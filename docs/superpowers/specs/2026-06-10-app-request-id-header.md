# App 网络请求 Request ID Header

## 背景

App 侧外部业务 API 已经收敛到 `ApiClient`，错误诊断也会读取后端响应里的
`x-request-id` / `x-trace-id` / `x-span-id`。但出站请求没有稳定携带请求级 ID，
线上排查时只能依赖后端生成的 ID，无法把本地日志、抓包和服务端入口日志提前串起来。

## 目标

- App 发起的外部业务 HTTP 请求默认携带 `x-request-id`。
- `x-request-id` 的值是 UUID 字符串，每个 HTTP 请求生成一次。
- 调用方已经显式传入 `x-request-id` / `X-Request-Id` 时必须保留，避免覆盖业务侧已有链路 ID。
- `NodeApiClient` 统一覆盖 OAuth、model provider、usage、repo snapshot/wiki 等走 `ApiClient` 的链路。
- 反馈 API 由于仍有自定义上传实现，也要覆盖普通 API 请求、附件初始化/完成、单次上传和日志分片上传请求。

## 非目标

- 不新增协议字段，不修改 `@zcode/protocol`。
- 不给 WebSocket、RPC、IPC、SSH、浏览器本地资源读取添加该 header。
- 不强制给任意第三方 bot provider、MCP URL 探测、用户配置的 webhook URL 注入该 header，避免破坏第三方兼容或 CORS。
- 不把 `x-request-id` 写入生产 info 日志；只允许记录 header key，避免高频请求把日志刷爆。

## 设计

服务层新增统一 helper：

1. 使用 `Headers` 规范化调用方传入的 header，兼容普通对象、数组和 `Headers` 实例。
2. 若没有现有 `x-request-id`，调用 `createUuid()` 生成 UUID 并写入小写 `x-request-id`。
3. 若调用方已传入同名 header，保持原值。

`NodeApiClient.request()` 在 endpoint rewrite 和 ZCode source header 合并后，再统一调用 helper。
这样无论目标是默认 endpoint、测试 endpoint 还是普通外部 API，都能拿到请求级 ID，
同时 source header 的覆盖规则保持不变。

`FeedbackHttpClient` 的普通 `fetch` 请求、`http/https.request` 单次上传和日志 chunk PUT
也共用同一个 helper。日志分片上传的每个 chunk/attempt 都是独立 HTTP 请求，因此各自生成
独立 `x-request-id`，便于后端按单次失败请求定位。

## 验证

- `NodeApiClient` 单测覆盖默认生成 `x-request-id`、保留显式传入的 request id、外部主动 abort 不影响 header 生成。
- endpoint rewrite 单测覆盖 ZCode endpoint source headers 与 `x-request-id` 共存，普通外部请求也会带 header。
- `FeedbackHttpClient` 单测覆盖普通反馈 API、日志 chunk PUT、单次附件 PUT 都带 `x-request-id`。
- 完成后执行定向 vitest，并按仓库要求执行 `pnpm typecheck` 和 `pnpm lint`。
