# Helper lifecycle 不得影响 Agent runtime 规范

## 状态

- 状态：P0/P1/P2 已实现；默认装配的定时健康探测与其自动 recovery 已移除
- 日期：2026-09-02
- 最近更新：2026-09-03
- 适用范围：Desktop 本地 Host、Computer Use Helper、ZCode Agent runtime、`zcode-cua` MCP broker
- 关联问题：`ZCT-2094300783841067008`、`ZCT-2095050283542110208`
- 替代关系：本规范确认后，替代“Helper ready/recovery 必须 recycle persistent Agent”的旧约定；
  [CUA Helper 恢复期 Agent 启动准入规范](./cua-agent-recovery-admission-gate.md)中的 Agent recycle
  部分需要按本规范收敛。旧规范中的 fail-closed、进程身份校验和 spawn 代际 fence 仍然保留。
- 被替代条款（2026-09-21）：本规范 §3.1「2026-09-10 spawn 快路」与 §3.3 中「Agent spawn env
  需要决定是否可以注入当前 broker tuple」的有界探针入口，已被
  [CUA Helper 懒启动规范](./2026-09-21-cua-helper-lazy-startup-spec.md)取代——spawn env
  注入凭据不再做任何健康判定；本规范其余条款继续有效。

## 一、产品不变量

Computer Use Helper 是 CUA 的能力提供者，不是 Agent runtime 的生命周期 owner。

必须永久成立：

1. Helper 冷启动、延迟 ready、health probe 失败、权限恢复、进程重启，都不得主动终止或重启 Agent。
2. Helper 的生命周期事件不得阻塞其他模块的启动或恢复，包括模型 provider、MCP、task index、session
   hydration、对话订阅和普通 Agent turn。
3. Helper 不可用时，只降低 CUA 工具的可用性；不得让非 CUA 对话、普通 MCP 或 Agent runtime 进入
   `workspace-dispose`。
4. Agent 是否重启只能由 Agent 自身崩溃、workspace 关闭、用户显式操作或 Agent runtime 自己的恢复策略决定。
5. “Helper ready”不是“Agent 必须重新 spawn”的隐式信号。
6. Host 不得通过定时器轮询 Helper 健康状态；健康检查只能发生在 CUA 启动、解析、调用、权限确认等
   明确的按需边界，且检查失败不得触发 Agent runtime 生命周期动作。

目标状态：

```text
Helper lifecycle:  STARTING -> READY -> DEGRADED -> READY/STOPPED
                         |         |          |
                         |         |          +--> CUA tool retryable error
                         |         +-------------> CUA tool available
                         +------------------------> CUA tool waits/retries

Agent lifecycle:   STARTING -> RUNNING ------------------------------> STOPPED
                                  ^                                     ^
                                  |                                     |
                 Helper events --+-- never call disposeWorkspace ------+
```

## 二、当前问题与证据

历史实现存在两条 Helper → Agent 的反向控制链（本次 P0 已切断 Agent 回收副作用）：

```text
resolveSpawnEnv
  -> buildCuaProductHelperAgentEnv
  -> start/checkHealth Helper
  -> 可能等待或返回 BROKER_UNAVAILABLE

Helper 定时 liveness/recovery（历史路径，现已移除）
  -> resolver.restart() / reconcileRecoveredHelper()
  -> recycleUntilStable()
  -> disposeWorkspace()
  -> cleanupManagedProcessWithRetry("workspace-dispose")
  -> Agent SIGTERM + 新 Agent spawn
```

相关事实：

- Agent spawn 环节在 [node.ts](../../packages/services/src/node.ts) 中等待 Helper env 解析；
- `reconcileRecoveredHelper()` 历史上会执行 persistent-agent recycle；当前仅清理后续 spawn
  admission marker，见
  [cuaProductMcpResolver.ts](/Users/dev/zcode-cua/src/broker/server/cuaProductMcpResolver.ts)；
- `disposeWorkspace()` 最终以 `workspace-dispose` 清理 Agent，见
  [zcodeAgentProcessManager.ts](../../packages/services/src/zcode-agent/zcodeAgentProcessManager.ts)；
- 两张工单均出现 `Helper unreachable -> Helper ready -> Agent SIGTERM(workspace-dispose) -> 新 Agent`。

### 冷启动预占与恢复回收不是同一条路径

