# MCP 异步初始化与 Tool Catalog Cache

## 状态

- 阶段：规划
- 范围：Agent runtime、MCP adapter、tool registry / executor、bootstrap 进程级依赖
- 目标：引入进程级 tool catalog cache，让命中缓存的新 session 可以在 live MCP 初始化完成前发起首轮模型请求
- 非目标：不实现 live MCP server/client LRU，不减少每个活跃 session 实际启动的 MCP server 数量

因此，本方案解决的是 MCP 初始化阻塞首轮模型请求的延迟，不解决 session/runtime 未释放造成的 live
MCP 进程和内存持续增长。后者若仍存在，应单独按 session ownership / close lifecycle 定位，不能把
tool catalog cache 当成资源回收机制。

## 背景

ZCode 当前已经在 session/runtime 创建时提前调度 MCP 初始化，但首个 provider request 之前仍会执行：

```text
startMcpStartup()
  -> connectConfiguredServers()
  -> initializeMcp() await startup
  -> registerMcpTools(live tools)
  -> provider request
```

因此当前“异步”只让 MCP 初始化与 context、skills、memory 等准备阶段并行；首轮模型请求仍被
`initialize + tools/list` 的最慢 server 阻塞。

优化重点不是共享 live MCP runtime，而是把两个事实分开：

```text
provider-visible tool catalog
  可以来自进程级、短期、经过清洗的 schema cache

live tool execution
  必须等待当前 session 的 live client，并重新确认工具、schema 和权限 metadata
```

本设计采用这种双通道语义。

## 设计取舍

| 能力                            | 语义                                                                                         | ZCode 规划                                     |
| ------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| process-scoped tool catalog LRU | 32 entries、30 分钟 TTL；只在 startup pending 时读                                           | Phase 1/2 采用                                 |
| transport identity              | stdio command/args/env/cwd/environment/client capability；HTTP 因 auth identity 不稳定而跳过 | 采用，并补 workspace identity 边界             |
| payload sanitization            | publish 前移除 connection instructions 和 tool annotations                                   | 采用；cache 不参与权限                         |
| concurrent publish              | entry-local generation，较旧 fetch 不能覆盖较新 snapshot                                     | 采用                                           |
| cold miss                       | tool listing 等 live client；不会为了快而静默隐藏 MCP                                        | 采用 aggregate complete-hit                    |
| live execution                  | 调用前等待当前 client，并从 live inventory 重新查 tool/visibility/annotations 后再审批       | 采用，并适配 ZCode 的 schema validation 顺序   |
| lifecycle                       | per-server startup future、startup cancellation、manager shutdown 和 stdio cleanup           | 保留现有 session ownership 并补回归            |
| status / auth / elicitation     | per-server startup update、auth state、ready wait、elicitation routing                       | 不由 catalog 接管                              |
| connector 专用 cache            | 失败后长期使用 cache、后台 reconnect、hard refresh，语义不同于普通 MCP                       | 不泛化到普通 MCP                               |
| required server                 | 把部分 server 标为 required，未就绪时阻塞                                                    | ZCode 当前无对应产品语义，本功能不顺带引入     |
| resources / templates           | 继续从 live client 查询，不走普通 tool catalog cache                                         | 不纳入本功能                                   |
| `tools/list_changed`            | 普通 catalog cache 当前没有完整动态 invalidation                                             | ZCode Phase 3 可在识别 notification 后标 dirty |

核心取舍是只做“startup advertisement 快路径”，不引入 connector 专用的长期 stale
fallback，也不把 cache 发展成第二套 MCP runtime。

## 已确认边界

1. 每个 session 继续拥有独立 `NodeMcpAdapter` 和独立 MCP server/client。
2. 不实现 live server LRU、idle eviction 或跨 session client 共享。
3. cache 只保存 tool catalog，不保存 client、transport、OAuth session 或 process handle。
4. cache 命中不代表 server 已 connected，设置页状态仍只反映 live control-plane 状态。
5. cache 只优化 provider tool declarations 的等待，不改变 session create/resume、conversation
   projection、desktop continuous 或 mobile replayable 语义。
6. tool call 必须在输入校验和权限判断前切换到 live descriptor。

## Impact Brief

### Feature Summary

| 项目     | 内容                                                                                      |
| -------- | ----------------------------------------------------------------------------------------- |
| 目标     | warm catalog hit 时，首轮 provider request 不等待当前 session 的 live MCP startup         |
| 用户价值 | 新建或恢复 session 能更快得到首轮响应，同时真实 MCP 调用仍使用本 session 的 live server   |
| 核心边界 | catalog 只负责 capability advertisement；live adapter 负责连接、权限事实和执行            |
| 明确不做 | live MCP LRU、跨 session client/process 共享、HTTP/SSE catalog cache、长期 stale fallback |

### UI Surface Matrix

| Surface                    | 是否改 UI | 行为影响                                                       | 证据/回归                          |
| -------------------------- | --------- | -------------------------------------------------------------- | ---------------------------------- |
| Conversation 首轮 sampling | 否        | complete-hit 时提前发起 provider request                       | core/bootstrap deterministic tests |
| MCP 设置页                 | 否        | 继续展示 control-plane live status；cache hit 不显示 connected | `MO01-MO03` + status unit tests    |
| MCP tool call / approval   | 否        | permission 前等待并解析 live descriptor                        | `Y01/Y02` + tool executor tests    |
| Subagent                   | 否        | 继续借用 parent live snapshot，不继承 advertisement cache      | borrowed port tests                |
| Desktop / mobile remote    | 否        | 共享 Agent 事实；不改变 continuous / replayable delivery       | invariant regression               |

### Shared vs. Divergent Behavior

- 共享：所有 session runtime 使用相同的 catalog lookup、sanitization、generation 和 live preflight
  规则。
- 分流：warm complete-hit 可以先 sampling；cold/partial/unsupported miss 继续等待 live startup。
- 分流：control-plane 只在显式 live connect 成功后才可能 seed catalog；status-only 查询不 seed。
- 分流：subagent 只消费 parent 的 live connected snapshot，不消费 cached advertisement。
- 不变：desktop continuous 与 mobile replayable 只负责消息交付，不拥有 catalog 或 MCP runtime。

