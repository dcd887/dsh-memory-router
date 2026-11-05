/* 钩子自测：用假 ctx 跑一遍注入逻辑，不装插件、不等真会话。
   node tests/hooks.mjs */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.js';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')); }
}

// 注：这里把压缩阈值（minSavedChars / minSavedRatio）置零，是因为本测试只验证「裁剪这条路径会不会记账」，
// 用的是小样本；真实默认阈值是 200 字 / 15%，小样本会被判为「不值得压」而跳过，那是设计如此。
const dataDir = path.join(os.tmpdir(), 'mr-hooks-' + Date.now());
const contexts = [];
const handlers = new Map();
let initiator = { id: 'sess-A' };

const ctx = {
  get(name) {
    if (name === 'systemPrompt') return { context: (def) => { contexts.push(def); return () => {}; } };
    if (name === 'agents') return { currentInitiator: () => initiator };
    return undefined;
  },
  on(name, fn) { handlers.set(name, fn); return () => {}; },
};

apply(ctx, {
  handoffDir: 'C:\\Users\\kjds\\Desktop\\DSH输出\\_workflows',
  handoffGlob: '交接_*.md',
  stateChars: 1800,
  dataDir,
  debug: true,
  trim: { enabled: true, dryRun: true, maxItems: 2, maxChars: 500, minSavedChars: 0, minSavedRatio: 0 },
  summary: { enabled: false },
});

const textFn = contexts.length ? contexts[0].text : null;
ok('注册了 prompt context', typeof textFn === 'function', 'contexts=' + contexts.length);

console.log('');
console.log('状态类问题 → 注入');
handlers.get('agent/inbox/claimed')({ agent: { id: 'sess-A' }, turn: 3, message: { role: 'user', content: [{ type: 'text', text: '当前状态如何，还有什么待办没做完' }] } });
handlers.get('agent/pre-step')({ agent: { id: 'sess-A' }, turn: 3, step: 1 }, async () => ({ kind: 'enter', messages: [] }));
const t1 = textFn();
ok('注入了内容', !!t1 && t1.length > 200, 'len=' + (t1 || '').length);
ok('带来源标注', !!t1 && t1.includes('交接_20261030_会话总账.md'), (t1 || '').slice(0, 80));
ok('明确说了别再检索', !!t1 && t1.includes('不要再为此检索'), '');

console.log('');
console.log('同一回合第二步 → 不重复注入');
const t2 = textFn();
ok('第二次为空', t2 === '', 'got=' + String(t2).slice(0, 20));

console.log('');
console.log('新回合 → 允许再注入');
handlers.get('agent/pre-step')({ agent: { id: 'sess-A' }, turn: 4, step: 1 }, async () => ({ kind: 'enter', messages: [] }));
const t3 = textFn();
// 2026-11-05 起加了内容哈希闸门：新回合但内容没变，ttlMs 内不再重复注入。
ok('新回合但内容没变 → 不重复注入（TTL 闸门）', t3 === '', 'len=' + (t3 || '').length);

console.log('');
console.log('历史类问题 → 不注入');
handlers.get('agent/inbox/claimed')({ agent: { id: 'sess-A' }, turn: 5, message: { role: 'user', content: [{ type: 'text', text: '以前踩过什么坑' }] } });
handlers.get('agent/pre-step')({ agent: { id: 'sess-A' }, turn: 5, step: 1 }, async () => ({ kind: 'enter', messages: [] }));
ok('历史类为空', textFn() === '', 'got=' + String(textFn()).slice(0, 20));

console.log('');
console.log('闲话 → 不注入');
handlers.get('agent/inbox/claimed')({ agent: { id: 'sess-A' }, turn: 6, message: { role: 'user', content: [{ type: 'text', text: '你好' }] } });
handlers.get('agent/pre-step')({ agent: { id: 'sess-A' }, turn: 6, step: 1 }, async () => ({ kind: 'enter', messages: [] }));
ok('闲话为空', textFn() === '', '');

