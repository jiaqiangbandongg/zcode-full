# zai 与 bigmodel Team Plan 全链路对称化

更新日期：2026-08-05

> 历史实施 spec。本文后半部分的 `ModelProviderService`、Registry Snapshot 和 runtime-key 投影描述已经
> 被 Provider Refactor 取代。当前 Team/Individual 执行通过 Effective Provider Config、ModelFactory 与
> Account Request Auth Service 完成；动态凭据不进入 Registry。本文保留旧根因与迁移依据，不作为当前
> 代码地图。

## 背景

Model Provider 设置详情页的「连接方式」支持 Start Plan / Individual Coding Plan / Team Plan / API Key 四种。
历史上 Team Plan 只在 `bigmodel` family 上真正落地，`zai` family 的 Team Plan 是**断裂的半成品**：
key 生成层有半套设施，但识别、匹配、数据获取、UI 渲染、登录恢复全部 hardcode bigmodel 或被
`familySpec.id === "bigmodel"` 守卫挡住，zai team key 是死代码。

本 spec 描述把 zai 与 bigmodel 在 Team Plan 全链路对齐的改造。

## 名词

- `ProviderFamilyDomain = ModelProviderFamilyId = "zai" | "bigmodel"`
- Team Plan 连接键（connection key）：形如 `team-plan:<codingPlanProviderId>:<productId>:<orgId>:<projectId>`，
  用于在 `modelProviderFamilySelectedKeys[family]` 里标识"当前选中某个团队的订阅"。
- 企业定价 / 团队产品（enterprise pricing / team products）：`GET /subscription/enterprise/v2/pricing`
  返回的套餐列表，按 family 独立请求。

## 现状：5 环节不对称表

```text
环节                  bigmodel                          zai
──────────────────────────────────────────────────────────────────────
① service 路由       createCodingPlanSubscriptionService
                      └─ new BigModelCodingPlanSubscriptionProvider
                         enterprise 读方法 hardcode bigmodelCodingPlan   ❌ 无 zai 路由
                         + bigmodel host + bigmodel token                 所有调用直达 bigmodel provider

② request 类型       EnterpriseCodingPlanPricingRequest
                      └─ { authenticated?: boolean }                   ❌ 无 family 字段

③ 数据获取 hook      useEnterpriseCodingPlanProducts
                      ├─ getStaticTeamProducts 读 bigmodelCodingPlan    ❌ 无 family 参数
                      └─ getEnterprisePricing({ authenticated })          单实例只服务 bigmodel

④ connection key     plan-identity.ts
                      createBigModelTeamPlanConnectionKey               ⚠️ dispatcher 对 zai 走通用拼接
                      prefix = "team-plan:builtin:bigmodel-coding-plan:"   但 parse/matches 只认 bigmodel 前缀
                                                                       zai key 永远匹配失败（死代码）

⑤ UI 可见性          providerFamilyConnectionVisibility.ts
                      ├─ filterStartPlanItems:
                      │  hasTeamPlanEntitlement =
                      │    familySpec.id === "bigmodel" && ...           ❌ zai 永远 false
                      ├─ appendSubscribedTeamPlanItems:
                      │  codingPlanItem = items.find(bigmodelCodingPlan) ❌ 只从 bigmodel 派生
                      └─ buildEntitlementTeamPlanItems:
                         entitlements[bigmodelCodingPlan]                ❌ 只读 bigmodel entitlement

登录后选 key          resolveLatestModelProviderFamilyConnectionSelection
                      familySpec.id === "bigmodel" 守卫                  ❌ zai 有订阅也不识别

失效清理              ModelProviderSection 清理 useEffect（重复两份）
                      只读 selectedKeys.bigmodel                        ❌ zai 不清理
```

**关键事实（已直接读源码核实）**：

- `createTeamPlanConnectionKey` dispatcher（`packages/ui/src/lib/modelProviderFamilyConnectionSelection.ts:29-45`）
  对 zai 走通用字符串拼接产出 `team-plan:builtin:zai-coding-plan:...`，是唯一半对称点。
- 但下游 `matchesBigModelTeamPlanConnectionKey` 严格检查 bigmodel 前缀，zai key 永远匹配失败。
- `resolveLatestModelProviderFamilyConnectionSelection` 的 `familySpec.id === "bigmodel"` 守卫使 zai
  即使有 subscribed team products 也不被识别为 team 连接。
- zai team key 从未真正写入用户 `modelProviderFamilySelectedKeys.zai`（被各处守卫挡住），
  **实际无存量 zai team key 需迁移**。

## 目标：5 环节对称 + key 按 family 生成

```text
环节① service:    按 request.family 路由到独立 ZaiCodingPlanSubscriptionProvider
环节② request:    EnterpriseCodingPlanPricingRequest 加 family?: ProviderFamilyDomain
环节③ hook:       useEnterpriseCodingPlanProducts 加 family 参数
环节④ key:        新增 family-aware create/parse/matches
                  zai 前缀 = "team-plan:builtin:zai-coding-plan:"
环节⑤ UI 可见性:  appendSubscribed/buildEntitlement/filterStartPlan 去掉 bigmodel hardcode
                  登录恢复/失效清理对 zai 开放
```

## 后端契约（用户确认）

- zai 用自己的域名（测试 `api.z.ai` / 线上 `api.z.ai`，即 `resolveZaiCodingPlanHost()`）。
- 除"购买"相关路径外，定价 / 团队项目 / 订阅查询 / 余额等路径结构复用 bigmodel 的 URL 结构，
  仅 host、providerId、OAuth token 不同。
- 购买路径：Stripe / PayPal 在 bigmodel provider 内已 zai-aware（`assertZaiPaymentProvider` +
  `/api/pay` 前缀 + zai token），复用。Alipay `createSign`/`updateSign` 对 zai 显式抛
  `CODING_PLAN_ZAI_OVERSEAS_PAYMENT_REQUIRED`，保持不变。

## 关键技术决策

### 1. zai provider 独立类（不复用 bigmodel provider 实例）

bigmodel provider 的 enterprise 读方法（`getEnterprisePricing`、`getEnterpriseBalance`、
`getEnterprisePendingOrders`、`checkEnterpriseOrderStatus`、`enrichEnterprisePricingTeamProjects`）
硬编码了 `BUILTIN_MODEL_PROVIDER_IDS.bigmodelCodingPlan` 作为 providerId + bigmodel host + bigmodel token，
无法参数化复用。新建 `ZaiCodingPlanSubscriptionProvider`：

- 继承或组合 `BigModelCodingPlanSubscriptionProvider`
- override enterprise 读方法：host 用 `resolveZaiCodingPlanHost()`、providerId 用 `zaiCodingPlan`、
  token 用 `loadZaiAuthorization`
- override `enrichEnterprisePricingTeamProjects`：customerInfo 走 zai 域名 + zai token，
  team project 预热 key 走 zai providerId