冷启动时 Host 可以先预占 socket/token，Agent 使用预占 tuple，Helper ready 后原子让渡 transport；
这条路径的设计目标是不重启 Agent。

但以下情况会落入旧的回收路径：

- Agent spawn 超过 grace 后被标记为 `BROKER_UNAVAILABLE`；
- Helper liveness watchdog 每 10 秒探测并直接调用 `resolver.restart()`；
- Helper restart 生成 fresh socket/token，旧 Agent 仍持有旧凭据；
- `reconcileRecoveredHelper()` 按 workspace registry 批量调用 `disposeWorkspace()`。

因此，单纯删除某一处 `disposeWorkspace()` 不够：P0 同时移除了 recovery callback 的 Agent 副作用，
并让普通 Helper restart 优先复用 host transport；后续 P1 继续解决 Agent spawn 的完全非阻塞与长期
稳定 facade。

## 三、规范性行为

### 3.1 Helper 启动

- 2026-09-10 spawn 快路：完整 startup 继续交给原 tracker；已有安全 `reservedTransport`
  且无 unavailable marker 时立即返回，不再先等 1s 才读取同一 tuple。Windows 仍先等待
  `transport_ready`；无预留、warm health 失败与后台启动失败保留原有准入规则。
- Helper 启动必须是 Host 内部的 detached/background 操作。
- 通用服务初始化、Agent spawn、session resume、task index 和普通 MCP 初始化不得等待 Helper
  完全 ready。
- Host 应尽早生成并占住 broker transport 的 admission tuple；生成 tuple 本身不得等待 Helper
  native backend、TCC 或完整 health probe。
- 如果 tuple 已可安全预占，Agent 可以携带该 tuple 启动；broker client 在 Helper 尚未 ready 时使用
  有界、可取消的 retry。
- 如果 tuple 暂时不可用，Agent 仍可启动，但 CUA 工具必须以 retryable `broker_not_ready` 失败；
  不得因为该状态登记一个稍后会触发 Agent recycle 的 workspace。

### 3.2 Helper ready

Helper ready 只允许完成以下动作：

- 发布当前 Helper readiness、generation、socket/transport 可用性；
- 清理 Helper 自己的 startup marker；
- 唤醒等待中的 CUA tool retry；
- 记录一次低频生命周期 telemetry。

Helper ready 禁止：

- 调用 `disposeWorkspace()`；
- 调用 `recycleUntilStable()`；
- 关闭或重建 Agent protocol client；
- 触发 session resume 作为 Helper ready 的副作用；
- 触发其他 workspace 的任何 Agent 操作。

### 3.3 按需健康检查与 Helper recovery/restart

默认产品装配不得创建周期性 Helper liveness timer，也不得因为空闲时段的一次探测失败自动调用
`resolver.restart()`。允许的健康检查入口必须由明确需求触发：

- Agent spawn env 需要决定是否可以注入当前 broker tuple；
- CUA MCP server resolve/request boundary 需要确认当前 Helper 可用；
- 用户完成权限授权，需要显式 verify/restart；
- Host 启动、关闭或收到 Helper process-exit 事件，只完成自身状态收口；不因退出事件主动 restart，
  下一次 CUA demand boundary 再按需启动/恢复。

因此，空闲期间即使 Helper 已卡死，也不会有后台定时任务主动探测或重启它；下一次 CUA 按需边界才会
执行有界 `checkHealth`，失败时只恢复 Helper 或返回 CUA-only 的 retryable/fail-closed 结果。非 CUA
模块、Agent runtime、session 和 task 状态均不参与这次恢复。

Helper recovery 必须拆成两个互不耦合的结果：

```text
Helper recovery result
  ├─ readiness: starting | ready | degraded | stopped
  ├─ helperGeneration / processIdentity
  └─ agentInvalidationRequired: false
```

本规范下 `agentInvalidationRequired` 默认恒为 `false`。Helper recovery 不得隐式触发 Agent restart。

如果 Helper 进程确实退出：

- Host 负责回收和重新验证 Helper 进程身份；
- Host broker facade 保持 Agent 侧连接契约不变；
- 当前 CUA 请求按 delivery-safety 规则返回 retryable 或 `possibly_sent`；
- 新的 CUA 请求在 Helper ready 后重试；
- 普通 Agent turn、session event、task index 和其他 MCP 继续使用原 runtime。

