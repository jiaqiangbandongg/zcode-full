# MCP 进程 ARMS 可观测性

## 状态

- 范围：Agent 内的 MCP connection pool / stdio transport、ZCode Protocol 动态通知、Host 转发和 Desktop main ARMS 上报。
- 改动层级：`commit-effect`（新增低频、旁路的运行时观测）。
- 不改变 MCP 连接、工具调用、session 回收、desktop continuous 或 mobile replayable 交付语义。

## 目标

生命周期保留三类 ARMS 事件；资源事件见下方迁移说明：

| 事件                       | 触发                                   | 回答的问题                            |
| -------------------------- | -------------------------------------- | ------------------------------------- |
| `perf_mcp_process_start`   | 正式 stdio MCP 完成连接和 `tools/list` | 每种 MCP 成功启动多少次，crash 率分母 |
| `perf_mcp_process_crash`   | 已连接的 stdio MCP 非预期退出          | 哪种 MCP 崩溃、退出特征和运行时长     |
| `perf_mcp_session_startup` | session 首次 MCP startup snapshot 收口 | 每个 session 配置、连接、进程和失败数 |

HTTP/SSE MCP 没有本地 OS 子进程，不发 process start/crash 与资源样本，但会进入
`perf_mcp_session_startup.configured_count/connected_count/failed_count`。

## 安全标识

- `mcp_source`：按运行时分发渠道分为三类：内置宿主 MCP 与 ZCode Official Marketplace
  （`zcode-plugins-official`，包含 Builtin Plugin 与 CDN Plugin）声明的 MCP 统一为
  `builtin`；Personal Source / Inline Plugin 声明的 MCP 为 `plugin`；用户、项目等普通 MCP
  配置为 `custom`。Plugin runtime namespace 只表达工具命名空间，不能单凭
  `plugin:<pluginName>:<serverName>` 推断分发渠道；Plugin loader 必须在公共配置校验之后附加
  runtime-only provenance，public config schema 不接受该字段。
- `mcp_id`：同一种 MCP 在当前安装内稳定。内置 `node_repl` 使用公开 ID
  `builtin:node_repl`；ZCode Official Marketplace Plugin 使用公开 manifest identity
  `builtin:<pluginName>:<serverKey>`；Personal Source Plugin 与用户配置 MCP 继续使用设备盐 HMAC
  后的 `plugin:<digest>` / `custom:<digest>`。公开 ID 的每个 `:` 分段只保留
  `[A-Za-z0-9._~-]`，其他 UTF-8 字节使用大写 `%HH` 编码，因此可读、可逆且不会把控制字符直接
  送入 ARMS。
- `mcp_instance_id`：每次正式 stdio 连接成功时生成的随机 ID；重连会产生新 ID。
- 除 ZCode 官方市场公开的 `<pluginName>:<serverKey>` identity 外，ARMS 禁止上传原始 server
  name；command、args、cwd、workspace identity/path、env、header、stderr 和 PID 始终禁止上传。
- 本地结构化日志同时记录 `mcp_id`、`mcp_instance_id`与原有 server name / PID，用于反查。

## 事件契约

### `perf_mcp_process_start`

- `group=stability`，`value=1`。
- 字段：`mcp_id`、`mcp_instance_id`、`mcp_source`、`mcp_isolation`、
  `runtime_surface`、`platform`、`arch`。
- 只在最终 session transport 成功连接且完成 `tools/list` 后发一次。版本协商 probe 不发。

### `perf_mcp_process_crash`

- `group=stability`，`value=1`。
- 字段：复用 start 标识，增加 `exit_code`、`signal`、`uptime_ms`、
  `affected_session_count`。
- 只对已发 start 的 stdio 实例发一次。主动 disconnect、session close、idle recycle、
  app quit/update 都不是 crash。
- MCP process crash 率：

  ```text
  distinct crash.mcp_instance_id / distinct start.mcp_instance_id
  ```

### `perf_mcp_session_startup`

- `group=stability`，`value=process_count`。
- 每个带 `session_id` 的 session lease 最多一次。
- 字段：`session_id`、`configured_count`、`connected_count`、`process_count`、
  `failed_count`、`runtime_surface`。`failed_count` 表示首次 snapshot 时未连接成功数，
  包含 `failed` / `connecting` / `untrusted` 等非 connected 状态，因此始终满足
  `configured_count = connected_count + failed_count`。
- `process_count` 是该 session 当时持有的 connected stdio MCP 连接数。workspace-shared
  MCP 在每个使用它的 session 中都计 1，不尝试把共享进程强行归属给首个 session。

### 资源事件迁移（08）

