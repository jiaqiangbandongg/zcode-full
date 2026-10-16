# WSL 远程进程确定性回收设计

> **历史边界说明**：本文形成时 WSL 仍是 per-session dedicated Host；当前 WSL 已按
> `window + normalized(distro,user)` 池化，workspace release、60 秒 idle TTL 与 app shutdown 以
> `docs/superpowers/specs/2026-07-20-window-scoped-wsl-host-pooling-design.md` 为准。本文的有界退出、
> 幂等清理和孤儿进程防护仍有效，但不得再把 WSL 的 Host 基数解释为 per-session。

## 背景

WSL remote workspace 当前复用统一 `IRemoteBackend` / `connectRemote` / Desktop Host
链路。WSL 的主连接是一个由 Desktop Host 启动的
`wsl.exe -- bash -lc "...zcode-server..."` stdio 子进程；正常释放依赖客户端关闭
stdin，WSL 内 `zcode-server` 收到 EOF 后再释放其托管的 ZCode Agent。

当时已有 per-session、per-window 和 Host 内部资源释放，但应用级退出只等待
`windowHostProcessMap` 中的 Local Host。当时的 WSL/Docker/Server dedicated Host、窗口级共享
SSH Host 和 Bot remote runtime 由 remote session manager 单独持有，窗口 `closed` 时会收到
Dispose，却没有被 app quit / update install 统一等待。与此同时，远端 stdio shutdown 若卡在
RPC stop，会在总 deadline 后直接退出，可能跳过 Agent dispose；`disconnect` 路径也没有有界的
最终退出保证。

这使“已经发起释放”和“所有 ZCode-owned 远程进程已经退出”之间存在空窗。在主进程提前退出、
Host cleanup 卡住或旧版本异常退出时，WSL 内 detached `zcode-cli` 可能被 PID 1 接管并长期残留。

## 目标

- 用户真正关闭窗口、退出应用或安装更新时，确定性回收该 owner 持有的 Remote Host、
  WSL `zcode-server` 和 ZCode Agent。
- app quit / update install 在有界时间内等待 Local Host 与全部 Remote Host；超时后留下明确日志并
  执行进程级兜底。
- RPC stop 超时不能阻止 Agent cleanup 被尝试。
- main 与 Host 的 disconnect / signal / Dispose 入口收敛到同一幂等释放状态机。
- 为新启动的 WSL ZCode 进程留下 owner 身份，使后续启动可以安全识别“owner 已死亡”的孤儿；
  不按进程名全局扫描和误杀。
- 不改变 Desktop `desktop-continuous`、Mobile `web-remote-replayable`、owner/lease、
  CommandInbox 或 workspace identity 语义。

## 非目标

- 不调用 `wsl --terminate` 或 `wsl --shutdown`。WSL distro 是用户共享环境，不属于单个
  ZCode session。
- 不在手机断线、Web bridge 重建、renderer reload、窗口最小化或隐藏到托盘时销毁 Host/Agent。
- 不清理无法证明归属 ZCode 的任意 `node`、`zcode-cli` 或用户 shell 进程。
- 不改变 SSH Host 的窗口级共享策略，也不把 WSL/Docker 改成共享 Host。
- 不把 task/session/queue/snapshot 状态下沉到 desktop main、relay 或清理 registry。

## 回收时点

| 事件 | 是否回收 | 范围 | 原因 |
| --- | --- | --- | --- |
| 关闭一个真实 BrowserWindow | 是 | 该窗口 Local Host、dedicated sessions、共享 SSH Hosts、Bot runtimes | 窗口 owner 已结束 |
| Windows 关闭按钮隐藏到托盘 | 否 | 无 | 窗口和运行中任务仍存活 |
| 最小化窗口 | 否 | 无 | 仅可见性变化 |
| renderer reload / crash recovery | 否 | 仅旧 attachment | Host/CLI 生命周期属于窗口，不属于 renderer |
| 手机 `/remote` 断线或 bridge dispose | 否 | 仅 mobile attachment | shared-host attachment 不拥有 runtime |
| `before-quit` / Cmd+Q / 托盘“退出” | 是并等待 | 应用内全部 Local/Remote Hosts | App owner 结束 |
| 自动更新安装前 | 是并等待 | 应用内全部 Local/Remote Hosts | 释放进程、文件和 runtime 锁后再交接更新 |
| Host 远端连接异常关闭 | 是 | 当前 Host 的 services、attachments、Agent 和 backend | Host 故障域结束 |
| Main/Host IPC disconnect | 是，有界 | 当前 Host 全部资源 | 父 owner 已消失 |

