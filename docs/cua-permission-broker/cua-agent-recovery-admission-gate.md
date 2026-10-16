# CUA Helper 恢复期 Agent 启动准入规范（历史方案，已废弃）

> 本文记录的 `beginRecovery -> recycleUntilStable -> disposeWorkspace` 方案已被
> `2026-09-02-helper-lifecycle-agent-runtime-isolation-spec.md` 的 P0/P2 取代。当前默认装配不再把
> Helper recovery gate 注入 Agent process manager，Helper ready/recovery 不得阻塞、回收或重启 Agent。
> 文中流程仅供事故复盘，不得作为新实现依据。

## 背景与问题定义

3.9.1 在 Windows 上出现“升级后无法对话/历史会话全部打不开”。工单
`ZCT-2092090611952312320` 与 `ZCT-2092131182991814656` 的共同特征是：Helper 冷启动或恢复期间，
Agent 已经被拉起但拿到 `BROKER_UNAVAILABLE`，随后 Helper ready 触发回收；UI、warmup 和恢复回收又同时
申请新的 Agent，导致旧 client 被 dispose 后仍有启动中的 promise 写回进程池。结果是同一 workspace
短时间内反复 spawn/`workspace-dispose`，conversation protocol client 处于 disposed 状态，中央内容区和输入框都无法使用。

这不是 Windows 专属的协议问题。Windows 没有 POSIX `.pending` rendezvous，Helper 与 Agent 的启动窗口更
容易暴露；macOS 仍可能在 Helper 首次 ready、凭据轮换和 workspace dispose 同时发生时触发同一竞态。因此准入
屏障放在 Host/Agent 共用层，不能放在某个平台的 Helper transport 实现里。

## 目标与非目标

目标：

- Helper 恢复/凭据轮换开始后，禁止新的 Agent child process spawn；已经在解析 command/env 的启动请求必须在真正 `spawn()` 前重新检查准入。
- 同一 workspace 的并发启动继续合并为一个 promise；workspace dispose 不能把尚未完成的启动 promise 从追踪表中遗失。
- 恢复回收完成并提交当前 generation 后，准入一次性打开，后续 Agent 从新的 Helper 凭据启动。
- 保持 fail-closed：恢复失败时不放行带有旧 broker 状态的 Agent；请求返回可重试错误，由现有 UI 有界重试兜底。
- desktop 使用 `continuous` 实时链路，web remote 使用 `replayable` 恢复链路；本规范不改变两者的消息投递边界。

非目标：

- 不在 UI 增加新的无限重试循环，也不把 task/session 状态下沉到 relay 或 Main。
- 不通过延长 Helper cold-start grace 掩盖竞态；Helper ready 仍由现有 watchdog/reconcile 触发回收。
- 不改变 Windows named pipe 或 macOS POSIX rendezvous 的协议格式。

## 状态与事件顺序

Host 内每个共享 CUA Helper 对应一个 admission gate。Gate 只保护 Agent child process 的 spawn，
不阻塞 Helper 自身的启动/停止。

```text
                  beginRecovery(epoch)
       +----------------------------------------+
       |                                        v
   +--------+   close gate   +-----------------------+
   | OPEN   | --------------> | RECOVERING(epoch)   |
   +--------+                 +-----------------------+
       ^       commitRecovery / failRecovery |  ^
       |                                      |  |
       +--------------------------------------+  |
       waitForSpawnAdmission()                 |
       - OPEN: resolve                         |
       - RECOVERING: queue                      |
       - stale generation/dispose: reject      |
```

恢复与启动的正确顺序为：

```text
Helper unavailable/credentials rotated
        |
        v
gate.beginRecovery()  --->  disposeWorkspace() increments generation
        |                                      |
        |                                      +--> in-flight start cannot spawn
        |                                           and remains tracked until finally cleanup
        v
registry.recycleUntilStable(dispose, guardedCommit)
        |
        +--> all registered workspaces disposed
        +--> revision stable
        +--> guardedCommit() attempts to publish the current generation
        |
gate.commitRecovery() ---> queued starts re-check generation/env, then spawn once
```

## 实现契约

### 1. Host admission gate

