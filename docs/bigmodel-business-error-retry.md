# BigModel 业务错误重试策略

记录时间：2026-06-08

## 背景

BigModel / Z.AI 兼容接口会把一部分可恢复失败包装成业务错误码返回，甚至可能出现在 HTTP 200 的 SSE error frame 中。ZCode adapter 已经在 provider fetch 边界把这类响应归一为 `ProviderBusinessError`，再由 model runner 分类并进入统一 retry budget。

这次是保守改动：不重构 retry 目录，不新增协议字段，只补充 BigModel 业务码到现有分类表，并复用已有的失败事件、重试事件和日志。若 SSE error chunk 没有结构化 `code` 字段、只在 message 里返回 `[1302][...][request_id]` 这类 BigModel 强格式前缀，adapter 也会先提取四位业务码再进入同一张分类表。

参考文档：[BigModel API 错误码 FAQ](https://docs.bigmodel.cn/cn/faq/api-code)

## 实现位置

- `apps/zcode-cli/packages/adapters/src/model/failure-provider-business-codes.ts`
- `apps/zcode-cli/packages/adapters/src/model/failure-classifier.ts`
- `apps/zcode-cli/packages/adapters/src/model/failure-inspection.ts`
- `apps/zcode-cli/packages/adapters/src/model/provider-finish-business-error.ts`
- `apps/zcode-cli/packages/adapters/src/model/runner-generate.ts`
- `apps/zcode-cli/packages/adapters/src/model/runner-retry.ts`
- `apps/zcode-cli/packages/adapters/src/model/runner-stream.ts`
- `apps/zcode-cli/packages/adapters/src/model/runner-status.ts`

实现继续复用既有 retry loop、stream retry 边界和日志发布路径；业务码分类、错误对象检查、SSE error chunk 重建和 delay 计算分别保持在上述文件中，避免把 provider 特例扩散到 core runtime。

## 会重试的 BigModel 业务码

| 业务码 | 语义 | ZCode 分类 | retry reason |
| --- | --- | --- | --- |
| `1120` | 临时账号访问异常，文档建议稍后重试 | `model_request_failed` | `server_error` |
| `1230` | API 调用流程异常 | `model_request_failed` | `server_error` |
| `1234` | 网络错误 | `model_request_failed` | `network_error` |
| `1302` | 并发过高 | `model_rate_limited` | `rate_limited` |
| `1303` | 调用频率过高 | `model_rate_limited` | `rate_limited` |
| `1305` | 平台流量限制或过载 | `model_rate_limited` | `rate_limited` |
| `1312` | 模型访问负载过高 | `model_request_failed` | `provider_overloaded` |

这些错误只在还没有向上游产出已提交模型事件时自动重试。流式请求如果已经产出 `text_delta`、`tool_call` 或 `finish`，仍然不会自动重放，避免重复文本或重复工具调用。

## Retry-After Header

当 provider 返回 `retry-after-ms` 或 `retry-after` 时，adapter 会优先使用 provider 指定的等待时间；合理上限是 5 分钟。若同一响应带有 `x-should-retry: false` 或 `x-should-retry: 0`，则不使用 `retry-after` 驱动等待，只保留本地 retry 判断。

响应头必须贯穿三条路径：fetch 层直接抛出的 `ProviderBusinessError`、AI SDK error chunk / finish metadata 重建出的 `ProviderBusinessError`、以及被 `APICallError.cause` 包住的业务错误。否则 adapter 会把 `retry-after` 误判为缺失，并退回本地指数退避。

## 流式 attempt 清理边界

所有准备进入下一次物理请求的失败 attempt 都必须先中止本轮请求，并在有界屏障内等待 iterator 与 AI SDK tee 保留分支清理。这一约束同时适用于 `iterator.next()` 直接抛错和 AI SDK 产出 `type: "error"` chunk 后由 adapter 内部调度 retry 的路径。

清理异常或超时不得覆盖原始 provider 错误，也不得无限阻塞 retry；但在清理完成或有界超时之前，下一次 `streamText()` 不得启动。

## 不重试的 BigModel 业务码

| 业务码 | 原因 |
| --- | --- |
| `1113` | provider 明确返回的终止型业务错误，自动 retry 不会改变结果 |
| `1304` | 日调用限制，短时间 retry 不会改变结果 |
| `1308` | 使用量上限，需要等重置时间 |
| `1309` | Coding Plan 到期 |
| `1310` | 周/月额度上限，需要等重置时间 |
| `1311` | 套餐没有模型权限 |
| `1313` | fair usage restriction，继续 retry 容易放大异常流量 |

这类错误即使由 HTTP 429 携带，也保持非重试。原因是它们不是瞬时并发或平台负载问题，自动 retry 会浪费预算，也可能加重 provider 侧的限流。

## 日志

没有新增日志入口，继续复用 model runner 的结构化状态事件：

- `model_request_failed`：单次尝试失败，记录 `requestId`、`traceId`、`attempt`、`maxAttempts`、`reason`、`retryable`、`statusCode`、安全错误消息等。
- `model_retry_scheduled`：准备进入下一次尝试，记录 `nextAttempt`、`delayMs`、`reason`、`statusCode` 等。

这两个事件会在 `runner-status.ts` 里通过 logger 以 `warn` 级别落日志。它们是低频生命周期事件，不是逐 chunk 高频日志。

## 测试覆盖

- `failure-classifier.test.ts` 覆盖 BigModel transient code 会被分类为可重试。
- `failure-classifier.test.ts` 覆盖 quota、套餐、长期限制类 code 保持非重试。
- `failure-classifier.test.ts` 覆盖 error chunk 重建和 `APICallError.cause` 包装后仍保留 `retry-after`。
- `runner-provider-business-network.test.ts` 覆盖 SSE 中的 `1305` 业务错误在可安全重放时会发布失败事件、重试调度事件，并在下一次请求成功。
- `runner-provider-business-network.test.ts` 覆盖 SSE error chunk 中的 `retry-after` 会决定下一次物理请求的等待时间。
- `runner-provider-business-network.test.ts` 覆盖 SSE error chunk 调度 retry 后，下一次物理请求必须等待上一轮 abort、`iterator.return()` 和 tee 保留分支的有界清理。

## 后续方向

如果后续要把 retry 逻辑进一步集中，可以把 provider business code mapping、HTTP status fallback、network inspection 和 retry budget 配置统一收敛到 `apps/zcode-cli/packages/adapters/src/model/retry/`。这次先不做目录级搬迁，避免扩大改动面。