console.log('');
console.log('超时后不再注入（TTL）');
const cfg = { handoffDir: 'C:\\Users\\kjds\\Desktop\\DSH输出\\_workflows', handoffGlob: '交接_*.md', stateChars: 1200, stateTtlMs: 1, dataDir, summary: { enabled: false }, trim: { enabled: false } };
const contexts2 = [];
const ctx2 = { get: (n) => n === 'systemPrompt' ? { context: (d) => { contexts2.push(d); return () => {}; } } : n === 'agents' ? { currentInitiator: () => initiator } : undefined, on: (n, f) => { handlers.set('x-' + n, f); return () => {}; } };
apply(ctx2, cfg);
handlers.get('x-agent/inbox/claimed')({ agent: { id: 'sess-B' }, turn: 1, message: { role: 'user', content: [{ type: 'text', text: '接着上一步继续' }] } });
handlers.get('x-agent/pre-step')({ agent: { id: 'sess-B' }, turn: 1, step: 1 }, async () => ({ kind: 'enter', messages: [] }));
const t4 = contexts2[0].text();
ok('TTL 过期后为空', t4 === '', 'len=' + (t4 || '').length);

console.log('');
console.log('裁剪钩子（dryRun）');
const decision = await handlers.get('tools/post-execute')(
  { name: 'mcp__memory__open_nodes', arguments: { names: ['唯一解H5'] } },
  { isError: false, value: {}, content: [{ type: 'text', text: JSON.stringify({ entities: [{ name: '唯一解H5', entityType: '项目', observations: ['a', 'b', 'c'] }, { name: '税则通', entityType: '项目', observations: ['d'] }] }) }] },
  async () => ({ kind: 'accept' }),
);
ok('dryRun 不改写决策', decision && decision.kind === 'accept' && !decision.content, JSON.stringify(decision || null).slice(0, 80));

console.log('');
console.log('裁剪钩子（真裁 dryRun=false）');
const dataDir2 = path.join(os.tmpdir(), 'mr-hooks2-' + Date.now());
const h2 = new Map();
const ctx3 = { get: () => undefined, on: (n, f) => { h2.set(n, f); return () => {}; } };
apply(ctx3, {
  handoffDir: 'C:\\Users\\kjds\\Desktop\\DSH输出\\_workflows',
  dataDir: dataDir2,
  summary: { enabled: false },
  trim: { enabled: true, dryRun: false, maxItems: 2, maxChars: 500, minSavedChars: 0, minSavedRatio: 0 },
});
const bigKg = JSON.stringify({
  entities: [
    { name: '唯一解H5', entityType: '项目', observations: Array.from({ length: 20 }, (_, i) => '观察 ' + (i + 1) + ' ' + 'x'.repeat(60)) },
  ],
});
const d2 = await h2.get('tools/post-execute')(
  { name: 'mcp__memory__search_nodes', arguments: { query: '唯一解' } },
  { isError: false, value: {}, content: [{ type: 'text', text: bigKg }, { type: 'text', text: '第二个文本块' }] },
  async () => ({ kind: 'accept', value: { raw: true } }),
);
ok('改写成 accept+content', d2 && d2.kind === 'accept' && Array.isArray(d2.content), JSON.stringify(d2 || null).slice(0, 60));
ok('只剩一个文本块', d2 && d2.content.filter((b) => b.type === 'text').length === 1, 'n=' + (d2 ? d2.content.length : -1));
ok('文本变短了', d2 && d2.content[0].text.length < bigKg.length / 2, 'len=' + (d2 ? d2.content[0].text.length : -1));
ok('没有丢掉 value 冲突', d2 && d2.value === undefined, 'value=' + JSON.stringify(d2 && d2.value));
const d3 = await h2.get('tools/post-execute')(
  { name: 'mcp__memory__open_nodes', arguments: {} },
  { isError: false, value: {}, content: [{ type: 'text', text: '短' }] },
  async () => ({ kind: 'accept', value: {} }),
);
ok('本来就短的不动它', d3 && d3.value !== undefined, JSON.stringify(d3 || null).slice(0, 40));

const rows2 = (() => {
  h2.get('agent/turn-stopping')();
  const file = path.join(dataDir2, 'metrics.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
})();
ok('真裁记了 dryRun=false', rows2.some((r) => r.kind === 'trim' && r.dryRun === false), 'rows=' + rows2.length);

const rows = (() => {
  handlers.get('agent/turn-stopping')();           // 收尾时刷盘
  const file = path.join(dataDir, 'metrics.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
})();
ok('账本写了 inject', rows.some((r) => r.kind === 'inject'), 'rows=' + rows.length);
ok('账本写了 trim', rows.some((r) => r.kind === 'trim' && r.tool === 'mcp__memory__open_nodes'), '');
ok('trim 记了省下的 token', rows.some((r) => r.kind === 'trim' && r.savedTokens > 0), '');

console.log('');
console.log('通过 ' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);
