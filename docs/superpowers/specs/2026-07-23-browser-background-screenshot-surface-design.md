# 内置浏览器后台 Tab 截图表面同步设计

> 状态：已实现；2026-07-30 补充 owner renderer + 目标 guest 有界 activity lease，
> 替代永久关闭后台节流；同日补充 preparing pump 的事件循环公平性，以及 macOS /
> Windows close-to-tray 后 hidden-born guest 的透明首帧 bootstrap。
> 日期：2026-07-23。
> 关联规范：
> `docs/browser-use/2026-07-15-browser-turn-final-screenshot-spec.md`、
> `docs/browser-use/2026-07-15-responsive-browser-viewport-spec.md`、
> `docs/testing/browser-use-codex-parity-coverage-matrix.md`。

## 1. 问题与运行时证据

用户报告的轮尾截图原图为 `1274 × 720`。像素比对显示，内容横向以 `800px`、纵向以
`450px` 为周期近似完全重复。持久化中只有一个 `source=browser_turn_end` 图片事实，
因此重复不是 conversation UI 拼接或图片压缩造成的。

运行时链路如下：

```text
browser-use tab 不是侧栏当前活动 tab
  -> TabsContent(forceMount) 仍挂载，但 data-[state=inactive]:hidden 令其 display:none
  -> Electron guest 保留最后一次可见时的 800 × 450 compositor surface
  -> 页面继续运行，CDP 读取到的当前 CSS viewport 已变为 1274 × 720
  -> Page.captureScreenshot(fromSurface=true) 按 1274 × 720 输出
  -> Chromium 用旧 800 × 450 surface 周期性填充目标 PNG
```

隔离 Electron `<webview>` 复现证明：

- 普通 `BrowserWindow` 在相同 CDP 参数下不会重复；
- `<webview>` guest 的布局尺寸、可见合成表面与 CSS viewport 不一致时可稳定复现；
- 增加 `clip`、`captureBeyondViewport` 或 `Emulation.setVisibleSize` 不能修复；
- `fromSurface=false` 在后台/被遮挡 guest 上可能返回黑图或错误尺寸，不能作为回退。

根因是后台 guest 截图前缺少“可截图表面已按当前视口完成合成”的同步边界，而不是图片编码、
轮尾持久化或展示层问题。

### 1.1 hidden window 下的主进程活锁

2026-07-30 的真实 macOS 复现又发现一条独立失败链：用户关闭最后一个窗口后，应用按产品策略
隐藏窗口而不退出；随后 BUA 在 hidden owner window 中发起截图。日志停在 screenshot request，
不再出现 surface ready、backend settled 或 app quit，主进程 CPU 持续 100%，且没有 crash dump。
对卡住的 Electron browser process 采样显示主线程持续执行 V8 Promise/microtask。

```text
hidden owner window
  -> activity controller 启动 owner + guest continuous capture pump
  -> Electron capturePage(1×1) 立即 resolve
  -> async continuation 在 microtask 中同步创建下一份 capture
  -> 下一份又立即 resolve，continuous 分支没有 macrotask yield
  -> Promise microtask 永不清空
  -> renderer Ready IPC / 1500ms timeout / 35s watchdog / second-instance 事件都无法调度
  -> 已隐藏的单实例进程仍占锁，新窗口无法打开，用户感知为 “ZCode 崩溃打不开”
```

这不是 native crash，也不是关闭窗口清理失败；根因是 activity pump 的调度设计允许
“立即完成的 capture”无限占用 Electron main event loop。修复边界必须放在 pump 本身，
不能依赖 coordinator timeout 或 watchdog 兜底，因为这些 timer 与 IPC 正是被饿死的任务。

### 1.2 hidden window 内新建 guest 没有首帧

事件循环公平性修复后，真实 macOS 日志暴露了后续独立问题：

```text
20:35:41.963  用户关闭窗口 -> Darwin close policy 执行 hide()
20:36:23.173  BUA newTab；guest 在 owner 已隐藏后 attach / navigate
20:36:31.363  screenshot request
20:36:31.541  guest activity capture failed
20:36:38.103  重试 screenshot，capture 一直 pending
20:36:52.930  用户重新激活 ZCode
20:36:53.533  同一份 screenshot 成功
```

隔离 Electron 41 实验进一步确认：

- hidden owner 中新建的 guest 即使已完成导航，第一次 `capturePage()` 仍可能返回 empty、
  抛出 `UnknownVizError` 或一直 pending；
