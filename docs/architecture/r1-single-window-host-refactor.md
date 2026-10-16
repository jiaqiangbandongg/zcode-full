# R1 窗口级单 Host 进程重构规格

## 1. 状态与范围

- 状态：实施中
- 阶段：远程架构重构 R1
- 发布方式：单版本原子切换，不保留新旧双架构
- 核心目标：每个 `BrowserWindow` 只有一个 window-scoped Local Host，由该 Host 统一承载本地服务、远程连接、窗口级任务投影和各类客户端 attachment
- 明确排除：独立 Server CLI、`sourceServerId`、Connection Profile、Transport Adapter、新的远端 wire contract、跨远程 Grouped 能力，分别留待 R2/R3/R4

本文是 R1 的实现规格。当前 Web 远控事实仍以 `docs/web-remote-control/` 下的架构、实时同步和任务命令队列文档为准；本规格完成后同步更新这些事实文档。

## 2. 决策

| 决策 | R1 结论 |
| --- | --- |
| Host 聚合边界 | Host 持有 workspace/task membership、在线/运行/等待事实和列表写路由；Renderer 只持有展示偏好 |
| 进程边界 | 每窗口唯一 Local Host；UI、手机和 Bot 不再创建独立 Remote Host |
| 端口拓扑 | 同一 Local Host 同时暴露 base port 和多个 remote-scoped port |
| 连接入口 | 保留 `IPlatformService -> Main`；Main 只做请求、状态事件和 MessagePort 薄转发 |
| Remote Host 合并 | 合并 UI、手机、Bot 创建的全部 Desktop Remote Host |
| 投影持久化 | `ControllerProjection` 仅驻内存并可从 source 重建，不增加数据库 |
| 远端协议 | 不修改现有 SSH/WSL/Docker/Server 的 zcode-server service channel |
| 列表写路由 | 跨 workspace 列表操作由 Controller 路由；进入 workspace/conversation 后继续使用 scoped facade |
| Realtime Host 身份 | 每窗口一个 `hostId`，内部按 `workspaceKey + taskId` 路由 |
| `remoteSessionId` | 由 Local Host 分配和管理；Main 只保存异步请求关联信息 |
| 断连列表 | 保留最后可信 task 投影并标记离线；禁止写和本地回落；重连后原子替换 |
| 上线与回滚 | Desktop 版本灰度；回滚旧 Desktop 版本，不做数据库或远端协议迁移 |

既有不变量：

- SSH online window cache、WSL TTL/task protection、Docker/Server dedicated session 的生命周期不变；
  只有 SSH 最后一个 pending waiter 主动取消时，允许退休尚未 ready 的 connecting entry 并中止其独占初始化。
- 身份隔离统一使用 `workspaceKey = workspaceIdentity?.trim() || workspacePath`；路径 IO 继续使用 `workspacePath`。
- Desktop `continuous` 与手机 Web `replayable` 的队列、seq、gap 和恢复边界相互隔离。
- Main 和 relay 不持有 session/task、stream、queue、snapshot 等业务状态。
- passive task-list observer 不得启动或重连远程 runtime。
- Grouped 只覆盖本地 workspace，R1 不把远程 task 加入本地 group。

## 3. 进程与职责模型

改造前：

```text
Renderer ─┬─ base port ────> Local Host ─────────> Local CLI
          ├─ remote port ──> SSH Remote Host ────> zcode-server
          ├─ remote port ──> WSL Remote Host ────> zcode-server
          └─ remote port ──> Docker/Server Host ─> remote service

Mobile -> relay/Main -> Local Host 或独立 Remote Host
Bot ---------------------> 临时 Remote Host
```

R1：

```text
Renderer ───────────────────┐
Mobile -> relay/Main ───────┼─> WindowHostRuntime（每窗口唯一 Local Host PID）
Bot/后台入口 ────────────────┘       │
                                    ├─ LocalSource -> Local CLI
                                    ├─ RemoteConnectionRegistry
                                    │    ├─ SSH pooled connection
                                    │    ├─ WSL pooled connection
                                    │    └─ Docker/Server logical connection
                                    ├─ ControllerProjection
                                    └─ AttachmentRegistry
                                         ├─ desktop-continuous
                                         └─ web-remote-replayable
```

