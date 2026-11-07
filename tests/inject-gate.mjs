/* 新增自测：会话开头闸门（firstTurns / oncePerSession / strictState）
   node tests/inject-gate.mjs */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.js';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')); }
}

function mkEnv(agentId) {
  const tmp = path.join(os.tmpdir(), 'mr-gate-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  fs.mkdirSync(tmp, { recursive: true });
  const liveFile = path.join(tmp, 'live_state.md');
  fs.writeFileSync(liveFile,
    '# 会话延续状态\n\n更新时间：now\n\n## 最近在处理\n- 在写投稿包\n\n## 本次动过的文件\n- a.docx\n', 'utf8');
  const contexts = []; const handlers = new Map();
  const ctx = {
    get(n) {
      if (n === 'systemPrompt') return { context: (d) => { contexts.push(d); return () => {}; } };
      if (n === 'agents') return { currentInitiator: () => ({ id: agentId }) };
      return undefined;
    },
    on(n, f) { handlers.set(n, f); return () => {}; },
  };
  apply(ctx, {
    dataDir: tmp, debug: false, handoffDir: path.join(tmp, 'none'),
    dedupe: { enabled: false }, edg: { enabled: false }, trim: { enabled: false }, summary: { enabled: false },
    liveState: { enabled: true, file: liveFile },
    inject: { ttlMs: 600000, maxChars: 500, statsEveryMs: 600000,
              firstTurns: 2, oncePerSession: true, strictState: true },
    statsLine: false,
  });
  const textOf = () => (contexts.length ? contexts[contexts.length - 1].text() : '');
  let turn = 0;
  function ask(text) {
    turn += 1;
    handlers.get('agent/inbox/claimed')({ agent: { id: agentId }, turn, message: { role: 'user', content: [{ type: 'text', text }] } });
    handlers.get('agent/pre-step')({ agent: { id: agentId }, turn, step: 1 }, async () => ({ kind: 'enter', messages: [] }));
    return textOf();
  }
  return { ask };
}

/* 1) 会话第 1 条消息，严格 state 意图 → 注入 */
{
  const e = mkEnv('s1');
  const t = e.ask('接着上次干，当前进度如何');
  ok('首条消息注入', !!t && t.includes('在写投稿包'), 'len=' + (t || '').length);
  ok('第二次不重复注入（oncePerSession）', !e.ask('接着上次干，当前进度如何'));
}

/* 2) 会话第 3 条消息才问状态 → 不注入（firstTurns=2） */
{
  const e = mkEnv('s2');
  e.ask('先随便聊一句'); e.ask('再聊一句');
  const t = e.ask('接着上次干，当前进度如何');
  ok('第 3 条消息不注入（firstTurns 闸门）', !t, 'len=' + (t || '').length);
}

/* 3) 非严格意图（mixed）→ 不注入 */
{
  const e = mkEnv('s3');
  const t = e.ask('这个插件省了多少 token');
  ok('mixed 意图不注入（strictState 闸门）', !t, 'len=' + (t || '').length);
}

console.log('\n通过 ' + pass + ' ｜ 失败 ' + fail);
process.exit(fail ? 1 : 0);
