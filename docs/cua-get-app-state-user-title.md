# CUA `get_app_state` 用户标题

## Feature Summary

| Field            | Value                                                                                               |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| Developer intent | 让模型为「读取应用界面」提供具体、用户可读的操作标题，避免所有观察动作都显示同一条泛化文案          |
| Capability       | Computer Use observation tool projection                                                            |
| Change layer     | validation + presentation                                                                           |
| Operating mode   | planning                                                                                            |
| Primary seeds    | `apps/zcode-cli/packages/core/src/mcp/index.ts`、`packages/ui/src/ToolCallBlocks/renderers/cua.tsx` |
| Out of scope     | 修改 Computer Use Helper 权限边界、改变 `get_app_state` 的观察结果、要求其他 CUA 工具提供标题                |

## Product Contract

- 官方 CUA `get_app_state` 的模型可见 input schema 必须包含必填 `title`：长度为
  1–120 个字符，使用用户当前语言，描述本次读取的目的，而不是复述
  `get_app_state`、CUA 或 MCP 等实现名。
- `title` 是 ZCode 的展示元数据，不属于上游 `zcode-cua` runtime 参数。Core MCP bridge
  在调用 `McpPort.callTool` 前必须移除它，避免破坏上游严格 schema。
- Conversation 工具卡优先展示 `input.title`。旧会话或历史 provider 调用没有 title 时，继续
  回退到「读取 {app} 应用界面」或「读取应用界面」。
- 该约定只作用于 CUA `get_app_state`。普通 MCP 的同名工具、其他 CUA 工具和
  `node_repl` 的既有 title contract 均保持不变。

## UI Surface Matrix

| User scenario    | UI entry                  | Shared implementation                          | Display/draft owner                        | Validation/gating                                                        | Commit action                        | Authority/persistence                                           | Mode boundary                                                                | Must remain isolated from                     |
| ---------------- | ------------------------- | ---------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------ | ------------------------------------ | --------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------- |
| 模型读取应用界面 | Conversation CUA tool row | MCP descriptor projection + `CuaToolCallBlock` | Agent tool input / Conversation projection | Core 注入 required title；CUA server identity + `get_app_state` 双重门控 | `McpPort.callTool`，调用前剥离 title | CUA runtime 只拥有真实观察参数；title 随 tool call history 投影 | Desktop continuous 与 mobile replayable 展示同一已持久化输入，不改变交付语义 | 上游 CUA 参数 schema、其他 MCP、其他 CUA 动作 |

## State And Call Boundary

```text
CUA tools/list descriptor
        |
        | Core 只为官方 get_app_state 叠加 required title
        v
Model tool contract -----> model emits { title, app_ref, ... }
                                  |
                    +-------------+-------------+
                    |                           |
                    v                           v
          Conversation projection      MCP bridge runtime call
                    |                           |
                    | 展示 input.title          | 移除 title
                    v                           v
             CUA tool summary          zcode-cua get_app_state
                                                |
                                                v
                                      Helper observation result
```

## Shared And Divergent Behavior

| Concern      | Shared                                  | Deliberately different                                                          | Why it matters                               |
| ------------ | --------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------- |
| 模型标题     | 与 `node_repl` 一样由模型给出短标题     | CUA title 由 Core 叠加到外部 MCP descriptor；`node_repl` 在自身 contract 中定义 | 外部 CUA server 不应被迫识别 ZCode UI 元数据 |
| UI fallback  | 新旧会话都走同一个 CUA renderer         | 新调用优先模型标题；旧调用保留本地化固定文案                                    | 历史任务必须继续可渲染                       |
| runtime 参数 | 原有 `app_ref`、`detail` 等参数原样传递 | 仅 `title` 在 dispatch 前移除                                                   | 不能改变观察语义或上游兼容性                 |

## Feature Relationships

| Rank           | From                    | Semantic edge                   | To                             | Why inspect it                       | Evidence                |
| -------------- | ----------------------- | ------------------------------- | ------------------------------ | ------------------------------------ | ----------------------- |
| must-inspect   | CUA tools/list          | projects model contract through | Core MCP bridge                | 必填字段必须真实进入 provider schema | `registerMcpTools`      |
| must-inspect   | Core MCP bridge         | strips display metadata before  | CUA runtime                    | 上游 contract 不包含 title           | `McpPort.callTool`      |
| must-inspect   | Conversation projection | renders title in                | CUA tool card                  | 用户需要看到模型描述的具体目的       | `CuaToolCallBlock`      |
| invariant-only | CUA title projection    | must not change                 | Helper/broker authorization    | title 与权限、token、TCC owner 无关  | CUA broker spec         |
| invariant-only | CUA title projection    | must not change                 | continuous/replayable delivery | title 只是既有 tool input 的一部分   | conversation projection |

## Must-Preserve Invariants

