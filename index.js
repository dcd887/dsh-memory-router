// 2026-11-05 触发一次热重载，让 edg.json 被载入（HMR 监听本文件）
/* 记忆路由 · Host 插件
 *
 * 干三件事：
 *   1. 用户发问时用正则判意图；「当前任务状态」这类直接注入本地交接文档，不检索向量库。
 *   2. memory 类工具的返回结果按条数与字数裁剪（默认 dryRun：只记账不改写）。
 *   3. 每满 N 条用户消息，后台调最便宜的模型压成 3 条要点，追加到 project_memory.md。
 *
 * 所有钩子都包在 try/catch 里：这个插件坏了不许影响主循环。
 */

import os from 'node:os';
import path from 'node:path';

import { classify, queryTerms } from './lib/intent.js';
import { loadState } from './lib/handoff.js';
import { compressText, matchesTool } from './lib/compress.js';
import { TtlCache, hashOf } from './lib/dedupe.js';
import { loadEdg, runEdg } from './lib/edg.js';
import { LiveState } from './lib/live_state.js';
import { Metrics, summarizeMetrics, statsLine } from './lib/metrics.js';
import { SummaryScheduler } from './lib/summarize.js';

const DEFAULTS = {
  enabled: true,
  handoffDir: '',
  handoffGlob: '交接_*.md',
  handoffPrefer: ['总账'],
  stateChars: 1800,
  stateTtlMs: 10 * 60 * 1000,
  injectMode: 'context',          // context | off
  injectOncePerTurn: true,
  dataDir: '',
  statsLine: true,                // 注入块末尾附一行「省了多少」
  statsTool: false,               // 是否注册 memory_router_stats 工具（默认关：工具 schema 本身就是每轮的固定成本）
  statsRefreshMs: 30000,
  // 去重：同一工具 + 同一参数，在 TTL 内再来一次就直接复用上次给模型看过的文本
  dedupe: { enabled: true, ttlMs: 60000, maxEntries: 200 },
  edg: { enabled: true, file: '' },
  // 会话延续器：自动落盘「在处理什么、动过哪些文件」，新会话第一轮注入
  liveState: { enabled: true, file: '', maxFiles: 20, maxUser: 5, staleHours: 24, preferOverHandoff: true },
  // 注入开销控制：同样的内容别每回合重灌；账面一行 30 分钟才带一次
  inject: { ttlMs: 10 * 60 * 1000, maxChars: 1600, statsEveryMs: 30 * 60 * 1000,
            // 只在会话开头注入：省掉中后期那些「看起来像问状态」的回合
            firstTurns: 0,        // >0 时只在前 N 条用户消息里注入
            oncePerSession: false, // true 时每个会话只注入一次
            strictState: false },  // true 时只认 intent==='state'，不认 mixed
  // 压缩阈值：省得太少就别压。压过头会让模型重读，那是净亏（见 metrics 的 reread）
  trim: { enabled: true, dryRun: true, maxItems: 2, maxChars: 500, minSavedChars: 200, minSavedRatio: 0.15,
          toolPattern: '^(mcp__)?memory__(search|open|read|list|query|query)' },
  summary: { enabled: true, everyUserMessages: 10, windowMessages: 10, maxOutputTokens: 300, provider: '', model: '' },
  debug: true,
};

function resolveConfig(input) {
  const cfg = { ...DEFAULTS, ...(input || {}) };
  cfg.trim = { ...DEFAULTS.trim, ...(input && input.trim) };
  cfg.dedupe = { ...DEFAULTS.dedupe, ...(input && input.dedupe) };
  cfg.edg = { ...DEFAULTS.edg, ...(input && input.edg) };
  cfg.liveState = { ...DEFAULTS.liveState, ...(input && input.liveState) };
  cfg.summary = { ...DEFAULTS.summary, ...(input && input.summary) };
  cfg.inject = { ...DEFAULTS.inject, ...(input && input.inject) };
  // dataDir 必须先定下来，否则后面拼出来的 edg.json / live_state.md 会变成相对路径，
  // 落到当时的 cwd（实测掉进了 DSH输出\_tools，edg 因此永远读不到）。2026-11-05 修。
  cfg.dataDir = cfg.dataDir || path.join(os.homedir(), '.dsh', 'memory-router');
  cfg.edg.file = cfg.edg.file || path.join(cfg.dataDir, 'edg.json');
  cfg.liveState.file = cfg.liveState.file || path.join(cfg.dataDir, 'live_state.md');
  cfg.metricsFile = path.join(cfg.dataDir, 'metrics.jsonl');
  cfg.summaryFile = path.join(cfg.dataDir, 'project_memory.md');
  return cfg;
}

