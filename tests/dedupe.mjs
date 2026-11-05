/* 去重与压缩阈值的自测：用假 ctx + 假工具结果跑一遍，不装插件。
   node tests/dedupe.mjs */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.js';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')); }
}

const dataDir = path.join(os.tmpdir(), 'mr-dedupe-' + Date.now());
const handlers = new Map();

const ctx = {
  get(name) {
    if (name === 'systemPrompt') return { context: () => () => {} };
    if (name === 'agents') return { currentInitiator: () => ({ id: 'sess-D' }) };
    return undefined;
  },
  on(name, fn) { handlers.set(name, fn); return () => {}; },
};

apply(ctx, {
  dataDir,
  debug: false,
  dedupe: { enabled: true, ttlMs: 60000, maxEntries: 50 },
  trim: { enabled: true, dryRun: false, maxItems: 2, maxChars: 500, minSavedChars: 50, minSavedRatio: 0.1,
          toolPattern: '^(mcp__)?memory__(search|open|read|list|query)' },
  summary: { enabled: false },
});

const pe = handlers.get('tools/post-execute');
ok('注册了 tools/post-execute', typeof pe === 'function');

// 造一段 memory 工具风格的返回：30 条 entity，前两条最相关
function bigResult(tag) {
  const entities = [];
  for (let i = 0; i < 30; i++) {
    entities.push({ name: tag + '-实体' + i, entityType: '测试', observations: ['这是一条比较长的观察文字，用来把结果撑大，' + i] });
  }
  return { content: [{ type: 'text', text: JSON.stringify({ entities }) }] };
}

const exec = { toolName: 'mcp__memory__search_nodes', arguments: { query: '唯一解' } };
const decision = { kind: 'accept', content: [{ type: 'text', text: 'x' }] };

const run = async (r) => pe(exec, r, async () => decision);

const d1 = await run(bigResult('唯一解'));
ok('第一次走压缩，结果被改写', d1 && d1.kind === 'accept' && d1.content[0].text.length < 2000,
   'len=' + (d1 && d1.content[0].text || '').length);
const lenAfterTrim = d1.content[0].text.length;

// 同一工具同一参数再来一次 → 应命中缓存，且文本与上次一致
const d2 = await run(bigResult('唯一解'));
ok('第二次命中缓存，文本与上次完全一致', d2.content[0].text === d1.content[0].text, 'diff');
ok('缓存命中不重新压缩（长度一致）', d2.content[0].text.length === lenAfterTrim);

// 参数不同 → 不命中
const exec2 = { toolName: 'mcp__memory__search_nodes', arguments: { query: '关盾' } };
const d3 = await pe(exec2, bigResult('关盾'), async () => decision);
ok('参数不同不命中缓存', d3.content[0].text !== d1.content[0].text);

// 结果太小 → 应跳过压缩（trim-skip），原样返回
const small = { content: [{ type: 'text', text: JSON.stringify({ entities: [{ name: 'a', entityType: 'b', observations: ['短'] }] }) }] };
const exec3 = { toolName: 'mcp__memory__search_nodes', arguments: { query: '小结果' } };
const d4 = await pe(exec3, small, async () => decision);
ok('结果太小时跳过压缩，返回原 decision', d4 === decision);

// 非 memory 工具 → 不处理
const exec4 = { toolName: 'bash', arguments: { cmd: 'ls' } };
const d5 = await pe(exec4, bigResult('bash'), async () => decision);
ok('非目标工具不处理', d5 === decision);

// 等账本落盘（flush 有 1.5 秒定时）
await new Promise((r) => setTimeout(r, 1800));
const metricsFile = path.join(dataDir, 'metrics.jsonl');
const raw = fs.readFileSync(metricsFile, 'utf8').trim().split('\n').filter(Boolean);
const rows = raw.map((l) => JSON.parse(l));
const kinds = rows.map((r) => r.kind);
ok('账本记了 trim', kinds.includes('trim'), kinds.join(','));
ok('账本记了 dedupe', kinds.includes('dedupe'), kinds.join(','));
ok('账本记了 reread（第二次同调用）', kinds.includes('reread'), kinds.join(','));
ok('账本记了 trim-skip', kinds.includes('trim-skip'), kinds.join(','));

const dd = rows.find((r) => r.kind === 'dedupe');
ok('dedupe 行有 charsIn / charsOut / savedTokens',
   dd && dd.charsIn > dd.charsOut && dd.savedTokens > 0, JSON.stringify(dd || {}).slice(0, 120));

const rr = rows.find((r) => r.kind === 'reread');
ok('reread 行有 lostTokens 且大于 0', rr && rr.lostTokens > 0, JSON.stringify(rr || {}).slice(0, 120));

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
