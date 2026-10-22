# PiP Session Coordinator v2：关联窗口组合捕获

## 目标

v2 延续 v1 的 session/turn authority，只修正 macOS native window 与 PiP presentation
身份混用的问题。一次键盘或元素动作可以打开 attached sheet/dialog；它有独立 CGWindowID，
但仍属于原顶层窗口的同一个 PiP presentation。

```text
actual window 2310 (root) ───────────────┐
                                          ├─ presentationWindowId=2310 ── one PiP
actual window 2324 (attached sheet) ─────┘                            composite

actual window 2400 (independent root) ───── presentationWindowId=2400 ── second PiP
```

CUA 工具的 state/frame 继续绑定实际窗口；只有 PiP presentation 使用逻辑根窗口。不得按快捷键名、
工具名或 `include_screenshot` 推断关联关系。

## Capture binding

`PipCaptureTarget` 新增可选 `presentationWindowId`：

```ts
type PipCaptureTarget = {
  windowId: number;              // 本次实际聚焦/操作的 surface
  presentationWindowId?: number; // 可证明的同进程逻辑根；缺失时等于 windowId
  pid: number;
  bundleId: string;
};
```

macOS capture 从已选 AX window 沿 `AXParent` 最多向上 8 层。只接受同 PID、非零 CGWindowID 的
祖先；取最外层有效祖先作为 presentation root。循环、超时、跨进程、无 ID 或读取失败均退回
实际 window ID。Linux/Windows 保持 `presentationWindowId === windowId`。

macOS 14.0/14.1 没有 ScreenCaptureKit `includeChildWindows`，因此同样保持
`presentationWindowId === windowId` 的 v1 独立 surface 展示；只在 macOS 14.2+ 合并身份与像素。

`window.window_id`、截图 frame provenance、输入目标和 post-action state 都继续报告实际窗口，
`presentationWindowId` 不进入模型可见 window DTO。

## Strict native ABI

公开协议升级为 version `2`、runtime id `zcode-cua-pip-session-v2`。Helper handshake 只有在 native
提供 `pipStartVerifiedCompositeAsync` 时才 ready；缺少该 ABI 时关闭 Auto-PiP，禁止回退 v1
`pipStartVerifiedAsync`。

Composite start 参数固定为：

```text
(presentationWindowId, windowId, pid, bundleId, width, height, group)
```

Native panel registry、dismissal 与容量按 `(group, pid, presentationWindowId)` 建 key；controller
另存最新实际 window ID，用于双击激活与诊断。

## Native presentation state

- 新 presentation：解析 presentation root 的 `SCWindow`，创建 `includeChildWindows=YES` 的
  ScreenCaptureKit filter。
- 同 presentation、同 actual window：刷新 filter 并 promote，不创建 panel。
- 同 presentation、actual window 变化：推进 capture generation、刷新 root filter 和 actual
  activation target；新首帧前保留旧末帧。
- 不同 presentation root：按既有 multi-panel 规则新建面板。
- sheet 关闭后下一次 root capture 仍命中同一 presentation，并刷新为 root-only 画面。

当 root 与 actual 不同而 composite filter 无法建立时，已有 panel 保留末帧；没有 panel 时放弃
Auto-PiP。不得把 actual child 作为第二个 panel 启动。PiP 失败不改变 CUA 工具结果。

## Presentation admission ordering

PiP session mode owns one producer-side presentation scheduler. Coordinator 仍同步校验
focus revision、turn sequence 与 capture binding，但 native presentation start 必须经过 scheduler
串行化；同一 turn 内并行到达的不同 presentation 不能直接竞争 native 的单 worker admission。

```text
new turn ── synchronous cancellation barrier (pipBeginTurn)
                         │
                         ├── invalidate the previous native start generation
                         ├── remove queued captures/terminal for the previous turn
                         └── release the mailbox wait for the superseded capture
                                              │
                                              ▼
coordinator ── capture(root) ── capture(sheet/root) ── terminal
                         │                  │
                         └── same key coalesce latest actual window
                                          │
                                          ▼
                             one native start at a time
```

