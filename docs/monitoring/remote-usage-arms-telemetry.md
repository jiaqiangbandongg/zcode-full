# 远程工作区连接 ARMS 自定义事件埋点

> 状态：已实现，待测试环境 ARMS 验收
> 关联分支：`fix/add-arms-for-remote`
> 关联规范：[远程场景使用量埋点 V1](./remote-usage-telemetry-v1.md)（数仓 `/report` 通道；本文档是其 ARMS 通道补充，不取代 V1）

## 目标与产品问题

本埋点用于在 ARMS（阿里云 RUM）上回答两个产品问题：

1. **哪些桌面设备使用了远程工作区** —— 查询 `remote_active_session_count` 且 `custom.value > 0`，按 `device_mid` 去重。ARMS 的 `user.name` 已固定为 `device_mid`，也可直接使用用户维度检索；按 remote kind 拆分显式连接使用量时改查 `remote_connect_result`。
2. **每台桌面设备同时打开了多少个远程工作区连接** —— `remote_active_session_count` 的 `custom.value` 是当前活跃逻辑 remote workspace session 数。先按 `device_mid` 取时间范围内的 max，再对设备级 max 计算分布。

口径约定：

- 范围：**由桌面 `ConnectRemote` 发起的远程工作区连接**（SSH/WSL/Docker/Server），不把手机 Web Remote Control 的 relay、bridge 或 replayable attachment 计为新的远程连接。
- `ConnectRemote` handler 必须显式把本次 Main-local route 标记为 `remoteUsageTelemetryEligible=true`；其他内部调用默认 false。stats、gauge、disconnect 与 periodic sampling 只处理 eligible route，以机械保证范围不会随 manager 新增调用方而扩大。
- “同时远程连接数”的主口径是**活跃逻辑 session 数**，即用户同时打开的远程 workspace 数；不是物理 TCP/SSH 连接池条目数，也不是远端物理设备数。
- 用户口径：**仅 `device_mid`**（与现有 ARMS 事件一致；ARMS SDK 屏蔽 `user.id`，账号 uid 无法注入 user 字段。账号级分析继续使用 V1 数仓通道的 `user_id`）。
- 事件范围：显式桌面连接成功/失败、活跃 session gauge、断开与可观测连接时长。

## 与 V1 数仓通道的关系

|                  | V1 数仓 `/report`                 | 本文档 ARMS                                     |
| ---------------- | --------------------------------- | ----------------------------------------------- |
| 显式桌面连接终态 | `remote_workspace_connect_result` | `remote_connect_result`（触发点相同，字段超集） |
| 断开事件         | 无（V1 剪枝）                     | `remote_disconnect`                             |
| 并发 gauge       | 无（V1 剪枝）                     | `remote_active_session_count` 的 `custom.value` |
| 连接时长         | 无（V1 剪枝）                     | `remote_disconnect` 的 `custom.value`           |
| 用户标识         | `user_id`（登录时）/ `device_mid` | 仅 `device_mid`                                 |

两通道的连接结果事件**刻意不同名**：按 event name 检索（告警配置、对账、全文搜索）时避免两套字段集混淆。先例：数仓 `message_completion` ↔ ARMS `perf_ui_message_complete`。

`remote_connect_result` 描述显式桌面连接尝试的终态；“是否使用远程工作区”的 ARMS 主口径使用统一 gauge，以便同时覆盖状态变化和跨查询时间范围的周期样本。

## 架构与事件流

