# 问题反馈新接口迁移 Spec

## 背景

问题反馈服务从旧的独立反馈域名接口迁移到 ZCode Server 新接口：

- 旧接口：`https://feedback.example.invalid/v1/tickets`
- 生产新接口：`https://zcode.z.ai/api/v1/feedback/*`
- 测试新接口：`https://zcode.z.ai/api/v1/feedback/*`

UI 和 RPC 服务接口暂不扩展，`IFeedbackService` 继续向 UI 暴露现有的创建、列表、详情、评论和附件上传能力。迁移只收敛在 services 层的 HTTP 协议、鉴权、字段映射和匿名票据缓存。

默认 feedback API base 必须跟随统一的 ZCode endpoint resolver：

- `ZCODE_ENV=production` 或未显式设置时，默认 `https://zcode.z.ai/api/v1`。
- `ZCODE_ENV=test` 时，默认 `https://zcode.z.ai/api/v1`。
- `ZCODE_BASE_URL`、`ZCODE_TEST_BASE_URL`、`ZCODE_PRODUCTION_BASE_URL` 等统一 endpoint 覆盖继续生效。
- `ZCODE_FEEDBACK_API_BASE` 或显式传入的 `apiBaseUrl` 只作为人工覆盖，优先级高于环境默认值。

反馈 API 的 HTTP 出口必须通过 services 层统一 `ApiClient` 收口，不直接调用全局 `fetch`。统一 `ApiClient` 负责 ZCode Server endpoint 重写、`x-request-id` 以及 `buildZCodeSourceHeaders()` 中的通参注入；反馈模块只在此基础上叠加接口自身关注的 header 和请求体。这样后续新增 ZCode Server 通参时，只需要修改统一 API client/source headers，不需要逐个业务模块补字段。

## 新接口契约

所有反馈 API 响应统一为：

```json
{
  "code": 0,
  "msg": "ok",
  "data": {}
}
```

`code !== 0` 或 HTTP 非 2xx 均视为失败，错误消息优先使用 `msg`，其次使用响应正文。

核心接口：

- `POST /feedback/ticket`：创建反馈工单，JWT 可选。
- `GET /feedback/ticket`：查询当前登录用户工单列表，要求 Bearer JWT。
- `GET /feedback/ticket/{ticket_id}`：查询工单详情。登录用户走 Bearer JWT；匿名用户必须携带 `X-Device-Mid`。
- `POST /feedback/ticket/{ticket_id}/message`：追加消息。登录用户走 Bearer JWT；匿名用户必须携带 `X-Device-Mid`。
- `POST /feedback/attachment/upload-credential`：获取 OSS 表单直传凭证，登录用户走 Bearer JWT；匿名用户必须携带 `X-Device-Mid`。

## 鉴权与匿名身份

服务层复用桌面宿主统一的 telemetry `deviceMid` 作为反馈匿名 `device_mid`：

- `deviceMid` 由 main 进程在窗口创建前通过 `telemetry-state.json` 同步确保，并注入 host process。
- 反馈服务不再维护独立的 `zcodefeedbackclientid`，避免同一台机器在 telemetry、ARMS、远控和 feedback 中被拆成多个设备。
- 旧的 `zcodefeedbackclientid` / `X-Feedback-Client-Id` 只作为废弃数据保留在本地凭据中，不参与新接口请求或匿名列表隔离。

请求头规则：

- 反馈请求通过统一 `ApiClient` 发送，自动携带 ZCode Server 通参，例如 `User-Agent`、`HTTP-Referer`、`X-ZCode-App-Version`、`X-Platform`、`X-Release-Channel`、`X-Client-Language`、`X-Client-Timezone`、`X-Os-Category`、`X-Os-Version` 和 `x-request-id`。
- 如果本地凭据存在 `zcodejwttoken`，请求发送 `Authorization: Bearer <token>`。
- 所有反馈 API 请求发送 `X-Device-Mid: <telemetry deviceMid>`，用于匿名工单归属与详情访问。
- `POST /feedback/ticket` 请求体同时发送 `device_mid`。
- 不再发送旧接口使用的 `X-Feedback-Client-Id` 和 `X-Feedback-Account-Id`。

匿名用户无法调用服务器列表接口。匿名创建成功后，本地在反馈数据目录维护最小票据缓存，用于“我的反馈”列表展示。登录用户列表以服务器 `GET /feedback/ticket` 为准。

## 字段映射

创建工单时，旧 UI 输入映射到新请求：

- `title` -> `title`
- `description` -> `content.description`
- `type` -> `content.function`
- `severity` -> `content.severity`
- `contact` -> `contact`
- `device` -> `environment`

`environment` 至少包含：

- `app_version`
- `platform`
- `release_channel`
- `os_category`
- `os_version`

`platform` 使用和 `GET /client/configs?platform=...` 一致的系统架构键，例如 `darwin-aarch64`、`darwin-x86_64`、`windows-x86_64`。`os_version` 使用短系统 release（`node:os.release()`），避免 macOS 的完整 Darwin kernel 字符串超过后端 `feedback_tickets.os_version` 长度限制。

设备快照中的额外字段以 snake_case 扁平写入 `environment`，不再嵌套在 `device` 字段内。UI 侧详情仍将 `environment` 映射回 `FeedbackDeviceInfo`，保持现有组件可读。

状态映射：

- `submitted` -> `已提交`
- `closed` -> `已归档`
- 未识别状态 -> `已提交`

其中 `已归档` 是服务层为兼容现有 `FeedbackTicketStatus` 保留的内部状态值；“我的反馈”列表和详情对用户展示为中文“已完成”、英文 `Completed`，不把接口兼容命名暴露给用户。

