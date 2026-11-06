/* EDG 自测：假 ctx + 真临时文件，验证「匹配 → 守卫 → 本地动作 → 记账」这条链。
   node tests/edg.mjs */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.js';
import { loadEdg, matchNode, evalGuard, runEdg } from '../lib/edg.js';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')); }
}

const tmp = path.join(os.tmpdir(), 'mr-edg-' + Date.now());
fs.mkdirSync(tmp, { recursive: true });

/* ---- 造两个测试文件 ---- */
const bigJson = path.join(tmp, 'hs_codes_full.json');
fs.writeFileSync(bigJson, JSON.stringify({
  items: Array.from({ length: 400 }, (_, i) => ({
    hs_code: '3403.' + String(1000 + i).slice(0, 4), name: '测试条目' + i,
    import_tariff: 5, category: '化工', description: '这是一段很长的描述'.repeat(6),
  })),
}), 'utf8');

const bigMd = path.join(tmp, '长文.md');
fs.writeFileSync(bigMd, Array.from({ length: 3000 }, (_, i) => (i % 50 === 0 ? '## 小节 ' + i : '这是第 ' + i + ' 行正文，用来把文件撑大。')).join('\n'), 'utf8');

/* ---- 单元：match / guard ---- */
const edg = loadEdg(path.join('C:/Users/kjds/Desktop/DSH输出/memory-router', 'edg.example.json'));
ok('示例图能载入', edg.nodes.length === 10, 'nodes=' + edg.nodes.length + ' err=' + edg.error);

const n1 = edg.nodes[0];
ok('match: 命中 hs_codes 路径', matchNode(n1, 'read', JSON.stringify({ file_path: bigJson })));
ok('match: 不命中别的文件', !matchNode(n1, 'read', JSON.stringify({ file_path: bigMd })));
ok('guard: 大文件为真', evalGuard(n1.guard, { resultText: 'x'.repeat(3000) }));
ok('guard: 小文件为假', !evalGuard(n1.guard, { resultText: 'x' }));

/* ---- 单元：本地动作 ---- */
const hit1 = runEdg(edg, { tool: 'read', argsText: JSON.stringify({ file_path: bigJson }), resultText: 'x'.repeat(3000) });
ok('命中节点 1', !!hit1 && hit1.node.id === 'tax-table-pick-fields', JSON.stringify(hit1 && hit1.node.id));
ok('只取 3 条 + 4 个字段', !!hit1 && hit1.text.length < 800 && hit1.text.includes('hs_code') && !hit1.text.includes('description'),
   'len=' + (hit1 && hit1.text.length));

/* ---- 守卫为假时不命中 ---- */
const hitNone = runEdg(edg, { tool: 'read', argsText: JSON.stringify({ file_path: bigJson }), resultText: 'short' });
ok('结果太小时不命中（minChars 守卫生效）', hitNone === null);

/* ---- 动作抛异常时回落 ---- */
const badEdg = { nodes: [{ id: 'bad', match: { tool: 'read' }, then: [{ act: 'readJson', path: '/不存在的路径.json' }] }] };
let diagHit = '';
const hitBad = runEdg(badEdg, { tool: 'read', argsText: '{}', resultText: 'x' }, { diag: (s, i) => { diagHit = s; } });
ok('动作失败返回 null（不炸）', hitBad === null);
ok('失败时记了 diag', diagHit === 'edg-node-error', diagHit);

/* ---- 未知动作被拒 ---- */
const evilEdg = { nodes: [{ id: 'evil', match: { tool: 'bash' }, then: [{ act: 'exec', cmd: 'rm -rf /' }] }] };
const hitEvil = runEdg(evilEdg, { tool: 'bash', argsText: '{}', resultText: 'x' });
ok('白名单外动作被拒（exec 不执行）', hitEvil === null);

/* ---- 走完整钩子：插件里能不能接上 ---- */
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(dataDir, { recursive: true });
fs.copyFileSync(path.join('C:/Users/kjds/Desktop/DSH输出/memory-router', 'edg.example.json'), path.join(dataDir, 'edg.json'));

const handlers = new Map();
const ctx = {
  get(n) {
    if (n === 'systemPrompt') return { context: () => () => {} };
    if (n === 'agents') return { currentInitiator: () => ({ id: 'sess-E' }) };
    return undefined;
  },
  on(n, f) { handlers.set(n, f); return () => {}; },
};
apply(ctx, { dataDir, debug: false, dedupe: { enabled: false }, trim: { enabled: false }, summary: { enabled: false } });

const pe = handlers.get('tools/post-execute');
const decision = { kind: 'accept', content: [{ type: 'text', text: 'raw' }] };
const r = await pe(
  { toolName: 'read', arguments: { file_path: bigJson } },
  { content: [{ type: 'text', text: 'y'.repeat(3000) }] },
  async () => decision,
);
ok('钩子接上了 EDG，返回被替换', r && r.kind === 'accept' && r.content[0].text.includes('hs_code') && !r.content[0].text.includes('description'));

await new Promise((res) => setTimeout(res, 1800));
const rows = fs.readFileSync(path.join(dataDir, 'metrics.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const edgRow = rows.find((x) => x.kind === 'edg');
ok('账本记了 edg 行', !!edgRow, rows.map((x) => x.kind).join(','));
ok('edg 行有 node / charsIn / charsOut / savedTokens',
   edgRow && edgRow.node === 'tax-table-pick-fields' && edgRow.charsIn > edgRow.charsOut && edgRow.savedTokens > 0,
   JSON.stringify(edgRow || {}).slice(0, 140));
ok('非 terminal 节点 turnsAvoided 记 0', edgRow && edgRow.turnsAvoided === 0);

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
