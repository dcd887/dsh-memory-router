import { loadState } from '../lib/handoff.js';
import { estimateByChars } from '../lib/metrics.js';
const s = loadState({ handoffDir: 'C:\\Users\\kjds\\Desktop\\DSH输出\\_workflows', handoffGlob: '交接_*.md', stateChars: 1800 });
const header = '【记忆路由·项目当前状态】\n来源：本地文件 ' + s.sources.join(' + ') + '\n这份状态已由本地文件直接给出，不要再为此检索 memory 向量库。问历史经验时再检索。\n---\n';
const text = header + s.text;
console.log('sources: ' + s.sources.join(' + '));
console.log('正文 ' + s.text.length + ' 字；含头 ' + text.length + ' 字；按字估算约 ' + estimateByChars(text) + ' token');
console.log('前 120 字：' + text.slice(0, 120).replace(/\n/g, ' / '));