新接口没有旧的 type/module/assignee/event 语义。服务层保留 UI 类型兼容：

- 创建返回使用本次输入的 `type`、`module`、`severity`。
- 服务器列表没有类型时默认映射为 `bug`。
- 详情中的消息映射为 `comments`，并生成展示用系统事件。

## 附件上传

新接口不再支持旧的 `attachments:init`、chunk PUT、`attachments:complete` 协议。服务层统一使用 OSS 表单直传：

1. 调用 `POST /feedback/attachment/upload-credential`，传入 `ticket_id`、可选 `message_id`、`file_name` 和 `size`。
2. 用返回的 OSS `host`、`path`、policy、签名和 callback 信息构造 `multipart/form-data` 表单。
3. 文件字段放在表单最后上传，并向 UI 上报上传进度。
4. OSS 返回 2xx 后，服务层按当前文件信息构造 `FeedbackAttachment` 返回。

取消上传继续通过 `AbortController` 中断当前 OSS 请求，并抛出 `FeedbackUploadCanceledError`。

反馈表单默认上传诊断日志时仍使用完整归档流程，但归档内容只覆盖反馈定位需要的日志与轻量配置。日志附件客户端预检上限为 1GB；为避免上传高频协议流或插件缓存导致归档膨胀，full archive 会排除：

- `dev`
- `sessions`
- `session-bindings`
- `checkpoints`
- `repo-snapshots`
- `repo-wiki`

其中 `repo-snapshots` / `repo-wiki` 是已退役 Repo 快照上传与 Repo Wiki 功能的历史数据目录：升级用户数据根仍可能残留（快照加密包可达 GB 级，Wiki 正文含仓库路径与引用信息），退役功能的归档隐私边界必须继续生效。

## 网络错误与重试边界

反馈 API 通过 Node.js `fetch` / Undici 发出。网络错误必须在 services 的统一 API 网络错误分类器中归一化，反馈、模型连通性等调用方不得各自维护互相分叉的错误码列表。

只有能够确认请求尚未到达后端的建连阶段错误可以自动重试，包括：

- `UND_ERR_CONNECT_TIMEOUT`
- `UND_ERR_CONNECT_ERROR`
- `ENOTFOUND`
- 明确包含 `connection attempts timed out` 或 `connect ETIMEDOUT` 建连证据的 `ETIMEDOUT`
- `ENETUNREACH`
- `EHOSTUNREACH`
- `ECONNREFUSED`
- 明确发生在 TLS 建立前的 `ECONNRESET`

请求体发送后发生的普通 socket 断开、用户取消、业务超时和 HTTP 失败不得按建连错误自动重试。`POST /feedback/ticket` 在后端提供幂等键契约前，只允许重试上述“请求尚未到达后端”的失败，避免响应丢失时重复创建工单。

重试耗尽后，services 日志应保留脱敏后的目标 URL、错误码、尝试次数和耗时。UI 必须按工单是否已经创建分流提示与后续动作：

- 创建工单前失败时，不直接展示 `fetch failed` 等运行时原始消息，而是按当前语言提示用户检查网络、VPN 或代理后重试；提交草稿、截图和联系方式必须继续保留，用户可以在原表单重新提交。
- 工单已经创建、日志等后续材料上传失败并进入错误状态时，不得提示用户重新提交整个表单。后台状态必须明确提示“工单已创建，但后续材料上传失败”，点击后直接打开已有工单，避免重复创建工单。截图仍保持现有的逐附件降级语义：失败后写入系统评论并继续提交，不因本次错误路由修复改成整体失败。

## 多端影响

本次迁移只修改 `packages/services` 的反馈 HTTP 协议和持久化缓存，不改变：

- app 与 agent 的 stdio 协议。
- task stream、snapshot、queue、owner command。
- 桌面端 `desktop-continuous` 与手机远控 `web-remote-replayable` 边界。
- main process、relay 或 remote host attachment 逻辑。

桌面本地与远程窗口都通过 host process 中的同一反馈服务访问新接口；Web/mobile 远控链路不新增独立 Agent runtime 或业务状态。

## 验证

必须覆盖：

- 创建工单走 `/feedback/ticket`，请求体包含 `device_mid`、`content`、`environment`，并发送 Bearer JWT 和 `X-Device-Mid`。
- 反馈 API 请求必须通过注入的统一 `ApiClient` 发出，不能绕过通参收口直接调用全局 `fetch`。
- 无 JWT 时匿名创建使用 host 注入的 telemetry `deviceMid`，不生成或持久化独立反馈客户端 ID。
- 无 JWT 列表不请求服务器，按 telemetry `deviceMid` 返回本地匿名缓存。
- 有 JWT 列表调用服务器接口并映射状态。
- 附件通过 upload credential + OSS 表单直传完成，并支持进度与取消。
- 网络握手阶段的可重试失败仍会重试。
- Undici `UND_ERR_CONNECT_TIMEOUT` 首次失败、后续恢复时能够自动重试成功。
- Undici 建连错误连续三次失败后停止重试，并记录尝试次数和错误码。
- 建连错误耗尽后，反馈表单展示本地化网络提示，不展示原始 `fetch failed`，并保留当前描述、截图和联系方式供用户重试。
- 工单创建后日志等后续材料上传发生网络错误并进入错误状态时，展示本地化的“工单已创建”提示，后台入口打开已有工单而不是重新打开提交表单。
- 全量执行 `pnpm typecheck` 和 `pnpm lint`。
