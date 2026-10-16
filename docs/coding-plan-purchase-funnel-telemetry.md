# Coding Plan 购买漏斗埋点设计

> 当前入口归属以 [购买埋点](./coding-plan-purchase-telemetry.md) 的 2026-09-09 规则为准：
> App 显式入口点击上报一次；下文原生面板打开及 OAuth 恢复时上报的描述为历史语义。

日期：2026-06-29
状态：草案

## 1. 目标

补齐以下三个点击事件：

1. `coding_plan_upgrade_ck`：进入 Coding Plan 产品选择页。
2. `purchase_product_select_ck`：选择个人或团队产品。
3. `purchase_billing_cycle_select_ck`：确认购买周期/方式并进入支付确认页。

与已有事件组成完整客户端链路：

```text
coding_plan_upgrade_ck
-> purchase_product_select_ck
-> purchase_billing_cycle_select_ck
-> purchase_pay_ck
-> purchase_result
```

事件统一使用以下结构，`eventRegion` 按事件发生位置填写：

```json
{
  "eventType": "ck",
  "eventRegion": "app.purchase",
  "elementName": "事件名",
  "eventText": "用户实际点击的界面文本",
  "eventExtraDetail": {}
}
```

约束：

- `eventText` 是顶层字段，对应上报结果中的 `event_text`。
- `eventText` 使用用户点击时实际看到的本地化文本，如“升级”“订阅”“个人套餐”。
- `coding_plan_upgrade_ck` 发生在购买流程入口，`eventRegion` 使用用户点击入口时所在的
  `app.profile`、`app.session` 或 `app.setting`；具体入口由 `upgrade_source` 区分。
- 除 `coding_plan_upgrade_ck` 外，购买面板内的 `purchase_product_select_ck`、
  `purchase_billing_cycle_select_ck` 和已有 `purchase_pay_ck` 均发生在
  `app.purchase`，其 `eventRegion` 必须固定为 `app.purchase`。
- 业务维度放在 `eventExtraDetail`，不重复写点击文案。
- `eventExtraDetail` 的值全部为字符串；空值写 `""`。
- 使用标准拼写 `purchase_billing_cycle_select_ck`，不使用 `biling`。

## 2. 关联 ID

现有 `purchase_attempt_id` 在点击支付时才生成，无法关联前三个事件。

新增：

```text
purchase_funnel_id
```

规则：

- 能直接打开购买面板的入口点击时创建 pending UUID；购买面板确认打开后，
  该 UUID 才成为本次 `purchase_funnel_id`，并上报 `coding_plan_upgrade_ck`。
- 未连接时个人/团队入口当前只发起 OAuth，不会自动打开购买面板；该点击不创建
  `purchase_funnel_id`，也不上报 `coding_plan_upgrade_ck`。用户登录后再次打开购买面板时
  再开始新的 funnel。
- 已经先打开购买面板、再由面板内套餐选择触发 OAuth 的入口（包括闲时任务 Upgrade）在面板
  打开时开始 funnel。OAuth 登录期间必须保留原 `purchase_funnel_id`、`upgrade_source` 和
  入口套餐快照；登录成功后恢复套餐选择并继续原 funnel，禁止重新生成 ID 或把来源改写为登录入口。
- 三个新增事件及已有 `purchase_pay_ck`、`purchase_result` 使用同一个 ID。
- 用户进入 `app.purchase` 后，本次购买流程只生成一个 `purchase_funnel_id`。在流程内返回
  上一步、重新选择并再次进入后续页面时继续沿用，不得因子页面卸载或重新挂载而生成新 ID。
- 关闭购买面板后结束；再次打开生成新 ID。
- `purchase_attempt_id` 继续表示一次真实支付尝试，不改变现有含义。

支付成功页是购买流程终态，只提供“关闭/完成”，不提供“返回”。用户不能从成功页回到
此前购买步骤；关闭成功页后结束本次 funnel。

