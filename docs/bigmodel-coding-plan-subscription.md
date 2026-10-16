# BigModel Coding Plan 订阅购买接入

日期：2026-05-28

## 范围

BigModel / Z.AI Coding Plan 设置页套餐列表由远端 `GET https://zcode.z.ai/api/v1/client/configs` 返回的 `codingPlanStaticProducts` 驱动。远端配置保存套餐身份、名称、描述、周期、权益、币种和静态价格快照；真实价格、当前周期、是否可购买、售罄和禁用状态仍以运行时 `POST /pay/batch-preview` 为准。

`batch-preview` 失败、未登录或没有返回某个静态 `productId` 时，列表仍展示静态套餐信息和静态价格快照；未拿到真实预览状态时点击订阅会先走登录/连接流程，不推断真实可购状态。

Z.AI Coding Plan 复用同一组 `/api/biz` 业务接口协议，host 切换到 `https://api.z.ai`。

## 套餐配置

套餐配置按 provider 分组，由服务层 `codingPlanSubscriptionService.getStaticProducts()` 从 ZCode client config 拉取，前端只做一天内存缓存、Start 免费 SKU 合并和 `batch-preview` 实时状态合并，不在本地写死 Lite / Pro / Max 描述：

- `productId`：后端商品 ID，用于和 `batch-preview`、`preview`、购买接口对齐。
- `productName`：套餐名称，用于 Lite / Pro / Max 分组和卡片标题。
- `productSmallTitle`：套餐副标题。
- `equity`：套餐权益摘要数组，每个元素为 `{ text, tooltip? }`，展示为一行带星星图标的权益。
- `description`：套餐权益文案数组，每个元素为 `{ text, tooltip? }`，对应分割线下方的一行说明；消费端继续兼容历史字符串。
- `productEquityList`：兼容历史商品配置的可选权益结构；新配置不再要求下发。
- `priceUnit`：计费周期，`month` / `quarter` / `year`。
- `displayOrder`：静态排序字段，保留与 `/product/info` 对齐。
- `priceCurrency`：币种，BigModel 为 `CNY`，Z.AI 为 `USD`。
- `originalAmount`：静态原始金额快照，来自 `batch-preview`。
- `discountAmount`：静态优惠后金额/折扣相关金额快照，保留接口原始语义。
- `payAmount`：静态应付金额快照，仅作展示参考。
- `monthlyOriginalAmount`：静态月均原始金额快照。
- `monthlyRenewAmount`：静态月均续费金额快照。
- `monthlyPayAmount`：静态月均应付金额快照，用于季/年套餐月均展示参考。
- `renewAmount`：静态续费金额快照。

### 当前套餐选择卡片的数据适配

`codingPlanStaticProducts` 应优先适配当前套餐选择卡片的既有信息层级，不新增仅供新布局使用的字段：

- 保持 `builtin:bigmodel-coding-plan` 与 `builtin:zai-coding-plan` 两个 provider 分组。
- 保持每个 Lite / Pro / Max 套餐按 `month` / `quarter` / `year` 提供独立 `productId`。
- 套餐名称继续使用 `productName`，周期使用 `priceUnit`，币种和静态价格继续使用现有价格字段。
- 星星图标旁的权益写入 `equity: Array<{ text: string; tooltip?: string }>`，个人套餐可以是一行，团队套餐可以是两行；分割线下方的普通说明写入同结构的 `description`。需要解释时下发 `tooltip`，否则省略该字段。新配置不重复下发 `productEquityList`；字符串数组、字符串 `description` 和 `productEquityList` 仍可由消费端兼容读取。
- 文案与静态价格采用相同的数据源原则：缺少 `equity`、`description` 或 Start Plan 文案时保持为空，不回退前端硬编码文案。
- BigModel 使用中文权益文案，Z.AI 使用英文权益文案；不同周期的同档套餐复用相同权益文案。
- 个人套餐 `description` 保持迁移前的完整卡片说明：Lite 三行、Pro 四行、Max 三行；迁移远端商品身份与价格时不得用远端简化描述覆盖这组卡片文案。
- 不通过配置改变卡片布局、信息顺序或交互。

可发布的完整响应示例见
[`packages/desktop/test/e2e/fixtures/coding-plan-client-configs.json`](../packages/desktop/test/e2e/fixtures/coding-plan-client-configs.json)。

配置字段有意对齐 `/product/info` 的展示字段，同时价格字段只采用 `batch-preview` 同名字段快照，不采用 `salePrice` / `originalPrice` 等商品详情价格，避免把商品详情接口的非实时金额当作真实应付价格。

### Start Plan 配置

