# OAuth 多提供方改造实施说明（Desktop）

更新时间：2026-04-03

## 1. 本次落地范围

本次在 Desktop OAuth 多提供方实现上做结构重排，目标是让 provider 同级扩展、按 provider 内聚配置，不再在公共入口里写某个 provider 的特例逻辑。

## 2. 核心改动

### 2.1 Shared 只保留领域类型

`packages/shared/src/oauth.ts` 现在只保留 OAuth 领域类型与 provider id（`bigmodel`、`zai`），不再放 provider 默认端点配置。

### 2.2 Provider 配置下沉

在 `packages/services/src/oauth/providers/` 新增 provider 配置模块：

- `bigmodelProviderConfig.ts`
- `zaiProviderConfig.ts`
- `configUtils.ts`

每个 provider 自己维护默认配置和环境变量映射；`runtimeConfig.ts` 只做聚合。

### 2.3 Runtime 配置职责收敛

`packages/services/src/oauth/runtimeConfig.ts` 现在只负责：

1. 定义 `OAuthProviderRuntimeConfig` / `OAuthRuntimeConfig`
2. 聚合各 provider 的 runtime config

不再承载 BigModel/ZAI 的具体字段拼装细节。

### 2.4 凭据仓储去除全局 legacy provider 语义

`packages/services/src/oauth/repo/oauthCredentialRepo.ts` 仅处理 namespaced key：

- `oauth:<provider>:access_token`
- `oauth:<provider>:refresh_token`
- `oauth:<provider>:user_info`
- `oauth:active_provider`

不再通过全局 `LEGACY_PROVIDER_ID` 推断或迁移某个 provider。

BigModel `oauth:bigmodel:user_info` 当前保存归一化 profile，并通过
`rawProfile.zcodeProfileSchemaVersion = 2` 标记已按 `customerName -> nickName -> "user"`
展示名优先级生成。启动 `restoreCachedSession()` 时，如果检测到 BigModel 旧缓存缺少
该版本标记或版本低于 2，会先立即返回本地缓存展示态，再在后台尝试用 BigModel
provider 命名空间下的 access token 做一次 best-effort userinfo 刷新；已高于 2 的缓存
视为未来版本数据，不请求、不改写、不降级。成功后写回 schema version 2 与新展示名。
401/403、缺少 token，或命中 `unknown/User` 哨兵 profile 时，继续保留旧缓存展示字段并
写入 schema version 2，避免之后每次启动重复触发确定失败的迁移。超时、离线或 5xx
这类暂时性失败只写入 `rawProfile.zcodeProfileMigrationRetryAfter` 退避时间，不写
schema version 2；退避窗口过后仍可再次尝试迁移。后台迁移写入必须固定到
`oauth:bigmodel:user_info`，且保存前确认当前 active provider 与 BigModel 缓存仍是启动时
捕获的旧状态；用户已 logout、切到 ZAI 或重新登录 BigModel 时，旧迁移结果必须失效。

### 2.5 BigModel fallback secret 移除

BigModel 不再内置历史 fallback secret；未显式配置 `BIGMODEL_OAUTH_APP_SECRET` 时运行时配置保持 `undefined`。当前 BigModel callback 只通过 zcode OAuth token 路由消费一次性 code。

### 2.6 OAuth callback 收敛

Desktop OAuth 统一使用 `zcode://oauth/callback`：

- ZAI 默认 `redirectUri` 从 `zcode://zai-auth/callback` 收敛为 `zcode://oauth/callback`
- BigModel 保持 `zcode://oauth/callback`
- Desktop main 进程不再识别 `zcode://zai-auth/callback` / `zcode://bigmodel-auth/callback`
- `ZAI_OAUTH_REDIRECT_URI` / `BIGMODEL_OAUTH_REDIRECT_URI` 及 legacy redirect URI override 已移除

Provider 归属不依赖 callback host，而是由发起登录时注册的 `state` 绑定关系决定。

## 3. 运行时配置说明（Host Process）

BigModel 环境变量：

- `BIGMODEL_OAUTH_ENABLED`
- `BIGMODEL_OAUTH_AUTHORIZE_URL`
- `BIGMODEL_OAUTH_TOKEN_URL`
- `BIGMODEL_OAUTH_USERINFO_URL`
- `BIGMODEL_OAUTH_APP_ID`
- `BIGMODEL_OAUTH_APP_SECRET`

ZAI 环境变量：

- `ZAI_OAUTH_ENABLED`
- `ZAI_OAUTH_AUTHORIZE_URL`
- `ZAI_OAUTH_TOKEN_URL`
- `ZAI_OAUTH_USERINFO_URL`
- `ZAI_OAUTH_CLIENT_ID`（兼容 `ZAI_OAUTH_APP_ID`）
- `ZAI_BUSINESS_BASE_URL`：派生 `POST /api/auth/z/login`，用于把 ZAI OAuth access token 换成业务 token；测试环境为 `https://api.z.ai`
- `ZAI_BUSINESS_LOGIN_URL`：完整业务 token 交换 URL override，优先级高于 `ZAI_BUSINESS_BASE_URL`

