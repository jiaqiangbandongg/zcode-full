# Conversation Session Network And SSE Decision Worksheet

目标：把 `N01-N09` 模型/API 请求故障和 `S01-S07` SSE 流式故障拆成可确认、可回写、可自动化的产品合同。本文只定义问题和验证面，不替产品决定最终行为。

关联文档：

- 环境故障 catalog：[conversation-session-environment-fault-catalog.md](./conversation-session-environment-fault-catalog.md)
- 决策 backlog：[conversation-session-decision-backlog.md](./conversation-session-decision-backlog.md)
- SSE 录制回放协议：[e2e-sse-capture-replay.md](./e2e-sse-capture-replay.md)
- replay server：`packages/desktop/test/e2e/helpers/upstream-replay-server.ts`
- 网络断言 helper：`packages/desktop/test/e2e/helpers/conversation-session-network.ts`

## 当前基础设施边界

现有 DeepSeek replay server 已经能表达大多数网络和 SSE fault：

| 能力 | 可覆盖的 case |
| --- | --- |
| `statusCode` + JSON body | `401/403`、`429`、`500`、`502/503`、provider JSON error |
| `delayMs` | 请求慢、非流式 timeout 前的等待窗口、用户 stop 窗口 |
| `events` + `offsetMs` | SSE 正常流、慢流、stream stall 前后事件顺序 |
| `closeMode=destroy` | SSE 已有响应头/部分 event 后异常断流 |
| `maxMatches` | retry 序列，例如前 N 次失败、后一次成功 |
| capture artifact `replay.fixtureId` | 证明测试命中了哪条 fixture，避免误判 |

还没定义的是产品口径：UI 最终状态、queue 保留、按钮恢复、错误文案、是否自动 retry、是否允许用户继续输入。

## 当前统计

| 指标 | 数量 |
| --- | ---: |
| Network/SSE case | 15 |
| Network/SSE 协议题 | 15 |
| answered | 0 |
| unanswered | 15 |

## 通用决策维度

每个 N/S case 至少要确认以下维度。确认后才能把 `decision-needed` 改成 `accepted`。

| 维度 | 必须确认 |
| --- | --- |
| 最终 task/session 状态 | `failed/error`、`completed(interrupted)`、继续 `running/retrying`，还是只显示提示 |
| user message | 保留为历史中的 user turn、回退到 draft，还是保留但标 interrupted |
| assistant 占位 | 是否生成 error assistant、partial assistant、interrupted assistant，还是不生成 assistant |
| queue | 当前 queue 是否保留；retry 期间是否允许继续入队；失败后是否自动消费 |
| 操作按钮 | retry、edit、fork、compact、stop、继续发送分别是否可用 |
| 错误展示 | toast、inline banner、message block、toolbar retry 状态、设置页引导分别怎么用 |
| 网络行为 | 是否自动 retry；retry 次数；是否按状态码/错误类型区分 |
| 持久化/恢复 | reload/relaunch 后错误、partial 文本、queue、retry 状态如何恢复 |

## P0 协议题索引

这张表是给审计脚本读的 case-level 协议面。`Status=unanswered` 表示该 fault case 仍不能回写为 `accepted`，也不能写稳定 E2E 断言；此时 `产品结论` 必须保持 `待确认`。产品确认后，先写下明确产品结论，再把对应行改成 `answered`，最后回写 fault catalog / coverage matrix。