- `beginRecovery()` 返回递增 epoch；重复 begin 不打开或重置已有恢复期。
- `waitForSpawnAdmission()` 是 Agent process manager 的可选 hook，在 `spawn()` 前调用。
- `commitRecovery(epoch)` 只对当前 epoch 生效，并释放等待者。
- `failRecovery(epoch, error)` 释放等待者为失败；下一次请求仍需经过 `resolveSpawnEnv` 的 fail-closed 检查。
- gate 不持有 workspace/session/task 数据，不参与 desktop continuous 或 web replayable 的 snapshot/queue 逻辑。

### 2. Pending start 与代际 fence

- `startingByWorkspaceKey` 是 workspace 级单航道；dispose 只能使 generation +1，并保留正在进行的 promise 直到其 finally 清理。
- start promise 在 command/env resolve 后、真正 `spawn()` 前依次检查：manager 未 dispose、workspace generation 未变化、admission gate 已打开。
- 任何检查失败都不得创建 child process，也不得把旧 promise/client 写入 `processesByWorkspaceKey`。
- dispose 后的新请求在旧 promise 结束前继续复用该 promise，避免第二条 spawn 航道；旧 promise 退出后，下一次请求才建立新的 start promise，且 finally 只能按 promise identity 清理 map entry。

### 3. Recovery 收口

- `recycleUntilStable` 仍以 workspace registry revision 作为稳定条件；consumer 用 guarded commit 同时打开 gate 和提交 Helper marker。
- gate 关闭后新的 `getClient` 会在 command/env resolve 前等待，因此不会继续制造 registry revision；只有已经进入 resolve 的旧请求可能贡献一次额外 pass，随后在 stable revision 上提交。
- registry 的重复 admission 语义由 producer 继续维护；本修复不改 Windows named pipe 或 producer 包版本，避免把消费端恢复修复和 CUA producer 发布耦合。
- producer 的 `commitRecovery` 当前是 `void` 回调，且 spawn-env 的 Healthy⇒clear 可能在 producer 下一轮读取前清掉 marker。因此 gate 不能等待“producer 一定再次 callback”作为开门条件，否则会形成永久 active 的死锁；当前 gate 仍在 consumer 侧按 commit/fail 路径收口。
- stale generation 的 commit 可能让 gate 比 producer 最终收口早一个短窗口打开。该窗口不会下发旧 socket/token，但可能产生额外 `BROKER_UNAVAILABLE` Agent；这是 P2 观测项，不在本修复中引入新的跨仓契约。
- 若 recovery 抛错，gate fail-closed，记录一次 warning/error，交由下一次请求和现有 UI bounded retry 恢复；不得在 Host 内启动后台无限重试。

### 4. 跨平台与消息链路

- Windows：named pipe 没有 `.pending` rendezvous，必须依赖 Host admission gate 防止 Agent 早于 Helper ready spawn。
- macOS：POSIX rendezvous 仍保留，用于减少 cold-start 竞态；gate 作为共享恢复屏障，覆盖 Helper 重启/凭据轮换窗口。
- desktop `desktop-continuous` 不拼接 web replayable 的恢复消息；web `web-remote-replayable` 继续通过 snapshot/gap 恢复。

## 验收与观测

至少覆盖以下回归场景：

1. gate 关闭时并发 `getClient` 只能保留一个 pending start，Helper commit 后只 spawn 一个 Agent。
2. command/env resolve 挂起期间执行 `disposeWorkspace`，恢复后旧 start 不 spawn；随后新请求可以成功 spawn。
3. recovery commit 失败时等待者收到错误，且不会 spawn 带旧凭据的 Agent。
4. Windows 与 macOS 使用同一 gate 行为；平台差异只在 Helper transport/rendezvous 层。
5. 已有 desktop continuous 与 web remote replayable 的 session realtime 测试保持通过。

生产日志应能按 workspaceKey/epoch 关联以下一次性生命周期事件：`recovery_begin`、`spawn_admission_wait`、
`recovery_commit`/`recovery_fail`、`spawn_blocked_by_generation`；commit 日志同时记录 admission 是否确实释放。
不要仅用两次 admission 日志之间的 spawn 数量判定 stale generation，必须结合 generation 或 marker 证据。
逐条 stream/chunk 仍使用 debug，避免日志量级膨胀。