- capture key 为 `(sessionId, turnId, pid, presentationWindowId)`；排队中的同 key 只保留最新
  actual window。
- completed terminal 排在此前已接受 capture 后；failed 与 closed 保持在 in-flight
  start 收口后执行 native terminal effect，禁止晚到面板复活。
- 新 turn 是例外的同 session cancellation barrier：`pipBeginTurn` 必须在 lifecycle ACK
  之前同步执行，用 native generation 作废旧 start，并取消旧 turn 的排队 capture/
  terminal。不得把 begin-turn 排在可能永不 settle 的 capture Promise 后；否则协议会
  返回 `applied=true`，原生窗口却一直停在上一轮绿勾。
- 如果 `pipBeginTurn` 抛异常，barrier 没有建立：必须中断旧 active capture，不能提交
  新 turn 的 coordinator 状态，也不能返回 `applied=true`。返回
  `native-reset-failed` 后，同一个 lifecycle event 可以重试；失败期间新 turn 的
  capture 绑定按旧 turn 状态拒绝，避免 ACK 与 native 生命周期分叉。
- native busy/false 只做有界重试，不得调用全局 `pipStop`，也不得推进另一个 in-flight worker
  的 generation。
- focus group 切换保持立即执行，不受 presentation admission 队列阻塞。
- scheduler 最多保留 64 个唯一 capture；超限优先丢弃最旧后台 capture，lifecycle control 永不
  丢弃。该降级仅影响 Auto-PiP，不改变 CUA 工具结果。

Native start admission 必须先取得单 worker slot，再推进 request generation；worker 在 Promise
settle 前释放 slot。只有 `pipStop`、`pipBeginTurn`、全局禁用等明确 lifecycle cancellation 可以
让已 admission worker 的 generation 失效。

## Explicit attached-surface resolution

显式 `window_id` 不得只搜索 `kAXWindows`。macOS 依次检查 top-level windows、focused/main
window，并在同 PID、8 层、64 节点的有界 surface-container 图中寻找请求的 CGWindowID；命中后
再沿 `AXParent` 计算 presentation root。NSOpenPanel、sheet、dialog、popover 即使没有列在
`kAXWindows` 中，只要 AX 关系可证明，也必须归到父 presentation。无关系的 CG-only/custom
window 继续以 actual ID 独立展示，禁止按几何、标题或 bundle 猜父子关系。

## Pointer promotion ordering

accepted pointer-down 先在 event-tap 线程内只更新受 `g_pip_stack_mutex` 保护的 lead 顺序，再异步
在 AppKit 主线程执行 `orderFrontRegardless`。异步提交按 membership、running、group visibility
与 visibility epoch 复核，不依赖会随 drag/up 推进的 interaction generation。内部 arbitration
顺序与 WindowServer 视觉顺序最终必须一致。

## 验收

- `Cmd+Shift+G` 轨迹中的 `2310 -> 2324` 只产生一个 presentation。
- attached sheet 与父窗口同时出现在 composite PiP；sheet 关闭后同一 panel 恢复父窗口。
- 同 PID 的两个独立顶层窗口仍产生两个 panel。
- 双击激活最新 actual window；关闭写入 presentation-root dismissal。
- 重复 post-action settle、乱序晚帧和快速 sheet 开关不新增 panel、不闪回旧画面。
- 同一 turn 并行捕获两个独立 presentation，最终恰好出现两块 panel；busy admission 不丢整组。
- 旧 turn 的 native start 不 settle 时，新 turn ACK 之前已清除完成徽章，新 capture 不被旧
  Promise 阻塞，旧 terminal 不得晚到重新加上绿勾。
- native reset 抛异常时，新 turn 返回 `native-reset-failed`，旧 capture mailbox 被释放；
  coordinator 不消费该 event 的 sequence/eventId，重试同一 event 可在 reset 成功后提交。
- 显式捕获 root、未列入 `kAXWindows` 的 attached panel、独立顶层窗口，presentation 数量为 2。
- 点击任一可见 panel 后，它同时成为 native lead 与 WindowServer front panel。
