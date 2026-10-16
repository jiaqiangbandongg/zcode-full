# Chat Error Banner ARMS 结构化归因

记录时间：2026-08-06

## 目标

`chat_error_banner` 是 UI 可见错误的 ARMS 上报入口。它只负责记录错误曝光事实，不能改变
模型请求的重试、错误码、错误文案、会话状态或 provider 业务动作。

当前 `failure_reason` 直接取 `ErrorAttribution.reason`。模型 adapter 为兼容旧调用和 provider
业务码保留了 `unknown`，导致以下事实在 ARMS 中无法聚合：

- 上游代理返回的 `ERROR_RATE_LIMITED` 文本；
- BigModel `1309`（Coding Plan 到期）；
- HTTP 402 + `Insufficient Balance`；
- 同一 402 根因被 adapter wrapper 和上游 `invalid_request_error` 分成不同展示原因。

对于没有携带 `ErrorAttribution` 的旧错误包装，埋点边界还必须保留/补齐可证明的低基数事实：

- `model_config_missing` → `error_source=runtime`、`failure_reason=model_config_missing`；
- `StreamRecoveryDiscarded` → `error_source=runtime`、`failure_reason=stream_recovery_discarded`；
- `ERR_SQLITE_ERROR` → `error_source=runtime`、`failure_reason=storage_error`；
- 明确包含 provider/network 语义的 adapter 错误，按稳定错误码或受控文案推导 source/reason。

2026-08-17：补齐旧 provider 错误包装仍可证明的 provider 拒绝事实：`1301`、`1213`、`3012`
以及 provider source 下的 `BAD_REQUEST` 统一归为 `invalid_request`；HTTP `405` 同样归为
provider 的 `invalid_request`。这些规则只在 telemetry 归因边界生效，不改变 adapter retry、错误文案
或业务动作。SSE 已进入 `response_body`、或非流式请求已进入 `response`/`parse` 阶段时，即使没有
HTTP status/provider code，也把 `source` 视为 provider；请求准备阶段仍保留 runtime 归因。

没有 response/stream boundary 或其他上游证据的 `Model request failed.` 继续保留 `unknown`，不通过
兜底规则伪造成 provider/network 根因。

这类推导只发生在 ARMS payload 边界，不改变 UI 错误码、重试或运行时状态；无法证明根因时仍保留空值，继续进入“新 Schema · 待补归因”。

2026-08-19：3.8.1 版本累计暴露出四类剩余缺口，后续实现按错误事实的 owner 分层修复：

- 请求发出前的 model capability / option 校验由 model 边界写入
  `error_source=runtime`、`failure_reason=invalid_request`，不能等到 UI 按文案猜测；
- 旧 transcript 缺失 attribution 时，telemetry 只允许消费 allowlist provider code、稳定错误包装和
  受控文案；裸 `Model request failed.` / `openai_error` 仍不得臆测；
- 已有 `source=provider`、但 reason 为空或 `unknown` 的旧事件，如果同时携带 EPIPE 等强网络证据，
  强证据必须原子地产生 `network/network_error`，不能让较粗粒度 source 覆盖它；
- `ZCode Protocol session stopped` 是 ZCode 自身生成的历史取消信号，cold hydration 必须恢复为
  cancelled，不得重新形成可见错误。`off-peak-ticket-expired` 在 UI 尚不知道 requeue 是否成功，
  本轮只归为 `runtime/offpeak_ticket_expired`，不按文案隐藏 Banner。

Builtin 终态额度码 `1304` / `1308` / `1310` / `1313` 等在 adapter 中仍可沿用
`rate_limited` 作为运行时失败/重试分类；`chat_error_banner` 的 telemetry reason 统一规范为
`quota_exhausted`。该例外只接受 trusted builtin provider identity，或 ZCode 历史记录中严格匹配的
`[code][message][request-id]` envelope，不把自定义 provider 的同名数字 code 当作官方业务码。

2026-08-19 第二轮 `failure_reason=unknown` 累计检查只继续收敛能够由独立低基数证据证明的错误：

- `UPSTREAM_NOT_FOUND`、`quota_limit`、`invalid_input`、`validation_error`、
  `internal_server_error` 等明确 provider code 直接返回对应的原子归因；
- `getaddrinfo` DNS 失败、提前结束/截断的 stream、server disconnected 等明确传输文案归为
  `network/network_error`；
- 明确的 in-flight/并发上限、provider 服务端责任、余额/欠费/预算、无效 tool/input/model 和
  内嵌 HTTP 400/500 错误分别归入已有标准 reason；
- legacy 三段式 envelope 在外层 error code 已等于 envelope code 时仍可消费 allowlist code，
  但不接受 envelope code 与外层非 wrapper code 冲突。

本轮仍不处理裸 `Model request failed.`、`get_channel_failed`、`Provider returned a business error.`、
`gateway_survival_resume_blocked`、裸 `openai_error`、`Request could not be completed`、`terminated`、
`aborted` 等缺少稳定根因证据的输入；这些值保持 `unknown`，等待 adapter/owner 补充结构化字段。

2026-08-19：泛化 `Model request failed.` 不再通过增加 reason 兜底来“消除 unknown”。runner 必须把
已经用于 ModelNetworkStatus / OTel 的低基数失败阶段同步写入终态 error attribution，并把原始异常
规范为受控 `exceptionKind`：

- `errorPhase` 复用 `prepare | configuration | connect | response | stream | parse | validation | unhandled`；
- `exceptionKind` 只允许 `api_call | provider_business | transport | validation | protocol | type_error |
  generic`，禁止透传任意 exception name；
