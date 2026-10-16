# Coding Plan 购买/升级页面交互

日期：2026-06-14

## 背景

Family provider 详情页已经把 Z.ai / BigModel 收敛为用户可见的 provider family，内部仍按 API Key / Start Plan / Coding Plan provider id 解析运行时目标。购买或升级 Coding Plan 时，用户需要保持在当前 family provider 上下文内完成操作，不应跳转到独立设置页或外部页面后丢失 provider 上下文。

购买/升级入口统一来自 family provider 的 Plan Card：

```text
┌──────────────────────────────────────────────────────────────┐
│ Pro                                      Coding Plan   [on]  │
│ Renews Jun 30, 2026 · Manage · Upgrade                      │
│                                                              │
│ 5h usage             1w usage             Total tokens        │
│ 12.4k / 50k          83k / 500k           1.28M               │
└──────────────────────────────────────────────────────────────┘
```

点击 `Buy plan` / `Upgrade` / `Change plan` 后进入购买页面。购买页面仍由当前 family provider 详情页触发和关闭，但视觉上不再是居中弹窗；它以覆盖当前设置内容的 page surface 承载完整 Pricing / Plan / Payment 状态机，不展示步骤条。

## 目标

- 购买/升级流程保留在当前 provider family 详情页上下文中，不跳转外部页面，也不丢失当前 provider family。
- 购买页面不展示 `Step 1/4` 这类步骤文案，用户只看到当前页标题、返回和关闭。
- 购买页面 header 不吸顶，随页面内容自然滚动，且不额外设置顶部外边距；返回/关闭图标按钮使用 `size-8` 和 `rounded-xl`；底部不设置固定 footer，页面动作放在内容区。
- 流程拆成五个状态：选 Plan、选周期、确认支付、支付、支付成功。
- `Personal` 与 `Team` 在选 Plan 页直接上下铺开，不再使用 tabs；个人与团队仍进入各自独立的后续购买路径。
- 支付成功与权益同步成功是两个状态，成功页必须能表达“支付已成功，但权益仍在同步”。
- 团队套餐支付成功页必须提示成员分配：标题为“团队套餐需要分配成员”，正文为“请先在 BigModel 团队套餐管理页添加自己或其他成员，完成后即可在 ZCode 使用团队额度。”提示卡片提供“管理团队套餐”入口，跳转 BigModel 团队套餐管理页。
- 用户点击关闭即退出购买流程；成功页关闭后还要触发权益刷新。

## 非目标

- 不新增 provider id。运行时身份仍使用现有 `builtin:zai-start-plan` / `builtin:zai-coding-plan` / `builtin:bigmodel-start-plan` / `builtin:bigmodel-coding-plan`。
- 不把团队套餐强行接入个人支付链路。团队未来可能涉及席位、组织、发票和企业支付，应独立建模。
- 不在 family provider 导航、header 或无明确套餐语义的位置新增促销徽标。
- 不改变现有 BigModel 支付宝、Z.ai Stripe / PayPal 的后端接口协议。Z.ai Coding Plan 产品流程不再展示 PayPal 支付入口；为保持旧版本协议兼容，本次不删除已有 PayPal 能力。

## 状态机

```text
purchasePanel.closed
  -> purchasePanel.planSelect
  -> purchasePanel.billingCycleSelect
  -> purchasePanel.paymentConfirm
  -> purchasePanel.payment
  -> purchasePanel.success
  -> purchasePanel.closed
```

返回和关闭规则：

- `planSelect`：只有关闭，关闭即退出购买流程。
- `billingCycleSelect`：返回到 `planSelect`，关闭即退出购买流程。
- `paymentConfirm`：返回到 `billingCycleSelect`，关闭即退出购买流程。
- `payment`：返回到 `paymentConfirm` 并取消当前支付状态，关闭即退出购买流程。
- `success`：不提供返回，只提供关闭；关闭后退出流程并刷新权益。

关闭弹出面板不应修改当前已保存的 provider family mode。用户已在面板内选择但尚未支付的 plan / 周期只保存在面板局部状态中。

## 入口文案

Plan Card 根据当前权益状态展示不同主操作：

- 无付费权益：`Buy plan`
- Start Plan：`Upgrade`
- 已有付费权益且存在更高档套餐：`Upgrade`
- 已有付费权益但主要操作是换套餐或换周期：`Change plan`

