# 窗口级 WSL Remote Host 共享与资源生命周期设计

## 实施状态

阶段 1、阶段 2 已在 `fix/wsl-remote-process-cleanup` 完成；阶段 3 已完成本次范围内的自动化验证与
真实 Windows + Ubuntu WSL PID 验证。运行证据见
`docs/testing/wsl-host-pooling-runtime-evidence.md`。

真实环境已验证同窗口同 distro/user 的 1、3、5 个 logical workspace 只保留一个 Windows remote
Host 和一个 WSL `zcode-server`；最后 owner 释放后按约 60 秒 idle TTL 回收，整个 App 正常关闭时
跳过 TTL，并在约 4 秒的采样窗口内完成 Host/server 回收。task draining、mobile attachment 和 Docker
dedicated 边界由自动化测试覆盖，尚未执行真实 task、真实手机和更新安装运行态注入。

## 审核修正：Active Run 权威边界

初版实现把 `sendPrompt()` Promise 的 pending 区间当作 workspace running task。该边界不成立：
`sendPrompt()` 返回的是命令 ACK，模型输出和工具执行仍可继续。ACK 后把 workspace count 降到 0，
会让关闭 tab 立即执行 `disposeWorkspace()`，中断尚未结束的 Agent run。

候选边界如下：

```text
send ACK       → 仅说明命令已接收；禁止作为 idle/release 边界
turn terminal  → stream 已收口；Agent active lock 仍可能未释放
session ready  → prompt_completed / prompt_failed，Agent 已释放 active lock
```

本设计选择 `session ready` 作为 active run 的完成边界：

```text
sendPrompt(taskId, traceId)
  → 先订阅 task ready event
  → workspace activeRun(taskId)=true
  → 上报 workspace count 与派生的 Host aggregate count
  → send ACK（不改变 count）
  → session ready
     → activeRun(taskId)=false
     → 更新 workspace/Host count
     → 若 workspace 正在 pending release，则执行 release
```

- 一个 task/session 同时最多拥有一个 active run；重复 begin 必须幂等。
- ACK 失败且 run 未开始时立即撤销计数和 ready 订阅。
- ready 事件早于 ACK continuation 时仍必须正确收口，不得被 ACK 后续重新标记 running。
- workspace count 是权威状态；Host aggregate count 从所有 workspace active run 派生，不再维护第二套
  `runningPromptCount`。
- task meta 不存在时不得伪造 workspace identity；保留短暂 RPC in-flight fallback 只用于退出诊断，
  不参与 workspace release 裁决。
- 若后续确认 session ready 后仍有必须保活的 background work，background handle 必须作为独立 owner
  接入同一 tracker，不能重新退回 Promise pending 计数。

### Shared Host 代理状态清理

`taskMetaById` 与 workspace event subscription 属于 Desktop Host 代理层，远端
`disposeWorkspace()` 不会自动清理它们。`ReleaseRemoteWorkspace` 完成时必须：

- 删除 `workspaceKey` 对应的全部 task meta。
- 保存并 dispose `onDynamicWorkspaceEvent` 返回的订阅 Disposable。
- 删除 workspace subscription 记录，保证未来重新 attach 时可以重新订阅。
- 清理该 workspace 已收口的 tracker 状态；active run 存在时 release 仍需延迟。

### 回归测试

- `sendPrompt` ACK 已返回、session 尚未 ready 时关闭 workspace：不得调用
  `releaseWorkspacePreparation()`。
- ready 到达后：pending release 恰好执行一次。
- ready 先于 ACK continuation：计数最终为 0，不残留 active run。
- 两个 workspace 并行 run：workspace count 独立，Host aggregate 为两者之和。
- workspace release 后对应 task meta、workspace subscription 和 listener 全部清理；重新 attach 可重新订阅。

## Feature Summary

| Field | Value |
| --- | --- |
| Change | 将 Desktop WSL remote workspace 从“一 workspace 一套 Host/server”调整为“同一窗口、同一 distro、同一 Linux user 共享一套 Host/server”，并补齐 workspace runtime 回收、连接并发控制和退出屏障。 |
| Primary goal | 多个 WSL workspace 并行使用时，减少重复 UtilityProcess Host、`wsl.exe` 启动和 `zcode-server` 常驻内存，同时保持 workspace、桌面与手机远控边界。 |
| User-visible surfaces | WSL 连接、远程目录选择、remote workspace tab、关闭 workspace、真实关窗、App 退出、更新安装、Renderer reload、手机 `/remote` attachment。 |
| Pool scope | 当前产品虽然限制单窗口，pool identity 仍显式包含 `windowWebContentsId`；不跨 Electron 窗口共享。 |
| Idle policy | 最后一个有效 workspace 引用和 draining task 消失后进入 60 秒 idle TTL；真实关窗、App 退出和更新安装跳过 TTL，立即执行有界回收。 |
| Existing docs | `docs/wsl-remote-workspace-design.md`、`docs/remote/wsl-remote-realtime-boundary.md`、`docs/superpowers/specs/2026-07-19-wsl-remote-process-cleanup-design.md`、`docs/superpowers/specs/2026-07-13-window-scoped-ssh-remote-host-pooling-design.md`、`docs/architecture/zcode-code-architecture-overview.md`。 |
| Main code owners | `packages/desktop/src/main/desktopRemoteSessions.ts`、`packages/desktop/src/host/index.ts`、`packages/desktop/src/host/remoteWorkspaceServiceCollection.ts`、`packages/server/src/remote/wsl-backend.ts`、`packages/server/src/remote/connect.ts`、`packages/services/src/zcode-agent/zcodeAgentProcessManager.ts`。 |

## 背景与已验证事实

当前 WSL、Docker 和 server remote 使用 dedicated Host；只有 SSH 使用窗口级 Host pool。同一 WSL distro
打开多个 workspace 时，每个逻辑 session 都会创建一个 UtilityProcess Host，并通过独立 `wsl.exe` stdio
连接启动一个独立 `zcode-server`。

```text
当前：同一 distro 的三个 WSL workspace

Desktop Main
├─ Host A ─ wsl.exe ─ zcode-server A ─ Agent(workspaceKey A)
├─ Host B ─ wsl.exe ─ zcode-server B ─ Agent(workspaceKey B)
└─ Host C ─ wsl.exe ─ zcode-server C ─ Agent(workspaceKey C)
```

