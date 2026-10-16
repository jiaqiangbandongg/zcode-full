# BigModel OAuth 登录设计

## 概述

将现有的用户名密码登录替换为 BigModel OAuth 登录。登录非强制，用户可不登录直接使用应用。点击主界面右上角登录按钮弹出 LoginDialog，通过 OAuth 跳转浏览器完成认证后自动回到应用。

仅实现 Desktop (Electron) 端，Web 端暂不支持。

## 整体流程

```
用户点击右上角「登录」按钮
        │
        ▼
  弹出 LoginDialog
  点击「通过 BigModel 登录」
        │
        ▼
  useOAuth hook:
        │ RPC 调用 oauthService.startOAuth() → 返回 { authorizeUrl, state }
        │ IPC 上报 state 给 Main（用于 deep link 路由）
        │ 调用 platform.openExternal(authorizeUrl)
        │
        ▼
  Main Process（调度层）
        │ 记录 state → webContents.id 映射
        │ shell.openExternal(authorizeUrl)
        │
        ▼
  浏览器打开 BigModel 登录页
  用户完成认证（手机号验证码等）
        │
        ▼
  BigModel 重定向 zcode://bigmodel-auth/callback?code=xxx&state=xxx
        │
        ▼
  Main Process 捕获 deep link（仅提取 URL）
        │ 从 URL 解析 state → 查 state→windowId 映射 → 找到目标窗口
        │ 转发 URL 给目标窗口的 renderer
        │ targetWindow.webContents.send(PlatformChannels.OAuthCallback, url)
        │
        ▼
  Renderer 收到 OAuthCallback 事件（Root/App 常驻监听）
        │ RPC 调用 oauthService.handleCallback(url)
        │   ├ 校验 state（匹配后立即删除，防重放）
        │   ├ POST tokenUrl 用 code + code_verifier 换 access_token
        │   ├ 存 token 到 credentialService
        │   └ (可选) GET userinfoUrl 获取用户信息
        │ 返回 userInfo
        │
        ▼
  更新 Zustand store（唯一数据源）→ 关闭 LoginDialog
```

## Custom Protocol 注册与 Deep Link 处理

### 协议注册

当前代码中不存在任何 protocol / single-instance 基础设施，需从零搭建。

在 `packages/desktop/src/main/index.ts` 中：

```ts
// 在 app.whenReady() 之前注册协议
app.setAsDefaultProtocolClient('zcode')

// 单实例锁（新增）
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
}
```

### 跨平台 Deep Link 捕获

#### macOS

macOS 通过 `open-url` 事件传递 deep link，无论应用是否已运行。

**必须在 `app.whenReady()` 之前注册**，否则冷启动时的 deep link 事件会丢失：

```ts
// 在 app.whenReady() 之前注册
app.on('open-url', (event, url) => {
  event.preventDefault()
  handleDeepLink(url)
})
```

冷启动时 Electron 在 macOS 上会自动触发 `open-url`，无需从 `process.argv` 提取。

**注意：** macOS 打包后需要 `Info.plist` 中声明 `CFBundleURLTypes`。通过 `electron-builder.config.js` 配置：

```js
// packages/desktop/electron-builder.config.js
{
  protocols: [
    {
      name: 'zcode',
      schemes: ['zcode'],
    },
  ],
}
```

#### Windows / Linux

通过单实例锁 + `second-instance` 事件（新增）：

```ts
app.on('second-instance', (event, argv) => {
  // Windows/Linux: 协议 URL 通过命令行参数传入
  const url = argv.find(arg => arg.startsWith('zcode://'))
  if (url) handleDeepLink(url)

  // 聚焦已有窗口
  const win = BrowserWindow.getAllWindows()[0]
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})
```

冷启动时（应用之前未运行），URL 在 `process.argv` 中：

```ts
// app.whenReady() 内，窗口创建后检查
const protocolUrl = process.argv.find(arg => arg.startsWith('zcode://'))
if (protocolUrl) handleDeepLink(protocolUrl)
```

**注意：** 冷启动时 deep link 可能早于 renderer mount 完毕。Main process 需缓存待处理的 deep link URL：