## 3. `coding_plan_upgrade_ck`

用户点击任何能够进入 Coding Plan 产品选择页的入口时上报。

```json
{
  "eventType": "ck",
  "eventRegion": "app.session",
  "elementName": "coding_plan_upgrade_ck",
  "eventText": "升级",
  "eventExtraDetail": {
    "purchase_funnel_id": "2a3f0a1e-1234-5678-9012-acde12345678",
    "upgrade_source": "session_token_usage",
    "entry_plan_status": "start_plan",
    "entry_plan_level": "start",
    "purchase_audience": "",
    "provider_family": "zai",
    "channel": "Z_AI"
  }
}
```

字段：

| 字段 | 含义 | 值 |
| --- | --- | --- |
| `eventText` | 实际点击文本 | `升级`、`订阅`、`个人套餐`、`团队套餐`，英文界面取对应英文 |
| `upgrade_source` | 点击位置 | 见下表 |
| `entry_plan_status` | 进入购买漏斗时的套餐状态 | `no_plan` / `start_plan` / `coding_plan` / `unknown` |
| `entry_plan_level` | 进入购买漏斗时的套餐级别 | 后端/权益快照原值；无法获取时为 `""` |
| `entry_plan_list` | 进入购买漏斗时用户已有的套餐列表 | `start_plan__{planId}`、`coding_plan__personal_{tier}`、`coding_plan__team_{tier}`，逗号拼接 |
| `purchase_audience` | 购买对象 | `personal` / `team`；尚未选择时为 `""` |
| `provider_family` | Provider | `bigmodel` / `zai` / `unknown` |
| `channel` | 渠道 | `MaaS` / `Z_AI` / `""` |

入口枚举：

| `eventRegion` | `upgrade_source` | 位置 | 当前代码 |
| --- | --- | --- | --- |
| `app.profile` | `profile_menu` | 用户头像菜单 Upgrade | `WorkspaceSidebar.tsx`、`SettingsPage.tsx` |
| `app.session` | `session_quota_alert` | Session 配额提醒中的 Upgrade | `ChatView.tsx` |
| `app.session` | `session_token_usage` | 输入框 Token 用量区域 Upgrade | `ChatInputToolbar.tsx` |
| `app.session` | `session_idle_time` | New task 首页与 Automations 闲时任务资格提示中的 Upgrade | `OffPeakNewTaskEntry.tsx`、`AutomationsSection.tsx` |
| `app.setting` | `setting_plan_card` | 模型设置页 Coding Plan Upgrade/Subscribe | `StatusCards.tsx` |
| `app.setting` | `setting_start_plan_card` | 模型设置页当前链接方式为 Start Plan 的 Upgrade/Subscribe | `StatusCards.tsx` |
| `app.setting` | `setting_personal_plan_banner` | 模型设置页个人套餐入口 | `Detail.tsx` |
| `app.setting` | `setting_team_plan_banner` | 模型设置页团队套餐入口 | `Detail.tsx` |

V4 conversation 使用同一事件契约，但入口由 V4 session quota banner 承载。banner 必须真实可见，
并保留 dismiss、提交阻断和 entitlement refresh；只有购买面板确认打开后才开始 funnel。Web/手机
可以展示权威 quota 状态，但旧桌面口径的网络上报只允许 `desktop-continuous` reporter 执行。

场景由事实字段组合表达，不单独上报推断型场景字段：

| 场景 | 字段组合 |
| --- | --- |
| Start Plan 升级 | `entry_plan_status=start_plan` |
| 首次购买 Coding Plan | `entry_plan_status=no_plan` |
| 已有 Coding Plan 升级 | `entry_plan_status=coding_plan`，并携带 `entry_plan_level` |

代码取值：

- 新增纯函数 `resolveCodingPlanEntryPlanState(...)`，统一输出
  `entryPlanStatus` 和 `entryPlanLevel`；所有入口复用，禁止组件各写一套判断。
