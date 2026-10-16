# Background Task POSIX Process Tree Stop

## 状态

- 日期：2026-08-14
- 状态：accepted
- 类型：bugfix

## 问题

`NodeExecutionAdapter` 在 POSIX 上以 `detached: true` 启动 execution。旧停止逻辑只向
`-rootPid` 对应的进程组发送 `SIGTERM`，并在 750ms 后向同一进程组发送 `SIGKILL`。

Bash job control、pipeline、`xargs -P` 或 PTY 可以让仍属于 root PPID 后代树的进程进入不同
PGID。只按根进程组发信号时，这些后代不会随 `TaskStop` 或 session close 一起停止。

## 行为合同

本次只实现 POSIX Bash process-tree stop，不改变 Windows、TaskStop 协议、UI、
background notification、desktop continuous 或 web remote replayable 行为。

```text
cancel / close
      |
      +--> 异步读取一次 `ps -A -o pid= -o ppid=`（最多等待 500ms）
      |          |
      |          +--> SIGTERM 根进程组；失败时退化为 root PID
      |          +--> SIGTERM 本次快照中的传递 PPID 后代
      |
      +--> 固定等待 1500ms
                 |
                 +--> SIGKILL 根进程组（best effort）
                 +--> 重新读取一次 `ps`，再 SIGKILL 当次仍挂在 root 下的传递后代
```

必须满足：

1. 每次 process-tree signal 都先用独立、最多 500ms 的 `ps` 快照计算传递 PPID 后代。
2. 每次都先发根进程组信号；组信号失败时回退到 root PID；随后逐个向快照后代发同一信号。
3. 首轮 `SIGTERM` 不阻塞 stop ACK；1500ms 后无条件执行 `SIGKILL` escalation，不提前轮询退出。
4. escalation 使用新的 PPID 快照，不记忆首轮后代，不读取启动时间，也不增加 PID identity 校验。
5. `ps` 启动失败、报错或超时时按空后代集合处理，根进程组/root PID fallback 仍继续。
6. 单次 execution 与 stop ACK 不显式等待 escalation Promise；adapter shutdown 会等待已经登记的
   1500ms escalation timer 及升级轮次的实际 PPID 快照/信号发送，并引用其清理句柄以保活。
   2026-09-08 补充：Bash 直写后不能依赖 pipe 保活，也不能认为单独 await Promise 会阻止 Node 退出。
7. Windows 保持现有 `taskkill /T /F` 路径。
8. 该合同只适用于 `command.shellProfile === "posix-bash"` 的 Bash execution。通用 shell、argv、
   hook 和自定义命令展开继续保持既有 POSIX 进程组停止策略：立即向根进程组发送 `SIGTERM`，
   750ms 后仅在进程组仍存活时发送 `SIGKILL`；不得为这些执行枚举 PPID 后代或登记 Bash escalation。
9. 2026-09-08 当前 Bash 直写合同：root 自然退出即结算，不再进入 foreground pipe drain，
   也不主动清理后代。Bash process-tree stop 只由 task cancel、adapter close、abort/timeout
   和 output limit 等真实终止路径触发；本次 shutdown 保活修复不恢复历史 drain 行为。

## 已知边界

以下边界有意保留，本次不额外增强：

- 首轮 TERM 后已经 reparent、且忽略 TERM 的跨 PGID 后代不会出现在第二次 PPID 快照中，可能继续存活。
- 快照与逐 PID 发信号之间没有 PID/start-time identity 校验。
- 不新增 cgroup、systemd scope、Windows Job Object、额外进程 ownership 或新的 stop surface。

## 验证

- POSIX 真实进程测试：background Bash 通过 job control 创建独立 PGID 的 cooperative worker；
  stop 后 launcher 与 worker 都退出，结果收口为 cancelled。
- POSIX 真实进程测试：generic argv execution 创建独立 PGID worker；取消只停止原进程组，worker
  保持存活并由测试自行清理，证明 Bash 杀树策略没有扩散到通用 ExecutionPort 调用方。
- 当前 Bash 直写回归：root 自然退出即结算，后代仍可写文件并由测试负责收尾；不再要求历史
  foreground Bash pipe drain。通用 argv/Hook 的 pipe drain 与停止策略继续保留。
- 独立 Node 进程回归：abort、close、后台 Stop、timeout、output limit 后调用 adapter close，
  忽略 TERM 的同组 worker 必须终止，且 Node 退出前已完成 close，不能依赖测试框架 IPC 保活。
- 可控时钟回归：1500ms timer 到期后，shutdown 仍须等待异步 SIGKILL 查表与信号发送完成。
- 既有同组后代、通用执行的继承 pipe / foreground drain、adapter close 和 Windows tree-kill
  测试继续保留。
- `pnpm typecheck` 与 `pnpm lint` 必须通过。
