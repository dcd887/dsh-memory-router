/* 任务级 A/B：同一批工具返回，插件开 vs 关，模型会读到的 token 差多少。
   node scripts/ab.mjs
   
   诚实说明：
   - 这里测的是「模型会读到的字节/token」，不是端到端 LLM 调用成本（那要真调模型，会花钱且不稳）。
   - 每个案例是一段固定的工具返回，来源分两类：真实文件 与 合成样本。表里标了来源。
   - token 用与账本同一个估算器（estimateByChars：中文 1.5 字/token，ASCII 4 字/token）。 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.js';
import { estimateByChars } from '../lib/metrics.js';

const HS = 'C:\\Users\\kjds\\Desktop\\06-学习\\hs-code-ai-assistant\\backend\\data\\hs_codes_full.json';
const BLIND = 'C:\\Users\\kjds\\Desktop\\DSH输出\\推理知识库\\验收\\cases\\case_001\\D_盲推结论_第七次.md';

/* ---------- 准备：两套插件实例（开 / 关） ---------- */
function makeCtx() {
  const handlers = new Map();
  const ctx = {
    get(n) {
      if (n === 'systemPrompt') return { context: () => () => {} };
      if (n === 'agents') return { currentInitiator: () => ({ id: 'ab' }) };
      return undefined;
    },
    on(n, f) { handlers.set(n, f); return () => {}; },
  };
  return { ctx, handlers };
}

const tmpOn = path.join(os.tmpdir(), 'mr-ab-on-' + Date.now());
const tmpOff = path.join(os.tmpdir(), 'mr-ab-off-' + Date.now());
fs.mkdirSync(tmpOn, { recursive: true });
fs.mkdirSync(tmpOff, { recursive: true });

// 开：去重 + 决策图 + 压缩都开，压缩用真实改写（dryRun:false），阈值按默认
const on = makeCtx();
apply(on.ctx, {
  dataDir: tmpOn, debug: false, summary: { enabled: false }, liveState: { enabled: false },
  dedupe: { enabled: true, ttlMs: 600000 },
  edg: { enabled: true, file: path.join('C:/Users/kjds/Desktop/DSH输出/memory-router', 'edg.json') },
  trim: { enabled: true, dryRun: false, minSavedChars: 200, minSavedRatio: 0.15,
          toolPattern: '^(mcp__)?memory__(search|open|read|list|query)' },
});

// 关：所有功能关掉，等价于原生
const off = makeCtx();
apply(off.ctx, {
  dataDir: tmpOff, debug: false, summary: { enabled: false }, liveState: { enabled: false },
  dedupe: { enabled: false }, edg: { enabled: false }, trim: { enabled: false },
});

/* ---------- 十个案例 ---------- */
const bigJson = JSON.stringify({
  items: Array.from({ length: 200 }, (_, i) => ({
    hs_code: '3403.' + String(1000 + i), name: '合成商品' + i, import_tariff: 6,
    category: '化工', description: '这是一段填充用的描述文字'.repeat(4),
  })),
});

const verdictJson = JSON.stringify({
  errors: ['case_003 第 4 条额度冲突', 'case_002 时间线缺口 6 分钟'],
  passed: 41, total: 42, detail: '通过数 41 / 42，失败明细见上'.repeat(30),
});

const longMd = Array.from({ length: 400 }, (_, i) => (i % 40 === 0 ? '## 小节 ' + i : '这是第 ' + i + ' 行正文，用来把文件撑大一些。')).join('\n');
const hugeMd = longMd.repeat(4);
const smallMd = '# 短文件\n\n只有几行。\n';
const pytestOut = 'PASSED test_a.py::test_x\nPASSED test_a.py::test_y\nFAILED test_b.py::test_z - assert 1 == 2\n' + 'traceback line\n'.repeat(60);

const readExec = (p, extra) => ({ toolName: 'read', arguments: { file_path: p, ...(extra || {}) } });
const bashExec = (cmd) => ({ toolName: 'bash', arguments: { cmd }, description: 'run tests' });
const text = (t) => ({ content: [{ type: 'text', text: t }] });

/* 合成样本要落盘：决策图的本地动作是读真实文件的，只给结果文本会因为找不到文件而跳过 */
const fixtureDir = path.join(os.tmpdir(), 'mr-ab-fixtures-' + Date.now());
fs.mkdirSync(fixtureDir, { recursive: true });
const fx = (name, content) => { const p2 = path.join(fixtureDir, name); fs.writeFileSync(p2, content, 'utf8'); return p2; };

const fVerdict = fx('判案_result.json', verdictJson);
const fBigJson = fx('data_dump.json', bigJson);
const fLongMd = fx('长文档.md', longMd);
const fHugeMd = fx('超大文档.md', hugeMd);
const fSmallMd = fx('短.md', smallMd);
const fMidJson = fx('mid.json', bigJson.slice(0, 3000));

