# Web 远控页面登录校验设计

> 本文只适用于 OAuth-gated `/web-remote` 登录流程。`remoteControlToken` / `relayOrigin` 是旧 `/web-remote` 行为说明，不适用于新的 `/remote` QR route；新 route 使用外部 relay `sid/hash/t/mid/name/app_version`，且不得把 `sid` 或 `hash` 写入 OAuth state。

## 背景

当前 Web 远控页面（`packages/web`）打开后无需任何身份校验即可直接访问任务和聊天窗口。手机端访问远控页面时，需要与桌面端共享同一用户身份才能正常使用产品功能。

本次改动目标：在 Web 远控页面引入与桌面端一致的 ZAI OAuth 登录流程，仅 ZAI provider，不涉及其他登录方式。

## 关键约束

| 约束项 | 说明 |
|--------|------|
| 部署域名 | `https://zcode.z.ai`（已在 ZAI OAuth 白名单内） |
| OAuth 提供方 | ZAI（`chat.z.ai/auth`），**不走桌面端 deep-link `zcode://`** |
| Token 存储 | Web 的 `localStorage`，核心 key 与桌面端保持一致：`zcodejwttoken`、`oauth:zai:access_token`、`oauth:zai:user_info`、`oauth:active_provider` |
| 生产态同域 | 远控页面部署在 `zcode.z.ai` 下，调用 `zcode.z.ai/api/v1/oauth/token` 同源，无 CORS 问题 |
| 开发态 | 通过环境变量注入本地 origin，ZAI 回调先回到生产域名再转发回局域网 IP；本地 token 交换必须走 Vite proxy 或后端 CORS 白名单，不能假设本地 Vite origin 天然拥有 `/api/v1/oauth/token` |

## 本期范围与联调边界

本期前端只完成以下能力：

1. Web 远控页面未登录时展示登录页。
2. 发起 ZAI OAuth 登录。
3. 处理 ZAI OAuth callback。
4. 将后端返回的 `zcodejwttoken` 与 ZAI OAuth 相关存储写入 `localStorage`。

后端同事会补齐以下能力，本设计只预留联调边界，不在本期实现：

1. 凭 `zcodejwttoken` 获取当前账号可连接的设备/远控入口列表。
2. 设备选择后的真实远控连接建立。
3. relay / server 侧对 `zcodejwttoken` 的鉴权与 session 绑定。

因此，本期前端的 `localStorage` 登录门禁只负责 UI 入口收敛，不等价于完整服务端鉴权。登录成功后的落点按 URL 分流：

1. 当前 URL 带 `remoteControlToken`：保留旧远控链接能力，登录成功后回到原 URL，继续用 `remoteControlToken` / `relayOrigin` 走现有 relay bootstrap。
2. 当前 URL 不带 `remoteControlToken`：本期不直接连接 `/ws`，先渲染已登录占位页；后端设备列表接口完成后，改为“调用设备列表接口 → 用户选择设备 → 建立远控连接”。

### 现有 `remoteControlToken` / `relayOrigin` 说明

当前代码里已经存在一条“桌面端生成远控链接 → 手机打开链接直连该次远控 session”的链路：

- `remoteControlToken`：relay 为一次 Web 远控会话生成的一次性 session token。Web 端会用它请求 `/api/remote-control/bootstrap/:token`，拿到 `wsUrl`、workspace 信息、初始 task 信息，然后连接 `/ws/remote-control/:token`。
- `relayOrigin`：relay 服务的 origin。Web 页面可能部署在 `zcode.z.ai`，但 relay 可以是另一台服务；因此 Web 端需要用 `relayOrigin` 拼出 bootstrap、workspace list、workspace switch、platform proxy 等 relay API 地址。未传时默认使用 `window.location.origin`。

这两个参数是当前直连远控 session 的入口参数，不是 ZAI 登录 JWT，也不代表用户身份。加登录功能后它们仍然需要保留：如果用户打开的是带 `remoteControlToken` 的旧远控链接，OAuth 跳转回来后必须还能拿到原始 `remoteControlToken` / `relayOrigin`，否则旧链接会丢失要连接的 relay session。