Main 仍负责窗口和 Host 进程的创建/销毁、native API、MessageChannel 建立及消息转发，但不再拥有远程连接池、logical session、任务投影或运行任务状态。窗口关闭和 App 退出只等待唯一 Local Host；远程资源由 Host 在有界时间内释放。

## 4. Host 状态层级

```text
WindowHostRuntime
├─ LocalSource
├─ RemoteConnectionRegistry
│  ├─ ConnectionEntry
│  │  ├─ 脱敏 target
│  │  ├─ connection / service collection
│  │  ├─ readiness / lifecycle / generation
│  │  └─ logical remote sessions
│  └─ workspaceKey -> connection / session route
├─ ControllerProjection
│  ├─ workspace / connection facts
│  ├─ task-index membership / metadata
│  ├─ sessions-index live overlay
│  └─ offline snapshot retention
└─ AttachmentRegistry
   ├─ attachmentId
   ├─ trusted clientMode
   ├─ local / remote scope
   └─ 独立 subscription / seq / backpressure / dispose
```

连接状态：

```text
absent -> connecting -> online -> closing -> absent
                |          |
                v          v
             failed     disconnected
                              |
                              v
                         reconnecting
```

`reconnecting` 仅表示既有历史恢复或用户显式重连，R1 不新增后台自动重试策略。连接取消、late completion、重复 dispose 必须幂等；旧 generation 的异步结果不得覆盖新连接。

SSH pending cancel 固定使用以下边界：

```text
SSH connecting entry
        |
        +-- 仍有其他 waiter ------> 保留 entry / backend，不中断共享连接
        |
        +-- 最后 waiter 取消 ------> 按对象身份退休 entry -> abort 独占 backend/deploy
                                              |
                                              +-> 同 target 新请求创建新 entry / 使用新凭据

WSL / Docker / Server pending cancel --------> 保持既有 transport 生命周期，不触发底层 abort
SSH online cache cancel ----------------------> 保持 window cache，不销毁在线连接
```

取消期间可能已经创建 SSH 远端 owner staging。旧 backend 一旦进入 dispose barrier 不得为 cleanup
重新连接；下一次使用新 backend 的 SSH 部署会在写入前执行 best-effort janitor，只删除 ZCode 自己的
UUID staging 命名且已超过 24 小时的项。当前 owner、正式路径、WSL/Docker/Server staging 均不在本次
清理边界内。

远程断连时：

```text
online snapshot
      |
      v disconnect
offline frozen snapshot --x mutation / local fallback
      |
      v reconnect + source snapshot
atomic replacement -> online snapshot
```

- logical session 最近一次可信 task 投影保留并标记 `sourceAvailability=offline`。
- conversation/file/git/terminal 和所有写操作立即失败，不回落本地服务。
- 用户关闭对应 tab/history scope 后清理内存投影。
- App 重启不恢复该内存快照，继续遵循远程历史等待用户重连的现有语义。

## 5. Main 与 Host 控制协议

控制消息使用严格运行时 schema；所有异步请求都带 `requestId`：

- `ConnectRemoteWorkspace`
- `CancelRemoteWorkspaceConnect`
- `BindRemoteWorkspaceContext`
- `DisposeRemoteWorkspaceSession`
- `AttachServicePort`
- `RemoteWorkspaceConnectionLog`
- `RemoteWorkspaceConnected`
- `RemoteWorkspaceConnectFailed`
- `RemoteWorkspaceClosed`

Local Host 在连接流程中分配 `remoteSessionId` 并返回 descriptor。Main 仅以 `windowId + requestId` 关联调用方，收到完成/失败/关闭事件后转发，不用 `remoteSessionId` 建立连接池或业务生命周期。