```ts
let pendingDeepLinkUrl: string | null = null

function handleDeepLink(url: string) {
  if (!url.startsWith('zcode://bigmodel-auth/callback')) return

  const state = new URL(url).searchParams.get('state')
  if (!state) return

  const targetWindowId = oauthStateToWindow.get(state)
  const targetWindow = targetWindowId
    ? BrowserWindow.getAllWindows().find(w => w.webContents.id === targetWindowId)
    : null

  if (targetWindow) {
    targetWindow.webContents.send(PlatformChannels.OAuthCallback, url)
    oauthStateToWindow.delete(state)
  } else {
    // Renderer 尚未就绪（冷启动），缓存 URL，等 renderer ready 后再发送
    pendingDeepLinkUrl = url
  }
}

// Renderer ready 后（通过 IPC 通知），发送缓存的 deep link
ipcMain.on(PlatformChannels.RendererReady, (event) => {
  if (pendingDeepLinkUrl) {
    event.sender.send(PlatformChannels.OAuthCallback, pendingDeepLinkUrl)
    pendingDeepLinkUrl = null
  }
})
```

注意：`pendingDeepLinkUrl` 只用于冷启动场景（应用之前未运行，由协议唤起）。冷启动时只有一个窗口正在创建，所以单值即可，不存在多窗口竞争。应用已运行时收到的 deep link 走 `state→windowId` 映射路由，不经过此缓存。

#### handleDeepLink — Main 仅做调度

```ts
// Main process 中的 handleDeepLink 只做 URL 提取和转发，不做业务逻辑
// 通过 state → windowId 映射路由到正确的窗口
const oauthStateToWindow = new Map<string, number>()

function handleDeepLink(url: string) {
  // 实现见上文「冷启动缓存」部分
}
```

## IOAuthService（新增 RPC 服务）

OAuth 业务逻辑放在 host process，遵循 AGENTS.md 规范。按照「新增服务 Checklist」执行：

### 服务接口

```ts
// packages/services/src/oauth/oauth.ts（新建）
import { createServiceDescriptor } from '@zcode/rpc'
import { ServiceChannels } from '@zcode/shared'

export interface IOAuthService {
  // 发起 OAuth：生成 state + PKCE，返回完整的 authorize URL 和 state
  startOAuth(): Promise<{ authorizeUrl: string; state: string }>

  // 处理回调：校验 state，code 换 token，存凭据，返回用户信息
  handleCallback(url: string): Promise<UserInfo>

  // 刷新 token
  refreshToken(token: string): Promise<void>

  // 清理（超时等）
  cancelPending(): Promise<void>
}

export const IOAuthService = createServiceDescriptor<IOAuthService>(ServiceChannels.OAuth)
```

### 服务实现

```ts
// packages/services/src/oauth/oauthService.ts（新建）
export class OAuthService implements IOAuthService {
  // 注入 ICredentialService，在 host process 内部使用
  constructor(private credentialService: ICredentialService) {}

  private pendingStates = new Map<string, { timeout: NodeJS.Timeout; codeVerifier: string }>()

  async startOAuth(): Promise<{ authorizeUrl: string; state: string }> {
    // 生成 state（随机 32 字节 hex）
    // 生成 PKCE code_verifier + code_challenge
    // 存入 pendingStates，设置 5 分钟超时
    // 构建并返回 { authorizeUrl, state }
  }

  async handleCallback(url: string): Promise<UserInfo> {
    // 解析 URL 提取 code、state
    // 校验 state（匹配后立即删除）
    // POST tokenUrl：code + code_verifier 换 token
    // 存 token 到 credentialService
    // (可选) GET userinfoUrl 获取用户信息
    // 返回 UserInfo
  }

  async cancelPending(): Promise<void> {
    // 清理所有 pending state 和超时定时器
  }

  async refreshToken(token: string): Promise<void> {
    // POST tokenUrl (grant_type=refresh_token) 刷新 token
    // 更新 credentialService 中的 auth_token 和 refresh_token
  }
}
```

### 注册步骤（按 AGENTS.md Checklist）