- Settings：输入已有 `displayStatus`、`providerId` 和 `planLevel`。Start provider
  可能承载付费 Coding Plan 权益，不能只根据 providerId 判断；`purchased` 状态下应先判断
  `planLevel` 是否是真实 Start Plan，非 Start 权益归为 `coding_plan`。
- Session/Token：入口代码已有 Start Plan providerId 和 entitlement snapshot，直接写
  `start_plan`。
- 用户头像菜单：复用已经加载的 entitlement snapshot；`unavailableReason=no_plan`
  写 `no_plan`，存在 quota/subscription/remaining 时写 `coding_plan`。
- 闲时任务：复用已经加载完成的 provider registry。存在未被系统判定失效的 Coding Plan
  provider 时写 `coding_plan`；仅存在 Start Plan 时写 `start_plan/start`；registry 已加载且
  两类套餐都不存在时写 `no_plan`；加载中或无法可靠判断时写 `unknown/""`。不得因
  selected-connection 门禁失败直接推断用户没有套餐。
- 缺少可靠快照时写 `unknown`/`""`，不根据按钮文案猜测。
- 不新增接口请求；状态在现有 render/state 派生阶段计算，点击时直接读取。

触发规则：

- 只在用户点击后购买面板实际打开时上报。
- 未连接时只触发 OAuth 的个人/团队入口不报；继续使用现有登录事件。
- disabled、自动打开、关闭购买面板不报。
- Settings 的个人/团队入口分别填写 `purchase_audience`。
- 闲时任务入口默认打开个人套餐页，`coding_plan_upgrade_ck.purchase_audience=personal`；
  用户后续改选团队套餐时，下游产品/周期/支付事件按实际选择写 `team`。

## 4. `purchase_product_select_ck`

用户在产品选择页点击可用产品卡片，并进入周期选择页时上报。

```json
{
  "eventType": "ck",
  "eventRegion": "app.purchase",
  "elementName": "purchase_product_select_ck",
  "eventText": "选择套餐",
  "eventExtraDetail": {
    "purchase_funnel_id": "2a3f0a1e-1234-5678-9012-acde12345678",
    "upgrade_source": "setting_plan_card",
    "entry_plan_status": "no_plan",
    "entry_plan_level": "",
    "purchase_audience": "personal",
    "provider_family": "bigmodel",
    "channel": "MaaS",
    "product_group_id": "glm-coding-pro",
    "product_id": "",
    "product_name": "GLM Coding Pro",
    "plan_tier": "pro"
  }
}
```

字段：

| 字段 | 含义 | 值 |
| --- | --- | --- |
| `eventText` | 产品卡片实际按钮文本 | `选择套餐` / `订阅` / `升级`，英文界面取对应英文 |
| `purchase_audience` | 产品类型 | `personal` / `team` |
| `provider_family` | Provider | `bigmodel` / `zai` / `unknown` |
| `channel` | 渠道 | `MaaS` / `Z_AI` / `""` |
| `product_group_id` | 产品组稳定 key | 代码中的 plan group key |
| `product_id` | 具体 SKU | 本阶段还未选周期，写 `""` |
| `product_name` | 产品名 | 如 `GLM Coding Pro` |
| `plan_tier` | 套餐档位 | `lite` / `pro` / `max` / `team_standard` / `team_advanced` / `unknown` |

触发规则：

- 个人产品在 `PlanChoiceCard` 点击后上报。
- 团队产品在 `TeamPlanChoiceCard` 点击后上报。
- 当前套餐、免费 Start Plan、disabled 产品不报。
- 不使用产品组中的第一个 SKU 伪造 `product_id`。

## 5. `purchase_billing_cycle_select_ck`

用户确认最终周期/购买方式，并从配置页进入支付确认页时上报。

### 个人示例