运行态测量中，三个完成握手但尚未启动实际 task 的 `zcode-server` RSS 约为 165 MB、156 MB 和
164 MB，总计约 485 MB。该数字不包含 Windows UtilityProcess Host、按 workspace 启动的 Agent 及
按需启动的 MCP 进程，因此只能作为当前重复 server 基线，不能写成固定产品预算。

以下事实限定本设计：

- 远端 `createLocalServices()` 和 `ZCodeAgentProcessManager` 已能在一个 server 内按 `workspaceKey`
  管理多个 workspace。
- Agent 主要按 workspace 管理，不是“一 conversation 一 Agent”；一个 workspace Agent 可以承载多个
  session。
- MCP 子进程按配置和使用情况启动，不假定空闲 server 必然存在 MCP 进程树。
- server deploy 已有版本匹配检查；正常命中版本时会跳过大文件上传，但首次安装或版本升级仍可能被多个
  backend 并发执行。
- `WSLBackend.resolveInfoPromise` 只在单 backend 内缓存；不同 dedicated backend 仍重复执行 availability、
  distro 列表和 home 探测。
- UI 已调用 `releaseWorkspacePreparation()` 表达“workspace 不再需要预热 runtime”，但当前 adapter 实现为空，
  无法形成 workspace 级资源回收闭环。
- 普通桌面 WSL 必须保持 `desktop-continuous`，不得为了共享 Host 注册手机 replayable 使用的
  `relay_bridge`。
- 已有进程清理设计规定真实关窗、App 退出和更新安装统一回收 Host，并禁止调用
  `wsl --terminate` / `wsl --shutdown`。

## 问题定义

本问题不是单纯的 `wsl.exe` 启动次数过多，而是 Host owner、logical session、workspace runtime 三种生命周期
当前被绑成一层：

```text
当前耦合

remoteSessionId 关闭
  = RPC port 关闭
  = 整个 UtilityProcess Host 关闭
  = WSL server connection 关闭
  = 该 server 内全部 workspace runtime 关闭
```

dedicated 模型的优点是简单和故障隔离，但同一 distro/user 的多个 workspace 无法复用本来已支持多 workspace
的远端服务图。仅增加探测缓存或连接节流不能消除重复 server 的主要常驻成本；直接复制 SSH pool 又会让零引用
workspace Agent 长期留到窗口关闭，形成另一种资源滞留。

因此本设计必须同时解决：

1. Host/server 级共享。
2. logical session 独立 attach/detach。
3. workspace Agent/runtime 独立释放。
4. 零引用 Host 的 idle 回收。
5. 首次连接、探测和 deploy 的 single-flight 与竞态。
6. 关窗/App 退出/更新安装的高优先级确定性回收。

## 目标

- 同一窗口、同一规范化 distro、同一 Linux user 的 WSL workspace 共享一个 UtilityProcess Host、一条
  `wsl.exe` stdio server connection 和一个 `zcode-server`。
- 每个 workspace 保持独立 `remoteSessionId`、`attachmentId`、`workspaceIdentity`、`workspaceKey` 和
  Renderer RPC port。
- 关闭单个 workspace 时只 detach logical session；当 workspace 无桌面/手机引用且没有运行 task 时，释放该
  workspace 的 Agent/preparation runtime。
- workspace 最后引用关闭但 task 仍运行时进入 draining；task 到达 terminal state 后再释放 runtime。
- 整个 pool 零引用且无 draining workspace 后进入 60 秒 idle TTL；TTL 内重新连接复用 Host，TTL 到期释放
  Host/server。
- 真实关窗、App 退出和更新安装取消 TTL、停止新 attach，并立即进入现有有界 shutdown barrier。
- 同 pool 的并发连接、环境探测和 deploy 不重复执行；首次安装/版本升级不会竞争固定 staging 文件。
- 保持 Desktop continuous、手机 replayable、owner/lease、workspace identity 和 task command queue 语义。
- 为 1、3、5 个 WSL workspace 留下 PID、RSS、连接耗时和关闭回收的真实 Windows + WSL 证据。

## 非目标

- 不跨 Electron 窗口或跨 Desktop App 实例共享 Host。
- 不把 `zcode-server` 改成监听 TCP/Unix socket 的常驻 daemon。
- 不调用 `wsl --terminate` 或 `wsl --shutdown`，不停止整个 distro。
- 不按进程名扫描或清理用户进程，不扩大 owner registry 的既有边界。
- 不把 Docker backend 改成 shared pool；Docker container 的 owner 和隔离语义另行设计。
- 不改变 SSH pool 的缓存策略。
- 不新增 UI、设置项或用户可配置 TTL；本期 TTL 固定为 60 秒并通过内部常量测试。
- 不把 task、stream、queue、snapshot、permission 或 elicitation 状态下沉到 Desktop Main。
- 不改变 App 与 Agent 的 `@zcode/protocol`，除非实施时证明现有 service RPC 无法表达 workspace runtime
  release；若必须修改，需单独更新协议 spec 和 runtime schema。
- 不承诺 WSL distro 在 ZCode 退出后显示 `Stopped`；验收对象是 ZCode-owned Host、server 和 Agent。

## Clarification Log

| Round | Question | Decision | Boundary fixed |
| --- | --- | --- | --- |
| 1 | 是否拆成多份 spec？ | 只写一份综合 spec，在文内描述分阶段实施。 | 一个目标设计、一份验收标准。 |
| 2 | 最后引用关闭后是否立即释放 Host？ | 零引用后保留 60 秒 idle TTL，前提是生命周期可单点管理且不引入新竞态。 | TTL 由 Main pool entry 唯一持有。 |
| 3 | TTL 期间 App 退出如何处理？ | App 退出、真实关窗和更新安装立即取消 TTL 并释放。 | owner teardown 优先于缓存。 |
| 4 | pool 是否跨窗口？ | 不跨窗口；当前单窗口限制进一步降低实现风险。 | key 仍包含 `windowWebContentsId`。 |
| 5 | 最后 workspace 关闭但 task 仍运行如何处理？ | 保持 runtime draining，task 完成后释放；App 级 teardown 不等待自然完成。 | UI detach 与 runtime owner 生命周期分离。 |
| 6 | 总体方案 | 采用窗口级 WSL shared pool。 | 不采用仅 quick wins 或 App daemon。 |

## 方案比较

### 方案 A：窗口级 WSL shared pool（采用）

在 Desktop Main 中将 WSL Host 与 logical session 分离，复用现有 `AttachServicePort` 和远端多 workspace
service graph。

