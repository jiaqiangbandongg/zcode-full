# Coding Plan 连接状态语义（个人套餐"未连接"回归）

> 后续裁决：本文保留原分支的设计与审查历史；“获取失败 → 重新登录”及 §7.2 的候选方案已由 [Provider Refactor Todo114](../working-memory/provider-refactor/steps/todo-114-account-status-sync-and-key-retry.md)（上游原 Todo105）取代。当前按该 Todo 补齐同步协议、统一两家缺 Key 分类，并复用刷新重试。

> 状态：spec（待决策/待实现）
> 日期：2026-09-10
> 相关：`docs/coding-plan/zai-bigmodel-team-plan-symmetry.md`、`packages/services/src/model-provider/codingPlanProviderAvailability.ts`、`packages/provider/src/account-provider-state.ts`、`packages/ui/src/settings/model-provider-section/providerFamilyConnectionVisibility.ts`

## 1. 问题

**已登录、服务端明确回答"该账号没有个人版 Coding Plan 订阅"时，设置页个人套餐卡显示"未连接 + 连接按钮"，应为"未开通，开通后启用 + 订阅按钮"。**

实测证据（2026-09-10，生产账号 `63821741092061425`）：

- `GET https://bigmodel.cn/api/biz/subscription/list` → `{"code":200,"success":true,"data":[]}`
- `GET https://bigmodel.cn/api/monitor/usage/quota/limit` → `{"code":500,"msg":"当前用户不存在coding plan"}`
- `bigmodelUsageQuotaMapper.ts:98` `isNoPlanMessage()` 命中 `"不存在coding plan"` → `unavailableReason: "no_plan"`

同账号团队版（`org-64faf` quota `code:200`）与 Start Plan（billing/balance 有 active plan）均正常，因此现象表现为"只有个人套餐显示未连接"。

## 2. 回归定位：rebase 前后行为对比

分界点：2026-09-10 16:43 `pull origin staging`（`790884b1ce` → `fa70e89683`），带入 `codex/provider-refactor-m2`（`90b2cf83ceb` 2026-08-20、`524f1ba2e5d` 2026-09-07）。rebase 前的基点 `790884b1ce` 不含这两个提交。

### 2.1 旧实现为什么正确

`git show 790884b1ce:.../providerFamilyConnectionVisibility.ts`（旧 `resolveCodingPlanEntitlementState`）判定顺序：

```
if (!hasCodingPlanProvider && loading)      → checking
if (!hasCodingPlanProvider)                 → disconnected      ← 判据 = 本地 provider 是否配置
if (zai && !apiKey)                         → disconnected
if (snapshot.unavailableReason === "no_plan") → notPurchased     ★ 关键分支
if (snapshot.unavailableReason === "not_configured") → disconnected
if (snapshot.unavailableReason === "unavailable")    → unavailable
if (currentSubscription / snapshot.quota)   → purchased
default                                     → notPurchased
```

旧 `useCodingPlanEntitlements.ts` 的查询开关只看**本地 provider 是否存在**：

```ts
bigmodelCodingPlanQueryEnabled =
  Boolean(bigmodelProviderFingerprint) || Boolean(bigmodelProvider && bigmodelTeamPlanContext);
```

即"本地有这个 provider（含派生 key）就查权益快照"，与账号是否有权益无关 → 个人卡拿到 `no_plan` → **`notPurchased`（"未开通，开通后启用" + 订阅按钮）**。

**结论：旧实现下，本账号的个人卡会显示"未开通"，用户观察到的"rebase 前是好的"成立。**

### 2.2 新实现为什么变成"未连接"

```
packages/services  validateSubscriptionListAvailability()
        → { kind:"unavailable", reason:"coding_plan_not_entitled" }   （reason 词汇在此层）
        ▼
  accountProviderConnectionResolver.ts:189  connections.push({ status: availability.kind })   ✗ reason 丢失
        ▼
packages/provider  account-provider-resolution.ts:63   states[id] = { availability, entitled }  ✗ 无 reason
        ▼
packages/ui  resolveAccountProviderInspectionAccess()  accountProviderAccess.ts:48
        if (provider.accountState?.availability === "unavailable") return null;   ✗ 不再发起权益查询
        ▼
  resolveCodingPlanEntitlementState()
        const canInspect = accountEntitled || accountAvailability === "pending";
        if (!canInspect) → status:"disconnected"     ✗ 短路，走不到 notPurchased
```

运行时对照（同一份日志）：

| 时段 | 实例代码 | personal 范围权益查询次数 |
|---|---|---|
| 15 点 | rebase 前 | 33 |
| 16 点 | 16:43 前为旧代码 | 17 |
| 17 点 | rebase 后（17:17 / 17:25 实例） | **0** |

即新实现连"服务端说没套餐"这个事实都没再取回来，直接由 Account Overlay 的 `entitled=false` 收敛成"未连接"。

### 2.3 净结论

- **账号切换**解释了"为什么这张卡现在没权益"（个人套餐挂在测试账号上）；
- **rebase 带入的 provider-refactor** 解释了"为什么没权益被画成未连接"——旧的 `snapshot.no_plan → notPurchased` 通路被新架构的 `canInspect` 短路替代，且 `unavailableReason` 在跨层时丢失。

