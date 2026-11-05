/* 注入开销控制自测：内容不变不重灌、超长截断、账面一行限频。
   node tests/inject.mjs */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.js';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')); }
}

const tmp = path.join(os.tmpdir(), 'mr-inject-' + Date.now());
fs.mkdirSync(tmp, { recursive: true });
const liveFile = path.join(tmp, 'live_state.md');

const writeLive = (msg, extra) => fs.writeFileSync(liveFile,
  '# 会话延续状态\n\n更新时间：now\n\n## 最近在处理\n- ' + msg + '\n' + (extra || '') +
  '\n## 本次动过的文件\n- a.docx\n', 'utf8');

writeLive('在补齐咪咕投稿包');

const contexts = [];
const handlers = new Map();
let agentSeq = 0;
const ctx = {
  get(n) {
    if (n === 'systemPrompt') return { context: (d) => { contexts.push(d); return () => {}; } };
    if (n === 'agents') return { currentInitiator: () => ({ id: 'sess-' + agentSeq }) };
    return undefined;
  },
  on(n, f) { handlers.set(n, f); return () => {}; },
};

apply(ctx, {
  dataDir: tmp,
  debug: false,
  handoffDir: path.join(tmp, 'none'),
  dedupe: { enabled: false }, edg: { enabled: false }, trim: { enabled: false }, summary: { enabled: false },
  liveState: { enabled: true, file: liveFile },
  inject: { ttlMs: 600000, maxChars: 200, statsEveryMs: 600000 },
  statsLine: true,
});

const textOf = () => (contexts.length ? contexts[contexts.length - 1].text() : '');

function ask(text, turn) {
  handlers.get('agent/inbox/claimed')({ agent: { id: 'sess-' + agentSeq }, turn, message: { role: 'user', content: [{ type: 'text', text }] } });
  handlers.get('agent/pre-step')({ agent: { id: 'sess-' + agentSeq }, turn, step: 1 }, async () => ({ kind: 'enter', messages: [] }));
  return textOf();
}

/* 1) 首次注入 */
const t1 = ask('接着上次干，当前状态如何', 1);
ok('第一次注入有内容', !!t1 && t1.includes('在补齐咪咕投稿包'), 'len=' + (t1 || '').length);
ok('没被截断（内容短于上限）', !!t1 && !t1.includes('注入截断'));

/* 2) 同一个人再问，内容没变 → 不注入 */
const t2 = ask('再确认一下状态', 2);
ok('内容没变 + TTL 内 → 第二次不注入', t2 === '', 'len=' + (t2 || '').length);

/* 3) 内容变了（变在头部）→ 立刻重新注入 */
writeLive('改成在写第一章扩写');
const t3 = ask('状态怎么样了', 3);
ok('内容变了 → 立刻重新注入', !!t3 && t3.includes('第一章扩写'), 'len=' + (t3 || '').length);

/* 4) 超长截断：换一个 agent，写一份超长状态 */
agentSeq = 1;
writeLive('这是一个很长的状态' + '，后面还有更多内容'.repeat(60));
const t4 = ask('当前状态如何', 1);
ok('超长被截断', (t4 || '').length <= 320, 'len=' + (t4 || '').length);
ok('截断留了标记', (t4 || '').includes('注入截断'), (t4 || '').slice(-30));

await new Promise((r) => setTimeout(r, 1700));
const rows = fs.readFileSync(path.join(tmp, 'metrics.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const kinds = rows.map((r) => r.kind);
ok('账本记了 inject', kinds.includes('inject'), kinds.join(','));
ok('账本记了 inject-skip', kinds.includes('inject-skip'), kinds.join(','));
const skip = rows.find((r) => r.kind === 'inject-skip');
ok('跳过原因是 unchanged', skip && skip.reason === 'unchanged', JSON.stringify(skip || {}).slice(0, 100));
const inj = rows.filter((r) => r.kind === 'inject');
ok('该注入的三次都记了（t1 / t3 / t4）', inj.length === 3, 'injects=' + inj.length);
ok('不是每次都带账面行', inj.filter((r) => r.withStats).length <= 2, JSON.stringify(inj.map((r) => !!r.withStats)));

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
