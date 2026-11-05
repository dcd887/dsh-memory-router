/* 算账：总量、按天、按工具、最近 7 天趋势。
   node scripts/stats.mjs [--json] [--days 7] [--file <path>] */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { summarizeMetrics, statsLine } from '../lib/metrics.js';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const di = argv.indexOf('--days');
const days = di >= 0 ? Math.max(1, parseInt(argv[di + 1], 10) || 7) : 7;
const fi = argv.indexOf('--file');
const file = fi >= 0 ? argv[fi + 1] : path.join(os.homedir(), '.dsh', 'memory-router', 'metrics.jsonl');

if (!fs.existsSync(file)) {
  console.log('没有账本：' + file + '（插件还没在会话里跑过）');
  process.exit(0);
}

const s = summarizeMetrics(file);
if (!s) { console.log('账本里还没有可用行：' + file); process.exit(1); }

if (asJson) {
  const cutoff = Date.now() - days * 86400000;
  const recent = Object.entries(s.perDay).filter(([d]) => new Date(d + 'T00:00:00Z').getTime() >= cutoff);
  console.log(JSON.stringify({ ...s, perDay: Object.fromEntries(recent) }, null, 2));
  process.exit(0);
}

const pad = (v, n) => String(v).padEnd(n, ' ');
const lpad = (v, n) => String(v).padStart(n, ' ');
const num = (v) => Number(v || 0).toLocaleString('en-US');
const ratio = (a, b) => (b ? (a / b * 100).toFixed(1) + '%' : '-');

console.log('账本 ' + s.file);
console.log('区间 ' + (s.first || '?') + ' → ' + (s.last || '?') + '   共 ' + s.rows + ' 行');
console.log('');

/* 1. 总量 */
console.log('一、总量');
console.log('  ' + statsLine(s));
console.log('  ' + pad('项目', 16) + lpad('次数', 6) + lpad('token', 12) + '  说明');
console.log('  ' + '-'.repeat(58));
console.log('  ' + pad('状态注入', 16) + lpad(s.injects, 6) + lpad(num(s.injectTokens), 12) + '  ' + num(s.injectChars) + ' 字');
console.log('  ' + pad('检索裁剪', 16) + lpad(s.trims, 6) + lpad(num(s.savedTokens), 12) + '  省下的');
console.log('  ' + pad('摘要调用', 16) + lpad(s.summaryCalls, 6) + lpad(num(s.summaryTokens), 12) + '  花掉的（后台，不在上下文中）');
console.log('  ' + pad('净额', 16) + lpad('', 6) + lpad((s.net >= 0 ? '+' : '') + num(s.net), 12) + (s.net >= 0 ? '  省' : '  多花'));
console.log('  估法分布 ' + (Object.entries(s.methods).map(([k, v]) => k + '=' + v).join('  ') || '无'));

/* 2. 按工具 */
console.log('');
console.log('二、按工具');
if (!Object.keys(s.perTool).length) {
  console.log('  （还没有裁剪记录）');
} else {
  console.log('  ' + pad('工具', 34) + lpad('次数', 6) + lpad('省 token', 12) + lpad('剩余占比', 10));
  console.log('  ' + '-'.repeat(66));
  for (const [tool, t] of Object.entries(s.perTool).sort((a, b) => b[1].saved - a[1].saved)) {
    console.log('  ' + pad(tool, 34) + lpad(t.calls, 6) + lpad(num(t.saved), 12) + lpad(ratio(t.charsAfter, t.charsBefore), 10));
  }
  console.log('  剩余占比 = 裁剪后字数 / 原始字数，越低压得越狠（目标 ≤ 20%）');
}

/* 3. 按天 */
console.log('');
console.log('三、按天');
const dayKeys = Object.keys(s.perDay).sort().slice(-days);
if (!dayKeys.length) {
  console.log('  （没有数据）');
} else {
  console.log('  ' + pad('日期', 12) + lpad('裁剪', 6) + lpad('省', 10) + lpad('注入', 6) + lpad('花', 10) + lpad('净', 10));
  console.log('  ' + '-'.repeat(56));
  for (const d of dayKeys) {
    const v = s.perDay[d];
    console.log('  ' + pad(d, 12) + lpad(v.trims, 6) + lpad(num(v.saved), 10) + lpad(v.injects, 6) + lpad(num(v.spent), 10) + lpad((v.net >= 0 ? '+' : '') + num(v.net), 10));
  }
}

/* 4. 趋势 */
console.log('');
console.log('四、最近 ' + days + ' 天累计');
const cutoff = Date.now() - days * 86400000;
let saved = 0, spent = 0;
for (const [d, v] of Object.entries(s.perDay)) {
  if (new Date(d + 'T00:00:00Z').getTime() >= cutoff) { saved += v.saved; spent += v.spent; }
}
console.log('  省 ' + num(saved) + '  花 ' + num(spent) + '  净 ' + (saved - spent >= 0 ? '+' : '') + num(saved - spent));

  // 去重与重读：两个新账目。去重是省，重读是赔（压缩过头导致模型再读一遍）
  const sumAll = summarizeMetrics(file) || {};
  if (typeof sumAll.dedupeSaved === 'number') {
    console.log('');
    console.log('  其中：去重省 ' + num(sumAll.dedupeSaved || 0) + '（' + (sumAll.dedupeHits || 0) + ' 次）、重读赔 ' +
      num(sumAll.rereadLost || 0) + '（' + (sumAll.rereadCount || 0) + ' 次）、跳过压缩 ' +
      (sumAll.trimSkips || 0) + ' 次（省得太少，不值得压）');
  }
console.log('  折算：每省下 1000 token 大约等于少读 1500 个汉字（按 1.5 字/token）');
