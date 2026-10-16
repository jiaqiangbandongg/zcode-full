# Coding Plan 限时配额活动提示

日期：2026-06-12

## 背景

`GET https://zcode.z.ai/api/v1/client/configs?app_version=<ZCODE_VERSION>&platform=<platform>-<arch>` 可能返回 `data.configs.codingPlanBillingDiscount`。该字段用于控制 Coding Plan 的限时配额活动提示。

## 语义

- `codingPlanBillingDiscount` 字段不存在：前端不暴露任何活动 UI，不展示徽标或 banner。
- `codingPlanBillingDiscount` 字段存在：前端按当前 locale 读取字段内下发的文案展示活动提示。
- 当前字段不再作为纯活动开关使用；没有当前 locale 文案时不展示对应活动 UI。
- 新字段格式为 `{"zh-CN": {"cardTitle": "...", "cardBody": "...", "badgeBody": "..."}, "en-US": {...}}`；前端不硬编码兜底文案。
- 文案表达配额活动，不表达价格折扣，避免用户误解为支付金额折扣。

## 展示位置

- Context usage remaining 的标题显示“剩余额度”，标题旁复用同一短徽标。
- Context usage remaining 的短徽标使用 compact 尺寸和 badge 级 `text-ui-xs` 字号，保留默认渐变样式，避免在紧凑弹层标题里过大。
- Model Settings 的个人套餐和团队套餐 status card 标题旁展示短徽标；Start Plan status card 标题旁不展示短徽标。
- Coding Plan 套餐列表顶部展示活动 banner，banner 图标使用 `astroid`，标题字号使用 `text-base`。
- Coding Plan 套餐列表顶部活动 banner 最右侧通过 `CodingPlanBillingDiscountBadge` 展示短徽标和 `info` 图标，组件结构为 `<>徽标 div + info</>`；`info` 是普通图标触发器，不使用 Button 包装；点击 `info` 后复用现有 Dialog 展示 GLM-5.2 150% 额度权益折算规则说明；说明文案必须走 i18n，不能直接硬编码在组件中。
- banner 右侧短徽标在渐变 banner 内使用 `surface` 样式，即 `bg-white text-[#191A1D]`，避免默认渐变徽标和 banner 背景融合后不可见。
- `CodingPlanBillingDiscountBadge` 默认渲染 `<>徽标 div + info</>`，不再通过开关控制；嵌在按钮内部的场景使用纯徽标 `CodingPlanBillingDiscountBadgePill`，避免 Dialog 触发按钮嵌套在外层 Button 中。
- 说明 Dialog 正文使用现有 Markdown 渲染组件展示，文字使用 `text-foreground` 主文字色；标题用 markdown 二级标题 `##` 表达，折算规则用 markdown 列表表达，规则项文案保持活动原文。
- Start Plan 升级按钮内展示短徽标，活动态升级按钮右侧展示同一个 `info` 图标触发器，点击后复用说明 Dialog；聊天 context 面板内的 Start Plan 升级按钮、聊天区 Start Plan quota banner 的升级按钮也遵循同一规则。
- Start Plan 已有权益时，plan card 的升级按钮使用 `button-gradient dark:bg-[#484A58]` 背景。
- Start Plan 升级按钮内的短徽标使用 `bg-white text-[#191A1D] rounded-full`，不再使用徽标默认渐变背景。
- Start Plan 升级按钮内的短徽标不展示 `trending-up` 图标，只展示 `150% 配额` 文案。
- 聊天区 quota banner 的徽标嵌入升级按钮时使用 `pr-px`，让白色徽标贴近按钮右侧，仅保留 1px 的活动背景边界；Model Settings 保留自身卡片按钮间距。
- 聊天区 quota banner 的活动升级按钮不使用固定高度，由徽标和按钮内容自然撑开，避免活动文案与固定 `h-6` 产生拥挤或裁切。
- 所有活动短徽标统一使用 badge 级 `text-ui-xs` 字号并保持单行不换行；compact 只缩小间距和图标，不改变字号层级。
- Model Settings 的 provider 导航入口和 family header 不展示短徽标；只有 Coding Plan 权益/套餐语义明确的位置展示。
- Sidebar usage remaining 的 Coding Plan 标题旁不展示短徽标，避免用量菜单标题过载；输入框 context usage 弹层仍展示。
- Start Plan plan card/status card 标题旁不展示短徽标，即使已有 Start Plan 权益；Start Plan 活动提示只放在升级按钮和套餐列表中。

## 调用与缓存

- 服务层通过现有 `BigModelCodingPlanSubscriptionProvider.getClientConfigs()` 读取该字段。
- 该读取必须复用现有 `clientConfigSnapshot` / `clientConfigRequest`，避免 sidebar、context usage、设置页同屏重复请求。
- `clientConfigSnapshot` 和 UI 活动状态缓存 TTL 均为 1 小时；TTL 过期后下一次读取会重新请求 `/api/v1/client/configs`。
- UI 挂载后懒加载活动状态，不阻塞原有 usage remaining、Start Plan 和套餐列表渲染。

## 国际化与服务端文案

- 使用 `codingPlanBillingDiscount[locale].badgeBody` 展示短徽标文案，中文示例：`150% 配额`，英文示例：`150% Quota`。
- 使用 `codingPlanBillingDiscount[locale].cardTitle` 和 `cardBody` 展示套餐列表顶部 banner。
- banner 右侧说明 Dialog 使用本地 i18n 文案，弹窗宽度使用 `max-w-lg`，文案区域用 `div.p-3.!space-y-3` 包裹；标题为“权益规则说明：”；正文说明用户在 ZCode 中通过 Coding Plan 使用 GLM-5.2 模型时，额度消耗全周期按 0.67 系数折算；同样的模型调用量，在额度扣减侧仅按 67% 计算，等效来看，用户在活动周期内的可用额度约为原来的 1.5 倍；高峰期每日 14:00～18:00 由原先的 3x 调整为 2x 系数，非高峰期由原先的 1x 调整为 0.67x 系数；额度权益截止时间以官方公告为准。说明 Dialog 不展示额外寒暄或感谢文案。
- 服务端未下发当前 locale 或某个必需文案为空时，不展示对应活动 UI。