```text
 Renderer                Main 进程                                      Window Host (UtilityProcess)
    |                       |                                                  |
    | ConnectRemote IPC     |                                                  |
    |---------------------->| desktopMainIpcRemote.ts ConnectRemote handler    |
    |                       |--- createRemoteWorkspaceSession --------------->| 建连
    |                       |    (remoteUsageTelemetryEligible=true)           |
    |                       |<-- RemoteWorkspaceConnected ---------------------|
    |                       | handleConnected                                  |
    |                       |   route 入 map {                                  |
    |                       |     connectedAtMonotonicMs,                       |
    |                       |     connectFinalized=false,                       |
    |                       |     remoteUsageTelemetryEligible=true            |
    |                       |   }                                               |
    |<== ScopedServicePort ==| attachRendererPort                              |
    |-- ready ACK ---------->| confirm                                         |
    |                       |   -> connectFinalized=true                       |
    |                       |   -> 读 after-state stats                        |
    |                       |   -> [量①] remote_active_session_count          |
    |                       |   -> resolve                                     |
    |                       | IPC 成功返回前 -> [连①] remote_connect_result   |
    |                       | IPC 失败返回前 -> [连②] remote_connect_result   |
    |                       |   failure 不改变活跃集合，不发 gauge              |
    |                       |                                                  |
  ══ 断开路径（统一 active-set retire，不允许各路径自行拼 gate）══════════════════
    |                       | wasActive = eligible && attachable                |
    |                       |             && connectFinalized                   |
    |                       | -> 先 mark closed / delete route                  |
    |                       | -> 读 after-state stats                           |
    |                       | -> wasActive 时 [量②] remote_active_session_count |
    |                       | -> wasActive 时 [断] remote_disconnect            |
    |                       |                                                  |
    |                       | connection-closed / disposed / window-closed      |
    |                       | / host-exit / app-shutdown 共用同一 retire helper |
    |                       |                                                  |
    |                       | 每 5 分钟且 active_session_count > 0              |
    |                       |   -> [量③] periodic gauge                        |
    |                       | app shutdown: 先停 periodic timer，再 retire 全部 |
    |                       |                                                  |
  所有事件经 dispatchFinalArmsCustomEvent -> e2eController.record -> armsRum.sendCustom
```

- 远程连接权威仍在 Window Host 的 `windowRemoteConnectionRegistry`。Main 的 `routesBySessionId` 只保留已有连接的请求/session/attachment 路由；本方案只从该既有路由表派生低频 telemetry gauge，不新增 session/task/stream/queue/snapshot 业务状态。
- `remoteUsageTelemetryEligible` 只属于 Main 内存中的 telemetry 范围标记，不进入 `RemoteTarget`、Host descriptor、`workspaceIdentity`、跨进程消息或持久化数据；默认 false，只有 `ConnectRemote` handler 显式打开。
- 手机 `/remote` 仍只 attach 到桌面窗口已存在的 remote session。bridge attach/detach、手机重连和 replayable 恢复不改变 `routesBySessionId`，因此不改变 gauge。
- Main 进程拥有最终 ARMS custom-event dispatch；无需向 Host、CLI、relay 或 Web bundle 增加 reporter 或协议字段。
- 5 分钟 periodic gauge 用于覆盖“连接在查询时间范围之前建立，范围内没有状态变化”的长连接。系统休眠期间不补发历史样本，恢复后由下一次 timer 或状态变化继续采样。

## 事件定义

group：`remote_usage`。公共维度（`event_name` / `app_version` / `arms_env` / `device_mid` / `platform` / `renderer_id` / `metric_value`）由 `buildFinalArmsCustomEventPayload` 自动注入，properties 全部 `String()` 化。

ARMS Custom 表只有一个主数值度量 `custom.value`。因此连接结果用它表示计数、disconnect 用它表示时长、并发 gauge 用它表示活跃逻辑 session 数；不能直接拿字符串 property 充当并发分布的数值度量。

### `remote_connect_result`

触发点：显式 `ConnectRemote` IPC 得到成功或失败终态时（与 V1 数仓事件同一插桩点）。

