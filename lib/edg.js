/* EDG：可执行决策图（Executable Decision Graph）的本地实现。
   一条节点 = 「什么工具 + 什么参数形状 + 什么守卫为真 → 插件自己跑哪几个本地动作」。

   三条硬规矩（照重构方案）：
     1. guard 只允许白名单算子，绝不调模型；
     2. 本地动作只允许 readJson / readFileSlice / grep / stat，不接 shell；
     3. 任何一步抛异常 → 整个节点作废，调用方回落老路径，并记 diag。
*/

import fs from 'node:fs';
import path from 'node:path';

const MAX_OUT = 4000;          // 单节点产出上限，超了截断，防止反而变大
const MAX_GREP_LINES = 60;

/* ---------------- 载入 ---------------- */

export function loadEdg(file, diag) {
  const out = { file, nodes: [], loadedAt: 0, error: '' };
  try {
    if (!file || !fs.existsSync(file)) return out;
    const raw = fs.readFileSync(file, 'utf8');
    const json = JSON.parse(raw);
    const nodes = Array.isArray(json) ? json : (json && json.nodes) || [];
    out.nodes = nodes.filter((n) => n && typeof n === 'object' && n.id && n.then);
    out.loadedAt = Date.now();
  } catch (e) {
    out.error = e && e.message ? e.message : String(e);
    if (diag) diag('edg-load-error', out.error);
  }
  return out;
}

/* ---------------- 匹配 ---------------- */

function asText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

export function matchNode(node, tool, argsText) {
  const m = node.match;
  if (!m) return false;
  if (m.tool) {
    const re = m.tool instanceof RegExp ? m.tool : new RegExp(m.tool);
    if (!re.test(tool)) return false;
  }
  const args = m.args || {};
  for (const key of Object.keys(args)) {
    const spec = args[key];
    let actual;
    try {
      const obj = JSON.parse(argsText || '{}');
      actual = asText(obj[key]);
    } catch { actual = argsText; }
    if (spec && typeof spec === 'object' && spec.$re) {
      if (!new RegExp(spec.$re).test(actual)) return false;
    } else if (spec && typeof spec === 'object' && spec.$has) {
      if (!actual.includes(spec.$has)) return false;
    } else if (asText(spec) !== actual) return false;
  }
  return true;
}

/* ---------------- 守卫（纯本地，白名单算子） ---------------- */

function evalOne(cond, ctx) {
  if (cond.exitCode !== undefined) {
    return Number(ctx.exitCode) === Number(cond.exitCode);
  }
  if (cond.fileExists !== undefined) {
    const p = resolvePath(cond.fileExists, ctx);
    return !!p && fs.existsSync(p);
  }
  if (cond.regex !== undefined) {
    return new RegExp(cond.regex, cond.flags || '').test(ctx.resultText || '');
  }
  if (cond.minChars !== undefined) {
    return (ctx.resultText || '').length >= Number(cond.minChars);
  }
  if (cond.jsonPath !== undefined) {
    let cur;
    try { cur = JSON.parse(ctx.resultText || 'null'); } catch { return false; }
    for (const seg of String(cond.jsonPath).split('.')) {
      if (cur == null) return false;
      cur = cur[seg];
    }
    if (cond.eq !== undefined) return asText(cur) === asText(cond.eq);
    if (cond.gt !== undefined) return Number(cur) > Number(cond.gt);
    return cur !== undefined && cur !== null;
  }
  return false;   // 不认识的算子一律为假，宁可回落
}

export function evalGuard(guard, ctx) {
  if (!guard) return true;
  if (Array.isArray(guard.all)) return guard.all.every((c) => evalOne(c, ctx));
  if (Array.isArray(guard.any)) return guard.any.some((c) => evalOne(c, ctx));
  return evalOne(guard, ctx);
}

/* ---------------- 本地动作（白名单） ---------------- */

function resolvePath(p, ctx) {
  if (!p) return '';
  let s = String(p);
  s = s.replace(/\$\{cwd\}/g, ctx.cwd || process.cwd());
  s = s.replace(/\$\{args\.([a-zA-Z0-9_]+)\}/g, (_, k) => {
    try { return asText(JSON.parse(ctx.argsText || '{}')[k]); } catch { return ''; }
  });
  if (!path.isAbsolute(s)) s = path.resolve(ctx.cwd || process.cwd(), s);
  return s;
}

function pickFields(obj, picks) {
  if (!picks || !picks.length) return obj;
  const out = {};
  for (const k of picks) if (obj && obj[k] !== undefined) out[k] = obj[k];
  return out;
}

function runAction(step, ctx) {
  const act = String(step.act || '');
  const target = resolvePath(step.path, ctx);

  if (act === 'readJson') {
    const raw = fs.readFileSync(target, 'utf8');
    const json = JSON.parse(raw);
    const arr = Array.isArray(json) ? json : (json.items || json.entities || json.data || [json]);
    const limit = Math.max(1, step.limit | 0 || 20);
    const sliced = Array.isArray(arr) ? arr.slice(0, limit) : [arr];
    const shaped = sliced.map((x) => (step.pick ? pickFields(x, step.pick) : x));
    return JSON.stringify({ file: path.basename(target), total: Array.isArray(arr) ? arr.length : 1, sample: shaped });
  }

  if (act === 'readFileSlice') {
    const raw = fs.readFileSync(target, 'utf8');
    const lines = raw.split('\n');
    const from = Math.max(0, (step.from | 0) || 0);
    const n = Math.max(1, step.lines | 0 || 20);
    return lines.slice(from, from + n).join('\n');
  }

  if (act === 'grep') {
    const raw = fs.readFileSync(target, 'utf8');
    const re = new RegExp(step.pattern || '.', step.flags || '');
    const hits = [];
    raw.split('\n').forEach((line, i) => {
      if (hits.length >= Math.min(MAX_GREP_LINES, step.maxLines | 0 || 20)) return;
      if (re.test(line)) hits.push((i + 1) + ': ' + line.trim().slice(0, 200));
    });
    return hits.length ? hits.join('\n') : '(无命中)';
  }

  if (act === 'stat') {
    const st = fs.statSync(target);
    return JSON.stringify({ file: path.basename(target), size: st.size, mtime: st.mtime.toISOString() });
  }

  throw new Error('未知动作: ' + act);
}

/* ---------------- 主入口 ---------------- */

export function runEdg(edg, ctx, hooks = {}) {
  if (!edg || !edg.nodes || !edg.nodes.length) return null;
  const { diag, onHit } = hooks;
  for (const node of edg.nodes) {
    let matched = false;
    try {
      matched = matchNode(node, ctx.tool, ctx.argsText);
      if (!matched) continue;
      if (!evalGuard(node.guard, ctx)) continue;

      const parts = [];
      for (const step of node.then) parts.push(runAction(step, ctx));
      let text = parts.join('\n').trim();
      if (!text) continue;
      if (text.length > MAX_OUT) text = text.slice(0, MAX_OUT) + '\n…（截断）';

      if (onHit) onHit(node, ctx, text);
      return { node, text };
    } catch (e) {
      if (diag) diag('edg-node-error', { node: node.id, message: e && e.message ? e.message : String(e) });
      continue;   // 这一节点作废，继续试下一个；都不成则调用方回落
    }
  }
  return null;
}