## 生命周期状态机

### 应用级

```text
RUNNING
  |
  | app-before-quit / update-install
  v
PREPARING_SHUTDOWN
  |-- mark force quit，禁止托盘隐藏逻辑重新接管
  |-- 停止 cron / telemetry / new remote session admission
  |-- snapshot Local Host + Remote Host owners
  |-- cancel pending remote connects
  |-- parallel disposeAndWait(all unique hosts)
  v
HOSTS_SETTLED
  |-- all exited: normal
  |-- deadline: record exact remaining host labels/PIDs and force fallback
  v
EXIT_OR_UPDATE_HANDOFF
```

### Remote Host 内部

```text
ACTIVE
  |
  | Parent Dispose / SIGTERM / SIGINT / disconnect / remote close
  v
DISPOSING (single-flight)
  |-- stop accepting new attachments/RPC
  |-- close owned attachment scopes
  |-- dispose local services and Agent processes
  |-- close remoteConnection stdin
  |-- wait remote server stream close
  v
EXITED

deadline exceeded
  -> log current phase
  -> run remaining best-effort cleanup
  -> process.exit(non-zero for unexpected/timeout)
```

### WSL 远端 server

```text
stdin EOF / error / termination signal
  |
  v
stopRpc (bounded independently)
  |
  +-- success --------------------+
  +-- timeout/error -> log -------+
                                  v
                         dispose services/Agent
                         (always attempted, bounded)
                                  |
                                  v
                              process.exit
```

RPC stop 与 service dispose 使用独立 phase deadline。禁止再用一个串行总 deadline 导致
`stopRpc` pending 时完全跳过 Agent dispose。

## 组件设计

### 1. Remote session manager 成为 Remote Host 生命周期事实源

`createRemoteWorkspaceSessionManager` 新增应用级异步入口：

```ts
disposeAllAndWaitForAppShutdown(reason: string): Promise<RemoteHostDisposeSummary>
```

调用时同步完成：

1. 阻止创建新的 remote session / Bot runtime。
2. 取消全部 pending SSH connect，并拒绝其 Promise。
3. 从 `remoteWorkspaceSessionsById`、`sshHostsByPoolKey`、
   `windowBotRemoteRuntimeProcessMap` 快照全部唯一 Host process。
4. 先清空或标记对应 registry，保证后续窗口 `closed`、Host `exit` 回调幂等。
5. 并行调用注入的 `disposeHostProcessAndWait`，返回每个 Host 的 exited/timed-out 结果。

Process Monitor 的全量 Host map 继续用于展示和诊断，不作为业务释放事实源。它不知道 pending connect、
logical session、SSH pool ownership 与 Bot runtime 关系，不能替代 session manager。

### 2. App quit 与 update install 共用一个 shutdown barrier

抽取应用级 Host barrier，同时覆盖：

- `prepareAppQuit`
- `prepareWindowsProcessesForUpdateInstall`

barrier 并行等待：

- `windowHostProcessMap` 中 Local Hosts
- remote session manager 返回的 dedicated/shared/Bot Hosts

Host process 按对象去重。重复进入返回同一个 in-flight Promise；更新预清理后触发
`before-quit` 不得再次创建 timer 或覆盖第一次结果。

窗口 `closed` 继续执行现有 per-window dispose，作为正常窗口生命周期入口；app barrier 是应用级
等待与异常补偿，不取代 per-window 语义。

### 3. Host shutdown 使用有界 single-flight

`disposeHostResources(reason)` 继续作为唯一异步释放函数，但增加 phase/deadline 记录：

- 先同步封住 attachment 与新 RPC 入口。
- service dispose 和 remote connection dispose 都必须被尝试；前一阶段失败不能跳过后一阶段。
- `disconnect` 与 SIGTERM/SIGINT 一样，等待 bounded cleanup 后明确退出。
- `exit` handler 只做同步 best-effort，不承担正常异步 cleanup。

正常 parent Dispose 使用退出码 0；remote unexpected close、disconnect cleanup timeout 或 cleanup
失败使用非零退出码，并保留 reason/phase/elapsedMs 日志。

### 4. RemoteConnection 提供可等待关闭契约

`RemoteConnection` 增加幂等 `disposeAndWait()`：

1. 同步停止 client/protocol/socket，并关闭主 stream stdin。
2. 等待主 `StdioStream.onClose`。
3. 超过 remote-server grace period 后调用 backend fallback dispose。
4. 返回 exited/timed-out 结果供 Host 日志和上层决策使用。

