/* 工具调用去重缓存：同一个工具 + 同一份参数，在 TTL 内再来一次，直接给上次给模型看过的内容。
   目的：省掉一次重复的工具执行，也省掉模型因为「记不清上次结果」而重发的那一轮往返。
   只存文本摘要，不存二进制；条数有上限，超了按 LRU 淘汰。 */

import crypto from 'node:crypto';

export function hashOf(tool, argsText) {
  const h = crypto.createHash('sha1');
  h.update(String(tool || ''));
  h.update('\u0000');
  h.update(String(argsText || ''));
  return h.digest('hex').slice(0, 16);
}

export class TtlCache {
  constructor(cfg = {}) {
    this.ttlMs = Math.max(0, cfg.ttlMs | 0 || 60000);
    this.maxEntries = Math.max(1, cfg.maxEntries | 0 || 200);
    this.map = new Map();   // key -> { text, charsIn, charsOut, wasTrimmed, savedTokens, at }
  }

  get(key) {
    if (!key || !this.ttlMs) return null;
    const e = this.map.get(key);
    if (!e) return null;
    if (Date.now() - e.at > this.ttlMs) { this.map.delete(key); return null; }
    // LRU：命中后挪到队尾
    this.map.delete(key);
    this.map.set(key, e);
    return e;
  }

  set(key, entry) {
    if (!key || !this.ttlMs) return;
    this.map.set(key, { at: Date.now(), ...entry });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }

  clear() { this.map.clear(); }
  get size() { return this.map.size; }
}
