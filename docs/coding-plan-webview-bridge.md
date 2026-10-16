# Coding Plan WebView Bridge

官网 `/coding-plan` 页面只允许 ZCode App WebView 内嵌访问，App 打开时必须携带 `embedded=app`，并通过 WebView 注入当前 provider 的购买凭据。

同步链路：

```text
用户点击升级/续费
  -> CodingPlanUpgradeDialog 收到 providerId、audience，以及可选的 teamPlanKey
  -> App 解析官网地址
     - 本地开发：    http://localhost:3000
     - 测试环境：    https://zcode.z.ai
     - 正式环境：    https://zcode.z.ai
     - 显式 override：VITE_CODING_PLAN_WEBVIEW_ORIGIN
  -> WebView 打开 /coding-plan?provider={zai|bigmodel}&audience={personal|team}&teamPlanKey={可选}&embedded=app&lang={cn|en}&theme={zai-light|zai-dark}
  -> dom-ready 后从 credentialService 读取 token
  -> executeJavaScript 先清理旧 provider token，再写入 WebView origin 的 localStorage，并同步 App theme class
  -> dispatch zcode-coding-plan-auth-ready
  -> 官网页重新拉取 batch-preview / preview / purchase
```

`lang` 和 `theme` 都是首屏 hint：官网会在 App 注入脚本执行前先用它们渲染正确语言和主题。尤其是 `theme`，用于避免官网 SSR 默认深色和 App 浅色主题之间的首次打开闪烁；真实运行态主题仍以后续注入脚本写入的 `zcode-theme` 和 class 为准。

`audience` 与 `teamPlanKey` 表达用户点击升级时的套餐意图。Z.ai/BigModel 只由 Provider ID 决定官网 family；个人套餐传 `audience=personal`，团队套餐传 `audience=team` 并携带当前团队连接 key。它们不参与鉴权，也不替代官网对实际套餐和团队权限的判断。

WebView 外壳继续保留 App 购买页原有结构：全屏覆盖、顶部“升级套餐”标题栏、右侧关闭按钮，以及标题栏下方的 150% 配额活动提示。官网页面只承载套餐主体和后续支付流程。

WebView 接入层隐藏宿主滚动容器和 guest 页面内的原生滚动条，但不禁用页面滚动。App 在每次 `dom-ready` 后注入 `zcode-coding-plan-hide-scrollbar` 样式，覆盖官网页和后续三方支付/回跳页，避免官网内容与 App 全局滚动条样式叠加后出现额外视觉噪音。

注入 key 与 App 购买接口保持一致：

| Provider             | WebView localStorage key      |
| -------------------- | ----------------------------- |
| Z.ai                 | `oauth:zai:access_token`      |
| Z.ai Start Plan 兜底 | `zcodejwttoken`               |
| BigModel             | `oauth:bigmodel:access_token` |

token 不放入 URL query，避免被浏览器历史、日志、埋点和 Referer 泄露。WebView 页面只能通过当前 origin 的 localStorage 读取注入值。

## 加载失败 fallback

按用户决策，WebView 不可用时**不回退到老 React Dialog**，只报错并引导用户去官网自行购买：

- 监听 `<webview>` 的 `did-fail-load`（主 frame）和 `render-process-gone` 事件。
- 触发后展示错误态：`settings.modelProvider.codingPlan.webview.loadFailed` + 错误详情。
- 错误态下 webview 元素 `hidden`，并提供两个操作：
  - **前往官网购买**：`IPlatformService.openExternal(webviewUrl)` 打开系统浏览器。
  - **重试**：`webview.reload()`。
- 凭据注入失败（`executeJavaScript` 抛错）走单独的 `authInjectFailed` 重试条，与加载失败区分。

## 购买完成回传

官网页购买成功后，通过 **preload + ipc-message** 通道实时通知 App，App 刷新套餐状态后自动关闭 webview。

### 协议