MCP CPU / 内存采样与 `perf_process_window`（`process_role=mcp`）统一见
[全进程 CPU / 内存监控埋点](./process-resource-telemetry.md)；旧事件自 v3.12.1 起停发。
以下孤儿口径只保留为 tracker 内部事实，不增加 ARMS 资源属性；旧 CLI 的 `memory` 通知在 main 丢弃。

## 疑似孤儿口径

```text
pool owner count == 0
AND 连续无 owner 时长 > 60 秒
AND OS 资源采样仍能观察到该进程
=> orphan_suspected = true
```

- 阈值是严格“超过 60 秒”；恰好 60 秒仍为 false。
- pool 现有 30 秒 idle grace 属于正常回收窗口，不会被标记。
- `protocol-settings` 等非 session lease 仍是 owner，不得因 `owner_session_count=0`
  就判定孤儿。
- 第一版只能发现仍被存活 CLI tracker 掌握的疑似孤儿。CLI 自身 crash 后
  完全脱离 tracker 的 OS 孤儿需要 Desktop/Host 系统扫描，不属于本次。

## 数据流与多端边界

```text
MCP adapter / pool
  -> process-scoped McpTelemetryTracker
  -> process/mcpTelemetry strict notification
  -> ZCodeAgentService dynamic event
  -> trusted Desktop Host relay
  -> Host parentPort strict response
  -> Desktop main ARMS sendCustom

mobile / renderer conversation attachment ---------------- X
task snapshot / queue / replay / owner command ------------ X
```

- local/remote CLI 都在真实执行机内采样；Desktop main 只负责最终 ARMS 提交。
- mobile `/remote` 复用已有 Host/CLI，不订阅、缓存或重放 MCP telemetry。
- 任何采样、schema、RPC、parentPort 或 `sendCustom` 失败都只丢弃当前事件，
  不阻塞 MCP/session/Agent 生命周期。

## Feature Impact Brief

### Feature Summary

| Field            | Value                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------- |
| Developer intent | 上报 MCP 进程启动、crash、每 session 数量；资源契约由全进程 spec 维护                 |
| Capability       | `capability.data-observability` + MCP runtime                                         |
| Change layer     | `commit-effect`                                                                       |
| Operating mode   | implemented                                                                           |
| Primary seeds    | MCP adapter/pool、Protocol notification、Agent service、Host parentPort、Desktop ARMS |
| Out of scope     | UI、MCP 连接语义、工具调用、持久化、真 OS 孤儿全局扫描                                |

### UI Surface Matrix

| User scenario   | UI entry | Shared implementation       | Display/draft owner | Default/inherit source | Validation/gating | Commit action     | Authority/persistence             | Mode boundary                       | Must remain isolated from              |
| --------------- | -------- | --------------------------- | ------------------- | ---------------------- | ----------------- | ----------------- | --------------------------------- | ----------------------------------- | -------------------------------------- |
| 线上 MCP 可观测 | none     | CLI tracker -> Host -> main | none                | 5min / 60s constants   | strict schemas    | ARMS `sendCustom` | live process/pool; no persistence | local/remote; desktop reporter only | UI、conversation stream、mobile replay |

### Feature Relationships

| Rank           | From                | Semantic edge                  | To                    | Condition      | Why inspect it               | Evidence                       |
| -------------- | ------------------- | ------------------------------ | --------------------- | -------------- | ---------------------------- | ------------------------------ |
| must-inspect   | MCP adapter         | emits lifecycle/resource facts | process tracker       | stdio          | PID/exit/memory authority    | adapter code                   |
| must-inspect   | MCP pool            | emits ownership/session counts | process tracker       | all leases     | sharing/orphan authority     | pool code                      |
| must-inspect   | CLI notification    | forwards strict facts          | Desktop main          | local/remote   | ARMS owner boundary          | CLI resource telemetry pattern |
| invariant-only | MCP telemetry       | must remain separate from      | conversation delivery | desktop/mobile | no replay/snapshot pollution | architecture docs              |
| evidence-only  | MCP/telemetry tests | covers                         | event contract        | all            | behavior proof               | focused unit/integration tests |

### State Owners And Commit Sinks

| State/fact           | Draft/display owner | Authoritative owner       | Commit command/service | Persistence/cache   | Evidence          |
| -------------------- | ------------------- | ------------------------- | ---------------------- | ------------------- | ----------------- |
| MCP process instance | none                | stdio transport + tracker | lifecycle event        | process memory only | adapter           |
| session owners       | none                | connection pool refs      | tracker owner update   | process memory only | pool              |
| ARMS payload         | none                | Desktop main reporter     | `sendCustom`           | ARMS backend        | Desktop telemetry |

### Must-Preserve Invariants