后续后端设备列表接口完成后，新的“登录后选设备”流程可以不依赖 URL 上预置 `remoteControlToken`，而是由后端按 `zcodejwttoken` 返回可连接设备。但这不影响本期对旧链接参数的兼容。

## 数据流

### 生产态（标准路径）

```
用户访问 https://zcode.z.ai/web-remote?remoteControlToken=xxx&relayOrigin=https%3A%2F%2Frelay.example
   ↓ 检测缓存会话不完整
全屏登录页
   ↓ 点击"用 ZAI 登录"
跳转 https://chat.z.ai/api/oauth/authorize
  ?redirect_uri=https%3A%2F%2Fzcode.z.ai%2Fweb-remote%2Fcallback
  &response_type=code
  &client_id=xxx
  &state=<base64url({nonce, app_return_to: "https://zcode.z.ai/web-remote?remoteControlToken=xxx&relayOrigin=..."})>
   ↓ 用户在 ZAI 授权页同意
回到 https://zcode.z.ai/web-remote/callback?code=xxx&state=yyy
   ↓ 检测 return_to 不存在或等于 self.origin，直接换 token
POST https://zcode.z.ai/api/v1/oauth/token
  {code, redirect_uri, state}
   ↓
返回 {code: 0, data: {token: "eyJ...", zai: {access_token: "zai_..."}, user: {...}}}
   ↓ 存入 localStorage['zcodejwttoken'] = "eyJ..."
   ↓ 存入 localStorage['oauth:zai:access_token'] = "zai_..."
   ↓ 存入 localStorage['oauth:zai:user_info'] = data.user 原始结构，并在恢复展示态时映射为 UserInfo
   ↓ 存入 localStorage['oauth:active_provider'] = "zai"
   ↓ replace 到 app_return_to，保留 remoteControlToken / relayOrigin
全屏登录页 → 继续现有 remoteControlToken relay bootstrap
```

### 开发态（`return_to` 转发路径）

```
开发者电脑本地启动: VITE_DEV_ORIGIN=http://192.168.x.x:5173 pnpm dev
手机浏览器访问: http://192.168.x.x:5173/web-remote?remoteControlToken=xxx&relayOrigin=...
   ↓ 检测缓存会话不完整
全屏登录页
   ↓ 点击"用 ZAI 登录"
跳转 https://chat.z.ai/api/oauth/authorize
  ?redirect_uri=https%3A%2F%2Fzcode.z.ai%2Fweb-remote%2Fcallback
  &state=<base64url({
    nonce,
    return_to: "http://192.168.x.x:5173/web-remote/callback",
    app_return_to: "http://192.168.x.x:5173/web-remote?remoteControlToken=xxx&relayOrigin=..."
  })>
   ↓ 用户在 ZAI 授权页同意
回到 https://zcode.z.ai/web-remote/callback?code=xxx&state=yyy
   ↓ 解 state，检测 return_to 存在且 ≠ self.origin
   ↓ 生产中转页不校验本地 nonce、不换 token，只负责白名单校验和转发
302 Location: http://192.168.x.x:5173/web-remote/callback?code=xxx&state=yyy
   ↓ 手机浏览器访问局域网 IP
http://192.168.x.x:5173/web-remote/callback?code=xxx&state=yyy
   ↓ 最终本地页验证 nonce
   ↓ 通过 Vite proxy 或后端 CORS 白名单 POST https://zcode.z.ai/api/v1/oauth/token 换 token
存入 localStorage → replace 到 app_return_to，保留 remoteControlToken / relayOrigin
```

## `state` 结构设计

### 编码格式

`state = base64url(JSON.stringify(payload))`

`base64url` 必须使用统一 codec，不允许直接 `atob(state)`。原因是 OAuth state 会出现在 URL query 中，编码需要把 `+`、`/`、`=` 转成 URL 安全形式；回调解析时也必须补回 padding。

### payload 结构