1. `packages/shared/src/channels.ts` — `ServiceChannels` 新增 `OAuth`
2. `packages/services/src/oauth/oauth.ts` — 接口 + descriptor
3. `packages/services/src/oauth/oauthService.ts` — Node.js 实现
4. `packages/services/src/accessor.ts` — `IServiceAccessor` 新增 `oauthService`
5. `packages/services/src/index.ts` — 导出
6. `packages/services/src/node.ts` — `createLocalServices()` 注册
7. `packages/client/src/remoteServiceAccess.ts` — ProxyChannel
8. `packages/ui/src/hooks/useOAuth.ts` — 新增 hook（见下文）

## IPC 通信

### Channels

```ts
// packages/shared/src/channels.ts

// OAuthService 作为 RPC 服务，使用 ServiceChannels
export const ServiceChannels = {
  ...existing,
  OAuth: 'oauth',
}

// Deep link 相关的平台 channel
export const PlatformChannels = {
  ...existing,
  OpenExternal: 'zcode:open-external',          // Renderer → Main：打开外部 URL
  OAuthRegisterState: 'zcode:oauth-register-state', // Renderer → Main：上报 state 用于路由
  OAuthCallback: 'zcode:oauth-callback',         // Main → Renderer：转发 deep link URL
  RendererReady: 'zcode:renderer-ready',         // Renderer → Main：renderer 已就绪
}
```

注意：不需要 `OAuthSuccess` / `OAuthError` channel。OAuth 启动通过 RPC 调用 `oauthService.startOAuth()`，回调处理通过 RPC 调用 `oauthService.handleCallback(url)`，结果直接在 renderer 侧获得，不经过 main 中转。

### Main Process 调度流程

```ts
// Main process 只做三件事：
// 1. 记录 state → windowId 映射（Renderer 上报）
// 2. 监听 deep link → 根据 state 路由到正确窗口
// 3. 缓存冷启动的 deep link，等 renderer ready 后转发

const oauthStateToWindow = new Map<string, number>()
let pendingDeepLinkUrl: string | null = null

// Renderer 通过 RPC 获取 authorizeUrl 和 state 后，上报 state 用于路由
ipcMain.on(PlatformChannels.OAuthRegisterState, (event, state: string) => {
  oauthStateToWindow.set(state, event.sender.id)

  // 5 分钟超时自动清理，防止残留脏映射
  setTimeout(() => oauthStateToWindow.delete(state), 5 * 60 * 1000)
})

// 窗口关闭时清理该窗口的所有 state 映射
app.on('browser-window-created', (_, win) => {
  win.on('closed', () => {
    for (const [state, id] of oauthStateToWindow) {
      if (id === win.webContents.id) oauthStateToWindow.delete(state)
    }
  })
})

// 打开外部 URL（用于 OAuth 跳转浏览器）
ipcMain.on(PlatformChannels.OpenExternal, (event, url: string) => {
  shell.openExternal(url)
})

// Renderer ready 后，发送缓存的 deep link
ipcMain.on(PlatformChannels.RendererReady, (event) => {
  if (pendingDeepLinkUrl) {
    event.sender.send(PlatformChannels.OAuthCallback, pendingDeepLinkUrl)
    pendingDeepLinkUrl = null
  }
})

// handleDeepLink 实现见「Custom Protocol」章节
```

### IPlatformService 扩展

```ts
// packages/shared/src/platform.ts
export interface IPlatformService {
  // 保留的现有方法（selectDirectory、activateOrSetWorkspace、connectRemote、log 等）
  // 删除：loginSuccess()、logout()
  // 新增：
  openExternal(url: string): void
  registerOAuthState(state: string): void
  onOAuthCallback(callback: (url: string) => void): (() => void)  // 返回 disposer
  notifyRendererReady(): void
}
```

注意：`onOAuthCallback` 返回 disposer 函数，调用时只移除当前回调，不影响其他订阅者。

Desktop 实现（`packages/desktop/src/renderer/src/main.tsx`）：
```ts
openExternal: (url) => window.zcode.openExternal(url),
registerOAuthState: (state) => window.zcode.registerOAuthState(state),
onOAuthCallback: (cb) => window.zcode.onOAuthCallback(cb),
notifyRendererReady: () => window.zcode.notifyRendererReady(),
```