### 3.4 凭据与 transport

最终实现必须满足以下任一等价条件：

1. Agent 看到的是 Host lifetime 内稳定的 broker facade socket/token，Helper 只是 facade 的下游实现；
2. Agent 侧 MCP client 支持在 Helper generation 变化时原地重连，并通过 Host 获取当前有效凭据，
   不需要重启 Agent 或重建 session。

不能采用的方案：

- 只删除 Agent recycle，但仍给每次普通 Helper restart 生成全新的 socket/token；
- 让 Agent 继续持有旧 bearer token，再期望旧 MCP 连接自动获得新凭据；
- 把新 token 写入全局 Agent env、普通 MCP env、hooks 或 Bash 子进程环境。

凭据仍必须保持原有安全边界：仅注入官方 CUA MCP server，Helper 进程身份、peer、generation 和
旧进程退出证据必须继续 fail-closed 校验。

### 3.5 Helper 不可用时的 CUA 行为

CUA 工具调用按以下顺序处理：

```text
CUA tool request
  -> Host facade 有当前 Helper
       ├─ yes: 正常调用
       └─ no: bounded wait/retry
                ├─ Helper ready: 继续当前请求
                ├─ retryable timeout: 返回 broker_not_ready
                └─ possibly_sent: 禁止自动重放，交给现有安全语义
```

`broker_not_ready` 只影响该次 CUA tool call，不得升级成 `workspace-dispose`、session error 或 Agent
runtime restart。重试必须有绝对 deadline，不得在 Host 内无限后台重试。

### 3.6 CUA 插件开关的启动时门控

插件设置页将 CUA 从启用切换为禁用并完成配置提交时，该提交只写入启动配置，不触碰当前运行时：

```text
plugin disable committed
  -> persist plugin enabled=false
  -> show “已有对话需重启 ZCode 后生效”
  -> leave existing Agent/MCP/Helper untouched

next session create/resume (including the same workspace Agent process)
  -> read plugin enabled=false
  -> do not inject CUA MCP
  -> do not start or consume Helper
```

这条链路不得依赖周期 watchdog、后台 health probe 或 Agent restart。正在运行的 Agent 进程、session、
已有 CUA MCP、Helper、普通 MCP 和非 CUA 子进程保持不变；因此设置关闭后已有对话需要重启 ZCode
才能完全切换到新的启动配置。Agent 子进程可以继续按 workspace 复用，但每个新建或重新 materialize 的
session runtime 都必须重新读取插件门控；禁用后新开对话不得注入 CUA MCP，也不得因为后台仍有 Helper
就重新获得 CUA 能力。Helper 可继续驻留到 Host/App 生命周期结束，但不被新 session 消费。

## 四、边界与状态 owner

| 状态/事实 | 权威 owner | Helper 能否修改 | Agent 能否被影响 |
| --- | --- | --- | --- |
| Helper process/readiness | Host + Helper lifecycle | 是 | 只能影响 CUA tool readiness |
| Broker transport facade | Host | 是 | Agent 连接契约保持不变 |
| Agent process/runtime | Agent process manager | 否 | 仅 Agent 自身生命周期策略可修改 |
| Session messages/active turn | Agent runtime/session store | 否 | Helper 不得清空或重建 |
| Task index metadata | Host task index syncer | 否 | Helper ready 不得触发 Agent dispose |
| CUA tool retry state | CUA broker client/facade | 是 | 只影响当前 CUA 请求 |
| Desktop realtime | `desktop-continuous` attachment | 否 | 不插入 Helper 专用 replay 消息 |
| Mobile remote realtime | `web-remote-replayable` attachment | 否 | 继续走 snapshot/gap 恢复，不创建独立 Helper |

Workspace 隔离继续使用 `workspaceIdentity?.trim() || workspacePath`；Helper recovery 不能按裸
`workspacePath` 把不同 remote workspace 误认为同一 Agent。

## 五、实现分阶段

### P0：切断反向生命周期控制（止血）

- 从 Helper ready、liveness recovery 和 `reconcileRecoveredHelper` 路径移除 `disposeWorkspace` 副作用。
- `CuaProductHelperWorkspaceRegistry` 不再作为 Agent recycle 目标集合；如暂时保留，只用于 readiness
  观测和 telemetry。