现有同步 `dispose()` 保留兼容，内部触发同一个 single-flight，但 Host 正常释放路径必须 await
`disposeAndWait()`。

连接建立中失败时也必须 dispose backend；不能只在成功返回 `RemoteConnection` 后才拥有 cleanup。

### 5. WSLBackend 只跟踪自己启动的子进程

WSL backend 维护其通过 `spawn` / `execFile` 启动且尚未退出的 Windows child handles：

- child `exit/close/error` 后立即从 registry 删除。
- backend fallback dispose 只关闭这些 handles，不枚举系统进程，不终止 distro。
- 主 server stream 优先由 stdin EOF 正常退出；仅在 grace period 后使用 child kill 兜底。
- upload/detect/deploy 等短命令在连接取消或 backend dispose 时也可被中止，避免连接失败阶段残留。

Docker backend 保持相同接口语义；SSH backend 继续关闭 ssh2 connection；server remote 使用其 WebSocket
关闭契约，不进入 WSL child registry。

### 6. Owner 标识与安全孤儿回收

每次 remote server 启动生成不可复用 `ownerId`，并记录：

- owner kind：`desktop-attached-remote`
- remote kind / distro
- Desktop Host owner token
- server PID 与 Linux process start time
- 由该 server 启动的 Agent PID 与 process start time

registry 放在 WSL 用户自己的 `~/.zcode/server/owners/`，使用原子写入；不放在 desktop main、relay 或
task repository。正常退出删除 registry。

下一次同用户启动 WSL remote server 时，只回收同时满足以下条件的记录：

1. registry schema、owner kind 和 distro 均匹配。
2. 记录的 server PID 已死亡，或 PID start time 与记录不一致。
3. Agent 当前 PID start time 与记录一致，且进程环境仍带相同 `ownerId`。
4. 目标 executable/command 属于 ZCode 部署路径。

任一校验失败只记录 warn 并跳过。旧版本没有 owner registry 的孤儿不能自动按名称清理；首次发布后可在
诊断中提示用户手动处理，避免误杀无法证明归属的进程。

## 时间预算

时间预算使用常量并在测试中注入，不散落 magic number：

| 阶段 | 建议默认值 | 说明 |
| --- | ---: | --- |
| Agent stdin graceful exit | 300 ms | 复用当前发布态快速路径 |
| Agent process-tree TERM/KILL fallback | 2,250 ms | 当前 2s + 250ms 兜底 |
| remote server RPC stop | 1,000 ms | 超时后仍继续 service dispose |
| remote server service/Agent dispose | 3,500 ms | 覆盖 Agent process-tree fallback |
| Host remote stream close | 5,000 ms | 覆盖 server 两阶段并留调度余量 |
| Main per-host force fallback | 6,000 ms | 必须晚于 Host/remote 正常预算 |
| App/update aggregate barrier | 8,000 ms | Hosts 并行等待，不按数量累加 |

E2E coverage 可使用现有 coverage-specific 延长配置。所有 timeout 日志必须包含 phase、host label、PID、
remote kind 和 elapsedMs；高频协议帧不得提升到 info。

## Web 远控和多端边界

- app/window teardown 前先关闭该 Host 的 mobile attachments，使其 connection scope 发送 `closed` 并
  释放 owned subscriptions。
- 不把 replayable snapshot、queue 或 task 状态复制到 main 以辅助 shutdown。
- 桌面 WSL attachment 始终为 `desktop-continuous`；手机 attachment 始终为
  `web-remote-replayable`。
- 手机 bridge dispose 只释放 attachment，不触发 Host shutdown。
- shared SSH Host 在 app/window teardown 时整体回收；关闭单个 logical session 仍只 detach。
- `workspaceIdentity`、`remoteSessionId`、owner/lease 路由不因进程回收接口而改变。

## 错误处理与日志

- Main：app/update barrier start、host count、每个 timed-out host、barrier complete 使用 `info/warn`。
- Host：Dispose/disconnect/remote close 生命周期使用 service logger；正常阶段为 `info`，超时为 `warn`，
  cleanup 失败为 `error`。
- WSL backend：一次性 spawn/exit/forced fallback 使用低频生命周期日志；不得记录命令环境中的 secret。
- owner reaper：成功回收使用 `info`，校验失败/跳过使用 `warn`，不记录完整 environ。
- 所有 dispose API 幂等；第二次调用复用 in-flight/result，不重复发送 signal。

## 测试设计

### Desktop Main 单元测试