Web 实现（`packages/web/src/main.tsx`）：
```ts
openExternal: () => { throw new Error('Not supported in web') },
registerOAuthState: () => {},
onOAuthCallback: () => () => {},  // 返回空 disposer
notifyRendererReady: () => {},
```

### window.zcode 更新

Preload bridge（`packages/desktop/src/preload/index.ts`）：
```ts
openExternal: (url: string) => ipcRenderer.send(PlatformChannels.OpenExternal, url),
registerOAuthState: (state: string) => ipcRenderer.send(PlatformChannels.OAuthRegisterState, state),
onOAuthCallback: (cb: (url: string) => void) => {
  const handler = (_: any, url: string) => cb(url)
  ipcRenderer.on(PlatformChannels.OAuthCallback, handler)
  // 返回 disposer，只移除当前回调
  return () => ipcRenderer.removeListener(PlatformChannels.OAuthCallback, handler)
},
notifyRendererReady: () => ipcRenderer.send(PlatformChannels.RendererReady),
```

类型声明（`packages/client/src/globals.d.ts`）同步更新。

同步更新 AGENTS.md 中 `window.zcode` 允许列表，新增 `openExternal`、`registerOAuthState`、`onOAuthCallback`、`notifyRendererReady`。

## UI 层改造

### useOAuth hook

```ts
// packages/ui/src/hooks/useOAuth.ts（新建）
// 仅负责登录流程的发起和 UI 状态管理
export function useOAuth() {
  const { oauthService } = useServices()
  const platform = usePlatform()

  const startLogin = async () => {
    // 1. RPC 调用 oauthService.startOAuth() → 返回 { authorizeUrl, state }
    // 2. platform.registerOAuthState(state) — 上报给 main 用于 deep link 路由
    // 3. platform.openExternal(authorizeUrl) — 打开浏览器
  }

  return { startLogin, status, error }
}
```

OAuth 回调监听和 notifyRendererReady **不放在 useOAuth 中**（因为它只在 LoginDialog 挂载时存在），而是放在 Root/App 常驻层：

```ts
// packages/ui/src/Root.tsx（或 App.tsx）中
// 常驻挂载，确保回调监听始终存在
useEffect(() => {
  const dispose = platform.onOAuthCallback(async (url) => {
    // RPC 调用 oauthService.handleCallback(url) 完成 token exchange
    // 成功 → setUser(userInfo)（更新 Zustand store）
    // 失败 → logger 记录错误
  })

  // 通知 main process renderer 已就绪，触发缓存的冷启动 deep link 转发
  platform.notifyRendererReady()

  return dispose
}, [])
```

这样即使 LoginDialog 未打开或被意外关闭，OAuth 回调仍能正确处理并更新登录状态。

### LoginDialog（改造自 WelcomeScreen）

WelcomeScreen 从全屏页面改造为 Dialog 组件，使用 shadcn Dialog 包裹。

接口：
```tsx
LoginDialog({
  open: boolean
  onOpenChange: (open: boolean) => void
})
```

内部使用 `useOAuth()` hook 驱动全部 OAuth 逻辑。

状态机：

```
┌─────────────┐    点击按钮    ┌──────────────┐    回调成功    ┌──────────┐
│   idle      │ ─────────────▶ │  waiting     │ ─────────────▶ │ success  │
│ 显示登录按钮  │               │ 等待浏览器认证 │               │ 关闭 dialog│
└─────────────┘               └──────────────┘               └──────────┘
                                     │
                              超时/失败/取消
                                     │
                                     ▼
                              ┌──────────────┐
                              │   error      │
                              │ 显示错误信息   │
                              └──────┬───────┘
                                     │ 重试
                                     ▼
                              回到 idle
```

- 日志使用 `packages/ui/src/logger.ts`
- 文案使用 i18n
- 删除用户名、密码相关的 state、input、校验逻辑
- 删除 `TID_USERNAME_INPUT`、`TID_PASSWORD_INPUT` 等 test ID
- 新增 `TID_OAUTH_LOGIN_BUTTON`、`TID_OAUTH_CANCEL`