远程连接进度由 Local Host 通过 `RemoteWorkspaceConnectionLog` 结构化上报，至少包含 `requestId`、`level` 和 `message`。Main 只把日志转发给该 `windowId + requestId` 对应的 renderer；不得再根据 Host 进程 label 或未带请求上下文的 stdout 猜测归属。这样同一个窗口 Host 并发连接多个远端目标时，日志也不会串到其他连接对话框。

Attachment scope：

```ts
type WindowHostAttachmentScope =
  | { kind: "local" }
  | {
      kind: "remote";
      remoteSessionId: string;
      workspacePath: string;
      workspaceIdentity: string;
    };
```

Host 必须校验 scope 中的 session、identity、path 和当前 registry generation。远程 scope 缺少 identity、引用已释放/旧 generation 或跨 logical session 时 fail-closed。

R1 完成后删除旧初始化协议及职责：

- `InitRemote`
- `InitRemoteWorkspace`
- `InitRemoteSshHost`
- `InitRemoteWslHost`
- Main 驱动的 WSL acquire/release
- Remote Host process map、pool 和独立 shutdown barrier

## 6. Scoped attachment 与可信客户端模式

```text
Desktop renderer port
  attachment context = desktop-continuous
       |
       +--> local scope 或 remote scope --> scoped facade

Mobile relay port
  attachment context = web-remote-replayable
       |
       +--> local scope 或 remote scope --> scoped facade
```

- 调用方 payload 内的 `clientMode`/`deliveryKind` 一律清除，由 Host 根据可信 attachment context 注入。
- 每个 port 独立维护订阅、seq、背压和 dispose；手机慢消费不得阻塞桌面实时链路。
- attachment 断开只释放 attachment 自身；仍有 workspace tab、手机 owner、Bot 或其他 attachment 使用时不得销毁连接。
- Renderer reload 只重建 attachment，复用原 Local Host、registry 和 logical sessions。
- `remoteSessionId` 只用于窗口内 source 路由，不替代 `workspaceIdentity`。

远程目录从连接根目录绑定到 canonical workspace 时，desktop attachment 必须采用两阶段切换：

```text
旧 attachment A（renderer 已注册）
        |
        v
Host 绑定 canonical context，按新 generation 失效 A
        |
        v
Main 创建候选 attachment B，并把 port 投递给 renderer
        |
        v
renderer 注册 B 的 services，并回传 attachment-ready(B)
        |
        v
Main 提升 B 为当前 renderer attachment
        |
        v
BindRemoteWorkspaceContext IPC 返回；调用方重新读取 B 的 services
```

- `BindRemoteWorkspaceContext` 的 renderer 可见完成语义不是“Main 已投递 port”，而是“renderer 已注册新 port”。
- Host generation 换代继续 fail-closed，允许 A 到 B 之间存在有界不可用窗口；调用方不得在 bind 返回前继续向 A 发起 RPC。
- B 投递失败、ready 超时或收到过期 ACK 时不得把 B 提升为当前 attachment；失败流程回收候选 B，再由连接、绑定或 reload 调用方按既有策略释放或重试该 logical session。
- ready 后调用方不得继续使用 bind 前捕获的 A services，必须按相同 `remoteSessionId` 从 renderer session store 重新读取 B。
- attachment 换代只改变 desktop `desktop-continuous` port，不创建新 Host、远程连接或 Agent，也不触碰手机/Bot 的 `web-remote-replayable` attachment。

## 7. Controller 投影协议

窗口级 V4 topic：

- `controller/workspaces`
- `controller/tasks-index`

两个 topic 均提供 `subscribe` / `unsubscribe`、`snapshot` / `delta`、`seq + logEpoch` 和 gap 检测后的 resync。

```text
task-index（membership 左表）
             |
             +-- sessions-index live overlay
             |
             +-- source availability
             v
        controller task row
```

`ControllerProjection` 只保存 workspace/connection facts、task membership/meta、live overlay 和离线摘要；不保存 conversation rows、stream、permission payload、tool payload 或 runtime snapshot。