- 购买路径（Stripe/PayPal）不 override，复用父类（已 zai-aware）

### 2. connection key 按 family 生成（无迁移风险）

`packages/shared/src/plan-identity.ts` 新增：

- `createTeamPlanConnectionKeyByFamily(family, parts)`
- `parseTeamPlanConnectionKeyByFamily(family, key)`
- `matchesTeamPlanConnectionKeyByFamily(family, candidateKey, selectedKey)`

bigmodel 分支委托给现有 `*BigModelTeamPlanConnectionKey`（保持兼容，bigmodel 前缀不变）。
zai 分支用 `team-plan:builtin:zai-coding-plan:` 前缀，结构 / legacy 兼容规则与 bigmodel 对称。

**无存量迁移**：zai team key 从未写入用户 selectedKey，不存在迁移。bigmodel 前缀不变。

### 3. 不改 bigmodel literal

~15 源文件 + ~10 测试文件的 `team-plan:builtin:bigmodel-coding-plan:` literal 保持不动。
zai 新代码统一用新 family-aware helper，不引入新 literal。

## 落地顺序（TDD：spec → 测试 → 实现）

### Phase 1 — shared 层

- `packages/shared/src/plan-identity.ts`：新增 3 个 family-aware helper
- `packages/shared/src/coding-plan-subscription.ts`：`EnterpriseCodingPlanPricingRequest` 加 `family?: ProviderFamilyDomain`
- `packages/shared/test/planIdentitySnapshot.test.ts`：补 zai family 用例（create/parse/matches/legacy/wildcard）

### Phase 2 — services 层

- 新建 `packages/services/src/coding-plan-subscription/zaiCodingPlanSubscriptionProvider.ts`
- `packages/services/src/coding-plan-subscription/codingPlanSubscriptionService.ts`：按 `request.family`
  路由到 bigmodel / zai provider 实例（family 缺省时保持 bigmodel，向后兼容）
- `packages/services/test/`：补 zai provider 单测（enterprise pricing 走 zai host/token、service 路由）

### Phase 3 — UI 层

- `useEnterpriseCodingPlanProducts.ts`：加 `family` 参数；读对应 family 的 static bucket；
  传 family 给 service
- `providerFamilyConnectionVisibility.ts`：`appendSubscribedTeamPlanItems` / `buildEntitlementTeamPlanItems`
  / `filterStartPlanItems` 按 family 循环或参数化
- `ModelProviderSection.tsx`：为 zai family 也调用 hook 得到 zai subscribedTeamProducts；
  清理 useEffect 改 family-aware（**合并当前重复的两份 effect**）；`showPurchasedTeamPlanFallback` family-aware
- `modelProviderFamilyConnectionSelection.ts`：去掉 `familySpec.id === "bigmodel"` 守卫，
  zai 也走 team key 解析；matcher 改用 family-aware 版本
- `oauthProviderFamilySelectionRefresh.ts` / `modelProviderFamilySelectedKeyMigration.ts`：
  team 识别对 zai 开放（`resolveCodingPlanProviderIdFromSelectedKey` 认 zai 前缀；
  `migrateBigModelTeamPlanSelectedKey` 泛化为 family-aware）

### Phase 4 — consumer 对齐

14+ `parse/matches/create` 调用点（model selection groups、usage sources、telemetry、off-peak、
composer、services layer）逐个改 family-aware。多数已在 `createTeamPlanConnectionKey` dispatcher 内，
只需下游 matcher/parse 也走 family-aware 版本。literal `startsWith("team-plan:...")` 检查点逐个评估。

### Phase 5 — 验证

- `pnpm typecheck` + `pnpm lint`
- 单测：plan-identity zai、zai provider、UI 可见性、selectedKey 迁移、登录恢复
- e2e：zai team plan 连接方式可见 / 登录恢复 / 失效清理
- 测试环境实际调用 zai 域名 enterprise pricing 验证后端契约

## 实施记录（2026-08-05）

### 后端契约验证

测试环境实际请求 `https://api.z.ai/api/biz/customer/getCustomerInfo`（zai 域名）成功，
返回结构与 bigmodel 同构（含 `organizations[].projects[]`，`projectType=2` 标识团队编程项目）。
zai token 用 `Bearer` header（区别于 bigmodel 裸 token）。

结论：zai team plan 的 availability 校验（customerInfo 团队项目验证）可复用 bigmodel 的 URL 结构，
只需 host → `buildRuntimeZaiBusinessUrl`、token → `oauth:zai:access_token`、header → `createZaiLoginAuthHeaders`。

### 注入流程运行时验证（dev:desktop:test）

5 环节对称化在 zai 已端到端打通，证据来自 app 日志 + `~/.zcode-dev` 凭证手动调用 `api.z.ai`：

1. **routing 正确**：`getEnterprisePricing` 由 `ZaiCodingPlanSubscriptionProvider` 处理，prewarm 日志带
   `family: "builtin:zai-coding-plan"`，请求落在测试环境 zai biz 域名 `api.z.ai`
   （`TEST_ZAI_BUSINESS_BASE_URL`，不是 zcode 前端域 `zcode.z.ai`）。
2. **customerInfo 正确**：测试账号在 `org-2B118...` / `proj_50399...` 下有 `projectType: 2` 团队项目，
   `getCustomerInfo` 200 成功，结构与 bigmodel 同构。
3. **注入流程复用**：prewarm 已对 zai 执行 list + POST create `zcode-team-api-key`：
   ```
   list:   { code: 200, apiKeyCount: 2, usableApiKeyCount: 0 }   ← 没有 name=zcode-team-api-key 的 key
   create: { code: 500, "You currently do not have a valid team subscription grant record,
                      unable to create API Key" }
   status: "missing"
   ```

**看不到 team plan 的根因 = zai 测试账号后端 grant 缺失**（与对称化代码无关）：
该 org/project 下不存在 `name=zcode-team-api-key, keyType=2` 的 key，且 POST 创建被 zai 后端拒绝。
`status: "missing"` → `apiKeyStatus: "unavailable"` → UI 按 `apiKeyStatus === "unavailable"` 过滤掉菜单项
（`modelSelectionGroups.ts` / `providerFamilyConnectionVisibility.ts`）。

> 注意：zai 后端虽然在该项目下返回了 `name="member-{userId}", keyType=2` 的 key，但客户端注入流程
> **不应**放宽 `isUsableBigModelTeamPlanApiKey` 的 name 校验去识别它——`zcode-team-api-key` 是
> zcode 客户端注入流程的统一命名契约，zai/bigmodel 都必须遵守。修复方式是给 zai 测试账号补 grant，
> 让 POST 能成功创建 `zcode-team-api-key`，而不是在客户端做 family 特判。

### 实际改动的文件清单

**shared**

- `plan-identity.ts`：`TEAM_PLAN_CONNECTION_KEY_PREFIX_BY_FAMILY` + family-aware `create/parse/matches/resolveFamily`
- `coding-plan-subscription.ts`：`EnterpriseCodingPlanPricingRequest.family?`
- `off-peak-types.ts`：`OffPeakCodingPlanKind` 新增 `zai-team`