```json
{
  "eventType": "ck",
  "eventRegion": "app.purchase",
  "elementName": "purchase_billing_cycle_select_ck",
  "eventText": "订阅",
  "eventExtraDetail": {
    "purchase_funnel_id": "2a3f0a1e-1234-5678-9012-acde12345678",
    "upgrade_source": "session_quota_alert",
    "entry_plan_status": "start_plan",
    "entry_plan_level": "start",
    "purchase_audience": "personal",
    "provider_family": "zai",
    "channel": "Z_AI",
    "product_id": "product-af5f6f",
    "product_name": "GLM Coding Lite / 月",
    "plan_tier": "lite",
    "billing_period": "month",
    "purchase_method": "continuous",
    "payment_method": "",
    "seat_count": "",
    "duration_months": "",
    "currency": "USD",
    "amount": "16.20"
  }
}
```

### 团队示例

```json
{
  "eventType": "ck",
  "eventRegion": "app.purchase",
  "elementName": "purchase_billing_cycle_select_ck",
  "eventText": "继续支付",
  "eventExtraDetail": {
    "purchase_funnel_id": "2a3f0a1e-1234-5678-9012-acde12345678",
    "upgrade_source": "setting_team_plan_banner",
    "entry_plan_status": "no_plan",
    "entry_plan_level": "",
    "purchase_audience": "team",
    "provider_family": "bigmodel",
    "channel": "MaaS",
    "product_id": "<team productId from API>",
    "product_name": "GLM Coding Plan 团队标准版",
    "plan_tier": "team_standard",
    "billing_period": "month",
    "purchase_method": "one_time",
    "payment_method": "alipay",
    "seat_count": "5",
    "duration_months": "12",
    "currency": "CNY",
    "amount": "12916.80"
  }
}
```

字段：

| 字段 | 含义 | 值 |
| --- | --- | --- |
| `eventText` | 实际点击文本 | 个人为 `订阅` / `升级`；团队为 `继续支付`；英文界面取对应英文 |
| `product_id` | 最终 SKU | 直接使用当前选中商品的 `selectedProduct.productId` |
| `product_name` | 产品及周期名 | 与支付事件保持一致 |
| `plan_tier` | 套餐档位 | 与产品选择事件一致 |
| `billing_period` | 周期 | `month` / `quarter` / `year` / `unknown` |
| `purchase_method` | 购买方式 | `continuous` / `one_time` / `unknown` |
| `payment_method` | 支付方式 | `alipay` / `paypal` / `stripe` / `unknown` / `""` |
| `seat_count` | 团队席位 | 个人为 `""` |
| `duration_months` | 一次性采购时长 | 非一次性采购为 `""` |
| `currency` | 币种 | `CNY` / `USD` / 后端值 / `""` |
| `amount` | 当前展示金额 | 纯数字字符串 |

触发规则：

- 个人：点击月/季/年卡片并进入支付确认页时上报。
- 团队：点击“继续支付”时上报最终产品、周期、席位和时长。
- `product_id` 必须取商品接口返回值，禁止按 provider、套餐和周期自行拼接。
- 团队只切换配置但未继续时不报。
- Z.ai 在本阶段尚未选择 PayPal/Stripe 时，`payment_method=""`。

## 6. 渠道差异

| Provider | `provider_family` | `channel` | 产品 | 支付 |
| --- | --- | --- | --- | --- |
| BigModel | `bigmodel` | `MaaS` | 个人和团队 | 当前为支付宝 |
| Z.ai | `zai` | `Z_AI` | 当前仅个人 | PayPal/Stripe 在支付确认阶段确定 |

映射只根据 `providerId`，不根据语言、币种或域名猜测。

## 7. 代码实现

### 7.1 支持 `eventText`

当前客户端没有传递 `eventText`，需要修改：