Start Plan 不是可支付 SKU，继续使用独立的 `configs.startPlanPreview`，不放入
`codingPlanStaticProducts` 或 `codingPlanStaticTeamProducts`。当前协议为
provider-neutral，BigModel 与 Z.AI 共用同一份免费额度定义：

- `planId`：Start Plan 身份。
- `name`：远端套餐名称。
- `entitlements`：按模型描述免费额度，包含 `grantUnits`、`meter`、`period`、
  `showName` 和 `unitType`。

卡片的额度汇总和明细由 `entitlements` 计算，BigModel 使用中文格式，Z.AI 使用
英文格式，避免在配置中重复保存可由结构化额度推导出的 `equity` 与
`description`。缺少 `startPlanPreview` 时不展示 Start Plan。

### 团队套餐配置

团队套餐的静态卡片数据放在
`configs.codingPlanStaticTeamProducts`，并与个人套餐一样按 provider 分组：

- `builtin:bigmodel-coding-plan`：BigModel 团队套餐数组。
- `builtin:zai-coding-plan`：Z.AI 团队套餐数组；当前没有 Z.AI 团队套餐，显式下发空数组。

每个团队套餐保留企业 pricing 返回的 `productId`、`tier`、`subscribeMode`、
`subscribePeriod`、购买方式和静态价格，并补充当前套餐选择卡片需要的展示字段：

- `productName`：中文展示名称，`PRO` 为“标准版”，`MAX` 为“高级版”。
- `equity`：带星星图标的额度权益对象数组；团队卡片当前为两行，分别展示 5 小时与每周额度。
- `description`：分割线下方的普通权益对象数组。

团队静态配置作为配置服务发布和客户端静态卡片接入的数据源；当前企业商品运行时
仍由 pricing 接口驱动。客户端接入静态回退后，商品可购状态、订阅状态和实时价格仍以
`/campaign/partner/enterprise/pricing` 或
`/subscription/enterprise/v2/pricing` 为准，不由静态快照推断。

### 测试环境

本地开发需要验证测试数据时，使用 `ZCODE_ENV=test` 启动应用。客户端将请求
`https://zcode.z.ai/api/v1/client/configs`，并自动附加 `app_version` 与
`platform` 参数。本地不再提供独立的 client-config mock 命令或专用环境变量。

## 接口链路

- BigModel API 主域名跟随环境：生产为 `https://bigmodel.cn`，`ZCODE_ENV=test` 为 `https://bigmodel.cn`。
- `POST /api/biz/pay/batch-preview`：读取当前账号可见套餐价格与可购状态。
- `GET /api/biz/product/info?productId=...`：仅用于维护静态目录时人工拉取商品展示字段，运行时套餐列表不再依赖它。
- `POST /api/biz/pay/preview`：点击套餐后试算并获取 `bizId`。
- `POST /api/biz/pay/create-sign`：首次购买或 renew 重新购买。
- `POST /api/biz/pay/product/update/sign`：已有订阅时变更套餐。
- `GET /api/biz/pay/check?bizId=...`：支付后轮询结果。
- `GET /api/biz/pay/check-pending-orders`：购买前检查未完成订单。

Z.AI 使用同样 path：

- `POST https://api.z.ai/api/biz/pay/batch-preview`
- `GET https://api.z.ai/api/biz/product/info?productId=...`
- `POST https://api.z.ai/api/biz/pay/preview`
- `POST https://api.z.ai/api/biz/pay/create-sign`
- `POST https://api.z.ai/api/biz/pay/product/update/sign`
- `GET https://api.z.ai/api/biz/pay/check?bizId=...`
- `GET https://api.z.ai/api/biz/pay/check-pending-orders`

## 鉴权

订阅购买接口使用对应品牌的 OAuth 登录态。

BigModel：

```http
Authorization: <oauth accessToken>
Content-Type: application/json
```

不要添加 `Bearer` 前缀。`Bearer` 只用于模型/API Key 类接口，不适用于 BigModel `/pay` 和 `/api/biz` 登录态业务接口。

Z.AI：

```http
Authorization: <zai business accessToken>
Content-Type: application/json
```

Z.AI 登录成功后会先用 OAuth access token 调用 `POST https://api.z.ai/api/auth/z/login` 换取业务 token，并将该业务 token 直接持久化到 `oauth:zai:access_token`。后续 `/api/biz/*` 与 `/api/pay/*` 链路只读取这一个持久化业务 token，不再使用单独缓存 key，也不再兜底使用原始 OAuth token。Z.AI monitor 用量接口仍继续使用 provider API key 的 `authorization` header，两条链路不要混用。

## UI 行为

