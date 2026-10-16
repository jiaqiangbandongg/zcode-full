# OAuth 多提供方最终改造方案（Final）

文档状态：已按 2026-07-16 OAuth callback 收敛决策更新。当前 Desktop OAuth 只支持统一回调 `zcode://oauth/callback`，不再支持 provider-specific callback host。

关联文档：

- `docs/superpowers/specs/2026-03-31-bigmodel-oauth-login-design.md`（当前已上线的 BigModel 单提供方方案）

## 0. 范围与边界

- 本方案本轮仅覆盖 **Desktop（Electron）**。
- Web OAuth 不在本轮实施范围内，相关设计与实现延后。

## 1. 背景

当前分支已经完成 BigModel OAuth 登录闭环，可用性上满足“单一提供方登录”。
但如果后续要接入更多 OAuth 提供方（例如 GitHub、Google、企业 SSO），现有实现在服务接口、deep link 路由、凭据存储命名空间、UI 模型上都仍偏向单提供方。

本文档给出最终目标结构与分阶段落地路径，目标是在不破坏现有 BigModel 登录体验的前提下，把 OAuth 能力升级为“可插拔、多提供方、可持续演进”的架构。

## 2. 现状问题（基于当前代码）

1. OAuth 配置与实现强绑定 BigModel 协议细节：`authCode` 参数、`tokenByAuthCode` 交换契约、特定用户信息字段。
2. 历史 BigModel 单提供方阶段曾使用 provider-specific deep link；当前已收敛为统一 `zcode://oauth/callback`。
3. `IOAuthService` 无 provider 维度，调用方无法表达“我要发起哪个提供方登录”。
4. 凭据 key 未分 provider 命名空间，未来多提供方会互相覆盖 token 与用户信息。
5. UI 文案与交互模型是“单按钮 BigModel 登录”，没有 provider 列表/策略扩展点。
6. 目前没有明确并发登录策略（同窗口快速连续点击不同 provider 的行为未定义）。

## 3. 最终目标

### 3.1 能力目标

1. 同一套 OAuth 主流程可接入多个提供方（Provider Adapter 可插拔）。
2. 每个提供方独立管理 state、token、userinfo 与错误处理，不互相污染。
3. UI 层可从配置驱动展示 provider 入口，按需开启/下线提供方。
4. 兼容现有 BigModel 登录数据与登录入口，平滑迁移。

### 3.2 产品策略（明确约束）

1. **单一活跃 provider**：同一时刻只维护一个 `active_provider`。
2. 新 provider 登录成功后，更新 `active_provider` 为新 provider（旧 provider token 可按策略保留或清理，见 Service 策略）。
3. **单窗口单 pending 登录**：同一窗口只允许一个待完成 OAuth 流程；发起新登录时自动取消旧 pending。

### 3.3 架构目标（遵循分层）

在 OAuth 域内保持单向依赖：

`Types -> Config -> Repo -> Service -> Runtime -> UI`

横切关注点（认证）统一通过 Providers 入口，不让 UI/业务层绕过 Providers 直接拼接第三方 OAuth 协议细节。

## 4. 目标结构设计

### 4.1 Types 层

在 `packages/shared` 增加 OAuth 领域类型：

- `OAuthProviderId`（如 `"bigmodel" | "github" | ...`）
- `OAuthStartRequest` / `OAuthStartResponse`
- `OAuthCallbackParams`（归一化后的 `code/state/...`）
- `OAuthTokenSet`
- `OAuthUserProfile`
- `OAuthProviderMeta`
- `OAuthLogoutScope`（`"active" | "all"`）

原则：类型只表达通用领域语义，不带具体厂商字段名。

### 4.2 Config 层

- 仅保留公开配置（authorize 地址、redirect 模板、显示名、是否启用、排序等）。
- `clientSecret`、私有交换参数等敏感字段不放到 `packages/shared` 或 renderer 可见路径。
- 敏感配置由 host process 在运行时注入。

Desktop 本轮约束：

1. 开发环境：使用本地 `.env.local`（已 `gitignore`）注入到 host process。
2. 打包环境：通过构建管线注入运行时环境变量，不写入源码仓库。
3. 风险标注：如果第三方接口要求客户端携带 `appSecret`，则属于协议级高风险，必须在文档中明确“可被逆向提取”。
4. 推荐方向：中长期将 token 交换下沉到受控后端，Desktop 仅持有短时授权码。