Host Controller 为每个 source 维护一个 `runtimePolicy: existing-only` 的被动
`sessions-index` 订阅，把 title、phase、pending-interaction 和 activity 摘要作为内存 live overlay
合并到 task-index membership；live 状态不写回 SQLite，避免进程退出后遗留伪 running 状态。
订阅只观察已经存在的 runtime，不能因打开列表启动本地 Agent、创建远程 runtime 或触发远程重连。
runtime 不可用或换代时清理该 source 的 live overlay，重新收到 snapshot 后原子替换。

Renderer 对 `controller/workspaces` 与 `controller/tasks-index` 各只保持一个窗口级共享订阅。
同一投影 revision、同一查询参数的 `listTaskList` 请求必须 single-flight 并复用结果，禁止每个
`useGlobalTaskList` 调用点独立订阅并在同一 frame 上重复全量读取。

共享订阅的失效粒度必须落到 query，而不是任意 Controller frame 到达后清空全部列表缓存：

- `controller/tasks-index` snapshot、gap resync 或无法识别旧 row 的 delta 可以保守失效相关 scope；
- 已知旧/新 row 的 upsert/remove 只失效 workspace scope 命中，且 `kind` 与变更前后 membership
  相交的查询；例如 timeline task 的 live/activity 变化不得连带刷新 pinned/archived；
- `controller/workspaces` 只维护 workspace facts/cursor，不直接失效 task list。source 上下线、移除、
  重连对列表可见 row 的影响必须同步发布 `controller/tasks-index` delta；
- 手动 refresh 与兼容期的 legacy task-list version 仍可强制绕过 query cache；
- 同一个 renderer 调度周期内连续到达的相关 delta 可以有界合并，但不得用无上限 debounce 延迟
  desktop continuous 列表状态。

```text
controller/tasks-index delta
          |
          v
  命中 workspace scope? -- 否 --> 保留该 query cache
          |
         是
          v
     已知旧 row? -- 否 --> 保守失效该 scope 的全部 kind
          |
         是
          v
旧 membership kind ∪ 新 membership kind
          |
          v
只失效相交的 query cache --> 同一调度周期合并一次 renderer revision
```

任务地址：

```ts
interface WindowHostTaskAddress {
  remoteSessionId?: string;
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}
```

读取范围：

- Timeline、Pinned、Archived、Active、Search 聚合当前本地和已连接/暂时离线的远程 scope。
- Search 只向在线 source 发起查询；离线 source 只能展示已有摘要，不伪造新搜索结果。
- Grouped 继续使用本地 task index 的 membership/order，只消费 Controller 提供的本地 task facts。
- WSL 连接仍按 distro/user 在窗口内复用；logical session 关闭只释放对应 workspace runtime。
  有运行中 task 时 release 延迟到计数归零，快速重开通过 workspace generation 使未开始的旧
  release 失效，已经在途的 release 完成前新 attachment 在 Host 内等待。

列表来源写操作由 Controller 解析唯一 source 后执行：pin/unpin、archive/unarchive、delete/restore、mark read/unread、本地 grouped membership/order，以及从列表打开/恢复任务。离线、identity 不匹配或地址不唯一时明确失败，不尝试本地 fallback。

跨 workspace 的列表操作不得复用发起组件渲染时捕获的 ambient scoped facade。目标是本地 workspace
时从窗口 base attachment 发起，由 Controller 解析唯一 local source；目标是 remote workspace 时必须
使用目标 tab 的精确 `remoteSessionId` attachment。目标 remote 已断开时失败并回滚乐观状态，禁止按
相同 `workspacePath` 回退到 base/local 或其他 remote attachment。

```text
Renderer（可能仍捕获旧 remote ambient facade）
          |
          v
先激活目标 tab，读取 workspaceIdentity + remoteSessionId
          |
          +-- local target  --> window base attachment --> Controller 唯一 local source
          |
          +-- remote target --> exact remoteSessionId attachment --> 对应 remote source
                                  |
                                  +-- session 已断开 --> 回滚，不 fallback
```