当前套餐状态显示在套餐卡片内容内部，不只依赖按钮文案表达；如果当前套餐内仍有更高周期可买，卡片继续允许进入周期页。已订阅用户不能从 Plan 页进入低等级或同等级无更高周期的套餐。

Family provider 详情页里的套餐入口 banner 按 provider 区分：BigModel 未连接或无权益时可以展示 Start/个人/团队入口，帮助用户选择国内个人或团队购买路径；Z.ai 未连接或已连接但无权益时展示 Start（仅远端 preview 存在时）和个人套餐入口，但不展示团队套餐入口。Z.ai 没有团队购买入口。

## 页面框架

购买流程使用页面级覆盖层，而不是居中 dialog 或右侧 sheet。该覆盖层由当前 provider 详情页入口控制 `open` 状态；关闭后回到原详情页位置。这样可以把购买体验变成 page，同时保留 family provider 里的授权、当前套餐和权益刷新上下文。页面通用结构：

```text
┌──────────────────────────────────────────────────────────────┐
│ ← Back              Pricing / Page title                 ×   │
├──────────────────────────────────────────────────────────────┤
│ Page content                                                 │
│ Page actions live inside the content area                    │
└──────────────────────────────────────────────────────────────┘
```

首屏 `planSelect` 不展示返回按钮，也不展示额外 Pricing 说明或 More Info 外链。成功页不展示返回按钮。

实现尺寸约束：

- 桌面和宽屏 Web 使用整页覆盖层，根容器使用 `bg-background` 与 `pt-12`，根容器本身不滚动；根容器内部使用独立滚动包裹承载 header 和内容区，内容区使用 `max-w-5xl` 并居中。
- 移动端使用同一页面覆盖层，Plan 卡片和周期卡片单列展示，header 同样不吸顶。
- 不再用固定 `48rem x 32rem` 外框限制 planSelect；选择 Plan、个人选择周期、个人确认支付按内容自然高度展示，不强制撑满页面；支付、团队配置和成功等需要沉浸或 sticky 动作的状态仍可占用剩余高度；团队配置 sticky 底部操作区背景使用 `bg-background`，顶部边框只切换颜色、不增减边框盒模型，避免连续订阅和单次采购来回切换时页面抖动。团队配置的服务方式标题行需要保留自动续费授权文案占位，切到单次采购时只隐藏文案，不改变标题行高度。

## 页面 1：选择 Plan

选 Plan 页不展示额外 Pricing 说明与 More Info 外链。页面内容直接按活动 banner、`For Individuals`、Start Plan 卡片、个人套餐列表、`For Teams`、团队套餐列表的顺序铺开，不再展示 audience tabs；团队套餐进入团队/企业页，不复用个人周期和支付页。section 标题使用比卡片标题更大的字号，形成页面级分组。
首屏只承担选择动作，不放解释性标题和长说明；套餐卡片按固定信息层级展示：Plan name、当前套餐状态、起始价格、带 150% 活动 banner 图标的用量额度、分割线、关键权益列表、底部满宽圆角按钮。Plan name 使用普通正文大小并保持 medium 权重，价格使用更大的字号作为视觉重点；中文价格只放大金额本体，例如 `¥49.00`，金额在 light 使用黑色、dark 使用白色，`人民币 起` 保持正常字号并使用低一档文字色。套餐卡片本身不展示选中态，也不响应整卡点击，只有底部按钮进入下一页；当前套餐状态用卡片内胶囊标识，不只放在按钮里；如果当前 plan 仍有更高周期可买，按钮继续作为升级入口，否则禁用。选 Plan 卡片使用产品营销文案，不直接复用支付接口的权益字段；接口权益和价格仍以周期页、支付页和后端 preview 为准。BigModel 个人套餐卡片内容固定显示中文，以匹配国内购买场景；Z.ai 个人套餐卡片内容固定显示英文，以匹配海外购买场景。Start Plan 是否展示由远端 `startPlanPreview` 决定：preview 存在时展示，preview 关闭或缺失时隐藏；Start Plan 的标题优先使用远端 `name`。BigModel 星星图标旁的汇总额度和权益列表数值均来自远端 `entitlements`，前端只固定中文格式：汇总展示为 `GLM 模型每日 500万 tokens`，权益列表展示为 `GLM-5.2 每日 300万 tokens` 和 `GLM-5-Turbo 每日 200万 tokens`；远端字段缺失时才回退到本地 provider 文案。Z.ai Start Plan 卡片也由远端 `entitlements` 生成汇总额度和权益列表，前端只固定英文格式：汇总展示为 `5M GLM tokens daily`，权益列表展示为 `GLM-5.2 · 3M tokens daily` 和 `GLM-5-Turbo · 2M tokens daily`；远端字段缺失时本地 provider 文案也使用同一组英文 fallback。当前 Start 权益有效时标记当前，用户已登录但无有效 Start 权益时只在状态胶囊和按钮标记已过期，星星图标旁不展示状态说明，过期态不降低整张卡片透明度，避免权益列表变成 disabled 文案。BigModel 和 Z.ai 使用独立文案来源，不能把 BigModel 的支付宝/协议说明和 Z.ai 的 PayPal/Stripe/海外订阅说明共用。