- `invalidate()`、owner full capture 和 CDP `Page.startScreencast` 都不能建立 guest 首帧；
- `showInactive()` 能建立首帧，但直接调用会重新显示用户刚关闭的窗口；
- 先把窗口 opacity 置为 `0`，再 `showInactive()`，待 guest 首帧 capture 后重新 `hide()` 并
  恢复原 opacity，可得到非空后续截图；实测结束状态保持
  `visible=false / focused=false / opacity=原值`。
- `showInactive()` 后同一同步 turn 立即为 owner/guest 各启动两份重叠 `capturePage()` 会触发
  `UnknownVizError`，隔离 Electron smoke 曾进一步导致 browser process `SIGSEGV`；窗口 show
  事件与 Viz surface 初始化之间必须保留有界 presentation grace，不能把既有 pump 原样同步
  接在 `showInactive()` 后。

根因不是 capture pump 频率或 renderer capture layer，而是 guest 在 owner window 已 hidden
后出生，从未获得过窗口级 compositor presentation opportunity。Electron 的 capturer count
只能维持已有 surface，不能为该 guest 从零 bootstrap 首帧。

## 2. 目标与非目标

### 2.1 目标

1. 对后台、非活动的 browser-use tab 截图前，先准备与当前自然 CSS viewport 一致的
   Electron guest surface。
2. 截图准备不能切换用户当前侧栏 tab、抢焦点、接受鼠标/键盘事件或产生可见闪烁。
3. main 必须收到 renderer 的明确 ready 回执后才调用 `Page.captureScreenshot`。
4. 准备失败时明确终止本次截图，不能继续返回已知可能平铺的旧 surface。
5. 成功、失败、取消、超时和 guest 重建路径都必须释放临时 surface 状态。
6. 保持现有 screenshot、clip、fullPage、轮尾图片持久化和图片预算合同不变。
7. 没有截图正在准备或抓取时，owner BrowserWindow 必须恢复 Electron 默认后台节流；
   不能因为 browser-use tab 按进程生命周期持久存在而持续唤醒整窗 renderer、guest 和 GPU。
8. activity 唤醒必须分阶段限频：surface Ready 后 owner renderer 不再参与，目标 guest 的
   `capturePage()` 频率必须有固定上限，不能把一份最长 35s 的资源租约变成无间隔 GPU readback。
9. preparing 阶段即使 `capturePage()` 同步或立即完成，也必须在每轮续泵之间让出一次
   macrotask；renderer IPC、取消、timeout、watchdog 和应用生命周期事件必须保持可调度。
10. macOS 用户关闭窗口，或 Windows 用户关闭到托盘后，BUA 新建的 guest 仍能完成显式或
    轮尾截图；bootstrap 期间窗口不得可见、聚焦、闪烁或重新出现在 Windows taskbar，完成后
    仍保持关闭前的 hidden 状态。若用户在 bootstrap 期间主动重新打开窗口，清理不得再次把
    窗口隐藏。

### 2.2 非目标

- 不通过裁掉重复区域、图像相关性检测或截图后重采样掩盖 compositor 错误。
- 不把 browser-use tab 强制切为用户当前活动 tab。
- 不在 relay、desktop main 或手机端新增 task/stream/snapshot 业务状态。
- 不修改 `@zcode/protocol`；本设计只新增 desktop main 与 owner renderer 之间的瞬时平台协调。
- 不在本修复中解决“显式 responsive viewport 大于窗口可合成区域”的独立 Electron 限制。
  如果该场景无法准备同尺寸 surface，必须失败而不是输出平铺图片；BCP-199 的大视口真实
  Electron 覆盖继续作为单独工作项。
- 不为 Linux 使用 opacity 模拟透明窗口；Electron Linux 的 `setOpacity()` 是 no-op，调用
  `showInactive()` 会造成真实闪烁。Linux 最后窗口关闭还会进入 `app.quit()`，不会保留可供
  BUA 截图的 owner/guest。透明 bootstrap 只在具备可逆窗口 opacity 的 macOS 与 Windows
  desktop wiring 启用。

## 3. 方案选择

采用“后台截图表面准备 + renderer ACK”。

未采用的方案：

1. `fromSurface=false`：后台 webview 可返回黑图，并且输出尺寸不再与 Browser API 的 CSS
   坐标系一致。
2. 截图前激活 browser tab、完成后切回：能够促使 surface 更新，但会抢用户焦点并产生闪烁，
   多任务并发时还会扰乱 tab owner 语义。
