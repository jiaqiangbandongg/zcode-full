# PermissionRequest Hook 与审批交互竞速（Permission Responder Race）

成熟度：`L3 Implementation Contract`。本文修订 `hooks.md` 决策优先级第 7/8 条与
`permission-broker.md` 运行时流程第 4 步的执行时序；两处旧文以本文为准。

## 背景（事故根因）

2026-08-26 实机事故：用户配置了同步 `PermissionRequest` command hook（vibe-island
桥接，matcher `.*`），该 hook 的实现是把权限请求转投到外部 UI 并**阻塞等待外部点击**。
旧时序下这是死锁：

```
core (permission-flow)            UI (v4)                     hook (vibe-island)
──────────────────────            ───────                     ──────────────────
emitPermissionRequested ────────► 确认窗已渲染
                                  （应答通道尚未建立）
await runPermissionRequestHooks ────────────────────────────► 外部 UI 展示，阻塞等待
        │                         用户点击 Start
        │                         resolveInteraction ──► ✗ no pending interaction（静默丢弃）
        ▼
（仅当 hook 无决定返回后）
permissionBroker.requestPermission ► 注册应答 deferred        ← 通道到这里才建立
```

三个叠加缺陷：

1. **时序缺陷（本文修复）**：确认窗对用户可见（`emitPermissionRequested` 已发出）与
   应答通道建立（broker 注册 interaction deferred）之间，串行夹着一个无上界的第三方
   hook。窗口期内的所有应答都被 `resolveInteraction` 按幂等语义静默丢弃。
2. hook 卡死时无任何逃逸：确认窗永久死亡，turn 永久挂起。`alwaysAsk` 的工具
   （`CreateWorkflow`）在任何权限模式下都走 ask 路径，因此必然暴露。
3. 残余风险（本文不修，见文末）：runner 在执行 hook 回调前 `await` 发出
   `HookRunStarted` 事件（`runner.ts`），该 await 不受 hook 超时保护；事件管线
   卡死时 60s 超时也救不回来。

## 设计决策

| 分叉 | 决策 |
|---|---|
| hook 语义 | 保留决定能力（allow/deny/modify），**不**改成纯通知的 async hook——那会让外部 UI 的点击永远无法回传决定 |
| 执行时序 | hook 链与 broker 等待**并发竞速**，先到的决定生效 |
| 首个决定 | 单一 settled 闩；晚到方的结果作废 |
| 败者处理 | 立即 abort（AbortSignal 传播到 hook 子进程 / broker 反向 RPC），**不等待**其收尾——等待会把卡死的 hook 重新变成阻塞点 |
| hook 链失败/超时 | 视为「该应答方退赛」：warn 日志 + 继续等 broker，**不再**转成 deny。辅助应答方的故障不应替用户做拒绝决定 |
| 无 hook 配置 | 竞速退化为 broker 单边等待，行为与旧路径逐字节等价 |
| 策略型强制拒绝 | 归属 `PreToolUse` hook（在确认窗出现前即可 deny，不参与竞速）；`PermissionRequest` hook 的定位收敛为「另一个应答面」 |
| 败者外部 UI 收尾 | v1 仅靠 abort → 子进程终止；外部集成应把「被终止」理解为「已在别处应答」。独立的 `PermissionResolved` 通知型 hook 事件留作后续 |

## 新时序

```
core (permission-flow)            UI (v4 / TUI)               hook (外部应答面)
──────────────────────            ─────────────               ──────────────────
emitPermissionRequested ────────► 确认窗渲染
        │
        ├─ 并发启动 broker 等待 ─► 应答 deferred 已注册（点击随时可达）
        ├─ 并发启动 hook 链 ──────────────────────────────────► 外部 UI 展示
        │
        └─ await 先到者 {hook 决定, broker 应答, broker 超时/取消}
                                  用户点击 Start
                                  resolveInteraction ──► ✓ 命中 deferred，竞速收口
        abort 败者 ───────────────────────────────────────────► hook 子进程收到 abort
emitPermissionResolved ─────────► 确认窗消除                   （外部 UI 应自行消除）
```

状态机（单次 ask 的竞速闩）：

```
            ┌─────────────── racing ───────────────┐
            │  hookPending: true   brokerPending: true │
            └──┬───────────┬───────────┬────────────┘
   hook 决定先到│   broker 应答先到│    broker 拒绝/超时/取消│
               ▼               ▼                     ▼
        settled(hook)    settled(broker)      throw（沿用旧 catch → deny）
        abort broker     abort hook           abort hook
               │               │
   hook 无决定/失败：不迁移状态，仅剩 broker 单边等待（hookPending: false）
```

