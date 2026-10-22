# macOS 后台输入模式

## 现状（2026-09-16 校正）

本文若干处把 `open_application(activate=true)` 当作前台化/恢复手段（见「重新观察后再派发」
与 Chrome fixture 的验收步骤）。**macOS 面已经没有这个工具**：`open_application` 于
2026-09-11 从 darwin 收缩掉（src/tools/platform-surface.ts），模型手上没有任何激活手段，
`FOREGROUND_REQUIRED` 在 macOS 上因此是不可满足的。真机 2026-09-16（LibreOffice 后台
open panel）证实：`Cmd+Shift+G` 一字不落地被忽略，而侧栏 cell 的 `AXOpen` 可靠。
模型面的 file_panel 引导已改为教 `AXOpen`（src/targeting/format.ts）。下文涉及
「先前台化再按键」的步骤按此校正阅读；要恢复那条 lane，得先补回自动提升能力。

> 2026-08 更新：本文的 native owner、后台投递和 possibly_sent 安全边界仍有效。
> “动作后强制 compact/full state、action_outcome、state_sync_status、delta/no_change
> 解锁屏障”已被 `docs/cua-receipt-observation-contract.md` 取代。当前模型可见动作结果
> 默认是 `zcode-cua-action-receipt-v1`；只有显式 `return_state=compact|full` 时才抓一次
> `force_full` 状态。

## 目标

zcode-cua 在 macOS 上默认不得改变用户当前的系统前台应用、key window、窗口层级或
物理鼠标位置。动作必须显式绑定到一个 live 逻辑应用、presentation window 和实际
surface；证据不足时失败关闭。仅当逻辑应用已经是前台，且 WindowServer 证明普通 OS
hit-test 与截图 surface 完全一致时，允许用 `kCGHIDEventTap` 把事件交给 AppKit 当前
responder；该路径不隐式激活应用。

Linux 与 Windows 继续保持当前平台语义。私有 SkyLight ABI 仅存在于 macOS native
Helper 内，不进入跨平台 MCP schema。

## 状态与时序

```text
MCP target/state_id + actionable frame
    |
    v
AX relationship graph ---> presentation root + attached surface(s)
    |                                      |
    |                                      +-- WindowServer before/after owner proof
    v
pixel -> exact actual owner PID + CGWindowID + live bounds
    |
    +-- stale/replaced/关系不明 --------------------> action_sent=false
    |
    +-- logical app frontmost + OS hit-test == actual surface
    |           |
    |           `-- foreground CGEvent -> AppKit focused sheet responder
    |
    `-- otherwise
                |
                `-- synthetic focus + stamped window fields
                    -> SLEventPostToPid(actual owner, actual window)