### State Owners

| 状态                                            | Owner                                            | 生命周期                    |
| ----------------------------------------------- | ------------------------------------------------ | --------------------------- |
| sanitized tool catalog LRU                      | Agent/bootstrap 注入的 `McpToolCatalogPort` 实现 | Agent process               |
| live MCP client/process/status                  | 每个 session 的 `McpPort` / `NodeMcpAdapter`     | session                     |
| startup Promise / AbortController / coordinator | `AgentRuntime` session runtime                   | session                     |
| cached/live MCP `ToolEntry` 集合                | session `ToolRegistry`                           | session                     |
| control-plane MCP status                        | control-plane adapter                            | Agent process control-plane |

`AgentRuntime` 只拥有 startup coordination；`SessionFacade.closeSessionResources()` 继续拥有实际
`McpPort.close()` 调度和 process cleanup。两个 owner 不能合并成同一个异步 finally，否则 shutdown
先后顺序会再次变得隐式。

## 推荐的第一版产品语义

以下语义作为第一版推荐默认值；实现前若需要改变，应先更新本文。

| 条件                                                          | 首轮 provider tools                | Tool call                                                  | 后续 model step                                   |
| ------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------- | ------------------------------------------------- |
| 所有可缓存 server 都命中新鲜 catalog，且 live startup pending | 立即使用 cached catalog            | 等同一个 startup promise；使用 live descriptor 校验和审批  | startup 成功后使用 live catalog                   |
| cache 中存在合法空 catalog                                    | 立即使用空 MCP tool 集合           | 不存在可调用 MCP tool                                      | startup 成功后使用 live catalog                   |
| 任一 enabled server cold miss、过期或 transport 不支持 cache  | 等待 live startup                  | 使用 live descriptor                                       | 使用 live catalog                                 |
| warm hit 后 live startup 成功                                 | 当前已发请求保持 cached contracts  | live revalidation 后执行                                   | 原子替换为 live contracts                         |
| warm hit 后普通 MCP startup 失败                              | 当前已发请求可能仍包含 cached tool | 返回结构化 unavailable/startup failure                     | 后续不再广告；execution-only tombstone 承接旧调用 |
| warm hit 后 startup 被 session shutdown 取消                  | 当前 waiter 收到 cancellation      | 不执行                                                     | session 关闭                                      |
| cached tool 已被 live server 删除或隐藏                       | 模型可能产生旧 tool call           | 在 permission 前拒绝为 unavailable                         | live catalog 不再包含该工具                       |
| cached schema 与 live schema 不同                             | 模型可能按旧 schema 产生参数       | 使用 live schema 重新校验；错误作为可恢复 tool result 返回 | live catalog 替换旧 schema                        |

真正 cold miss 时继续等待 MCP。第一版不采用“首轮静默省略
MCP tools、下一轮再出现”的更激进策略，避免用户明确要求使用 MCP 时模型误判能力不存在。

## 总体架构

```text
ZCode Protocol / Agent process
│
├─ McpToolCatalogPort                        process scoped
│    ├─ stdio identity A -> sanitized tools
│    ├─ stdio identity B -> sanitized tools
│    └─ LRU capacity=32, TTL=30m
│
├─ control-plane NodeMcpAdapter              live，设置页 mcp/list
│    └─ 成功 tools/list 可发布 catalog
│
├─ Session A NodeMcpAdapter                  live，session scoped
│    ├─ startup shared Promise
│    └─ 成功 tools/list 可发布 catalog
│
└─ Session B NodeMcpAdapter                  live，session scoped
     ├─ startup shared Promise
     └─ 命中 catalog 时 provider 不等待 startup
```

catalog port 的内存实现可以放在 adapter 层，但不塞进 `NodeMcpAdapter`，也不扩展现有 live
`McpPort`。生命周期由 bootstrap 显式注入：

```text
bootstrap creates one McpToolCatalogPort
  -> inject Agent protocol control-plane
  -> inject every createZCodeApp / session runtime

each session still creates its own NodeMcpAdapter
  -> existing connectConfiguredServers()
  -> existing listTools() / callTool() / close()
```

禁止使用模块级隐式 singleton。测试、同进程多 Agent 实例和未来不同 runtime 环境必须能通过依赖注入
获得独立 cache。

## 初始化时序

### Warm catalog hit

```text
session/runtime create
  -> catalogPort.context(scope) for each enabled server
       ├─ 同步读取 complete cached catalog
       └─ 为每个可缓存 server 分配 fetch generation ticket
  -> 立即调用现有 mcpPort.connectConfiguredServers()
       └─ 把同一个 Promise 保存为 session shared startup
  -> 注册 advertisement-only cached ToolEntry
  -> provider request 使用 cached contracts

后台 startup 完成
  -> connected server publishIfNewest()
  -> 用 live ToolEntry 替换 cached ToolEntry
  -> live inventory 中已不存在的 cached ToolEntry 改为 provider-invisible tombstone
  -> invalidate provider tool contract cache
```

### Cold catalog miss

```text
session/runtime create
  -> catalogPort lookup 得到 incomplete coverage
  -> 立即调用现有 mcpPort.connectConfiguredServers()
       └─ 把同一个 Promise 保存为 session shared startup
  -> 首轮 sampling await live startup
  -> 注册 live ToolEntry
  -> provider request
```

### 新建与恢复 session

- 新建 session 和 cold-resume session 走同一 lookup 规则，不把“旧 session”本身视为 cache hit。
- 已存活 session 若 runtime 和 live adapter 仍在，继续使用自己的 live 状态，不重新走 catalog 快路径。
- session 关闭后重新恢复会创建新的 live adapter；若同一 Agent process 中仍有 matching catalog，
  可以 warm sampling，但 tool call 仍等待这个新 adapter。
- catalog 不写入 rollout、task snapshot 或 replayable event；Agent process 重启后普通 catalog 为 cold
  miss，这也避免把 schema cache 误当成持久化 session 权限。

### Cached tool call