### 右上角登录按钮

复用现有按钮：
- 未登录（user === null）→ 点击弹出 LoginDialog
- 已登录 → 显示用户信息，点击可 logout

### Auth 状态统一为 Zustand store

当前问题：Root.tsx 用 `useState` 管理 `user`，Zustand store 也定义了 `user` 但从未被使用，是死代码。

修正：统一为 Zustand store 作为唯一数据源。

- 删除 Root.tsx 中的 `const [user, setUser] = useState<UserInfo | null>(...)`
- Root.tsx 改为 `const user = useZCodeStore(s => s.user)`
- 所有登录/登出操作通过 `useZCodeStore(s => s.setUser)` 更新
- 启动时 Root 通过 `useAuthToken().getToken()` 读取 token，有则调用 `setUser`

## 启动流程调整

```ts
// packages/desktop/src/main/index.ts
// 删除 hasAuthToken() 函数及其分支判断
// 删除 createLoginWindow()
// 始终 createWindow()
// 新增：setAsDefaultProtocolClient('zcode')
// 新增：requestSingleInstanceLock()
// 新增：open-url / second-instance 监听
```

Root 组件启动时：
```ts
// 通过 useAuthToken() hook 读取 token
// 有 token → 读取缓存的 user_info → setUser(userInfo)（Zustand store）
// 无 token → user = null，正常使用，不阻塞
```

## Token 管理

### 存储

使用现有 `credentialService`（`~/.zcode/v2/credentials.json`）：

| Key | 用途 |
|---|---|
| `auth_token` | access_token，保持现有 key 不变 |
| `refresh_token` | 刷新 token（如果 BigModel 返回） |
| `user_info` | 缓存的用户信息 JSON |

### Token 刷新策略

Token 刷新逻辑**不放在 `useOAuth` hook 中**（因为 LoginDialog 大多数时候未挂载），而是放在常驻层：

- 在 Root 或 App 组件中挂载一个常驻的 `useTokenRefresh` hook
- 该 hook 监听全局的 401 事件（通过 Zustand store 的标志位或 broadcastService 广播）
- 收到 401 → 调用 `oauthService.refreshToken(refreshToken)`
- 刷新成功 → 更新 token，重试请求
- 刷新失败 → 清除凭证 + `setUser(null)`，用户需重新登录

`useOAuth` hook 只负责登录流程（`startOAuth` + deep link 回调处理），不负责 token 刷新。

`IOAuthService` 的 `refreshToken(token: string): Promise<void>` 方法在 host process 中执行 token 刷新请求和凭据更新。

### Logout

1. 通过 `credentialService` 删除 `auth_token`、`refresh_token`、`user_info`
2. `setUser(null)`（Zustand store）
3. 不关闭窗口，不 reload

### loginSuccess / logout 方法迁移

删除登录窗口后，现有的 `loginSuccess` 和 `logout` 平台方法语义失效，需要调整：

| 方法 | 当前语义 | 新方案 |
|---|---|---|
| `window.zcode.loginSuccess` | 关闭登录窗口，打开主窗口 | **删除**。不再有登录窗口切换，登录成功由 Root 常驻的回调监听通过 Zustand store 更新 UI |
| `window.zcode.logout` | 关闭主窗口，打开登录窗口 | **删除**。logout 不再是平台操作，完全在 UI/Hook 层处理 |
| `IPlatformService.loginSuccess` | 同上 | **删除** |
| `IPlatformService.logout` | 同上 | **删除**。logout 业务逻辑由 UI/Hook 层通过 credentialService + Zustand 处理 |
| `PlatformChannels.LoginSuccess` | IPC 通知 main 切换窗口 | **删除** |
| `PlatformChannels.Logout` | IPC 通知 main 切换窗口 | **删除** |

Logout 在 UI 层实现（如 `useLogout` hook 或直接在组件中）：
```ts
// UI/Hook 层，不经过 IPlatformService
async function handleLogout() {
  const { credentialService } = useServices()
  await credentialService.delete('auth_token')
  await credentialService.delete('refresh_token')
  await credentialService.delete('user_info')
  setUser(null)  // Zustand store
}
```