| Question | Case | Status | 产品结论 | 需要确认 | 验证关键词 | 回写目标 |
| --- | --- | --- | --- | --- | --- | --- |
| N01.1 | N01 | unanswered | 待确认 | `401/403` 后最终状态、设置引导、user message 与 queue 是否保留 | auth error、settings entry、queue snapshot | fault N01、fault coverage N01 |
| N02.1 | N02 | unanswered | 待确认 | provider/API Key 缺失是发送前阻止还是发送后失败，draft 是否保留 | no network request、composer draft、settings entry | fault N02、fault coverage N02 |
| N03.1 | N03 | unanswered | 待确认 | `429` retry 策略、retry 期间入队、最终失败后的状态与 queue | retry count、toolbar retry、queue | fault N03、fault coverage N03 |
| N04.1 | N04 | unanswered | 待确认 | `502/503` 是否区分、retry 策略、失败后 retry/edit/fork/compact 是否可用 | status code、retry、action buttons | fault N04、fault coverage N04 |
| N06.1 | N06 | unanswered | 待确认 | DNS/connection/proxy/TLS 失败后的 user message、断网状态、queue 规则 | network error、message retention、queue | fault N06、fault coverage N06 |
| N07.1 | N07 | unanswered | 待确认 | 请求 timeout 阈值、stop 语义、超时后自动失败还是 retry | delay fixture、stop、timeout | fault N07、fault coverage N07 |
| N08.1 | N08 | unanswered | 待确认 | 200 malformed response 属于 protocol/provider/可忽略错误，以及是否 retry | malformed body、normalized error、log | fault N08、fault coverage N08 |
| N09.1 | N09 | unanswered | 待确认 | title/sidecar 失败的 fallback 文案、用户是否可见、是否影响主 turn | title fallback、warn、main turn completed | fault N09、fault coverage N09 |
| S01.1 | S01 | unanswered | 待确认 | 空 SSE 断开是否 retry/error，assistant 占位、user message、queue 如何处理 | empty SSE、retry boundary、queue | fault S01、fault coverage S01 |
| S02.1 | S02 | unanswered | 待确认 | `message_start` 后断开是否生成 interrupted/error/no assistant，queue 是否自动 drain | prelude close、assistant placeholder、queue | fault S02、fault coverage S02 |
| S03.1 | S03 | unanswered | 待确认 | text delta 后断流的 partial 保留、final state、fork/edit/compact 是否可用 | partial text、failed/interrupted、buttons | fault S03、fault coverage S03 |
| S04.1 | S04 | unanswered | 待确认 | malformed SSE event 是终止、忽略还是恢复，以及日志分类 | bad event、protocol log、event ordering | fault S04、fault coverage S04 |
| S05.1 | S05 | unanswered | 待确认 | SSE provider error event 是否展示原文、是否 retry、是否生成 error assistant | provider error frame、retry、assistant error | fault S05、fault coverage S05 |
| S06.1 | S06 | unanswered | 待确认 | stream stall UI、超时阈值、用户 stop 和自动 retry/失败策略 | stalled event、toolbar state、timeout | fault S06、fault coverage S06 |
| S07.1 | S07 | unanswered | 待确认 | stop 后 late SSE event 是否忽略、是否 warn、如何证明 inputId 隔离 | late event、activeInputId、new turn isolation | fault S07、fault coverage S07 |

### 已确认但不关闭顶层问题的子决策

| Decision | Parent cases | 产品结论 | 验证关键词 | 回写目标 |
| --- | --- | --- | --- | --- |
| S02-R1 | S02 / S06 | reasoning-only 可重试断流或 idle timeout 由 core 丢弃未完成 reasoning tail，并从前一个安全锚点以新 assistant message id 自动恢复；不改变 queue、Stop 或交付边界 | reasoning-only recovery、safe anchor、new request id、no tool side effect | fault catalog / focused runtime and projection tests |

该子决策只固定“预算内且恢复成功”的安全重试，不回答 S02/S06 的最终失败状态、queue、按钮和 exhaustion 语义，因此上方 15 个顶层问题仍保持 unanswered。

### Pending diagnostic

[conversation-session-sse-stall-e2e-diagnostic.md](./conversation-session-sse-stall-e2e-diagnostic.md) 用真实 Desktop E2E 分别在 prelude、thinking、text、未闭合 tool input、完整 tool block 但消息未 terminal，以及工具已成功执行后的 continuation 制造无 event stall。该 probe 只硬断言恢复安全、不污染新请求和工具不重复执行；partial/终态 UI 作为决策证据采集，不改变 `S02/S03/S06` 的 unanswered 状态。

2026-08-27 实测补充：当前实现会丢弃 reasoning/text partial 并从安全锚点恢复；未闭合 tool input 不执行；而 `content_block_stop` 已是工具提交边界，即使后续没有 assistant `message_delta/message_stop`，只读工具仍会执行一次并以成功 `tool_result` 作为恢复锚点。这些是现状证据，不替代顶层 UI、耗尽和 partial 保留策略的产品裁决。