### 4.3 Providers 层（核心）

目录建议：`packages/services/src/oauth/providers/`。

定义 provider 适配器接口（示意）：

```ts
interface OAuthProviderContext {
  providerId: OAuthProviderId;
  redirectUri: string;
  state: string;
  now: () => number;
}

interface OAuthProviderAdapter {
  providerId: OAuthProviderId;
  parseCallbackParams(url: string): OAuthCallbackParams; // 必选：适配 authCode/code 等差异
  buildAuthorizeUrl(ctx: OAuthProviderContext): string;
  exchangeToken(params: OAuthCallbackParams, ctx: OAuthProviderContext): Promise<OAuthTokenSet>;
  fetchUserInfo?(tokenSet: OAuthTokenSet, ctx: OAuthProviderContext): Promise<OAuthUserProfile>;
  refreshToken?(tokenSet: OAuthTokenSet, ctx: OAuthProviderContext): Promise<OAuthTokenSet>;
  normalizeError(error: unknown): Error;
}
```

约束：Adapter 仅处理协议差异，不直接操作 `credentialService`，保持纯协议职责。

### 4.4 Repo 层

目录建议：`packages/services/src/oauth/repo/`。

统一 key 命名空间：

- `oauth:<provider>:access_token`
- `oauth:<provider>:refresh_token`
- `oauth:<provider>:user_info`
- `oauth:active_provider`

老 key 迁移采用 **懒迁移**（避免启动期全量迁移竞态）：

1. 优先读新 key。
2. 新 key 缺失时 fallback 读旧 key（`auth_token` / `refresh_token` / `user_info`）。
3. 读到旧值后立即写入新 key。
4. 写入成功后删除旧 key。

### 4.5 Service 层

`IOAuthService` 升级为 provider-aware（示意）：

```ts
interface IOAuthService {
  getProviders(): Promise<OAuthProviderMeta[]>;
  getActiveProvider(): Promise<OAuthProviderId | null>;
  startOAuth(provider: OAuthProviderId): Promise<{ authorizeUrl: string; state: string }>;
  handleCallback(url: string): Promise<UserInfo>;
  refreshToken(provider?: OAuthProviderId): Promise<void>;
  logout(provider?: OAuthProviderId): Promise<void>; // 不传则退出 active provider
  logoutAll(): Promise<void>;
  cancelPending(provider?: OAuthProviderId): Promise<void>;
}
```

状态结构：

- `state -> { provider, createdAt, timeout, sourceWindowId? }`

并发策略：

1. `startOAuth` 时若已有 pending，先 `cancelPending()` 再创建新 state。
2. 防止同窗口并发登录导致回调归属不清。

登出策略：

1. 默认 `logout()`：仅退出当前 `active_provider`。
2. `logout(provider)`：退出指定 provider（兼容未来“非 active 预清理”场景）。
3. `logoutAll()`：清理所有 provider 凭据。
4. 当 `active_provider` 被登出后，置空或按策略切换到最近仍有效 provider（本轮建议置空，行为最清晰）。

### 4.6 Runtime / Platform 层

Desktop main deep link 路由统一为单一入口：

- 当前路径：`zcode://oauth/callback?...`
- 已移除旧路径：`zcode://bigmodel-auth/callback?...`
- 已移除旧路径：`zcode://zai-auth/callback?...`

收敛策略：

1. 新客户端发起 OAuth 时，无论 provider，均使用 `zcode://oauth/callback` 作为 `redirect_uri`。
2. Desktop main 进程只识别 `oauth` host，provider 归属不从 callback host 推断。
3. 回调路由仍以 `state` 为权威索引；renderer 侧 `OAuthService` 根据 pending state 找回发起登录的 provider。
4. 不再提供 `ZAI_OAUTH_REDIRECT_URI` / `BIGMODEL_OAUTH_REDIRECT_URI` 及 legacy redirect URI 环境变量覆盖能力，避免发布环境重新产出旧 callback。

`registerOAuthState` 可附带 provider（可选），最终仍以 `state` 为权威索引。

### 4.7 UI 层