- 普通 stream 在 iterator 创建前失败为 `prepare`，创建后失败为 `stream`；generate 继续区分
  `prepare/response`，retry sleep 为 `connect`；
- `failure_reason=unknown` 可以保留，但新事件必须能按 phase/exceptionKind 分桶，并通过既有
  `trace_id` 下钻 model-attempt OTel，而不是上传原始 message、stack 或 requestId。

## 约束与非目标

- 请求发出前的确定性本地校验可以使用既有 `ErrorAttribution` 字段在 model 边界写入事实；provider
  business code/message 的业务规范化只发生在 `chat_error_banner` telemetry。两者都不修改 adapter 的
  `ModelFailureReason` 词表、retry decision、错误 code/message 或 ChatErrorBanner 主文案。
- 已有非 `unknown` 的结构化 reason 保持原值，避免破坏既有 ARMS 聚合；唯一例外是上文明确列出的
  trusted builtin 终态额度码，它们只在 telemetry 中由 `rate_limited` 规范为 `quota_exhausted`。
- `failure_reason` 与 `error_source` 必须在同一次归因中由同一份证据决定；禁止在丢失
  provider code、HTTP status 或受控文案来源后，再把任意非空 reason 统一反推成 provider。
- `invalid_request` 等可同时表示本地校验和 provider 拒绝的歧义 reason，缺少结构化 source
  或上游证据时只保留 reason，`error_source` 保持空值。
- 只上报低基数标准 reason，不上报完整 provider message、URL、header、凭据或用户输入。
- 旧协议的 error detail、session projection 和 task meta 允许携带可选 `attribution`；旧数据缺失该字段
  时仍按原有兼容路径处理，live 与 cold hydration 不得出现归因漂移。
- `error_message` 继续沿用当前可见 banner 文案；该字段本来就是用户可见错误曝光事实。

## 归因优先级

```text
已有非 unknown 的结构化 reason
        ↓
trusted builtin 终态额度码规范化
        ↓
稳定本地错误码/错误包装推导
        ↓
trusted provider business code / provider source 下的通用语义 code
        ↓
HTTP status + message/code 组合
        ↓
严格 legacy envelope / 可见错误文案的受控模式
        ↓
unknown
```

每一级必须返回同一份证据决定的 `{ errorSource, failureReason }`。只有当原 reason 为空或
`unknown` 时，EPIPE、ECONNABORTED 等强网络证据才可以纠正粗粒度的 provider source。
稳定 transport code 使用受控 allowlist，并覆盖 adapter 已识别的 Node/Undici 网络与超时码；
即使旧事件只保留 `providerErrorCode`、可见文案未重复该 code，也必须按 code 原子恢复
`network/network_error` 或 `network/timeout`。BigModel `1234` 虽然来自 provider business
envelope，但语义是网络失败，因此 legacy `[1234][message][request-id]` 必须恢复为
`network/network_error`，不能产生 `provider/network_error` 的矛盾组合。
HTTP `413` 不单独决定 reason：token/context 证据归 `context_exceeded`，request body/tool/media
结构证据归 `invalid_request`，其余保持 `unknown`。

标准化仅发生在 ARMS payload 内。`unknown` 表示没有可靠证据，不再因为某一个新 provider
错误出现就修改产品错误流程。

## 标准 reason

保留现有值，并为可安全识别的未知错误补充：

`rate_limited`、`quota_exhausted`、`balance_insufficient`、`plan_expired`、
`plan_access_denied`、`model_not_found`、`context_exceeded`、`server_error`、
`network_error`、`timeout`、`stream_idle_timeout`、`tls_error`、`auth_failed`、
`invalid_request`、`provider_not_configured`、`provider_overloaded`、
`offpeak_ticket_expired`。

provider code 只作为本地规则输入；原始 code 继续使用现有 `provider_error_code` 字段上报。

## 不变量

```text
用户请求 → adapter / retry / session state   （保持原路径）
       └→ TurnError → ChatErrorBanner
                       └→ buildChatErrorBannerTelemetryPayload
                          └→ 单次解析 evidence → failure_reason + error_source
```

ARMS 上报失败仍由现有旁路处理，不能阻断 UI 或模型请求。

## 验证

- 覆盖代理 rate-limit 文案、1309、402 Insufficient Balance、429、5xx、未知错误。
- 覆盖 model capability/option 本地预检、严格 legacy 1210/1211/1214/1301/1305/1308/1310 envelope、
  legacy 1234 network envelope、EPIPE/ECONNABORTED/ECONNRESET/ECONNREFUSED/ENOTFOUND、
  ETIMEDOUT/UND*ERR*\* timeout、413 context/request-body 分流和 off-peak marker。
- 覆盖 unknown 第二轮的 DNS、stream termination、in-flight/concurrency、provider server、
  balance/budget/arrears、invalid tool/input、UPSTREAM_NOT_FOUND 和内嵌 400/500 证据，并为上述明确
  非目标保留负例。
- 覆盖普通 stream prepare/stream、generate prepare/response、retry connect 的 phase，受控
  exceptionKind、live/cold hydration 等价和 `failure_phase` / `failure_exception_kind` ARMS 展开。
- 断言非 `unknown` 的既有 reason 不变。
- 断言 trusted builtin 终态额度码只改变 telemetry reason，不改变 adapter retry / UI action。
- 断言 source 缺失时，明确的 network/runtime reason 仍进入正确 source，歧义 reason 保持空值。
- 断言历史 `ZCode Protocol session stopped` 恢复为 cancelled，相似 provider 文案仍是错误。
- 断言 `error_message`、`error_code`、provider/model 脱敏字段不变。
- 运行 UI 聚焦测试、`pnpm typecheck`、`pnpm lint`。
