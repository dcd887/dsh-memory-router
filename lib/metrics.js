/* 记账：每条注入 / 每次裁剪写一行 jsonl，用来事后算「省了多少」。
   token 数优先用宿主自带的 tokenMeter 估；估不了才退回字符换算，并如实标注 method。 */

import fs from 'node:fs';
import path from 'node:path';

/* 兜底换算：中文 1.5 字/token，ASCII 4 字/token。数值写死在这里，可按需改。 */
export function estimateByChars(text) {
  const s = String(text || '');
  let cjk = 0, other = 0;
  for (const ch of s) {
    if (/[\u3400-\u9fff\uf900-\ufaff]/.test(ch)) cjk++;
    else other++;
  }
  return Math.max(1, Math.ceil(cjk / 1.5 + other / 4));
}

export class Metrics {
  constructor(cfg, meter) {
    this.file = cfg.metricsFile;
    this.meter = meter;          // (text) => number | undefined
    this.buf = [];
    this.flushTimer = null;
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); } catch { /* ignore */ }
  }

  tokens(text) {
    if (this.meter) {
      try {
        const n = this.meter(text);
        if (typeof n === 'number' && n > 0) return { tokens: n, method: 'meter' };
      } catch { /* fall through */ }
    }
    return { tokens: estimateByChars(text), method: 'chars' };
  }

  log(entry) {
    try {
      const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
      this.buf.push(line);
      if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 1500);
    } catch { /* never break the loop for logging */ }
  }

  flush() {
    this.flushTimer = null;
    if (!this.buf.length) return;
    const lines = this.buf.join('\n') + '\n';
    this.buf = [];
    try { fs.appendFileSync(this.file, lines, 'utf8'); } catch { /* ignore */ }
  }

  inject(kind, text, extra) {
    const { tokens, method } = this.tokens(text);
    this.log({ kind: 'inject', target: kind, chars: String(text || '').length, tokens, method, ...extra });
  }

  trim(tool, before, after, extra) {
    const b = this.tokens(before), a = this.tokens(after);
    this.log({
      kind: 'trim', tool,
      charsBefore: String(before || '').length, charsAfter: String(after || '').length,
      tokensBefore: b.tokens, tokensAfter: a.tokens,
      savedTokens: Math.max(0, b.tokens - a.tokens),
      method: b.method, ...extra,
    });
  }

  /* 去重命中：这次没有调工具，直接复用了上次给模型看过的文本。
     savedTokens 记「少喂进去的那部分」——charsIn 是原始工具输出，charsOut 是复用的摘要。 */
  dedupe(tool, charsIn, charsOut, extra) {
    const b = this.tokens('x'.repeat(Math.max(0, charsIn | 0)));
    const a = this.tokens('x'.repeat(Math.max(0, charsOut | 0)));
    this.log({
      kind: 'dedupe', tool,
      charsIn: charsIn | 0, charsOut: charsOut | 0,
      savedTokens: Math.max(0, b.tokens - a.tokens), method: b.method, ...extra,
    });
  }

  /* 因压缩过头导致的二次读取：同一调用又来了，说明上次给的细节不够。
     这是负收益，必须单独记，不能混进 trim 的省钱里。 */
  reread(tool, lostTokens, extra) {
    this.log({ kind: 'reread', tool, lostTokens: Math.max(0, lostTokens | 0), ...extra });
  }

  /* 该压没压：省下来的太少，按阈值跳过，避免为省一点而害模型重读 */
  trimSkip(tool, charsBefore, wouldSaveChars, extra) {
    this.log({ kind: 'trim-skip', tool, charsBefore: charsBefore | 0, wouldSaveChars: wouldSaveChars | 0, ...extra });
  }

  /* EDG 命中：插件自己跑了本地动作，用结构化结果替换了原始工具输出。
     注意 turnsAvoided 只在 terminal 节点记 1，其它一律 0 —— 宁可少报。 */
  edgHit(tool, nodeId, charsIn, charsOut, terminal) {
    const b = this.tokens('x'.repeat(Math.max(0, charsIn | 0)));
    const a = this.tokens('x'.repeat(Math.max(0, charsOut | 0)));
    this.log({
      kind: 'edg', tool, node: nodeId,
      charsIn: charsIn | 0, charsOut: charsOut | 0,
      savedTokens: Math.max(0, b.tokens - a.tokens), method: b.method,
      terminal: !!terminal, turnsAvoided: terminal ? 1 : 0,
    });
  }

  diag(stage, info) {
    let payload = info;
    if (info instanceof Error) payload = { message: info.message, stack: String(info.stack || '').split('\n').slice(0, 3).join(' | ') };
    this.log({ kind: 'diag', stage, ...(typeof payload === 'object' ? payload : { info: String(payload) }) });
  }
}