1. 采样和上报失败不影响 MCP/session/Agent。
2. 主动回收不计 crash，probe 不计 start/crash。
3. 不上传原始 MCP 名、命令、路径、凭据、stderr 或 PID。
4. workspace-shared 进程用 owner lease 计数，不伪造单一 session owner。
5. Desktop main/relay 不持有 MCP 业务状态；mobile 不重复上报。
6. ZCode Official Marketplace 的 Builtin/CDN Plugin MCP 与宿主 `node_repl` 均按
   `mcp_source=builtin` 聚合；Personal Source / Inline Plugin MCP 继续按 `plugin` 聚合，
   不能用相同的 `plugin:` runtime namespace 混淆两种渠道。

### Codegraph Evidence

当前环境无 codegraph tool，按精确 symbol 文本追踪到深度 2：

| Seed                                  | Direct callers / key path                        | Depth | Interpretation            |
| ------------------------------------- | ------------------------------------------------ | ----- | ------------------------- |
| `createMcpAdapterConnectionPool`      | protocol entrypoint -> session lease             | 2     | process tracker owner     |
| `NodeMcpAdapter.openServerConnection` | pool adapter -> stdio transport                  | 2     | start/crash/PID authority |
| `createZCodeProcessResourceSampler`   | protocol notification -> service -> Host -> main | 2     | forwarding pattern        |

### Graph Drift / Delta

- feature graph 的 `capability.data-observability` 已登记本 spec、`createMcpTelemetryTracker`
  与 `reportMcpTelemetryToArms` 两个 code seed，见
  `.agents/skills/feature-boundary-planner/references/zcode-feature-graph.yaml`。
- 当前保留三类生命周期事件；CPU / 内存采样与资源属性统一以全进程 spec 为准。
  超过 60 秒的疑似孤儿只保留为 tracker 内部事实。

## Case Planning

### Clarification Log

| Round | User answer                         | Boundary fixed                               |
| ----- | ----------------------------------- | -------------------------------------------- |
| 2     | 需要定位具体 MCP                    | 公开 ID + 匿名设备稳定 ID + 随机 instance ID |
| 3     | 加孤儿判定，稳妥按超过 60 秒        | `unowned_ms > 60_000` 且 OS 仍存活           |
| 4     | ZCode 官方市场的 MCP 都归为内置来源 | Builtin/CDN Plugin 均为 `mcp_source=builtin` |
| 5     | 内置来源 MCP 不匿名                 | 官方 Plugin 使用公开 canonical `mcp_id`      |

### Boundary Decisions

| Boundary          | Decision                                  | Includes                            | Excludes / prunes                    | Source      |
| ----------------- | ----------------------------------------- | ----------------------------------- | ------------------------------------ | ----------- |
| crash denominator | successful connected stdio instance       | start + unexpected close            | probe/connect failure/expected close | user + code |
| session count     | one first snapshot per session lease      | configured/connected/process/failed | per-server event fan-out             | user        |
| orphan            | no pool owner for >60s and still observed | tracker-only suspected orphan       | CLI-death OS sweep                   | user        |

### Accepted Cases

| Case ID      | Setup                                                    | Action                   | Assertions                                                                      | Evidence layers         | E2E status          |
| ------------ | -------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------- | ----------------------- | ------------------- |
| MCP-ARMS-001 | connected stdio final transport                          | startup completes        | one start with safe/readable or anonymous ID; probe absent                      | adapter + tracker       | focused integration |
| MCP-ARMS-002 | connected stdio instance                                 | unexpected exit          | one crash with same instance ID/code/signal/uptime                              | adapter + tracker       | focused integration |
| MCP-ARMS-003 | connected stdio instance                                 | deliberate close         | no crash                                                                        | adapter                 | unit                |
| MCP-ARMS-004 | session has stdio + HTTP + failed server                 | first snapshot           | configured/connected/process/failed counts once                                 | pool                    | unit                |
| MCP-ARMS-005 | shared stdio connection, two sessions                    | acquire/release leases   | each session process_count=1; owner count 2 -> 1                                | pool + tracker          | unit                |
| MCP-ARMS-006 | tracked process has no owners                            | sample at 60s / 60s+1ms  | false at 60s, true after 60s                                                    | tracker                 | unit                |
| MCP-ARMS-007 | valid/invalid notification and Host message              | forward                  | strict validation, local/remote only, mobile excluded                           | shared/service/Host     | unit                |
| MCP-ARMS-008 | main receives each event kind                            | report                   | exact three lifecycle ARMS names; legacy memory ignored                         | Desktop reporter        | unit                |
| MCP-ARMS-009 | ZCode 官方市场与 Personal Source Plugin 各声明 stdio MCP | discover + process start | 官方 Plugin source=builtin 且 ID 可读；Personal Source source=plugin 且 ID 匿名 | loader + pool + tracker | unit                |

GUI/conversation 产品状态不变，不新增 conversation case catalog/E2E matrix 组合。