3. 裁剪第一块重复区域再拉伸：不能证明第一块覆盖完整 viewport，会降低图像质量并破坏点击
   坐标对应关系。

## 4. 分层设计

### 4.1 BrowserScreenshotSurfaceCoordinator

在 desktop browser-use 域增加一个可注入的截图表面协调器。`BrowserGuestManager` 只依赖
该接口，不直接访问 React、DOM 或具体 IPC 实现。

```ts
interface BrowserScreenshotSurfaceCoordinator {
  prepare(input: {
    requestId: string;
    windowId: number;
    workspaceKey: string;
    sessionId: string;
    browserId: string;
    browserGeneration: number;
    tabId: string;
    webContentsId: number;
    viewport: { width: number; height: number };
    signal: AbortSignal;
  }): Promise<{
    viewport: { width: number; height: number };
    release(): void;
  }>;
}
```

- 本地 desktop wiring 使用 renderer IPC 实现。
- 测试可注入 fake coordinator，验证调用顺序、取消和释放。
- 没有可用 owner renderer 时，`prepare` 明确失败，不回退到旧 surface 截图。
- `groupsByReadyRequestId` 是 Ready 关联的唯一 request registry；pending request 不再维护一份
  从不参与查找的镜像 Map。
- `leaseReleases` 是 group 当前有效 lease 的唯一事实源。最后一个 release closure 从 Set 移除后
  才归还 surface/activity；不得再同步维护独立 `leaseCount`，避免 abort/watchdog/dispose 重入时
  计数器与真实资源集合漂移。

### 4.2 Main 与 renderer 瞬时消息

新增严格关联 `requestId` 的平台消息：

- `BrowserViewScreenshotSurfacePrepare`
- `BrowserViewScreenshotSurfaceReady`
- `BrowserViewScreenshotSurfaceRelease`

消息必须携带 `workspaceKey`、`sessionId`、`browserId`、`browserGeneration`、`tabId` 和
`webContentsId`；prepare 还携带 main 当前实际 `timeoutMs`，旧 payload 缺失时 renderer 回退到
共享默认值。renderer 只处理完整 scope 与当前 tab/guest 同时匹配的请求；main 只接受同一
`requestId` 的 ready，迟到或旧 generation 回执直接丢弃。

这些消息只表达瞬时渲染准备，不进入 Zustand 持久状态、conversation fact、relay 或
replayable snapshot。

### 4.3 Renderer 截图表面

收到 prepare 后，目标 browser-use tab 进入临时 `preparing` 状态：

1. inactive `TabsContent` 不再使用 `display:none`、`visibility:hidden` 或
   `content-visibility:hidden`；
2. 它被放入侧栏内容区域内的后台 capture layer，保持实际布局尺寸，但位于当前活动内容之下；
3. capture layer 禁用 pointer events、键盘焦点和可访问性暴露，不能改变当前 tab selection；
4. 原有 responsive viewport、guest zoom 和 viewport override 不在此处重写；
5. `ResizeObserver` 观察 webview，连续两个 animation frame 的宽高稳定且大于零后读取
   `getBoundingClientRect()`；
6. renderer 回传 `webContentsId` 与稳定 DOM viewport，并进入 `ready`。

capture layer 必须建立独立 stacking context，活动 tab 保持原有背景和交互层级。具体 CSS
必须由真实 Electron smoke 证明 guest surface 在被活动内容覆盖时仍持续合成；不能只以
JSDOM 中元素未 `display:none` 作为完成依据。

### 4.4 Main 截图门禁

`BrowserGuestManager` 在执行 screenshot、clip screenshot 或 fullPage screenshot 前：

1. 通过 CDP 读取当前 CSS viewport；
2. 调用 coordinator `prepare`；
3. 校验 ready 的 `webContentsId` 未变化、viewport 与当前自然 CSS viewport 在 `1px`
   舍入容差内一致；
4. 不一致时在 prepare 预算内继续等待一次稳定回执；
5. 一致后才调用现有 `executeBrowserCommandOnView`；
6. 在 `finally` 中调用 `release`。

现有同 tab `inFlightScreenshots` 互斥仍保留。表面准备计入同一次 screenshot 请求预算，
不能绕过 timeout/backpressure。

### 4.5 Owner renderer + 目标 guest activity lease

Electron 的 `backgroundThrottling: false` 不是单 guest 隔离开关：同一个 BrowserWindow 中任一
WebContents 禁用节流后，整个窗口及其其它 WebContents 都会持续绘制；建窗时禁用还会让
Page Visibility 保持为 `visible`。因此不能在主窗口创建时永久关闭后台节流，也不能假装通过
目标 webview 获得 tab 级隔离。