```typescript
interface OAuthStatePayload {
  /** 防 CSRF 随机数，与 sessionStorage['oauth_pending_nonce'] 比对 */
  nonce: string;
  /**
   * 可选。登录成功后回到的业务页面完整 URL。
   * 用于保留旧远控链接上的 remoteControlToken / relayOrigin 等 query 参数。
   */
  app_return_to?: string;
  /**
   * 可选。仅开发态注入本地 callback URL。
   * 生产态不注入；生产 callback 页直接换 token。
   */
  return_to?: string;
}
```

### `app_return_to` 校验

`app_return_to` 用于登录完成后恢复原业务页面，必须用 URL API 校验，不能直接拼接跳转：

1. 生产态：`app_return_to.origin === "https://zcode.z.ai"`，且 pathname 只能是 `/web-remote` 或 `/web-remote/`
2. 开发态：`app_return_to.origin` 必须等于发起登录的本地 origin；如果同时存在 `return_to`，则必须与 `return_to` 同 origin
3. 只允许保留业务需要的 query 参数，当前至少包括 `remoteControlToken`、`relayOrigin`；其它参数如果后续需要，必须显式列入允许列表
4. 校验失败时回退到 `/web-remote`，不得跳转到任意外部 URL

> `remoteControlToken` / `relayOrigin` 的保留依赖 `app_return_to`。如果 OAuth 发起时没有把当前完整 URL 写入 state，登录回来后旧远控链接会丢失要连接的 relay session。

### `return_to` 白名单校验

生产中转页解出 `return_to` 后，仅在以下条件全部满足时执行转发：

1. `return_to` 存在
2. `return_to` 必须先通过 `new URL(return_to)` 解析成 URL 对象
3. `returnToUrl.origin !== window.location.origin`（目标 origin 不是当前 callback 页 origin）
4. `return_to` 匹配私网段正则：`/^https?:\/\/(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+)(:\d+)?(\/|$)/`
5. `return_to` pathname 必须是 `/web-remote/callback`
6. 当前构建或部署环境显式允许开发态中转。线上正式生产构建默认关闭；如果必须让 `https://zcode.z.ai` 承担本地开发中转，需要增加后端签名或专用测试部署，不能在公开生产环境接受任意未签名的私网 `return_to`

不满足则不执行跨 origin 转发，继续按当前 callback 页处理：如果当前页就是本地开发 callback，因为 `returnToUrl.origin === window.location.origin`，必须进入 nonce 校验和 token 交换分支，不能再 replace 回自己；如果当前页是生产 callback 且没有有效 dev `return_to`，则按生产态正常回调直接走 token 交换流程。

生产中转页只负责 `return_to` 白名单校验和 302 转发，不读取本地 `sessionStorage`，也不执行 token 交换。最终回到本地开发页后，再由本地页读取自己 origin 下的 `sessionStorage['oauth_pending_nonce']` 做 nonce 校验。

### CSRF 防护

发起登录前：
```js
const nonce = crypto.randomUUID();
sessionStorage.setItem("oauth_pending_nonce", nonce);
```

回调页解出 `state` 后：
```js
function decodeBase64Url(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return atob(padded);
}

const payload = JSON.parse(decodeBase64Url(state));
const returnToUrl = parseOptionalUrl(payload.return_to);
if (
  returnToUrl &&
  returnToUrl.origin !== window.location.origin &&
  isTrustedDevReturnTo(returnToUrl)
) {
  // 开发态生产中转页：只做白名单校验和转发，不校验本地 nonce。
  // buildReturnToCallbackUrl 只能转发到通过白名单的 /web-remote/callback，并保留 code/error/state。
  location.replace(buildReturnToCallbackUrl(returnToUrl.toString(), { code, error, state }));
  return;
}

// 如果 return_to 和当前页同 origin，说明已经回到最终本地 callback；
// 继续执行 nonce 校验和 token 交换，避免本地 callback replace 回自己。
if (payload.nonce !== sessionStorage.getItem("oauth_pending_nonce")) {
  throw new Error("OAuth CSRF 检测失败");
}
sessionStorage.removeItem("oauth_pending_nonce");

// token 交换与持久化成功后，跳回受限的业务 URL。
location.replace(resolveSafeAppReturnTo(payload.app_return_to) ?? "/web-remote");
```

