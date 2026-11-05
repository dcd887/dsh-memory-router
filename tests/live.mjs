/* 会话延续器自测：写 → 落盘 → 新会话注入 → 过期归档。
   node tests/live.mjs */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.js';
import { LiveState } from '../lib/live_state.js';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')); }
}

const tmp = path.join(os.tmpdir(), 'mr-live-' + Date.now());
fs.mkdirSync(tmp, { recursive: true });

/* ---- 单元：LiveState 本身 ---- */
const cfg = { enabled: true, file: path.join(tmp, 'live_state.md'), maxFiles: 5, maxUser: 3, staleHours: 24 };
const ls = new LiveState(cfg, null);
ls.recordUser('接着上次的剧本杀投稿，把咪咕那份补齐');
ls.recordUser('另外看看硬盘能清什么');
ls.recordFile('C:/Users/kjds/Desktop/DSH输出/x.docx');
ls.offerToolCall('write', JSON.stringify({ file_path: 'C:/Users/kjds/Desktop/DSH输出/y.md' }));
ls.offerToolCall('bash', JSON.stringify({ cmd: 'ls' }));   // 非文件工具，不该记
ls.offerToolCall('edit', JSON.stringify({ file_path: 'C:/Users/kjds/Desktop/DSH输出/x.docx' })); // 重复，应被提到最前
ls.flush();

const txt = fs.readFileSync(cfg.file, 'utf8');
ok('落盘成功', !!txt && txt.includes('会话延续状态'));
ok('记了用户消息', txt.includes('咪咕那份补齐'));
ok('记了文件路径', txt.includes('y.md') && txt.includes('x.docx'));
ok('非文件工具不记', !txt.includes('bash'));
ok('重复文件去重并提前', txt.indexOf('x.docx') < txt.indexOf('y.md'), 'order');
ok('最多只留 maxFiles 条', (txt.match(/^- /gm) || []).length <= 5 + 3, 'lines=' + (txt.match(/^- /gm) || []).length);

/* ---- 过期判定 ---- */
const old = path.join(tmp, 'old_state.md');
fs.writeFileSync(old, '# 会话延续状态\n\n## 本次动过的文件\n- 老文件.md\n', 'utf8');
const past = new Date(Date.now() - 30 * 3600 * 1000);
fs.utimesSync(old, past, past);
const ls2 = new LiveState({ ...cfg, file: old }, null);
const r = ls2.readFresh();
ok('超过 staleHours 判为过期', r && r.stale === true, JSON.stringify(r && { stale: r.stale }));

const archDir = path.join(tmp, 'archive');
fs.mkdirSync(archDir, { recursive: true });
const dest = ls2.archiveIfStale(archDir, 24);
ok('过期状态被归档', !!dest && fs.existsSync(dest), String(dest));
ok('归档文件名带日期', dest && /live_state_\d{4}-\d{2}-\d{2}\.md$/.test(dest), String(dest));

/* ---- 集成：新会话第一轮注入 live_state ---- */
const handlers = new Map();
const contexts = [];
const ctx = {
  get(n) {
    if (n === 'systemPrompt') return { context: (d) => { contexts.push(d); return () => {}; } };
    if (n === 'agents') return { currentInitiator: () => ({ id: 'sess-L' }) };
    return undefined;
  },
  on(n, f) { handlers.set(n, f); return () => {}; },
};
apply(ctx, {
  dataDir: tmp,
  debug: false,
  // 交接文档指向一个不存在的目录，确保注入必须来自 live_state
  handoffDir: path.join(tmp, 'no-such-dir'),
  dedupe: { enabled: false }, edg: { enabled: false }, trim: { enabled: false }, summary: { enabled: false },
  liveState: { enabled: true, file: cfg.file, preferOverHandoff: true },
});

handlers.get('agent/inbox/claimed')({ agent: { id: 'sess-L' }, turn: 1, message: { role: 'user', content: [{ type: 'text', text: '接着上次干，当前状态如何' }] } });
handlers.get('agent/pre-step')({ agent: { id: 'sess-L' }, turn: 1, step: 1 }, async () => ({ kind: 'enter', messages: [] }));

const injected = contexts.length ? contexts[0].text() : '';
ok('新会话注入了延续状态', !!injected && injected.includes('会话延续状态'), 'len=' + injected.length);
ok('注入了上次动过的文件', injected.includes('y.md'));
ok('明确说了接着干就行', injected.includes('接着干就行'));

/* ---- 不在状态类提问时不注入（避免每轮都灌） ---- */
const t2 = contexts[0].text();
ok('同一回合第二步不重复注入', t2 === '', String(t2).slice(0, 20));


/* ---- 内容没变时不该重写文件（否则注入闸门的内容哈希每轮都变） ---- */
const sigFile = path.join(tmp, 'sig_state.md');
const ls3 = new LiveState({ ...cfg, file: sigFile }, null);
ls3.recordUser('同一句话');
ls3.flush();
const m1 = fs.statSync(sigFile).mtimeMs;
const before = fs.readFileSync(sigFile, 'utf8');
await new Promise((r) => setTimeout(r, 30));
ls3.recordUser('同一句话');          // 内容没变（去重后 users 一样）
ls3.flush();
const m2 = fs.statSync(sigFile).mtimeMs;
const after = fs.readFileSync(sigFile, 'utf8');
ok('内容没变时不重写文件', m1 === m2, 'm1=' + m1 + ' m2=' + m2);
ok('文件内容也没变', before === after);

ls3.recordUser('换一句完全不同的话');   // 内容变了
ls3.flush();
const m3 = fs.statSync(sigFile).mtimeMs;
ok('内容变了才重写', m3 > m2, 'm2=' + m2 + ' m3=' + m3);

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
