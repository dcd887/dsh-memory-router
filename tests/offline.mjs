/* 离线自测：不装插件也能验纯函数。node tests/offline.mjs */

import { classify } from '../lib/intent.js';
import { loadState, extractState, newestHandoff } from '../lib/handoff.js';
import { compressText } from '../lib/compress.js';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')); }
}

console.log('意图判定');
const cases = [
  ['当前状态如何，还有什么没做完', 'state'],
  ['接着上次做，下一步干嘛', 'state'],
  ['唯一解的待办还剩几件', 'state'],
  ['以前踩过什么坑', 'history'],
  ['当时为什么这么决定', 'history'],
  ['查一下记忆里有没有类似经验', 'history'],
  ['你好', 'none'],
  ['把这段代码格式化一下', 'none'],
];
for (const [text, want] of cases) {
  const v = classify(text);
  ok(text + ' → ' + want, v.intent === want, 'actual=' + v.intent);
}

console.log('');
console.log('压缩检索结果');
const kg = JSON.stringify({
  entities: [
    { name: '税则通', entityType: '项目', observations: ['已备案上线', '宽测 195/195', '部署包 v5.1'] },
    { name: '唯一解H5', entityType: '项目', observations: ['三案本格推理', '已上线 GitHub Pages', '谜页集审核中'] },
    { name: '关盾 Agent', entityType: '项目', observations: ['ModelScope 已部署'] },
  ],
  relations: [{ from: '唯一解H5', to: '税则通', relationType: '无关' }],
});
const c1 = compressText(kg, ['唯一解', '谜页集'], { maxItems: 2, maxChars: 500 });
ok('保留 2 条', c1.kept === 2, 'kept=' + c1.kept);
ok('最相关排第一', c1.text.includes('唯一解H5'), c1.text.slice(0, 60));
ok('字数下降', c1.savedChars > 0, 'saved=' + c1.savedChars);
ok('不超过字数上限', c1.text.length <= 560, 'len=' + c1.text.length);

const long = 'x'.repeat(2000);
const c2 = compressText(long, [], { maxItems: 2, maxChars: 500 });
ok('纯文本超长也截断', c2.text.length <= 520 && c2.savedChars > 0, 'len=' + c2.text.length);

console.log('');
console.log('本地交接文档');
const found = newestHandoff('C:\\Users\\kjds\\Desktop\\DSH输出\\_workflows', '交接_*.md');
ok('找到最新交接', !!found, 'none');
if (found) {
  console.log('       → ' + found.file);
  const state = loadState({ handoffDir: 'C:\\Users\\kjds\\Desktop\\DSH输出\\_workflows', handoffGlob: '交接_*.md', stateChars: 1800 });
  ok('抽出内容', !!state && state.text.length > 100, 'len=' + (state?.text?.length || 0));
  ok('不超字数预算', state.text.length <= 1900, 'len=' + state.text.length);
  ok('含待办或结论', /待办|结论|当前状态|进度/.test(state.text), state.text.slice(0, 40));
  const big = extractState('# A\n## 结论\n短\n## 待办\n1. x\n', 1800);
  ok('空段不炸', typeof big === 'string' && big.length > 0, big);
}

console.log('');
console.log('通过 ' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);
