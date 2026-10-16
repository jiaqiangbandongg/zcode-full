# ZAI / BigModel Provider Family Domain Boundary

> **历史实现说明，已被 Provider Refactor 的 Provider Group、Account Overlay 与 Access Config
> 取代。** 文中的 `AppSettings.providerFamilyDomain`、`ModelProviderService` 和 Registry 过滤链不再
> 是当前 Provider 事实源。当前设计见 `docs/working-memory/provider-refactor/design/`。

ZCode 的 ZAI / BigModel 内置模型供应商互斥边界由用户成功连接后的 provider family domain 决定。OAuth 登录态仍记录当前登录 provider，但不再作为模型供应商运行域的唯一事实源。

## 事实源

- 当前模型供应商运行域使用 `AppSettings.providerFamilyDomain`，取值为 `"zai"` 或 `"bigmodel"`。
- `providerFamilyDomain` 只在 WelcomeScreen 中 OAuth 登录成功或 API Key 保存成功后写入。
- `providerFamilyDomainMigrated` 标记旧数据是否已经迁移过，避免用户退出后又被旧 `oauth:active_provider` 自动恢复。
- 当前 App OAuth 登录 provider 继续使用 `oauth:active_provider`，只表示认证事实。
- ZAI 登录镜像使用 `oauth:zai:*`，其中 `zcodejwttoken` 是 ZAI Start Plan runtime 的 JWT。
- BigModel 登录镜像使用 `oauth:bigmodel:*`。
- 不再使用独立 provider connection 作为事实源。

## 互斥规则

- 未选择 `providerFamilyDomain` 时，WelcomeScreen 展示 ZAI 与 BigModel 连接入口。
- `providerFamilyDomain === "zai"` 时，ZAI 组可用，BigModel 组会被系统禁用并从 provider registry 过滤。
- `providerFamilyDomain === "bigmodel"` 时，BigModel 组可用，ZAI 组会被系统禁用并从 provider registry 过滤。
- 切换到另一个 provider family 只有在 OAuth 登录成功或 API Key 保存成功后才生效；取消或失败不改变当前 domain。
- ModelProviderService 会清空非当前 domain 的派生 apiKey，并写入 `systemDisabledReason: "oauth_provider_inactive"`。该 reason 历史命名保留，当前语义是 provider family 非活动。
- ZAI / BigModel provider 的 Unlink 等价于对应 active provider 的 App logout，不再存在独立 provider connection unlink 接口。
- ZAI logout 会同时清空 `builtin:zai-coding-plan` 与 `builtin:zai-start-plan` 的派生 apiKey / availability；BigModel logout 会清空 `builtin:bigmodel-coding-plan`。
- 当退出/解绑当前 `providerFamilyDomain` 或删除当前 domain 最后一个可用凭据时，清空 `providerFamilyDomain` 并更新 `providerFamilyDomainUpdatedAt`。`providerFamilyDomainMigrated` 保持 true。

## 运行时投影

- Provider registry 只同步当前 `providerFamilyDomain` 对应的 ZAI / BigModel 组。
- ZAI Start Plan 只有在 `providerFamilyDomain === "zai"` 时，才会把 `zcodejwttoken` 投影到 registry。
- Coding Plan key 刷新只应发生在登录或显式 Connect 后，普通 preset metadata 同步不会跨 provider 恢复旧 key。

## 数据迁移

- 如果 `providerFamilyDomain` 已存在，不覆盖用户选择。
- 如果 `providerFamilyDomain` 不存在且 `providerFamilyDomainMigrated !== true`，启动时从旧状态做一次迁移：
  - `oauth:active_provider` 为 `"zai"` 或 `"bigmodel"` 时，写入相同 domain。
  - 没有 active provider，但只有一个 family 有本地可用凭据时，写入该 family。
  - 两边都有凭据或两边都没有凭据时，不写 domain，等待 WelcomeScreen 让用户选择。
- 无论是否推断成功，都写入 `providerFamilyDomainMigrated = true`，避免后续重复迁移。