影响的文件（已纳入改动清单，此处仅做说明）：
- `packages/shared/src/platform.ts` — 删除 `loginSuccess()`、`logout()`
- `packages/shared/src/channels.ts` — 删除 `PlatformChannels.LoginSuccess`、`PlatformChannels.Logout`
- `packages/desktop/src/main/index.ts` — 删除 `LoginSuccess` / `Logout` 的 IPC 监听及窗口切换逻辑
- `packages/desktop/src/preload/index.ts` — 删除 `loginSuccess`、`logout`
- `packages/client/src/globals.d.ts` — 同步更新类型
- `AGENTS.md` — 从 `window.zcode` 允许列表中删除 `loginSuccess`

## OAuth 配置

```ts
// packages/shared/src/oauth.ts（新建）
export const BIGMODEL_OAUTH_CONFIG = {
  authorizeUrl: 'https://bigmodel.cn/login',
  tokenUrl: 'https://bigmodel.cn/api/oauth/token',      // 待确认
  userinfoUrl: 'https://bigmodel.cn/api/oauth/userinfo',  // 待确认，可选
  appId: 'zcode-bigmodel-app',                            // 待确认
  redirectUri: 'zcode://bigmodel-auth/callback',
}
// Desktop 是 public client，不使用 clientSecret，通过 PKCE 保障安全
```

## 安全措施

- **state**：每次请求生成随机 32 字节 hex，存 Map，回调时校验后立即删除
- **PKCE**：必须实现。Desktop 属于 public client，无法安全保存 clientSecret。使用 S256 方法生成 `code_verifier`（随机 43-128 字符）和 `code_challenge`（SHA256 hash + base64url 编码）。如果 BigModel 不支持 PKCE，则作为已知安全风险在文档中标注，并考虑其他缓解措施
- **超时**：5 分钟无回调自动清理 state，通知 renderer 显示超时
- **防重复**：点击登录按钮时检查 pendingStates，已有则忽略。该检查在 OAuthService 内部，per-service 实例（即 per-window 的 host process），不会阻塞其他窗口
- **不使用 clientSecret**：Desktop public client 不适合存储 secret

## 改动范围

### 新建的文件

| 文件 | 说明 |
|---|---|
| `packages/shared/src/oauth.ts` | OAuth 配置常量 |
| `packages/services/src/oauth/oauth.ts` | IOAuthService 接口 + descriptor |
| `packages/services/src/oauth/oauthService.ts` | OAuthService Node.js 实现 |
| `packages/ui/src/hooks/useOAuth.ts` | OAuth 登录流程 hook |
| `packages/ui/src/hooks/useTokenRefresh.ts` | Token 刷新 hook（常驻层） |

### 修改的文件

| 文件 | 改动 |
|---|---|
| `packages/shared/src/channels.ts` | ServiceChannels 新增 OAuth；PlatformChannels 新增 OpenExternal、OAuthRegisterState、OAuthCallback、RendererReady；删除 LoginSuccess、Logout |
| `packages/shared/src/platform.ts` | IPlatformService 新增 openExternal、registerOAuthState、onOAuthCallback、notifyRendererReady；删除 loginSuccess()、logout() |
| `packages/services/src/accessor.ts` | IServiceAccessor 新增 oauthService |
| `packages/services/src/index.ts` | 导出 oauth 模块 |
| `packages/services/src/node.ts` | createLocalServices() 注册 OAuthService |
| `packages/client/src/remoteServiceAccess.ts` | ProxyChannel 新增 oauth |
| `packages/client/src/globals.d.ts` | window.zcode 类型新增 openExternal、registerOAuthState、onOAuthCallback、notifyRendererReady；删除 loginSuccess、logout |
| `packages/desktop/electron-builder.config.js` | 新增 protocols 配置（macOS plist 协议声明） |
| `packages/desktop/src/main/index.ts` | 注册 custom protocol、requestSingleInstanceLock、open-url/second-instance 监听、state→window 映射、冷启动缓存、删除 createLoginWindow、删除 hasAuthToken 分支、删除 LoginSuccess/Logout IPC 窗口切换逻辑 |
| `packages/desktop/src/preload/index.ts` | 暴露 openExternal、registerOAuthState、onOAuthCallback、notifyRendererReady；删除 loginSuccess、logout |
| `packages/desktop/src/renderer/src/main.tsx` | 删除 skipAuth，platform 实现新增方法 |
| `packages/ui/src/WelcomeScreen.tsx` | 改造为 LoginDialog |
| `packages/ui/src/Root.tsx` | 删除 mock 登录逻辑和 useState user，改用 Zustand store；新增常驻的 OAuth 回调监听 + notifyRendererReady |
| `packages/ui/src/store/index.ts` | 删除 MOCK_USER |
| `AGENTS.md` | 更新 window.zcode 允许列表（新增 OAuth 方法，删除 loginSuccess），更新"包括登录窗口"描述 |

