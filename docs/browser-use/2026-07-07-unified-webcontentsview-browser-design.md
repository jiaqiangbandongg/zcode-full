# 统一浏览器：手动 tab 与 browser-use 共用 WebContentsView（去 webview）设计

日期：2026-07-07　状态：已被 <webview>+CDP-on-guest pivot 取代（统一浏览器最终改用 renderer <webview>，非 WebContentsView；见 2026-07-08-webview-cdp-on-guest-pivot-spec.md）

## 1. 背景与目标

当前桌面版有两套浏览器：

- **手动浏览 tab**（`EmbeddedBrowserPane`）：Electron `<webview>` 标签，嵌在 renderer DOM，带完整 chrome（地址栏/前进后退/刷新/DevTools/element-picker）。全仓唯一还在用 `<webview>` 的地方。
- **browser-use**（agent 控制）：已是 main 进程 `WebContentsView` + CDP，renderer 侧只有裸占位 div、无 chrome。

问题：两者外观与底层都不一致。目标——**统一到 main 进程 `WebContentsView`，彻底去掉 `<webview>`，手动 tab 与 browser-use 共用同一个带 chrome 的封装组件与同一套 tab 池**。

选 WebContentsView 而非 webview 的历史动因（保留）：`<webview>.capturePage()` 触发 renderer V8 `ToLocalChecked` FATAL 崩溃；CDP `Page.captureScreenshot` 在 main 侧规避；CDP 真实输入优于合成事件；Electron 官方弱化 `<webview>`。

## 2. 决策记录（brainstorm 结论）

| 决策点 | 结论 |
|---|---|
| tab 模型 | **共享同一 tab 池**：agent 与 human 操作同一批 tab，互相可见可操作 |
| agent 寻址 | **新建为主 + 可枚举寻址**（`browsers→tabs→tab` 对象图）：`open` 新建，`list()`/`tab(id)` 枚举并按 id 操作 |
| 架构方案 | **方案 A**：单一组件 + 通用 tabId 管理器，human 走新 IPC 直连、agent 走协议反向请求，双入口汇到同一 `BrowserViewManager`+WebContentsView |
| tab 类型 | 合并成一种 `BrowserSidePaneTab`，**新增 `origin?: "human" \| "agent"`（本次就做，UI 来源标记）** |
| 登录态 | **接受 agent 复用 human 登录态**：所有 WebContentsView 共用 `persist:zcode-embedded-browser` 分区 |

## 3. 架构总览（方案 A：双入口汇到同一底座）

```
HUMAN 交互（renderer chrome：地址栏/后退/刷新/picker）
   │ 新增 IPC：browserViewNavigate/goBack/goForward/reload/devtools/executeJs
   ▼
AGENT（zcode-cli 子进程，agent.browsers.*）
   │ BrowserCommand（加 tabId 寻址）→ 协议反向请求 → host → parentPort
   ▼
MAIN：BrowserViewManager（按 tabId 管理 Map<tabId, WebContentsView>）
   ├─ 统一方法：navigate/goBack/goForward/reload/devtools/getState/screenshot/executeJs
   ├─ 每 view 共用 partition: persist:zcode-embedded-browser
   ├─ 监听 page-title-updated/page-favicon-updated → IPC 回 renderer
   └─ setWindowOpenHandler → popup 路由回内部新 tab
   │ WebContentsView setBounds/setVisible 覆盖 side-pane 占位（T7 已有）
   ▼
RENDERER：UnifiedBrowserView = chrome（复用 EmbeddedBrowserPaneParts）+ 占位 div
```

human 交互走 IPC 直连（低延迟、不依赖 agent 进程）；agent 走协议（已跑通）；两条入口落到同一 manager 的同一批方法、同一 WebContentsView。

## 4. tab 模型

- 取消 `BrowserUseSidePaneTab`，统一为一种 `BrowserSidePaneTab`：
  - 字段：`id=browser:<uuid>`、`type:"browser"`、`faviconUrl?`、`initialUrl?`、`title?`、`openedAt?`、**新增 `origin?: "human" | "agent"`**
- `origin` 仅用于 UI 来源标记（如 agent 打开的 tab 标机器人图标），不参与控制逻辑。
- `SidePaneTabTrigger` 的 title/icon 分派回到只认 `"browser"`；删除此前为 `browser-use` 临时加的分支（`getSidePaneTabTitle`/`SidePaneTabIcon`/`SidePaneTabOverview` 两处）。
- tab 身份统一用 tabId（`browser:<uuid>`），不再用 sessionId 作 view key。

