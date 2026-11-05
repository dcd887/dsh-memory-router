/* 意图判定：纯正则，毫秒级，不调模型。
   分三档：state（当前任务状态）/ history（历史经验）/ none（不注入，省钱）。
   两侧都命中时给 mixed，由调用方按预算取舍（状态优先）。 */

const STATE_WORDS = [
  '当前', '现在', '目前', '此刻', '眼下',
  '进度', '做到哪', '到哪一步', '还剩', '剩下',
  '待办', '下一步', '接下来', '还要做什么', '该做什么', '该干什么',
  '状态', '现状', '收尾', '完成情况',
  '接着', '继续', '接手', '上次', '上一轮', '前一轮',
  '交接', '总账', '卡在哪', '阻塞',
];

const HISTORY_WORDS = [
  '经验', '教训', '踩过', '坑', '教训是',
  '以前', '之前', '当时', '当初', '早先',
  '为什么', '怎么决定', '决策', '依据', '理由',
  '记忆', 'memory', '知识库', '记录过', '存过',
  '结论是什么', '类似', '相似', '参考',
];

/* 项目名词：出现一个就有理由认为这句在问这个项目的事 */
const PROJECT_HINTS = [
  '唯一解', '推理', '税则通', 'hs', '关盾', '风险小帮手', 'mcqa',
  '舰队', '红楼', '典藏司', '软著', '简历', '作品集', '海关', '案件',
];

function hits(text, words) {
  const found = [];
  for (const w of words) if (text.includes(w)) found.push(w);
  return found;
}

export function classify(rawText) {
  const text = String(rawText || '').toLowerCase();
  if (!text.trim()) return { intent: 'none', stateScore: 0, historyScore: 0, stateHits: [], historyHits: [], projectHits: [] };

  const stateHits = hits(text, STATE_WORDS);
  const historyHits = hits(text, HISTORY_WORDS);
  const projectHits = hits(text, PROJECT_HINTS);

  const stateScore = stateHits.length * 2 + (projectHits.length ? 1 : 0);
  const historyScore = historyHits.length * 2;

  let intent = 'none';
  if (stateScore > 0 && historyScore > 0) intent = 'mixed';
  else if (stateScore > 0) intent = 'state';
  else if (historyScore > 0) intent = 'history';

  return { intent, stateScore, historyScore, stateHits, historyHits, projectHits };
}

/* 给检索结果打分用的词：英文按词、中文按二元组。
   不是精确分词，只用于「哪条更相关」的相对排序，够用。 */
export function queryTerms(rawText) {
  const text = String(rawText || '');
  const out = new Set();
  for (const m of text.matchAll(/[a-zA-Z][a-zA-Z0-9_-]{1,}/g)) out.add(m[0].toLowerCase());
  const cjk = text.replace(/[^\u4e00-\u9fff]/g, '');
  for (let i = 0; i + 1 < cjk.length; i++) out.add(cjk.slice(i, i + 2));
  return [...out];
}
