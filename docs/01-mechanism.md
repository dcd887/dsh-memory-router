机制说明
================================================

## 1 数据流

```
用户消息
   │
   ├─ agent/inbox/claimed ──→ 判意图（要不要注入状态）
   │                          └─→ LiveState.recordUser（记下这句话）
   │
   ├─ agent/pre-step ──→ systemPrompt.context 被请求
   │                     └─→ buildStateText
   │                           ├─ 有新鲜 live_state → 用它
   │                           ├─ 否则用交接文档
   │                           └─ commitInject（哈希闸门 → 决定注不注）
   │
   └─ 模型发起工具调用
         │
         └─ tools/post-execute（工具结果回来，模型还没读）
               │
               ├─ ① 去重：同工具同参数，TTL 内直接给上次的文本
               ├─ ② 决策图：命中节点 → 本地执行 → 用结构化结果替换
               ├─ ③ 压缩：按阈值裁剪（省得太少就跳过）
               ├─ ④ 缓存最终文本（供下次命中）
               └─ ⑤ 记 CCS 行
```

关键点：②与③ 都在模型读之前发生，模型看到的就是替换后的内容。

## 2 三个机制逐条对照

### 2.1 EDG（可执行决策图）

论文定义：存精确动作、字面参数、因果依赖、公开守卫。

这里用 JSON 声明：

```json
{
  "id": "tax-table-pick-fields",
  "match": { "tool": "read", "args": { "file_path": { "$re": "hs_codes" } } },
  "guard": { "minChars": 2000 },
  "then": [
    { "act": "readJson", "path": "${args.file_path}", "limit": 3,
      "pick": ["hs_code", "name", "import_tariff", "category"] }
  ],
  "terminal": false
}
```

| 论文概念 | 对应字段 |
|---|---|
| 精确动作 | then[].act（白名单四个） |
| 字面参数 | then[].path 支持 `${args.x}` 与 `${cwd}` |
| 因果依赖 | 节点按数组顺序试，第一个匹配即生效 |
| 公开守卫 | guard（五个纯本地算子） |

### 2.2 GDR（守卫决策复用）

论文：从观测到的回执激活持久决策，替换后续推理回调。

这里的实现差异要从 DSH 的接口说起：

| DSH 给的能力 | 能否做到「跳过回调」 |
|---|---|
| tools/post-execute 改写结果 | 能 |
| 由插件发起新工具调用 | 不能（PostToolDecision 无此分支） |
| 插件自己读写文件、跑白名单动作 | 能 |

所以本插件做的是：让插件自己执行确定性动作，把结果塞回这次工具调用的返回值。

省下的是：这次工具输出被模型读取的那部分 token（实测 6031→298、8035→1707），以及常常因此少一轮工具往返。

### 2.3 CCS（认证回调替换）

每命中一次写一行：

```json
{"ts":"2026-11-05T09:44:32.015Z","kind":"edg","tool":"read",
 "node":"blind-push-summary","charsIn":8035,"charsOut":1707,
 "savedTokens":1582,"terminal":false,"turnsAvoided":0}
```

`turnsAvoided` 只在 terminal 节点记 1。当前 8 个节点全是 terminal=false，所以这一列一律 0——宁可少报。

## 3 安全边界（三条硬约束）

| 约束 | 实现 | 测试 |
|---|---|---|
| 守卫不调模型 | 只有 exitCode / fileExists / regex / minChars / jsonPath；不认识的算子返回 false | edg.mjs「白名单外动作被拒」 |
| 动作不跑 shell | act 只认 readJson / readFileSlice / grep / stat；`exec` 抛「未知动作」 | 同上（`rm -rf /` 被拒） |
| 出错必回落 | match 或 guard 抛异常 → 该节点作废 → 走原路径 + 记 diag | edg.mjs「动作失败返回 null」「失败时记了 diag」 |

第三条是这套东西能不能长期挂着的关键：决策图写错，最坏结果是退化成没有它。

## 4 记账口径

净收益 = 裁剪省 + 去重省 + EDG 省 − 重读赔 − 注入花 − 摘要花

| 科目 | 记什么 |
|---|---|
| trim | 压缩省下的 token |
| trim-skip | 省得太少没压的次数（不进账） |
| dedupe | 复用缓存省下的 |
| edg | 本地执行替换输出省下的 |
| reread | 负收益：上次压过，同一调用又来 = 压过头了 |
| inject | 注入花的 |

`reread` 是我自己加的。论文没有这一项，但没有它，账本会系统性地虚高——压缩越多，账面越省，实际可能越贵。

## 5 为什么不用 RSI（递归自我改进）

论文标题里有 RSI，做法是从历史反馈迭代改进 harness 配置。

这里没做，理由是样本量：它需要成百上千条同类轨迹，我们现在一天几十次调用，学出来的规则大概率是过拟合。

替代做法：`edg.json` 手写 + 按实测数据增删节点。慢，但每条都能解释。
