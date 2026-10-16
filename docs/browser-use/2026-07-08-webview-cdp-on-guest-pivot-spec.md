# 内置浏览器改用 `<webview>` + CDP-on-guest（弃 WebContentsView）设计

日期：2026-07-08　状态：已实现（P1–P5 全部落地，真机端到端验证通过：human tab 与 agent 握手均 attachGuest cdp=true，navigate/snapshot ok）

## 1. 背景

前期把内置浏览器从 `<webview>` 迁到 main 的 `WebContentsView`，理由是"规避 `webview.capturePage()` 的 V8 崩溃"。复核后发现前提不成立：

- **`<webview>` + CDP-on-guest 完全可行**：main 通过 `webviewTag` + `will|did-attach-webview` 管理 guest，用 `webContents.fromId` 拿到 guest webContents，再经 `webContents.debugger.attach` 执行 `Page.captureScreenshot` 等 CDP 命令，不需要 `WebContentsView`/`BrowserView`（见下方 Spike 实证）。
- WebContentsView 是**窗口 native 层，永远合成在 renderer DOM 之上** → 菜单/下拉/tooltip 碰到 pane 就被遮，且 z-index 无法修（本质缺陷）。还带来 setBounds/setVisible 手动定位、DPR/缩放换算、"第二个 tab 打不开"等一堆定位类 bug。
- `webview.capturePage()` 的崩溃只是**那个方法**的问题；改用 **CDP `Page.captureScreenshot`** 截图即可绕开。所以 webview 本身没问题，我们当初把"webview"和"capturePage 崩溃"混淆了。

**Spike 实证**（`/tmp/webview-cdp-spike`，host.png 为证）：renderer `<webview>` guest → main `debugger.attach("1.3")` → `Page.navigate`/`Page.captureScreenshot` 全通；且一个高 z-index 的 DOM 菜单**成功盖住** webview 内容（WebContentsView 下会被遮）。

**目标**：内置浏览器改回 `<webview>` 渲染（DOM 内合成、可被 DOM 覆盖），控制仍走 CDP（挂到 guest 的 `webContents.debugger`）。一举解决菜单遮挡 + 去掉手动定位/缩放那套。

## 2. 架构

```
RENDERER (React UI)
  UnifiedBrowserView：chrome(地址栏/前进后退/刷新/DevTools/picker) + <webview partition="persist:zcode-embedded-browser">
    - webview 随 DOM 布局定位（不再 setBounds/setVisible 覆盖）
    - dom-ready 时 getWebContentsId() → IPC 上报 { key, webContentsId } 给 main
    - webview 事件(did-navigate/page-title-updated/did-fail-load) 驱动本地 chrome 状态
        │ IPC: browserViewAttachGuest({ key, webContentsId })
        ▼
MAIN
  BrowserGuestManager（替代 BrowserViewManager）：Map<key, { guest: WebContents, cdpAttached }>
    - attachGuest(key, webContentsId): guest = webContents.fromId(id); guest.debugger.attach("1.3"); 存表
    - execute(key, command): toControlledView(guest) → executeBrowserCommandOnView(复用，零改)
    - guest 提供 loadURL/getURL/getTitle/navigationHistory/reload/executeJavaScript/debugger —— 与 ControlledView 接口天然吻合
    - guest 'destroyed' / tab 关闭 → detach + 清表
  宿主 desktopWindowChrome：重新开 webviewTag + will/did-attach-webview(URL 白名单、popup 路由回内部 tab)
```

**关键洞察**：executor（`executeBrowserCommandOnView` + SNAPSHOT/RESOLVE 脚本 + CDP Input）作用在一个 `ControlledView`（`{ webContents:{loadURL/getURL/...executeJavaScript}, cdp:{send} }`）上。WebContentsView 的 webContents 和 webview guest 的 webContents **接口一致**，故 **executor 完全复用、零改**，只把 `toControlledView` 的数据源从 `WebContentsView.webContents` 换成 guest webContents。

## 3. 两个 tab 来源的生命周期

### human tab（renderer 主动开）

1. 用户开 tab → renderer 渲染 `<webview src=about:blank 或 initialUrl>`。
2. webview `dom-ready` → `getWebContentsId()` → IPC `browserViewAttachGuest({key=tab.id, webContentsId})`。
3. main `webContents.fromId` + `debugger.attach` 存表。
4. 地址栏导航：renderer 直接 `platform.browserViewNavigate({key,url})` → main → execute（CDP/loadURL 在 guest 上）。或 human 也可 renderer 侧 `webview.loadURL`（二选一，统一走 main execute 更一致）。

### agent tab（agent 主动 open，renderer 还没 webview）—— 需握手

1. agent `agent.browsers.open(url)` → 协议 → host → main。main 表里无该 session 的 guest。
2. main 发 `BrowserViewReady({sessionId})` 让 renderer **开一个 browser-use tab + 挂 webview**（复用现有自动开 tab 链）。
3. renderer webview dom-ready → 上报 guest id → main attachGuest。
4. main 此时才能对该 guest 执行命令。**握手期处理**：main 的 execute 若该 key 尚无 attached guest，等待其 attach（pending，带超时，如 10s）后再执行；超时返回结构化 error。（webview attach 生命周期本身是异步的。）

## 4. 复用 / 改动 / 删除清单

**复用（控制面，几乎不动）**

