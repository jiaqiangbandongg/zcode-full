# TUI Network Status Projection

更新日期：2026-07-15

## 当前行为

TUI 把通用 HTTP 边界的 `network_request_status` 和 provider 模型请求的
`model_network_status` 归一成同一组内存 `NetworkRequest`。这些状态显示在右侧 sidebar 的
`APIs` section，不再在输入框下方保留独立 network panel。

```text
session event
  -> app-session-event-handler
  -> app-network-events（归一、按 request id 合并、最多保留 8 条）
  -> app.tsx networkRequests state
  -> app-sidebar-api.tsx（摘要 + 最近 5 条，剩余显示 more）
```

sidebar 摘要同时显示：

- 当前 session usage 中的 model request 次数；
- WebFetch / WebSearch 次数；
- 内存网络请求的 pending、error 和 recent 数量；
- 展开时最多 5 条最近请求，包含状态、method、目标和可用的 duration。

## 事件与身份

- 通用 HTTP 事件必须包含稳定 `requestId`、`method`、`url` 和
  `pending | complete | error` 状态。
- provider 模型事件映射为 `source=model`、`method=POST`，目标从 provider/model/base URL
  元数据解析。
- 当前合并 key 是 `request.id`（由 `requestId` 构造）；同 id 的新状态替换旧行并移到顶部。
- 内存最多保存 8 条，sidebar 最多渲染 5 条；这些数字是 UI 容量，不是持久协议。
- `model_retry_scheduled` 还会更新 footer status；新的 outbound attempt 到达后才形成请求行。
- cache 命中的 WebFetch 不产生网络行，因为没有 outbound request。

## 权威边界

network list 是 live TUI projection，不落盘、不轮询 debug proxy，也不作为 runtime 网络状态的第二权威。
恢复 session 后只展示恢复以来收到的 live 网络事件。usage summary 可以持久化累计计数，但不能反推每条
历史请求。

## 布局

`APIs` 是 sidebar 的可折叠 section，由 sidebar state 保存展开状态。窄终端或 sidebar 关闭时不渲染该
section；这不影响请求执行或事件收集。旧“输入框下方固定三行 network panel、短终端按优先级折叠”的描述
已经失效。

## 当前代码与测试

- `packages/contracts/src/events/session.events.ts`
- `packages/tui/src/app-network-events.ts`
- `packages/tui/src/app-sidebar-api.tsx`
- `packages/tui/src/app-session-event-handler.ts`
- `packages/tui/tests/tui-sidebar.test.ts`
- `packages/tui/tests/tui-sidebar-render.test.ts`
- `packages/core/tests/webfetch-tool.test.ts`
- `packages/core/tests/websearch.test.ts`

## 尚未覆盖

- network request list 的冷恢复（当前产品语义明确为不恢复）；
- 跨 attempt 的显式复合身份。如果未来同一个 requestId 可以并发多个 attempt，必须先修改合并 key 和
  event contract，不能只在 UI 增加一列。
