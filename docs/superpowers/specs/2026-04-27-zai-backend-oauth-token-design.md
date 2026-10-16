# ZAI 后端 OAuth Token 改造设计

## 背景

当前桌面端已经有多 provider OAuth 架构，ZAI 登录通过 `ZaiProviderAdapter` 直接向三方 ZAI token 与 userinfo 接口换取 access token。新需求要求桌面端只负责打开 ZAI 授权页并接收 deep link 回调；拿到 `code` 和 `state` 后调用自有后端 `https://zcode.z.ai/api/v1/oauth/token`，由后端完成向 z.ai 换 token、拉取 userinfo、创建用户并签发 JWT。

本次改造目标是最终把后端返回的 JWT 保存为 ZAI 登录 token，同时保留现有 UI、deep link、凭据仓储和多 provider service 架构。

## 范围

- 只改 ZAI OAuth provider 协议契约。
- 不改 BigModel 登录行为。
- 不新增 UI 入口，不调整登录弹窗视觉。
- 不新增独立登录 service，继续复用 `OAuthService` 与 provider adapter 机制。

## 数据流

1. UI 调用 `oauthService.startOAuth("zai")`。
2. `ZaiProviderAdapter.buildAuthorizeUrl` 生成授权 URL：
   - `https://chat.z.ai/api/oauth/authorize`
   - `client_id=client_P8X5CMWmlaRO9gyO-KSqtg`
   - `redirect_uri=zcode://zai-auth/callback`
   - `state=<random-state>`
3. 桌面端通过平台层打开浏览器。
4. 用户授权后，系统 deep link 回到：
   - `zcode://zai-auth/callback?code=<code>&state=<state>`
5. `OAuthService.handleCallback` 校验 pending state 后调用 ZAI adapter。
6. ZAI adapter 调用后端：

```http
POST https://zcode.z.ai/api/v1/oauth/token
Content-Type: application/json

{
  "code": "<code>",
  "redirect_uri": "zcode://zai-auth/callback",
  "state": "<state>"
}
```

7. 后端返回：

```json
{
  "code": 0,
  "msg": "",
  "data": {
    "token": "eyJ...",
    "expires_in": 86400,
    "user": {
      "user_id": "u_xxxxx",
      "email": "user@example.com",
      "avatar": "https://...",
      "created_at": "2026-04-27T10:00:00Z"
    }
  }
}
```

8. 客户端保存：
   - `oauth:zai:access_token` = `data.token`
   - `oauth:zai:user_info` = 映射后的用户信息
   - `oauth:active_provider` = `zai`

## 协议映射

ZAI provider 配置：

- `authorizeUrl`: `https://chat.z.ai/api/oauth/authorize`
- `tokenUrl`: `https://zcode.z.ai/api/v1/oauth/token`
- `userinfoUrl`: 保留配置字段但本次登录成功路径不再调用
- `appId`: 使用 `client_P8X5CMWmlaRO9gyO-KSqtg`
- `redirectUri`: `zcode://zai-auth/callback`
- `legacyRedirectUri`: 继续保留 `zcode://oauth/callback` 兼容旧 deep link 解析能力

Token 映射：

- `OAuthTokenSet.accessToken` 使用 `data.token`
- `OAuthTokenSet.expiresAt` 使用 `now() + data.expires_in * 1000`
- 后端当前未提供 refresh token，本次不写 `refreshToken`

User 映射：

- `OAuthUserProfile.id` 使用 `data.user.user_id`
- `OAuthUserProfile.username` 优先使用 `data.user.email`，缺失时回落为 user id
- `OAuthUserProfile.displayName` 同 username
- `OAuthUserProfile.avatarUrl` 使用 `data.user.avatar`

## 错误处理

- HTTP 非 2xx 继续由 `readApiJson` 抛出 `ApiError`。
- 业务响应 `code !== 0` 视为 token 交换失败，错误消息优先使用 `msg`。
- 响应缺少 `data.token` 时抛出明确错误，避免保存空登录态。
- 响应缺少 `data.user` 不阻断登录，沿用现有 fallback profile；原因是本次核心目标是拿到后端 JWT，用户展示信息可后续补齐。

## 测试

更新 `packages/services/test/oauthService.test.ts`：

- ZAI 授权 URL 使用新授权地址和不变 client id。
- ZAI token 请求使用 JSON body：`code`、`redirect_uri`、`state`。
- ZAI 登录成功后保存 `data.token` 到 `oauth:zai:access_token`。
- `expires_in` 被换算为 `expiresAt`，后续可用于过期判断扩展。
- `code !== 0` 和缺少 `data.token` 会失败。

最终验证必须执行：

- `pnpm typecheck`
- `pnpm lint`

## 文档

功能完成后更新 `docs/oauth/oauth-multi-provider-implementation.md`，记录 ZAI 登录已经改为后端 JWT token 交换链路。