- `browserCommandExecutor.ts`（executeBrowserCommandOnView + SNAPSHOT_SCRIPT + RESOLVE + CDP Input + Page.captureScreenshot + settleNavigation）—— 零改。
- 协议 `BrowserCommand`/`tabId`/`list`/result、agent 对象模型/facade/documentation、node_repl 顶层持久、element-picker（executeJs 走 guest）。
- 新 chrome：`UnifiedBrowserView` 的 chrome 部分（BrowserToolbar/BrowserEmptyState）、`embeddedBrowserHelpers`。

**改**

- `UnifiedBrowserView.tsx`：占位 div → `<webview>`；去掉 bounds/visible 上报；加 dom-ready→上报 guestId、webview 事件驱动 chrome、地址栏/按钮走导航。
- main：`BrowserViewManager` → `BrowserGuestManager`（attachGuest / execute(复用 executeBrowserCommandOnView) / detach / list / 握手 pending）。`toControlledView` 数据源换 guest webContents。
- 新 IPC `browserViewAttachGuest({key, webContentsId})`（renderer→main）。
- `desktopWindowChrome`：重新开 `webviewTag` + `will/did-attach-webview`（URL 白名单 + popup 路由回内部 tab）。
- AnimatedSidePanePanel：human/agent 分支都渲染新的 webview 版 UnifiedBrowserView。

**删除（WebContentsView 定位那套）**

- `browserViewSetBounds`/`browserViewSetVisible` IPC + renderer 上报 + manager setBounds/setVisible/ensureView(addChildView) + `browserViewBounds.ts`（rectToViewBounds/sameBounds）。
- preload setBounds 的缩放换算（`webFrame.getZoomFactor()` 那段）。
- `browserViewLifecycle.ts` 的 diff-effect 回收（改由 webview 卸载 + guest 'destroyed' 自然回收）。
- `browserViewManager.ts`（被 BrowserGuestManager 取代）。

## 5. 迁移阶段（每阶段单独 spec/commit，先 spec 后码）

- **P1 main guest 底座**：`BrowserGuestManager`（attachGuest + execute 复用 executor + detach + 握手 pending）+ `browserViewAttachGuest` IPC + 宿主 webviewTag/will|did-attach-webview 请回。单测：attach 后 execute 走 guest；未 attach 时 pending/超时。
- **P2 renderer webview 组件**：`UnifiedBrowserView` 改 `<webview>` + dom-ready 上报 guestId + webview 事件驱动 chrome + 导航按钮。human tab 切过去，真机验证菜单不再被遮 + 导航/截图/element-picker。
- **P3 agent 握手**：agent open → BrowserViewReady → renderer 开 webview tab → 上报 guestId → main attach → 完成 pending 命令。真机验证 agent open→snapshot→click。
- **P4 删 WebContentsView 定位资产**：setBounds/setVisible/bounds/缩放换算/diff-effect/browserViewManager 清理。
- **P5 回归**：菜单遮挡、多 tab、缩放、resize、element-picker、agent 全链路真机过一遍。

## 6. 风险

- **agent 握手异步性**：main 要等 renderer 建 webview 上报 guestId 才能执行首命令。缓解：pending+超时+清晰错误；human tab 无此问题（webview 先在）。
- **guestId 时序**：dom-ready 前 getWebContentsId 可能无效；用 dom-ready 事件为准。webview 崩溃/重载后 guestId 变 → 需重新 attach（监听 destroyed/did-attach）。
- **CDP attach 冲突**：同 guest 只允许一个 debugger；打开 DevTools 会占用 → attach 失败需结构化处理。
- **`<webview>` 官方长期不推荐**：但 Electron 41 仍支持，且它是让页面内容参与 DOM 合成、可被菜单覆盖的方案；接受。
- **partition 登录态**：webview 显式 `partition="persist:zcode-embedded-browser"`，与之前一致。

## 7. Popup / 新标签页创建期契约（2026-07-20 补充）

网页通过 `<a target="_blank">`、`window.open()` 或 `form target="_blank"` 请求新页面时，必须由 main 的 `setWindowOpenHandler` 拦截，校验协议后路由到 ZCode 内部 Browser tab；不得静默吞掉，也不得放任 Electron 创建脱离 ZCode 的 `BrowserWindow`。

`allowpopups` 是 Electron guest 的**创建期能力**，必须在 React 创建 `<webview>` DOM 节点时就作为 attribute 输出。禁止在 ref、effect、`dom-ready` 或 `did-attach-webview` 之后再补：这些阶段 guest 已经 attach，虽然宿主 DOM 最终能看到 attribute，Chromium 仍会在更早的 popup 权限边界直接吞掉新窗口请求，main 的 `setWindowOpenHandler` 不会收到事件。`will-attach-webview` 继续负责安全硬化和二次固定参数，但不能代替 renderer 的创建期声明。

时序如下：

```text
React 创建 <webview allowpopups=""> 节点
  -> Electron 创建/attach guest（此时冻结 popup 能力）
  -> main did-attach-webview 安装 setWindowOpenHandler
  -> 网页点击 target=_blank
  -> handler 校验 http/https 并发送 OpenBrowserUrl
  -> renderer 在当前可见 workspace 新建并激活 Browser tab
```

回归基线：

- renderer 静态创建标记必须包含 `allowpopups`，不能只断言 mount 后的最终 DOM；
- main handler 单测继续覆盖内部 tab、系统浏览器 modifier 和非法协议；
- Electron 真机/CDP 用真实 guest 点击 `target="_blank"`，验证 webview target 数由 1 增为 2，且新 target URL 等于请求 URL。