```text
provider returns cached MCP tool call
  -> registry 找到 advertisement-only cached ToolEntry
  -> resolveForExecution(signal)
       ├─ await 当前 session shared startup Promise
       ├─ 从当前 live adapter 查找 serverName + toolName
       ├─ 不存在 / 不可见 / 当前 provider name 已变化 -> structured unavailable
       └─ 存在 -> 构造 live ToolEntry
  -> 使用 live input schema 校验
  -> 运行 PreToolUse / permission policy
  -> 使用 live annotations 判断 readOnly/destructive/risk
  -> live callTool()
```

`resolveForExecution` 必须发生在初次 input validation、PreToolUse hook 和 permission 之前。只在
cached handler 内等待 startup 是不安全的，因为当前 executor 在 handler 之前已经使用
`ToolEntry.metadata` 完成权限决策。

## Port 与运行时接口

现有 `McpPort` 保持不变。它继续只表达当前 session 的 live 连接与执行能力：

```text
McpPort
  connectConfiguredServers / connectServer / disconnectServer
  status / listTools / callTool / close
```

新增独立、可注入的 `McpToolCatalogPort`，表达跨 session 的只读 schema cache。runtime 在调用现有
`connectConfiguredServers()` 前同步取得 lookup context 和 generation ticket：

```ts
type McpToolCatalogWorkspaceScope =
  | {
      kind: "local";
      workspaceIdentity?: string;
      workspacePath: string;
    }
  | {
      kind: "remote";
      workspaceIdentity?: string;
      workspacePath: string;
      remoteSessionId?: string;
    };

interface McpToolCatalogScope {
  workspace: McpToolCatalogWorkspaceScope;
  serverName: string;
  serverConfig: McpServerConfig;
  clientCapabilityFingerprint: string;
}

interface McpToolCatalogFetchTicket {
  generation: number;
}

interface McpToolCatalogContext {
  current():
    | { kind: "hit"; tools: McpCatalogToolDescriptor[] }
    | { kind: "miss"; reason: "absent" | "expired" | "dirty" | "oversize" };

  beginFetch(): McpToolCatalogFetchTicket;

  publishIfNewest(
    ticket: McpToolCatalogFetchTicket,
    tools: McpToolDescriptor[],
  ): void;

  invalidate(): void;
}

interface McpToolCatalogPort {
  context(scope: McpToolCatalogScope): McpToolCatalogContext | undefined;
}
```

`context()` 对第一版不支持的 HTTP/SSE 返回 `undefined`，这会使 aggregate coverage 变为
`incomplete`。cache identity 的规范化、敏感字段 digest、TTL、LRU 和 generation 都封装在 port
实现内，core runtime 不拼接 key。

`McpCatalogToolDescriptor` 应在类型上排除不能跨 session 信任的字段，避免调用方误用：

```ts
type McpCatalogToolDescriptor = Pick<
  McpToolDescriptor,
  | "serverName"
  | "toolName"
  | "name"
  | "description"
  | "inputSchema"
  | "outputSchema"
>;
```

合法空数组必须表示 cache hit，不能与 cache miss 共用 `undefined`。

`startMcpStartup()` 的协调职责为：

```text
1. 为 enabled servers 取得 catalog contexts、读取 snapshot、分配 fetch tickets
2. 无条件立即启动现有 mcpPort.connectConfiguredServers()
3. 保存且复用同一个 startup Promise
4. complete-hit：先注册 advertisement entries；cold/incomplete：首轮 await startup
5. startup success：按 server publishIfNewest()，包括成功的零工具 catalog
6. reconcile 当前 session 的 live registry；缺失项改为 provider-invisible tombstone
7. startup failure/cancel：不 publish；停止广告 cached entries，并保留旧响应可解析的 tombstone
```

这个拆分使 catalog 优化可以单独关闭或替换，也避免 control-plane、subagent 或 live adapter 被迫理解
provider sampling 的 warm/cold 语义。

### Session startup coordinator

当前 `mcpInitialized` / `mcpToolsRegistered` 两个布尔值无法区分“cached entries 已广告”和“live
entries 已收敛”。实现时应由一个 session-scoped coordinator 统一拥有 Promise、catalog contexts
和 registry names，避免多个 turn、compact 或 tool call 分别拼状态：

```text
                         complete-hit
IDLE ── start ──> STARTING_CACHED ──────> provider sampling allowed
                    │   │
                    │   ├─ live snapshot settled ──> LIVE_SETTLED
                    │   └─ session close ──────────> CLOSED
                    │
                    └─ tool call ── wait same Promise ── live resolve

                         incomplete
IDLE ── start ──> STARTING_BLOCKED ─────> provider waits same Promise
                         │
                         ├─ live snapshot settled ──> LIVE_SETTLED
                         └─ session close ──────────> CLOSED
```

`LIVE_SETTLED` 是 per-server 结果：connected server 使用 live entries；failed/disabled server 不再
广告对应 cached entries，但保留 execution-only tombstone。aggregate throw 和 session cancellation
也必须形成可供 preflight 读取的 terminal outcome，不能只吞错后留下“已注册”的布尔值。

## Tool registry 与 executor

### Advertisement entry

cached descriptor 只能生成 provider advertisement entry：

- 给 `ToolRegistry.toContracts()` 提供 name、description、input/output schema。
- 按当前 session 的 tool allowlist / denylist 重新过滤。
- 不提供可被权限系统信任的 annotations、risk、approval 或 session instructions。
- 携带 `resolveForExecution`，在执行边界解析为 live `ToolEntry`。
- 现有 `ToolEntry` 必填的 permission/metadata 字段使用固定保守 placeholder（high risk、needs
  approval），不能从 cache 推导；executor 必须断言 deferred entry 已先解析，placeholder 不得进入真正
  permission flow。

建议给 `ToolEntry` 增加可选 preflight：

```ts
type ToolExecutionEntryResolution =
  | { kind: "ready"; entry: ToolEntry }
  | { kind: "unavailable"; message: string; recoverable: true }
  | { kind: "cancelled"; message: string };

interface ToolEntry {
  resolveForExecution?: (context: {
    input: unknown;
    signal?: AbortSignal;
  }) => Promise<ToolExecutionEntryResolution>;
}
```