```

## 行为契约

1. `left_click` 及其 `click_count` 2/3 与 `mouse_button` right/middle 形态
   共用 surface 路由。后台或存在无关遮挡时使用 window-scoped recipe；
   逻辑应用已在前台且 OS hit-test 精确命中同一 actual surface 时走 foreground CGEvent，
   因为 NSOpenPanel 实测会接受 window-scoped SkyLight event 却不产生 AppKit responder
   副作用。click state 依次为 1/2/3。
2. `scroll`、`left_click_drag` 走相同的
   PID/window 定向事件通道；`left_click_drag` 内部按下会保存目标窗口和虚拟坐标，
   释放必须复用同一目标。模型侧没有独立的按下/移动/释放入口。
3. `type`、`key`（含 hold 时长形态）保留 AX 优先。逻辑应用不在前台时，默认真实键盘事件以
   actual PID/window 后台会话投递；已经在前台时交给 OS 当前 focused attached surface。
   `strategy=event` 本身不激活应用：它只在 logical PID 已前台且 fresh
   `app_ref.window_id` 仍是当前 focused file-panel surface 时走一次全局真实键盘事件。
   需要前台化时，调用方必须先执行
   `open_application(activate=true)`，重新观察后再派发。
   未满足前台/焦点前置条件返回 `foreground_required + action_sent=false`，不能伪装成
   TCC `permission_denied`，也不能静默降级回 window_event。
   Chromium renderer 的 Tab/Enter/组合键也属于该例外：后台 PID/window receipt 不能证明
   renderer 收到事件。已由 fixture 前台复核的工作流必须显式使用精确 `window_id` 和
   `strategy=event`，并以 DOM keydown/keyup/submit 结果验收。
4. `type(target=element)`、`set_value`、`select_text`、`perform_action` 继续优先使用
   AX token。元素 `set_value(strategy=event)` 与第 3 条相同，必须激活并复核精确窗口后
   走全局选择/输入，不能被 background mode 截获；默认/AX 策略仍由 native synthetic
   focus 包裹，不激活系统应用。
5. `open_application` 在 macOS 默认后台打开。唯一前台化例外是调用方同时传入
   `activate=true`，且 `app.window_id` 经 fresh AX/WindowServer
   证据确认为 `open_panel`、`save_panel`，或同一 presentation root 下从文件面板派生的
   `attached_dialog`。该路径激活 logical app、聚焦 exact actual surface 并复核后返回；
   普通窗口、popover、缺 lineage、旧 generation 不得借此前台化。无 URL、非
   `new_instance` 的普通启动继续使用原生
   `NSWorkspaceOpenConfiguration`，固定 `activates=false`、
   `allowsRunningApplicationSubstitution=true`：窗口正常出现在屏幕上（可交互、AX
   可读），但不激活、不抢键盘焦点。注意不能设 `hides=true`：窗口会在隐藏态创建，
   unhide 也
   拉不回屏幕，AX 树遍历超时，且违反本节第 7 条“输入目标必须是 on-screen 窗口”。
   Helper 必须保持请求存活并等待
   `openApplicationAtURL` 的 completion 成功后，才能进入 AX window 后置条件验证；不能把
   “LaunchServices 请求已提交”当成成功提前返回。completion 返回的
   `NSRunningApplication` pid 必须随结果上报 broker——枚举源（NSWorkspace KVO /
   `CGWindowList(OnScreenOnly)`）对刚启动的 app 有数秒滞后，身份解析优先走
   `applicationInfo(pid)` 直查。目标进程已存在但 `AXWindows=0` 时也要
   重新分发，并等待真实 AX window 出现后才返回；否则明确失败，不能让后续观测退化成
   `elements(0)`。整个过程不激活目标，也不通过事后恢复前台应用来掩盖瞬时抢焦点。
6. macOS 上无 `app_ref`/窗口证据的 raw action 一律拒绝；旧 Helper 缺少后台 ABI
   时也拒绝，绝不降级到全局输入。
7. 目标必须是当前 on-screen 且仍属于绑定 PID 的真实窗口。隐藏、最小化、其他
   Space、失效/负 fallback window id 都返回 `action_sent=false`。
8. 已写入 PID、window id 与窗口内坐标的事件只通过 `SLEventPostToPid` 投递一次。
   不得对同一 `CGEventRef` 再调用 `CGEventPostToPid`；双通道会令 Chromium 收到重复的
   `mousedown` / `mouseup` / `contextmenu`，使“工具成功”掩盖重复业务副作用。

## AX 动作后的 receipt 边界

`AXUIElementPerformAction` 等写 API 的返回值不是应用业务状态的事务确认。macOS 可能先把
动作交给目标应用，应用已经新增条目、打开编辑器或改变选择，随后 AX API 仍返回
`kAXErrorAttributeUnsupported`、`kAXErrorFailure` 或 `kAXErrorCannotComplete`。因此进入原生
调用以后，错误只能表示 `possibly_sent`，不能表示“动作没有发生”，也不能触发自动重试。

```text
模型状态 s-N
    |
    v
原生调用前校验 ----失败/target stale----> not_sent receipt
    |                                      仅废弃被证明 stale 的 s-N
    v
进入一次原生调用
    | accepted / possibly_sent
    v
accepted/possibly_sent receipt（retry_action=false）
    |
    +-- return_state=none ----------> 结束，不 capture
    |
    `-- return_state=compact/full --> 一次 force_full capture --> 新状态 s-(N+1)
```

模型可见动作结果现在统一为 `zcode-cua-action-receipt-v1`：

- `dispatch_status="accepted" | "possibly_sent" | "not_sent"` 只描述派发事实；
- `retry_action=false` 禁止宿主或模型原样重放非幂等调用；
- 默认 `return_state="none"`，不再隐式 capture、settle 或等待状态屏障；
- 显式 `return_state="compact" | "full"` 只执行一次 `force_full` observation；
- receipt 排在长 AX tree 前，避免宿主截断时丢失防重放证据。

