# Conversation Session Requirement Matrix Workflow

本文定义 conversation session 领域的“需求澄清分支”实例。通用入口是 `.agents/skills/feature-boundary-planner` skill：用户先描述要新增或调整的功能，Agent 根据现有文档和代码找关联概念，形式化枚举状态组合，再和用户逐步剪枝，最后产出需要覆盖的 case 文档。

## 目标

- 把“我要改一个功能”转成可 review 的状态空间，而不是直接写 E2E。
- 用现有 protocol、case catalog、coverage matrix 和 formal-proof 口径生成候选组合。
- 把产品已经确认、需要继续确认、明确剪枝和暂不覆盖的组合分别落文档。
- 只把 `accepted` case 交给后续 E2E manual-review / promotion 流水线。

## 输入

用户只需要先给出自然语言变更，例如：

```text
running 时 queue 里某条消息可以点立即发送
```

如果描述不足，Agent 只先问最小必要问题，例如“这是已有行为修正，还是新增入口？”

## 上下文发现

优先从文档找产品语义，再读代码确认当前实现和可观察证据：

1. 协议层：`docs/conversation-protocol-declaration.md`
2. case catalog：`docs/conversation-session-case-catalog.md`
3. 覆盖矩阵：`docs/testing/conversation-session-e2e-coverage-matrix.md`
4. 相关专项矩阵：fork、goal、fault、tool cross-product、network/SSE、recovery/isolation 等
5. 当前实现：UI surface、store/runtime 状态、protocol event、fixture/helper

输出一张 concept map，记录每个概念来自哪里、为什么和本次需求有关。

## 维度提取

维度只收会改变产品结果或断言的因素。常见维度包括：

| 类型 | 示例 |
| --- | --- |
| 产品状态 | `session.phase`、`queue.length`、`queue.autoDrain`、`goal`、`compact.origin` |
| 输入事件 | send text、`/goal`、`/compact`、stop、edit、fork、queue send-now |
| 目标对象 | latest turn、old turn、assistant message、user query、queue item |
| 入口 surface | composer、turn actions、queue actions、toolbar、goal control |
| 运行形态 | text streaming、tool call、compact pending、goal verification |
| 配置/环境 | model/provider/thought、desktop continuous、web remote replayable、Docker replay |
| 证据层 | UI、runtime/store、protocol、network/SSE、files、logs |

如果一个维度被不变量完全吞掉，不做全排列，但必须记录剪枝理由和代表 case。

## 枚举与剪枝

枚举视图沿用 formal-proof 的结构：

```text
state -> candidate -> guard -> effect -> case
```

先做相关维度的笛卡尔积，再按 guard 和不变量剪枝。每个候选组合必须归入一个状态：

| 状态 | 含义 |
| --- | --- |
| `accepted` | 产品语义明确，能写 setup/action/assert |
| `undefined` | 真实可能发生，但产品语义未确认 |
| `pruned` | 被 guard 或不变量明确剪掉 |
| `ignored` | 存在但当前版本不覆盖，需要写清范围原因 |
| `bug-candidate` | 当前实现疑似违反已确认协议 |

Agent 每次只拿小批量问题和用户确认，避免一次丢出巨大矩阵。问题要包含候选答案和影响面，用户回答后再回写文档。

## 文档产出

一次需求澄清至少产出或更新以下内容：

1. `docs/conversation-session-case-catalog.md`：新增/更新自然语言 case。
2. `docs/testing/conversation-session-e2e-coverage-matrix.md`：把 accepted 但未实现的 case 标成 `missing` 或 `planned`。
3. 若有 undefined：新增或更新 decision worksheet/backlog，并写清问题、候选口径、回写目标。
4. 若是专项维度：同步对应专项矩阵，而不是把所有组合塞进主路径矩阵。

文档中的 accepted case 必须包含 setup、action、assertion 和至少一个非 UI 证据层。仅在某条路径中经过某个状态，不算覆盖。

## E2E 交接

只有 `accepted` case 进入 E2E 落地流程：

1. 生成 `manual-review/pending` spec。
2. 运行 manual/capture 并人工 review。
3. 整理 case-local provider/file fixtures。
4. promotion 后进入正式 replay 和 Docker suite。

这个后续流程由 `.agents/skills/e2e-case-lifecycle` skill 负责。需求澄清分支不直接生成正式 E2E，也不把 `undefined` 写成测试断言。