`call-runner` 在 registry lookup 后、canonicalize / normalize / validation 之前只执行一次 preflight；
`ready.entry` 成为后续唯一 entry。`unavailable` 产生稳定、可恢复的 MCP tool result，`cancelled`
产生现有 cancellation 结果；两者都不进入 hook、permission 或 handler，也必须发布对应的 tool error
事件，不能让 UI row 永久停在 input streaming。

preflight 等待的是同一个 session shared startup Promise，并同时 race 当前 tool caller signal 与
session shutdown signal。shared startup 必须继续受现有 MCP connect / initialize / auth 配置超时约束；
若某种 transport 当前没有有限 startup timeout，Phase 2 对该 transport 的启用必须先补齐 timeout，
不能让 cached tool call 无限等待。startup terminal failure 映射为 `unavailable`，caller abort 映射为
现有 `ToolCancelled` 并发布 terminal tool event。

这段 startup 等待不计入 live tool handler 的 execution timeout，语义与 permission wait 相同：
只有 preflight 得到 live entry、完成 live schema 校验与 permission 后，现有 handler
`executeWithTimeout` 才开始计时。另记 `mcp.tool.live_preflight.waitMs`，便于区分初始化慢与工具执行慢。

### Registry reconcile

当前 `registerMcpTools()` 只会覆盖同名 entry，不会删除 live inventory 中已消失的工具。异步 catalog
需要显式管理本 session 注册过的 MCP tool names：

```text
cached names = {A, B, C}
live names   = {A, C, D}

reconcile:
  replace A/C with live entries
  replace B with provider-invisible unavailable tombstone
  register D
  invalidate provider tool cache
```

同一个已经发出的 provider request 持有自己的 tool contract 数组，不被 registry 后续 reconcile
改写。因此不能立即 unregister B：旧响应到达时会在 registry lookup 阶段变成不可恢复的
`ToolNotFound`，根本到不了 live preflight。

第一版给 registry entry 增加“是否参与 `toContracts()`”的 advertisement 标记。tombstone 不再进入
后续 provider contracts，但 registry lookup 仍能解析旧响应，并稳定返回 recoverable unavailable。
因为当前 session MCP 配置不热切换，tombstone 可以保留到 session close；未来若引入 runtime refresh，
再用 provider contract generation/ref-count 安全回收，不能靠立即 unregister 猜测旧响应已经结束。

## Tool Catalog Cache

### 范围

第一版只缓存普通 stdio MCP。

HTTP/SSE 暂不缓存，原因是当前没有稳定、规范化的 resolved auth principal identity。只按 URL、
headers 或 server name 共享可能把不同账号、OAuth token 或权限范围下的 tool catalog 串在一起。

### 默认容量与有效期

- LRU capacity：32 个 server catalog identity
- 单 entry sanitized JSON 上限：2 MiB
- process cache sanitized JSON 总预算：16 MiB，按 weighted LRU 淘汰
- TTL：30 分钟
- 生命周期：仅进程内，不落盘
- snapshot：`tools + publishedAt`
- entry：`nextFetchGeneration + lastAcceptedGeneration`

除 entry 数量约束外，ZCode 额外增加 byte budget，避免少量异常大 schema 反向制造新的内存
问题。成功取得但超过单 entry 上限的 catalog 标记为 `oversize` 并清除该 identity 的旧 snapshot，后续
走 cold path；不能因为“新值放不下”继续广告旧值。

参数先作为内部可注入选项，方便 fake clock 和容量测试，不增加用户配置项。
lookup 命中可以提升 LRU recency，但 TTL 固定从最后一次成功 publish 计算，不能因反复读取而无限续期。

### Identity

identity 必须表达“这个连接是否应得到相同 tool schema”，建议至少包含：

```text
local workspaceKey = workspaceIdentity?.trim() || workspacePath
remote workspaceKey = workspaceIdentity.trim()（必需）
+ remoteSessionId（remote scope 必需）
+ serverName
+ normalized stdio command
+ ordered args
+ explicit cwd / effective fallback cwd
+ effective environment digest
+ client capability fingerprint
+ tool catalog schema version
```

要求：

- `workspacePath` 只用于执行 cwd；隔离使用 `workspaceKey`。
- 同 path、不同 remote identity 必须 miss。
- 本地允许 `workspaceIdentity` 缺省并 fallback 到 path；SSH/WSL/Docker 若拿不到应有的
  `workspaceIdentity` / `remoteSessionId`，第一版返回 unsupported/cold miss，不能降级成只按远端 path
  共享。
- env value 只进入 cache 实例持有的 process-salted cryptographic digest，不进入可序列化 raw key；
  不得出现在日志、错误或 telemetry。
- port 只从 `serverConfig` 计算规范化 fingerprint，不在 cache entry 中保留 raw config。
- key 日志只允许输出 opaque fingerprint 和 hit/miss reason。
- client capability 或 catalog payload schema 变化必须使旧 entry miss。
- cwd resolve、base env、network env 与 server env 的合并必须复用 live adapter 的纯函数，不能另写一套
  “近似 key”；Windows 环境变量名按大小写不敏感规范化，路径使用当前平台语义。
- session-specific browser broker、临时 socket、临时 token 若进入 effective config，必须参与 fingerprint；
  因而 built-in `node_repl` 第一版可能无法跨 session 命中，这是安全优先的预期结果。

### Payload sanitization

允许缓存：

- server/tool stable identity
- model-visible name
- description
- input schema
- output schema

禁止缓存或禁止从 cache 信任：

- `annotations`
- readOnly / destructive / idempotent / openWorld 推断
- permission / approval / risk level
- session-specific initialize instructions
- OAuth/auth availability
- runtime scope、sandbox、cwd execution state
- plugin/session provenance
- client、transport、process handle

### Generation

每次 live fetch 在真正连接前取得 entry-local generation ticket：

```text
ticket.generation <= lastAcceptedGeneration
  -> 丢弃 publish

ticket.generation > lastAcceptedGeneration
  -> sanitize
  -> 保存 snapshot
  -> 更新 lastAcceptedGeneration
```

LRU 淘汰后，已经持有旧 entry context 的 fetch 可以完成，但不得把已淘汰 identity 隐式重新插回
LRU。新的 lookup 创建新 entry，由新 generation 独立管理。

### Aggregate coverage

第一版采用完整覆盖语义：