- app shutdown 同时等待 Local、WSL dedicated、Docker/Server dedicated、SSH shared 和 Bot runtime。
- 所有 Host 并行等待并按 process 对象去重。
- `closed` 已经 per-window dispose 后，app barrier 再调用保持幂等。
- 更新预清理后进入 `before-quit` 复用同一 shutdown result。
- 托盘隐藏、最小化和 renderer reload 不调用应用级 remote dispose。
- pending SSH connect 在 shutdown 时被拒绝且 Host 被回收。

### Host / Server 单元测试

- parent Dispose、SIGTERM、SIGINT、disconnect、remote close 进入同一个 single-flight。
- RPC stop 永久 pending 时，deadline 后仍调用 service/Agent dispose。
- service dispose 失败时仍关闭 remote connection。
- remote connection 正常 close、timeout fallback 和重复 dispose。
- shutdown timeout 后进程使用预期 exit code，日志带 phase。

### WSL backend 单元测试

- `exec`/`execFile` child 被登记并在 exit 后删除。
- stdin EOF 正常退出时不 force kill。
- grace timeout 只 kill 当前 backend 启动的 child。
- backend dispose 不调用 `wsl --terminate` / `--shutdown`。
- 连接建立中失败、上传取消和 deploy 失败不残留 child handle。

### Owner registry/reaper 单元测试

- server 已死、Agent PID/start-time/env/ownerId 全匹配时回收。
- PID 被复用、ownerId 不匹配、路径不匹配、registry 损坏时跳过。
- 正常退出删除 registry。
- 不扫描或回收没有 owner registry 的旧进程。

### 真实 WSL 验证

1. 打开 WSL workspace 并启动一条真实 Agent session。
2. 最小化、隐藏到托盘、renderer reload，确认原 Host/server/Agent PID 保持。
3. 关闭真实窗口，确认该窗口 WSL Host、server、Agent 在 deadline 内退出，distro 仍 Running。
4. 再次连接并退出整个 App，确认全部 ZCode-owned WSL 进程退出。
5. 再次连接并触发 update install preparation，确认交接前进程退出。
6. 注入 Host disconnect、RPC stop pending 与 service dispose pending，确认有界收口且无新孤儿。
7. 制造带合法 owner registry 的孤儿，再次连接后确认只回收该 owner；普通 WSL 用户进程不受影响。
8. 手机 attach WSL workspace 后断线，确认仅 attachment 释放，桌面 Host/Agent 继续；关闭 App 后再整体退出。

仓库机械验证：

```sh
pnpm typecheck
pnpm lint
```

## 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| update/app quit 变慢 | Hosts 并行等待；正常退出事件驱动，只有异常进入 deadline |
| timeout 层级倒置导致上层先杀下层 | 统一预算常量并测试严格顺序：Agent < server < Host < app |
| 重复窗口/app/update dispose | single-flight + process 对象去重 + registry 先摘除后 await |
| 误杀用户 WSL 进程 | 禁止 distro terminate；ownerId + PID start time + env + executable 多重校验 |
| 手机断线误杀 Host | mobile attachment 与 Host owner 分层，bridge dispose 测试 |
| SSH/Docker 回归 | 统一接口兼容旧 `dispose()`，分别覆盖 backend 行为 |
| main 持有业务状态 | manager 只持 Host/session 生命周期，不持 task/queue/snapshot |

## 实施顺序

1. 先补 Desktop Main app/update shutdown barrier 的失败测试。
2. 实现 remote session manager `disposeAllAndWaitForAppShutdown` 与 Host 去重/幂等。
3. 补 Host/server phase timeout 失败测试，修正 shutdown 顺序和 disconnect 收口。
4. 增加 `RemoteConnection.disposeAndWait`，补连接建立失败 cleanup。
5. 让 WSL backend 跟踪并有界回收自己启动的 child。
6. 增加 owner registry 与严格校验 reaper。
7. 回归 desktop continuous、mobile replayable、SSH pool、Docker/server remote。
8. 完成真实 WSL 运行态验证、`pnpm typecheck`、`pnpm lint`。

## 验收标准

- 正常关闭窗口、退出 App、更新安装三个 owner teardown 路径均能证明对应 ZCode Host/server/Agent
  在 deadline 内退出。
- 托盘隐藏、最小化、renderer reload 和手机断线不会终止仍属有效 owner 的 runtime。
- shutdown 任一阶段 pending/throw 都不会阻止后续 cleanup phase 被尝试。
- WSL distro 保持可用，非 ZCode 用户进程不受影响。
- 不产生新的 PPID 1 ZCode Agent；合法 owner registry 的历史孤儿可在下一次连接时安全回收。
- typecheck、lint 和相关单元/集成测试全部通过。
