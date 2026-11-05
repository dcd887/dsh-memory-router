/* 后台摘要：把最近 N 条用户消息压成 3 条要点，追加到 project_memory.md。
   触发条件：每累计 everyUserMessages 条用户消息触发一次（默认 10）。
   不阻塞当前回合：fire-and-forget，失败只记诊断，不抛。 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROMPT_FILE = path.join(HERE, '..', 'prompts', 'summarize.txt');

function readPrompt() {
  try { return fs.readFileSync(PROMPT_FILE, 'utf8'); } catch { return ''; }
}

const FALLBACK_PROMPT = [
  '下面是一个人最近与编码助手的对话片段（只有用户这一侧）。',
  '请压成恰好 3 条要点，每条一行，20 到 40 个汉字，不要标题、不要编号、不要解释。',
  '要点写：他在推进什么、卡在哪、下一步最可能做什么。',
  '',
  '对话：',
  '{{messages}}',
].join('\n');

export class SummaryScheduler {
  constructor(opts) {
    this.cfg = opts.cfg;
    this.metrics = opts.metrics;
    this.getLlm = opts.getLlm;
    this.getModel = opts.getModel;
    this.file = opts.file;
    this.buffers = new Map();   // agentId -> string[]
    this.counts = new Map();    // agentId -> number
    this.running = new Set();
  }

  push(agentId, text) {
    if (!this.cfg.enabled) return;
    const key = String(agentId || 'unknown');
    const n = (this.counts.get(key) || 0) + 1;
    this.counts.set(key, n);
    const buf = this.buffers.get(key) || [];
    buf.push(String(text || '').slice(0, 1200));
    while (buf.length > (this.cfg.windowMessages || 10)) buf.shift();
    this.buffers.set(key, buf);
    const every = Math.max(2, this.cfg.everyUserMessages || 10);
    if (n % every === 0) this.run(key, buf.slice());
  }

  async run(key, messages) {
    if (this.running.has(key)) return;
    this.running.add(key);
    const t0 = Date.now();
    try {
      const llm = this.getLlm && this.getLlm();
      if (!llm || typeof llm.stream !== 'function') {
        this.metrics.diag('summary', { reason: 'no llm service' });
        return;
      }
      const sel = (this.getModel && this.getModel()) || {};
      const provider = this.cfg.provider || sel.provider || sel.providerId;
      const model = this.cfg.model || sel.model || sel.modelId;
      if (!provider || !model) {
        this.metrics.diag('summary', { reason: 'no provider/model', sel: Object.keys(sel || {}) });
        return;
      }

      const tpl = readPrompt() || FALLBACK_PROMPT;
      const body = messages.map((m, i) => (i + 1) + '. ' + m.replace(/\s+/g, ' ').slice(0, 400)).join('\n');
      const prompt = tpl.replace('{{messages}}', body);

      let out = '';
      const stream = llm.stream({
        provider, model,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        temperature: 0.2,
        maxTokens: this.cfg.maxOutputTokens || 300,
      });
      for await (const chunk of stream) {
        if (chunk && chunk.type === 'text-delta' && chunk.text) out += chunk.text;
      }
      out = String(out || '').trim();
      if (!out) { this.metrics.diag('summary', { reason: 'empty output', ms: Date.now() - t0 }); return; }

      const bullets = out.split('\n').map((l) => l.replace(/^\s*[-·•\d.、]+\s*/, '').trim()).filter(Boolean).slice(0, 3);
      if (!bullets.length) { this.metrics.diag('summary', { reason: 'no bullets' }); return; }

      this.append(bullets, key);
      const { tokens } = this.metrics.tokens(out);
      this.metrics.log({ kind: 'summary', agent: key, bullets: bullets.length, outChars: out.length, outTokens: tokens, ms: Date.now() - t0 });
    } catch (e) {
      this.metrics.diag('summary-error', e);
    } finally {
      this.running.delete(key);
    }
  }

  append(bullets, key) {
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
    const block = '\n## ' + stamp + ' · 自动摘要（' + key.slice(0, 8) + '）\n' +
      bullets.map((b) => '- ' + b).join('\n') + '\n';
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      if (!fs.existsSync(this.file)) {
        fs.writeFileSync(this.file, '# 项目当前状态（自动摘要）\n\n> 由记忆路由插件写入；每条 3 行要点，最新在最下面。\n', 'utf8');
      }
      fs.appendFileSync(this.file, block, 'utf8');
      const st = fs.statSync(this.file);
      if (st.size > 64 * 1024) {
        const text = fs.readFileSync(this.file, 'utf8');
        fs.writeFileSync(this.file, '# 项目当前状态（自动摘要，已裁剪）\n\n' + text.slice(-32 * 1024), 'utf8');
      }
    } catch (e) {
      this.metrics.diag('summary-append', e);
    }
  }
}