| 字段              | 值                                  | 说明                            |
| ----------------- | ----------------------------------- | ------------------------------- |
| value             | `1`                                 | 显式连接尝试计数                |
| `result`          | `success` / `failure`               | 连接结果                        |
| `remote_kind`     | `ssh` / `wsl` / `docker` / `server` | 远程类型                        |
| `connect_trigger` | `new` / `reconnect` / `restore`     | 与 V1 同口径                    |
| `error_category`  | V1 七枚举；成功为空字符串           | `classifyRemoteUsageError` 产出 |

### `remote_active_session_count`

触发点：活跃 route 集合发生变化后，以及每 5 分钟的非零 periodic 采样。

| 字段                  | 值                                                                                                       | 说明                                                               |
| --------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| value                 | `active_session_count`                                                                                   | ARMS `custom.value` 数值度量；变化后的活跃逻辑 session 数，可为 0  |
| `sample_reason`       | `state-change` / `periodic`                                                                              | 状态变化或低频补点                                                 |
| `transition`          | `connected` / `connection-closed` / `disposed` / `window-closed` / `host-exit` / `app-shutdown` / `none` | periodic 使用 `none`                                               |
| `remote_kind`         | 四种 kind / 空字符串                                                                                     | 状态变化对应 route 的 kind；periodic 为空                          |
| `active_target_count` | 数字字符串                                                                                               | 脱敏 remote target identity 去重数，仅作诊断维度，不作为主并发指标 |

状态变化样本的 `renderer_id` 使用对应 route 的 `webContentsId`。telemetry 模块保存最近一次有效的 gauge `rendererId`，periodic 样本复用该值；`active_session_count > 0` 却没有最近 rendererId 在状态机上不可达，因为每个活跃 route 首次 finalize 时必先产生状态变化样本。

### `remote_disconnect`

触发点：已进入活跃集合的 route 退出集合时。必须在 route 从统计源移除/标记 closed 后读取 after-state stats；同一路由只上报一次。

| 字段                | 值                                                                                | 说明                                                     |
| ------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------- |
| value               | `duration_ms`                                                                     | 可观测连接存活时长，使用单调时钟差值并 clamp ≥ 0         |
| `remote_kind`       | 同上                                                                              |                                                          |
| `disconnect_reason` | `connection-closed` / `disposed` / `window-closed` / `host-exit` / `app-shutdown` | 见下表                                                   |
| `duration_ms`       | 数字字符串                                                                        | 与 value 相同，便于明细检索；数值聚合使用 `custom.value` |

`disconnect_reason` 语义：

| 值                  | 含义                                                                   |
| ------------------- | ---------------------------------------------------------------------- |
| `connection-closed` | 传输层异常断开（SSH keepalive 半开、网络中断、远端进程退出）           |
| `disposed`          | 用户主动释放（关 tab、取消已连接的对话框、Host 主动 dispose 防御路径） |
| `window-closed`     | 关闭窗口带走该窗口全部连接                                             |
| `host-exit`         | 窗口 Host UtilityProcess 崩溃/退出兜底                                 |
| `app-shutdown`      | 正常退出或更新安装进入 shutdown barrier                                |

时长口径：`connectedAtMonotonicMs` 在 Main 收到 `RemoteWorkspaceConnected` 时记录，默认使用 `performance.now()`；bind context / renderer reload 重挂不重置计时。正常 app shutdown 会 best effort 上报；Main 突然崩溃、kill -9 或断电仍属于右删失样本，不进入平均时长。

## 并发数与 target 口径

`getRemoteConnectionStats()`（新增于 `createRemoteWorkspaceSessionManager`）只统计 `remoteUsageTelemetryEligible && attachmentState === "attachable" && connectFinalized` 的 route：

- `active_session_count`：route 条数，即活跃逻辑 remote workspace session 数。它是“同时远程连接数”的唯一主口径；同一远端 target 打开两个 workspace = 2。
- `active_target_count`：按脱敏 target identity key 去重后的条数，仅作诊断属性。key 只存在于 Main 内存，永不上报：
  - ssh → `"ssh:" + buildSshRemoteHostKey(target)`
  - wsl → `"wsl:" + (distro?.trim() || "default") + "\0" + (user?.trim() ?? "")`
  - docker → `"docker:" + container`
  - server → `"server:" + normalizeServerRemoteUrlForComparison(url)`