### 删除的内容

| 删除内容 | 文件 |
|---|---|
| `createLoginWindow()` 函数 | `packages/desktop/src/main/index.ts` |
| `login.html` 入口 | `packages/desktop/` |
| `login.tsx` renderer | `packages/desktop/src/renderer/src/login.tsx` |
| vite 多入口中的 `login.html` | `packages/desktop/vite.config.ts` |
| `hasAuthToken()` 函数及启动分支 | `packages/desktop/src/main/index.ts` |
| 用户名密码表单 UI | `packages/ui/src/WelcomeScreen.tsx` |
| `MOCK_USER` 常量 | `packages/ui/src/Root.tsx`、`packages/ui/src/store/index.ts` |
| `admin/admin` mock 校验逻辑 | `packages/desktop/src/renderer/src/login.tsx`、`packages/ui/src/Root.tsx` |
| 相关 test ID（TID_USERNAME_INPUT 等） | `packages/shared/src/` |
| `loginSuccess()` 方法及 IPC 监听 | `packages/shared/src/platform.ts`、`packages/desktop/src/main/index.ts`、`packages/desktop/src/preload/index.ts` |
| `logout()` 平台方法及 IPC 监听 | `packages/shared/src/platform.ts`、`packages/desktop/src/main/index.ts`、`packages/desktop/src/preload/index.ts`（logout 业务逻辑移至 UI/Hook 层） |
| `PlatformChannels.LoginSuccess` | `packages/shared/src/channels.ts` |
| `PlatformChannels.Logout` | `packages/shared/src/channels.ts` |

### 不改动的部分

- `packages/services/src/credential/credentialService.ts` — 存储层不变
- `packages/web/` — 本次不处理
- `packages/rpc/` — 不涉及（使用现有 RPC 框架）
- `packages/server/` — 不涉及

## 边界情况

| 场景 | 处理 |
|---|---|
| 用户点击登录后关闭浏览器 | 5 分钟超时，OAuthService 清理 state，renderer 显示超时提示 |
| 用户多次点击登录按钮 | OAuthService 检查 pendingStates，已有则忽略（per-host-process，不影响其他窗口） |
| deep link 到达时应用已关闭（冷启动） | macOS: Electron 启动后触发 open-url；Windows/Linux: 从 process.argv 提取 URL。state 不匹配（内存态已丢失）→ 返回错误，用户重新登录 |
| deep link 到达时应用已运行 | macOS: open-url 直接触发；Windows/Linux: second-instance 事件。通过 state→windowId 映射路由到正确窗口 |
| deep link 早于 renderer ready（冷启动时序） | Main process 缓存 URL，等 RendererReady IPC 后再转发 |
| state 不匹配 | OAuthService 拒绝，返回错误，renderer 显示错误 |
| token exchange 网络失败 | OAuthService 返回错误，renderer 显示错误，可重试 |
| 存储的 token 过期（启动时） | 乐观加载，后续 API 401 时在 hook 层触发刷新或重新登录 |
| 多窗口同时登录 | 每个窗口有独立的 host process 和 OAuthService 实例，state→windowId 映射确保回调路由到正确窗口 |

## Review 修正记录