优点：

- 直接消除同窗口同 distro/user 的重复 Host/server。
- 不引入远端监听端口和 daemon 安全模型。
- 与当前单窗口产品限制一致，故障域明确。
- 可保持 `remoteSessionId` 和 Renderer API 外部语义。

代价：

- Main 需要维护 pool、attachment、idle timer 和连接 single-flight。
- 必须新增 workspace runtime release 的真实实现。
- 共享故障会影响同 pool 的全部 workspace，需要明确广播和恢复语义。

### 方案 B：保持 dedicated，只做缓存与节流（不采用为最终方案）

它可作为方案 A 的前置阶段，但不能消除重复 `zcode-server` 和本地 Host service graph 的常驻成本，因此不能
作为本 feature 的完成状态。

### 方案 C：App 全局 WSL daemon/pool（不采用）

跨窗口或跨 App 实例共享能进一步减少资源，但需要持久化 owner、远端鉴权、版本升级、跨窗口权限和 daemon
孤儿治理。当前产品只允许单窗口，没有必要承担这组复杂度。

## 进程拓扑与组件职责

```text
Desktop Main（生命周期 owner）
└─ Window-scoped WSL Host Pool
   key = windowWebContentsId + canonicalDistro + linuxUser
   │
   ├─ Remote Host UtilityProcess
   │  ├─ local remote-workspace service wrappers
   │  ├─ attachment registry
   │  └─ workspace lifecycle coordinator
   │
   └─ WSLBackend / wsl.exe stdio connection
      └─ one zcode-server
         ├─ workspaceKey A → Agent runtime A
         ├─ workspaceKey B → Agent runtime B
         └─ workspaceKey C → Agent runtime C
```

### Desktop Main

Main 只管理进程、logical session 和 attachment 生命周期：

- 计算 `poolKey` 并 get-or-create Host。
- 对同一 pool 的连接执行 single-flight。
- 为每个 `remoteSessionId` 创建独立 attachment。
- 从 logical session 和 mobile attachment 派生 workspace/pool 引用。
- 管理每个 Host 唯一的 60 秒 idle timer。
- 在窗口/App/update teardown 时取消 timer 并进入 shutdown barrier。
- Host 异常退出时通知全部关联 logical session，但不保存 task 业务状态。

将 WSL pool 从已经较大的 `desktopRemoteSessions.ts` 抽到
`packages/desktop/src/main/remoteWslHostPool.ts`；该文件只负责 pool state machine、single-flight、idle timer
和 Host dispose，不负责 IPC 参数解析或 UI 通知。

### Remote Host

Remote Host 持有一个共享 `activeServices`，通过多个 `AttachServicePort` 暴露给 logical session。它负责：

- attachment 注册、重复 attach 防护和 detach。
- attachment 到 workspace context 的绑定。
- workspace 引用归零后的 Agent/preparation release 请求。
- task running/terminal 生命周期与 draining workspace 协调。
- Host shutdown 时停止新 attachment 并按阶段释放全部 service/connection。

### WSL backend / connect layer

- 一个 pool Host 只创建一个 `WSLBackend`。
- `resolvedInfoPromise` 继续保证 backend 内 single-flight。
- Main/Host 上层对同 pool 的 `connectRemote()` 只允许一个 in-flight Promise。
- backend 只回收自己明确创建的 Windows child，继续以 stdin EOF 为正常 server 退出路径。

### Remote zcode-server / services

- 继续由一个 `createLocalServices()` 服务多个 workspace。
- `ZCodeAgentProcessManager` 继续按 `workspaceKey` 隔离 Agent。
- 实现可等待且幂等的 workspace preparation/runtime release；不得只关闭 Renderer port 而遗留 Agent。
- runtime release 不删除 task/session 持久数据，只释放进程和可重建的内存态资源。

## Identity Model

### Pool identity

```text
poolKey = encode(
  windowWebContentsId,
  canonicalDistro,
  linuxUser
)
```

规则：

- `windowWebContentsId` 必须存在，即使当前产品只有一个窗口，也不得省略。
- distro trim 后按 WSL 返回的 canonical distribution name 建 key；不能仅依赖 UI display label。
- Linux user 必须是 backend 实际生效的 user。未显式填写 user 时，应在建连探测完成后得到 resolved user，
  并将 provisional connect key 安全归并到 resolved pool key。
- 不把 `$HOME` 作为 user identity；home 目录可以被自定义。
- `workspacePath`、`workspaceIdentity`、`remoteSessionId`、server asset version 不进入 pool key。
- 不把 secret、环境变量内容或完整 command 写入 key 或日志。

连接开始前 distro/user 可能使用默认值，因此 acquisition 与最终 identity 分两层：

```text
connectKey = windowWebContentsId
  + normalizedRequestedDistroOrDefaultSentinel
  + normalizedRequestedUserOrDefaultSentinel

resolvedPoolKey = windowWebContentsId
  + canonicalDistro
  + resolvedLinuxUser
```

- `connectKey` 只用于首次 resolve 前的 waiter single-flight，不能作为 ready Host 的长期 identity。
- 同一个 `connectKey` 同时最多启动一个 Host，避免多个默认 distro/user 请求在 resolve 前重复建连。
- Host resolve 后原子注册 `resolvedPoolKey`，同时保留 `connectKey → resolvedPoolKey` 的进程内 alias，直到 Host
  disposed 或 WSL discovery cache 失效。
- 若另一个 ready Host 已占用同一 `resolvedPoolKey`，新 Host 不发布 attachment；waiter 转移到既有 Host，新 Host
  进入 dispose。该冲突路径必须有单元测试。
- 显式 distro/user 与默认值最终解析为同一 identity 时允许在首次 resolve 后收敛；首次并发请求使用不同
  `connectKey` 时可能产生一个短命 loser Host，但不得产生两个 ready pool owner。

### Logical session identity

`remoteSessionId` 继续表示一个 Renderer/Main logical remote workspace route：

```text
workspace A → remoteSessionId A → attachment A ─┐
workspace B → remoteSessionId B → attachment B ─┼→ shared WSL Host
workspace C → remoteSessionId C → attachment C ─┘
```

关闭 `remoteSessionId A` 不等于关闭 shared Host。

### Workspace identity

所有隔离语义继续使用：

```ts
workspaceKey = workspaceIdentity?.trim() || workspacePath;
```

