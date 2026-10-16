# main WebContentsView + CDP 执行规格（T5）

> 状态：已被 <webview>+CDP-on-guest pivot 取代（executor 复用，WebContentsView 定位/manager 已删；见 2026-07-08-webview-cdp-on-guest-pivot-spec.md）。
> 上位：`2026-07-07-browser-use-cdp-node-repl-spec.md`；替换 T4 的占位 executor（`handleBrowserExecuteRequest`）。
> 范围：main 进程用 `WebContentsView` + CDP（`webContents.debugger`）真实执行 browser 命令。P0 核心子集：navigate / getState / screenshot（Page.captureScreenshot，规避 renderer capturePage 的 V8 FATAL）。click/type/snapshot 留 T8。

## 1. 落点（新目录 `packages/desktop/src/main/browserView/`）

- `browserViewManager.ts`：按 key（`sessionId`，P0 单 tab）管理 `WebContentsView` 生命周期。
  - `ensureView(key)`：无则 `new WebContentsView({ webPreferences:{ sandbox:true, contextIsolation:true, nodeIntegration:false }})`；懒建，缓存 `Map<key,{view,cdp}>`。P0 不挂到窗口（headless：view 不 addChildView，或 addChildView 后 setBounds 到 0 尺寸/离屏）——UI 显示是 T7。
  - `destroyView(key)`：CDP detach + `webContents.close()` + 从 map 删。
  - `disposeAll()`：app/host 退出清理。
- `cdpSession.ts`：包一个 `WebContents` 的 debugger。
  - `attach()`：`wc.debugger.attach("1.3")` + `sendCommand("Page.enable")`（DOM/Runtime 按需）。已 attach 幂等。
  - `send(method, params)`：`wc.debugger.sendCommand(...)`。
  - `detach()`：`wc.debugger.detach()`。
- `browserCommandExecutor.ts`：`execute(win, sessionId, command)` 按 `command.method` switch，返回 `BrowserCommandResult`（shared 契约）。
  - navigate：`view.webContents.loadURL(url)`（先过 about/http/https 白名单，越界 `navigation_blocked`）→ 读 state。
  - getState：读 `webContents.getURL()/getTitle()/canGoBack()/canGoForward()` + CDP `Page.getLayoutMetrics` 取 scroll/viewport（或省略）。
  - screenshot：CDP `Page.captureScreenshot({format:"png"})` → `{base64, mimeType:"image/png"}`。**不用** `webContents.capturePage`（renderer 侧会 V8 FATAL；main 侧虽可用，但统一走 CDP 可与其它控制命令共用同一通道且拿全页）。
  - 其它 method（click/type/snapshot/...）：P0 返回 `capability_unsupported`（T8 实现）。
  - 异常 → 结构化 `execution_error`，不 throw。

## 2. 接线（替换 T4 占位）

- `packages/desktop/src/main/index.ts`（或调用 spawnHostProcess 处）：构造一个 `BrowserViewManager` 单例，把 `handleBrowserExecuteRequest` 依赖实现为
  `({win, sessionId, command}) => browserCommandExecutor.execute(win, sessionId, command)`，传入 `spawnHostProcess` 的 dependencies。
- win 复用当前窗口的 `BrowserWindow`（spawnHostProcess 已有 `win` 参数）。P0 view 归属该 win。

## 3. headless-first（P0）

- P0 不接 UI 显示（T7 做 side-pane bounds 覆盖）。view 创建后即可被 CDP 驱动导航/截图，无需可见。
- 若 view 必须 attach 到窗口才能渲染/截图：`win.contentView.addChildView(view)` + `view.setBounds({x:0,y:0,width:1280,height:800})`，但盖在 UI 之上不美观——P0 可先 setBounds 到离屏或极小，仅验证 CDP 链路；T7 再正确定位。实测中确认 headless（不加窗口）能否 captureScreenshot；不能则加窗口 + 离屏 bounds。

## 4. CDP 与 DevTools 冲突

- 同一 webContents 只能一个 debugger。受控 view 默认不开 DevTools。attach 失败（已被占用）→ 结构化 `execution_error`，不崩。

## 5. 验证点（T5）

- 单测（`browserView/*` 纯逻辑，假 webContents/debugger stub）：
  - `browserCommandExecutor` navigate → 调 loadURL（白名单通过）；javascript:/file: → navigation_blocked 不调 loadURL。
  - screenshot → 调 CDP `Page.captureScreenshot`，返回 base64 image。
  - getState → 读 getter 组装 state。
  - 未实现 method → capability_unsupported。
  - CDP 异常 → execution_error。
  - `browserViewManager` ensureView 幂等（同 key 复用）、destroyView detach+close。
- typecheck：main tsconfig（WebContentsView/Debugger API）。
- 真机（T6 P0 一并验）：desktop 起，agent 触发 navigate+screenshot，main 日志见 CDP attach + captureScreenshot，返回非空 PNG。

## 6. 边界
- executor 只在 main（独占 WebContentsView+CDP）。host/agent 不碰 Electron。
- P0 单 tab（key=sessionId）；多 tab 生命周期 T9。