进入 workspace/conversation 后，文件、Git、终端、Agent/session 等仍通过已验证的 scoped facade 访问，不扩展为显式 Controller 路由。

## 8. Realtime 边界

- 一个 WindowHostRuntime 只注册一个 realtime `hostId`。
- owner/lease/stale-run/session route 继续按 `workspaceKey + taskId` 隔离；不能因为 shared-host 合并而删除 owner 判定。
- Desktop 保持 direct continuous；不拼接 replayable 运行态恢复消息。
- 手机 Web 必须经过 replayable gap/snapshot 恢复边界，不能绕过恢复直接消费 desktop continuous。
- 远程 workspace 的 bridge、snapshot、queue、owner command、缓存和去重 key 必须携带 `workspaceIdentity` 与 `remoteSessionId`。
- 桌面与手机已提交的 busy/running 输入统一进入 CLI/runtime `CommandInbox`；FIFO 以 CLI 串行
  admission 顺序为准。Renderer 只保留未提交草稿和 pending optimistic overlay，Host 的
  owner/lease 只负责路由，不保存第二份 accepted input queue。

## 9. 远端 RPC 兼容层

R1 以 `LegacyRemoteWorkspaceRpcContract` 对现有远端 service channel 做类型封装和 channel 完整性校验，但不增加握手、版本协商、远端部署要求或持久化字段。

- file、Git、terminal、Agent/session 由远端权威提供。
- Desktop app-global service 由本地权威提供。
- SSH window cache、WSL TTL/running-task protection、Docker/Server dedicated logical session 的生命周期语义不变；
  SSH pending connect 的最后 waiter 取消是唯一新增的底层 abort 边界。

## 10. 实施切片

1. 规格、feature graph、conversation case catalog 和 coverage matrix 先行，并采集 PID、连接复用、reload、手机 attachment、task-list 基线。
2. 先写控制协议、registry、scoped attachment、投影、断连/恢复契约测试。
3. 把远程连接、logical session 和 generation 生命周期迁入 WindowHostRuntime。
4. Main 收敛为请求、事件和 MessagePort 薄转发。
5. base、remote、手机和 Bot 统一为同一 Host 的 scoped attachment。
6. Host 聚合任务事实和列表写路由；Renderer 改为窗口投影消费者。
7. 删除旧 Remote Host 架构，补齐日志、事实文档、全量门禁和代表链路 E2E。

## 11. 接受用例与剪枝

接受用例登记在 `docs/conversation-session-case-catalog.md` 的 R1H 组，覆盖矩阵登记在 `docs/testing/conversation-session-e2e-coverage-matrix.md`。

已确认的 E2E 剪枝：SSH 覆盖完整代表链路；双窗口和 Renderer reload 单独覆盖；WSL、Docker、Server 的 transport 差异主要由契约/集成测试覆盖并做平台 smoke。手机 attachment 和 Bot 复用必须覆盖“不会创建额外 Host/Agent”的断言。Grouped 只验证本地-only 语义未扩张。

门禁顺序：定向测试、`pnpm test:unit`、conversation coverage audit、Desktop E2E typecheck、`pnpm typecheck`、`pnpm lint`、Electron 代表 E2E、container conversation E2E、平台 smoke，以及改造前后 PID/连接数/任务列表/路由/退出残留对比。

## 12. 可观测性与退出

- Process Monitor 和生命周期日志展示窗口 Host PID、connection、logical session、attachment 数量。
- 进程、session、连接、端口的启动/关闭使用生产 `info`；可恢复异常使用 `warn`；不可恢复握手/进程错误使用 `error`。
- V4 frame、stream delta、tool update 等与消息流同数量级的逐条信息只能使用 `debug`。
- 窗口关闭/App 退出必须有界释放连接、端口和 Agent；一个 remote connection 失败或关闭不能影响 local 或其他 remote。