| Invariant                                    | Surfaces/modes                           | Proof needed                           |
| -------------------------------------------- | ---------------------------------------- | -------------------------------------- |
| 只有官方 CUA `get_app_state` 被要求 title    | local/current/legacy server names        | bridge 单测覆盖 CUA 与普通 MCP 边界    |
| `title` 不发送给上游 CUA                     | Agent runtime                            | `McpPort.callTool` 参数断言            |
| 旧会话没有 title 仍可读                      | Desktop/Web/Mobile history               | renderer fallback 单测                 |
| 模型 title 在工具卡优先于固定 app 文案       | Desktop/Web/Mobile conversation          | renderer summary 单测                  |
| Computer Use Helper 权限和 remote attachment 语义不变 | macOS desktop-local / mobile shared host | 无 broker、protocol、delivery 文件改动 |

## Codegraph Evidence

当前 worktree 没有可调用的 codegraph 命令或索引，因此使用功能图 code seed 与精确符号搜索核对
深度 2 的路径，不声称完整静态调用图。

| Seed                        | Query            | Direct callers / key path                                                          | Depth | Interpretation                                                |
| --------------------------- | ---------------- | ---------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------- |
| `registerMcpTools`          | symbol/file scan | MCP tools/list → `createMcpToolEntry` → ToolRegistry contract / `McpPort.callTool` | 2     | 同一 bridge 同时拥有 provider schema 与 runtime dispatch 边界 |
| `CuaToolCallBlock`          | symbol/file scan | `ToolCallBlock` CUA route → summary projection                                     | 2     | summary 当前使用固定 i18n 文案，可安全增加 title 优先级       |
| `buildNodeReplDisplayModel` | symbol/file scan | node_repl input title → renderer summary                                           | 2     | 既有产品先例是模型 title 优先、实现名 fallback                |

## Graph Delta

| Status    | Node/edge                                        | Semantic reason                                     | Action         |
| --------- | ------------------------------------------------ | --------------------------------------------------- | -------------- |
| confirmed | `capability.computer-use` aliases/docs           | `get_app_state` 用户标题成为可检索产品语义          | 更新功能图     |
| confirmed | `service.cua-tool-contract-projection`           | Core bridge 拥有模型 schema 叠加与 runtime 剥离边界 | 新增节点与边   |
| confirmed | `surface.computer-use-task-experience` code seed | 专用 CUA renderer 是当前用户可见落点                | 增加 code seed |

## Boundary Decisions And Pruning

| Boundary       | Decision                                  | Includes                                                            | Excludes / prunes                       | Source                    |
| -------------- | ----------------------------------------- | ------------------------------------------------------------------- | --------------------------------------- | ------------------------- |
| 工具范围       | 只改 `get_app_state`                      | 当前 official、`computer-use` 与 legacy `zcode-cua` server identity | screenshot、click、type 等其他工具      | 用户请求                  |
| 标题 authority | 模型 input.title 是新调用的显示 authority | 1–120 字符、用户语言                                                | UI 根据 app 名二次改写模型标题          | 用户请求 + node_repl 先例 |
| 上游兼容       | title 在 Core dispatch 前剥离             | provider contract、history projection                               | 修改或升级外部 CUA package schema       | 当前依赖边界              |
| 历史兼容       | 缺 title 使用既有 i18n fallback           | 旧 session、旧 provider                                             | 对历史输入做迁移                        | 兼容性不变量              |
| 多端矩阵       | 用投影不变量剪枝                          | Desktop 与 mobile 各取代表性 renderer 单测语义                      | 展开 theme/locale × clientMode 笛卡尔积 | 无布局或 delivery 变更    |

## Accepted Cases

| Case ID      | Setup                   | Action               | Assertions                                         | Evidence layers | E2E status |
| ------------ | ----------------------- | -------------------- | -------------------------------------------------- | --------------- | ---------- |
| CUA-TITLE-01 | official CUA descriptor | 注册 `get_app_state` | model schema 的 `title` 必填且保留原 required 字段 | contract unit   | automated  |
| CUA-TITLE-02 | 模型调用含 title        | 执行 tool handler    | `McpPort.callTool` 收到其他参数但不含 title        | runtime unit    | automated  |
| CUA-TITLE-03 | 新 CUA tool row         | 渲染 summary         | 优先显示模型 title，不显示固定 app 摘要            | UI unit         | automated  |
| CUA-TITLE-04 | 无 title 历史 row       | 渲染 summary         | 回退到既有本地化 app 摘要                          | UI unit         | automated  |

## Planning Handoff

| Item             | Destination                                        | Status     |
| ---------------- | -------------------------------------------------- | ---------- |
| Spec update      | 本文                                               | complete   |
| Case catalog     | 本文 Accepted Cases                                | complete   |
| Coverage matrix  | 本文 Accepted Cases                                | complete   |
| Decision backlog | none                                               | complete   |
| E2E handoff      | 无新 E2E；contract/runtime/UI 单测足以覆盖本次边界 | not-needed |
