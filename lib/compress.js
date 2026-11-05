/* 检索结果压缩：只保留最相关的前 N 条，总字数封顶。
   针对 @modelcontextprotocol/server-memory 的返回形状（entities/relations），
   认不出来就退化成「按行截断」，不猜。 */

function parseJson(text) {
  const t = String(text || '').trim();
  if (!t || (t[0] !== '{' && t[0] !== '[')) return undefined;
  try { return JSON.parse(t); } catch { return undefined; }
}

function scoreOf(entity, terms) {
  const hay = [entity.name, entity.entityType, ...(entity.observations || [])].join(' ').toLowerCase();
  let s = 0;
  for (const t of terms) if (t && hay.includes(t)) s += t.length >= 2 ? 2 : 1;
  return s;
}

function clip(s, n) {
  const str = String(s == null ? '' : s);
  return str.length <= n ? str : str.slice(0, n) + '…';
}

/* 返回 { text, kept, total, savedChars } */
export function compressText(rawText, terms, cfg) {
  const raw = String(rawText || '');
  const maxItems = Math.max(1, cfg.maxItems | 0 || 2);
  const maxChars = Math.max(80, cfg.maxChars | 0 || 500);
  const parsed = parseJson(raw);

  if (parsed && Array.isArray(parsed.entities)) {
    const all = parsed.entities.map((e, i) => ({ e, i, s: scoreOf(e, terms) }));
    const ranked = all.slice().sort((a, b) => b.s - a.s || a.i - b.i);
    const kept = ranked.slice(0, maxItems);
    const lines = [];
    lines.push('记忆命中 ' + parsed.entities.length + ' 个实体，保留前 ' + kept.length + ' 条：');
    const perEntity = Math.max(120, Math.floor((maxChars - 60) / Math.max(1, kept.length)));
    for (const { e } of kept) {
      lines.push('- ' + (e.name || '(无名)') + '（' + (e.entityType || '未分类') + '）');
      /* 观察按相关度排，再看字数预算收：相关的先留，不搞「只留前三条」那种一刀切 */
      const obs = (e.observations || []).map((o, i) => ({ o, i, s: scoreOf({ observations: [o] }, terms) }))
        .sort((a, b) => b.s - a.s || a.i - b.i);
      let used = 0;
      for (const { o } of obs) {
        const piece = clip(o, 160);
        if (used + piece.length > perEntity && used > 0) continue;
        lines.push('  · ' + piece);
        used += piece.length;
        if (used >= perEntity) break;
      }
    }
    if (parsed.relations && parsed.relations.length) {
      lines.push('（另有 ' + parsed.relations.length + ' 条关系未展开）');
    }
    let text = lines.join('\n');
    if (text.length > maxChars) text = clip(text, maxChars) + '\n…（按字数上限截断）';
    return { text, kept: kept.length, total: parsed.entities.length, savedChars: Math.max(0, raw.length - text.length) };
  }

  /* 认不出结构：只做整体截断，绝不改写内容 */
  if (raw.length <= maxChars) return { text: raw, kept: 0, total: 0, savedChars: 0 };
  const text = clip(raw, maxChars) + '\n…（按字数上限截断）';
  return { text, kept: 0, total: 0, savedChars: raw.length - text.length };
}

/* 工具名是否属于要管的记忆工具 */
export function matchesTool(name, pattern) {
  if (!name) return false;
  try { return new RegExp(pattern || '^(mcp__)?memory').test(String(name)); } catch { return false; }
}
