# Windows Agent 进程树清理状态机

## 背景

桌面 Host 会为每个 workspace 启动 Agent CLI。关闭 workspace、重启 runtime、Computer
Use Helper 凭据轮换以及 App 退出时，都必须回收 Agent 根进程与它派生的 runtime/MCP
后代。Windows 不使用 POSIX process group，而是通过 `taskkill /T` 与经身份复核后的
`taskkill /T /F` 收口进程树。

现有等待路径如下，禁止新增第二套等待语义：

```text
ZCodeAgentProcessManager
  -> ZCodeProtocolClient.disposeAndWait
  -> ZCodeStdioTransport.disposeAndWait
  -> terminateProcessTreeAndWait
  -> waitForProcessTreeTermination
```

非等待式 `terminateProcessTree` 仍用于 best-effort dispose；等待式调用必须在同一条路径
内取得并观察 taskkill flight。

## 已确认缺陷

运行时日志确认了三个互相叠加的竞态：

1. 等待式回收启动 graceful `taskkill /T` 后没有暴露其 flight，等待器无法观察命令完成；
2. `taskkill /F` 已成功且 OS PID 已消失时，Node `ChildProcess.exit` 可能晚 1-10 ms 投递；
   等待器返回成功后，transport 又用滞后的 `exitCode` 把 root PID 追加回残留结果；
3. 多 workspace 共用的进程表查询可能早于新 Agent spawn 启动。新 root 的 cleanup 若复用
   这张旧表会查不到自身，随后正确地 fail-closed，却也因此无法发送 taskkill。

这三项均属于清理状态机实现错误，不是 app 自动更新逻辑，也不是用户仍在运行 ZCode。

## 安全不变量

1. PID 只表示数字，不代表所有权；强杀前必须匹配进程创建身份，或由 Host 持有的受管
   `ChildProcess` live root 句柄证明所有权。句柄例外只适用于 root，不适用于后代。
2. 身份查询失败或超时时，未复核后代与 `unverifiedRootOnly` 必须 fail-closed，禁止向裸 PID
   发送 `/F`。未进入 `unverifiedRootOnly` 且句柄仍确认存活的受管 root 不属于裸 PID。
3. 生前进程树快照仍是 root 退出后认领后代的唯一依据。
4. 非等待式回收不得阻塞 Host 事件循环。
5. 多 workspace 回收必须并发执行，禁止恢复同步或逐 workspace 串行 taskkill。
6. 只有绝对 deadline 到达后仍属于原进程树的 PID 才是 confirmed residual。
7. confirmed residual 必须继续向调用方报错，禁止吞掉真实清理失败。

## 状态机

```text
running
  -> snapshot-query
       |-> query-started-after-root -> verified snapshot
       `-> query-started-before-root -> start fresh query
  -> stdin-eof-requested
  -> graceful-taskkill-in-flight
       |-> os-tree-exited -> wait-child-exit-event ----------> success
       `-> force-deadline
            -> verify-current-identities-in-parallel
                 |-> verified root/descendant -> force-taskkill-in-flight
                 |-> managed root handle live -> root-only force-taskkill-in-flight
                 `-> unverified descendant/root-only -> skip-that-pid-and-observe
                                      |
                                      |-> child-exited ------> success
                                      `-> cleanup-deadline --> confirmed-residual
```

`graceful-taskkill-in-flight`、force flight 和 ChildProcess `exit` 必须并发观察。taskkill
命令返回不等于 Node 已经投递 exit 事件；反之，root exit 也不等于快照中的后代均已退出。

## Deadline 契约

等待式 Windows 回收使用两个上界，最终取更早者：

1. transport 从 `disposeAndWait` 的 cleanup 起点固定一个全链路绝对 deadline，覆盖进程表
   快照、stdin EOF、taskkill 与 exit observation；
2. waiter 仍按已经固定的所有权状态计算本阶段相对 deadline，避免没有信号目标时白等。

```text
transportDeadlineAt = cleanupStartedAt
  + forceBudgetMs
  + windowsTaskkillTimeoutMs
  + boundedExitObservationGraceMs

waiterDeadlineAt = waiterStartedAt
  + remainingForceAfterMs
  + ownedTargetTaskkillBudgetMs
  + boundedExitObservationGraceMs

effectiveDeadlineAt = min(transportDeadlineAt, waiterDeadlineAt)
```

waiter 的 taskkill 预算按已经固定的所有权状态分配：

```text
                         +---------------------------+
                         | 至少一个已验证信号目标？  |
                         +-------------+-------------+
                                       |
                 +---------------------+---------------------+
                 | yes                                       | no
                 v                                           v
waiterDeadline = waiterStartedAt                waiterDeadline = waiterStartedAt
  + forceAfterMs                                  + forceAfterMs
  + windowsTaskkillTimeoutMs                      + boundedExitObservationGraceMs
  + boundedExitObservationGraceMs
```