**services**

- `coding-plan-subscription/`：新建 `zaiCodingPlanSubscriptionProvider`（继承 bigmodel，override host/token/header/providerId）；`codingPlanSubscriptionService` 按 `request.family` 路由
- `model-provider/codingPlanProviderAvailability.ts`：`validateSelectedTeamPlanAvailability(family, ...)` 泛化，zai 也走 customerInfo 校验；`validateZaiCodingPlanPairAvailability` 加 team project 校验
- `session/offPeakRuntimeModel.ts`：去掉 `providerFamily === "bigmodel"` 守卫，zai team plan 可走 off-peak

**UI lib**

- `modelProviderFamilyConnectionSelection.ts`：去 `familySpec.id === "bigmodel"` 守卫（latest + missing）
- `modelProviderFamilySelectedKeyMigration.ts`：`migrateBigModelTeamPlanSelectedKey` → family-aware `migrateTeamPlanSelectedKeyForDomain`；参数 `upgradeBigModelTeamPlan` → `upgradeTeamPlan`
- `oauthProviderFamilySelectionRefresh.ts`：`resolveCodingPlanProviderIdFromSelectedKey` 认 zai 前缀；`getEnterprisePricingProducts` 对 zai 拉定价；`hasCompleteTeamPlanConnectionKey` family-aware；启动恢复保护分支对 zai 开放
- `modelSelectionGroups.ts`：`buildTeamPlanConnectionOptions` 去掉 `familyId !== "bigmodel"` 守卫（zai team 选项可生成）；`createTeamPlanConnectionKey`/`matchesTeamPlanConnectionKey`/`isSelectedTeamPlanKnownUnavailable`/`resolveSelectedTeamPlanConnectionKey`/`isSelectedFamilyTeamPlanConnection` 全 family-aware
- `codingPlanUsageSources.ts`：team usage source 按 `product.family` 生成 key + providerId；`matchesTeamPlanUsageSourceKey` family-aware
- `codingPlanEntitlementContext.ts`：新增 `resolveTeamPlanEntitlementContext(family, ...)` + zai 版
- `codingPlanFunnelTelemetry.ts`：team plan 识别 family-aware

**UI section**

- `ModelProviderSection.tsx`：合并两个重复的失效 team key 清理 useEffect 为单个 family-aware effect；`showPurchasedTeamPlanFallback` family-aware；`isSelectedTeamPlanStillSubscribed` family-aware；为 zai 独立调 `useEnterpriseCodingPlanProducts` 并合并 `subscribedTeamProducts`
- `providerFamilyConnectionVisibility.ts`：`buildEntitlementTeamPlanItems`/`buildSelectedTeamPlanFallbackItems` 遍历两 family；`resolveTeamPlanProjectKey` family-aware
- `useModelProviderNavigation.ts`：`resolveRestoredSelection` team key 恢复 family-aware；`selectedTeamPlanKey` 传入也覆盖 zai
- `useCodingPlanEntitlements.ts`：zai team plan 查询带 organizationId/projectId/cacheKey（对称 bigmodel）
- `useEnterpriseCodingPlanProducts.ts`：加 `family` 参数（Phase 3）
- `enterpriseCodingPlanProducts.ts`：`family` 字段（Phase 3）

**UI 其它**

- `v4/composer/V4ComposerToolbar.tsx`：`resolveContextTeamUsageSourceFromEntitlementSnapshot` 按 snapshot.provider.id 判断 family
- `store/offPeakTaskStore.ts`：`hasAnyOffPeakCodingPlanProvider` team 识别 family-aware

### 显式保留为 bigmodel 专用的路径

以下路径**不需要** zai 对称，因为语义上就是 bigmodel 专用，或 zai 有独立等价路径：

- `codingPlanProviderAvailability.ts` 的 `validateBigModelCodingPlanPairAvailability` — 函数本身按 family 分离，zai 有独立的 `validateZaiCodingPlanPairAvailability`
- `modelProviderService.ts:178` 的 `resolveSelectedBigModelTeamContext` — 读 `selectedKeys.bigmodel`，bigmodel bucket 专用
- `zcodeAgentService.ts:1024` — 守卫 `providerId !== bigmodelCodingPlan` 直接 return false，仅服务 bigmodel provider 的项目成员提示

### 待评估项

- ~~`WorkspaceSidebarFooterUsageSummary` 的 `CurrentSidebarCodingPlanUsageSource.team` 分支类型硬绑 `bigmodelCodingPlan`；zai team usage summary 显示需要类型 + 调用方对齐（当前 zai 在 sidebar 只显示 individual）~~ ✅ 已修复（见下文「消费方对称化遗漏」章节）
- e2e：zai team plan 连接方式可见 / 登录恢复 / 失效清理的 e2e 测试待补

## 修复：zai Plan Card 卡在「加载中」（appendSubscribedTeamPlanItems bigmodel 守卫短路）

日期：2026-08-06

### 现象

zai OAuth 登录成功 + team plan provider 已落盘 + selectedKey 已是 team key 后，
设置页 Z.ai Plan Card 仍一直显示「加载中...」，无法进入连接方式详情。

### 根因（CDP 抓 React fiber + 运行时 state 确认）

`appendSubscribedTeamPlanItems`（`providerFamilyConnectionVisibility.ts`）有一个
**bigmodel 硬编码前置守卫**：

```typescript
const bigmodelCodingPlanItem = items.find(
  (item) => item.presetId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelCodingPlan,
);
if (!bigmodelCodingPlanItem) {
  return items; // ← 短路！
}
```

当设置页 `providerFamilyDomain === "zai"` 时，`codingPlanItems` 经
`shouldShowCodingPlanForProviderFamilyDomain` 过滤后**只含 zai family**（zai-coding-plan

- zai-start-plan），没有 `bigmodelCodingPlan`。守卫直接 return，zai teamPlan item
  **永远不生成**。

下游连锁：

- `connectionModeCodingPlanItems` 不含 teamPlan item
- `resolveSavedPlanConnectionItem(selectableNavigationItems, teamKey)` 找不到匹配 → null
- `pickFamilyModeNavigationItem` 走 `if (mode === "oauth" && savedItemKey)` 分支 →
  savedItemKey 不是 startPlan key → **return null**
- `selectedNavItem = null`
- `Detail.tsx` L269 `if (!selectedNavItem) return <ModelProviderLoadingCard>` →
  **永远 loading**

### 修复

`appendSubscribedTeamPlanItems` 去掉 bigmodel 前置守卫，三个 builder（entitlement /
fallback / product）各自按 family 用 `resolveCodingPlanItemForFamily` 解析对应
codingPlanItem（Phase 3 已改），不存在就跳过该 family。fallback 插入位置也改为按
首个 team item 所属 family 找锚点（原硬编码 `bigmodelCodingPlanItem.key`）。