ZAI 默认登录链路已切换为后端 JWT token 交换，授权入口和业务 token 交换入口按 `ZCODE_ENV=test|production` 选择：

- 授权页：由 `ZAI_<ENV>_OAUTH_ORIGIN` 派生 `/api/oauth/authorize`，生产默认为 `https://chat.z.ai/api/oauth/authorize`
- token 交换：由 `ZCODE_<ENV>_BASE_URL` 派生 `/api/v1/oauth/token`
- 桌面端请求体：`{ code, redirect_uri, state }`
- 本地保存的 `oauth:zai:access_token` 是后端返回的 `data.token`

## 4. ZAI 后端 JWT 登录链路（增量）

ZAI OAuth 登录不再由桌面端直接请求三方 ZAI token 接口。桌面端只负责打开授权页、接收 `zcode://oauth/callback` deep link，并把 `code`、`redirect_uri`、`state` 传给后端 `https://zcode.z.ai/api/v1/oauth/token`。

后端完成 z.ai token 交换、userinfo 拉取、用户创建与 JWT 签发。客户端把响应中的 `data.token` 保存为 `oauth:zai:access_token`，把 `data.user` 映射为 `oauth:zai:user_info`，并把 `oauth:active_provider` 设置为 `zai`。

## 5. 验证结果

已执行：

- `pnpm vitest run packages/services/test/oauthService.test.ts`
- `pnpm typecheck`
- `pnpm lint`

结果：通过。

## 6. OAuth 凭据自动加解密（增量）

为避免 OAuth token / user_info 以明文落盘，本次在凭据服务层增加透明加解密：

- 入口：`packages/services/src/credential/credentialService.ts`
- 加解密实现：`packages/services/src/credential/providers/credentialCipherProvider.ts`
- 密文格式：`enc:v1:<iv>.<authTag>.<cipherText>`（AES-256-GCM）

行为说明：

1. `credentialService.save` 自动加密后写入 `~/.zcode/v2/credentials.json`
2. `credentialService.load` 自动解密并返回明文给上层业务
3. 历史明文值（无 `enc:v1:` 前缀）保持兼容读取，避免升级后登录态失效

密钥说明：

- 优先使用环境变量 `ZCODE_CREDENTIAL_SECRET`
- 未配置时使用本机上下文生成 fallback key（用于本地/远程模式下的最小可用加密）

测试：

- `packages/services/test/credentialService.test.ts`
  - 验证写盘非明文
  - 验证读取自动解密
  - 验证历史明文兼容

## 7. 启动登录态恢复改造（增量）

为避免启动时仅凭本地文件值判断“已登录”，本次把登录态恢复收敛到 `oauthService.restoreSession()`：

- 接口：`packages/services/src/oauth/oauth.ts`
- 实现：`packages/services/src/oauth/oauthService.ts`
- UI 调用入口：`packages/ui/src/Root.tsx`

行为变化：

1. 启动恢复不再直接在 UI 读取 token/user_info
2. `restoreSession` 会用 active provider 的 access token 调用 provider `fetchUserInfo` 做真实有效性校验
3. 若返回未授权（401/403），立即执行 logout 流程并清理本地登录态

BigModel 兼容迁移：

- legacy `auth_token` / `refresh_token` 读取逻辑下沉到 provider 目录（`bigmodelProviderAdapter.ts`）
- 兼容命中后自动回填命名空间 key：`oauth:bigmodel:access_token` / `oauth:bigmodel:refresh_token`

测试：

- `packages/services/test/oauthService.test.ts`
  - 启动校验成功可恢复会话
  - BigModel legacy token 可恢复并迁移
  - 启动校验 401 会触发退出并清理凭据

## 8. OAuth 后预置模型供应商补齐（ZAI）

本次补齐了 ZAI 在 OAuth 成功后的预置模型供应商同步链路，行为对齐 `z-work` 中 `getZaiApiKey` 的取 key 逻辑：

1. 使用 `oauth:zai:access_token` 调 `POST https://api.z.ai/api/auth/z/login` 交换 ZAI 业务 token
2. 使用业务 token 调 `GET /api/biz/customer/getCustomerInfo` 选择默认机构/项目
3. 调 `GET /api_keys` 查找 `zcode-api-key`，不存在则 `POST /api_keys` 创建
4. 调 `GET /api_keys/copy/{apiKey}` 获取 `secretKey`
5. 写入预置 provider 的 `apiKey` 为 `apiKey.secretKey`

实现与测试：

- 实现：`packages/services/src/model-provider/repo/oauthPresetProviderRepo.ts`
- 测试：`packages/services/test/modelProviderService.test.ts`
  - `会把 OAuth 的 ZAI 供应商配置同步成预置模型供应商`
  - `ZAI 交换业务 token 失败时不会写入预置模型供应商`
  - `ZAI 拉取明文 key 失败时不会写入预置模型供应商`

兼容策略：

- BigModel 保持原有 fallback 行为（`copy` 缺失 `secretKey` 时可回退裸 key）
- ZAI 严格要求 `secretKey`，避免落盘不可用的裸 API key