## N. 模型/API 请求故障

| ID | 故障 | 当前代码观察 | 必须确认的产品结论 | 建议 E2E fixture / 断言 |
| --- | --- | --- | --- | --- |
| N01 | 主模型请求 `401/403` | 归一为 `ProviderNotConfigured/auth_failed`，不可重试；runtime `turn.failed`，UI task runtime `failed` | 是否强制引导设置；user message 是否保留；queue 是否保留；修好 key 后 retry 从哪里开始 | JSON `401/403` fixture；断言无自动 retry、UI 错误、设置入口、queue snapshot |
| N02 | provider 未配置 / API Key 缺失 | registry resolve 阶段失败，通常没有真实模型请求 | send 前禁用、点击后弹设置，还是生成错误轮；输入草稿是否保留 | 无 key setup；断言没有 DeepSeek 请求；composer、设置入口、draft |
| N03 | 主模型请求 `429` | `ModelRateLimited/rate_limited`，默认可重试；会有 retry scheduled；默认最多 10 次 retry | 是否接受默认 retry；retry 期间能否入队；最终失败后状态/queue | `429` + `maxMatches` retry fixture；断言 retry 次数、toolbar retry、queue 行为 |
| N04 | 主模型请求 `502/503` | `5xx` 归一为 `server_error`，默认可重试；`503` 没有独立语义 | 是否区分 502/503；最终失败后是否允许 retry/edit/fork/compact | `503` fixture；断言 retry、最终 error、action buttons |
| N05-code | `500` JSON error | provider parser 可保留 provider message/code，否则按 `server_error` | 展示 provider 原文还是统一文案；哪些 provider code 要特殊处理 | JSON error body fixture；断言错误文案、traceId、日志、queue |
| N06 | DNS/connection refused/代理/TLS | network/proxy 默认可重试，TLS 不可重试 | user message 是否保留；是否显示断网状态；失败后能否继续发送 | replay server unavailable 或代理失败 fixture；断言 network error、消息/queue/snapshot |
| N07 | 请求超时 | 非流式 timeout 归一为 `ModelRequestTimeout`；SSE stall 另算 `model_stream_stalled` | timeout 阈值；期间 stop 是否变成 interrupted；超时后是否自动 retry | `delayMs` 超过阈值或可控 timer；断言 stop、timeout、retry |
| N08 | 200 但响应非法 | 通常由 adapter/AI SDK 抛为模型失败或 provider business failure | malformed 是协议错误、provider 错误，还是忽略坏片段；是否可 retry | `statusCode=200` malformed body/SSE；断言 normalized error 和日志 |
| N09 | title/sidecar 失败 | fire-and-forget，失败 warn，不影响主 turn；goal summary title 有 fallback | 列表标题 fallback 文案；是否需要用户可见提示；是否完全不影响主 turn | 主请求成功 + title fixture 失败；断言主消息 completed、title fallback、warn |

### N 组回答模板

```text
N01 = 状态 / user message / queue / UI 引导 / retry：
N02 = 发送前还是发送后失败 / draft / 设置入口：
N03 = retry 策略 / retry 期间入队 / 最终失败：
N04 = 是否区分 502/503 / retry / 失败后按钮：
N05 = provider 原文还是统一文案 / 特殊 code：
N06 = user message / 断网状态 / queue：
N07 = timeout 阈值 / stop / 自动失败或 retry：
N08 = protocol/provider/ignore / retry：
N09 = 标题 fallback / 用户是否可见：
```

## S. SSE 流式故障

SSE 组的核心分界是 retry boundary：还没出现用户可见 delta 时，理论上可以 retry；一旦出现 `text_delta`、`reasoning_delta` 或 tool call，retry 可能导致重复输出或工具错序。

