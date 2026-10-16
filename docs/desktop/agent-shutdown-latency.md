# Agent Shutdown Latency

## 背景

桌面 App 退出会进入 `before-quit`，main process 等待各 workspace window 的 Local Host 以及仍存活的 Remote Host 完成资源回收。每个 Host 再等待其按 workspaceKey 托管的 ZCode CLI 进程树退出，避免 `zcode-cli` / `app-server` / MCP 子进程在 Windows、macOS、Linux 上残留。

2026-06-12 的运行日志显示，普通关闭从 `waiting for host process cleanup` 到 `host process cleanup completed` 约 2.4s 到 2.7s。静态代码确认主要原因是 `terminateProcessTreeAndWait()` 固定等待 `DEFAULT_FORCE_AFTER_MS + DEFAULT_WAIT_AFTER_FORCE_MS`，即使 agent 进程已经提前退出也不会立即返回。

## 目标

- 正常关闭时优先让 stdio agent 收到 EOF，自行完成协议入口的 shutdown 和 sqlite/session store 收尾。
- 进程已退出时立即结束等待，不再固定吃满 2.25s 兜底窗口。
- agent 无响应时仍按进程树强制回收，防止 runtime/MCP 子进程残留。
- Agent 正常运行期间的 stdio request / response / notification / stderr 热路径不得查询系统进程表；进程清理只能影响退出耗时，不能改变消息吞吐、顺序或 UI 实时性。
- 保持桌面端 `desktop-continuous` 主链路语义；本变更只影响 app 退出后的 host 资源回收，不改变手机 Web 远控 `web-remote-replayable` 的 stream/snapshot/queue 边界。

## Windows 普通退出与更新安装预算

Windows 普通退出属于高频交互，更新安装属于低频且必须释放随包资源锁的严格交接，两者不再
共用同一等待预算：

```text
普通退出 / 重启                    更新安装
  -> Cron 与 Host 并行 dispose       -> Cron 与 Host 并行 dispose
  -> 4s 后强制结束 Host             -> 7.5s 后强制结束 Host
  -> 总屏障最多等待 4.5s             -> 总屏障最多等待 9s
  -> 退出 App                       -> 扫描并清理随包资源引用
                                     -> quitAndInstall
```

- Windows 普通退出包括窗口关闭、托盘退出和普通应用重启；它不执行更新安装的随包资源锁扫描。
- Cron Scheduler 的 1.5 秒收口必须与 Host 清理并行，并纳入同一个退出 Promise；不得先等待
  Cron 再启动 Host timer，否则阶段预算会串行累加为约 6 秒/10.5 秒。Cron 一进入 disposing
  状态必须停止向正在退出的 Host 派发新任务。
- Windows 普通退出的短预算只适用于 Local Host。SSH/WSL/Docker/Bot Remote Host 的关闭
  还包含最长 1 秒的 service dispose 与最长 6 秒的 remote connection dispose，Main 必须继续
  使用 7.5s/9s 严格预算，避免在 Host 既有关闭上界前强杀；该预算是兜底上界，远程 Host
  提前退出时不会固定等待至超时。
- `auto-update quitAndInstall` 必须显式选择 `update-install` policy，继续保留 7.5s/9s 严格屏障。
- 若更新请求晚于已经启动的普通退出，它不得因为无法延长既有 4s timer 而拒绝安装：更新类型
  升级为 `update-install`，尚未调度的清理使用严格预算；既有短屏障完成后继续执行 Windows
  资源扫描并 fail-open 启动安装器。产品接受此极端竞态下可能残留 runtime，更新可达性优先。
- macOS/Linux 暂不缩短，避免把本次 Windows 性能修复扩散到未采集运行时证据的平台。
- 普通退出的 4s 强杀点仍晚于 Host 内部 3.5s 的 service/process-tree 有界清理；不得直接降到
  该内部边界之前，否则可能在 `taskkill` 兜底执行前终止 Host 并重新制造孤儿 runtime。

## 实现约束