- `packages/shared/src/telemetry.ts`：`TelemetryEventPayload` 增加 `eventText?: string`。
- `packages/shared/src/validation.ts`：IPC schema 增加 `eventText: z.string().optional()`。
- `packages/ui/src/lib/appTelemetry.ts`：payload 支持 `eventText`。
- `packages/desktop/src/preload/index.ts`：bridge 类型支持 `eventText`。
- `packages/services/src/telemetry/telemetryCore.ts`：
  `reportEvent` 和 `sendReport` 透传，并在请求体写入
  `event_text: payload.eventText ?? ""`。

现有事件不传该字段时保持 `event_text=""`，兼容旧调用。

### 7.2 新增漏斗模块

新建：

```text
packages/ui/src/lib/codingPlanFunnelTelemetry.ts
```

统一负责：

- 三个新增事件的 payload。
- `purchase_funnel_id`。
- `resolveCodingPlanEntryPlanState(...)` 套餐状态纯函数。
- Provider/channel、套餐、周期和购买方式归一化。
- 字段字符串化。
- 调用 `reportAppTelemetryEvent`；失败不阻断 UI。

### 7.3 入口接线

| 场景 | 代码 |
| --- | --- |
| 左下角头像菜单 | `WorkspaceSidebar.tsx`、`SettingsPage.tsx` |
| Session 配额提醒 | `ChatView.tsx` |
| Token 用量 Upgrade | `ChatInputToolbar.tsx` |
| Settings Upgrade/Subscribe/个人/团队入口 | `StatusCards.tsx`、`CodingPlanStatusActions.tsx`、`Detail.tsx` |
| 产品和周期选择 | 官网 webview 页（原 `CodingPlanPurchasePanel.tsx` 已于 2026-09 删除，App 侧不再有产品和周期选择的原生交互） |

跨页面跳转需要扩展 `packages/ui/src/lib/settingsNavigation.ts`，携带：

```ts
{
  purchaseFunnelId: string;
  upgradeSource: CodingPlanUpgradeSource;
  entryPlanStatus: "no_plan" | "start_plan" | "coding_plan" | "unknown";
  entryPlanLevel: string;
}
```

该 intent 只服务“点击后直接打开购买面板”的跨页面入口。购买面板消费 intent 并确认
`open=true` 后上报 `coding_plan_upgrade_ck`；OAuth-only 入口不写入该 intent。

### 7.4 贯通已有支付事件

> 2026-09 起本节为历史方案：`codingPlanPurchaseTelemetry.ts` 已随原生购买面板删除，
> `purchase_pay_ck` / `purchase_result` 改由官网 webview 侧上报，字段约定仍适用。

修改 `codingPlanPurchaseTelemetry.ts`。`purchase_pay_ck` 和
`purchase_result` 必须同时增加并复用同一个 `purchase_funnel_id`：

```json
{
  "purchase_pay_ck": {
    "purchase_funnel_id": "2a3f0a1e-1234-5678-9012-acde12345678",
    "upgrade_source": "session_idle_time",
    "purchase_attempt_id": "payment-attempt-uuid",
    "entry_plan_status": "no_plan",
    "entry_plan_level": ""
  },
  "purchase_result": {
    "purchase_funnel_id": "2a3f0a1e-1234-5678-9012-acde12345678",
    "upgrade_source": "session_idle_time",
    "purchase_attempt_id": "payment-attempt-uuid",
    "entry_plan_status": "no_plan",
    "entry_plan_level": ""
  }
}
```

硬约束：

- 两个事件的 `purchase_funnel_id` 必须来自当前购买面板的 funnel context，结果事件不得重新生成。
- 两个事件的 `upgrade_source` 必须来自同一 funnel context，支付阶段和结果阶段不得丢失或重写。
- 两个事件继续复用同一次支付的 `purchase_attempt_id`。
- 两个事件复用进入漏斗时已经记录的 `entry_plan_status` 和
  `entry_plan_level`，支付阶段不得重新查询或重新判断。