- server URL 只做同安全级别协议归一：`ws:// == http://`、`wss:// == https://`；`ws:// != https://`。
- manager 是全应用单例，因此 gauge 跨窗口汇总；这不代表 Host 物理连接池跨窗口共享。
- route target 已由 Host `stripRemoteTargetSecrets` 去掉密码/token，SSH password auth 可能在 Main key 中表现为 `agent`。因此 `active_target_count` 既不是物理设备数，也不是物理 transport 数，不用于产品 KPI。

## 状态变化与幂等不变量

所有退出路径必须复用一个 atomic retire helper，不能分别判断后直接上报：

```text
wasActive = route.remoteUsageTelemetryEligible
            && route.attachmentState == attachable
            && route.connectFinalized
    |
    +-> false: 仅执行幂等清理，不发 gauge，不发 disconnect
    |
    +-> true:
          1. mark closed 或从 routesBySessionId 删除
          2. 读取 after-state stats
          3. 发 remote_active_session_count
          4. 发 remote_disconnect
```

由此保证：

- `connection-closed` 把 route 标记为 closed 后，后续 tab dispose 不重复上报。
- attach 未确认的 route 从未进入活跃集合，因此不产生 gauge/disconnect；ConnectRemote catch 负责上报 failure。
- 未显式标记 eligible 的内部 route 即使连接成功，也不进入 stats，不产生 gauge/disconnect，不更新 periodic gauge 的 rendererId。
- host exit、window close、app shutdown 任意先后到达都只会让每个活跃 route 退出一次。
- reporter/getStats/sendCustom 抛错都不能回滚 route 状态或阻断连接与清理流程。

## 隐私边界

沿用 V1 禁止清单（[remote-usage-telemetry-v1.md](./remote-usage-telemetry-v1.md)“错误分类与隐私”节）：任何事件禁止上传 `workspacePath` / `workspaceIdentity` / `remoteSessionId` / SSH host、用户名、端口 / Docker container / WSL distro / Server URL / 原始错误消息或堆栈。

上报字段只包含受控枚举、聚合计数和时长；不上传任何远端身份原文。`active_target_count` 的去重 key 只存在于 Main 内存，事件只携带聚合后的数字字符串。

## 剪枝与已知边界

- `remote_connect_result` 保持“显式桌面连接尝试”语义；并发与实际使用设备数统一从 gauge 计算。
- telemetry eligibility 默认 false，只有 `ConnectRemote` handler 显式打开；后续新增 manager 调用方不会自动进入本指标范围。
- renderer reload / bind workspace context / attachment 换代不改变 route 活跃集合，不产生状态变化事件，也不重置时长。
- 建连中取消、建连失败不产生 disconnect 或 gauge，由 `remote_connect_result failure` 覆盖。
- periodic gauge 固定 5 分钟，目标是支撑日/周窗口；小于 5 分钟且期间没有状态变化的临时查询可能需要向前扩展查询范围。
- 正常 app shutdown best effort 上报；主进程崩溃、强杀或断电无法补报 disconnect，连接时长指标必须标注为“可观测完成样本”。
- 本功能不修改 desktop `continuous` 或 mobile `replayable` 链路，不新增 conversation/session E2E，不更新 conversation case catalog/coverage matrix。

## 指标计算示例