文件读写、Git、terminal 和 command cwd 继续使用 `workspacePath`。Main、Host、mobile attachment、provider
registry 和 Agent release 请求必须同时携带 `workspaceIdentity` 与 `workspacePath`，禁止仅按路径匹配。

## 状态模型与权威来源

### Host pool state

```ts
type RemoteWslHostState =
  | "connecting"
  | "ready"
  | "draining"
  | "idle"
  | "disposing"
  | "disposed";

interface RemoteWslHostEntry {
  process: ElectronUtilityProcess;
  generation: number;
  target: SanitizedWslTarget;
  resolvedDistro?: string;
  resolvedUser?: string;
  state: RemoteWslHostState;
  readinessPromise: Promise<void>;
  idleTimer?: ReturnType<typeof setTimeout>;
  disposePromise?: Promise<void>;
}
```

这是设计形态，不要求实施逐字复制类型；但以下不变量必须保留：

- 一个 pool key 同时最多一个非 disposed Host entry。
- 一个 Host entry 同时最多一个 idle timer 和一个 dispose Promise。
- `generation` 单调递增；timer、ready continuation 和 exit callback 修改 map 前必须同时比较 entry 对象和
  generation。
- `disposing` 后拒绝新 attach；调用方需要创建新 Host 时必须等待旧 entry 从 map 摘除。
- map 删除遵循 compare-and-delete，旧 Host exit 不能删除同 key 的新 Host。

### Logical session state

```ts
interface AttachedWslWorkspaceSession {
  host: RemoteWslHostEntry;
  attachmentId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}
```

Main 不额外保存可派生的手工 `refCount`。桌面引用从 attached logical sessions 派生；手机引用从现有
shared-host attachment registry 派生。需要频繁判断时允许维护索引，但索引只能由 attach/detach 的同一原子入口
更新，并必须有一致性测试。

### Workspace runtime state

```text
active
  ├─ refs > 0                         → active
  └─ refs = 0
     ├─ running task exists           → draining
     └─ no running task               → releasing → released

draining
  ├─ new attachment arrives           → active
  ├─ task reaches terminal state      → releasing → released
  └─ owner teardown                   → forced bounded shutdown
```

task 是否运行的权威仍在 Host/远端 Agent/session service。Main 可以持有“workspace 正在 draining”的生命周期
标记，但不得复制 task 内容、stream event 或 snapshot。

workspace runtime 的 acquire/release 使用独立、单调递增的 workspace generation。Main 在同 workspace
重新建立 logical session 时，必须先向 Host 发送 acquire generation 并等待 ACK，收到成功 ACK 后才能 attach
RPC MessagePort。Host 收到 acquire 后取消更旧、尚未开始的 release；若旧 release 已经进入
`releaseWorkspacePreparation()`，则等待其完成后再 ACK。release 完成前新 session 不得进入 resume/create/sendPrompt。

```text
close generation=7
  → ReleaseRemoteWorkspace(generation=7)
      → releaseWorkspacePreparation in-flight

reopen generation=8
  → AcquireRemoteWorkspace(generation=8, requestId)
      → invalidate pending release generation<8
      → await in-flight release generation=7
      → RemoteWorkspaceAcquired(generation=8, requestId)
  → attach service port
  → resume/create/sendPrompt
```

实现采用“建 Host 前解析”的等价收敛：Main 为 provisional target 执行可缓存、失败不固化的 WSL identity
resolution，拿到 WSL 列表中的 canonical distro name 与 `id -un` 的实际 Linux user 后，才调用 Host pool
`getOrCreate`。因此 provisional key 只用于 resolver single-flight/cache，不会成为 ready Host 的长期 identity；
default target、显式等价 target、大小写不同但 WSL 列表命中同一名称的 target 最终都使用同一 resolved key。
并发 resolver 可以重复探测，但 resolved `getOrCreate` 必须原子保证只 spawn 一个 Host。App/window 在 resolution
期间关闭时，完成 continuation 必须重新检查 shutdown/window 状态，不得在 teardown snapshot 后创建 Host。

Main 等待 acquire ACK 必须有 10 秒 deadline；deadline 只终止本次 logical connect，不允许绕过 ACK attach，
也不能杀掉仍服务其他 workspace 的 shared Host。Host exit/App shutdown 必须 reject 全部 pending acquire waiter。
generation 在发送 `AcquireRemoteWorkspace` 前即已分配，因此 timeout/cancel 不能只丢弃 waiter：Main 必须立即对
同 generation best-effort 发送补偿 release。若成功 ACK 在 waiter 放弃后才到达，Main 必须确认该 workspace
没有 attached desktop/mobile owner，再对 ACK 携带的 generation 重发 release；失败 ACK 不需要补偿。这样即使
第一次 release 与 Host 内旧 generation 的 release-in-flight 重叠而未执行，晚 ACK 仍会在旧 release 完成后完成收口。

Acquire ACK 成功只表示 Host 已授予该 workspace generation 的 runtime owner，不表示 desktop logical attachment
已经建立。ACK 后若 `AttachServicePort`、renderer port 转移或 session tracking 任一步失败，Main 必须对同一
generation 执行补偿性 `ReleaseRemoteWorkspace`，再释放 pool owner；只释放 pool owner 不等价于释放 shared
Host 内的 workspace runtime。手机 shared-host attachment 必须在创建或转移 MessagePort 前验证已绑定的
`workspaceGeneration`，非法 session 不得给 Host 留下无调用方持有的 attachment。

```text
AcquireRemoteWorkspace(generation=N) → ACK
  → validate generation
  → AttachServicePort
      ├─ success → logical session owns runtime N
      └─ failure → ReleaseRemoteWorkspace(generation=N)
                  → release pool owner
```

## 创建、复用与取消时序

```text
Workspace A connect
  → Main canonicalize provisional WSL target
  → reserve pool entry(connecting, generation=N)
  → create Host
  → create WSLBackend
  → resolve distro + Linux user
  → detect/deploy/start zcode-server
  → Host Connected
  → entry(ready)
  → AttachServicePort(A, workspace context)
  → publish RemoteServicePort(A)
```

同目标并发连接：

```text
Connect A ─┐
Connect B ─┼→ same readinessPromise → one detect/deploy/server start
Connect C ─┘

ready
  ├→ independent attachment A
  ├→ independent attachment B
  └→ independent attachment C
```

取消规则：