## 契约

新增 core 内部模块 `packages/core/src/tool/executor/permission-responder-race.ts`：

```ts
interface PermissionResponderRaceInput {
  /** hook 链：resolve undefined 表示无决定（退赛）；抛错同样按退赛处理并回调 onHookFailure。 */
  runHooks: (signal: AbortSignal) => Promise<PermissionBrokerResult | undefined>;
  /** broker 等待：注册应答 deferred 必须在本函数调用内同步完成（既有契约）。 */
  requestBroker: (signal: AbortSignal) => Promise<PermissionBrokerResult>;
  signal?: AbortSignal;          // 外层 turn 取消，abort 双方
  onHookFailure?: (error: unknown) => void;   // hook 链抛错且 broker 仍在等待时回调（warn 日志）
}

interface PermissionResponderRaceOutcome {
  result: PermissionBrokerResult;
  source: "hook" | "broker";
}
```

语义细则：

- `requestBroker` 拒绝（超时、取消、无 broker fail-closed）且 hook 尚未胜出时，
  原样上抛并 abort hook 链——与旧路径的 catch → deny 错误形态一致。
- hook 胜出后 broker 被 abort 产生的拒绝必须吞掉（那是我们自己的取消）；反之亦然。
- 败者的 promise 不被 await：必须挂 `catch` 防 unhandled rejection，其收尾由
  hook 超时（60s 默认）与 abort 传播兜底。
- `modify` 决定只可能来自 hook 胜出（broker 的 modify 走既有路径），沿用
  `recheckPermissionHookModifiedInput` 的修改后输入重校验。

## 兼容性与行为变化

1. **hook 链抛错不再 deny**（行为变化，有意）：旧路径 `runPermissionRequestHooks`
   抛错 → catch → 整次调用按 deny 失败。新路径记 warn 后继续等用户。理由：
   runner 已经把单 hook 失败/超时收敛为「无决定」，能抛到这一层的只剩基础设施
   故障（事件管线、admission 崩溃），它们与用户的审批意愿无关。
2. **TUI 提示可能先出现再被 hook 决定消除**：旧路径 hook 先行，hook 有决定时 TUI
   永远看不到提示；新路径 broker 立即启动，提示先出现、hook 决定到达后按
   `PermissionResolved` 消除。v4 桌面端本来就先渲染（事件先发），故此行为只是把
   两类客户端拉齐。broker 实现必须继续遵守「支持 AbortSignal、abort 清理 pending
   提示」的既有契约（`permission-broker.md`）。
3. **策略语义**：用户点击可能快于 hook 的 deny 决定。需要「用户不可越过」的强制
   拒绝必须用 `PreToolUse` hook（在 ask 之前生效）或 permission deny rule 表达；
   `PermissionRequest` hook 从此不保证先于用户应答。

## 测试要求

executor 级（`packages/core/tests/permission-responder-race.test.ts`）：

- hook 链永不返回时，broker 的 `requestPermission` 仍被立即调用（应答通道先于
  hook 完成建立——事故场景的直接回归）。
- hook 未决出期间 broker 应答 allow：工具执行，hook 链收到 abort。
- hook 决定 allow/deny 先到：broker 收到 abort，结果按 hook 决定收口，
  `PermissionResolved` 事件正常发出。
- hook 决定 modify 先到：修改后输入生效（沿用重校验路径）。
- hook 链无决定（返回 undefined）：完全退化为 broker 单边等待。
- hook 链抛错：warn 回调触发，broker 应答仍然生效，不产生 deny。
- broker 拒绝（无 broker fail-closed / 超时 / 外层取消）：错误形态与旧路径一致，
  hook 链收到 abort。
- 双方同 tick 决出：仅一个胜者，无重复 `PermissionResolved`。

runner 级（既有覆盖，不新增）：hook 超时/取消区分已由
`hook-runner-lifecycle.test.ts` 钉住。

## 残余风险（记录在案，本文不修）

- `InMemoryHookRunner.run` 在 hook 回调前 `await emitHookEvent(HookRunStarted)`，
  该 await 不受 hook 超时保护；事件管线卡死时 hook 链整体冻结。竞速让它不再
  冻结确认窗（broker 单边照常工作），但 hook 链自身的可观测性事件会缺失。
  后续可把 lifecycle 事件发射改为有界或非阻塞。
- 外部应答面（vibe-island 类）在败者路径只收到进程终止信号，没有结构化的
  「已在别处应答」通知；`PermissionResolved` 通知型 hook 事件留作后续提案。