| 指标                          | 计算                                                                          |
| ----------------------------- | ----------------------------------------------------------------------------- |
| 远程工作区使用设备数（日/周） | `remote_active_session_count` 且 `custom.value > 0`，按 `device_mid` 去重     |
| 显式连接成功设备数            | `remote_connect_result` 且 `result=success`，按 `device_mid` 去重             |
| 各显式连接类型使用设备数      | 同上按 `remote_kind` 分组                                                     |
| 每设备同时连接数峰值          | 对 `remote_active_session_count` 先按 `device_mid` 聚合 `max(custom.value)`   |
| 同时连接数峰值分布            | 对上一步的设备级 max 再计算 P50/P90/max；禁止直接对所有事件行做直方图         |
| 可观测平均连接时长            | `remote_disconnect` 的 `custom.value`；看板注明不含主进程突然终止的右删失样本 |
| 传输异常断开占比              | `disconnect_reason=connection-closed` / 全部 `remote_disconnect`              |

## 实施计划

### 状态所有权与修改文件

| 状态 / 事实                                      | Owner                                               | 文件                                                                 |
| ------------------------------------------------ | --------------------------------------------------- | -------------------------------------------------------------------- |
| ARMS payload / configure / periodic gauge / 上报 | 新模块（复用 `desktopArmsCustomEvent.ts` 最终派发） | （新）`packages/desktop/src/main/desktopRemoteUsageArmsTelemetry.ts` |
| 显式连接终态                                     | ConnectRemote IPC handler                           | `packages/desktop/src/main/desktopMainIpcRemote.ts`                  |
| route 生命周期 / atomic retire / 并发统计        | RemoteWorkspaceSessionManager                       | `packages/desktop/src/main/desktopRemoteSessions.ts`                 |
| 装配与 shutdown timer 收口                       | Main 入口                                           | `packages/desktop/src/main/index.ts`                                 |

#### 1.（新）`desktopRemoteUsageArmsTelemetry.ts`

- 常量：`REMOTE_USAGE_ARMS_GROUP = "remote_usage"`、三个 event name、`REMOTE_USAGE_GAUGE_INTERVAL_MS = 300_000`。
- 类型：`RemoteDisconnectReason`、`RemoteGaugeTransition`、`RemoteConnectionStats { activeSessionCount; activeTargetCount }`。
- 纯 builder：
  - `buildRemoteConnectResultArmsPayload(params)`
  - `buildRemoteActiveSessionCountArmsPayload(params, stats)`，`value = stats.activeSessionCount`
  - `buildRemoteDisconnectArmsPayload(params)`，`value = durationMs`
- `configureRemoteUsageArmsTelemetry({ armsCustomContext, getRemoteConnectionStats, sendCustom, e2eController?, logger, setInterval?, clearInterval? })`：模块级单例；启动 5 分钟 timer，仅在 count > 0 且已有最近 rendererId 时发送 periodic gauge。
- `reportRemoteConnectResultToArms` / `reportRemoteConnectionStateChangedToArms` / `reportRemoteDisconnectToArms`：未 configure no-op；内部 try/catch 永不抛；统一经 `dispatchFinalArmsCustomEvent` 落地。
- `stopRemoteUsageArmsPeriodicSampling()`：只停止 timer，不清空 reporter 配置；app shutdown 后续仍可发送 final gauge/disconnect。
- `resetRemoteUsageArmsTelemetryForTest()`：停止 timer并清空模块状态。
- 复用 shared 的 `RemoteUsageRemoteKind` / `RemoteWorkspaceConnectTrigger` / `RemoteUsageErrorCategory` / `RemoteUsageResult`，不新增协议或 shared runtime schema。

#### 2. `desktopRemoteSessions.ts`（canonical gauge + disconnect + stats）