150% 配额活动的 Info 弹窗由远端 `codingPlanBillingDiscount` 当前语言节点提供
`infoTitle` 和 `infoBody`；`infoBody` 使用 Markdown。前端不保留本地权益规则正文，
任一字段缺失时不展示 Info 入口，避免展示过期或不完整的活动规则。

Plan Select 中只有 `unavailable` 状态调整展示语义：按钮文案统一显示“立即订阅”但保持
禁用，hover 或键盘 focus 时显示“当前套餐不可购买，查看详情”；“查看详情”必须是
可操作链接，Tooltip 与按钮间距为 `4px`。Z.ai 打开 `https://z.ai/subscribe`，BigModel 打开
`https://bigmodel.cn/glm-coding`。disabled 按钮由可聚焦包裹层承接 Tooltip 事件；当前套餐、
已包含、已售罄和订阅服务繁忙等其他禁用状态的文案与行为保持不变。个人套餐和团队套餐
共用这套 unavailable 展示规则。
宽屏下 Plan 卡片区域在页面内容区内横向铺开，Start Plan 作为个人区域第一张卡展示，个人区域响应式列数按宽到窄为 `4 -> 2 -> 1`：`xs` 以下单列，`xs`（480px）起双列，`md` 起四列。断点提前切换列数，不额外限制卡片宽度，让卡片继续自然填满当前内容区。付费套餐卡高度一致，但不强制撑满页面剩余高度；Start Plan 是免费体验档，只展示权益和当前/已有状态，不进入个人付费周期与支付链路。团队套餐可用时按远端返回数量展示，团队区域宽屏固定使用 4 列栅格；如果只有 2 个团队套餐，只显示前两列卡片，后两列保持为空。团队套餐卡片不展示 hover 或 selected 视觉状态，点击后直接进入团队配置页。窄屏继续按内容自然高度滚动。Plan 卡片使用 `bg-card`，从页面底色中分离出来。

```text
┌──────────────────────────────────────────────────────────────┐
│ Pricing                                                  ×   │
├──────────────────────────────────────────────────────────────┤
│ 150% quota banner                                         │
│ For Individuals                                           │
│ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌────────┐│
│ │ Start Plan   │ │ Lite         │ │ Pro          │ │ Max    ││
│ │ $0           │ │ $20+         │ │ $100+        │ │ $200+  ││
│ │ Included     │ │ Choose       │ │ Current      │ │ Choose ││
│ └──────────────┘ └──────────────┘ └──────────────┘ └────────┘│
│                                                              │
│ For Teams                                                   │
│ ┌──────────────┐  ┌──────────────┐                         │
│ │ Team Pro     │  │ Team Max     │                         │
│ └──────────────┘  └──────────────┘                         │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

Plan 卡片只比较能力和权益，不在这一页让用户选择月 / 季 / 年。价格可展示弱提示；中文视觉拆分为大字号金额 + 正常字号币种和 `起`，英文使用 `{price}+`，例如 `CN¥49.00+`，整段保持大字号并在 light 使用黑色、dark 使用白色；真实支付金额以周期页和支付页为准。

Plan 卡片文案：

| Plan | 中文短定位               | 中文关键权益                                                                            |
| ---- | ------------------------ | --------------------------------------------------------------------------------------- |
| Lite | 基础用量额度             | 适合小型 Repo 轻量级迭代；逐步开放最新旗舰模型及功能；支持多款编程工具                  |
| Pro  | 5x Lite 额度 + Lite 权益 | 适合中型 Repo 日常开发；优先体验最新旗舰模型及功能；覆盖多款精选 MCP 工具；更快生成速度 |
| Max  | 20x Lite 额度 + Pro 权益 | 适合高阶用户中大型 Repo 深度开发；首发接入最新旗舰模型及功能；高峰期专属资源优先保障    |

| Plan | English summary     | English key benefits                                                 |
| ---- | ------------------- | -------------------------------------------------------------------- |
| Lite | Base usage included | Small repo iteration; Latest models over time; 20+ coding tools      |
| Pro  | 5x Lite usage       | Mid-sized repo development; Priority model access; Curated MCP tools |
| Max  | 20x Lite usage      | Mid-to-large repo work; First model access; Peak-time priority       |

### Team section

```text
┌──────────────────────────────────────────────────────────────┐
│ Upgrade Coding Plan                                      ×   │
├──────────────────────────────────────────────────────────────┤
│ For Individuals                                           │
│ Individual plan cards...                                  │
│                                                              │
│ For Teams                                                   │
│                                                              │
│ ┌──────────────┐  ┌──────────────┐                         │
│ │ Team Pro     │  │ Team Max     │                         │
│ │ seat price   │  │ seat price   │                         │
│ │ benefits...  │  │ benefits...  │                         │
│ │ Select       │  │ Select       │                         │
│ └──────────────┘  └──────────────┘                         │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