> 注意：`sessionStorage` 不跨 origin 共享。开发态发起页是 `http://192.168.x.x:5173`，生产中转页是 `https://zcode.z.ai`，两者不能共享 `sessionStorage`；因此 nonce 校验只能发生在最终回到本地 origin 之后。

## 新增文件

新增 auth 代码按 `Providers → Repo → Service → Runtime/App Wiring` 拆分，避免把认证横切关注点直接写进 `main.tsx`。`packages/web` 是 Web 运行时入口，允许放浏览器 runtime/repo 适配；ZAI 协议细节仍放在 provider 模块中，业务编排由 service 暴露。

### `packages/web/src/auth/oauthStateCodec.ts`

纯函数模块，负责 `state` 的编解码和校验：

- `buildOAuthState(payload: OAuthStatePayload): string`
- `parseOAuthState(state: string): OAuthStatePayload | null`
- `decodeBase64Url(value: string): string`
- `encodeBase64Url(value: string): string`
- `parseOptionalUrl(value?: string): URL | null`
- `isTrustedDevReturnTo(url: URL): boolean`
- `resolveSafeAppReturnTo(value?: string): string | null`
- `buildReturnToCallbackUrl(returnTo: string, params: { code?: string; error?: string; state: string }): string | null`

### `packages/web/src/auth/webZaiOAuthConfig.ts`

Web ZAI OAuth 配置：

- authorize URL：`https://chat.z.ai/api/oauth/authorize`
- token URL：生产态为 `/api/v1/oauth/token`；开发态可通过 Vite proxy 指到 `https://zcode.z.ai/api/v1/oauth/token`
- client id：复用 ZAI OAuth client id
- redirect URI：始终使用 `https://zcode.z.ai/web-remote/callback`
- dev return 中转开关：默认关闭；仅开发/测试部署或带后端签名的生产中转允许打开

### `packages/web/src/auth/zaiWebOAuthProvider.ts`

Provider 模块，负责 ZAI 协议细节：

- `buildAuthorizeUrl(params)` — 构造 ZAI authorize URL
- `parseCallbackParams(url)` — 解析 `code` / `state` / `error`
- `exchangeToken(params)` — POST token 接口并校验响应结构
- `toUserInfo(user)` — 将后端 `data.user` 映射成前端展示态

### `packages/web/src/auth/browserOAuthCredentialRepo.ts`

Repo 模块，封装浏览器存储，不允许业务层散落读写 `localStorage` / `sessionStorage`：

- `saveTokenSet(tokenSet)` — 保存 `oauth:zai:access_token` 和 `zcodejwttoken`
- `saveUserInfo(user)` — 保存 `oauth:zai:user_info`
- `setActiveProvider("zai")`
- `loadCachedSession()`
- `clearAll()`

`loadCachedSession()` 成功条件必须同时满足：

1. `oauth:active_provider === "zai"`
2. `zcodejwttoken` 存在且 trim 后非空
3. `oauth:zai:access_token` 存在且 trim 后非空
4. `oauth:zai:user_info` 可解析，并能映射为 `UserInfo`

任一条件不满足时按未登录处理；如果检测到残缺登录态，应清理上述 ZAI 相关 key，避免后续误判成已登录。

### `packages/web/src/auth/webAuthService.ts`

Service 模块，对应桌面端 `OAuthService` 在 Web runtime 的等价物，只编排 provider 与 repo：

- `startLogin(options?: { devReturnTo?: string; appReturnTo?: string }): void` — 生成 nonce，交给 repo 存入 sessionStorage，调用 provider 构造 authorize URL，跳转；`appReturnTo` 默认取当前完整 URL，用于保留 `remoteControlToken` / `relayOrigin`
- `handleCallback(url: string): Promise<{ userInfo: UserInfo; appReturnTo: string | null } | null>` — 解 state，处理中转/nonce 校验，调用 provider 换 token，调用 repo 持久化
- `restoreCachedSession(): Promise<UserInfo | null>` — 通过 repo 读取 localStorage 恢复登录态；这里只做本地缓存恢复，不调用远端 userinfo
- `logout(): Promise<void>` — 通过 repo 清除 localStorage

### `packages/web/src/auth/WebLoginPage.tsx`