## 3. 目标语义

`accountAvailability === "pending"` 与 `accountEntitled === true` 的既有分支保持不变，只补回"已登录但服务端明确无订阅"一档：

| accountEntitled | availability | 原因 | 卡片状态 | 文案 | 主按钮 |
|---|---|---|---|---|---|
| true | available | — | 按快照 | 现值 | 现值 |
| false | pending | — | 按快照（待生效可查看） | 现值 | 现值 |
| false | unavailable | 明确无权益 | **notPurchased** | 未开通，开通后启用 | **订阅** |
| false | unavailable | 凭据失效 | unavailable | 获取失败 | 重新登录 |
| false | unavailable | 未登录 / 未连接 | disconnected | 未连接 | 连接 {provider} |
| false | unknown / 原因缺失 | — | disconnected（现状，向后兼容） | 未连接 | 连接 {provider} |

**边界（必须保持不变）**：

- **Start Plan 不参与**：它靠 `disconnected` 呈现领取/付费卡（`StatusCards.tsx` `disconnectedStartPlanPricingVisible`），且 `notPurchased` 在 `buildVisibleFamilyConnectionItems` 中意味着"明确无权益 → 隐藏入口"（`packages/ui/test/providerFamilyConnectionVisibility.test.ts` 已锁定）。
- **Team Plan 不参与**：团队卡由 `buildTeamPlanItems` 从团队权益快照组装，有自有文案（"团队套餐未分配"等），不经过本条分流。

## 4. 候选方案（待决策）

### 方案 A：恢复旧信号（快照 `no_plan`）

放宽 `resolveAccountProviderInspectionAccess` 对 `availability === "unavailable"` 的拦截，让个人 provider 仍能取回快照；`resolveCodingPlanEntitlementState` 在 `!canInspect` 时若 `snapshot.unavailableReason === "no_plan"` → `notPurchased`。

- 优点：行为与 rebase 前一致，改动集中在 UI 层，不动跨包契约。
- 缺点：为"不可用"的 provider 重新引入一次权益查询（旧实现本来如此）；同一问题存在两个权威（availability 的 `not_entitled` 与 quota 的 `no_plan`），日后易再漂移。

### 方案 B：透传 availability 的原因（推荐）

1. `packages/provider`：`AccountProviderState` / `AccountProviderConnectionResult(unavailable)` 增加可选 `unavailableReason`（`not-authenticated` / `not-connected` / `credential-failed` / `not-entitled`）；`unknown` 沿用上一次 State 的规则与 `availability` 一致；只进 Account State，不写 Provider Config。
2. `packages/services`：`accountProviderConnectionResolver` 把 `CodingPlanUnavailableReason` 映射为该 union。
3. `packages/ui`：`useModelProviderNavigation` 透传 `accountState.unavailableReason`，按第 3 节分流；仅对 **individual** provider 生效；原因缺失时保持现状（向后兼容）。

- 优点：权威唯一（Account Overlay 已经算出了 `not_entitled`），不额外发请求，方向与 provider-refactor 一致。
- 缺点：跨三包契约变更，需要补单测/ e2e。

## 5. 测试要求（按"先写测试"执行）

- 单测 `packages/ui/test/providerFamilyConnectionVisibility.test.ts`：四种原因分支；无原因回退 `disconnected`；Start Plan 传"明确无权益"时行为不变（防回归）。
- 单测 `packages/services/test/accountProviderConnectionResolver.test.ts`：原因映射与 State 透传；`unknown` 沿用上次原因。
- e2e：见第 8 节的缺口说明。

## 6. 影响面与风险

- 方案 B 为 additive optional 字段，`available` / `entitled` 判定与模型可用性不受影响；
- 个人卡由 `disconnected` 变为 `notPurchased`：入口可见性不受影响（隐藏规则只对 Start Plan 生效），"订阅"按钮（`buyAction`）已存在；
- 需确认 Host↔Renderer 的 `accountState` 无 schema 裁剪；
- 该语义层为桌面端与手机远控共享，无 `continuous` / `replayable` 差异。

## 7. 范围外（相邻缺陷，另行处理）

### 7.1 Team quota 把业务 500 吞成未分配

`validateTeamPlanQuotaAvailability` 在 HTTP 200 + envelope `code:500, success:false` 时走 `hasQuotaData=false → coding_plan_not_entitled` 确定态，并写入 24h 入口缓存（`codingPlanProviderAvailability.ts:381-392`）。应归 `unknown`（不落缓存）。本账号 `org-272fbf` 项目 2026-09-10 实测 11 次 `code:500`。

### 7.2 Z.AI 与 BigModel 的"缺派生 key"原因不对称（本次决定不改，待产品确认）

**触发条件**：登录的是 zai family（`providerFamilyDomain` 落成 zai）**且**账号级派生 key 为空（无套餐导致派生不出，或派生失败）。

