# Agent 模型请求归因 Header

## 背景

Agent 发起模型请求时，adapter 层已经会把 `TraceContext.traceId` 写入请求头
`x-zcode-trace-id`，用于把 provider 侧网络请求和本地日志、事件、调试网络捕获串联起来。
但同一个 trace 下可能存在主会话、子会话、工具二级模型请求、compact/title 等多类模型请求，
只靠 trace 不足以在服务端和抓包侧快速按 session 聚合；同时每次模型 HTTP 请求也需要稳定的
`x-request-id`，用于把后端入口日志、抓包和本地 `ModelStatusContext.requestId` 对齐。

## 目标

- 所有 agent 模型请求继续发送现有 `x-zcode-trace-id`，不改名为 `x-trace-id`。
- 所有 agent 模型请求都必须发送 `x-request-id`，取值为当前
  `ModelStatusContext.requestId`。
- 所有 agent 模型请求都必须额外发送 `x-session-id`，取值为当前 agent session id 去掉内部
  `sess_` 前缀后的值。
- 所有 agent 模型请求都必须发送 `x-zcode-session-type`，值只能是 `main`、`subagent`、
  `side_chat` 或 `other`，用于服务端统计和诊断请求来源。
- 存在合法 `metadata.querySource` 时发送 `x-zcode-query-source`，让服务端直接按 compact、
  Memory、标题生成等调用用途过滤，不依赖宿主 session 的粗分类。
- `x-request-id` / `x-session-id` / `x-zcode-session-type` 只用于观测、审计和请求归因，
  不作为鉴权、计费、限流或业务路由依据。
- 流式 `streamText`、非流式 `generateText`、adapter 内部重试和主/副模型调用路径共用同一套 header 构造。
- OpenCode Go 请求额外发送 `x-opencode-session`，取当前 conversation/session 的稳定归因 ID；同一
  session 的 generate、stream、retry、title、compact 请求保持不变。

## 非目标

- 不修改 provider 静态配置里的 `headers`，避免把 session 级动态值缓存到 provider registry。
- 不改 app/agent 协议 schema；当前 `TraceContext` 和 model request metadata 已经支持 `sessionId`。
- 不把 `x-zcode-trace-id` 改为 `x-trace-id`。
- 不给普通 OpenCode Zen（`/zen/v1`）或其他路径发送该 header。

## 设计

模型请求 header 继续在 `apps/zcode-cli/packages/adapters/src/model/runner-options.ts`
中合并：

1. provider 静态 header 先进入请求。
2. adapter 根据 `ModelStatusContext` 生成观测归因 header。
3. 归因 header 覆盖同名 provider header，保证请求级 request/trace/session/type 不被静态配置污染。

`x-zcode-session-type` 表示请求所属会话的类型，`x-zcode-query-source` 表示本次请求的用途，
两者独立。不能根据 `sessionId` 前缀、`querySource` 或 telemetry 的 `actorKind` 反推会话类型。
runtime 在 `createRuntimeModel` 创建模型句柄时统一绑定分类，调用层只声明用途；绑定后的
`generateText`、`streamText`、`bind` 均保留分类，标题、Memory、工具内部请求不再覆写为 `other`。

```text
runtime.taskType ──→ session-type ──┐
调用方 querySource ─→ query-source ├─→ adapter → HTTP headers
工作区请求 scope ──→ other ────────┘
```

| 请求所属范围 | `x-zcode-session-type` |
| --- | --- |
| interactive、fork、workflow parent | `main` |
| subagent child | `subagent` |
| selection side chat（含 `/side`、`/btw`） | `side_chat` |
| workflow child、nested workflow child | `other` |
| 会话内 compact、goal verification、session/goal title、Memory、工具内部模型请求 | 继承上述宿主分类，与用途无关 |
| 工作区级 Repo Wiki、Git 文案、连接测试等独立请求 | `other` |

工作区级请求可能借用已有会话的 runtime，但不属于该会话；其模型创建入口显式指定
`scope: "workspace"`，仅影响本模型句柄的归因分类，不修改 runtime 配置或传给 provider factory。
默认 scope 为 session，不增加按用途匹配的白名单。本变更只调整归因，不启用原先未启用的
Memory/标题路径，不改变模型选择、重试、准入、工具执行和 UI/远控投递语义。

`side_chat` 直接映射已有 `taskType: "selection_side_chat"`，不新增持久化类型或 app/agent
协议字段。该会话内的普通请求、compact、标题、Memory 与工具内部请求均继承 `side_chat`；
`querySource` 保持原用途值，普通请求仍为 `main_turn`。工作区独立请求仍为 `other`。
接收此 header 的服务端需接受新增值；本仓库只负责客户端发送，不能据此确认外部服务已兼容。

System prompt 不会单独发起模型请求，它随所属 agent step 分类；普通工具调用结束后的下一次
agent step 也继续使用宿主分类。旧调用若没有显式分类，adapter 只允许根据
`agent_step + main/subagent actor` 做兼容推导，其余一律回退 `other`。新客户端每次物理
模型请求都发送该 header；旧客户端缺失或服务端收到未知值时，服务端应按 `other` 统计且
不得拒绝请求。

`ModelStatusContext.sessionId` 的来源保持现状：优先读取 `request.traceContext.sessionId`，
其次读取 `request.metadata.sessionId`。agent runtime 创建 root trace context 时已经写入当前
`sessionId`，子 trace context 会继承它；因此主 turn、compact、title generation、
prompt enhance、goal verification、工具二级模型调用都会带上同一个 session header。
内部 `SessionId` 类型通常形如 `sess_xxx`；写入 provider header 时只剥掉开头的 `sess_`，
若输入本身没有该前缀则保持原值。

