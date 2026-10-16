# WebContentsView 覆盖 side-pane 显示规格（T7，P1）

> 状态：已被 <webview>+CDP-on-guest pivot 取代（executor 复用，WebContentsView 定位/manager 已删；见 2026-07-08-webview-cdp-on-guest-pivot-spec.md）。
> 上位：`2026-07-07-browser-use-cdp-node-repl-spec.md`；依赖 T5 的 `BrowserViewManager`（已把 view setBounds 到离屏）。
> 范围：让 main 的受控 WebContentsView 真正显示——覆盖到 renderer side-pane 的一块矩形区域。renderer 报 bounds，main setBounds 定位。P0 是 headless（view 在离屏），T7 把它移到可见区域。

## 1. 架构（renderer 只报 bounds，不碰命令）

CDP 设计下，浏览器命令全走 agent→host→main（interaction/browserExecute），**renderer 不在命令路径**。T7 renderer 的唯一职责：
1. 渲染一个空占位 `<div>`（浏览器像素由 main 的 WebContentsView 盖在其上）。
2. `ResizeObserver` + 滚动/布局变化 → 把该 div 的 `getBoundingClientRect()`（CSS px，相对视口=内容区）经 IPC 报给 main。
3. 显隐：pane 出现/隐藏时通知 main show/hide（隐藏=view 移出屏或 removeChildView）。

main 收到 bounds → `browserViewManager.setBounds(key, rect)`（WebContentsView.setBounds 用 CSS px、相对窗口内容区，与 DOM rect 同坐标系，无需 DPR 换算）。

## 2. 何时出现（P0 最小）

受控 view 属于某个 zcode session（key=sessionId）。T7 P0：新增 side-pane tab 类型 `browser-use`，当它可见时渲染占位并上报 bounds；main 把对应 session 的 view 覆盖上去。tab 的创建时机（agent 首次 browser 命令自动开 / 手动开）留后续；T7 先支持「存在该 tab 时正确显示」。

> 简化：P0 不做自动开 tab。先让 `BrowserViewManager` 在 view 创建时记录，renderer 侧提供一个 `BrowserUseViewPane` 组件；接入 side-pane 渲染分支。手动验证时可临时在 UI 触发。自动开 tab（agent 命令 → 展开 pane）记为 T7.1/后续。

## 3. 落点

### 契约 / IPC（`packages/shared/src/channels.ts`）
- `PlatformChannels` 增：
  - `BrowserViewSetBounds: "zcode:browser-view-set-bounds"`（renderer→main，invoke/send，payload `{key, rect:{x,y,width,height}}`）。
  - `BrowserViewSetVisible: "zcode:browser-view-set-visible"`（payload `{key, visible}`）。
- channel 类型表加 request/response（response void）。

### main
- `desktopMainIpcPlatform.ts`：`ipcMain.handle(BrowserViewSetBounds)` → `browserViewManager.setBounds(key, rect, senderWindow)`；`BrowserViewSetVisible` → `browserViewManager.setVisible(key, visible, senderWindow)`。
- `browserViewManager.ts`：新增
  - `setBounds(win, key, rect)`：ensureAttached(win, key) + `view.setBounds(rect)`。
  - `setVisible(win, key, visible)`：visible=false → `view.setVisible(false)` 或移出屏；true → 恢复并 setBounds 最近 rect。
  - 缓存每 key 最近 bounds，view 建好/show 时套用。
  - 把 T5 里「离屏 setBounds」改为：默认 hidden（`setVisible(false)`），等 renderer 报 bounds + show 才显示。

### renderer（`packages/ui`）
- 新增 `packages/ui/src/browser-use/BrowserUseViewPane.tsx`：
  - 渲染 `<div ref>` 占位（`bg-surface` 等，遵 DESIGN.md）。
  - `ResizeObserver` 观察 div + 监听窗口 resize/side-pane 动画结束 → `platform.browserViewSetBounds({key, rect})`（rect=getBoundingClientRect 取 x/y/width/height，round 整数）。
  - mount 时 setVisible(true) + 首次上报 bounds；unmount setVisible(false)。
- `platform.ts`（IPlatformService）+ preload + renderer platform 实现：加 `browserViewSetBounds?`/`browserViewSetVisible?`（仿 captureWindowScreenshot）。Web fallback no-op。
- side-pane 类型 `workspaceSidePane.ts` 加 `BrowserUseSidePaneTab { type:"browser-use"; sessionId }`；`AnimatedSidePanePanel.tsx` tab 分支渲染 `BrowserUseViewPane`。

## 4. 坐标与时序

- WebContentsView.setBounds 用 CSS px、相对窗口内容区左上角；DOM `getBoundingClientRect` 也是 CSS px 相对内容区视口 → 直接对应，无需 DPR/标题栏偏移换算（Electron 内容区不含原生标题栏）。
- 时序：view 可能先于 renderer 报 bounds 建好（agent 先发命令）→ main 默认 hidden，等首次 setBounds+show。renderer pane 先于 view 存在 → main 缓存 bounds，view 建好即套用。ensure 幂等。
- side-pane 有展开动画：动画中 rect 变化 → ResizeObserver 持续上报（可能高频，加 rAF 节流）。

## 5. 验证点（T7）
- 单测（browserViewManager，stub WebContentsView）：setBounds 缓存 + 调 view.setBounds；setVisible(false) 调 view.setVisible(false)；ensure 幂等；view 未建时 setBounds 缓存、建后套用。
- BrowserUseViewPane（无 jsdom：验证 bounds 计算/节流纯函数——把 rect 提取+round 抽成纯函数单测）。
- typecheck：channels/platform/preload/main/ui。
- 真机（手动）：desktop 起，出现 browser-use pane，agent navigate 后能在 pane 区域看到网页；resize 窗口/pane，网页跟随。

## 6. 边界
- 仅 desktop（Web/mobile 无 WebContentsView，platform 方法 no-op）。
- 多 tab（多 view 定位）留 T9；T7 单 view（key=sessionId）。
- P0 不做自动开 pane；先保证「有 pane 时正确覆盖显示」。

## 7. 自动开 tab（T7 闭环补充）

P0 之上补 main→renderer 反向通知，让 agent 首次 browser 命令后网页自动显现：

- `BrowserViewManager` 首次为某 key 建 view 时触发 `onViewCreated(win, sessionId)` 回调。
- 回调里 `win.webContents.send(PlatformChannels.BrowserViewReady, { sessionId })`（main→renderer）。
- 新增 `PlatformChannels.BrowserViewReady`（main→renderer，payload `{sessionId}`）。
- preload `onBrowserViewReady(cb)` 订阅（仿 onOpenBrowserUrl）；platform.ts 加 `onBrowserViewReady?`。
- renderer `useAppPanels` 订阅 → `openBrowserUseSidePane(current, {sessionId})` 开 tab + 展开 side-pane。
- `workspaceSidePane.ts` 加 `openBrowserUseSidePane`（复用同 sessionId 的 tab，不重复开）。
- 边界：仅 desktop；tab id = `browser-use:<sessionId>`，去重复用。