- `purchase_funnel_id` 串联从升级入口到支付结果的完整流程；
  `purchase_attempt_id` 只串联一次支付点击及其结果。
- 现有支付状态、商品和错误字段不变。

### 7.5 闲时任务入口与登录连续性

New task 首页和 Automations 闲时任务资格提示统一创建：

```json
{
  "eventRegion": "app.session",
  "elementName": "coding_plan_upgrade_ck",
  "eventText": "升级",
  "eventExtraDetail": {
    "upgrade_source": "session_idle_time",
    "purchase_audience": "personal"
  }
}
```

英文界面 `eventText` 使用用户实际看到的 `Upgrade`。Provider、渠道、入口套餐状态和
`purchase_funnel_id` 继续由 `codingPlanFunnelTelemetry` 的统一逻辑填充。

```text
闲时 Upgrade 点击
  -> 创建一次 funnel context
  -> 全局 CodingPlanUpgradeDialog target 持有 context
  -> 购买面板打开并上报 coding_plan_upgrade_ck
  -> 未登录用户选择套餐
  -> OAuth / WelcomeScreen
  -> callback 只刷新购买凭据，target/context 不变
  -> 恢复原套餐选择
  -> product -> cycle -> pay -> result 继续复用同一 context
  -> 用户关闭购买面板后结束 funnel
```

登录成功、用户状态刷新和购买 token 刷新都只能更新鉴权/商品状态，不得替换 dialog target。
`purchase_product_select_ck`、`purchase_billing_cycle_select_ck`、`purchase_pay_ck` 和
`purchase_result` 必须从该 target 中继续读取原 `purchase_funnel_id` 与
`upgrade_source=session_idle_time`。

## 8. 验证

自动测试：

- 三个事件的名称、`eventText` 和字段枚举。
- 未连接 OAuth-only 点击不生成 funnel，也不报 `coding_plan_upgrade_ck`。
- 购买面板实际打开后才上报一次 `coding_plan_upgrade_ck`。
- `coding_plan_upgrade_ck` 使用实际入口区域；`purchase_product_select_ck`、
  `purchase_billing_cycle_select_ck`、`purchase_pay_ck` 的 `eventRegion` 均为
  `app.purchase`。
- Start provider 承载付费 Coding Plan 权益时归为 `coding_plan`，不误报
  `start_plan`。
- BigModel -> `bigmodel/MaaS`。
- Z.ai -> `zai/Z_AI`。
- 产品组阶段 `product_id=""`。
- 团队只在“继续支付”时上报最终配置。
- 三个新增事件、`purchase_pay_ck`、`purchase_result` 五个事件复用同一个
  `purchase_funnel_id`。
- 闲时任务两个 Upgrade 入口均固定上报
  `eventRegion=app.session`、`upgrade_source=session_idle_time`，并使用本地化
  `eventText`。
- 闲时任务入口的 provider registry 套餐判定覆盖
  `coding_plan` / `start_plan` / `no_plan` / `unknown`，不把 selected-connection
  失败误报为 `no_plan`。
- OAuth 登录前后的 dialog target 保留同一个 funnel context；登录成功后恢复套餐选择时，
  `purchase_funnel_id` 和 `upgrade_source` 不变。
- 在 `app.purchase` 内返回上一步并重新进入后续页面时，继续复用原
  `purchase_funnel_id`，不生成新 ID。
- `purchase_pay_ck` 和对应 `purchase_result` 同时复用
  `purchase_funnel_id` 与 `purchase_attempt_id`，结果事件不生成新 ID。
- 支付成功页不展示返回入口，只允许关闭或完成；关闭后结束本次 funnel。
- 上报失败不影响跳转和支付。

执行：

```bash
pnpm --filter @zcode/ui test
pnpm typecheck
pnpm lint
```

运行时核对一次 Desktop 上报请求，确认 `event_text`、事件顺序和两个关联 ID。