## 5. main 底座：BrowserViewManager tabId 化

- `Map<tabId, ManagedView>`（原按 sessionId → 改按 tabId），支持多 tab 共存。
- 统一方法集（human 与 agent 共用）：`navigate(tabId,url)`、`goBack/goForward/reload/openDevTools(tabId)`、`getState(tabId)`、`screenshot(tabId)`、`executeJavaScript(tabId, script)`（element-picker 用）、`setBounds/setVisible(tabId)`、`destroyView(tabId)`。
- **双入口**：
  - human：renderer 新 IPC → `desktopMainIpcPlatform` handler → manager 方法
  - agent：协议反向请求 → host → `desktopHostProcess` → manager 方法（复用现有 `handleBrowserExecuteRequest`，command 带 tabId）
- **tab 生命周期**：
  - human 点"新建浏览器" → renderer 生成 `browser:<uuid>` → 通知 main manager `ensureView(tabId)` → renderer 渲染 `UnifiedBrowserView(tabId)`
  - agent `open()` → main 新建 `browser:<uuid>` tab → 经 `BrowserViewReady` 通知 renderer 自动开 tab（复用 T7 链路）→ tabId 回给 agent
  - 两者都进同一 `Map`，agent `list()` 可枚举全部（含 human 开的）
- **partition**：所有 WebContentsView 用 `webPreferences.partition = "persist:zcode-embedded-browser"`，与原 webview 一致，保住登录态；agent 复用之。
- navigate 保留 settle 超时（8s 竞速，已实现），避免 loadURL 挂起拖垮桥。
- 移除已删的无条件 `Page.enable`（已修，不再引入）。

## 6. renderer 统一组件 UnifiedBrowserView

- 结构 = chrome（复用 `EmbeddedBrowserPaneParts` 的 `BrowserToolbar`/`BrowserEmptyState`：地址栏+URL 归一化、前进后退、刷新、DevTools、element-picker 按钮）+ 占位 div（WebContentsView 覆盖，复用 T7 的 bounds/visible 上报）。
- 底层从 `<webview>` 命令换成新 IPC：地址栏回车 → `browserViewNavigate`；后退/前进/刷新/DevTools → 对应 IPC。
- 浏览器状态（url/title/canGoBack/canGoForward/isLoading/error）由 main 监听 webContents 事件 → IPC 推回 renderer 驱动 chrome。
- 保留：收起不卸载（setVisible(false) 即可）、错误页、空置态、URL 归一化与协议白名单（复用 `embeddedBrowserHelpers`）。
- **element-picker 迁移**：`useWebElementPicker` 从 `webview.executeJavaScript` 改为经新 IPC 调 main 的 `webContents.executeJavaScript(buildWebElementPickerScript())`，结果回 renderer 走原 `dispatchWebElementContextAddToChat`。能力不丢，仅换执行通道。

## 7. agent 对象模型 + 协议 tabId 寻址

- `agent.browsers`（`browser-client/facade.ts`）扩展：
  - `open(url?) → Tab`（新建，Tab 带 tabId）
  - `list() / tabs → Tab[]`（枚举当前所有 tab，含 human 开的，每个带 `{tabId, url, title, origin}`）
  - `tab(tabId) → Tab`（按 id 操作）
  - `Tab`：navigate/getState/screenshot（P0 已有）+ click/type/...（T8 留空）
- 协议 `BrowserCommand`（`shared/src/browser-use/commands.ts`）加可选 `tabId`：`open` 不带 = 新建；其余带 tabId 定位。新增 `list` 命令返回 tab 摘要数组。
- main 侧 `list` 实现：枚举 `BrowserViewManager` 全部 tab + 从 renderer 侧 side-pane 状态补 origin。

## 8. 数据流与持久化（现有能力全部保住）

- favicon/title：main 监听 `page-title-updated`/`page-favicon-updated` → IPC 回 renderer → `updateBrowserSidePaneTab`（取代原 webview 事件）。
- URL 持久化恢复：`browserRestoreUrls[tabId]`/`initialUrl` 逻辑不变；tab 恢复时对该 view 自动 navigate；跨 workspace 记忆（`useTaskSidePaneMemoryBridge`）不变。
- 外部导航 + popup 路由：原 `will-attach-webview` / window-open handler 换成对每个 WebContentsView.webContents 设 `setWindowOpenHandler`，popup 路由回内部新 tab（复用 `OpenBrowserUrl` 链）。