- 头像菜单的“升级”入口优先跟随当前选中的 Coding Plan 或当前用量来源；当 API Key 模式下没有 Coding Plan 权益可供推导时，必须按 `providerFamilyDomain` 回退：BigModel 域展示 BigModel 套餐，Z.AI 域展示 Z.AI 套餐，禁止跨品牌回退。
- 未连接 BigModel：展示连接入口。
- 已连接且加载中：展示静态套餐列表和加载态。
- `batch-preview` 加载失败：不额外展示“连接后查看套餐”提示卡，保留静态套餐列表和静态价格快照；点击订阅进入登录/连接流程。
- `batch-preview` 没有返回某个静态 `productId`：该套餐可展示静态价格快照；点击订阅进入登录/连接流程。
- 静态目录为空：展示空态。
- 点击购买时先调用 `preview`；如果后端返回安全验证要求，由官方版本的安全校验完成验证后自动重试同一次 `preview`。
- `preview`、订单试算或支付相关接口返回 HTML/WAF 页面、非 JSON 或无法解析响应时，UI 不展示原始响应内容，统一提示“系统繁忙，请稍后再试。”。
- `create-sign` / `update-sign` 返回支付宝 `sign` 后，UI 将完整 `sign` 转成二维码并轮询 `pay/check`。
- 支付成功后刷新 Coding Plan 权益和模型供应商配置。
- Z.AI 未登录或接口不可用：保留静态套餐列表，可展示静态价格快照；点击订阅进入登录流程。
- Z.AI `batch-preview` 成功：静态套餐列表合并接口返回的真实价格和按钮状态，并使用接口购买链路。

## 购买埋点

个人版 Coding Plan 支付链路上报 `purchase_pay_ck` 和 `purchase_result`。`product_name` 统一使用「套餐名 / 计费周期」格式，例如英文界面为 `GLM Coding Lite / month`、中文界面为 `GLM Coding Lite / 月`；BigModel 和 Z.AI 使用同一套展示规则。套餐名优先来自单品 `preview`，缺失时回退到静态商品配置合并后的 `productName`，避免 `/pay/batch-preview` 未返回 `productName` 时埋点退化成 `productId`。`billing_period` 仍保持机器可分析枚举 `month` / `quarter` / `year`。金额埋点不再上报模糊的 `amount`，而是冻结单品 `preview` 返回的 `cashAmount` / `giveAmount` / `thirdPartyAmount` / `refundAmount` / `residualAmount`；缺失字段保持空字符串，不用其他金额反推。

## Z.AI 海外支付确认页

Z.AI 海外 Coding Plan 使用单页确认式收银台，不再把 PayPal、Stripe 支付动作直接挂在支付方式按钮上。

- 顶部展示 `Payment` 试算区，金额来自同一次 `preview`：实付金额优先使用 `thirdPartyAmount`，活动优惠来自 `campaignDiscountDetails`，现有套餐剩余价值优先使用 `refundAmount` / `residualAmount`，缺失时按“原价 - 活动优惠 - 实付金额”兜底。
- `Payment Method` 只负责选择支付方式：PayPal 或 Credit Card / Debit Card。
- Stripe 卡片列表由 `/stripe/query` 读取。主确认页只展示当前选中卡片和 `Add card` / `Change card` 入口。
- `Add card` / `Change card` 打开卡片管理弹窗。弹窗内可以选择已有卡、删除卡、使用 Stripe Elements 新增卡；新增卡只调用 `/stripe/bind` 绑卡，不立即扣款。
- 用户勾选 recurring charge 授权后点击 `Confirm` 才执行支付：PayPal 分支执行 setup/subscribe，Stripe 分支使用选中的 `paymentMethodId` 调用 `/stripe/pay`。
- Stripe publishable key 优先读取 `VITE_ZAI_STRIPE_PUBLISHABLE_KEY`，未配置时回退到 Z.AI 官方 payment 页公开使用的 publishable key，保证默认构建可以展示 Stripe Elements。
- Stripe.js 必须跟随海外支付状态按需初始化。应用启动、套餐页常驻渲染以及 `overseasPaymentDialog=null` 时不得加载 Stripe.js，也不得创建 `js.stripe.com` / `m.stripe.network` iframe；只有用户进入 Z.AI 海外支付、创建 `overseasPaymentDialog` 后才允许初始化 Stripe，以免 Electron 在未支付时额外创建跨域 renderer 进程。
- 卡号、有效期和 CVC 对应的 Stripe Elements 仅在 `Add card` / `Change card` 卡片管理弹窗打开时挂载。关闭支付流程后卸载应用侧支付组件；Stripe.js 已创建的风控 iframe 是否继续驻留由 Stripe SDK 管理，不把主动销毁第三方全局状态作为支付流程职责。