- `resolveSpawnEnv` 不等待完整 Helper readiness；改为消费已预占 tuple、stable facade tuple 或立即
  返回 CUA-only 的 `broker_not_ready` 状态。
- 保留旧的 process identity、generation fence 和 fail-closed 检查，避免以“解耦”为名放行旧 token。

### P1：建立稳定 broker facade

- Host 持有稳定的 Agent-facing socket/capability；Helper 连接是可替换的 downstream。
- Helper 进程换代只更新 facade 的 downstream handle。
- facade 对 CUA 请求执行有界 retry、取消传播和 delivery-state 分类。
- 普通 Helper restart 不再 mint 一个必须通过 Agent respawn 才能消费的新 Agent-facing tuple。

### P2：删除旧的 Agent recycle 契约

- 删除 `onHelperCredentialsRotated -> recycleUntilStable -> disposeWorkspace` 的产品语义。
- 将 admission gate 限制为 Helper 自身启动/transport admission，不再阻塞 Agent spawn。
- 更新旧 recovery spec、注释、测试名和 telemetry 字段，避免“recovery 必须回收 Agent”的错误文档继续
  诱导实现。

## 六、验证矩阵

| Case | 初始状态 | 事件 | 预期结果 |
| --- | --- | --- | --- |
| HLR-01 | Helper cold-start，普通 Agent spawn | Helper 延迟 ready | Agent 立即启动；PID/runtime generation 不变 |
| HLR-02 | Helper cold-start，预占 tuple 已发布 | Helper ready | Agent 不重启；同一 CUA MCP 连接最终可用 |
| HLR-03 | Helper cold-start，tuple 暂不可用 | CUA tool request | bounded retry 或 `broker_not_ready`；不回收 Agent |
| HLR-04 | Agent 有 active CUA turn | Helper health probe 失败 | 不 restart Helper-induced Agent；当前请求按安全 delivery 状态收口 |
| HLR-05 | Agent 有普通非 CUA turn | Helper recovery | 对话继续；非 CUA MCP、model provider、task index 不受影响 |
| HLR-06 | Helper 空闲后卡死或进程退出，但没有 CUA 请求 | 等待超过历史 watchdog 周期 | 不发生定时 probe/restart 或退出事件自动 recovery；Agent PID/session 不变，下一次 CUA demand 再按需恢复 |
| HLR-07 | 多 workspace 并行 | 单一 Helper recovery | 不产生跨 workspace Agent dispose；workspace identity 隔离保持 |
| HLR-08 | Desktop continuous | Helper ready/recovery | 不注入 replayable 恢复消息，不改变 continuous cursor |
| HLR-09 | Mobile remote/replayable | Desktop Helper recovery | 手机只通过 shared-host attachment 恢复，不创建第二个 Helper/runtime |
| HLR-10 | Helper recovery 与 Agent spawn 并发 | generation 交错 | 不下发旧 tuple；也不因代际检查失败而 dispose 已运行 Agent |
| HLR-11 | Helper token/identity 校验失败 | recovery 完成 | CUA fail-closed；Agent 与普通模块继续运行 |
| HLR-12 | 用户关闭 workspace / Agent 自身崩溃 | 非 Helper 事件 | 允许既有 Agent dispose/restart 语义；不得归因于 Helper recovery |
| HLR-13 | Helper 已不可用 | 下一次 CUA resolve/spawn 边界 | 执行一次有界按需 probe/recovery；不启动周期 timer，不回收 Agent |
| HLR-14 | CUA 插件已运行且存在活动 Agent | 设置页提交禁用 | 只写启动配置；不关闭已有 CUA MCP/Helper，不重启 Agent；已有对话保持原能力，新开对话不注入 CUA MCP；提示已有对话需重启 ZCode 后生效 |

必须断言：

- Helper 生命周期日志中不得出现由 readiness/recovery 直接引起的 `workspace-dispose`；
- 同一 Agent 的 `runtimeIdentity`、session event sequence 和 active turn 不因 Helper ready 改变；
- CUA 请求失败必须携带 retryable/delivery-state 事实，不能伪装成 Agent crash；
- 非 CUA 模块启动耗时不包含 Helper 完整 health budget；
- desktop 与 mobile 的 delivery profile 不互相扩散。

## 七、观测与故障归因