| 账号状态 | BigModel 的 reason | Z.AI 的 reason | 本次改动后显示 |
|---|---|---|---|
| 未登录 | `not_connected`（resolver 早退，`accountProviderConnectionResolver.ts:111-120`） | 同左（同一早退分支） | 两端"未连接"，无分叉 |
| 登录 + 派生 key 为空 | `not_connected`（调用点常量） | `auth_failed`（`resolveMissingZaiApiKeyReason` 见 user_info 即判定） | 未连接 vs **获取失败**，分叉 |
| 登录 + 有 key + 订阅列表为空 | `not_entitled` | `not_entitled` | 两端"未开通"，为本次修复点 |

**根因**：`codingPlanProviderAvailability.ts:140-154` 中 zai 传动态判定、bigmodel 传常量；`resolveMissingZaiApiKeyReason`（同文件 :657-662）把"没有派生 key"也报成 `auth_failed`，复用了"凭据被服务端拒绝"的语义。

**修法（未执行）**：

- A：`return userInfo ? "coding_plan_not_connected" : "coding_plan_not_authenticated"` —— 一行对齐，`auth_failed` 只留给 `classifyAvailabilityError` 的真 401/403；
- B：缺 key 时改用 OAuth access token 查询 `subscription/list`，把该状态也纳入"未开通"（需后端确认该接口是否接受 OAuth token）。

**为何"未登录时看不到"不能作为不改的依据**：`shouldShowCodingPlanForProviderFamilyDomain`（`useModelProviderNavigation.ts:307-312`）在 `providerFamilyDomain` 为空时对两个 family 都返回 true（即两端卡片都会显示），只有 domain 落定后才按 family 过滤；而 domain 一旦落定不会因登出重置。因此分叉受众 = zai domain 且处于"登录 + 派生 key 为空"的用户。

**本次决策**：不改（保持 zai 在该状态的新文案"获取失败"）；若后续认为不应引入该文案变化，最小收敛方式是在 UI 侧去掉 `credential-failed → unavailable` 分支，使其回退 `disconnected`（等于改动前行为），此时本 MR 净效果仅剩"无订阅 → 未开通"。

### 7.3 其它待确认项（来自 2026-09-10 review）

- 个人卡变为 `notPurchased` 后 `canDisconnectProvider` 由 false 变 true（`StatusCards.tsx:255/392/515`、`Detail.tsx:728`），"未开通"状态会暴露断连入口，需产品确认是否需要。
- `unavailableReason` 进入 `states`，而 `packages/provider/src/sources.ts:61` 的 revision = `hash([..., providers, states])`，纯展示原因变化也会推进 Account 快照 revision 并触发 registry 重同步，需确认是否可接受。
- `packages/provider/test/account-provider-resolution.test.ts` 未覆盖新增的 State 投影逻辑（reason 下发 / `unknown` 沿用 / 上一层无原因不误带）。

## 8. 实现状态与 e2e 缺口（2026-09-10）

**已实现**（分支 `fix/coding-plan-not-purchased-status`，基点 `origin/staging`）：

- `packages/provider`：`AccountProviderState` / `AccountProviderConnectionResult` 增加 `unavailableReason`，`unknown` 沿用上一轮；
- `packages/services`：`CodingPlanUnavailableReason` 导出并映射为账号域原因，随连接结果发布；
- `packages/shared`：新增 `isIndividualCodingPlanModelProviderId`；
- `packages/ui`：`resolveCodingPlanEntitlementState` 按 `unavailable + not-entitled → notPurchased`、`credential-failed → unavailable` 分流，仅个人版生效；
- 单测：UI 新增 7 组用例、services 新增 2 组用例，共 50 条通过（含既有的 Start/Team 语义防回归）。

**验证结果**：`pnpm lint` 0 error；`pnpm typecheck` 与改动前基线**错误集合完全一致**（91 条均为分支上既有的内建包 dist 声明过期问题，与本次改动无关）。

**e2e 未完成（不得谎报为已验证）**，原因是当前桌面 E2E 基础设施无法表达"已登录 + 无个人套餐"这一状态：

- upgrade mock 能提供该数据（`subscription/list` 为空 + quota 返回 `当前用户不存在coding plan`），但该 mock 场景下设置页**不渲染家族连接方式选择器**（实测 nav 只有 `preset:account:bigmodel-start-plan` 与两个 custom provider，`model-provider-connection-mode-trigger` 数量为 0），无法导航到个人套餐卡；
- team mock 只有 `personalOnly` / `teamOnly` / `both` 三种场景，均含套餐，无法表达"无套餐"；
- 相关既有 e2e 已因 provider-refactor 的 id 变化失效：`coding-plan-upgrade-personal-sold-out`（以及使用同一 `preset:builtin:bigmodel` 的用例）在本机实测失败于 `model-provider-nav-item-preset:builtin:bigmodel: missing`。

**落地建议**：给 team mock 增加 `personalNone` 场景（或让 upgrade mock 场景渲染家族根卡），再按 `provider-family-responsive.test.ts` 的 `visible()` 模式（导航存在隐藏副本，必须操作可见元素）补一条设置页用例；同时单独修复失效的 coding-plan e2e test id。