运行时进一步否定了“动态设为 false、结束后设回 true”的初版方案。Electron 41 在 hidden
WebContents 上调用 `setBackgroundThrottling(true)` 时，getter 虽恢复为 `true`，但内部仍调用
`RenderWidgetHostImpl::WasShown()`，不会重新触发 `WasHidden()`；真实 smoke 中 rAF 持续运行，
CPU 无法回落。该 API 不能作为可逆租约。

最终采用 Electron `capturePage()` 的原生 capturer-count 语义：hidden page 在 capturer count
非零时被认为可见，capture Promise settle 后 Chromium 自动归还 count 并恢复 hidden 调度。
`<webview>` guest 与 owner renderer 是不同的 WebContents：只 capture owner 不会唤醒 guest，
只 capture guest 也不会驱动 owner renderer 的 `ResizeObserver + rAF` ready 握手。activity
controller 因此按 surface 生命周期分成两个阶段，同窗其它 guest 始终不参与：

```text
preparing:
  owner: start A -> start B before awaiting A -> A settle -> macrotask yield -> start C -> ...
  target guest: start A -> start B before awaiting A -> A settle -> macrotask yield -> start C -> ...
  invariant: even if A/B settle immediately, no target may chain another pump turn in the same microtask drain
ready:
  owner: stop creating captures -> final captures settle -> hidden
  target guest: one 1×1 capture at most every 200ms
sibling guest: no capturer
release
  -> stop creating target guest captures
  -> await the final capture settle
  -> capturer count returns to zero
  -> Chromium restores background scheduling
```

`1 × 1` capture 只用于保持可逆 activity，不读取、记录或持久化页面图像。Prepare 阶段的
重叠顺序保证 owner renderer 能连续完成 `ResizeObserver + 2 rAF`，且每个目标最多两份
未 settle capture。每次前一份 capture settle 后必须先经一个 macrotask 边界，再进入下一轮；
这既保留“先启动下一份”的重叠语义，也保证 Ready IPC 与有界回收 timer 可以运行。
Ready 后 owner 已完成职责，必须立即停泵；目标 guest 只保留单 in-flight 脉冲，capture
启动间隔至少 `200ms`。真实 Electron smoke 必须证明该频率仍能让隐藏 guest 推进渲染，
同时 owner 和 sibling 已恢复/保持节流。

Desktop main 增加可注入的 screenshot activity controller：

```ts
interface BrowserScreenshotActivityLease {
  readonly invalidated?: AbortSignal;
  markPrepared?(): void;
  release(): void;
}

interface BrowserScreenshotActivityController {
  acquire(input: {
    windowId: number;
    webContentsId: number;
    requestId: string;
    reason: "browser-screenshot";
  }): BrowserScreenshotActivityLease | undefined;
}
```

状态归属和约束：

1. `desktopWindowChrome` 不再设置永久 `backgroundThrottling: false`，使用 Electron 默认
   `true`。
2. coordinator 激活一个 preparation group 时，必须先获得 owner renderer + 目标 guest
   activity lease，
   再发送 renderer `Prepare`；否则隐藏、最小化或完全遮挡的 renderer 仍可能因为 rAF 和
   compositor 冻结而无法回 `Ready`。
3. controller 必须校验目标 guest 的 `hostWebContents.id` 属于 owner window；不匹配时受控
   失败，禁止跨窗口误唤醒。
4. 第一份同 owner + guest lease 在 preparing 阶段各启动一条重叠 `1 × 1 capturePage()` pump；
   相同目标后续 lease 只增加引用，不新增 pump。同窗其它 guest 不被唤醒。
5. preparation group 从 prepare 开始，到所有 screenshot surface lease 真实释放为止只持有
   一份 activity lease。同 guest 的并发请求共享 group；排队 group 不提前唤醒。
6. renderer `Ready` 后 coordinator 必须调用 `markPrepared()`：owner pump 停止，目标 guest
   pump 切为 `200ms` 最小启动间隔、单 in-flight 的 capturing 模式。
7. group settle 时先发送 renderer `Release`，再释放 activity lease；最后一份 lease 停止续泵，
   等已创建的最后 capture 自然 settle。`release()` 必须幂等。
8. 最后一份 lease 的停泵延迟到一个 microtask；若 coordinator 同步激活下一个排队 group，新
   acquire 取消停泵，避免 capturer count 短暂归零后重复 hidden/visible 调度。