- 取消一个 pending logical connect 只移除该 waiter。
- 每次 `wslHostPool.retain()` 创建的 pending owner 必须由单一幂等收口函数释放；取消触发 acquire
  Promise rejection 后，异步 catch 不得再次减少引用。成功 attach 后 owner 才从 pending connect 转移给
  tracked logical session，由 session dispose 负责后续唯一一次 release。
- 只在全部 waiter 均取消、Host 仍 connecting 且尚无 attachment 时 dispose connecting Host。
- Host 已 ready 后，旧 cancel 不得销毁已被其他 session 复用的 Host。
- App/window/update shutdown 无条件覆盖 waiter 规则，拒绝全部 pending 并释放 Host。
- `setupRemoteConnection()` continuation 在 shutdown 后恢复时必须检测 Host lifecycle token，不得重新发布
  connection 或 attachment。

## Workspace detach 与 runtime 回收

```text
关闭 workspace A
  → 从 logical session map 摘除 A
  → DetachServicePort(attachment A)
  → 派生 workspaceKey A 的 desktop/mobile refs
     ├─ refs > 0
     │  → 保留 runtime
     └─ refs = 0
        ├─ no running task
        │  → disposeWorkspace(workspaceKey A)
        └─ running task
           → mark draining(A)
           → terminal event
           → re-check refs
              ├─ refs > 0 → active
              └─ refs = 0 → disposeWorkspace(A)
```

`releaseWorkspacePreparation()` 必须从空操作变成真实生命周期入口，并满足：

- 参数使用 `workspaceIdentity` fallback `workspacePath` 解析 `workspaceKey`。
- 与 `disposeWorkspace()` 或等价 Agent manager API 形成单一实现，不维护两套释放语义。
- 幂等；重复调用复用 in-flight 或返回已释放结果。
- 与同 workspace 的 `ensureAgentReady()` 互斥或按 generation 防止“释放完成后旧 warm-up continuation 又发布
  Agent”。
- running task 存在时不直接杀 Agent；返回明确的 busy/draining 结果，或由 Host coordinator 延迟调用。
- owner teardown 可绕过 busy 保留策略，进入整个 Host 的有界 shutdown。
- 只释放进程、watcher、MCP transport 和可重建缓存，不删除 session/task 持久数据。

## Pool idle TTL

pool 只有在以下条件同时满足时才能进入 idle：

1. 没有 attached desktop logical session。
2. 没有该 Host 的 mobile shared-host attachment。
3. 没有 draining workspace/running task owner。
4. Host 已 ready，且没有 pending connect waiter。

```text
last owner released
  → entry.state = idle
  → install timer(entry identity, generation=N, 60s)

new connect before deadline
  → compare current entry + generation
  → clear timer
  → state = ready
  → attach

timer fires
  → compare current entry + generation
  → re-check all four idle predicates
  ├─ predicate false → no dispose; transition to ready/draining as derived
  └─ predicate true
     → state = disposing
     → remove/mark entry atomically
     → disposeHostProcessAndWait
```

TTL 常量命名并集中定义，单元测试使用可注入 clock/fake timer；不得在多个调用点散落 `60_000`。

## 真实关窗、App 退出与更新安装

owner teardown 优先级高于 idle cache 和 draining task：

```text
real window close / app quit / update install
  → manager enters shuttingDown
  → reject new Host, connect and attachment
  → cancel all Host idle timers
  → reject pending connect waiters
  → snapshot all dedicated/shared/bot Hosts
  → dedupe by process identity
  → dispose all Hosts in parallel
  → await aggregate bounded barrier
  → continue window destruction / app quit / update handoff
```

- renderer reload 不是 owner teardown；existing logical session 按现有 reattach 设计恢复。
- 最小化和隐藏到托盘不触发 idle，也不减少 workspace owner。
- App 退出发生在 idle TTL 期间时立即取消 timer 并释放，不等待 TTL。
- App 退出发生在 workspace draining 时不等待 task 自然结束，复用现有 Host/server/Agent shutdown deadline。
- `before-quit`、窗口 `closed` 和 update preparation 重复调用必须命中同一 single-flight result。
- WSL shared Host 必须进入现有 app-level remote Host 全量快照，不能只依赖窗口 `closed` 事件。

## 探测、部署与 `wsl.exe` 并发管理

### 探测缓存

缓存分两层：

- pool Host 生命周期内：backend `resolvedInfoPromise` 永久复用。
- Main 进程级只读 discovery：`wsl --status` 和 distro list 使用 5 秒 TTL 缓存；用户刷新 WSL
  连接界面或连接失败时允许主动失效。

Linux user、`$HOME` 和实际 distro 必须以具体 Host target 为范围，不能只按 Windows 用户做永久全局缓存。
缓存 rejected Promise 必须清除，后续连接可以重试。

### 连接节流

同 poolKey 使用 single-flight 而不是 semaphore；不同 distro 的连接允许并发。若真实运行 trace 证明 WSL VM
在不同 distro 并发仍存在系统级锁竞争，再增加全局小并发 semaphore，不能先凭估算写死串行策略。

### Deploy single-flight 与锁

正常版本匹配继续跳过上传。首次安装/升级必须满足：

- 同一 Host 内 deploy 复用 readiness Promise。
- 跨窗口或第二个 App 实例即使不共享 pool，也不能竞争同一固定 `${remotePath}.new`。
- staging path 使用不可预测且本次部署唯一的后缀。
- 最终替换在同一 filesystem 内原子 rename。
- distro/user/server install root 范围使用远端 lock；持锁者异常退出后 lock 必须可超时恢复。
- lock 内重新检查版本，等待者不能在获得锁后无条件重复上传。
- 清理只删除本次 owner 的 staging file，不使用宽泛 glob。
- deploy lock 只提供互斥，不代替锁内网络 deadline；每个 manifest CDN 候选的响应头和
  body 读取都必须受 `manifestRequestTimeoutMs` 约束，超时后允许后续连接重试。
- 单次 deploy transaction 必须固定同一份 fresh manifest；GLM 的跳过判断、本地 release
  materialize 和最终写入的 component identity 必须使用同一 SHA-256 快照。语义版本相同但
  SHA 变化时必须重新部署；SHA 相同时不得因版本标签变化重复上传。
- manifest source 必须按 component 的实际资源来源选择：mock-cdn 文件完整时使用 mock
  manifest；mock manifest 存在但目标 component 文件不完整、且已配置 CDN fallback 时，
  SHA 判断与 materialize 都必须改用同一份 fresh CDN manifest。不得用 mock SHA 判定跳过后
  再上传 CDN 制品，也不得为了读 SHA 先下载整个 GLM artifact。