新增或保留以下低频生命周期字段：

- `helperGeneration`、`helperProcessIdentity`、`readiness`；
- `agentRuntimeIdentity`（仅用于关联，不作为 Helper 的控制权）；
- `recoveryCause`：`cold-start`、`health-degraded`、`process-exit`、`permission-refresh`；
- `agentInvalidationRequired`：规范实现必须为 `false`；
- CUA request 的 `retryable`、`request_delivery_state`、`possibly_sent`。

以下现象应直接判为回归：

- Helper ready/recovery 后出现 Agent `SIGTERM`、`workspace-dispose` 或新 runtime generation；
- session resume 仅由 Helper ready 触发；
- 普通 Agent spawn 等待 Helper 完整启动；
- Helper token 进入 Agent 全局 env 或非 CUA 子进程。

## 八、Spec 变更后的实现顺序

1. 先新增/更新 service 与 producer resolver 的契约测试，锁定“Helper 事件不得 dispose Agent”。
2. 再实现 P0，确认 Agent startup/recovery 与 CUA readiness 解耦。
3. 然后实现 P1 stable broker facade；涉及 broker 协议时同步更新 producer 与 shared 类型/运行时校验。
4. 最后删除旧 recycle 语义，并更新 conversation/CUA E2E case catalog 与 coverage matrix。
5. 完成后运行 `pnpm typecheck`、`pnpm lint`、受影响 unit tests，以及 desktop CUA E2E；无法实机验证的
   平台必须在 MR 中列出风险和待补证据。

本规范不允许用“延长 Helper 等待时间”作为最终方案。等待时间只能缓解冷启动观感，不能改变 Helper
与 Agent runtime 的错误 ownership。

## 九、本次实现状态

### Todo103 整合补充：显式停止与迟到的 transport 消息

Windows Host 是 transport tuple 的唯一所有者。异常退出可保留 tuple 供按需恢复；显式 stop 则清除它。
stop 已开始但旧子进程尚未退出时，迟到的 ready/transport_ready 不得重新发布已失效 tuple，下一次冷启动必须产生新 tuple。

```text
显式 stop -> 失效当前 generation、清除 tuple -> 等待旧进程退出 -> 新 generation
                     |
                     `-> 旧 ready/transport_ready：忽略，不发布 tuple 或 health handle
```

这不新增 Agent 生命周期或同步机制，仅补齐 source 新增 tuple 缓存与现有 stop epoch 的组合边界。

- P0 已实现：`reconcileRecoveredHelper` 与普通 Helper recovery 不再调用 Agent recycle callback；Desktop
  recovery admission 不再关闭，也不再通过 `disposeWorkspace` 重建 Agent。
- macOS product Host 的普通 recovery 优先复用已验证 transport；因此 Helper 进程可重启，而既有 Agent
  继续使用同一 socket/token。
- Windows recovery 现在也复用既有 named pipe/token；Helper 进程可替换，既有 Agent 的 host-facing
  transport 不变。无已验证 handle 的 cold/fresh fallback 仍只影响后续 spawn admission，不触发 Agent
  recycle。
- P1 stable facade 已按“Host-owned facade”落地：macOS/Windows Host 在普通 recovery 中复用同一
  Agent-facing socket/token，Helper 进程仅作为可替换 downstream；broker client 继续通过现有 bounded
  warmup retry 与 delivery-state 处理 Helper 短暂退出，不需要新增独立常驻进程。
- P2 已收口：默认 services 装配不再注入 `CuaAgentAdmissionGate`，`recycleUntilStable` 与
  `onHelperCredentialsRotated` 已删除；`CuaAgentAdmissionGate` 类型仍保留为兼容导出，但不再参与
  默认 Agent spawn。
- 默认 services 装配不再启动 `startCuaHelperLivenessWatchdog`，因此不存在每 10 秒 probe 失败后自动
  `resolver.restart()` 的链路；spawn env 与 Producer resolver 中的有界 `checkHealth` 仍保留为按需检查。
- CUA 插件开关与 BUA 对齐为启动时门控：显式禁用只写配置，不处理已运行 Agent、已有 CUA MCP
  或 Helper；新 Host/Agent/App 启动时读取 disabled 后不注入 CUA MCP，也不启动 Helper。设置页需提示
  已有对话需重启 ZCode 后生效。
