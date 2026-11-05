/* 会话延续器：把「现在在干什么、改过哪些文件」自动落到 live_state.md，
   新会话第一轮直接注入它，不用人再写交接文档。

   只记确定性的东西（用户说过什么、动过哪些文件），不编「下一步」。
   「下一步」由摘要调度器那一侧提供，没有就留空，不猜。 */

import fs from 'node:fs';
import path from 'node:path';

const FILE_TOOLS = /^(write|edit|multi_edit|apply_patch|create_file|fs_write|fs_edit|str_replace)/i;

export class LiveState {
  constructor(cfg, metrics) {
    this.cfg = cfg;                       // { enabled, file, maxFiles, maxUser, staleHours }
    this.metrics = metrics;
    this.files = [];                      // 最近动过的文件，新的在前
    this.users = [];                      // 最近几条用户消息（截断）
    this.timer = null;
    this.writes = 0;
    this.lastSig = '';
  }

  get enabled() { return !!this.cfg.enabled; }

  /** 记一条用户消息（截断到 80 字，去掉换行） */
  recordUser(text) {
    if (!this.enabled) return;
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return;
    // 连续重复的同一句话不重复记：既省得注入里出现两行一样的话，
    // 也让内容签名稳定（否则同一句话问两遍会触发重写，注入闸门就失效了）
    if (this.users[0] === t.slice(0, 80)) return;
    this.users.unshift(t.slice(0, 80));
    if (this.users.length > (this.cfg.maxUser | 0 || 5)) this.users.length = this.cfg.maxUser | 0 || 5;
    this.schedule();
  }

  /** 记一个被工具改过的文件路径 */
  recordFile(p) {
    if (!this.enabled || !p) return;
    const s = String(p).replace(/\\/g, '/');
    this.files = this.files.filter((x) => x !== s);
    this.files.unshift(s);
    if (this.files.length > (this.cfg.maxFiles | 0 || 20)) this.files.length = this.cfg.maxFiles | 0 || 20;
    this.writes += 1;
    this.schedule();
  }

  /** 从工具执行里认出「这次改了哪个文件」 */
  offerToolCall(tool, argsText) {
    if (!this.enabled) return;
    if (!FILE_TOOLS.test(String(tool || ''))) return;
    let args = {};
    try { args = JSON.parse(argsText || '{}'); } catch { return; }
    const p = args.file_path || args.path || args.file || args.filename;
    if (typeof p === 'string' && p) this.recordFile(p);
  }

  schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 1500);
    if (this.timer.unref) this.timer.unref();
  }

  render() {
    const lines = [];
    lines.push('# 会话延续状态（自动生成，不用手改）');
    lines.push('');
    lines.push('更新时间：' + new Date().toISOString().slice(0, 19).replace('T', ' '));
    lines.push('');
    lines.push('## 最近在处理');
    if (this.users.length) for (const u of this.users) lines.push('- ' + u);
    else lines.push('- （本次会话还没有用户消息）');
    lines.push('');
    lines.push('## 本次动过的文件');
    if (this.files.length) for (const f of this.files) lines.push('- ' + f);
    else lines.push('- （还没有写操作）');
    lines.push('');
    lines.push('## 怎么用');
    lines.push('新会话第一轮会自动注入这份状态。要接着干，直接说「接着上次」即可，不用再写交接文档。');
    lines.push('');
    return lines.join('\n');
  }

  /* 内容签名：只看「说了什么、动了哪些文件」，不含时间戳。
     内容没变就不重写文件——否则每轮的更新时间会让下游的内容哈希失效。 */
  signature() {
    return this.users.join('\u0001') + '\u0002' + this.files.join('\u0001');
  }

  flush(force) {
    if (!this.enabled) return;
    const sig = this.signature();
    if (!force && sig === this.lastSig) return;
    this.lastSig = sig;
    try {
      fs.mkdirSync(path.dirname(this.cfg.file), { recursive: true });
      fs.writeFileSync(this.cfg.file, this.render(), 'utf8');
      if (this.metrics) this.metrics.log({ kind: 'live', files: this.files.length, users: this.users.length });
    } catch { /* 落盘失败不影响主循环 */ }
  }

  /** 读现有状态；超过 staleHours 视为过期，返回 null */
  readFresh() {
    try {
      if (!fs.existsSync(this.cfg.file)) return null;
      const st = fs.statSync(this.cfg.file);
      const ageH = (Date.now() - st.mtimeMs) / 3600000;
      if (ageH > (this.cfg.staleHours || 24)) return { text: '', ageH, stale: true };
      return { text: fs.readFileSync(this.cfg.file, 'utf8'), ageH, stale: false };
    } catch { return null; }
  }

  /** 启动时：把过期的旧状态归档成带日期的交接文件，别覆盖丢掉 */
  archiveIfStale(dir, keepHours) {
    try {
      const r = this.readFresh();
      if (!r || !r.stale) return null;
      const d = new Date();
      const name = 'live_state_' + d.toISOString().slice(0, 10) + '.md';
      const dest = path.join(dir, name);
      if (!fs.existsSync(dest)) fs.copyFileSync(this.cfg.file, dest);
      return dest;
    } catch { return null; }
  }
}
