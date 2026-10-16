# Debug Execution Gantt

`debug` 的原始 `timeline` 适合保留事实顺序，但不能表达并发执行。tool call、model request、permission 等操作可能重叠发生，因此 debug UI 需要把 trace 还原成持续时间段，并用甘特图展示。

## 目标

- 在 `GET /api/traces/:traceId` 中新增 `spans[]`，专门表达可持续的执行段。
- `timeline[]` 继续保留原始事件、日志、SQLite message/part，按发生时间倒序展示，不做截断。
- `spans[]` 面向并发可视化，按 `startAt`、`endAt`、lane、status 描述 turn、model、tool、permission、subagent、network、storage、log。
- UI 使用成熟开源库 `vis-timeline` 渲染甘特图，支持横向缩放、滚动、按 lane 分组和点击查看 span 详情。
- 网络抓包记录可以转换为 `network` lane span，并和同一个 `traceId` 下的 runtime spans 一起显示。

## 非目标

- 不用甘特图替代原始 timeline；事件原文仍以 timeline 和 payload details 为准。
- 不推断未观测到的真实并发关系。没有 `startAt` 的记录不能生成 span。
- 不长期保存网络 span。网络 span 来自 debug server 的实时内存请求列表。

## Span 契约

```ts
type TraceSpanLane =
  | "turn"
  | "model"
  | "tool"
  | "network"
  | "permission"
  | "storage"
  | "subagent"
  | "event"
  | "log";

type TraceSpanStatus = "running" | "ok" | "error" | "cancelled" | "unknown";

interface TraceSpan {
  id: string;
  traceId?: string;
  sessionId?: string;
  turnId?: string;
  spanId?: string;
  parentSpanId?: string;
  toolCallId?: string;
  lane: TraceSpanLane;
  label: string;
  source: "log" | "eventlog" | "sqlite" | "network";
  startAt: string;
  endAt?: string;
  status: TraceSpanStatus;
  summary?: string;
  payload?: unknown;
}
```

`endAt` 缺失表示还没有观察到结束事件。前端可以把它渲染为 running/unknown 状态，但不能把当前时间写回 API 结果。

## 事件配对规则

- `turn_started` -> `turn_complete` / `turn_error`，按 `sessionId + turnId` 配对。
- `model_request` -> `model_complete` / `model_error`，优先按 `modelRequestId/requestId/id` 配对，缺失时退回 `sessionId + turnId`。
- `tool_call_started` -> `tool_call_result` / `tool_call_error`，优先按 `toolCallId` 配对。
- `permission_requested` -> `permission_resolved` / `permission_denied`，优先按 `permissionId/requestId` 配对，缺失时退回 `toolCallId`。
- `subagent_spawned` -> `subagent_stopped`，优先按 `subagentId/subagentSessionId/childSessionId` 配对。
- 带 `durationMs` 的结构化日志可以生成 `log` 或更具体 lane 的 span，`startAt = timestamp - durationMs`，`endAt = timestamp`。

## UI

- 顶部提供 `Trace`、`甘特图`、`网络请求` 三个视图入口。
- 没有 hash 路由时默认进入 `甘特图`，因为它是调试执行过程的主视图。
- 筛选条只保留项目 select 和 Trace select；Trace select 的每个选项同时显示 `traceId` 和第一条用户消息。
- `甘特图` 页使用当前 `traceId`，将 API `spans[]` 与同 trace 的网络请求 span 合并。
- `网络请求` 页提供独立列表、trace 过滤、代理状态和一键复制环境变量。
- 甘特图 bar 的可见内容保持紧凑，只显示操作名、状态和耗时；`traceId`、`turnId`、`toolCallId`、`spanId` 以及完整 payload 保留在 tooltip 和详情面板，避免 bar 变成大段日志文本。
- 甘特图 range bar 必须有 UI-only 最小可视宽度。毫秒级 tool call 仍保留真实 `startAt`/`endAt`、tooltip 和详情耗时，但画布上的 bar 至少给出可点击面积，避免快速执行段被压成一条竖线。
- 甘特图 toolbar 必须提供窗口内全屏开关。该开关只让甘特图面板覆盖当前浏览器窗口，不调用浏览器 Fullscreen API；Esc 和同一按钮都应能退出，切换后需要重新适配 timeline 宽高。全屏模式下详情面板固定高度，剩余空间给 timeline；timeline item 应贴近顶部布局，避免放大后因 bottom orientation 产生大块上方空白。
- 点击网络请求中的 `traceId` 应切换到对应 trace；点击甘特图 span 应展示 source、status、duration、trace/session/turn/tool 标识和 payload。

## 测试覆盖

- analyzer 能把重叠 tool call 生成两个可重叠的 `tool` span。
- analyzer 能把 model request 和 turn 事件生成不同 lane 的 span。
- 未配对结束事件时仍返回带 `startAt` 的 span，status 为 `unknown`。
- 前端 typecheck 覆盖 `vis-timeline` 数据映射、网络请求 span 合并和新 `TraceDetailResponse.spans` 契约。
- 前端单测覆盖 range item 的最小 bar 宽度样式，确保快速完成的 tool span 不是一条难以点击的线。