远端锁必须覆盖完整 `deployServer` transaction，而不是只包住某个 `installFile()` 或
`installDirectory()`：主 server、Node runtime、Agent bundle、官方插件目录和最后的 version marker
必须属于同一个部署 owner，禁止两个版本交错安装。锁固定在 `${REMOTE_BASE}/.deploy.lock`，owner 使用
不可预测 UUID；持锁 shell 每 30 秒刷新 owner 文件 mtime，等待者只接管超过 600 秒没有心跳的锁。释放时
必须再次比较 owner token，禁止旧 owner 删除后来者的锁；Host/backend 关闭造成 stdin EOF 时也走同一
owner-checked cleanup。

`wsl.exe -- bash -lc <command>` 会先经 WSL 默认 shell 重组参数，直接放在 command 参数里的局部
`$lock_dir` / `$owner_token` 可能在 lock-holder 真正执行前被展开为空。lock-holder 脚本必须以不含 `$`
的八进制 payload 写入 owner 唯一临时脚本，再由 bash 执行；脚本结束时同步删除该临时文件，且 stdin
继续保留给 release marker。SSH/Docker 复用同一 wrapper，不能为 WSL 分叉部署事务语义。

lock-holder release 是外部 stdio 边界，默认最多等待 5 秒 close。超时后必须 best-effort destroy 本次 lock
stream 的 stdin/stdout/stderr 并返回包含 owner、deadline 和 stderr 摘要的错误；不得直接 dispose 共享 backend。
若部署主体与 release 同时失败，调用方必须保留两个错误上下文，不能用 release timeout 覆盖原始部署失败。

lock acquisition 同样是外部 stdio 边界，总等待默认最多 120 秒，并通过
`DeployOptions.deployLockAcquireTimeoutMs` 允许连接层覆盖。deadline 从 lock-holder stream 创建成功后开始；若始终
没有 acquired marker，即使其他 owner 持续 heartbeat，也必须销毁本次 waiter 自己的 stdin/stdout/stderr、移除
监听器，并抛出包含 owner、deadline 与 stderr 摘要的 acquisition timeout。不得删除其他 owner 的 lock，也不得
dispose 可能被共享的整个 backend。

```text
deployServer
  → start remote lock-holder shell
      → mkdir ~/.zcode/server/.deploy.lock (atomic acquire)
      → write owner UUID + heartbeat
      → emit acquired marker
  → lock 内重新执行 checkServerDeployDecision
  → fetch one bounded fresh manifest snapshot
      → GLM SHA decision + release materialize share the snapshot
  → install all selected components + write version markers
  → send owner-scoped release / stdin EOF
      → compare owner UUID → remove only this lock
```

本地上传目录与开发态官方插件目录必须同时使用唯一 remote archive 和唯一 extract staging。归档上传、解压
或替换失败时，只清理本 owner 的 archive/staging；最终目录替换在 deploy-root lock 内执行。
`RemoteDownloadAssetInstaller.installDirectory()` 已有唯一 staging，但其最终 `rm + mv` 同样依赖上述
deploy-root lock，component cache lock 不能替代 install-root transaction lock。

## 异常、断线与恢复

WSL backend 的 shutdown barrier 必须先禁止新命令，再回收所有已登记 child。任何在 `exec()` 入口门禁后
跨越 discovery / identity await 的 continuation，都必须在最终同步 `spawn()` 前再次检查 disposed；检查、
spawn 与 child 登记位于同一 JavaScript turn，禁止在 `disposeAndWait()` 已完成后产生新 `wsl.exe`。直接
`execFile()` 的探测命令同样必须在同步创建 child 前检查 disposed。

### Shared Host 意外退出

```text
Host/server unexpected close
  → compare pool entry identity
  → mark disposed and remove pool entry
  → cancel idle timer
  → enumerate attached logical sessions
  → emit RemoteSessionClosed for each session
  → existing UI marks affected workspaces disconnected
```

一个 shared Host 退出会影响同 pool 全部 workspace，这是共享方案明确接受的故障域。重连任一仍打开 workspace 时，
Main 创建新 Host；同组其他仍打开 workspace 可复用该 Host 逐个恢复 attachment。每个 workspace 的路径/provider/
Agent 初始化失败保持独立，不因 workspace B 失败回滚已恢复的 workspace A。

### Stale continuation

所有跨 `await` 的连接、deploy、attach、timer 和 exit continuation 在写入共享状态前检查：

- manager 未进入 `shuttingDown`。
- pool map 仍指向同一 Host entry。
- generation 未变化。
- logical request/session 尚未取消。

检查失败时只释放自己创建且尚未转移 owner 的资源，不发布 stale port/connection。

### 错误日志

- Host create/ready/idle/reuse/dispose/exit 为低频生命周期 `info`。
- deploy lock 等待、连接取消、idle predicate 变化使用 `debug` 或单次 `info`，不得按 polling 高频落盘。
- timeout、stale callback、release busy 超出预期时间使用 `warn`。
- handshake、deploy、Agent release 或 shutdown 不可恢复失败使用 `error`。
- 日志包含 pool label、generation、remoteSessionId/workspaceKey 的安全摘要、phase 和 elapsedMs；禁止 secret、完整
  environment 和用户命令。

## Desktop continuous 与手机 replayable 边界

```text
shared WSL Host
├─ desktop attachment
│  └─ clientMode=desktop-continuous
│     └─ direct continuous events; no relay_bridge
└─ mobile attachment
   └─ clientMode=web-remote-replayable
      └─ existing replayable gap/snapshot recovery
```

- Host 共享只改变进程复用，不改变 delivery kind。
- 普通桌面 WSL 不能因为 Host 变成 shared 就注册 `relay_bridge`。
- 手机 `/remote` 继续 attach 桌面已存在的 WSL Host，禁止另起独立 WSL session/runtime。
- 手机断线只 detach mobile attachment；若无其他引用且无 running task，才参与 workspace/pool idle 判定。
- `workspaceIdentity` 和 `remoteSessionId` 必须贯穿 bridge、snapshot、queue、owner command 和缓存 key。
- owner/lease 与 stale run 防护继续保留；不能用 shared Host 代替 task owner 判断。
- Main 不拼接 replayable 事件，也不缓存 task stream 来辅助 Host 共享。

## Docker backend 决策