`ModelStatusContext.requestId` 的来源保持现状：优先读取 `request.metadata.requestId`，
没有显式值时由 adapter 生成 UUID。写入 `x-request-id` 时使用同一个值，保证模型 status event、
本地日志和实际 HTTP 请求拥有同一个请求级归因 ID。

adapter retry 会为新的物理请求更新 `x-request-id`，但同一逻辑调用的
`x-zcode-session-type` 必须保持不变。该 header 不含凭据或用户内容，可以进入经过统一
脱敏的 request header 调试记录。

### Query source header

`x-zcode-query-source` 只取自当前请求的 `metadata.querySource`，经
`ModelStatusContext.querySource` 进入统一 header builder；不从 prompt、session type 或
`modelCall.operation` 反推，不增加新的业务状态或 app/agent 协议字段。

```text
调用方 metadata.querySource
  → Adapter ModelStatusContext.querySource
  → 统一 attribution header builder
  → generateText / streamText（每次重试重新装配）
  → Provider HTTP header: x-zcode-query-source
```

- 值去掉首尾空白后原样传递，允许 1–128 个 ASCII 字母、数字、下划线、点、冒号或短横线。
  缺失、空值或非法值时省略该 header，不因观测字段导致模型请求失败。
- 不维护用途枚举白名单；新增合法用途标识可以直接透传。常用值为 `main_turn`、`subagent`、
  `compact`、`session_title`、`goal_summary_title`、`project_memory_extract`、
  `project_memory_dream`、`project_memory_recall`。
- 此 header 为请求级保留字段。Provider 静态 header（包括 SDK factory 默认 header）中的同名项
  按大小写不敏感规则剔除，再按当前请求注入；缺失或非法来源也不能回退到静态值。不修改持久化配置。
- 同名静态值剔除只作用于 `x-zcode-query-source`；其他 header 保持原对象合并顺序和 SDK
  行为，已有归因头的大小写冲突问题不随本功能调整。
- 同一逻辑调用的重试保持相同 query source；并发请求分别使用自己的来源。原有
  `x-zcode-session-type` 仍按宿主分类，compact 可以同时带 `main` 与 `compact`。
- `skipTranscript` 只控制 model-io 记录，不影响此 header；Memory Extraction/Dream 仍可从
  服务端请求头识别。请求 body 不新增 `querySource`。
- 该字段只用于观测、过滤与审计，不参与鉴权、计费、限流或业务路由。旧客户端缺少字段时，
  服务端按来源未知处理，不拒绝请求。
- 桌面本地、远程 workspace、Web/手机调用复用同一 Agent Adapter；本变更不修改
  `desktop-continuous` / `web-remote-replayable` 的投递、队列或恢复语义，也无 UI 交互变化。

### OpenCode Go 会话 header

`x-opencode-session` 只在请求 base URL 的 host 为 `opencode.ai` 或其子域、且规范化 path
为 `/zen/go/v1` 时发送（忽略大小写、允许尾斜杠）。host + path 的组合避免把普通 Zen
`/zen/v1` 或其他 OpenCode API 误判为 Go 入口，也不依赖可能变化的 provider id。值复用
`normalizeModelSessionIdForAttribution()` 的结果：优先使用
`traceContext.sessionId`，其次使用 `metadata.sessionId`，并去掉内部 `sess_`/子 agent 前缀；没有
session id 时省略 header。该逻辑位于统一的 attribution header builder，provider 静态 header
仍由运行时归因值覆盖。

## 验证

- contracts/core 表驱动测试覆盖全部 session task type；runtime 测试覆盖会话内标题、Memory、
  工具请求的宿主继承、generate/stream/bind 与并发隔离，以及工作区请求继续为 `other`。
- `side_chat` 覆盖 task type 映射、runtime 继承、adapter 校验，以及三种 API 格式的
  generate/stream 实际 HTTP header；已有 main/subagent/workflow 分类保持原值。
- adapter 单测覆盖 `generateText` 和 `streamText` 均带 `x-request-id`、`x-zcode-trace-id`、
  `x-session-id` 与 `x-zcode-session-type`。
- options 单测覆盖 `generateText` / `streamText` 两条请求路径都会合入 `x-request-id`
  与 session type，且 provider 静态同名 header 不能覆盖运行时分类。
- retry 单测覆盖 request id 随物理请求更新、session type 保持不变。
- Query source 验证覆盖主会话、compact、标题、Memory、未知合法来源、空值/非法值、静态 header
  大小写冲突与缺失时省略；通过正式 SDK 的 HTTP 请求捕获覆盖三种 API 格式的 generate/stream
  路径，并验证 retry 的来源稳定、并发隔离和 `skipTranscript` 不影响 header。
- 保留其他归因头大小写冲突时的既有 SDK 合并结果，验证新增来源头不会顺带改变旧 header。
- OpenCode Go 单测覆盖根域/子域与 `/zen/go/v1` path 边界、普通 Zen/其他 path 不命中，以及
  generate/stream 和 retry 都携带稳定的 `x-opencode-session`。
- 完成后执行 contracts/core/adapters 相关测试、CLI workspace typecheck/lint，并按仓库要求
  执行根目录 `pnpm typecheck` 和 `pnpm lint`。