### 测试

`packages/ui/test/providerFamilyConnectionVisibility.test.ts` 新增 1 个回归测试
「zai-only 视图（无 bigmodel codingPlan item）仍生成 zai Team Plan 连接项」，
覆盖 selectedTeamPlanKey 存在 + items 只含 zai 的场景。13 tests 全绿。

### 运行时验证

CDP 抓取修复前后的 React fiber state：

- 修复前：`connectionModeCodingPlanItems` 只有 1 个 item（zai-coding-plan），
  无 teamPlan item；`selectedNavItem = null`；Detail 渲染 `<ModelProviderLoadingCard>`。
- 修复后：HMR 应用后页面「加载中」消失（`loadingCount: 0`），Plan Card 正常渲染。

## 修复：zai Team Plan 在 sidebar badge / 聊天框模型选择 / 使用统计页不显示（消费方对称化遗漏）

日期：2026-08-06

### 现象

zai OAuth 登录 + team plan 已落盘 + 设置页 Plan Card 正常显示团队套餐后，以下三个区域仍**不显示** zai team plan 相关内容：

1. **侧边栏头像 badge**：不显示 team 标识 / 额度
2. **聊天框模型选择器**：不出现 zai team 模型分组
3. **使用统计页**：不显示 zai team source / 额度

### 根因

三个区域都是 Phase 3 zai 对称化时遗漏的**消费方**差异。lib 层 `modelSelectionGroups.ts` / `codingPlanEntitlementContext.ts` / `codingPlanUsageSources.ts` 已对称（能生成 zai team 数据），但消费数据的 UI 组件仍用 bigmodel 单 family 旧写法，把 zai team 数据挡在外面：

```text
区域                        断裂点
─────────────────────────────────────────────────────────────────────
sidebar badge               WorkspaceSidebarFooterUsageSummary.tsx
  ├─ 只拉 bigmodel enterprise products（无 zai hook）
  ├─ resolveSidebarCurrentCodingPlanUsageSource 只传 bigmodel selectedKey
  ├─ teamEntitlement.enabled 硬绑 providerId === bigmodelCodingPlan
  ├─ teamEntitlement.preferredProviderId 硬编码 bigmodelCodingPlan
  ├─ profilePlanBadge.hasTeamPlanEntitlement 带 bigmodelFamilyAllowed 前置守卫
  └─ providerEntitlements team 分支硬判 bigmodelCodingPlan providerId

聊天框模型选择器             V4ComposerToolbar.tsx
  ├─ resolveV4ContextPlanConnection 只识别 bigmodel team-plan 前缀
  │  （zai team selectedKey 落到 personalCoding 判断后 return none）
  ├─ V4ContextPlanConnection.teamCoding 类型硬绑 family: "bigmodel"
  ├─ resolveContextCodingPlanUsageSource providerId 类型/守卫硬绑 bigmodel
  ├─ contextCodingPlanUsageTeamSource 读 entitlements[bigmodelCodingPlan]
  ├─ enterpriseProducts hook 不传 family（默认只拉 bigmodel pricing）
  └─ buildModelSelectGroups 第 8/9 参数传 [] 和 false（team 分组永远建不出）

使用统计页                  SettingsPage.tsx + CodingPlanUsagePanel.tsx
  ├─ SettingsPage 只拉 bigmodel enterprise products（无 zai hook）
  ├─ checkingUsageCodingPlanTab 只等 bigmodel loading
  ├─ CodingPlanUsagePanel.zaiEntitlement 不排除 team（team 被当个人查询）
  ├─ CodingPlanUsagePanel.teamEntitlement 硬绑 bigmodelCodingPlan providerId
  └─ CodingPlanUsagePanel.effectiveEntitlement zai providerId 一律走个人分支
```

### 修复策略

统一对齐 `ModelProviderSection.tsx:486-522` 已验证的「双 family hook + 合并 subscribedTeamProducts」模式：

**lib 层先行**（`codingPlanUsageSources.ts`）：

- `CurrentSidebarCodingPlanUsageSource.team.providerId` 从硬绑 `bigmodelCodingPlan` 松开为 `SidebarUsageCodingPlanProviderId`
- `resolveSidebarCurrentCodingPlanUsageSource` 新增 `zaiSelectedKey` 参数，zai 分支先判 team-plan 前缀，命中返回 team source
- `formatTeamUsageSourceLabel` 按 `product.family` 取品牌前缀（zai → `Z.ai - `，bigmodel → `BigModel - `）

**消费方 1 — sidebar badge**（`WorkspaceSidebarFooterUsageSummary.tsx`）：

- 新增 `zaiEnterpriseProducts` hook，`subscribedTeamProducts` 合并双 family
- `currentUsageSource` 传 `zaiSelectedKey`
- `teamEntitlement` 按 `currentUsageSource.audience === "team"` 路由，`preferredProviderId` 动态取
- `profilePlanBadge` 去掉 `bigmodelFamilyAllowed` 前置守卫，`teamEntitlementLoading` 合并双 family loading
- `providerEntitlements` team 分支按 `audience === "team"` 路由（兼容 zai/bigmodel）

**消费方 2 — 聊天框模型选择器**（`V4ComposerToolbar.tsx`）：

- `V4ContextPlanConnection.teamCoding` 类型放开 `family: ProviderFamilyDomain` + zai/bigmodel providerId
- `resolveV4ContextPlanConnection` 新增 zai team-plan 前缀识别分支
- `resolveContextCodingPlanUsageSource` providerId 类型/守卫放开，按 `team-plan:` 前缀路由
- `contextCodingPlanUsageTeamSource` 按 `connection.providerId` 取对应 entitlement snapshot
- `enterpriseProducts` hook 传 `family: connection.family`
- 新增 `showPurchasedTeamPlanFallback` 计算（双 family 任一有 team key 即显示，对齐 `ModelProviderSection.tsx:549-558`）
- `buildModelSelectGroups` 传 `subscribedTeamProducts` + `showPurchasedTeamPlanFallback`（替代原 `[]` / `false`）

**消费方 3 — 使用统计页**（`SettingsPage.tsx` + `CodingPlanUsagePanel.tsx`）：

- `SettingsPage` 新增 `usageZaiEnterpriseProducts` hook，`usageSubscribedTeamProducts` 合并双 family；`checkingUsageCodingPlanTab` 合并双 family loading
- `CodingPlanUsagePanel.zaiEntitlement` 加 `!effectiveSourceIsTeamPlan` 守卫（team source 不当个人查）
- `CodingPlanUsagePanel.teamEntitlement` 按 `effectiveSourceIsTeamPlan` 路由，`preferredProviderId` 动态取
- `CodingPlanUsagePanel.effectiveEntitlement` 先判 team plan（命中走 teamEntitlement），否则按 providerId 走个人分支

### 测试

`packages/ui/test/codingPlanUsagePanel.test.ts` 新增 5 个 zai 对称回归测试：

