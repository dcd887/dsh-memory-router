/* 本地交接文档：找最新一份、按小节裁剪成「当前状态」。
   两份同一天的交接并存时（总账 + 单线版），按关键词优先，不靠 mtime 抢。
   只读文件，不联网，不碰向量库。 */

import fs from 'node:fs';
import path from 'node:path';

const CACHE = new Map(); // file -> { mtimeMs, text }

const STATE_HEAD = /(结论|待办|当前状态|现在该做什么|进度|现状|收尾|下一步|本轮|总账|怎么恢复|恢复上下文)/;
const DROP_HEAD = /(踩过的坑|踩坑|技术事实|目录一览|产物清单|文件清单)/;

function readCached(file) {
  const st = fs.statSync(file);
  const hit = CACHE.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.text;
  const text = fs.readFileSync(file, 'utf8');
  CACHE.set(file, { mtimeMs: st.mtimeMs, text });
  return text;
}

function dateStamp(name) {
  const m = /(\d{8})/.exec(name);
  return m ? m[1] : '';
}

/* 挑「最新那一天」的交接；同一天有多份时，名字含优先词的先选。
   preferKeywords 默认把「总账」排在同日单线版前面——实测两份 10-30 交接只差 4 秒，
   纯按 mtime 会选到单线版，丢掉总账里的待办。 */
export function newestHandoff(dir, prefix, preferKeywords) {
  if (!dir || !fs.existsSync(dir)) return null;
  const pre = String(prefix || '交接_').replace(/\*.*$/, '');
  const keywords = preferKeywords && preferKeywords.length ? preferKeywords : ['总账'];
  const files = fs.readdirSync(dir)
    .filter((n) => n.startsWith(pre) && n.toLowerCase().endsWith('.md'))
    .map((n) => ({ name: n, p: path.join(dir, n), m: fs.statSync(path.join(dir, n)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  if (!files.length) return null;

  const newestDay = dateStamp(files[0].name);
  const sameDay = files.filter((f) => dateStamp(f.name) === newestDay);
  for (const kw of keywords) {
    const hit = sameDay.find((f) => f.name.includes(kw));
    if (hit) return { file: hit.p, name: hit.name, mtimeMs: hit.m };
  }
  const f = sameDay[0] || files[0];
  return { file: f.p, name: f.name, mtimeMs: f.m };
}

/* 把 markdown 切成 [{head, lines}]，只认 #/##/### 级标题 */
function splitSections(text) {
  const out = [];
  let cur = { head: '', lines: [] };
  for (const line of String(text).split(/\r?\n/)) {
    if (/^#{1,4}\s/.test(line)) {
      out.push(cur);
      cur = { head: line.replace(/^#+\s*/, '').trim(), lines: [] };
    } else {
      cur.lines.push(line);
    }
  }
  out.push(cur);
  return out.filter((s) => s.head || s.lines.join('').trim());
}

function clip(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const nl = cut.lastIndexOf('\n');
  return (nl > max * 0.6 ? cut.slice(0, nl) : cut) + '\n…（已截断）';
}

/* 抽取「当前状态」文本：命中状态类小节优先，其次全文 */
export function extractState(markdown, maxChars) {
  const secs = splitSections(markdown);
  const keep = secs.filter((s) => !DROP_HEAD.test(s.head) && STATE_HEAD.test(s.head));
  let body;
  if (keep.length) {
    body = keep.map((s) => '### ' + s.head + '\n' + s.lines.join('\n').trim()).join('\n\n');
  } else {
    body = secs.map((s) => (s.head ? '### ' + s.head + '\n' : '') + s.lines.join('\n').trim()).join('\n\n');
  }
  return clip(body.trim(), maxChars);
}

/* 合并两个来源：自动摘要（project_memory.md）在前，最新交接在后，总量不超 stateChars。
   摘要给不超过 40% 的预算，剩下的给交接。 */
export function loadState(cfg) {
  const budget = Math.max(400, cfg.stateChars | 0 || 1800);
  const sources = [];
  let used = 0;

  const sumFile = cfg.summaryFile;
  if (sumFile && fs.existsSync(sumFile)) {
    try {
      const raw = readCached(sumFile);
      const cap = Math.min(Math.floor(budget * 0.4), 700);
      const text = clip(raw.trim(), Math.min(cap, budget - used));
      if (text) { sources.push({ name: path.basename(sumFile), text, kind: 'summary' }); used += text.length; }
    } catch { /* ignore */ }
  }

  const found = newestHandoff(cfg.handoffDir, cfg.handoffGlob, cfg.handoffPrefer);
  if (found) {
    try {
      const md = readCached(found.file);
      const rest = budget - used;
      if (rest > 200) {
        const text = extractState(md, rest);
        if (text) { sources.push({ name: found.name, text, kind: 'handoff', mtimeMs: found.mtimeMs }); used += text.length; }
      }
    } catch { /* ignore */ }
  }

  if (!sources.length) return null;
  const body = sources.map((s) => '#### 来源：' + s.name + '\n' + s.text).join('\n\n');
  return { text: body, sources: sources.map((s) => s.name), mtimeMs: (sources.find((s) => s.mtimeMs) || {}).mtimeMs };
}