- 所有 enabled、可缓存 server 都有新鲜 entry，才能返回 `complete-hit`。
- 任一 server miss、expired 或 transport unsupported，整体返回 `incomplete`，首轮等待 live startup。
- disabled/untrusted server 不要求 cache entry，也不贡献 provider tools。

不做“部分 server 先暴露、其余 server 后出现”的 progressive tool set，避免第一轮模型看到不完整能力。

## Failure、取消与刷新

### Startup failure

- 失败结果不能覆盖已有成功 catalog。
- 该失败 session 在 startup 进入 terminal 后不得继续向后续 model step 暴露 cached tools。
- 已经发出的 model request 若调用 cached tool，通过 live preflight 返回 unavailable/startup failure。
- registry 不立即 unregister 已广告的 cached name，而是切换为 provider-invisible tombstone，承接已经
  发出的 provider request。
- 新 session 可以再次在 startup pending 窗口使用仍在 TTL 内的 catalog；若本次也失败，同样在
  terminal 后停止暴露。

“启动失败后长期使用 cache 并后台 reconnect”属于 connector 专用语义，第一版不泛化到
普通 MCP。

### Cancellation

```text
turn/tool waiter abort
  -> 只取消当前 waiter
  -> 不取消 session shared startup

AgentRuntime.beginShutdown()
  -> 同步把 startup coordinator 转成 CLOSED
  -> abort session-owned startup controller
  -> completion handler 检查 CLOSED + generation，不 publish / reconcile

SessionFacade.closeSessionResources()
  -> 仍负责调用 mcpPort.close()
  -> 执行现有 adapter / stdio process tree cleanup
  -> 不 publish cancelled fetch
```

当前 `callTool()` 对 `record.connecting` 的直接 `await` 不受本次 tool-call `AbortSignal` 约束。
实现时需要增加 per-waiter abort race，但不能因为一个 waiter stop 就取消仍由 session 持有的 startup。
`AgentRuntime.beginShutdown()` 是 coordinator 的同步关闭点，负责阻止异步完成回写；它不接管实际
adapter close ownership。实际 MCP process cleanup 仍由 `SessionFacade.closeSessionResources()` 的
现有并发 close 链路负责，避免 runtime 与 facade 双重 close 或漏 close。

为保持现有 `McpPort` contract，session-owned controller 可以先取消 coordinator 暴露的 shared
startup wrapper；底层 raw connect promise 由随后并发发生的 `mcpPort.close()` 中断/清理。无论 raw
promise 最终 resolve 还是 reject，completion 都必须先检查 CLOSED，不能重新 publish 或改 registry。

### Config refresh

当前 session MCP 配置仍是启动期配置，本设计不新增 session runtime 配置热切换。

未来若增加 refresh：

- 新 generation 成功后才能 publish。
- 已经发出的 model step 保持自己的 contracts。
- in-flight live tool call 不被新 catalog 中断。

### `tools/list_changed`

Phase 2 可以在 feature flag 下先不实现完整动态刷新，Phase 3 再收口 notification：

- cache read 不刷新 `publishedAt`。
- adapter 能识别 `tools/list_changed` 后，把对应 entry 标记 dirty / invalidate，不直接把 notification
  payload 当作新 catalog。
- 若 adapter 当前未消费该 notification，在风险说明中明确依赖 TTL + live revalidation，不得声称
  catalog 与 server 永远同步。

## Control-plane 与设置页

process-scoped control-plane 协议处理器可以注入同一个 `McpToolCatalogPort`，使设置页触发的成功
`connect + tools/list` 在 Phase 3 提前为新 session 填充 schema；live adapters 本身无需持有 cache。

边界保持：

- `mcp/list` status 仍来自 control-plane adapter 的 live status。
- catalog hit 不投影成 `connected`，也不改变 tool count/status UI。
- status-only 请求不连接、不发布新 catalog。
- connect replace 只有成功取得 live tools 时才发布。
- OAuth pending、workspace epoch、配置 readiness 和敏感信息隔离继续遵守
  `docs/mcp-oauth-client-auth.md`。

## Subagent

当前 subagent 借用 parent `McpPort`，并消费 parent 的精确 startup snapshot；child 不拥有连接生命周期。

第一版保持该契约：

- parent 主模型可以使用 cached catalog 提前 sampling。
- 当模型真正启动 `Agent` tool 且 child 需要继承 MCP 时，subagent bridge 继续等待 parent live startup。
- child 只接收当前 live connected server 的精确、scope-filtered snapshot。
- child 不能使用 parent 的 advertisement-only cached snapshot，也不能 publish/close parent catalog 或连接。

后续如果需要优化“不使用 MCP 的 child 也等待 parent startup”，应单独设计按 profile/scoped server
需求裁剪，不能在本功能中把 cached metadata 当成 child 执行权限。

## Desktop、Web、Mobile 与远程边界

```text
desktop-continuous ─┐
                    ├─ shared Host / Agent session -> session MCP adapter
mobile replayable ──┘
```

- cache 只存在于实际 Agent process。
- mobile `/remote` 继续 attachment 到桌面已有 Host/Agent，不创建独立 MCP runtime 或 cache authority。
- relay、desktop main、renderer 不持有 tool catalog 业务状态。
- desktop continuous 与 mobile replayable 只影响事件如何到达 UI，不改变 provider tool catalog 和
  live execution 事实。
- remote workspace identity 必须进入 cache key；不能只按远端 `workspacePath` 共享。
- 当前 `ZCodeWorkspaceRef` 只有 `workspaceIdentity` / `workspaceKey` / `workspacePath`，没有
  `remoteSessionId`。Phase 2 只用统一 remote identity parser 判断它是远程 workspace，不从 identity
  字符串反推或拼造 session id；一旦判定为远程，catalog context 返回 unsupported，首轮继续走 cold
  live path。
- Phase 3 若要开启远程 catalog，必须先把真实 `remoteSessionId` 从现有 host/workspace session
  resolver 贯穿到内部 workspace/session context 和 catalog scope，并与 `workspaceIdentity` 一起建
  key。缺任一字段仍禁用，不得只按 path 共享，也不得把该状态下沉到 main/relay。

本设计不修改 `getTaskSnapshot`、dynamic task event、owner lease、queue 或 replay gap 恢复。