/* 读整份账的成本行 */
export function readRows(file) {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 坏行跳过，不让一行脏数据毁掉整份账 */ }
  }
  return out;
}

/* 读整份账，给出汇总：注入花了多少、裁剪省了多少、净收益；再按天、按工具拆开 */
export function summarizeMetrics(file) {
  const rows = readRows(file);
  if (!rows.length) return null;
  const by = { injectChars: 0, injectTokens: 0, savedTokens: 0, trims: 0, injects: 0, summaryCalls: 0, summaryTokens: 0, diag: 0, methods: {},
               dedupeHits: 0, dedupeSaved: 0, rereadCount: 0, rereadLost: 0, trimSkips: 0, edgHits: 0, edgSaved: 0, edgTurns: 0 };
  const perTool = {};
  const perDay = {};
  let first = null, last = null;

  const day = (ts) => String(ts || '').slice(0, 10);
  const bucket = (d) => (perDay[d] = perDay[d] || { saved: 0, spent: 0, trims: 0, injects: 0, net: 0 });

  for (const r of rows) {
    if (!first) first = r.ts;
    last = r.ts;
    const d = bucket(day(r.ts));
    if (r.kind === 'inject') {
      by.injects++; by.injectChars += r.chars || 0; by.injectTokens += r.tokens || 0;
      by.methods[r.method || '?'] = (by.methods[r.method || '?'] || 0) + 1;
      d.injects++; d.spent += r.tokens || 0;
    } else if (r.kind === 'trim') {
      by.trims++; by.savedTokens += r.savedTokens || 0;
      const k = r.tool || '?';
      perTool[k] = perTool[k] || { calls: 0, saved: 0, charsBefore: 0, charsAfter: 0 };
      perTool[k].calls++;
      perTool[k].saved += r.savedTokens || 0;
      perTool[k].charsBefore += r.charsBefore || 0;
      perTool[k].charsAfter += r.charsAfter || 0;
      by.methods[r.method || '?'] = (by.methods[r.method || '?'] || 0) + 1;
      d.trims++; d.saved += r.savedTokens || 0;
    } else if (r.kind === 'dedupe') {
      by.dedupeHits++; by.dedupeSaved += r.savedTokens || 0;
      d.saved += r.savedTokens || 0;
      by.methods[r.method || '?'] = (by.methods[r.method || '?'] || 0) + 1;
    } else if (r.kind === 'edg') {
      by.edgHits++; by.edgSaved += r.savedTokens || 0; by.edgTurns += r.turnsAvoided || 0;
      d.saved += r.savedTokens || 0;
      by.methods[r.method || '?'] = (by.methods[r.method || '?'] || 0) + 1;
    } else if (r.kind === 'reread') {
      by.rereadCount++; by.rereadLost += r.lostTokens || 0;
      d.spent += r.lostTokens || 0;
    } else if (r.kind === 'trim-skip') {
      by.trimSkips++;
    } else if (r.kind === 'summary') {
      by.summaryCalls++; by.summaryTokens += r.outTokens || 0;
      d.spent += r.outTokens || 0;
    } else if (r.kind === 'diag') by.diag++;
  }
  for (const d of Object.values(perDay)) d.net = d.saved - d.spent;

  return { file, rows: rows.length, first, last, ...by,
           net: by.savedTokens + by.dedupeSaved + by.edgSaved - by.rereadLost - by.injectTokens - by.summaryTokens,
           perTool, perDay };
}

/* 一行话：给注入块末尾或命令行用，不占地方 */
export function statsLine(sum) {
  if (!sum) return '记忆路由账面：还没有数据。';
  return '记忆路由账面：裁剪省 ' + sum.savedTokens + '（' + sum.trims + ' 次）、去重省 ' + (sum.dedupeSaved || 0) +
    '（' + (sum.dedupeHits || 0) + ' 次）、决策图省 ' + (sum.edgSaved || 0) + '（' + (sum.edgHits || 0) + ' 次）、重读赔 ' + (sum.rereadLost || 0) + '（' + (sum.rereadCount || 0) + ' 次）、注入花 ' +
    sum.injectTokens + '，净 ' + (sum.net >= 0 ? '+' : '') + sum.net + '。';
}