- `forceAfterMs` 默认 2,000 ms。
- 进程层默认单次 taskkill 上限为 2,000 ms；ZCode transport 的等待式路径显式使用 1,000 ms。
- graceful taskkill 从等待开始即与 force timer 并发，不为 graceful 与 force 两条命令各叠加
  一份 timeout；deadline 只在 force 余量后保留一份终态 taskkill 上限。
- 身份查询不可用且没有任何已验证 identity 时，graceful 与 force 的目标集合都必然为空；此时
  不预留没有对应命令的 taskkill timeout，只保留 force 余量与 exit 观察宽限。
- 只要存在任何已验证目标，waiter 的相对 deadline 就保留完整 taskkill 预算。禁止根据某一时刻
  Promise 是否已 settle 临时缩短边界；但 transport 的全链路绝对 deadline 仍是硬上限，慢快照
  已经消耗的时间不得重新补回。
- `boundedExitObservationGraceMs` 只用于吸收 taskkill callback 与 ChildProcess exit 事件的
  投递差，不得演变为无条件 sleep。
- identity recheck 仍由 force 预算覆盖，不是额外串行时段。
- force 前必须在同一个有界窗口内并发定向复核初始 ownership 中的 root 与每个后代；只有
  CreationDate 仍匹配的 identity 才能进入通用 `/F` 目标集。唯一例外是未进入
  `unverifiedRootOnly`、且原始受管 `ChildProcess` 仍满足 `exitCode/signalCode` 均为 `null`、
  句柄可发送信号并确认 PID 存活的 root：定向复核未完成时允许对该 root 执行 `/T /F`，
  但不得沿该 PID 重新发现或认领后代。单个后代身份复核失败只跳过该 PID，不得阻止其他
  已验证目标收口。
- 多 workspace 共用相同相对 deadline 并行收口，总等待时间不得按 workspace 数量增长。
- transport 在 cleanup 起点固定 `cleanupStartedAt + 2,000 + 1,000 + 250 = 3,250 ms` 的
  deadline，并传给 waiter。即使 CIM 快照与 EOF 已经耗尽 force 窗口，waiter 也只能使用
  这条 deadline 的剩余时间，因此全链路硬上限仍为 3,250 ms，低于 desktop Host 与 server
  stdio lifecycle 的 3,500 ms service-dispose phase。

## 可测试性边界

Windows taskkill runner 是进程层依赖，默认实现仍使用异步 `execFile`。测试可以注入 runner
来控制 started、completed、failed 与挂起时序，但注入不得绕过生产的 PID 身份校验。

必须覆盖：

- graceful taskkill 未完成时不提前报告残留；
- taskkill 完成后 exit 晚 1-10 ms 仍成功；
- 新 root 不复用早于自身 spawn 启动的共享进程表；
- PID 复用或身份查询失败时不向未复核后代或 `unverifiedRootOnly` 发送 `/F`；受管 live root
  句柄例外只能发送 root `/T /F`，不能把后代带入显式 `/F` 目标集；
- 定向 CIM 复核失败时，受管 live root 句柄仍触发 root-only `/F`，而未复核后代被跳过；
- graceful flight 挂起时，force 对本次仍匹配的 root 与后代分别发送 `/F`，并跳过已复用后代；
- deadline 到达且原身份 PID 仍存活时返回 remaining PID；
- CIM 快照耗时超过 force 窗口时，taskkill/exit observation 不得把全链路 deadline 向后重置；
- 多 workspace taskkill 并发；
- workspace restart、App quit 和 CUA Helper 凭据轮换复用同一状态机。

## 诊断

低频清理日志应记录 taskkill started/completed/failed、identity verification 结果、force
skip 原因、exit observation、deadline 与 remaining PID。日志不得包含 prompt、token 或用户
内容。

## 2026-08-24 验证记录

- `zcodeAgentProcessManager.test.ts` 真机权限下连续 10 轮通过：360/360；
- 进程终止器、stdio transport、manager 相关测试集：55 passed / 11 skipped；
- 确定性用例覆盖 taskkill flight、exit 延迟、累加 deadline、PID 复用、身份查询失败与
  共享进程表新鲜度；其中无信号目标的 unverified 分支不预留 taskkill timeout，有已验证
  后代的 unverified 分支仍保留完整 timeout；
- 10 连跑后未发现测试型 Node Agent 孤儿；本轮生成的临时目录在进程退出后均可删除；
- `pnpm typecheck` 与 `pnpm lint` 通过，lint 保留 110 条与本改动无关的既有 warning；
- 无权读取 `Win32_Process` 的受限沙箱会按安全设计进入 unverified fail-closed，Windows
  真机进程树回归必须在具备 CIM 读取权限的测试环境运行。

## 2026-08-25 force 后代回收验证记录

- root 与 descendant 的定向身份复核/force 时序连续 10 轮通过：160/160；
- 真实 Windows 权限下进程终止器、stdio transport 与 Agent manager 清理测试集：
  59 passed / 11 skipped；
- 后代 PID 复用用例确认：不匹配 identity 不接收 `/F`，其他匹配目标仍可并发收口，
  未确认旧身份继续按 fail-closed 上报而不是误判成功。