## 日志与指标

服务层日志使用 `createServiceLogger(scope)`；Agent/bootstrap 继续使用现有 logger。禁止记录 env、
headers、OAuth secret、token 或完整 tool schema。

建议事件：

| 事件                            | 级别  | 关键字段                                               |
| ------------------------------- | ----- | ------------------------------------------------------ |
| `mcp.catalog.lookup`            | debug | fingerprint、hit/miss/expired/unsupported、serverCount |
| `mcp.catalog.published`         | debug | fingerprint、toolCount、generation                     |
| `mcp.catalog.publish_discarded` | debug | fingerprint、generation、lastAcceptedGeneration        |
| `mcp.startup.sampling_ready`    | info  | source=cache/live、waitMs、serverCount、toolCount      |
| `mcp.tool.live_preflight`       | debug | serverName、toolName、waitMs、outcome                  |
| `mcp.startup.failed`            | warn  | 现有失败摘要，不含敏感配置                             |

建议聚合指标：

- catalog complete-hit / incomplete / expired / unsupported 比例
- warm hit 时 provider 前 MCP wait
- cold miss 时 provider 前 MCP wait
- cached tool call 等待 live startup 的时长
- live preflight unavailable / schema drift 数量
- LRU entry 数量与 eviction 数量

高频 tool call 细节必须走 debug；生产生命周期只保留每 session 一次的 sampling-ready 和异常。

## 分阶段实施

### Phase 1：Cache write-only

目标：不改变 provider 等待语义，先验证 identity、sanitization 和 publish generation。

主要改动：

- 新增 `McpToolCatalogPort` contract 和 adapter 层内存实现。
- bootstrap 创建 process-scoped port，并注入每个 session runtime。
- session runtime 在成功 `tools/list` 后 publish；不修改 `NodeMcpAdapter`。
- 增加 cache hit/miss/publish 指标，但 runtime 暂不读取 cache。
- control-plane seed 暂不启用，避免把 status 与 cache authority 一次性耦合进第一阶段。

验收：

- 不改变现有 MCP runtime、权限、设置页和 E2E 行为。
- 两个并发 session 乱序完成时旧 generation 不能覆盖新 snapshot。
- 无敏感配置进入日志。

### Phase 2：Async provider catalog

目标：先在本地 workspace 上让 complete-hit 的首轮 provider request 不等待 live MCP，并把执行与
生命周期安全边界作为启用门槛。

主要改动：

- runtime 在调用现有 `McpPort.connectConfiguredServers()` 前读取 catalog context，并保存同一个
  shared startup Promise。
- runtime 注册 cached advertisement entries。
- startup completion 后 reconcile live entries；缺失/失败项转成 provider-invisible tombstone。
- executor 增加 permission 前的 live `resolveForExecution`。
- tool waiter 支持独立 AbortSignal，不取消 shared startup。
- `AgentRuntime.beginShutdown()` 同步关闭 coordinator 并 abort session startup；facade 继续拥有
  `mcpPort.close()`。
- 本地 workspace 可以读取 cache；识别为 SSH/WSL/Docker 等远程 workspace 时返回 unsupported/cold
  miss，直到 `remoteSessionId` 已端到端进入 runtime。
- subagent 继续等待 parent live startup，只借用 live connected snapshot；不得读取 advertisement
  cache。

验收：

- warm session 的 provider request 在 MCP barrier 放行前到达。
- tool call 在 barrier 前保持等待，放行后调用当前 session 的 live process。
- cached tool 删除、schema 变化和 destructive annotation 变化均由 live preflight 裁决。
- 已经发出 contracts 后发生 reconcile，stale tool call 仍进入 tombstone preflight，不变成
  `ToolNotFound`。
- shutdown 与 startup completion 竞态时不 publish、不 reconcile，现有 process tree cleanup 仍执行。
- 远程 workspace 安全退化为 cold live path；subagent 保持 live-only。两项是 Phase 2 enablement
  gate，不延后到默认开启阶段。

### Phase 3：边界完善与默认开启

目标：完成 control-plane seed、notification、可观测性，并在 identity 贯穿完成后可选开启远程
catalog。

主要改动：

- 设置页 live connect 成功结果 seed catalog。
- `tools/list_changed` dirty/invalidation。
- 可选：把真实 `remoteSessionId` 贯穿到 runtime catalog scope，再开启 SSH/WSL/Docker cache，并做
  不串 identity 的代表测试；贯穿未完成时继续保持 Phase 2 的 remote unsupported 行为。
- 根据指标确认默认开启；保留内部 cache mode 便于紧急回退。

## 预计代码影响

| Rank           | 区域                                                                              | 预计改动                                             |
| -------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------- |
| invariant-only | `apps/zcode-cli/packages/contracts/src/interfaces/mcp.port.ts`                    | 现有 live port 接口保持不变                          |
| must-inspect   | `apps/zcode-cli/packages/contracts/src/interfaces/`                               | 新增 catalog port、scope、sanitized descriptor 类型  |
| must-inspect   | `apps/zcode-cli/packages/adapters/src/mcp-tool-catalog/`                          | 内存 LRU、identity、TTL、generation、sanitization    |
| must-inspect   | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-entrypoint.ts`              | process-scoped cache owner                           |
| must-inspect   | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-types.ts`            | catalog port 进入 protocol process context           |
| must-inspect   | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts`       | 本地 scope 与远程分类；Phase 3 可选贯穿 session id   |
| must-inspect   | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workspace-model-catalog.ts` | 把同一个 port 传给每个 workspace session app         |
| must-inspect   | `apps/zcode-cli/packages/bootstrap/src/app/create-app.ts`                         | catalog port dependency injection 到 session runtime |
| must-inspect   | `apps/zcode-cli/packages/bootstrap/src/app/session-facade.ts`                     | 保持实际 MCP close ownership 与 cleanup              |
| must-inspect   | `apps/zcode-cli/packages/core/src/runtime/agent-runtime.ts`                       | shutdown 同步关闭 coordinator、abort startup         |
| must-inspect   | `apps/zcode-cli/packages/core/src/runtime/methods/mcp.ts`                         | cached/live startup 状态与 reconcile                 |
| must-inspect   | `apps/zcode-cli/packages/core/src/runtime/methods/turn-loop.ts`                   | sampling 前 warm/cold 选择                           |
| must-inspect   | `apps/zcode-cli/packages/core/src/mcp/index.ts`                                   | advertisement entry 与 live entry 构造               |
| must-inspect   | `apps/zcode-cli/packages/core/src/tool/executor/call-runner.ts`                   | permission 前 live preflight、waiter abort           |
| should-inspect | `apps/zcode-cli/packages/core/src/tool/registry.ts`                               | reconcile / provider-invisible tombstone             |
| should-inspect | `apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts`                    | parent startup 与 borrowed snapshot                  |
| should-inspect | `apps/zcode-cli/packages/core/src/subagent/borrowed-mcp-port.ts`                  | 保持 live-only、scope-filtered                       |
| conditional    | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mcp.ts`                     | control-plane 成功结果 seed cache                    |
| conditional    | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workspace.ts`               | Phase 3 贯穿真实 remoteSessionId                     |
| conditional    | `packages/shared/src/zcode-protocol/index.ts`                                     | 若跨进程接口需扩展，增加严格 schema                  |
| invariant-only | `packages/ui/src/settings/McpSettingsSection.tsx`                                 | status UI 不读取 catalog                             |
| invariant-only | web remote / relay / desktop main                                                 | 不新增 cache authority 或 runtime 状态               |