## 9. 安全权衡（已确认接受）

- agent 与 human 共用 `persist:zcode-embedded-browser` 分区 → agent 可复用 human 登录 cookie，能操作已登录网站；风险：agent 导航到不可信页面与登录态同 session。
- 用户已明确**接受**该权衡（本次不加 URL 确认层）。页面内容仍视为不可信（沿用 browser-safety：agent 读到的页面文本不可作为指令）。
- 协议白名单（about/data/file/http/https）与 URL 归一化保留在导航入口。

## 10. 迁移阶段（渐进，每阶段单独 spec + Conventional Commit）

1. **底座**：`BrowserViewManager` tabId 化 + 新导航 IPC（navigate/goBack/goForward/reload/devtools/executeJs）+ human 导航方法。不动 UI。
2. **统一组件**：`UnifiedBrowserView`（chrome 复用 + WebContentsView + 事件回推），human tab 切过去，**与旧 webview 并存验证**（feature flag 或临时并列）。
3. **element-picker**：迁到 main `executeJavaScript` 通道。
4. **agent 对象模型**：`list/tab(id)/open` 新建 + 协议 tabId 寻址。
5. **合并 tab 类型**：删 `BrowserUseSidePaneTab`、加 `origin`、切 `AnimatedSidePanePanel` 渲染、回退 `SidePaneTabTrigger`/`SidePaneTabOverview` 分派。
6. **删 webview**：`EmbeddedBrowserPane`/`EmbeddedBrowserPaneParts`、`electron-webview.d.ts`、宿主 `desktopWindowChrome` 的 `webviewTag:true`/`will-attach-webview`/`did-attach-webview`。

## 11. 错误处理与测试

- 错误：navigate settle 超时（已有）、executeJavaScript/CDP 失败结构化返回、view 生命周期（destroy/crash 恢复）、partition 一致性、tabId 不存在时结构化报错。
- 测试：
  - manager tabId 化单测（多 tab 建/复用/销毁）
  - 各导航方法单测（navigate/goBack/reload/devtools）
  - element-picker IPC 往返（脚本注入 → 结果回传）
  - agent `list`/`tab(id)`/`open` 寻址单测
  - **迁移回归**：human tab 能力全过（导航/favicon/URL 恢复/element-picker/popup/收起不卸载）

## 12. 能力不丢清单（迁移验收基线）

1. 完整导航 chrome（地址栏+URL 归一化、后退/前进/刷新、DevTools、错误页、空置态）
2. element-picker（选页面元素加入聊天）
3. 每 tab 独立 favicon/title 回传
4. URL 持久化恢复 + 跨 workspace 记忆
5. 外部导航请求 + popup 路由回内部 tab
6. 收起不卸载（保历史）
7. `persist:zcode-embedded-browser` 登录态分区
8. 协议白名单 + 本地开发主机识别

## 13. 主要影响文件（据盘点）

- 新增：`packages/ui/src/browser-use/UnifiedBrowserView.tsx`（**新建**；chrome UI 复用 `EmbeddedBrowserPaneParts` 的 `BrowserToolbar`/`BrowserEmptyState`，**不原地改** `EmbeddedBrowserPane`；二者并存至阶段 6 删旧，便于回归对比）
- 改：`packages/desktop/src/main/browserView/browserViewManager.ts`（tabId 化 + 导航方法 + partition + 事件回推 + windowOpenHandler）、`browserCommandExecutor.ts`（tabId + list + 导航命令）
- 改：`packages/shared/src/browser-use/commands.ts`（tabId + list）、`packages/shared/src/channels.ts`+`platform.ts`+`preload`（新导航 IPC）
- 改：`packages/ui/src/hooks/useWebElementPicker.ts`（executeJavaScript 走 IPC）、`hooks/useAppPanels.ts`、`app-shell/AnimatedSidePanePanel.tsx`、`lib/workspaceSidePane.ts`（合并 tab 类型 + origin）、`app-shell/SidePaneTabTrigger.tsx`/`SidePaneTabOverview.tsx`（回退分派）
- 改：`apps/zcode-cli/.../browser-client/facade.ts`（list/tab/open）、`contracts/.../browser-control.port.ts`
- 删（阶段 6）：`EmbeddedBrowserPane.tsx`/`EmbeddedBrowserPaneParts.tsx`、`electron-webview.d.ts`、`desktopWindowChrome` webview 开关