元素动作只废弃本次 target 引用的 `pre_state_id`；相同 app/window 的其它 state 不受
scope-wide 写锁影响。坐标 hit-test 产生的 fresh native token 没有 `pre_state_id`，因此
不会误废弃最近状态。`possibly_sent` 对 element、coordinate、drag、mouse down/up 和
keyboard 使用同一 receipt 契约，不再退化为 `CUA_NOT_READY` 后让模型猜测是否重放。
缺失 pid/bundle/name 的 mutation scope 仍必须在派发前以 `action_sent=false` 拒绝。

contextual AX 的 synthetic-focus 只是一项派发前置条件。若它明确返回
`action_sent=false`，允许绕过该前置条件直接执行一次 AX；一旦 wrapper 已调用原生动作或
派发事实不明确，不得 fallback、重新解析 token 或再次 AXPress。

## 兼容与风险

- SkyLight 是私有 ABI，系统升级可能使 capability 不可用；运行时逐符号探测并明确
  报错，不做全局回退。
- “后台”不等于可操作无渲染窗口。窗口可被其他窗口遮挡，但必须仍在当前 Space 且
  WindowServer 标记为 on-screen。
- 目标应用仍可能拒绝合成输入。动作成功只代表事件已定向投递；最终效果由既有
  post-action observation 验证。
- producer 与 Helper 不支持混版本。安装新 producer 时必须用同一 build id 的 bundled
  Helper 覆盖旧安装；启动校验不通过则明确失败，不在动作路径兼容旧 wire payload。

## Begin 失败诊断

后台键盘会话的 begin 不能只返回一个布尔值。布尔值会把 session busy、AX 未授权、
SkyLight 符号缺失、窗口不在当前 Space、窗口 owner/bounds 变化、`GetProcessForPID`
失败以及 synthetic-focus record 被 WindowServer 拒绝全部压成同一条错误，运行时无法
区分“目标 stale”和“私有 ABI 失效”。Helper 的 additive detailed ABI 必须返回：

- 稳定的 `reason`；
- `native_status`（仅底层 SPI 返回状态码时有值）；
- `pid`、`window_id`、预期 bounds；
- 能读到时的 live owner、on-screen 和 live bounds；
- SkyLight 缺失符号列表。

```text
MCP key/type/hold
    |
    v
beginBackgroundWindowInputDetailed
    |
    +-- parse/AX/SkyLight/live-window/focus-record 分支
    |                         |
    |                         v
    |              { ok:false, reason, evidence }
    |                         |
    |                         +--> Helper warn 日志
    |                         +--> BrokerError.details
    v
verified PID keyboard dispatch（仅 ok=true 时执行）
```

失败发生在 verified keyboard dispatch 之前，因此所有 begin 失败必须保留
`action_sent=false`。旧 addon 没有 detailed ABI 时继续 fail-closed，并以
`legacy_unclassified` 标记为不可精确分类，不能伪装成某一个具体 native 原因。

## End 失败诊断

同一条论证适用于收尾：布尔值会把 session 不匹配、合成焦点解除失败、真实前台变化、
物理光标移动压成一条错误。detailed end ABI 必须返回稳定 `reason`、`native_status`、
`pid`/`window_id`，以及派发前后各量一次的 frontmost pid 与 physical cursor。

end 发生在 verified dispatch **之后**，因此每一种 reason 都必须按 `action_sent=true`
解读，绝不能让调用方把它读成“动作没送达、可以重试”。

**键盘路径不把 `frontmost_changed` / `cursor_moved` 当失败。** 理由是这两个量本路径
改不动：app-scoped 键盘走 `CGEventPostToPid`（pid 定向投递），既不移动系统光标，也不
调用 `SetFrontProcess`。所以观测到的漂移只有两个来源——

1. 用户自己动了鼠标（收尾含 100ms + 40ms 等待，人手一碰即触发）；
2. 目标 App 对按键的正常反应，例如 `escape` 关掉菜单后该 App 交还前台。

第 2 种情况下，动作越是生效，校验越是失败。把它们报成失败会让模型认为按键没送达并
重试，造成重复输入。因此：记 `warn` 日志与遥测，工具结果仍为成功。