Team section 的核心约束是直接展示团队套餐入口；团队区域宽屏固定使用 4 列栅格，有几个团队套餐就渲染几张卡，少于 4 个时后续列位自然留空。团队套餐当前只服务 BigModel 国内购买场景，选 Plan 页团队卡片的套餐名与描述固定展示中文，不随应用 locale 切到英文；后续团队配置、确认和支付页仍保留各自金额格式与流程文案规则。点击团队套餐后仍进入团队独立配置、确认和支付链路，不复用个人周期与支付模型。

## 页面 2：选择周期

选择周期页只处理已选个人 plan 的计费周期，不额外展示“当前套餐/新套餐”摘要行。个人周期卡片列表按内容自然高度展示，卡片保持等高但不强制占满页面剩余高度；窄屏继续按内容自然高度滚动。周期卡片使用 `bg-card`，周期标题使用正常字号 medium。中文实付价格保留两位小数和币种名，币种名与周期单位紧密相连，例如 `¥538.00 人民币/月`；金额本体使用大字号，在 light 使用黑色、dark 使用白色，`人民币/月` 保持正常字号并使用低一档文字色；英文实付价格整段保持大字号黑/白。原价、价格单位、第二行辅助说明使用低一档文字色；月付第二行显示“按月灵活订阅”，季付/年付第二行显示折合月价。周期卡片本身不展示选中态，也不触发购买，右侧胶囊按钮才是动作入口；如果当前登录态或购买 token 已失效，则点击按钮后进入连接/登录恢复流程，不先进入支付页。已订阅用户不能向下购买：低于当前套餐等级，或同等级但周期不高于当前周期的商品，按钮展示已有权益/当前套餐，不允许点击。