## 测试规划

### Adapter unit

1. miss、fresh hit、合法空 hit、TTL expiry、count/weighted-byte eviction。
2. server/config/cwd/env digest/workspace identity/client capability 任一变化产生 miss。
3. 同 path 不同 `workspaceIdentity` / `remoteSessionId` 不共享。
4. Windows env key 大小写与 path resolve 使用 Windows 语义；macOS/Linux 不误套 Windows 规则。
5. HTTP/SSE 返回 unsupported，不创建普通 catalog entry。
6. annotations、timeout、session instructions 和敏感字段不进入 payload。
7. generation 乱序完成时 newest wins。
8. 被 LRU 淘汰的 in-flight entry 完成后不重新插入。
9. cache read 可以更新 LRU recency，但不延长基于 `publishedAt` 的 TTL。
10. oversize live catalog 清除旧 snapshot 并进入 cold path，不保留过时 advertisement。

### Core runtime

1. complete-hit：provider request 不等待 startup。
2. cold miss：首轮仍等待 startup，保持现有语义。
3. cached empty：立即发送且不暴露 MCP tools。
4. startup success：下一 model step 使用 live descriptor。
5. startup failure：后续 step 不再广告 cached tools，已发请求仍由 tombstone 返回 unavailable。
6. cached tool 被 live 删除：permission 前返回 unavailable，不退化为 registry `ToolNotFound`。
7. cached safe / live destructive：使用 live metadata，被 Plan mode 或 permission policy 正确拒绝。
8. cached schema v1 / live schema v2：使用 v2 校验，错误进入 tool result，session 可继续。
9. allowlist/denylist 对 cached catalog 按 session 重新应用。
10. 多个 caller 等待同一个 startup Promise，不重复连接。
11. caller abort 只取消自己的 startup waiter，不取消 session shared startup。
12. caller abort 产生 terminal `ToolCancelled` 事件；startup failure 产生 recoverable unavailable 事件。
13. preflight startup wait 不消耗 live handler execution timeout，且记录独立 waitMs。
14. `beginShutdown()` 先于 startup completion 时同步进入 CLOSED，迟到 completion 不 publish 或
    reconcile。

### Bootstrap / integration

1. Session A 成功初始化并填充 catalog。
2. Session B 使用独立 MCP PID，initialize barrier 未释放时 provider 已收到 A 的 cached schema。
3. Session B tool call 等 barrier，放行后确认调用 B 的 PID，而不是 A。
4. control-plane 成功 connect 可以 seed 后续 session；status-only 不 seed。
5. session close 继续清理自己的 stdio process tree，不影响 process catalog。
6. subagent 等待 parent live startup，只获得 connected、scope-filtered snapshot。
7. Phase 2 本地 catalog 可命中；SSH/WSL/Docker 一律 unsupported/cold，不按 path 串 catalog。
8. Phase 3 只有真实 `remoteSessionId` 已贯穿后才验证各远程代表 identity 不串 catalog。
9. adapter close、startup failure 和 timeout 继续执行现有跨平台 process tree cleanup。
10. shutdown 与 completion 竞态时 facade 仍调用一次实际 `mcpPort.close()`，coordinator 不重复持有
    cleanup ownership。

### 既有回归

- `mcp-runtime.test.ts`
- `mcp-tool-bridge.test.ts`
- `mcp.test.ts`
- `mcp-process-lifecycle.test.ts`
- `subagent-borrowed-mcp-port.test.ts`
- Plan mode MCP permission `Y01/Y02`
- MCP OAuth/status isolation `MO01-MO03`

第一版以 adapter/core/bootstrap deterministic tests 为主，不要求新增 GUI E2E。若后续增加
conversation E2E，必须先把 accepted case 回写
`docs/conversation-session-case-catalog.md` 和
`docs/testing/conversation-session-e2e-coverage-matrix.md`，再进入 manual-review/capture。

## 状态组合与剪枝

| Case ID | 状态     | 代表组合                                         | 预期                                                  |
| ------- | -------- | ------------------------------------------------ | ----------------------------------------------------- |
| `MCA01` | accepted | warm complete-hit + startup pending              | provider 立即 sampling，tool call 等 live             |
| `MCA02` | accepted | cold / expired / partial / unsupported           | 首轮等待 live，保持当前能力完整性                     |
| `MCA03` | accepted | 合法 cached empty                                | 立即 sampling，不暴露 MCP tools                       |
| `MCA04` | accepted | startup success / partial failure / cancellation | 成功项 publish + live reconcile；失败/取消不 publish  |
| `MCA05` | accepted | cached present + live missing/hidden             | tombstone 在 permission 前 recoverable unavailable    |
| `MCA06` | accepted | cached schema / annotations 与 live 不同         | live schema 校验、live metadata 审批                  |
| `MCA07` | accepted | concurrent generation + LRU eviction             | newest wins；淘汰后旧 fetch 不复活 entry              |
| `MCA08` | accepted | control-plane connect / status-only              | Phase 3 仅成功 connect seed；status-only 不 seed      |
| `MCA09` | accepted | parent / subagent                                | Phase 2 gate：child 只借用 live connected snapshot    |
| `MCA10` | accepted | local / SSH / WSL / Docker                       | Phase 2 remote cold；Phase 3 才可按完整 identity 命中 |
| `MCA11` | ignored  | HTTP/SSE/OAuth catalog                           | v1 缺规范化 auth principal identity                   |
| `MCA12` | ignored  | live server LRU / sharing                        | 用户已确认不做                                        |
| `MCA13` | accepted | shutdown / late startup completion               | CLOSED 后不 publish/reconcile；facade 仍完成 close    |