- zai team product 展开为带 zai providerId + `Z.ai - ` 品牌前缀的 usage source
- `resolveSidebarCurrentCodingPlanUsageSource` 把 zai team selectedKey 解析成 team source
- zai team key 未匹配 source 时返回 null（不回退 individual）
- zai 个人 coding-plan key 解析成 individual
- `matchesTeamPlanUsageSourceKey` 对 zai team sourceId/selectedKey 正确匹配

全量相关测试（codingPlanUsagePanel 17 + providerFamilyConnectionVisibility / modelSelectionGroups /
sidebarUsageCodingPlanProviderPreference / codingPlanEntitlements / enterpriseCodingPlanProducts /
v4ComposerToolbarRecovery / modelProviderCodingPlan / modelProviderCodingPlanI18n /
zcodeModelSelectionResolution / modelProviderFamilyConnectionSelection /
workspaceSidebarFooterWebRemoteControlTooltip）共 **319 tests 全绿**。

### 多端 / 远控影响

本次改动只在 UI renderer 层（消费 entitlement / enterprise pricing 数据的 React 组件 + lib），
不涉及 stream / snapshot / queue / owner / replayable 等远控语义，桌面 continuous 与手机 replayable
链路均不受影响。

## 修复：zai Team Plan 聊天框模型选择器仍不显示（refreshCodingPlanApiKey zai 分支漏传 selectedKeys）

日期：2026-08-06

### 现象

上一节「消费方对称化遗漏」修复后，sidebar badge / 使用统计页已显示 zai team plan，但**聊天框模型选择器仍不显示 zai team 模型**（`modelGroups` 为空数组）。

### 根因（CDP 抓 React fiber + config.json 核实）

`builtin:zai-coding-plan` provider 的 `enabled: false`，导致 `shouldIncludeModelProviderInSelection` →
`isModelProviderEnabled(provider)` 返回 false → provider 被 `filterModelProvidersByEntitlement` 过滤掉 →
`buildModelSelectGroups` 拿不到 `codingPlanProvider` → team 模型分组建不出来。

`enabled` 由 availability 校验设置（`applyCodingPlanAvailabilityToProvider`）。zai 的 availability 校验
`validateZaiCodingPlanPairAvailability` → `validateSelectedTeamPlanAvailability("zai", context)` 需要
`context.modelProviderFamilySelectedKeys` 才能解析 selectedKey → 查 team project → 返回 `available`。

但 `refreshCodingPlanApiKey`（`modelProviderService.ts:1465`）调用 zai 分支时**漏传了**
`modelProviderFamilySelectedKeys`（bigmodel 分支传了，zai 没传）：

```typescript
// 修复前：zai 分支只传 apiClient + credentialService
isZaiCodingPlanProviderId(providerId)
  ? await validateZaiCodingPlanPairAvailability(providers, {
      apiClient,
      credentialService,                    // ← 缺 modelProviderFamilySelectedKeys
    })
  : ...
    ? await validateBigModelCodingPlanPairAvailability(providers, {
        apiClient,
        credentialService,
        modelProviderFamilySelectedKeys: ...,  // ← bigmodel 传了
      })
```

链路：`context.modelProviderFamilySelectedKeys` undefined → `resolveSelectedTeamContext` 返回 null →
`validateSelectedTeamPlanAvailability` 返回 `{ kind: "unknown" }` → 回退个人 `subscription/list` →
团队账号无个人订阅 → `{ kind: "unavailable", reason: "coding_plan_not_entitled" }` → `enabled: false`。

`resolveCodingPlanEntryStatus`（入口缓存）有同样的 zai 漏传 bug。

### 修复

`modelProviderService.ts` 两处调用点统一加载 `loadProviderRegistryFamilySettings()` 一次，
zai/bigmodel 两个分支共享 `modelProviderFamilySelectedKeys`：

- `refreshCodingPlanApiKey`（:1462-1482）
- `resolveCodingPlanEntryStatus`（:1300-1313）

### 测试

`packages/services/test/modelProviderService.test.ts` 新增回归测试
「Z.ai 已选 Team Plan 项目时刷新 Coding Plan 会按 team project 校验并启用 provider（对齐 BigModel）」，
覆盖 zai team selectedKey + getCustomerInfo team project 场景。已验证该测试在修复前失败、修复后通过。

## 修复：zai Team Plan 选中后发消息仍走个人 Coding Plan（runtime registry 漏 team apiKey 投影）

日期：2026-08-06

### 现象

选中 zai team plan、provider 已 `enabled: true`、聊天框也能选出 team 模型后，发消息却报
`[1113][Insufficient balance or no resource package. Please recharge.]`。日志显示请求命中的是
**个人 zai coding plan 的额度**，而不是选中团队项目的额度。

### 根因

`buildZCodeProviderRegistrySnapshot`（`modelProviderService.ts`）——发消息时下发给 agent runtime 的
provider 凭据快照——只有 bigmodel 的 team runtime key 投影（`resolveSelectedBigModelTeamPlanRuntimeApiKey`），
**没有 zai 对应实现**：

```text
buildZCodeProviderRegistrySnapshot
  ├─ bigmodelTeamRuntimeApiKey = resolveSelectedBigModelTeamPlanRuntimeApiKey(...)  ✅
  ├─ zaiTeamRuntimeApiKey     = （不存在）                                          ❌
  └─ filter.map(provider):
       bigmodel team 选中 → 覆盖 apiKey = team-ak.team-secret + enabled:true          ✅
       zai team 选中     → 不覆盖 → 仍是个人 coding plan 的空 apiKey / start plan JWT ❌
```

同时 `filterResolvedProviderFamiliesForRegistry` 里只有 bigmodel 给 `pickResolvedFamilyProvider`
传了 `forceCodingPlan: true`。zai 选中 team plan 时，coding provider（`enabled:false`，因为只有
team 选中后才会被 enable）会被 `pickResolvedFamilyProvider` 提前丢弃，runtime key 投影即使存在也
拿不到 provider → 下发的是 zai-start-plan / 个人 zai provider → 走个人 Coding Plan 余额。

链路：registry 下发个人 start plan JWT → agent runtime 据此鉴权 → 命中个人账户额度 → `[1113]` 余额不足。

### 修复（对齐 bigmodel 三处）

1. **`resolveSelectedZaiTeamContext`**：对齐 `resolveSelectedBigModelTeamContext`，用 family-aware
   `parseTeamPlanConnectionKeyByFamily("zai", selectedKey)` 解析出 `organizationId` / `projectId`。
2. **`resolveSelectedZaiTeamPlanRuntimeApiKey`**：对齐 `resolveSelectedBigModelTeamPlanRuntimeApiKey`，
   读 `oauth:${ZAI_PROVIDER_ID}:access_token` → 校验 zcode JWT 未过期 → 调用 zai 业务域名
   （`resolveZaiBusinessBaseUrl` + `createZaiLoginAuthHeaders`）的 `getCustomerInfo` 校验 org/project
   存在 → `ensureBigModelTeamPlanProjectApiKey` + `copyBigModelTeamPlanProjectApiKeySecret`
   （zai/bigmodel 业务 API 路径同构，仅 host/providerId/token 不同）→ 返回 `${apiKey}.${secretKey}`。