`session_mismatch`、`unfocus_record_failed`、`action_failed` 与各类
`*_unclassified` 继续报错——它们是真实的状态泄漏或不可分类风险，只是必须报出确切
reason，而不是笼统的“invariant changed”。指针路径仍沿用原策略，未随本次变更调整。

## 验收

- broker 单测证明五种 click profile 在后台全部选择 window-scoped ABI；逻辑应用已在
  前台且 actual surface 同时通过 WindowServer hit-test 时才选择 foreground ABI；无关
  遮挡存在时不走全局路径。
- scroll/drag/mouse hold 单测证明 app/window scope 始终保留且无全局 fallback。
- Chromium keyboard 单测证明不再激活或全局发送。
- native 源码测试锁定私有符号、字段、click recipe、target-only focus 和 fail-closed。
- 实机以一个保持前台的观察应用为基线，对后台 Calculator/TextEdit/Chromium 执行动作，
  比较动作前后 frontmost PID、物理 cursor、窗口 bounds/order，并验证目标状态变化。
- broker 单测证明键盘 end 的 `frontmost_changed` / `cursor_moved` 只记日志、不改变工具
  结果，而 `session_mismatch` / `unfocus_record_failed` 仍然 fail-closed 且报出确切 reason。
- **实机验收必须包含「派发期间人为移动鼠标」和「目标 App 菜单打开时按 escape」两档。**
  只在无人触碰机器的静默环境下验收，会让 frontmost/cursor 不变量看起来永远成立——
  下方 2026-08-13 的证据就是这样通过的，而实机反馈里同一条路径 7 次调用失败 6 次。
- AppKit fixture 必须使用 `NSOpenPanel.beginSheetModal(for:)` 真正建立 modal response，
  验证 `Cmd+Shift+G` 子 surface、完整路径、默认确认按钮状态和确认关闭，再由应用内
  oracle 校验精确文件；目标 lane 不超过 15 次 CUA 调用，且不得调用 `osascript`。
- Chrome fixture 必须从后台 `open_panel` 开始，经双确认 `open_application` 前台化 exact
  surface 后完成 `Cmd+Shift+G`、路径输入、Enter 和确认；页面 AX/DOM 文本是最终 oracle，
  整条被测路径不得用 CDP/Playwright 设置文件。

## 2026-08-23 文件面板实机证据

- presentation root、NSOpenPanel 和 `Cmd+Shift+G` 子 sheet 分别解析为三个真实 window id，
  且共享同一个 presentation root。
- 8 次 CUA 调用完成完整路径输入、目标文件选择与确认关闭；应用内 oracle 返回
  `response=ok`、`target_selected=true`，`osascript_calls=0`。
- 确认点击的 outcome 报告 actual panel owner/window 和 `surface_kind=open_panel`；
  文件面板关闭后回到同一 presentation root。

## 2026-08-24 文件面板差异 E2E

- M14–M16 三个独立 task pack 分别锁定坐标 surface 路由、panel 代际键盘身份和
  state-only 坐标权限；均使用真实 AppKit NSOpenPanel 和原生 MCP 调用。
- M14/M15 在前台原始键盘步骤前显式执行 `activate=true`，
  直接覆盖“重新激活后立即输入”的恢复路径；`return_state:none` 仍必须返回实际
  dispatch surface 和不可重试 outcome。
- `main@e0d27a36`：M14/M16 无法交付 actionable panel raster；M15 的 Escape 返回
  成功文本但 panel 不关闭。
- 修复分支：M14、M15、M16 的 blocking checks 全部通过；`osascript_calls=0`。
- M16 额外证明普通 panel 点击只返回 `accepted/not_proven`，不会因 settle 中短暂捕获
  presentation root 而误报 panel 已关闭。

## 2026-08-13 实机证据

- 后台 Calculator（PID 23325，CGWindowID 168257）接收单击后显示值变为 `7`。
- 同一窗口的双击、三击、右击、中击均由 native 返回成功；每次事件前后的系统
  frontmost PID 都保持为 17641，物理 cursor 保持 `(985.21484375, 300.1875)`。
- synthetic-focus keyboard session 的 begin、verified key、end 均成功；Calculator 显示
  更新为 `78,888,891`，frontmost PID 与 cursor 仍保持不变。