全屏登录 UI 组件，显示 ZCode logo 和“用 ZAI 登录”按钮。

UI 约束：

- 修改或新增 UI 前必须遵守根目录 `DESIGN.md`。
- 使用语义颜色 token（如 `bg-background`、`text-foreground`、`bg-card`、`border-border`），兼容由 Zai 接管的 Light Theme / Dark Theme。
- 文案必须兼容 `zh-CN` / `en-US`；因为登录页发生在完整 `ZCodeIntlProvider` 之前，需要提供轻量 locale resolver 或复用已有 i18n 字典。
- 按现有按钮体系实现主按钮，不写死临时颜色、圆角、字号。
- 布局需要适配手机竖屏、桌面宽屏和较长英文文案。

### `packages/web/src/auth/WebCallbackPage.tsx`

OAuth 回调处理组件。根据 `state.return_to` 和 URL 参数判断：

- **有 `error`**：显示登录失败，允许用户回到登录页重试
- **`state.return_to` 存在、可解析成 URL、目标 origin 不等于当前 origin，且指向受信任私网 origin**：生产 callback 作为开发中转页，执行 `location.replace(return_toCallbackUrl)`
- **无 `return_to`，或 `new URL(return_to).origin === window.location.origin`**：说明当前页就是最终 callback，校验 nonce → 换 token → 持久化 → 跳转 `app_return_to`，保留旧远控链接参数

> 中转分支不能按 `code` 有无判断；ZAI 回调到生产 callback 时会带 `code`。真正的分支条件是 `state.return_to` 是否存在、是否能解析为 URL，以及 `returnToUrl.origin` 是否与当前 callback 页 origin 不同。

Callback 处理只放在 `WebCallbackPage` 中，`main.tsx` 只负责根据 URL 渲染该组件，避免 `main.tsx` 和组件各自调用一遍 `handleCallback()`。

### `packages/web/src/auth/WebLoggedInWaitingPage.tsx`

已登录但 URL 不带 `remoteControlToken` 时展示的占位页。该组件是本期“后端设备列表接口未完成”的前端落点，避免在没有目标设备的情况下误连普通 `/ws`。

UI 约束：

- 与 `WebLoginPage.tsx` 使用同一套 pre-bootstrap 轻量 locale resolver 和主题 token。
- 文案必须兼容 `zh-CN` / `en-US`，说明“已登录，设备列表能力即将接入”或同义表达，不能写死中文。
- 组件只接收 `user: UserInfo` 与 `onLogout?: () => void` 这类展示/操作参数，不直接读写 `localStorage`，不直接调用 repo。
- 布局与登录页保持同级全屏页面，不嵌套卡片，不临时定义脱离 `DESIGN.md` 的颜色、圆角、字号。

### `packages/web/src/main.tsx` 改造

在 `bootstrapWebApp()` 的 WebSocket 连接之前，插入登录校验：

```typescript
async function bootstrapWebApp() {
  const params = new URLSearchParams(window.location.search);
  const isCallback =
    window.location.pathname === "/web-remote/callback" &&
    params.has("state") &&
    (params.has("code") || params.has("error"));

  if (isCallback) {
    renderCallbackPage({
      authService: webAuthService,
      onSuccess: ({ appReturnTo }) => {
        window.location.replace(appReturnTo ?? "/web-remote");
      },
      onRetry: () => {
        window.location.replace("/web-remote");
      },
    });
    return;
  }

  // 新增：登录校验。本地缓存恢复必须同时检查 active provider、JWT、ZAI access token 和 user_info。
  const auth = await webAuthService.restoreCachedSession();
  if (!auth) {
    renderLoginPage(() =>
      webAuthService.startLogin({
        devReturnTo: DEV_RETURN_TO
          ? `${DEV_RETURN_TO.replace(/\/$/, "")}/web-remote/callback`
          : undefined,
        appReturnTo: window.location.href,
      }),
    );
    return;
  }

  const hasRemoteControlToken = params.has("remoteControlToken");
  if (!hasRemoteControlToken) {
    // 本期后端设备列表接口尚未接入时，不直接回落到普通 /ws。
    // 避免“已登录但没有目标设备”的页面误连到错误的 Web + Server 入口。
    renderLoggedInWaitingPage(<WebLoggedInWaitingPage user={auth} />);
    return;
  }

  // 以下为原有 bootstrapWebSocket 逻辑...
}
```