- `PendingConnect` 与 `RemoteAttachmentRoute` 增加 `remoteUsageTelemetryEligible: boolean`；route 另加 `connectedAtMonotonicMs: number`、`connectFinalized: boolean`。字段放 route 顶层，避免 bindContext 替换 descriptor 时丢失。
- `createRemoteWorkspaceSession` 增加第五个 Main-local lifecycle 参数 `{ remoteUsageTelemetryEligible?: boolean }`，默认 false；该参数只写入 pending/route，不转发给 Host。
- options 增加可选 `reportRemoteConnectionStateChanged`、`reportRemoteDisconnect`、`monotonicNowMs`（测试注入，默认 `performance.now`）。只做 type-only import，避免 runtime 环依赖。
- `confirmRendererAttachmentReady` 对首次 connect 在 resolve 前设置 `connectFinalized = true`；仅 eligible route 随后上报 `transition=connected` 的 after-state gauge。bind/reattach 的 ready ACK 不重复 finalize。
- 新增统一 `retireActiveRoute(route, transition, mutate)`：先按 `eligible && attachable && connectFinalized` 捕获 `wasActive`，执行 mark/delete，再读取 stats；仅 `wasActive` 时依次上报 gauge 与 disconnect。
- `handleClosed` / `disposeRemoteWorkspaceSession` / `disposeRemoteWorkspaceSessionsForWindow` / `child.once("exit")` / `disposeAllAndWaitForAppShutdown` 全部复用 retire helper。
- app shutdown 使用 `app-shutdown`，先逐条 retire 再 clear；不能像当前实现一样直接 `routesBySessionId.clear()`。
- return 对象增加 `getRemoteConnectionStats()`。

#### 3. `desktopMainIpcRemote.ts`（显式连接结果 + configure）

- options 增加必选 `getRemoteConnectionStats: () => RemoteConnectionStats`。
- `createRemoteWorkspaceSession` option 签名增加 Main-local lifecycle 参数；`ConnectRemote` 调用时显式传 `{ remoteUsageTelemetryEligible: true }`。
- `finalArmsCustomEventE2E` 创建后调用 `configureRemoteUsageArmsTelemetry`；register 早于首窗创建，连接事件不可能早于 configure。
- `ConnectRemote` 成功/失败返回前各调用一次 `reportRemoteConnectResultToArms`。该事件不再携带并发 property；并发只来自 canonical gauge。
- reporter 外层保留 safe try/catch，保证任何埋点异常都不会把成功连接改写成失败。

#### 4. `index.ts`（装配与退出顺序）

- manager options 注入 `reportRemoteConnectionStateChangedToArms` 与 `reportRemoteDisconnectToArms`。
- `registerRemoteIpcHandlers` 注入 `getRemoteConnectionStats`。
- `prepareAppQuit` 在调用 `remoteSessionManager.disposeAllAndWaitForAppShutdown` 前同步执行 `stopRemoteUsageArmsPeriodicSampling()`；manager 随后发送 `app-shutdown` gauge/disconnect，ARMS SDK 使用现有 Host shutdown barrier 提供的时间窗口 best effort flush，实际到达率必须通过测试环境验收。

#### 5. 文档索引

- `docs/monitoring/README.md` 产品专项节加本文档索引。
- `docs/monitoring/business-monitoring.md` 引用 V1 处补充并发/时长见本文档。
- `docs/monitoring/remote-usage-telemetry-v1.md`“本期剪枝”节补注：逻辑 session 并发数与可观测连接时长由 ARMS 通道承接。
- 不登记 `performance-telemetry-catalog.md`：该文件是性能事件字典，usage 类 group 如 `plan_usage` / `send_funnel` 均不进入。

### 测试计划（先写测试再实现）

**A（新）`packages/desktop/test/desktopRemoteUsageArmsTelemetry.test.ts`**

- 三个 builder 的字段集与 `custom.value`：connect=1、gauge=active session、disconnect=duration。
- failure 缺省 `errorCategory -> unknown`；properties 不含任何 target/path/session identity。
- 未 configure 不抛不发；configure 后经真实 `createFinalArmsCustomEventE2EController` 断言公共维度与 suppress。
- fake timer：count=0 不发 periodic；count>0 每 5 分钟发一次；使用最近 rendererId；stop/reset 后不再发。
- getStats / sendCustom 抛错时吞掉并 `logger.warn`；每个 case reset 隔离。