```text
[官网页] 购买成功（Alipay 轮询 / Stripe / 企业订单 onSuccess）
    │
    │ window.zcodeBridge?.notifyPurchaseComplete?.({ provider })   ← no-op guard
    ▼
[preload: packages/desktop/src/preload/codingPlanWebview.ts]
    │ ipcRenderer.sendToHost("zcode:coding-plan-purchase-complete", {
    │   provider: "zai" | "bigmodel",
    │   timestamp: number,            ← 客户端时间戳，仅用于日志/去重
    │ })
    ▼
[host renderer: CodingPlanEmbeddedWebviewDialog]
    │ webview.addEventListener("ipc-message", ...)
    │   if (event.channel !== CodingPlanWebviewChannels.PurchaseComplete) return
    │   校验 payload.provider ∈ {"zai","bigmodel"}
    │   onPurchaseCompleteRef.current?.()
    ▼
[CodingPlanUpgradeDialog.handlePurchaseComplete]
    │ closeAndRefreshCodingPlanUpgradeFromWebview(...)
    │   1. onClose()   ← 先关闭 webview，避免弱网刷新阻塞用户回到主界面
    │   2. refreshCodingPlanUpgradeCompletion(...)
    │      ├─ refreshCodingPlanApiKey（每个 provider）
    │      ├─ refreshModelProviders
    │      ├─ refreshCodingPlanEntitlements
    │      └─ codingPlanSubscriptionService.getEnterprisePricing({
    │           authenticated: true,
    │           family: teamPlanFamily,   ← "zai" | "bigmodel"
    │         })
```

### 频道与 payload

- 频道名：`zcode:coding-plan-purchase-complete`（定义于 `packages/shared/src/channels.ts` 的 `CodingPlanWebviewChannels.PurchaseComplete`）
- payload 类型：`CodingPlanPurchaseCompletePayload`
  - `provider`: `"zai" | "bigmodel"`，与 auth-ready 事件的 `detail.provider` 同构
  - `timestamp`: `number`，客户端时间戳，App 侧仅用于日志/去重，不参与判等

### preload 分流

`desktopWindowChrome.ts` 的 `will-attach-webview` 钩子按 `params.src` 分流：

- `/coding-plan?...&embedded=app`（http/https）→ `codingPlanWebviewPreloadPath`（挂 `window.zcodeBridge`）
- 其余 webview（内置浏览器等）→ `embeddedBrowserJavaScriptDialogPreloadPath`（原 alert/confirm 桥）

两者 webPreferences（contextIsolation=true / sandbox=true / nodeIntegration=false）一致。

### 官网页调用点

`components/coding-plan/coding-plan-page.tsx` 中 3 处（helper `notifyZcodeBridgePurchaseComplete(provider)` 内置 no-op guard，官网单独跑零影响）：

| 支付场景                                | 位置                        | provider   |
| --------------------------------------- | --------------------------- | ---------- |
| Alipay 二维码轮询成功（bigmodel 个人）  | alipay-qr useEffect         | `bigmodel` |
| 企业订单轮询 onSuccess（bigmodel 团队） | `pollEnterpriseOrderStatus` | `bigmodel` |
| Stripe 支付成功（zai 个人 + 海外团队）  | `onStripePay`               | `zai`      |

### 安全

- host renderer 收到 `ipc-message` 后校验 `provider` 字段，只接受 `zai`/`bigmodel`，忽略非法 payload。
- 官网页是外部 https 站点；`will-attach-webview` 仍按 `isAllowedEmbeddedBrowserUrl` 做 protocol 白名单。
- preload 暴露的 `window.zcodeBridge` 只包含业务最小面：`notifyPurchaseComplete`、`getLang`、`onLangChange`、`openExternal`，不暴露 `ipcRenderer` / Node 原语；`openExternal` 在 preload 和 main 进程都只允许 `http:` / `https:`。
- WebView 使用 `persist:zcode-coding-plan` 独立持久 partition。App 注入凭据前和关闭购买页时会清理 `oauth:zai:access_token` / `zcodejwttoken` / `oauth:bigmodel:access_token`；退出登录或 Clear All Data 会通过桌面命令清理整个 partition，避免账号切换后官网首屏读到旧 token。