剪枝说明：

- desktop continuous vs mobile replayable：pruned 为 invariant + 一组代表回归，因为共享同一 Agent
  runtime，本功能不改变 delivery 事实。
- provider/model/thought、queue/goal/compact/fork/edit：pruned，因为不改变 MCP startup owner 或
  execution authority。
- theme/locale/responsive：pruned，因为没有 UI 改动。
- 每个具体 MCP tool：pruned 为 safe、destructive、missing、schema-drift 四类代表。

## Must-Preserve Invariants

1. 每个 session 的 live MCP client/server 继续独立。
2. cached tool catalog 不能授权执行，也不能影响 readOnly/destructive/approval 判断。
3. 实际调用只能到当前 session 的 live adapter。
4. cache hit 不能投影成 UI connected。
5. cache key 不泄漏 env、header、OAuth secret 或 token。
6. 本地隔离使用 `workspaceIdentity?.trim() || workspacePath`；远程必须同时具备
   `workspaceIdentity` 和 `remoteSessionId`；`workspacePath` 只用于执行 cwd。
7. mobile `/remote` 不创建独立 Agent、Host 或 MCP runtime。
8. desktop continuous 与 web remote replayable 不共享或扩散 delivery 状态。
9. subagent 不拥有 parent MCP lifecycle，也不从 advertisement cache 获得执行权限。
10. session close、connect failure 和 timeout 继续执行现有跨平台 stdio process tree cleanup。
11. 已发 provider contracts 中的 stale tool 在 reconcile 后仍能进入 recoverable preflight，不能提前
    变成 `ToolNotFound`。
12. coordinator 进入 CLOSED 后，任何迟到 startup completion 都不能 publish catalog 或修改 registry。

## 风险与回退

| 风险                                  | 处理                                                                |
| ------------------------------------- | ------------------------------------------------------------------- |
| stale tool 被模型调用                 | live preflight；不存在则 recoverable unavailable                    |
| stale schema 生成错误参数             | live schema 重新校验；错误返回模型                                  |
| stale annotation 导致误授权           | annotations 不缓存；permission 前解析 live entry                    |
| 旧初始化覆盖新结果                    | entry generation newest-wins                                        |
| remote workspace 串 cache             | Phase 2 禁用；Phase 3 仅完整 identity + cwd/env 才可启用            |
| env/token 泄漏                        | 只存 digest；日志只记录 opaque fingerprint                          |
| 动态 description 跨 session 过时/泄漏 | 限同 workspace identity；ephemeral config 进 key；可内部 bypass     |
| HTTP 不安全共享                       | v1 完全不缓存 HTTP/SSE                                              |
| 少量超大 schema 撑高 cache 内存       | 2 MiB entry + 16 MiB process byte guard；oversize 清旧值            |
| warm hit 后 server 长期失败仍持续广告 | terminal 后不再进入 contracts；tombstone 只承接旧响应               |
| reconcile 使旧响应变成 ToolNotFound   | 缺失项保留 provider-invisible tombstone 到 session close            |
| shutdown 后迟到 completion 回写       | beginShutdown 同步 CLOSED + abort；completion 检查 state/generation |
| cache 路径引入回归                    | 先 write-only shadow，再启用 read；内部 mode 可回退                 |

## 第一版默认决策

本规划采用以下默认值；实现评审若推翻任一项，应先更新本文和对应 case：

1. cold/partial miss 继续阻塞首轮 provider request。
2. 只允许 aggregate complete-hit 提前 sampling，不做 progressive partial tool set。
3. 只做进程内 cache，capacity 32、TTL 30 分钟，并增加 2 MiB/entry、16 MiB/process 的 serialized
   byte guard，避免少量超大 schema 撑高 cache 内存。
4. HTTP/SSE 全部不缓存，等 auth principal identity 单独设计。
5. 第一版不新增用户可见 startup 状态，只保留日志、指标和现有 live 设置页状态。

## Planning Handoff

| 交付物                    | 状态              | 说明                                                                                  |
| ------------------------- | ----------------- | ------------------------------------------------------------------------------------- |
| Feature spec              | complete          | 本文定义 warm/cold、执行安全、ownership、远端和回退边界                               |
| Feature graph             | updated           | `capability.mcp-async-tool-catalog` 及 cache/live/status/subagent/identity 关系已登记 |
| Case catalog              | planned           | 当前以 core/adapter/bootstrap 测试为主；需要 GUI conversation E2E 时先登记 `MCA*`     |
| Coverage matrix           | planned           | 与 case catalog 同步后再进入 manual-review/capture                                    |
| Fixture / replay / Docker | not-needed for v1 | 首版可用 deterministic fake MCP server 和 barrier 覆盖                                |

进入实现前没有产品语义 blocker。需要单独跟踪但不阻塞本方案的两项：

- 不做 live LRU 意味着本功能不会修复 session/runtime 未 close 导致的进程与内存增长。
- 当前普通 MCP 对 `tools/list_changed` 的消费能力若不足，v1 依赖 TTL + 每次执行 live revalidation；
  notification invalidation 放在 Phase 3。

## 参考

- `docs/mcp-platform-boundary.md`
- `docs/runtime-tools/mcp-status-list-control-plane.md`
- `docs/design/v2/mcp-stdio-process-lifecycle.md`
- `docs/mcp-oauth-client-auth.md`
- `docs/plugin-mcp-session-runtime-merge.md`