本设计故意不为 Docker 补对称 shared pool：

- WSL 的共享 identity 是当前 Windows 用户下稳定的 distro + Linux user；Docker target 可能对应一次性 container、
  mutable container name 或不同 container lifecycle owner。
- 当前没有证据证明多个 Docker workspace 应共享一个 container service graph，也没有用户确认关闭最后 workspace 后
  container 是否应保持、停止或删除。
- 贸然套用 WSL/SSH pool 会改变 container owner 和隔离语义。

Docker 仍使用 dedicated Host，但继续参与统一的真实关窗/App/update shutdown barrier 和幂等 dispose 接口。后续若要
共享 Docker，必须先单独确认 container identity、owner、重建和 volume/workspace 隔离。

## 分阶段实施

本设计只产生一份最终 spec，但实施按依赖分三段；每段都必须保持可运行、可测试和可回滚。

### 阶段 1：workspace release 与并发基础

- 为 `releaseWorkspacePreparation()` 建立真实、幂等、可等待的 workspace runtime release。
- 补 Agent warm-up 与 release 的 generation/single-flight。
- 引入短 TTL WSL discovery cache。
- 为同 target 连接/deploy 增加 single-flight。
- deploy 使用唯一 staging path 和 distro/user/install-root lock。

阶段完成后仍可保留 dedicated Host，但关闭不再使用的 workspace preparation 能回收 Agent，首次连接风暴和 deploy
竞争得到控制。

### 阶段 2：窗口级 WSL Host pool

- 抽离或新增 WSL Host pool owner。
- Host 与 logical session 解耦，复用 `AttachServicePort`。
- 增加 workspace context、desktop/mobile 引用派生和 draining 状态。
- 加入 60 秒 idle TTL、generation 和 stale callback 防护。
- shared Host 异常断开时批量关闭关联 logical session。
- 将 shared WSL Hosts 纳入窗口/App/update 全量 shutdown barrier。

### 阶段 3：运行态验证与性能基线

- 在真实 Windows + WSL 环境记录 1、3、5 workspace 的 Windows Host PID、`wsl.exe` PID、WSL server PID、
  Agent PID、RSS 和连接耗时。
- 注入 close/reopen、timer race、pending connect cancel、Host crash 和 update teardown。
- 验证 desktop continuous 与 mobile replayable 边界。
- 只有运行证据证明不同 distro 并发仍有系统锁竞争时，才评估额外全局 semaphore。

## 测试设计

### Pool identity 单元测试

- 同窗口、canonical distro 和 resolved user 相同得到同 key。
- distro display name 大小写/空白按 canonicalization 结果收敛。
- 同 distro 不同 user 不共享。
- 不同 window 不共享，即使当前产品限制单窗口。
- workspacePath、workspaceIdentity 和 remoteSessionId 不影响 pool key。
- secret 不进入 key 或 snapshot 日志。

### Desktop Main pool 单元测试

- 三个同 key 并发 connect 只 spawn 一个 Host，并共享 readiness Promise。
- ready Host 为三个 session 返回三个不同 attachmentId/MessagePort。
- 取消一个 waiter 不影响其他 waiter；全部 waiter 取消才 dispose connecting Host。
- 关闭一个 session 只 detach，不销毁仍有引用的 Host。
- 最后引用消失且无 running task 后安装唯一 60 秒 timer。
- TTL 内重连取消 timer 并复用同 process。
- TTL 到期前新引用出现时 timer no-op。
- 旧 generation timer/exit callback 不影响同 key 新 Host。
- window close/App quit/update install 取消 timer 并立即 await Host dispose。
- renderer reload、最小化、托盘隐藏不触发 Host dispose。
- shared Host unexpected exit 向全部关联 session 发出 closed。

### Workspace runtime 单元测试

- `releaseWorkspacePreparation` 不再是空操作，并按 workspaceKey 释放正确 Agent。
- 同 workspace 重复 release 幂等。
- release 与 warm-up 并发时不会发布已失去 owner 的 Agent。
- refs=0、无 running task 时立即 release。
- refs=0、有 running task 时进入 draining，不中断 task。
- terminal event 后重新检查 refs；无新引用才 release。
- draining 期间重新 attach 恢复 active，不释放新 owner 使用的 Agent。
- close 后 release 已开始、同 workspace 立即 reopen 时，Main 在旧 release 完成前不 attach RPC port。
- acquire generation 使更旧的 pending release 失效；stale release 到达时不清理新 runtime。
- acquire ACK 超时或 Host exit 时 connect 明确失败，不绕过 ACK 进入 resume/sendPrompt。
- acquire ACK 成功但 desktop attachment 失败时补偿释放同 generation 的 workspace runtime 与 pool owner。
- 手机 shared-host attach 在转移 MessagePort 前拒绝缺少 workspace generation 的非法 session。
- App/window/update teardown 可进入全 Host 有界 shutdown。
- release 不删除 task/session 持久数据。

### Deploy/discovery 单元测试

- 多调用共享成功的 discovery Promise/cache。
- rejected discovery 不被永久缓存。
- cache TTL 到期和主动 refresh 后重新探测。
- 版本匹配跳过上传。
- 两个 installer 竞争时只有持锁者上传，等待者锁内复查版本后跳过。
- staging path 每次唯一；失败只清理本次 staging file。
- stale lock 可恢复，活跃 lock 不被抢占。
- 已获得 deploy lock 但 release close 永不触发时，5 秒 deadline 后销毁 owner stream 并返回 timeout。
- deploy 与 lock release 同时失败时，错误中同时保留 deploy failure 与 release failure。
- manifest 响应体半开时在 deadline 内失败，下一次 deploy 会发起新请求而不复用 pending Promise。
- GLM 语义版本不变但 manifest SHA 变化时重新部署，且判断与安装使用同一 pinned manifest。
- mock manifest 存在但 GLM 文件不完整时，使用 CDN SHA 决策并物化；远端 SHA 已匹配时只读 manifest，不下载 GLM artifact。

### Host/server shutdown 单元测试

- shared WSL Host 的全部 attachment 在 service dispose 前停止接受新 RPC。
- workspace release pending/throw 不阻止 remote connection close phase。
- stdin EOF 后等待 server/wsl.exe 正常退出。
- deadline fallback 只处理 backend owned child，不 terminate distro。
- idle dispose 与 app-level dispose 并发时复用同一 Promise。

### Desktop/mobile 边界测试