3. **`buildZCodeProviderRegistrySnapshot` 接入**：新增 `zaiTeamRuntimeApiKey` + `selectedZaiTeamContext`
   计算；filter 阶段保留 zai coding provider；map 阶段 zai team 选中时覆盖 `apiKey` + `enabled: true`。
4. **`filterResolvedProviderFamiliesForRegistry`**：zai 也传
   `forceCodingPlan: Boolean(resolveSelectedZaiTeamContext(familySelectedKeys))`，与 bigmodel 对称。

### 测试

`packages/services/test/modelProviderService.test.ts` 新增回归测试
「Z.ai Team Plan 选中时 provider registry 使用团队项目 API Key（对齐 BigModel）」，覆盖：
zai team selectedKey + zai 业务域名 `getCustomerInfo` / `api_keys` / `api_keys/copy` mock 场景，
断言 registry 返回 `apiKey: { source: "inline", value: "team-ak-zai.team-secret-zai" }`、
`models[0].disabledReason` 为 undefined、所有业务请求的 authorization 头为原始 zai token。

已通过 stash 验证该测试在修复前失败、修复后通过。typecheck（本次改动文件无新增错误）+ lint（0 errors）通过。

### 多端 / 远控影响

此修复只影响 host process 下发给 agent runtime 的 provider 凭据快照构造（`modelProviderService`），
不涉及 stream / snapshot / queue / owner / replayable 等远控语义。桌面 continuous 与手机 replayable
链路都通过同一个 `getProviderRegistrySnapshot` 读 provider，二者均受益于 zai team apiKey 投影修复，
不改变各自的 delivery 边界。

## 修复：Team Plan 启动后个人套餐使用统计缺少凭证

日期：2026-08-17

### 现象与根因

账号同时拥有个人套餐和 Team Plan，App 以 Team Plan 连接方式启动后，「使用统计」仍会按账号权益
展示个人套餐来源；但个人用量查询只读取当前缓存 Coding Plan provider 的 `apiKey`。Team Plan 启动时
该 provider 可能没有个人套餐 key，首次修复尝试调用通用 key 刷新仍不完整：个人 key 解析继续按
“默认名称，否则第一个项目”猜项目，当 Team Plan 项目排在前面时会误入 `projectType=2` 的团队项目，
在那里创建个人 `zcode-api-key` 被拒绝，刷新后 key 仍为空，最终抛出
`bigmodel_coding_plan_api_key_required` / `zai_coding_plan_api_key_required`。

### 语义

使用统计是账号级多来源视图，凭证必须按用户点击的来源独立解析：

```text
个人来源（无 organizationId / projectId）
  -> provider apiKey 缺失时刷新该 family 的个人 Coding Plan apiKey
  -> customerInfo 中只从 projectType != 2 的项目解析个人 key
  -> 重新读取 provider 后查询个人用量

团队来源（有 organizationId / projectId）
  -> 继续复制对应组织 + 项目的 Team Plan API Key
  -> 禁止回退个人 provider apiKey
```

个人凭证恢复复用 `IModelProviderService.refreshCodingPlanApiKey`，不在 usage provider 内复制 OAuth
或 API Key 兑换逻辑。刷新失败或刷新后仍无 key 时保留原错误语义。

### 运行连接与统计来源的边界

使用统计是多来源视图，用户点击的个人套餐不等于当前模型运行连接。当 Team Plan
是当前连接时，个人 Coding Plan provider 会被标记为 `enabled=false`，但它仍是个人
统计来源的凭证容器。因此：

```text
明确点击个人统计来源
  -> 精确匹配 preferredProviderId
  -> 允许读取 enabled=false 的个人 provider API Key
  -> 不修改当前 Team Plan 运行连接

模型运行时选择 provider
  -> 继续要求 enabled=true
```

放宽只适用于显式指定来源的 Coding Plan 统计查询，不得改变 agent registry
的当前连接选择。

## 修复：zai Team Plan 使用统计页报「无法读取用量统计」（bigmodelUsageQuotaProvider 多处 bigmodel 硬编码）

日期：2026-08-06

### 现象

zai team plan 选中、provider 已启用、聊天框能选出 team 模型、发消息也走团队项目后，
打开「使用统计」页 Coding Plan 面板仍报错：「无法读取用量统计。请稍后重试，或检查网络和供应商配置。」
日志显示抛出 `zai_coding_plan_api_key_required`。

### 根因

`packages/services/src/usage-stats/providers/bigmodelUsageQuotaProvider.ts`（quota / monitor 用量查询
provider）有 4 处只认 `bigmodelCodingPlan`，zai coding plan team plan 进不来：

```text
① shouldUseBigModelTeamContext(provider) — 只对 bigmodelCodingPlan 返回 true
   zai coding plan 即使带 org/project 也不进 team 分支
   → teamContext = null → 走个人分支用 provider.apiKey（zai coding plan team 模式下为空）
   → resolveAuthorization 返回 null → throw "zai_coding_plan_api_key_required"

② isProviderSelectableForQuota — 只为 bigmodel team 放宽「apiKey 为空」拦截
   zai team provider 的 apiKey 是运行时投影（不落盘到 provider config），被这里直接过滤掉

③ shouldAllowDisabledBigModelTeamProvider — 同样只认 bigmodel
   zai team 的 disabled provider 不被允许 → pickQuotaProvider 选不到

④ resolveBigModelTeamProjectApiKey — 硬编码 BIGMODEL_OAUTH_ACCESS_TOKEN_KEY + resolveBigModelApiOrigin
   zai team 即使进入此分支也读不到 token（key 名不对）
```

链路：上述任一拦截 → `pickQuotaProvider` 返回 null 或 team 授权解析返回 null →
`getCodingPlanUsageSnapshot` throw → UI 显示「无法读取用量统计」。

### 修复（4 处 family-aware 化）

1. `BigModelTeamContext` → `TeamPlanContext`，新增 `family: ProviderFamilyDomain` 字段
2. `shouldUseBigModelTeamContext` + `resolveBigModelTeamContext` → 合并为
   `resolveTeamPlanContextForProvider(provider, request)`：任何 coding plan provider
   （`isCodingPlanModelProviderId`）配合 org/project 都解析出带 family 的 team context
3. `resolveBigModelTeamProjectApiKey` → `resolveTeamPlanProjectApiKey`：按 `teamContext.family`
   选 OAuth token key（`oauth:zai:access_token` vs `oauth:bigmodel:access_token`）+
   业务域名（`resolveZaiBusinessBaseUrl` vs `resolveBigModelApiOrigin`）。header 构造
   （`createBigModelBizHeaders`，含 `bigmodel-organization`/`bigmodel-project`）zai/bigmodel
   业务接口已验证同构，复用

