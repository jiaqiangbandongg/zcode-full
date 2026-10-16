# MCP 状态批量查询控制面

## 背景

MCP 设置页需要展示当前配置中各 server 的状态。旧方案在设置页初次加载时逐个执行真实连接检查，容易让 UI 刷新触发大量 control-plane 请求，也会把“配置状态展示”和“主动健康检查”混在一起。

## 目标

- 设置页初次加载使用一次批量状态查询，避免按 server 数量触发自动检查。
- 批量状态查询走独立的 `mcp-status` lane control-plane CLI 进程，与 plugin 管理命令（`plugins/*`）隔离进程；两者共用同一个内部 cwd（数据目录下的 `.zcode/plugin-workspace`，即 `getDataBaseDir()/.zcode/plugin-workspace`，默认等于 `~/.zcode/plugin-workspace`；E2E 隔离 HOME 或自定义 data dir 时不在 `~` 下），但不共用 stdio 连接。
- 保留单 server 主动检查能力，但只在用户手动检查或启用后检查时触发。
- 不把 MCP 状态下沉到 desktop main、relay 或 mobile remote 链路。

## 协议语义

- `mcp/list`：返回当前配置的 MCP server 状态快照。请求发往独立的 `mcp-status` lane control-plane CLI 进程；该进程持有独立的 `McpPort`，会用 runtime 同款 MCP adapter 刷新可信配置的连接状态，再返回 `status()` 的本地快照。project MCP 在未信任前仍只返回 `untrusted`，不会被连接。
- 进程生命周期：mcp-status lane 进程在首次 `mcp/list` 时惰性拉起，每个 host 最多一个（进程 key 是固定的内部 cwd）。它通过进程级连接池真正连上可信 MCP server 且完成后不断开，因此进程本身约 45 MB 之外还挂着 MCP 子进程；为避免这部分常驻，manager 对该 lane 启用 `idleTimeoutMs`（默认 5 分钟）：连接上没有请求在飞满 5 分钟即主动回收整棵进程树（`terminationKind=expected`、`terminationReason=idle-timeout`），下一次 `mcp/list` 透明地重新拉起（实测冷启动约 1 s）。chat / plugin lane 不启用空闲回收。
- 进程可观测性：spawn/ready/exit/error 事件经 `processLifecycleReporter` 上报 host → main → ARMS，payload 带 `lane`（`mcp-status`），与共用同一 cwd 和 command 的 plugin lane 进程可区分。
- 为什么要独立进程：CLI 的 ZCode Protocol transport 对同一条 stdio 连接上的请求严格串行（FIFO，只有 `session/stop` 可越队）。connect 模式的 `mcp/list` 会真正连接全部 MCP server，任一 server 握手不完成就吃满 30s 超时；此前它与 `plugins/uninstall` 等命令共用 plugin 管理进程，卸载被排在 30s 探测后面，UI 在 5 分钟请求超时内没有任何反馈（2026-09-03 线上复现：`uninstallPlugin` 等待 37s 直到用户强退，`mcp/list` 出现 60.5s = 两个 30s 首尾相接）。拆到独立 lane 后探测再慢也不阻塞插件管理，探测超时触发的进程回收也不再连坐在途的安装/卸载。
- `mcp/list` 可以带 `mcpServers` 显式输入。桌面设置页已经由 desktop main 解析 `~/.zcode/cli/config.json` 与 `.agents/mcp.json` fallback，并在真实 session create/resume 时把 enabled MCP 下发为 `params.mcpServers`；状态查询必须复用同一批 UI-resolved MCP，避免 control-plane agent 自己 `createConfig()` 读不到 `.agents` fallback 时把实际可用 server 标红。
- `mcp/probe`：保留为单 server 主动检查语义。只有用户显式检查或启用后检查时使用，结果可以和 `mcp/list` 不同。

因此 UI 不应把 `mcp/list` 结果解释成真实健康检查成功；绿色 connected 只表示快照来源报告为 connected。

## 数据流

1. UI MCP 设置页加载本地配置后，请求 `zcodeAgentService.listMcpServerStatuses(...)`，并传入当前 workspace 下 enabled 的 ZCode Agent MCP 列表。
2. service 通过 `getMcpStatusClient()` 使用 `mcpStatusProcessManager`（`lane: "mcp-status"`，独立于 plugin 管理的 `pluginProcessManager`）客户端发送 `mcp/list`。新版 agent 接收 `mcpServers`；旧版 strict agent 若拒绝该可选字段，service 会去掉字段重试一次。
3. control-plane CLI 进程内按请求 workspace 读取 plugin 配置；若请求携带 `mcpServers`，本地 ZCode Agent MCP 状态以这批显式输入为准，否则回退到 agent 自己 `createConfig()` 读取的 `mcp.servers`。
4. CLI handler 对可信配置调用进程内 `mcpPort.connectConfiguredServers(...)` 刷新本地 records；project untrusted MCP 从连接输入中剔除。显式 `mcpServers` 与 session create/resume 使用同一个 protocol-to-runtime 转换 helper，保持 timeout/env/header 等字段一致。
5. CLI handler 包装现有 `listMcpServerStatuses(...)` 返回 status snapshot；`status()` 本身只读本地 records，不再额外连接。
6. UI store 按当前本地 ZCode Agent MCP 行合并状态；plugin-managed 只读列表继续由 plugin 管理数据驱动，避免同名 server 串状态。