9. 任一 owner/guest activity capture 失败时，controller 必须使 `invalidated` signal 进入 aborted；
   coordinator 在 Ready 前立即拒绝 prepare，Ready 后使已交付的 surface lease 失效。不能只停泵
   然后静默等待完整的 prepare 超时预算。
10. activity controller 属于 desktop main 瞬时资源状态，不进入 renderer Zustand、relay、
    conversation fact 或 web remote replayable snapshot。
11. continuous pump 每完成一轮都必须经过可唤醒的 macrotask delay；若其间发生
    `markPrepared()`、`release()` 或 invalidation，delay 应立即结束并重新读取 phase，
    不能额外创建下一份 capture。

### 4.6 macOS / Windows hidden-born guest 透明 bootstrap

capturer-count activity 对“曾经有 surface、现在被 hidden 调度”的 guest 有效，但不能建立
hidden-born guest 的第一帧。Desktop wiring 因此在 macOS hide-close 与 Windows
close-to-tray 两条 hidden-but-alive 生命周期启用 `transparentWindowBootstrap` capability；
controller 不把该行为扩散到 Web、手机或 Linux。

当第一份 activity lease 发现 owner window 已隐藏时，在启动 owner/guest capture pump 前：

```text
snapshot originalOpacity
  -> Windows: setSkipTaskbar(true)
  -> setOpacity(0)
  -> subscribe focus
  -> showInactive()                 # 不激活 app、不抢焦点；窗口对用户透明
  -> 100ms presentation grace       # 禁止并发 CopyFromSurface
  -> owner + target guest pump 建立/维持首帧
  -> renderer Ready
       -> if 用户未聚焦: hide() -> restore originalOpacity
       -> if 用户已聚焦: restore originalOpacity，保留 visible
       -> Windows: setSkipTaskbar(false)
  -> guest paced capturer 维持 surface
  -> Page.captureScreenshot
```

约束：

1. opacity 必须先于 `showInactive()` 置零；任何异常都不得先显示不透明窗口。
2. 原 opacity 必须按 snapshot 恢复，不能假设固定为 `1`。
3. Windows 必须在 `showInactive()` 前临时 `setSkipTaskbar(true)`，并在 hidden/focus/error
   任一路径恢复 `false`；主窗口产品合同的原始状态是显示在 taskbar。否则透明窗口虽无像素，
   仍可能让任务栏按钮或预览重新出现。
4. bootstrap 只属于第一份 owner + guest activity state；同 guest 并发 lease 复用，不能重复
   show/hide。
5. `showInactive()` 后保留 `100ms` presentation grace；grace 内不启动 activity
   `capturePage()`，避免 Viz surface 尚未建立时并发 CopyFromSurface。renderer Ready/实际截图
   可在 grace 内直接利用透明可见窗口完成，不需要等待该 timer。
6. renderer Ready、prepare timeout、capture failure、abort、watchdog、window destroy 与
   coordinator dispose 都必须幂等清理 bootstrap。
7. bootstrap 期间若收到 owner `focus`，视为用户主动恢复窗口：立即恢复 opacity/taskbar，
   并禁止后续
   cleanup 调用 `hide()`。main 单线程内的 focus 判定与 hide/restore 必须在同一同步清理段
   完成，避免反向隐藏用户窗口。
8. `showInactive()` 只补窗口级 presentation opportunity，不改变 Browser API active tab、
   renderer tab selection、workspaceKey、session owner 或图片持久化语义。
9. window 原本可见或处于 minimized 状态时不启动 bootstrap，避免把最小化状态错误恢复成
   hidden；Linux wiring 保持 capability 关闭，沿用现有 capture activity。

activity lease 必须有独立的有界回收。host 默认 screenshot transport budget 为 `30s`，
Playwright element screenshot 预算最多约 `32s`；activity lease 的安全 watchdog 为 `35s`。
watchdog 只强制恢复 renderer capture layer、停止 activity capture pump，不伪造底层 Chromium
截图已结束。

截图取消后可能存在两个不同事实：

```text
caller timeout / cancel
  -> activity lease: 立即释放，停止 owner renderer 与目标 guest 后台持续跑帧
  -> inFlightScreenshots: 继续保留，直到 Chromium Promise 真实 settle
```

CDP `Page.captureScreenshot` 没有可靠的单请求取消 API。即使调用方已经超时，底层 Promise
仍可能继续执行；同 tab 重试必须继续被 `inFlightScreenshots` 拦截，但不能为了等待迟到结果
无限期关闭后台节流。