const CASES = [
  { id: 'C1', name: '读税则大表（真实文件）', exec: readExec(HS), result: text('{"meta":{},"items":[' + '{"hs_code":"0101.2100"},'.repeat(400) + ']}') , source: '真实文件' },
  { id: 'C2', name: '读盲推记录（真实文件）', exec: readExec(BLIND), result: text(fs.readFileSync(BLIND, 'utf8')), source: '真实文件' },
  { id: 'C3', name: '读判案结果 JSON', exec: readExec(fVerdict), result: text(verdictJson), source: '合成' },
  { id: 'C4', name: '读大 JSON（10KB）', exec: readExec(fBigJson), result: text(bigJson), source: '合成' },
  { id: 'C5', name: '读大 md（约 12KB）', exec: readExec(fLongMd), result: text(longMd), source: '合成' },
  { id: 'C6', name: '读超大 md（约 50KB）', exec: readExec(fHugeMd), result: text(hugeMd), source: '合成' },
  { id: 'C7', name: '读短 md（小文件，守卫应拦）', exec: readExec(fSmallMd), result: text(smallMd), source: '合成' },
  { id: 'C8', name: 'bash 跑测试（非 read，不匹配）', exec: bashExec('pytest -q'), result: text(pytestOut), source: '合成' },
  { id: 'C9', name: '重复读大表（应命中去重）', exec: readExec(HS), result: text('{"items":[' + '{"hs_code":"0101.2100"},'.repeat(400) + ']}'), source: '重复' },
  { id: 'C10', name: '读中等 JSON（3KB，守卫生效）', exec: readExec(fMidJson), result: text(bigJson.slice(0, 3000)), source: '合成' },
];

/* ---------- 跑 ---------- */
/* next() 必须返回「承载原始结果的 decision」，否则关掉插件那一列量到的是桩数据而不是工具输出。 */
async function run(handlers, exec, result) {
  const pe = handlers.get('tools/post-execute');
  const d = await pe(exec, result, async () => ({ kind: 'accept', content: result.content }));
  const blocks = (d && d.content) || [];
  return blocks.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n');
}

const rows = [];
let sumOff = 0, sumOn = 0;
for (const c of CASES) {
  const offText = await run(off.handlers, c.exec, c.result);
  const onText = await run(on.handlers, c.exec, c.result);
  const tOff = estimateByChars(offText), tOn = estimateByChars(onText);
  sumOff += tOff; sumOn += tOn;
  rows.push({ id: c.id, name: c.name, source: c.source, tOff, tOn, saved: tOff - tOn });
}

/* ---------- 输出 ---------- */
const pad = (s, n) => { s = String(s); let w = 0; for (const ch of s) w += /[\u3400-\u9fff]/.test(ch) ? 2 : 1; return s + ' '.repeat(Math.max(0, n - w)); };
const lpad = (s, n) => { s = String(s); let w = 0; for (const ch of s) w += /[\u3400-\u9fff]/.test(ch) ? 2 : 1; return ' '.repeat(Math.max(0, n - w)) + s; };

console.log('');
console.log(pad('编号', 6) + pad('案例', 30) + lpad('关', 8) + lpad('开', 8) + lpad('省', 8) + lpad('省%', 7));
console.log('-'.repeat(70));
for (const r of rows) {
  const pct = r.tOff ? Math.round(100 * r.saved / r.tOff) : 0;
  console.log(pad(r.id, 6) + pad(r.name, 30) + lpad(r.tOff, 8) + lpad(r.tOn, 8) + lpad(r.saved, 8) + lpad(pct + '%', 7));
}
console.log('-'.repeat(70));
const pctAll = Math.round(100 * (sumOff - sumOn) / sumOff);
console.log(pad('合计', 6) + pad('十个案例', 30) + lpad(sumOff, 8) + lpad(sumOn, 8) + lpad(sumOff - sumOn, 8) + lpad(pctAll + '%', 7));
/* 命中率与折算：单看合计会误导，因为案例是我挑的 */
const hitRows = rows.filter((r) => r.saved > 0);
const hitRate = hitRows.length / rows.length;
const avgPctWhenHit = hitRows.length ? Math.round(100 * hitRows.reduce((a, r) => a + r.saved / r.tOff, 0) / hitRows.length) : 0;
console.log('');
console.log('命中 ' + hitRows.length + '/' + rows.length + ' 个案例；命中时平均省 ' + avgPctWhenHit + '%。');
console.log('注意：这十个案例是我按「会命中」挑的，' + pctAll + '% 是上界，不是真实负载的期望值。');
const assumed = 0.3;
console.log('若按「三成读取能命中」折算，综合节省约 ' + Math.round(assumed * avgPctWhenHit) + '%（= 30% × ' + avgPctWhenHit + '%）。');
console.log('');
console.log('口径说明：');
console.log('  1. 这里算的是「模型会读到的 token」，不是端到端 LLM 调用成本。');
console.log('  2. token 用 estimateByChars 估算（中文 1.5 字/token，ASCII 4 字/token）。');
console.log('  3. 关掉插件那一列 = 工具原样返回，即原生 DSH 的行为。');