## UI 合并规则

- 合并仅作用于 `source === "zcodeagentmcp"` 的本地 MCP 行。
- 合并使用当前行的 `name`，但不得用 name 覆盖 plugin-managed 只读行。
- 设置页发往 `mcp/list` 的 `mcpServers` 来自当前 UI store 的 enabled ZCode Agent MCP，必须带 workspaceIdentity/workspacePath 的当前输入一起发送，不能复用其他 workspace 的缓存。
- 请求必须带 epoch 或等价版本保护，迟到的批量结果不能覆盖用户在请求期间编辑产生的 `changed`，也不能覆盖更新的手动检查结果。
- UI 仅为交互反馈写入的展示态（例如启用后立刻显示 `connecting`、禁用后显示 `unknown`）不得作废当前批量请求；只有配置、启停、workspace 身份这类会改变 agent 读取输入的操作才能推进 epoch。
- 设置页同一时间只允许一个 `mcp/list` 在飞；如果在飞期间又触发刷新，只合并成完成后的下一轮，避免多次点击开关把整批 MCP 连接排队到十几秒。
- runtime 状态映射到 UI 状态时，`failed` 映射为 `error`；`connected`、`connecting`、`disconnected` 保持可展示语义；`disabled`、`untrusted` 显示为非成功配置态并带安全说明。
- status snapshot 可选携带稳定 `failureKind` 与 `serverRequestId`。`error` 继续保存原始详情，UI 不直接把它当用户主文案。
- 可信官方 HTTP MCP 只读取响应头 `X-Request-Id`；连接、initialize、`tools/list` 的诊断可进入设置页，`tools/call` 的 request id 只进入对应工具结果。无 HTTP response 的 stdio、DNS、timeout 不伪造 id。
- ZCode envelope `3001`、`1000`，JSON-RPC `error.code=1006/3101`，HTTP 429/5xx 与其他 JSON-RPC error 分别映射为 `server_not_found`、`server_unavailable`、`not_authenticated`、`coding_plan_required`、`rate_limited`、`server_internal_error`、`protocol_error`；无法细分时使用 `connection_failed`。

## 验证

2026-09-06 合并恢复：此前插件 UI 已恢复，但服务层的独立 lane 被遗漏。本次按原控制面边界
接回 manager、请求归零事件与空闲回收，不恢复旧 Provider Store。子进程隔离专项 4/4、
完整 `zcodeAgentService` 单测 45/45 通过；这不是设置页真实交互验收的替代。

- 初次打开 MCP 设置页只触发一次 `mcp/list`，不在 UI 层逐个自动检查。
- `mcp/list` 会在 `mcp-status` lane CLI 进程内刷新可信 MCP 的 live status，配置正确但不可达应显示 failed/error，可连接应显示 connected 和工具数。
- `mcp/list` 在飞（例如某个 MCP server 30s 握手超时）期间，`plugins/uninstall`、`plugins/list` 必须立刻返回，不得排在其后（services 单测 `plugins/uninstall 不会排在挂起的 mcp/list 后面`）。
- 只有 `.agents/mcp.json` fallback 的 server 在设置页展示时，也会随 `mcpServers` 进入 `mcp/list` 并返回 snapshot，不再出现 `MCP server status was not returned by agent` 假红。
- 手动检查或启用单个 server 时才触发主动检查。
- 同名 local/plugin MCP 不串状态。
- 失败摘要中英文可切换且使用普通次要文字颜色；原始英文错误只在点击信息按钮后通过 Popover 显示，服务端 Request ID 作为详情文本的紧凑后缀出现，不再独立重复展示。成功刷新会清除旧诊断。
- 批量结果迟到时不会覆盖用户编辑或更新的手动检查结果。
- 重复点击开关或 React dev 重复触发 effect 时，不会产生重叠的 `mcp/list` 队列；最多在当前请求完成后补跑一轮最新输入。
- 桌面端通过 CDP 验证 Settings → MCP Servers 无重复刷新循环、console 无错误、状态正常渲染。