## 路由设计

远控页面 SPA 内复用 URL 参数区分"主应用"和"回调页"：

| URL | 渲染内容 |
|-----|----------|
| `/web-remote?remoteControlToken=...&relayOrigin=...` | 旧远控链接入口；需已登录，登录后继续现有 relay bootstrap |
| `/web-remote` 或 `/web-remote/` | 无旧远控 token 的入口；需已登录，本期显示已登录占位页，后续接设备列表 |
| `/web-remote/callback` | 回调处理页，自动处理 token 交换或 return_to 转发 |

由于是 SPA，通过 `window.location.pathname` 判断，不需要额外路由库。

## 存储设计

| localStorage key | 值 | 用途 |
|-----------------|-----|------|
| `zcodejwttoken` | 后端 JWT 字符串，即 `data.token` | 业务 API 鉴权；后续设备列表接口也凭它识别当前用户 |
| `oauth:zai:access_token` | ZAI access token，即 `data.zai.access_token` | 与桌面端 ZAI OAuth token set 结构保持一致 |
| `oauth:zai:user_info` | JSON；优先保存后端 `data.user` 原始结构，恢复展示态时映射为 `UserInfo` | 显示用户名/头像，并兼容现有 `OAuthCredentialRepo` 的 ZAI user_info 恢复逻辑 |
| `oauth:active_provider` | `"zai"` | 标识当前登录方式 |
| `oauth:zai:expires_at` | timestamp | token 过期判断（可选，后续迭代） |

| sessionStorage key | 值 | 用途 |
|--------------------|-----|------|
| `oauth_pending_nonce` | UUID | CSRF 防护 |

> 存储 key 与 `OAuthCredentialRepo` 现有命名一致。前端展示使用 `@zcode/shared` 的 `UserInfo` 类型，不从 `@zcode/ui` 反向导入类型。

## Token 交换接口

### 请求

```http
POST https://zcode.z.ai/api/v1/oauth/token
Content-Type: application/json

{
  "code": "<ZAI auth code>",
  "redirect_uri": "https://zcode.z.ai/web-remote/callback",
  "state": "<state>"
}
```

### 响应（同现有桌面端行为）

```json
{
  "code": 0,
  "msg": "",
  "data": {
    "token": "eyJhbGciOiJIUzI1NiJ9...",
    "zai": {
      "access_token": "zai_access_token_xxx"
    },
    "expires_in": 86400,
    "user": {
      "user_id": "u_xxxxx",
      "name": "User Name",
      "email": "user@example.com",
      "avatar": "https://..."
    }
  }
}
```

### 错误处理

- HTTP 非 2xx：`WebRemoteControlFailureReason` 映射到错误页（如"unexpected-error"）
- 业务 `code !== 0`：显示"登录失败，请重试"，保留登录页
- 缺少 `data.token` 或 `data.zai.access_token`：同上，并禁止写入半登录态

## 环境变量

### 开发态注入

`.env.local` 或 Vite 启动参数：

```bash
# 你的电脑局域网 IP + 端口
VITE_DEV_ORIGIN=http://192.168.100.12:5173
```

开发态还需要配置 token 交换路径。推荐在 Vite dev server 配置 proxy。

当前 `packages/web/vite.config.ts` 已有 `/api` 通配代理到本地 `http://localhost:3030`，因此 `/api/v1/oauth/token` 专用代理必须放在 `/api` 之前；否则本地 token 交换可能被错误转发到本地 server，而不是 `https://zcode.z.ai`。

```typescript
// packages/web/vite.config.ts
server: {
  proxy: {
    "/api/v1/oauth/token": {
      target: "https://zcode.z.ai",
      changeOrigin: true,
      secure: true,
    },
    "/ws": { target: "ws://localhost:3030", ws: true },
    "/api": { target: "http://localhost:3030" },
  },
}
```