## 5. 时序

```text
CLI/runtime screenshot(tabId)
  -> desktop main / BrowserGuestManager
       -> enter per-tab viewport mutation queue
            -> CDP read CSS viewport
            -> coordinator.prepare(requestId, full scope, webContentsId, viewport)
                 -> activityController.acquire(owner window, target guest)
                      -> macOS / Windows hidden owner: opacity=0 + showInactive() bootstrap
                      -> preparing: start owner + target guest continuous 1×1 capture pumps
                           -> each completed turn yields to Electron main event loop
                 -> owner renderer
                      -> target inactive tab: hidden -> background capture layer
                      -> ResizeObserver + 2 stable animation frames
                      -> ready(requestId, webContentsId, DOM viewport)
                 <- ready
                 -> activityLease.markPrepared()
                      -> 未被用户激活时 hide() + restore opacity
                      -> owner stops; target guest switches to 200ms paced capture
            -> validate guest identity + viewport
            -> Page.captureScreenshot
            -> finally coordinator.release(requestId)
                 -> renderer removes capture layer state
                 -> activity lease release
                      -> target guest stops; Chromium restores hidden scheduling
  <- PNG or structured screenshot failure
```

该时序只同步渲染表面，不改变 tab owner、active Browser API tab 或用户侧栏选中项。

## 6. 错误与清理

- prepare 最长等待 `3000ms`；该预算只用于容纳 renderer 在慢机器或后台窗口中的 surface
  稳定过程，不能替代 guest identity、viewport、连续稳定 frame 与 raster 内容校验。窗口销毁、
  renderer 无响应、viewport 为零、guest id 变化或
  请求取消均返回截图失败。
- main 必须把当前实际 `timeoutMs` 放入 prepare payload；renderer 的本地验证保险 deadline 为
  `timeoutMs + 1000ms`（默认 `4000ms`）。正常路径仍由 main 在 prepare settle 时发送 `Release`
  提前清理；额外 1000ms 只防止 Release 丢失后验证循环永久存活，不能截短 main 的有效预算。
- 失败时不执行 `Page.captureScreenshot`，避免把已知损坏图片持久化为轮尾事实。
- `release` 必须幂等，并在成功、CDP 异常、timeout、abort 和 late completion 后执行。
- prepare 阶段 abort、timeout、send 失败、窗口销毁或 coordinator dispose 必须释放
  activity lease；ready 后 abort 必须自动释放对应 surface lease，不能只依赖底层 CDP Promise
  settle。
- activity watchdog 到期后强制 settle group、停止 capture pump 并记录 `warn`；底层截图仍保留
  `inFlightScreenshots` tombstone，直到真实 settle。
- activity capture 自身失败时通过 lease invalidation 立即结束准备；若 surface 已 Ready，
  manager 在返回图片前再次检查 invalidation，不能把失去活动保证后的迟到图片当成成功。
- continuous pump 不得通过 Promise microtask 自旋等待 renderer Ready；立即完成的 capture
  也必须让 timer、IPC、second-instance 和 window lifecycle 先获得一次调度机会。
- 透明 bootstrap 清理时若窗口已经销毁，不再调用 `hide()` / `setOpacity()` /
  `setSkipTaskbar()`；若窗口已被用户 focus，则只恢复 opacity/taskbar、保留窗口可见。
  `showInactive()`、opacity 或 Windows taskbar 设置失败时，activity 必须受控失败，不能退回到
  可见 `show()`。
- renderer 对未知 release 直接忽略；新 prepare 可覆盖同 tab 已结束的旧请求，但不能覆盖仍
  活跃的不同 request。
- 高频 prepare/ready/release 只使用 UI `logger.debug` 与 service/main debug 日志；日志不记录
  图片 base64、页面正文或完整 URL。
- 自动轮尾截图是 best-effort：表面准备失败时沿用现有“记录并跳过图片、不影响对话完成”语义；
  显式 screenshot API 返回结构化错误。

## 7. 多端与身份边界

- 桌面 `desktop-continuous` 与手机 `web-remote-replayable` 仍读取同一个成功持久化的图片事实。
- 手机远控命令继续经 shared-host attachment 到 owner desktop window；不创建手机独立
  browser runtime 或 host。
- `workspaceIdentity` 继续通过
  `workspaceKey = workspaceIdentity?.trim() || workspacePath` 隔离；远程 workspace 的 `remoteSessionId`
  现有路由不变。