- `ZCodeStdioTransport.disposeAndWait()` 先关闭 stdin，触发 `app-server --stdio` 的 input close 路径；短窗口内未退出再进入进程树终止。
- `ZCodeStdioTransport.disposeAndWait()` 必须在发送 stdin EOF 前保存进程树快照；否则根进程先退出后，已脱离或被系统接管的后代无法再通过 PPID 找回。
- 协议先失效，stderr reader 保留到流关闭，child exit 后最多再 drain 250ms，再用旧 runtime 身份生成 exit tail。仅 stderr 失败不关闭健康协议。
- 普通 EOF 宽限为 1800ms，覆盖 CLI 自首个关闭事件起 1500ms 的总退出上限；等待仍扣减原进程树总预算，重复信号不续时。coverage 保留独立的写盘宽限。
- `ZCodeStdioTransport` 的 `send()`、stdout frame 分发和 stderr line 分发只负责协议 I/O，不得调用同步或异步的 `ps`、PowerShell、`taskkill` 等进程管理命令，也不得依据消息 method/type 猜测何时刷新进程树。退出快照只允许在 `dispose()` / `disposeAndWait()` 已开始后获取。
- 进程所有权来自 Host 的 spawn 关系和 Agent 自身的 MCP/process adapter，不来自协议消息活跃度。POSIX Agent 必须继续运行在独立进程组；Windows 继续以 CLI 根 PID 的 task tree 为关闭边界。Agent 正常 EOF 收尾负责先关闭其登记的 MCP 进程树，Host 的退出前快照和进程组/task tree 信号负责强制兜底。
- `terminateProcessTreeAndWait()` 的完成边界是“回收前快照中已归属该 runtime 的进程树全部退出”，不是仅直接 child 退出。根进程先退出时，已发现后代仍必须经过 graceful / force 回收和存活复核；返回值必须显式携带残留 PID，调用方不能把“记录 warning 后结束有界等待”误当成 cleanup 成功。
- cleanup timeout 只是进入“终态观察”的边界，不等于已经证明存在持久残留。所有平台统一按下面的终态判定释放进程所有权；在观察预算内稍晚投递的正常 exit 仍然属于 cleanup 成功，只有截止时仍存活的快照身份才报告 `cleanup incomplete`：

  ```text
  退出前身份快照 -> graceful / force 回收 -> 终态观察预算
                                            |-- 快照身份全部退出 -> success（含 late exit）
                                            `-- deadline 时仍存活 -> remainingPids + 保留 ownership
  ```

  Windows 的快照、EOF、taskkill 和终态观察共享 transport 固定绝对 deadline；没有已验证
  `taskkill` 目标时不得把剩余预算压缩成固定的 250ms，而应在同一绝对 deadline 内为原
  `ChildProcess` / 已固定身份保留最多 750ms 的纯观察窗口。本次新增的纯观察路径与首次
  3.25s cleanup 的最坏组合不超过 Local Host 的 4s 强制退出点；有已验证信号目标的路径
  继续沿用既有 taskkill 绝对 deadline。macOS/Linux 继续使用既有 POSIX force + observation
  上界，本轮没有运行时证据支持扩大其等待时间。

- 进程树快照不能只保存裸 PID：必须同时保存可复核的进程创建标识（Linux `/proc` start ticks；Darwin `lstart + command + PGID`；Windows `CreationDate`）和 POSIX PGID。延迟 graceful / force 回收前必须核对身份；PID 已复用时按“原成员已退出”处理，禁止重新沿复用后的 root PID 查树或向新进程发送信号。Windows force 阶段不得再启动完整进程表查询；必须在原 deadline 内预留固定窗口，对快照中的已知 PID 使用 `Get-CimInstance` 定向复核当前 `CreationDate`。后代只有确认创建身份匹配才允许 `taskkill /T /F`；查询失败、超时或身份不匹配时必须 fail closed。受管 root 是唯一例外：未进入 `unverifiedRootOnly`，且 Host 持有的原始 `ChildProcess` 仍满足 `exitCode/signalCode` 均为 `null`、句柄可发送信号并确认 PID 存活时，可仅对 root 执行 graceful `/T` 或 deadline `/T /F`；不得沿 root PID 重新发现后代或将未复核后代加入 `/F` 目标。
- 系统进程表暂时不可用且尚未取得 root 创建标识时，本轮回收必须 fail closed：不得通过 `ChildProcess.kill()` 或 `taskkill` 向裸 PID 发信号，也不得在延迟 force 阶段重新发现该 PID 的进程树。快照必须显式标记 `identityVerification: "unavailable"`，在既有退出预算内继续观察原 `ChildProcess`；截止时仍未退出则通过 `remainingPids` 报告 cleanup incomplete，禁止把空身份误报为清理成功。
- Agent 的“当前可复用 protocol client”与 Host 的“尚未确认退出的 OS 进程所有权”是两种状态。protocol close 可以立即解除 workspace 的 active client 绑定，但只有 cleanup 确认 root 与已登记树成员均退出后才能释放进程所有权。
- timeout、protocol close、workspace restart 和 app quit 对同一 managed process 的回收必须幂等；失败的 cleanup Promise 不能永久缓存。app quit 必须等待 active 与正在退休的全部 owned process，并对先前报告残留的进程树执行一次直接进入 force 阶段的有界最终重试。
- Windows 在 EOF 前通过系统进程表保存后代快照，继续使用 `taskkill /PID /T` 和 `/F` 兜底；若 root 在 protocol close 前已经退出，cleanup 边界允许沿 Win32_Process 保留的 `ParentProcessId` 找回后代，但候选成员的 `CreationDate` 必须落在 Host 记录的 root 生命周期内，并继续用 `CreationDate` 固定成员身份，避免 root PID 复用后认领无关进程。Windows 10+ 统一使用异步 PowerShell `Get-CimInstance Win32_Process`，同一轮多个 workspace 共享一个 in-flight 查询；CIM 不可用时显式进入 unverified fail-closed。POSIX 继续使用 Host spawn 时拥有的独立进程组和已发现后代进程兜底。
- Windows 对多个 workspace Agent 执行 `taskkill` 时必须使用异步子进程并行等待，禁止用
  `spawnSync` 串行阻塞 Host 事件循环。Host 的 service phase timeout 必须能在清理命令卡住时
  准时触发；异步命令仍需设置单次超时，并在 graceful/force 命令完成后返回明确清理结果。
- Windows 退出快照统一异步执行 `Get-CimInstance Win32_Process`；同一轮多个 workspace 共享一个
  in-flight 查询。查询耗时计入原有 force deadline，不得在查询结束后重新开始计算，否则机器负载
  较高时会把进程表查询时间额外叠加到退出预算。首次成功快照是本轮唯一一次完整进程表查询；
  force 阶段必须复用该快照，只允许对快照中的已知身份执行有界的定向 CIM 复核。
- PowerShell/CIM 命令成功但没有可解析身份、被拒绝、不可用或超时时，返回
  `identityVerification: "unavailable"`，空身份不得表示清理完成。root 在同轮查询期间退出时，
  只有调用方已经提供可信的 `ownedProcessExitedAtMs`，或能在查询完成时从受管 ChildProcess 的
  exit 事件读取该时间，才允许按同轮完整进程表恢复后代；查询完成时间不得代替退出上界。
- 关闭路径日志必须是低频生命周期日志，不能记录 stdio 原始帧或 streaming delta。

## 非目标

- 本轮不修改 Main / Host 的 Dispose 消息协议、app-server 信号处理或启动时孤儿进程扫描。
- 本轮不增加常驻进程轮询，也不从运行期消息流推断进程所有权。当前 MCP adapter 不使用 detached spawn，并在 Agent EOF 收尾时显式回收已登记的 stdio MCP 进程树；若未来新增需要脱离 Agent 进程组的托管进程，必须在对应 spawn adapter 中增加显式 ownership/close 契约，不能恢复运行期进程表扫描。
- 本轮不改变 workspace 与 active Agent 的复用关系，不改变 MCP 配置及 session 连接语义。
- 本轮不改变桌面端 `desktop-continuous` 与手机远控 `web-remote-replayable` 的消息交付边界。