> **token key 规约（关键）**：OAuth credential key 用的是 **OAuth provider id**
> （`ZAI_PROVIDER_ID = "zai"` / `BIGMODEL_PROVIDER_ID = "bigmodel"`），不是
> **builtin provider id**（`BUILTIN_MODEL_PROVIDER_IDS.zai = "builtin:zai"`）。
> 初版修复误用 `BUILTIN_MODEL_PROVIDER_IDS.zai` 拼 key 得到 `oauth:builtin:zai:access_token`，
> 实际 credential 存的是 `oauth:zai:access_token`（对齐 `loadZaiAuthorization`），
> 导致 token 永远加载不到 → `zai_coding_plan_api_key_required`。已修正为 `ZAI_PROVIDER_ID`。4. `shouldAllowDisabledBigModelTeamProvider` → `shouldAllowDisabledTeamProvider`：
> 任何 coding plan provider 配合 team org/project 都允许 disabled provider 5. `isProviderSelectableForQuota`：team org/project 存在时，任何 coding plan provider
> 都放宽 apiKey 为空拦截（preferredProviderId 精确匹配由 `pickQuotaProvider` 兜底）

### 测试

`packages/services/test/usageStatsService.test.ts` 新增 2 个 zai 对称回归测试：

- 「Z.ai Team Plan 用量在 provider apiKey 为空时复制团队项目 API Key（对齐 BigModel）」
- 「Z.ai Team Plan 用量允许已登录但被禁用的 Coding Plan provider（对齐 BigModel）」

覆盖：zai coding plan provider + zai OAuth token（`oauth:zai:access_token`，对齐
`loadZaiAuthorization`）+ zai 业务域名（`api.z.ai`）+ 团队项目 api_keys list/copy +
monitor quota/model-usage/tool-usage。已通过 stash 验证：修复前两个测试均失败
（token key 不匹配导致 `zai_coding_plan_api_key_required`），修复后通过。
usageStatsService 全部 12 tests 全绿。

typecheck（services 包 0 错误）+ lint（0 errors）通过。

### 多端 / 远控影响

此修复只影响 host process 的用量统计查询（`usageStatsService` → monitor API），不涉及
stream / snapshot / queue / owner / replayable 等远控语义。桌面 continuous 与手机 replayable
链路都通过同一个 `usageStatsService` 读用量，二者均受益于 zai team 用量查询修复。

## 修复：zai Team Plan 输入框旁上下文用量不显示额度（V4ComposerToolbar teamEntitlement 硬编码 bigmodelCodingPlan）

日期：2026-08-06

### 现象

zai team plan 选中后，输入框左侧的「上下文用量 / 套餐剩余额度」区域不显示 zai team plan
的 quota（落空或显示为空）。

### 根因

`packages/ui/src/v4/composer/V4ComposerToolbar.tsx`（`V4ComposerModelControls`）里给
`teamEntitlement` hook 传的 `preferredProviderId` 硬编码为 `bigmodelCodingPlan`：

```typescript
const teamEntitlement = useUsageEntitlement({
  ...
  preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelCodingPlan, // ← 硬编码
  requirePreferredProvider: true,
  organizationId: contextCodingPlanUsageTeamSource?.organizationId,
  projectId: contextCodingPlanUsageTeamSource?.projectId,
});
```

zai team plan 选中时，`contextCodingPlanUsageTeamSource.providerId` 已正确产出为
`zaiCodingPlan`（在 `resolveContextTeamUsageSourceFromEntitlementSnapshot` /
`resolveV4ContextPlanConnection` 里按 family 处理），但这里没跟随它，仍传 `bigmodelCodingPlan`。

链路：`preferredProviderId=bigmodelCodingPlan` + zai team org/project →
服务端 `pickQuotaProvider` 按 `provider.id === preferredProviderId` 精确匹配
（`requirePreferredProvider: true`）→ zai coding plan provider 不匹配 bigmodelCodingPlan →
返回 null → `resolveAuthorization` 返回 null → `teamEntitlement.snapshot` 为空 →
输入框旁上下文用量区域不显示 zai team 额度。

### 修复

`preferredProviderId` 改为跟随 `contextCodingPlanUsageTeamSource.providerId`：

```typescript
preferredProviderId:
  contextCodingPlanUsageTeamSource?.providerId ??
  BUILTIN_MODEL_PROVIDER_IDS.bigmodelCodingPlan,
```

`contextCodingPlanUsageTeamSource.providerId` 已在
`resolveContextTeamUsageSourceFromEntitlementSnapshot`（按 family 反查 coding plan provider id）
和 `resolveV4ContextPlanConnection`（zai team 分支产 `zaiCodingPlan`）里正确产出，可直接复用。

### 多端 / 远控影响

此修复只影响 UI renderer 层（输入框旁上下文用量的 entitlement 查询参数），不涉及
stream / snapshot / queue / owner / replayable 等远控语义，桌面与手机链路均不受影响。

## 风险点

| 风险                                                                          | 缓解                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~~zai 后端企业接口实际行为未知~~                                              | ✅ 已验证：测试环境 `api.z.ai` getCustomerInfo 成功，结构与 bigmodel 同构；注入流程（list + POST create `zcode-team-api-key`）已在 zai 复用，prewarm 日志可见。测试账号 POST 创建被拒（缺 grant）属后端侧问题，代码无需改动 |
| ~~ModelProviderSection 清理 useEffect 重复（anomaly）~~                       | ✅ 已合并为单个 family-aware effect                                                                                                                                                                                                 |
| ~~`WorkspaceSidebarFooterUsageSummary` 显式 `providerFamily !== "zai"` 排除~~ | ✅ 已修复：sidebar badge / 聊天框模型选择 / 使用统计页三个消费方已全部对称化（见上文「消费方对称化遗漏」章节）                                                                                                                      |
| literal 前缀检查点遗漏                                                        | grep 全量 `team-plan:` literal 逐一评估，已覆盖核心路径                                                                                                                                                                             |

## 修复：zai coding plan provider 不落盘（endpoint 兜底对称化）

日期：2026-08-05

### 现象

zai OAuth 登录成功后，设置页 Plan Card 仍显示「未连接」。直接读 `config.json` 发现
`builtin:zai-coding-plan` provider 不存在，而 `builtin:bigmodel-coding-plan` 正常存在。

### 根因

`loadSinglePresetProvider`（`packages/services/src/model-provider/repo/oauthPresetProviderRepo.ts`）
的 endpoint 解析**不对称**：

```text
oauthProvider === BIGMODEL_PROVIDER_ID
  ? buildBigModelCodingPlanAnthropicEndpoints(matchedProviders)  // ✅ 内部带兜底域名
  : collectSchemaEndpoints(matchedProviders)                     // ❌ 无兜底
```

