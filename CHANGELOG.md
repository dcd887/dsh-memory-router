# CHANGELOG

## 0.1.0 — 2026-11-05

首个可运行版本。对标 HarnessMM（arXiv 2610.32813）的 EDG / GDR / CCS 三机制，在 DSH 上做等价实现。

### 新增

| 模块 | 说明 |
|---|---|
| `lib/dedupe.js` | 工具调用去重：同工具同参数，TTL 内复用上次文本，工具不再执行 |
| `lib/edg.js` | 可执行决策图：JSON 声明 match + guard + then，命中后本地执行并替换输出 |
| `lib/live_state.js` | 会话延续：自动落盘「在处理什么、动过哪些文件」，新会话第一轮注入 |
| `lib/metrics.js` | CCS 记账：trim / dedupe / edg / reread / inject 六科目，净收益公式含负收益项 |
| `edg.example.json` | 五个示例节点：税则大表取字段、盲推记录抓结论、判案 JSON 抓错误、大 JSON 抓行、长 md 给骨架 |
| `scripts/ab.mjs` | 十案例 A/B，可复现；输出命中率与「上界」说明 |
| `scripts/stats.mjs` | 账本汇总 |

### 安全边界

- 守卫只允许五个纯本地算子：`exitCode` / `fileExists` / `regex` / `minChars` / `jsonPath`
- 动作只允许四个只读动作：`readJson` / `readFileSlice` / `grep` / `stat`
- 未知动作（如 `exec`）直接抛错；任一节点异常回落原路径，不阻断主循环

### 实测（生产会话）

| 场景 | 原生 | 插件后 | 省 |
|---|---|---|---|
| 读税则大表（8972 条） | 6031 字 | 298 字 | 1433 token |
| 读盲推记录（26 KB） | 8035 字 | 1707 字 | 1582 token |

### 已知局限

- 累计净收益为负（−10517）：注入开销是历史累积，且验证方式放大了它
- 无法跳过模型回合：DSH 的 `PostToolDecision` 只有 `accept` / `block` 两支
- 决策图仅匹配 `read` 类工具，bash/pwsh 输出未做结构化
- 压缩默认 dryRun（只记账不改写）

### 测试

6 套 92 项：offline 18 / hooks 19 / dedupe 13 / edg 15 / live 16 / inject 11