**B（扩展）`packages/desktop/test/desktopRemoteSessions.test.ts`**

- stats：两个 eligible 的同 SSH target 逻辑 session -> session=2 / target=1；四 kind 混合去重。
- server 归一化：`ws:// == http://`、`wss:// == https://`、`ws:// != https://`。
- attach 未确认不计入、不发 gauge；首次 ready 后发一次 `connected` gauge；bind/reattach ready 不重复发。
- 未传 lifecycle 参数或显式 eligible=false 的内部连接成功后仍不进入 stats，不发 gauge；其后 disconnect/app shutdown 也不发事件。
- connection-closed 报一次；closed 后再 dispose 不重报。
- dispose / window close / host exit 分别产生对应 transition + disconnect，并断言每次 gauge 都是 after-state。
- app shutdown 逐条报 `app-shutdown`，最后一个 gauge value=0；attach 未确认 route 不报。
- callback 抛错不中断 route 清理；duration 使用注入单调时钟得到精确值。

**C（扩展）`packages/desktop/test/desktopMainIpcRemoteTelemetry.test.ts`**

- configure 被调用并透传 `getRemoteConnectionStats` / E2E controller / sendCustom。
- 显式连接成功/失败的参数与四种 remote kind；断言 `createRemoteWorkspaceSession` 收到 `remoteUsageTelemetryEligible=true`；connect-result 不再携带并发字段。
- ARMS reporter 抛错不改写 `{ success: true }` 返回值。

**D（回归）**

- `packages/desktop/test/e2eProcessCleanup.test.ts`：覆盖 index.ts shutdown barrier 装配。
- 现有 remote session / window lifecycle 单测全量回归。
- 本功能不修改 conversation 状态、V4 wire 或 replayable/continuous 边界，不新增 conversation E2E case。

### 必须完成的 ARMS 验收

E2E bridge 在 `sendCustom` 前记录 payload，只能证明客户端组装正确，不能证明 SDK flush、ARMS 入库和查询口径。因此以下测试环境验收是发布前置条件，不是可选冒烟：

1. 开启 E2E bridge 双门禁，连接两个 WSL/Docker remote workspace，断开一个，确认本地最终 payload 的 gauge 序列为 `1 -> 2 -> 1`。
2. 保持至少一个连接跨过 5 分钟，确认 periodic gauge 入库。
3. 正常退出 App，确认 `app-shutdown` disconnect 与最终 gauge 0 在 ARMS test 环境可查询。
4. 在 ARMS Custom 表验证：`custom.value` 是 number、`user.name` 与 `device_mid` 一致、设备级 `max(custom.value)` 和二阶段 P50/P90 查询结果符合预期。
5. 验证任何事件均不含禁止上传的 target/path/identity/error 原文。

若当前开发机缺少真实 WSL/Docker/SSH 环境，提交说明必须列出未完成项，且不能把 ARMS 数据口径标记为已验收。

### 实施顺序与验证

1. 本 spec 文档与二次评审。
2. 测试 A -> 实现 `desktopRemoteUsageArmsTelemetry.ts` -> 绿。
3. 测试 B -> 修改 `desktopRemoteSessions.ts` -> 绿。
4. 测试 C -> 修改 `desktopMainIpcRemote.ts` 与 `index.ts` -> 绿。
5. 更新三处文档索引。
6. 完成测试环境 ARMS 验收并记录查询口径。
7. 提交 Conventional Commit。

验证命令（仓库根目录）：

```bash
pnpm typecheck
pnpm lint
pnpm exec vitest run \
  packages/desktop/test/desktopRemoteUsageArmsTelemetry.test.ts \
  packages/desktop/test/desktopRemoteSessions.test.ts \
  packages/desktop/test/desktopMainIpcRemoteTelemetry.test.ts \
  packages/desktop/test/e2eProcessCleanup.test.ts
```