| ID | 故障 | 当前代码观察 | 必须确认的产品结论 | 建议 E2E fixture / 断言 |
| --- | --- | --- | --- | --- |
| S01 | 响应头已返回，但无 SSE event 后断开 | 仍在 retry-safe 区域；retryable 则 retry，否则 `task_error` | 是否等价模型错误；是否生成 assistant 占位；user message/queue 是否保留 | `events=[]` + `closeMode=destroy`；断言 retry/错误、user message、queue |
| S02 | `message_start` 后断开 | `message_start/start` 是 retry-safe prelude，不算可见正文 | 最终失败时是否有 interrupted/error assistant；queue 是否自动 drain | 只发 `message_start` 后 destroy；断言 assistant 占位和 queue |
| S03 | 若干 text delta 后断开 | 已越过可见 boundary，不再 retry；已收到文本会留在消息流 | partial 文本是否保留；最终状态是 failed 还是 interrupted；是否允许 fork/edit | text delta 后 destroy；断言 partial 文本、状态、action buttons |
| S04 | SSE event JSON malformed | 没有专门 malformed-event 产品分类，通常抛模型失败 | 坏 event 是终止、忽略、还是尝试恢复；是否记录协议错误 | malformed event fixture；断言错误类型、日志、后续 event 是否忽略 |
| S05 | SSE 中 provider error event | registry transform 成 `ProviderBusinessError` 再进入失败分类 | 是否展示 provider 原文；是否 retry；是否生成 error assistant | `event:error` 或 business error frame；断言 normalized UI error |
| S06 | stream stall | 先发布 `model_stream_stalled`；未越过 visible boundary 且可重试时会增加 idle timeout 后重试 | UI 显示“慢/重连/停止”哪种；多久失败；是否允许用户 stop | 大 offsetMs 慢流；断言 toolbar 状态、stop、retry |
| S07 | stop 后 late SSE event | UI terminal handler 按 `activeInputId` 忽略旧 terminal；late event 应不污染新一轮 | 是否需要 warn；新一轮是否必须证明 inputId 隔离；partial 是否冻结 | stop 后 destroy/late fixture；断言旧 input 不追加到新消息 |

### S 组回答模板

```text
S01 = retry or error / assistant 占位 / user message / queue：
S02 = interrupted/error/no assistant / queue：
S03 = partial 保留策略 / final state / fork-edit-compact：
S04 = terminate/ignore/recover / 日志：
S05 = provider 原文 / retry / error assistant：
S06 = stall UI / timeout / stop：
S07 = late event 处理 / warn / inputId 断言：
```

## 验证分层

确认产品口径后，每条 case 的 E2E 都要至少覆盖这些信号中的关键项：

| 层 | 断言 |
| --- | --- |
| UI | `TID_CHAT_VIEW` runtime 状态、错误条/toast、toolbar retry/stop、按钮 disabled、partial/error assistant |
| Network | statusCode、fixtureId、retry 次数、SSE events 顺序、`closeMode`、是否重复主请求 |
| Runtime/Store | `activeInputId` 清理、`apiRetry`、queue count、stopRequested、task error |
| Log | UI/service/agent 是否有同一 traceId/inputId 的 failure/retry/stall 记录 |
| Files | session snapshot 中 user/assistant/error/partial/timeline 是否按产品口径持久化 |

## 建议落地顺序

1. `N02`：无 key / 未配置 provider，最少依赖 replay。
2. `N01`：401/403 鉴权失败，决定设置引导和错误态。
3. `N03/N04/N05`：状态码 retry 和错误文案。
4. `S01/S02/S03`：SSE retry boundary 三件套。
5. `S06/S07`：stall 和 stop 后 late event，最容易暴露 inputId 污染。
6. `N06/N07/N08/S04/S05/N09`：补齐网络不可达、timeout、malformed、provider error、sidecar。

确认后回写规则：

1. 更新 `docs/testing/conversation-session-environment-fault-catalog.md` 对应 case 的产品预期和 Review。
2. 更新 `docs/testing/conversation-session-decision-backlog.md`，移除已经确认的行或标注已转 accepted。
3. 在 `docs/testing/conversation-session-e2e-coverage-matrix.md` 增加 fault spec 缩写，并把对应 fault case 从 decision-needed 进入 `missing/covered` 跟踪。
4. 写 replay fixture 和 WDIO spec。
5. 跑 `pnpm audit:conversation-session-coverage`、目标 spec、`pnpm typecheck`、`pnpm lint`。