- `useOAuth` 改为 `startLogin(provider)`。
- LoginDialog 从“单按钮”升级为“provider 列表驱动”。
- i18n 文案改为通用模板 + provider 显示名映射，去掉硬编码 BigModel 文案。
- 默认保持 BigModel 置顶，保证现有用户路径不变。

## 5. 分阶段实施计划

### 阶段 0：安全与止血（必须先做）

1. 移除代码中的硬编码敏感信息（尤其 `clientSecret`）。
2. 完成密钥轮换。
3. 在 CI 增加 secret 扫描（pre-commit + pipeline）。
4. 增加“客户端 secret 风险”文档告警与发布前检查。

**退出标准**：仓库无明文 secret；新构建可通过运行时配置登录 BigModel；风险声明明确。

### 阶段 1：服务层抽象（不改 UI 行为）

1. 引入 Provider Adapter（含 `parseCallbackParams`）。
2. 明确 `OAuthProviderContext`。
3. 引入 `repo/` 层并完成 provider 命名空间 key。
4. 在 `repo/` 层同步落地老 key **懒迁移**（读新 key 失败时 fallback 旧 key，并回写新 key 后删旧 key）。
5. `IOAuthService` 增加 provider、logout、active provider 能力。
6. 保持 UI 仍只显示 BigModel（仅内部完成抽象）。

**退出标准**：BigModel 功能不回退，新增 provider 只需新增 adapter + config。

### 阶段 2：deep link 通用路由 + 过渡兼容

1. main 进程支持新旧 path 双路由。
2. 完成 redirect URI 切换流程（先客户端后服务端）。
3. 补齐冷启动/多窗口路由测试。

**退出标准**：任意 provider 回调都能正确路由；BigModel 迁移无中断。

### 阶段 3：UI 与 i18n 扩展

1. 登录弹窗 provider 列表化。
2. 文案从 BigModel 专有改为通用键。
3. 落地“单一活跃 provider”交互文案（例如登录替换提示）。

**退出标准**：同一 UI 可发起多个 provider 登录，无硬编码品牌词。

### 阶段 4：兼容与收尾

1. 完成老 key 清理收尾（懒迁移已在阶段 1 落地）。
2. 补齐 e2e：多 provider、取消登录、state 过期、回调异常、窗口关闭等。
3. 完整回归：Desktop 多平台（macOS、Windows、Linux）。

**退出标准**：通过 typecheck、lint、单测与核心 e2e；BigModel 老用户可无感迁移。

## 6. 测试策略

1. Provider Adapter 契约测试：引入 `MockProviderAdapter`，所有 provider 共享同一套契约用例。
2. adapter fixture 测试：每个 provider 只补充 fixture（授权 URL 参数、callback 样例、token/userinfo 响应样例）。
3. Service 测试：
   - 多 provider 状态隔离
   - 单 pending 并发保护
   - `active_provider` 切换
   - `logout()` / `logout(provider)` / `logoutAll()` 行为
   - 懒迁移流程
4. Desktop 集成测试：deep link 冷启动/热启动、多窗口路由、新旧 path 兼容。
5. 回归测试：仅启用 BigModel 时行为与当前版本一致。

## 7. 风险与对策

1. **风险：** provider 契约差异大（参数名、token 格式、userinfo 接口差异）。  
   **对策：** 强制通过 Adapter 层隔离，Service 仅消费归一化结果。
2. **风险：** 客户端保存或使用 `clientSecret` 存在逆向提取风险。  
   **对策：** 运行时注入 + 密钥轮换 + 明确风险告警；中长期迁移到服务端交换。
3. **风险：** 老凭据覆盖或丢失。  
   **对策：** provider 命名空间 key + 懒迁移 + 原子写入后删旧 key。
4. **风险：** deep link 在不同 OS 行为差异导致回调丢失。  
   **对策：** 保留单实例锁、冷启动缓存、平台专项 e2e，并保持新旧 path 过渡期兼容。
5. **风险：** 并发登录导致状态错乱。  
   **对策：** 单窗口单 pending，发起新登录先 cancel 旧流程。

## 8. 推荐落地顺序（执行建议）

1. 阶段 0（安全）
2. 阶段 1（服务抽象）
3. 阶段 2（deep link 通用化）
4. 阶段 3（UI 扩展）
5. 阶段 4（兼容与收尾）

该顺序可以在每一阶段都保持“可发布状态”，并降低一次性大改风险。

---

更新时间：2026-04-01