- bigmodel：`buildBigModelCodingPlanAnthropicEndpoints` → `resolveBigModelCodingPlanAnthropicBaseUrl`
  硬编码兜底 `https://open.bigmodel.cn/api/anthropic`，remote 不下发 baseUrl 也能构造 endpoint。
- zai：`collectSchemaEndpoints` 在 `baseUrl` 为空时直接 `continue`（`oauthPresetProviderRepoShared.ts`），
  返回空 endpoint → `getModelProviderEndpointKinds(endpoints).length === 0` →
  `loadSinglePresetProvider` return null → `builtin:zai-coding-plan` 永远不落盘。

UI 判定 `resolveCodingPlanEntitlementState` 里 `hasCodingPlanProvider=false` → 显示「未连接」。

### 修复（与 bigmodel 完全对称）

`packages/services/src/model-provider/repo/oauthPresetProviderRepoShared.ts` 新增 zai 三件套：

1. `resolveZaiCodingPlanAnthropicBaseUrl(env)` → `${resolveZaiBusinessBaseUrl(env)}/api/anthropic`
   （测试 `api.z.ai` / 线上 `api.z.ai`，与 builtin:zai API Key provider 运行时域名一致）
2. `normalizeZaiCodingPlanAnthropicBaseUrlForEnv(baseUrl, env)`：remote baseUrl 优先，缺失或非法时
   回退兜底；补一层 `new URL()` 合法性校验（`normalizeModelProviderBaseUrlForKind` 不拦截纯文本）
3. `buildZaiCodingPlanAnthropicEndpoints(providers)`：remote anthropic baseUrl 优先，否则兜底；
   paths 用 `/v1/messages`

`packages/services/src/model-provider/repo/oauthPresetProviderRepo.ts` 改 endpoint 分支：

```typescript
const endpoints =
  oauthProvider === BIGMODEL_PROVIDER_ID
    ? buildBigModelCodingPlanAnthropicEndpoints(matchedProviders)
    : buildZaiCodingPlanAnthropicEndpoints(matchedProviders); // 从 collectSchemaEndpoints 换过来
```

（`oauthProvider` 在此函数只有 `BIGMODEL_PROVIDER_ID` / `ZAI_PROVIDER_ID` 两个值，二者都是 coding plan provider。）

### 测试

`packages/services/test/oauthPresetProviderRepoSharedZai.test.ts`（7 tests 全绿）覆盖：
remote baseUrl 优先、缺失 baseUrl 时兜底、非法 URL 回退、环境解析、与 bigmodel 对称性。

### 多端 / 远控影响

此修复只影响 provider 持久化层（本地 config.json 写入），不涉及 stream / snapshot / queue /
owner / replayable 等远控语义，桌面 continuous 与手机 replayable 链路均不受影响。

## quota limit type 等价（CREDIT_LIMIT ↔ TOKENS_LIMIT）

### 现象

zai Team Plan 选中后，使用统计页的「5 小时 / 每周」配额卡空白，聊天框上下文用量、
Usage Remaining 浮层同样不显示额度。monitor 接口 `getCodingPlanUsageSnapshot` 返回 OK，
但 UI 匹配不到 limit。

### 根因（运行时日志确认）

zai 业务后端 Team Plan 的 `/api/monitor/usage/quota/limit?type=2` 返回的 limit `type` 是
`CREDIT_LIMIT`，bigmodel 业务后端是 `TOKENS_LIMIT`。两者 `unit/number` 语义完全一致：

| 卡片         | 查询条件           | bigmodel 返回  | zai 返回               |
| ------------ | ------------------ | -------------- | ---------------------- |
| 5 小时       | `unit=3, number=5` | `TOKENS_LIMIT` | `CREDIT_LIMIT`         |
| 每周         | `unit=6`           | `TOKENS_LIMIT` | `CREDIT_LIMIT`         |
| 工具（每月） | `unit=5, number=1` | `TIME_LIMIT`   | （zai 测试账号未返回） |

四个消费方（`CodingPlanUsagePanel` / `CodingPlanContextUsage` /
`CodingPlanUsageRemainingPanel` / `StatusCards`）原本硬绑 `TOKENS_LIMIT`/`TIME_LIMIT` 精确匹配，
zai 返回 `CREDIT_LIMIT` 时全部 miss → 配额卡不渲染。

### 修复

`packages/ui/src/lib/codingPlanQuotaPresentation.ts` 新增等价 type 集合与分类判断：

```typescript
const TOKEN_LIMIT_TYPES = new Set(["TOKENS_LIMIT", "CREDIT_LIMIT"]);
const TOOL_LIMIT_TYPES = new Set(["TIME_LIMIT"]);

export function isSameLimitCategory(limitType, queryType): boolean {
  if (limitType === queryType) return true;
  if (TOKEN_LIMIT_TYPES.has(queryType)) return TOKEN_LIMIT_TYPES.has(limitType);
  if (TOOL_LIMIT_TYPES.has(queryType)) return TOOL_LIMIT_TYPES.has(limitType);
  return false;
}
```

- `findCodingPlanQuotaLimit` 改用 `isSameLimitCategory`，`unit/number` 仍精确匹配。
  覆盖 `CodingPlanUsagePanel` / `CodingPlanContextUsage` / `CodingPlanUsageRemainingPanel`。
- `StatusCards.tsx` 的 file-scoped `findUsageLimit` 同样改用导出的 `isSameLimitCategory`，
  与前者保持一致（原本靠 `isDisplayableUsageLimit` 兜底，现在精确卡片也能命中）。

### 设计说明

zai 后端用 `CREDIT_LIMIT` 是当前线上行为（api.z.ai / api.z.ai 均如此）。
按「和 bigmodel 应该一样」的产品预期，`CREDIT_LIMIT` 视为 zai 后端待对齐的历史命名；
消费方等价匹配后，zai 后端若后续统一切到 `TOKENS_LIMIT`，UI 无需再改。
unit/number 语义是稳定契约，type 枚举差异通过等价集合吸收。

### 测试

`packages/ui/test/codingPlanUsagePanel.test.ts` 新增 2 个测试：

- zai `CREDIT_LIMIT` 按 `TOKENS_LIMIT` 查询等价命中（5h / weekly），缺失项返回 null
- bigmodel `TOKENS_LIMIT`/`TIME_LIMIT` 原行为不变，`CREDIT_LIMIT` 不误匹配 `TIME_LIMIT` 查询

### 多端 / 远控影响

纯 UI 层 limit 匹配逻辑，不涉及 stream / snapshot / queue / owner / replayable 语义。

## 相关文档

- `docs/coding-plan-enterprise.md` — 企业版编程套餐购买闭环（bigmodel 现状）
- `docs/input-model-provider-team-plan-linkage.md` — 输入框模型/Provider/Team Plan 链路
- `docs/coding-plan-purchase-panel-flow.md` — 购买面板流程
- `docs/model-provider-coding-plan-availability.md` — Coding Plan 可用性计算