| # | 原问题 | 修正 |
|---|---|---|
| P0 | OAuth 业务逻辑放在 main process，违反"main 只做调度" | 新建 IOAuthService 放在 host process，main 只做 deep link 捕获和转发 |
| P0 | 假设存在 requestSingleInstanceLock 等基础设施 | 明确标注从零搭建，补充冷启动处理（process.argv） |
| P0 | 整体流程图和 IPC 章节存在两套回调路径（OAuthSuccess vs OAuthCallback） | 统一为 OAuthCallback 方案：main 只转发 URL，renderer 通过 RPC 处理，删除 OAuthSuccess/OAuthError channel |
| P1 | 回调写死发给 mainWindow，多窗口下发错 | 改为 state→windowId 映射，从 URL 解析 state 路由到正确窗口 |
| P1 | 依赖 clientSecret，不做 PKCE | 必须实现 PKCE，移除 clientSecret 依赖 |
| P1 | macOS 打包后缺少 plist 协议声明 | 在 electron-builder.config.js 中添加 protocols 配置 |
| P1 | 冷启动时 deep link 可能早于 renderer ready | Main process 缓存 deep link URL，等 RendererReady IPC 后转发 |
| P1 | notifyRendererReady 定义了但没有调用点 | 在 Root/App 常驻层的 useEffect 中调用 platform.notifyRendererReady() |
| P2 | removeAllListeners 清空整频道 | 改为 disposer 模式，onOAuthCallback 返回清理函数 |
| P2 | state→windowId 映射缺少生命周期清理 | 5 分钟超时自动清理 + 窗口关闭时清理该窗口的映射 |
| P3 | macOS open-url 注册时机未明确 | 明确标注必须在 app.whenReady() 之前注册 |
| P1 | Token 刷新放在 useOAuth hook（LoginDialog 生命周期），未挂载时 401 刷新断裂 | 刷新逻辑移到常驻层 useTokenRefresh hook，useOAuth 只负责登录流程 |
| P2 | Auth 状态 useState 和 Zustand 不一致 | 统一为 Zustand store 唯一数据源 |
| P2 | IOAuthService 接口缺少 refreshToken 方法 | 补充 refreshToken(token: string): Promise<void> |
| P3 | 路径不一致，缺少 globals.d.ts | 统一 packages/ 前缀，补充 globals.d.ts |
| P1 | loginSuccess/logout 方法语义失效未处理 | loginSuccess 删除，logout 从 IPlatformService 删除，业务逻辑移至 UI/Hook 层 |
| P1 | onOAuthCallback 和 notifyRendererReady 放在 useOAuth（LoginDialog 生命周期），dialog 未挂载时回调丢失 | 回调监听和 notifyRendererReady 提升到 Root/App 常驻层，useOAuth 只保留 startLogin |
| P2 | logout 设计不一致（platform 层混入业务逻辑） | IPlatformService.logout() 删除，logout 完全在 UI/Hook 层通过 credentialService + Zustand 处理 |
| P2 | 流程图写 useOAuth 监听回调，与正文 Root/App 常驻监听不一致 | 更新流程图为 Root/App 常驻监听 |
| P2 | loginSuccess/logout 方法迁移章节残留旧措辞（修改/评估/简化） | 统一为"删除"口径 |

## AGENTS.md 约束合规性

| 约束 | 合规情况 |
|---|---|
| Auth 仅通过 Providers | ✅ UI 通过 IPlatformService + usePlatform() hook + useOAuth() hook |
| Main 进程只做调度 | ✅ OAuth 业务在 host process 的 OAuthService，main 只做 deep link 捕获、state→window 路由、冷启动缓存 |
| 业务服务在 host process | ✅ IOAuthService 按新增服务 Checklist 注册 |
| window.zcode 允许列表 | ✅ 新增方法并同步更新 AGENTS.md |
| 频道名集中 channels.ts | ✅ ServiceChannels + PlatformChannels |
| 依赖注入解决兼容 | ✅ IPlatformService + IServiceAccessor 模式 |
| 多 OS 兼容 | ✅ macOS open-url / Windows+Linux second-instance + process.argv |
| 注释中文 | ✅ |
| 日志用 logger.ts | ✅ |
| 国际化 | ✅ |
| import 绝对路径 | ✅ |
| 含 JSX 文件用 .tsx | ✅ |