如果后续本地 `localhost:3030` server 自己实现了 `/api/v1/oauth/token` 转发，也可以不加专用 Vite proxy；但二者必须二选一写清楚，不能让浏览器直接从 Vite origin 调一个不存在的同源接口。

`main.tsx` 或 auth config 读取：

```typescript
const DEV_RETURN_TO = import.meta.env.VITE_DEV_ORIGIN;
```

`VITE_DEV_ORIGIN` 只负责让本地页面发起 OAuth 时把 `return_to` 写入 state。真正收到 ZAI callback 的是 `https://zcode.z.ai/web-remote/callback` 所在部署；该部署是否允许开发态 `return_to` 中转，不能由本地 `.env.local` 决定。若团队需要使用线上域名作为本地开发中转，必须在 callback 所在部署增加显式开关、专用测试部署或后端签名校验。

### 生产构建

`VITE_DEV_ORIGIN` 未定义，`startLogin` 不传 `return_to`，`state` 中无 `return_to` 字段。正式生产构建默认不接受未签名的开发态 `return_to` 中转。

生产态 token URL 使用同源 `/api/v1/oauth/token`；开发态也优先请求同一路径，由 Vite proxy 转发到 `https://zcode.z.ai`，避免浏览器 CORS 差异。

## 测试计划

### 单元测试

- `oauthStateCodec.ts`：正向编解码、非法 base64/JSON 兜底、`-` / `_` / 缺 padding 的 base64url 边界覆盖、`return_to` 私网白名单、`app_return_to` 同源/路径/query allowlist 覆盖
- `browserOAuthCredentialRepo.ts`：验证 `zcodejwttoken`、`oauth:zai:access_token`、`oauth:zai:user_info`、`oauth:active_provider` 写入/清理；缺任一关键 key 时 `loadCachedSession()` 返回 null 并清理残缺状态
- `webAuthService.ts`：mock `fetch` 响应，验证 token 交换成功/失败路径；缺少 `data.token` 或 `data.zai.access_token` 时不得写入半登录态；登录成功后返回安全的 `appReturnTo`
- `WebCallbackPage.tsx`：验证 `state.return_to` 中转分支不校验生产 origin 的 sessionStorage，最终本地 callback 才校验 nonce；验证同 origin `return_to` 不会 replace 回自己，而是继续 token 交换；验证 `?error=...&state=...` 能显示登录失败并允许重试

### E2E 测试（手动）

| 场景 | 步骤 | 预期 |
|------|------|------|
| 生产态首次登录 | 清空 localStorage，访问远控页，点击登录，完成授权 | 跳转回主应用，进入已登录后的前端流程 |
| 旧远控链接登录 | 清空 localStorage，访问带 `remoteControlToken` / `relayOrigin` 的远控链接，完成授权 | 登录后回到原 URL，query 中仍保留 `remoteControlToken` / `relayOrigin`，继续 relay bootstrap |
| 无远控 token 登录 | 清空 localStorage，访问 `/web-remote`，完成授权 | 登录后显示已登录占位页，不误连普通 `/ws` |
| 生产态回访 | 已有完整缓存登录态后刷新页面 | 不再展示登录页；带旧远控 token 时继续 relay bootstrap，无旧远控 token 时显示已登录占位页 |
| 生产态 token 过期 | mock 后端 401 | 显示错误页或跳转登录页 |
| 开发态登录 | 手机访问局域网 IP，点击登录 | 回调到生产页 → 转发回局域网 IP → 登录成功 |
| 取消授权 | 在 ZAI 页点拒绝 | 留在登录页，无异常 |

### 机械检查

- `pnpm typecheck`
- `pnpm lint`

## 后续迭代（非本次范围）

- JWT 过期主动刷新（后端未提供 refresh_token，暂时跳过）
- 登出功能（清除 localStorage，回到登录页）
- 其他 OAuth provider（如 BigModel）
- 登录状态与桌面端同步（同一浏览器跨端）
- 后端设备列表接口完成后，登录成功页接入“获取可连接设备 → 选择设备 → 建立远控连接”流程
- relay / server 侧完成 `zcodejwttoken` 鉴权后，前端把 token 或后端下发的短期连接票据接入 bootstrap / WebSocket 连接流程