- prepare/ready/release 不进入 relay，不携带 stream、queue、snapshot 或 clientMode 恢复语义。
- macOS、Windows、Linux 共用同一 coordinator 合同；desktop wiring 的透明窗口 bootstrap
  只在 Electron 支持 opacity 的 macOS/Windows 启用，Windows 还临时隐藏 taskbar entry。
  Windows 高 DPI 是必须验证的风险面，截图 surface 与 raster 合同本身不做平台特判。

## 8. 测试与验收

### 8.1 自动化

1. UI：inactive browser-use tab 收到 prepare 后不再 `display:none`，但不改变 active tab、
   focus、pointer 和 accessibility；release 后恢复。
2. Renderer IPC：scope、generation、tabId、webContentsId、requestId 任一不匹配时不 ready。
3. Coordinator：ready、timeout、abort、window destroyed、late ready 与幂等 release。
   activity lease 必须先于 prepare 获得；同 guest group 只获得一份；排队 group 不获得；
   Ready 时切换 activity phase；activity invalidation、prepare/send/ready 后 abort、watchdog、
   window destroyed 和 dispose 均释放。
4. Manager：prepare 必须先于 CDP screenshot；success/error/abort 均 release；prepare 失败时
   不调用 `Page.captureScreenshot`；surface invalidation 后不返回成功图片；prepare 必须在
   per-tab viewport mutation queue 内获取，禁止 activity 在队列外空转。
5. 现有 screenshot、clip、fullPage 与 in-flight backpressure 测试继续通过。
6. 真实 Electron smoke：先让 guest 在 `800 × 450` 可见，再把 tab 置为 inactive 并将侧栏
   调整为 `1274 × 720`；prepare 后截图必须为当前 CSS viewport，四角 sentinel 各不相同，
   且不得出现 `800 × 450` 周期重复。
7. 真实 Electron activity smoke：隐藏窗口下 owner renderer、目标 guest 与 sibling guest
   均进入节流；preparing 只让 owner renderer + 目标 guest 恢复跑帧；`markPrepared()` 后
   owner 恢复节流、目标 guest 以不高于 5Hz 的 capture 脉冲继续推进、sibling 始终节流；
   释放且最后 capture settle 后三者再次进入节流。smoke 还必须注入一次 capture failure，
   证明 pump 停止并显式报告 invalidation。全过程 `getBackgroundThrottling()` 保持 `true`。
8. Controller 调度回归：令 owner/guest `capturePage()` 连续立即 resolve；在第一个 timer
   turn 到来前，每个 target 最多只有初始重叠 capture，不得耗尽整段同步结果队列；timer
   必须能够运行，随后 `markPrepared()` / `release()` 可停止续泵。
9. Controller 窗口状态回归：hidden owner 在首个 capture pump 前依次执行
   `setOpacity(0) -> showInactive()`；Ready 后未被用户激活时依次执行
   presentation grace 到期、且目标 guest capturer 已启动后，执行
   `hide() -> restore originalOpacity`。grace 前 owner/guest capture 数必须为零，避免
   `UnknownVizError` / native crash。若 bootstrap 期间收到 `focus`，必须立即恢复 opacity，
   且 Ready/release 不再 hide；visible owner 与未启用 capability 的平台均不得调用这些 API。
   Windows 另断言 `setSkipTaskbar(true)` 发生在 `showInactive()` 前，并在 hidden/focus/error
   清理时恢复 `false`。
10. 真实 Electron hidden-born smoke：先隐藏 owner，再动态 attach/navigate guest；透明
    bootstrap 前 capture 为空或失败，bootstrap 后 guest 首帧与最终截图均非空；清理后断言
    `isVisible() === false`、`isFocused() === false`、opacity 恢复，且后续隐藏截图仍成功。
    smoke 在 macOS 与 Windows 执行；Windows 同时覆盖临时 taskbar 隐藏。

### 8.2 验收

- 用户保持 conversation/其他侧栏 tab 活动时，轮尾截图不切换 UI、不闪烁、不重复拼接。
- 同一页面 active 与 background 截图内容、尺寸和滚动位置一致。
- Windows 125%/150%/160% DPI 至少完成一次手工或真实 Electron smoke；不能只依赖 mock。
- `pnpm typecheck` 与 `pnpm lint` 必须通过。
- hidden-born guest 必须在 macOS 真实 Electron 上覆盖；Windows close-to-tray 需要 Windows
  CI/手工 smoke，当前非 Windows 环境只能覆盖 taskbar 生命周期单测；Linux 不启用透明
  bootstrap。