- 桌面 WSL attachment 保持 `desktop-continuous`，不注册 `relay_bridge`。
- 手机 attachment 使用 `web-remote-replayable`，不新建独立 WSL Host。
- 同 Host 不同 workspace 的 snapshot/event/queue/owner command 不串路由。
- 手机 detach 不误杀仍有桌面 owner 或 running task 的 runtime。

### 真实 Windows + WSL 验证

每次采样必须记录时间戳和父子关系，不能只凭 Task Manager 截图判断：

1. 打开一个 WSL workspace，记录 Host、`wsl.exe`、server、Agent PID 与 RSS。
2. 同窗口打开同 distro/user 的第二至第五个 workspace，确认 Host/server PID 不增加，Agent 按 workspace 按需增加。
3. 对比 dedicated 基线和 shared pool 的总 RSS、首次连接耗时、后续 workspace attach 耗时。
4. 关闭其中一个 workspace，确认其 attachment 消失；无 task 时对应 Agent 在 deadline 内退出，Host/server 保持。
5. 在 task 运行时关闭 workspace，确认 task 不被立即中断；terminal 后 Agent 释放。
6. 关闭最后 workspace，确认 60 秒内 Host/server 保持；TTL 到期后退出。
7. TTL 内重新打开 workspace，确认复用原 Host/server PID，旧 timer 不误杀。
8. TTL 期间退出 App，确认不等待 60 秒，全部 ZCode-owned Host/server/Agent 在 shutdown deadline 内退出。
9. 分别验证真实关窗、更新安装、renderer reload、最小化、托盘隐藏。
10. 手机 attach 后关闭桌面 tab，验证 mobile owner 保持 runtime；手机再断开后进入 draining/idle 判定。
11. 注入 Host crash、connect cancel、deploy failure 和 stale timer，保存日志与 PID 证据。
12. 确认 distro 可继续 Running，用户在同 distro 的普通进程不受影响。

仓库机械验证：

```sh
pnpm typecheck
pnpm lint
```

## 可观测性与性能指标

正式实现前后使用相同 server 版本、同一 distro 和同一组 workspace 比较：

| Metric | Expected direction |
| --- | --- |
| 同 pool UtilityProcess Host 数 | `N → 1` |
| 同 pool `zcode-server` 数 | `N → 1` |
| 同 pool 长驻 `wsl.exe` server launcher 数 | `N → 1` |
| 第二至第五 workspace attach 时间 | 明显低于首次冷连接，不重复 deploy/server start |
| 空闲 server RSS | 从 N 份降为 1 份；不规定跨版本绝对阈值 |
| workspace Agent 数 | 按 active/draining workspace，而不是按 Host 或 conversation |
| 最后 owner 关闭后的 Host 存活时间 | 60 秒 ± scheduler tolerance；App teardown 为 shutdown deadline 而非 60 秒 |

日志需要能重建以下时序：pool create/reuse、Host generation、session attach/detach、workspace draining/release、
idle timer install/cancel/fire、owner shutdown override、Host exit。

## 风险与缓解

| Risk | Mitigation |
| --- | --- |
| shared Host 崩溃扩大影响面 | 限制为窗口+distro+user；批量通知关联 session；重连按 workspace 独立恢复。 |
| 旧 timer 误杀复用后的 Host | entry identity + monotonic generation + fire 前重新派生 idle predicates。 |
| 手工 refcount 漂移 | 优先从 logical/mobile attachment 权威集合派生；若为性能建索引则只允许原子入口更新并做一致性测试。 |
| 关闭 tab 误杀后台 task | refs=0 且 running 时进入 draining；只有 terminal 后释放。 |
| draining 永久不结束 | 正常等待 task lifecycle；真实 owner teardown 使用既有有界 shutdown；异常断线随 Host exit 清理。 |
| shared server 内 workspace 串数据 | 所有隔离 key 使用 `workspaceIdentity` fallback `workspacePath`；端到端多 workspace 测试。 |
| deploy 首次安装竞争 | unique staging + remote lock + lock 内版本复查。 |
| discovery 缓存陈旧 | 5 秒短 TTL、主动刷新/失败失效，不缓存 resolved user/home 为全局永久值。 |
| App 退出被 TTL 延迟 | shutdown 首先取消 timer，立即并行 dispose；TTL 从不进入退出等待预算。 |
| mobile replayable 污染 desktop | attachment 保留 clientMode/deliveryKind；desktop WSL 明确禁止 relay_bridge。 |
| Docker 被错误对称化 | 本 spec 明确保持 dedicated，另行确认 container owner 后再设计。 |

## 验收标准

- 同一窗口、同一 canonical distro 和 Linux user 的多个 WSL workspace 只存在一个 Host、一个 server
  connection 和一个 `zcode-server`。
- 每个 logical workspace 保持独立 remoteSessionId、attachment、workspaceIdentity 和 workspaceKey；跨 workspace
  task/session/provider/queue 不串线。
- 关闭无运行 task 的 workspace 能真实释放对应 Agent/preparation runtime，不再停留在空操作。
- acquire 成功后的 attachment 异常不会遗留无 logical owner 的 workspace runtime 或 Host attachment。
- 关闭有运行 task 的 workspace 不立即中断 task；terminal 后释放 runtime。
- pool 零 owner 后进入 60 秒 idle TTL，TTL 内复用，TTL 后确定性释放。
- 真实关窗、App 退出和更新安装在 TTL 或 draining 任意状态下均立即进入有界 shutdown，不等待 60 秒。
- 最小化、托盘隐藏和 renderer reload 不误释放仍有效的 Host/runtime。
- 同 pool 并发连接只执行一次 detect/deploy/server start；首次安装/升级没有 staging path 竞争。
- deploy lock acquire/release 和 manifest HTTP 请求分别有独立 deadline；任一外部边界半开都不会无限持锁。
- GLM 资源按 pinned manifest SHA 判定内容身份，同版本重发制品可正确更新。
- 桌面 WSL 保持 `desktop-continuous` 且无 `relay_bridge`；手机保持 `web-remote-replayable` shared-host
  attachment。
- Docker 保持 dedicated，但继续被应用级 shutdown barrier 覆盖。
- 真实 Windows + WSL 的 1/3/5 workspace 验证留下 PID、RSS、耗时和释放时间证据。
- 不调用 distro terminate，不影响非 ZCode WSL 用户进程。
- 相关测试、`pnpm typecheck` 和 `pnpm lint` 全部通过。