```text
┌──────────────────────────────────────────────────────────────┐
│ ← Back                         Pro Plan                  ×   │
│ Choose billing cycle                                         │
│                                                              │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ Monthly                                                  │ │
│ │ $20                                                      │ │
│ │ Flexible monthly billing                                │ │
│ │                                            Subscribe      │ │
│ └──────────────────────────────────────────────────────────┘ │
│                                                              │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ Quarterly                                                │ │
│ │ ¥132.30 人民币  ~~¥147.00 人民币~~ /季                  │ │
│ │ 折合 ¥44.10 人民币/月                                  │ │
│ │                                             Upgrade       │ │
│ └──────────────────────────────────────────────────────────┘ │
│                                                              │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ Yearly                                                   │ │
│ │ $180 / year                                              │ │
│ │                                            Current        │ │
│ └──────────────────────────────────────────────────────────┘ │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

生效时间、剩余价值抵扣、续费金额等只展示后端 preview 能确认的内容。后端未返回明确语义时，不写“立即生效”或“下周期生效”。

## 页面 3：确认支付

确认支付页负责调用 `preview({ productId, ... })` 取得支付金额明细，展示 provider 对应的续费/账号/协议确认信息，但不生成二维码、不创建 Stripe/PayPal 支付动作。个人确认支付页按内容自然高度展示，不强制撑满页面。preview 加载中或金额明细不可用时，只展示加载/不可用提示，不展示续费政策、账号规范、协议确认和继续支付按钮。用户勾选同意并点击确认后才进入支付页。确认页不再额外展示 Plan / Billing cycle 摘要，金额明细用独立卡片展示，至少包含套餐原价、活动折扣、当前套餐抵扣和实付金额；后端未返回的折扣或抵扣行不展示。活动折扣与当前套餐抵扣默认收起到一行 `抵扣费用` / `Deductions`，收起态右侧展示总抵扣金额，点击后展开逐条展示多个优惠活动和当前套餐剩余价值。BigModel 个人确认支付页固定使用中文页面标题、金额标签、周期、续费政策、账号规范和协议确认文案，以匹配国内支付宝签约场景；Z.ai 继续使用 `overseasPayment.*` 文案，不能共用条款、扣费渠道和账号规范说明。用户需要返回上一页才能修改周期，返回两次才能修改 plan。

BigModel 续费政策按当前选中周期动态展示金额周期，但“本次实付金额”和“未来续费金额”必须分开处理。金额明细卡里的实付金额来自 preview 的本次结算结果，可受首购优惠、活动折扣、当前套餐抵扣、赠金、余额和第三方支付拆分影响；续费政策里的自动扣费金额只能使用后端明确返回的续费金额语义，例如 `renewAmount`。如果后端没有明确续费金额，不展示固定扣费金额，改为提示后续按所选周期自动续费，实际扣费以续费时账单为准。

- 有明确续费金额：`续订将按照「￥{renewAmount}/{月|季|年}」发起自动扣费。`
- 无明确续费金额：`后续将按所选套餐周期自动续费，实际扣费以续费时账单为准。`
- `扣费优先级：优先扣除赠金，再扣余额，再采用支付宝扣费。`
- `{每月|每季|每年}将持续定期扣款，直至您根据我们的服务条款取消服务。`
- `您可在续费日前至少3天，前往「个人套餐概览页」关闭自动续费。`

BigModel 账号使用规范展示为可展开模块，默认收起并露出总则文案，展开后按小标题展示限制、风控和退款说明：

- 总则：`仅限订阅人在官方许可的产品范围内使用。严禁将账号出借、转让或以任何形式提供给第三方使用，亦不得用于非正当或违反法律法规及平台规则的行为。如发现平台将限制或封禁账号，且不予退款。`
- 专享限制：`套餐仅限订阅人个人在 Coding 工具中使用。若发现账号出现多人使用等异常情形，用于非编程开发、非正当的或违反法律法规及平台规则的用途，将限制账号权益。`
- 风控处置：`违反《用户协议》、《服务协议》、《订阅服务协议》及平台上其他相关规则及约定的，将触发限流或冻结。累计 3 次违规将被永久封禁。`
- 退款说明：`因违规使用导致账号被封禁的，已支付的套餐费用一律不予退款。`

金额下方信息按 provider 区分：

- BigModel：展示旧版支付宝支付弹窗里的中文续费说明、账号使用规范提示块，以及底部《服务协议》《订阅及自动续费协议》同意确认；退款相关说明只出现在账号使用规范展开内容里，底部协议勾选区不重复展示退款文案。
- Z.ai：展示固定英文的 Renewal Policy、Account Usage Policy，以及银行卡/订阅授权条款勾选确认；即使应用 locale 为中文，Z.ai 确认支付和海外支付条款也保持英文。

Z.ai Renewal Policy 同样不能把本次 Amount due 当作未来 recurring charge。只有 `renewAmount` 明确存在时才展示固定续费金额；否则使用不承诺具体金额的 fallback 文案。

- 有明确续费金额：`{renewAmount} will be charged automatically per {month|quarter|year}.`
- 无明确续费金额：`Future renewals will follow your selected subscription cycle. The actual renewal amount is subject to your renewal invoice.`
- `Payments will be deducted first from bonus credits, then from your account balance, and finally via credit card.`
- `Please note that a small minimum applies when charging your credit card. If the remaining amount is less, we will round up the deduction to meet this minimum.`
- `{Monthly|Quarterly|Yearly} charges will continue on a recurring basis until you cancel in accordance with our Terms of Service.`
- `You may disable auto-renewal at least 1 day before the renewal date in your subscription setting.`

Z.ai Account Usage Policy 文案：

- `The GLM Coding Plan is strictly limited to use by the subscriber within officially supported products. Any sharing, resale, transfer, or third-party access is strictly prohibited. Any improper, unauthorized, or policy-violating use may result in immediate account restriction or suspension with no refunds. Please comply with our Terms and Policy.`

Z.ai 银行卡/订阅授权勾选文案：

- `You agree that Z.ai will charge your card the above amount now and on a recurring basis according to your subscription plan until you cancel in accordance with our [terms](https://docs.z.ai/legal-agreement/subscription-terms).`

支付页必须继承确认支付页这一次 `preview`，不再重新拉取金额明细，但支付页不展示金额明细卡。支付页只把 preview 的实付金额用于支付控件文案，并继续调用后续支付接口：BigModel 根据同一个 `bizId` 生成二维码签约内容；Z.ai 根据同一个 `bizId` 展示并提交 Stripe 银行卡支付表单。

```text
┌──────────────────────────────────────────────────────────────┐
│ ← Back                         Confirm payment           ×   │
├──────────────────────────────────────────────────────────────┤
│ Confirm purchase                                             │
│                                                              │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ Plan price                   US$54.00                    │ │
│ │ Deductions >                 -US$14.80                   │ │
│ │ Amount due                   US$39.20                    │ │
│ └──────────────────────────────────────────────────────────┘ │
│                                                              │
│ Renewal policy / 续费说明                                    │
│ • Uses provider-specific legacy payment policy copy.         │
│ • BigModel shows Alipay renewal/account/agreement details.   │
│ • Z.ai shows Renewal policy/account policy/card auth terms.  │
│                                                              │
│ ☑ Provider-specific agreement / authorization confirmation.  │
│                                                              │
│                                           Continue to payment│
└──────────────────────────────────────────────────────────────┘
```

## 页面 4：支付

支付页负责展示真实支付渠道，不再允许修改 plan 或周期。BigModel 支付宝二维码与 Z.ai 海外支付主收银台都必须直接嵌入当前购买面板内容区，不使用额外外层卡片/边框包裹，也不能再额外打开主支付弹窗；只有信用卡新增/管理这类支付方式子流程允许继续使用独立弹窗。

```text
┌──────────────────────────────────────────────────────────────┐
│ ← Back                         Payment                   ×   │
├──────────────────────────────────────────────────────────────┤
│ Payment method                                               │
│                                                              │
│ ● Credit Card                                                │
│   Visa ending in 4242                         Change         │
│                                                              │
│ ☑ I authorize recurring billing.                             │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

Z.ai 海外支付继续使用确认式收银台，但支付方式入口只展示 Credit Card / Debit Card（Stripe），不展示 PayPal。本次只下线界面入口，现有 PayPal service、deep-link 回调和协议定义保持不变。真正扣款发生在用户点击 `Pay` / `Confirm` 后。Z.ai 支付页的 `Payment method` 标题、错误提示和银行卡支付内容直接放在支付页内容区，不使用额外 section/card 容器包裹。Z.ai 支付页和添加信用卡子流程的主按钮需要与购买面板其它流程一致，使用 `h-10`、`rounded-full`、`text-ui-base`；已保存卡片和添加信用卡表单使用 `rounded-xl`，添加信用卡弹窗 header 不使用分割线。

当 Plan 首页的套餐 preview 返回系统繁忙时，保留页面上的系统繁忙提示，但 Plan Card 主按钮继续显示“升级” / `Upgrade`，且允许点击。点击后不能直接使用失败的 preview 进入周期页，而是复用原有未登录升级链路重新登录；登录成功后只重开个人套餐 Plan 首页，不恢复登录前点击的具体 plan，由用户基于刷新后的套餐状态重新选择。

### BigModel 支付宝支付

BigModel 支付宝二维码仍属于支付页的一种支付状态。宽屏下使用左右结构且不使用外层卡片包裹：二维码与右侧文案作为一组在弹窗剩余空间中居中；左侧二维码用 `rounded-xl` 容器独立包裹，最大约 `24rem`，二维码在容器内撑满，容器高度跟随二维码图片；右侧占据剩余宽度，展示订阅计划标题、支付宝扫码金额和等待确认状态；内容需要撑满支付页剩余高度，避免弹窗出现滚动条。窄屏下右侧说明先展示，二维码排在说明后面。

```text
┌──────────────────────────────────────────────────────────────┐
│ ← Back                         Payment                   ×   │
├──────────────────────────────────────────────────────────────┤
│ ┌────────────────────────────┐  GLM Coding Pro 连续包月计划 │
│ │                            │                              │
│ │          QR Code           │  [Alipay] 请使用支付宝扫码支付│
│ │                            │            ¥1,412.44 人民币  │
│ │                            │                              │
│ └────────────────────────────┘  正在等待支付确认             │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

二维码过期时仍停留在支付页，展示刷新二维码操作，不退回周期页。

## 页面 5：支付成功

支付成功必须进入独立成功页，不能只用 toast。成功页用于确认购买结果，并承接权益刷新延迟。

```text
┌──────────────────────────────────────────────────────────────┐
│ Payment successful                                       ×   │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│ Payment successful                                           │
│                                                              │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ Current                      Pro                         │ │
│ │ Status                       Active                      │ │
│ └──────────────────────────────────────────────────────────┘ │
│                                                              │
│                                                    Done      │
└──────────────────────────────────────────────────────────────┘
```

成功页关闭 / Done 后：

1. 关闭购买面板。
2. 触发 Coding Plan entitlement refresh。
3. 刷新 provider registry / 当前 family provider Plan Card。

### 支付成功但权益同步中

支付成功和权益同步成功必须分离。支付 check 已确认成功，但 entitlement refresh 尚未完成或失败时，仍展示支付成功页：

```text
┌──────────────────────────────────────────────────────────────┐
│ Payment successful                                       ×   │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│ Payment successful                                           │
│                                                              │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ Payment                     Successful                   │ │
│ │ Plan status                  Syncing                     │ │
│ └──────────────────────────────────────────────────────────┘ │
│                                                              │
│                                      Refresh now     Done    │
└──────────────────────────────────────────────────────────────┘
```

成功页不使用额外容器包裹“支付成功”标题，不展示“关闭面板后刷新权益”类说明文案。宽屏下成功页内容在弹窗内容区垂直居中，两侧使用更大的水平内边距，“支付成功”标题区和下方状态内容拉开距离。权益刷新失败时，禁止把支付状态改成失败。UI 只提示 plan status 尚未刷新，并允许用户手动 `Refresh now` 或 `Done`；`Done` 和右上角关闭行为一致。

## 鉴权与恢复

购买流程中遇到 OAuth required 或业务 token 过期时，面板不应直接变成错误页。当前页切换为连接态：

```text
Connect Z.ai to continue
```

未登录用户在 Plan Select 点击个人或团队套餐时，购买面板必须先记录由本次点击发起的
登录 attempt，再关闭购买面板并进入统一登录页。登录页不能覆盖一个仍处于 open 状态的
购买面板。

```text
Plan Select (unauthenticated)
  -> record { loginAttemptId, provider, audience }
  -> close Coding Plan purchase panel
  -> open WelcomeScreen / OAuth
  -> OAuth succeeded for the same loginAttemptId
  -> consume pending intent once
  -> reopen Coding Plan purchase panel at Plan Select
```

只有同一次套餐点击产生的 login attempt 成功时才自动重开。登录取消、失败或被另一条登录
attempt 替换时必须丢弃 pending intent；普通登录成功不能打开购买面板。重开后停留在
Plan Select，并恢复个人/团队 audience，但不自动进入周期或支付页，避免 OAuth 返回后在
用户未确认最新价格时继续购买。

已经进入周期页或支付页后遇到业务 token 过期的重新授权，仍保留当前页局部选择；该恢复
不适用 Plan Select 的“关闭后重开”规则。

如果用户关闭面板，恢复状态丢弃。

## 响应式约束

- 桌面端：优先使用宽 dialog 或右侧 sheet，内容区允许滚动，不使用固定 footer。
- 手机 Web：使用全屏 sheet，Plan 卡片改为单列，周期卡片单列，支付摘要和支付方式上下排列。
- 所有按钮和标题必须预留国际化文本长度，不能依赖英文短文案。
- 主题颜色使用现有语义 token，符合 `DESIGN.md`；不要为购买流程引入大面积品牌色背景。

## 后续实现提示

- 面板状态建议命名为 `planSelect` / `billingCycleSelect` / `payment` / `success`，不要把 UI 状态命名成 `step1` / `step2`。
- 个人购买流可以独立命名为 `personalPlanPurchaseFlow`，避免未来团队支付被迫复用个人假设。
- 后端 preview 返回前不要承诺真实应付金额、优惠、抵扣或生效时间。
- 支付成功页的权益刷新失败需要打 UI 日志，日志应通过 `packages/ui/src/logger.ts` 输出。