function textOfMessage(message) {
  if (!message) return '';
  const c = message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n');
  return '';
}

function textBlocksOf(result) {
  const out = [];
  if (result && Array.isArray(result.content)) {
    for (const b of result.content) if (b && b.type === 'text' && typeof b.text === 'string') out.push(b.text);
  }
  return out;
}

function toolNameOf(exec) {
  if (!exec || typeof exec !== 'object') return '';
  const cands = [exec.toolName, exec.name, exec.tool && exec.tool.name, exec.definition && exec.definition.name, exec.call && exec.call.name];
  for (const c of cands) if (typeof c === 'string' && c) return c;
  return '';
}

function argsTextOf(exec) {
  if (!exec || typeof exec !== 'object') return '';
  const c = [exec.arguments, exec.args, exec.call && exec.call.arguments, exec.input];
  for (const v of c) {
    if (typeof v === 'string' && v) return v;
    if (v && typeof v === 'object') { try { return JSON.stringify(v); } catch { /* ignore */ } }
  }
  return '';
}

export function apply(ctx, config = {}) {
  const cfg = resolveConfig(config);
  if (!cfg.enabled) return;

  const meter = (text) => {
    try {
      const tm = ctx.get('tokenMeter');
      if (tm && typeof tm.estimateMessage === 'function') {
        return tm.estimateMessage({ role: 'user', content: [{ type: 'text', text: String(text || '') }] });
      }
    } catch { /* fall back to char estimate */ }
    return undefined;
  };

  const metrics = new Metrics(cfg, meter);
  const states = new Map();       // agentId -> { intent, at, turn, step, injectedTurn, userCount }
  const shaped = new Set();       // 已记录过形状诊断的工具名
  const dedupe = new TtlCache(cfg.dedupe);
  const live = new LiveState(cfg.liveState, metrics);
  let edg = { nodes: [] };   // 启动时载入一次；文件改了要重启才生效（刻意如此，避免半截配置生效）
  const statsCache = { at: 0, line: '' };

  /* 账面一行话：缓存 statsRefreshMs，避免每次组装都读账本 */
  function currentStatsLine() {
    if (!cfg.statsLine) return '';
    const now = Date.now();
    if (now - statsCache.at < cfg.statsRefreshMs) return statsCache.line;
    try {
      metrics.flush();
      const sum = summarizeMetrics(cfg.metricsFile);
      statsCache.line = sum ? statsLine(sum) : '';
    } catch { statsCache.line = ''; }
    statsCache.at = now;
    return statsCache.line;
  }

  const summarizer = new SummaryScheduler({
    cfg: cfg.summary,
    metrics,
    file: cfg.summaryFile,
    getLlm: () => ctx.get('llm'),
    getModel: () => {
      const svc = ctx.get('agentDefaultModel');
      if (!svc || typeof svc.currentSelection !== 'function') return {};
      try { return svc.currentSelection() || {}; } catch { return {}; }
    },
  });

  /* 轻量哈希：只为判断「这段注入和上次是不是一样」，不做安全用途 */
  function hashText(t) {
    let h = 5381;
    const s = String(t || '');
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16);
  }

  function stOf(agentId) {
    const key = String(agentId || 'unknown');
    let st = states.get(key);
    if (!st) {
      st = { intent: 'none', at: 0, turn: -1, step: -1, injectedTurn: null, injectedSession: false, userCount: 0, hits: [],
             lastHash: '', lastAt: 0, lastStatsAt: 0 };
      states.set(key, st);
    }
    return st;
  }

  /* ---------- 1. 用户消息：判意图、计数、喂摘要 ---------- */
  function onUserMessage(payload) {
    const agentId = (payload && payload.agent && payload.agent.id) || 'unknown';
    const text = textOfMessage(payload && payload.message);
    if (!text) return;
    const verdict = classify(text);
    const st = stOf(agentId);
    st.intent = verdict.intent;
    st.at = Date.now();
    st.hits = verdict.stateHits.concat(verdict.historyHits).slice(0, 6);
    st.userCount += 1;
    if (typeof payload.turn === 'number') st.turn = payload.turn;
    summarizer.push(agentId, text);
    try { live.recordUser(text); } catch { /* 不影响主循环 */ }
    if (cfg.debug && verdict.intent !== 'none') {
      metrics.log({ kind: 'intent', agent: String(agentId).slice(0, 8), intent: verdict.intent, state: verdict.stateScore, history: verdict.historyScore, hits: st.hits });
    }
  }

  /* ---------- 2. 每步：只记回合/步号，用于「一回合只注入一次」 ---------- */
  function onPreStep(payload) {
    const agentId = (payload && payload.agent && payload.agent.id) || 'unknown';
    const st = stOf(agentId);
    if (typeof payload.step === 'number') st.step = payload.step;
    if (typeof payload.turn === 'number' && payload.turn !== st.turn) {
      st.turn = payload.turn;
      st.injectedTurn = null;
    }
  }

  /* ---------- 3. 注入：状态类问题才拼本地交接文档 ---------- */
  /* 统一出口：同一份内容在 ttlMs 内不重复注入；超长截断；账面一行限频。
     返回 '' 表示这次不注入。 */
  function commitInject(st, agentId, core, meta) {
    // 只拿核心内容算哈希：账面那一行有没有，不该影响「内容变没变」的判断
    const capped = core.length > cfg.inject.maxChars
      ? core.slice(0, cfg.inject.maxChars) + '\n…（注入截断）'
      : core;
    const h = hashText(capped);
    const now = Date.now();
    if (st.lastHash === h && now - (st.lastAt || 0) < cfg.inject.ttlMs) {
      metrics.log({ kind: 'inject-skip', reason: 'unchanged', agent: String(agentId).slice(0, 8), ...meta });
      return '';
    }
    st.lastHash = h;
    st.lastAt = now;
    st.injectedTurn = st.turn;
    st.injectedSession = true;
    const line = statsLineMaybe(st);
    const out = line ? capped + '\n\n' + line : capped;
    metrics.inject(meta.target || 'state', out, { agent: String(agentId).slice(0, 8), coreChars: capped.length, withStats: !!line, ...meta });
    return out;
  }

  /* 账面一行是否要带：默认 30 分钟一次，避免每轮都塞 */
  function statsLineMaybe(st) {
    if (!cfg.statsLine) return '';
    const now = Date.now();
    if (now - (st.lastStatsAt || 0) < cfg.inject.statsEveryMs) return '';
    st.lastStatsAt = now;
    return currentStatsLine();
  }

  function buildStateText() {
    if (cfg.injectMode !== 'context') return '';
    let agentId = 'unknown';
    try {
      const agents = ctx.get('agents');
      const a = agents && typeof agents.currentInitiator === 'function' ? agents.currentInitiator() : undefined;
      if (a && a.id) agentId = a.id;
    } catch { /* keep unknown */ }
    const st = stOf(agentId);
    if (!st.at) return '';
    if (Date.now() - st.at > cfg.stateTtlMs) return '';
    if (st.intent !== 'state' && st.intent !== 'mixed') return '';
    if (cfg.inject.strictState && st.intent !== 'state') return '';
    if (cfg.inject.firstTurns > 0 && (st.userCount || 0) > cfg.inject.firstTurns) return '';
    if (cfg.inject.oncePerSession && st.injectedSession) return '';
    if (cfg.injectOncePerTurn && st.injectedTurn === st.turn) return '';

    // 先看会话延续状态：比交接文档新、且够近，就优先用它（这样开新会话不用再写交接）
    let liveText = '';
    if (cfg.liveState.enabled && cfg.liveState.preferOverHandoff) {
      try {
        const lr = live.readFresh();
        if (lr && !lr.stale && lr.text && lr.text.includes('本次动过的文件')) liveText = lr.text;
      } catch { /* 读不到就走交接文档 */ }
    }

    let data = null;
    try { data = loadState(cfg); } catch (e) { metrics.diag('handoff-read', e); return ''; }

    if (liveText) {
      const header0 = '【记忆路由·会话延续状态】\n' +
        '来源：本地文件 live_state.md（自动生成）\n' +
        '这是上一次会话留下的现场，接着干就行；要更早的历史再查交接文档或 memory。\n';
      const core0 = header0 + '---\n' + liveText;
      return commitInject(st, agentId, core0, { target: 'live', file: 'live_state.md', intent: st.intent });
    }

    if (!data || !data.text) return '';

    const header = '【记忆路由·项目当前状态】\n' +
      '来源：本地文件 ' + data.sources.join(' + ') + '\n' +
      '这份状态已由本地文件直接给出，不要再为此检索 memory 向量库。问历史经验时再检索。\n';
    const core = header + '---\n' + data.text;
    return commitInject(st, agentId, core, { target: 'state', file: data.sources.join('+'), intent: st.intent });
  }

  /* ---------- 4. 工具结果裁剪 ---------- */
  /* PostToolDecision 的类型只有三种：accept+content、accept+value、block+feedback。
     带 value 时 content 必须缺省，所以改写结果一律走 accept+content 这一支。 */
  function rewriteDecision(decision, newBlocks) {
    if (!decision || typeof decision !== 'object') return null;
    if (decision.kind !== 'accept') return null;
    const out = { kind: 'accept', content: newBlocks };
    if (decision.additionalContexts) out.additionalContexts = decision.additionalContexts;
    return out;
  }

  /* 处理一次工具结果。顺序很重要：
     ① 先去重（同一工具同一参数，TTL 内直接复用上次的文本，连工具都不用再跑）
     ② 再去压缩（省得太少就跳过，避免为了省一点而让模型重读）
     ③ 无论走哪条，都把「最终给模型看的文本」写进缓存，供下一次命中 */
  async function handleToolResult(exec, result, decision) {
    const name = toolNameOf(exec);
    const args = argsTextOf(exec);
    const key = cfg.dedupe.enabled ? hashOf(name, args) : '';
    try { live.offerToolCall(name, args); } catch { /* 不影响主循环 */ }

    const blocks = textBlocksOf(result);
    const joined = blocks.length ? blocks.join('\n') : '';

    // ① 去重命中
    if (key) {
      const hit = dedupe.get(key);
      if (hit) {
        metrics.dedupe(name, hit.charsIn, hit.charsOut, { key });
        // 上次是压过的，这次又来问同一个 → 说明压过头了，记为负收益
        if (hit.wasTrimmed) metrics.reread(name, hit.savedTokens, { key });
        const cached = [{ type: 'text', text: hit.text }];
        return rewriteDecision(decision, cached) || decision;
      }
    }

    if (!joined) return decision;

    // ①.5 EDG：命中决策图节点，就由插件自己跑本地动作，用结果替换原始输出。
    // 与论文的差别：这里不能替模型发起新的工具调用，只能把「这次工具的输出」换成更小的结构化结果。
    if (cfg.edg.enabled && edg.nodes.length) {
      const hit = runEdg(edg, { tool: name, argsText: args, resultText: joined, cwd: process.cwd() }, {
        diag: (stage, info) => metrics.diag(stage, info),
        onHit: (node, ctx2, text) => metrics.edgHit(name, node.id, joined.length, text.length, node.terminal),
      });
      if (hit) {
        if (key) dedupe.set(key, { text: hit.text, charsIn: joined.length, charsOut: hit.text.length, wasTrimmed: true, savedTokens: 0 });
        return rewriteDecision(decision, [{ type: 'text', text: hit.text }]) || decision;
      }
    }

    if (cfg.debug && !shaped.has(name)) {
      shaped.add(name);
      metrics.diag('shape', {
        tool: name,
        execKeys: Object.keys(exec || {}).slice(0, 12),
        resultKeys: Object.keys(result || {}).slice(0, 12),
        decisionKeys: Object.keys(decision || {}).slice(0, 12),
      });
    }

    // ② 压缩，但要看阈值
    let finalText = joined;
    let wasTrimmed = false;
    let savedTokens = 0;

    if (cfg.trim.enabled && matchesTool(name, cfg.trim.toolPattern)) {
      const terms = queryTerms(args);
      const compressed = compressText(joined, terms, cfg.trim);
      const wouldSave = compressed.savedChars || 0;
      const ratio = joined.length ? wouldSave / joined.length : 0;
      // 三个条件缺一不可：确实省到字了、省够阈值、省的占比够。
      // 少写 wouldSave > 0 会在阈值为 0 时把「一个字都没省」也当成裁剪，
      // 进而把带 value 的 decision 改写成 content，丢掉 value（hooks 自测抓到的）。
      const enough = wouldSave > 0 && wouldSave >= (cfg.trim.minSavedChars | 0) && ratio >= (cfg.trim.minSavedRatio || 0);
      const dryRun = cfg.trim.dryRun !== false;

      if (!enough) {
        metrics.trimSkip(name, joined.length, wouldSave, { ratio: Math.round(ratio * 1000) / 1000 });
      } else if (dryRun) {
        metrics.trim(name, joined, compressed.text, { dryRun: true, kept: compressed.kept, total: compressed.total });
      } else {
        const before = metrics.tokens(joined), after = metrics.tokens(compressed.text);
        savedTokens = Math.max(0, before.tokens - after.tokens);
        metrics.trim(name, joined, compressed.text, { dryRun: false, kept: compressed.kept, total: compressed.total });
        finalText = compressed.text;
        wasTrimmed = true;
      }
    }

    // ③ 缓存「最终给模型看的文本」
    if (key) {
      dedupe.set(key, { text: finalText, charsIn: joined.length, charsOut: finalText.length, wasTrimmed, savedTokens });
    }

    if (!wasTrimmed) return decision;

    const newBlocks = [];
    let replaced = false;
    for (const b of (result.content || [])) {
      if (b && b.type === 'text') {
        if (!replaced) { newBlocks.push({ ...b, text: finalText }); replaced = true; }
      } else {
        newBlocks.push(b);
      }
    }
    const rewritten = rewriteDecision(decision, newBlocks);
    if (!rewritten) {
      metrics.diag('decision-not-rewritable', { tool: name, kind: decision && decision.kind });
      return decision;
    }
    return rewritten;
  }

  /* ---------- 注册 ---------- */
  ctx.on('agent/inbox/claimed', (payload) => {
    try { onUserMessage(payload); } catch (e) { metrics.diag('inbox-error', e); }
  });

  ctx.on('agent/pre-step', async (payload, next) => {
    try { onPreStep(payload); } catch (e) { metrics.diag('prestep-error', e); }
    return next();
  });

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next();
    try { return await handleToolResult(exec, result, decision); } catch (e) { metrics.diag('trim-error', e); return decision; }
  });

  ctx.on('agent/turn-stopping', () => {
    try { live.flush(); } catch { /* ignore */ }
    try { metrics.flush(); } catch { /* ignore */ }
  });

  try {
    if (cfg.liveState.enabled) {
      const archived = live.archiveIfStale(cfg.dataDir, cfg.liveState.staleHours);
      if (archived) metrics.diag('live-archived', { file: archived });
    }
  } catch { /* ignore */ }

  try { edg = loadEdg(cfg.edg.file, (stage, info) => metrics.diag(stage, info)); } catch { /* 载入失败就空图，全走老路径 */ }

  try {
    const sp = ctx.get('systemPrompt');
    if (sp && typeof sp.context === 'function' && cfg.injectMode === 'context') {
      sp.context({ name: 'memory-router-state', order: 5, text: () => buildStateText() });
    } else if (cfg.debug) {
      metrics.diag('no-system-prompt', { injectMode: cfg.injectMode });
    }
  } catch (e) { metrics.diag('context-register', e); }

  /* ---------- 可选：把账面做成一个工具，随时问「省了多少」 ----------
     默认不开：工具 schema 每一轮都进上下文，本身有固定成本。
     要在会话里随时问，就把 cordis.patch.yml 里的 statsTool 改成 true。 */
  if (cfg.statsTool) {
    try {
      const toolSvc = ctx.get('tools');
      if (toolSvc && typeof toolSvc.register === 'function') {
        toolSvc.register({
          name: 'memory_router_stats',
          description: '查看记忆路由插件在本机省下了多少 token（读本地账本，不联网，不调模型）。',
          parameters: {
            type: 'object',
            properties: { days: { type: 'number', description: '回看天数，默认 7' } },
            additionalProperties: false,
          },
          output: {
            schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
            render: (args, value) => [{ type: 'text', text: String((value && value.text) || '') }],
          },
          async execute(args) {
            metrics.flush();
            const sum = summarizeMetrics(cfg.metricsFile);
            const d = args && typeof args.days === 'number' ? Math.max(1, args.days) : 7;
            let text = statsLine(sum);
            if (sum) {
              const cutoff = Date.now() - d * 86400000;
              let saved = 0, spent = 0;
              for (const [k, v] of Object.entries(sum.perDay)) {
                if (new Date(k + 'T00:00:00Z').getTime() >= cutoff) { saved += v.saved; spent += v.spent; }
              }
              text += '\n最近 ' + d + ' 天：省 ' + saved + '、花 ' + spent + '、净 ' + (saved - spent);
              const top = Object.entries(sum.perTool).sort((a, b) => b[1].saved - a[1].saved).slice(0, 5);
              if (top.length) text += '\n分工具：' + top.map(([k, v]) => k + ' ' + v.calls + ' 次省 ' + v.saved).join('；');
            }
            return { text };
          },
        });
      } else {
        metrics.diag('no-tools-service', {});
      }
    } catch (e) { metrics.diag('stats-tool-register', e); }
  }

  metrics.diag('boot', { handoffDir: cfg.handoffDir, dataDir: cfg.dataDir, injectMode: cfg.injectMode, dryRun: cfg.trim.dryRun !== false, statsLine: cfg.statsLine, statsTool: cfg.statsTool });
}