- 若 CI 无法覆盖其它 macOS 版本、Windows close-to-tray、Linux 或 minimized-window
  compositor，提交说明必须列出风险与待补项。

## 9. 影响面与用例剪枝

本次属于 `commit-effect + recovery + rendering/performance + app-shutdown-policy`。activity
lease 只改变 desktop 截图表面准备期间的 Electron 电源/合成策略，并在 macOS hide-close /
Windows close-to-tray 后临时建立透明窗口 presentation opportunity；不改变 Browser API、
图片事实、tab 生命周期、workspace identity 或多端恢复合同。代码图工具在当前 workspace
不可用，调用面以精确 symbol 搜索并向上展开两层 direct caller 完成。

| 影响项        | 结论                                                                                                        |
| ------------- | ----------------------------------------------------------------------------------------------------------- |
| 主 capability | `capability.browser-screenshot-surface`；入口仍是显式/轮尾 browser screenshot                               |
| 运行时 owner  | Electron main 的 `DesktopBrowserScreenshotActivityController`；renderer 只收 prepare/release                |
| 直接调用链    | `BrowserGuestManager -> DesktopBrowserScreenshotSurfaceCoordinator -> activity controller -> BrowserWindow` |
| 交付边界      | 只影响 `desktop-continuous` 本地瞬时资源；必须与 `web-remote-replayable`、relay、snapshot 保持隔离          |
| 不变量        | workspaceKey、tab/session ownership、图片事实、UI selection、protocol shape、用户 focus 均不变              |
| 证据          | controller 状态单测 + coordinator/manager 既有测试 + hidden-born 真实 Electron smoke/runtime trace          |

| Case    | 初始状态                         | 事件                           | 预期 effect                                                 | 分类                         |
| ------- | -------------------------------- | ------------------------------ | ----------------------------------------------------------- | ---------------------------- |
| BAS-001 | owner window 后台、无截图        | browser-use tab 持久存在       | 保持默认节流，不持续跑帧                                    | accepted                     |
| BAS-002 | owner window 后台                | 显式或轮尾截图                 | prepare 前唤醒 owner + 目标 guest，settle 后停泵            | accepted                     |
| BAS-003 | 同 guest 并发 prepare            | 两个请求 ready                 | 共享 surface group 和一份 activity lease                    | accepted                     |
| BAS-004 | 不同 guest 请求排队              | 前一截图未释放                 | 只有 active group 的目标 guest 被唤醒                       | accepted                     |
| BAS-005 | ready 前 timeout/abort           | preparation 失败               | release renderer 与 activity lease，不执行截图              | accepted                     |
| BAS-006 | ready 后 backend 挂起            | host cancel/watchdog           | 恢复节流，保留同 tab in-flight 防重入                       | accepted                     |
| BAS-007 | owner window 销毁                | 任意阶段                       | 幂等清理，不访问 destroyed WebContents                      | accepted                     |
| BAS-008 | 手机 replayable 恢复             | 读取已持久化截图               | 不传播 activity lease 或新增手机 runtime                    | pruned；desktop-local 不变量 |
| BAS-009 | hidden owner；capture 立即完成   | preparing continuous pump 续泵 | 每轮让出 macrotask；IPC/timer 可运行且 capture 数量保持有界 | accepted；本次根因回归       |
| BAS-010 | macOS owner 已 hidden            | 此后 attach guest 并请求截图   | 透明 bootstrap 首帧；截图成功且窗口保持 hidden/unfocused    | accepted；本次根因回归       |
| BAS-011 | 透明 bootstrap 进行中            | 用户主动 focus ZCode           | 立即恢复 opacity；Ready/release 不得再次 hide 用户窗口      | accepted；窗口状态竞争       |
| BAS-012 | Windows owner 已隐藏到托盘       | 此后 attach guest 并请求截图   | 透明 bootstrap；taskbar 不重现；截图后仍隐藏到托盘          | accepted；Windows 对等路径   |
| BAS-013 | Linux 或 visible/minimized owner | 请求截图                       | 不启动透明 bootstrap；沿用现有 activity/close 生命周期      | accepted；平台边界           |

代表组合以“活动 group × 生命周期事件”为主，不与 tab 数量、workspace 类型、
`desktop-continuous` / `web-remote-replayable` 做全排列；完整 scope 继续由既有 coordinator
identity 测试证明。
