# ZAI OAuth Environment Origin

## 背景

ZAI OAuth 登录入口当前使用 `/api/oauth` 前缀，生产默认入口为 `https://chat.z.ai/api/oauth/authorize`。为了支持测试环境登录入口，需要避免在多端代码里散落完整授权 URL。

## 方案

- Host/service 与 Web/Vite 都只读取按 `ZCODE_ENV=test|production` 分组的链接常量。
- `ZAI_<ENV>_OAUTH_ORIGIN` 用于派生 ZAI OAuth `authorizeUrl` 和 `userinfoUrl`。
- `ZAI_<ENV>_BUSINESS_BASE_URL` 用于派生 ZAI 业务 token 交换接口 `/api/auth/z/login`。
- 继续保留已有完整 URL override：`ZAI_OAUTH_AUTHORIZE_URL`、`ZAI_OAUTH_USERINFO_URL` 优先级高于 origin 派生值，兼容旧配置。
- 继续保留业务 token 完整 URL override：`ZAI_BUSINESS_LOGIN_URL` 优先级高于 `ZAI_BUSINESS_BASE_URL`，仅用于测试或接口路径迁移。
- token exchange 走 `ZCODE_<ENV>_BASE_URL` 派生出的 ZCode API：桌面/host 为 `${baseUrl}/api/v1/oauth/token`，Web 默认请求 `/api/v1/oauth/token` 并由 Vite proxy 按 `ZCODE_ENV` 选择的 base url 转发。

## 测试环境配置

```env
ZCODE_TEST_BASE_URL=https://zcode.z.ai
ZAI_TEST_OAUTH_CLIENT_ID=client_P8X5CMWmlaRO9gyO-KSqtg
ZAI_TEST_OAUTH_ORIGIN=https://chat.z.ai
ZAI_TEST_BUSINESS_BASE_URL=https://api.z.ai
```

本地开发默认 `ZCODE_ENV=test`，让 `pnpm dev:web`、`pnpm dev:desktop:test` 都走测试环境登录入口。不要在 `.env*` 里写 `ZCODE_ENV`，当前环境由启动脚本或 CI 注入。

正式环境在 `.env.production` 显式配置生产 client id：

```env
ZCODE_PRODUCTION_BASE_URL=https://zcode.z.ai
ZAI_PRODUCTION_OAUTH_ORIGIN=https://chat.z.ai
ZAI_PRODUCTION_BUSINESS_BASE_URL=https://api.z.ai
ZAI_PRODUCTION_OAUTH_CLIENT_ID=client_P8X5CMWmlaRO9gyO-KSqtg
```
