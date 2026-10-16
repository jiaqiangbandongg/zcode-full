# Coding Plan 购买埋点

日期：2026-06-25

## 目标

Coding Plan 购买主链路补充两个最小埋点：

- `purchase_pay_ck`：用户确认继续支付，并进入当前购买尝试的支付提交链路。
- `purchase_result`：同一次购买尝试成功、失败、取消或超时。

两个事件必须复用同一个 `purchase_attempt_id`。该 ID 在点击继续支付时生成，并保存在当前购买 hook 的本次尝试上下文中；结果上报不得重新生成。

## WebView 迁移后的上报链路

2026-09-09：入口点击由 App 的 `CodingPlanUpgradeDialogProvider.openCodingPlanUpgrade`
统一上报 `coding_plan_upgrade_ck`，复用现有平台 telemetry 出口。此前 WebView 迁移删除了
原生面板中的调用，造成 App 入口事件缺失；不能把页面加载当作入口点击。

```text
用户点击入口 -> App 上报 coding_plan_upgrade_ck（不等待网络）
             -> 打开 WebView，注入同一个 purchase_funnel_id 和 entry_plan_list
             -> 官网仅上报 purchase_*，沿用入口上下文
刷新 / 重渲染 / 登录恢复 -> 不经过入口回调 -> 不新增入口事件
```

每次显式入口调用上报一次；同次点击不另建漏斗 ID，不在 effect 中上报。没有
funnelContext 的内部调用不伪造来源。网络失败沿用 helper 的 warn 和吞错语义，不阻塞
打开弹窗，也不让官网补报。Desktop 通过 IPlatformService 上报；Web/手机沿用平台
适配器的现有能力，不新增 main/host 或 realtime 状态。

官网当前分支的 `0f20939` 已删除入口上报，必须先发布该官网版本，再发布本 App
改动；旧官网仍会上报入口，混用会重复计数。未升级的旧 App 与新官网组合在迁移窗口
可能缺少入口事件，需在发布记录中标注。官网同时保留 `entry_plan_list` 到产品、周期、
支付和结果事件。App 通过 `__zcodeReportContext__` 注入，不依赖 URL query。

MR !2508 兼容修复：有 funnelContext 的 App 购买上下文必须同时注入
`purchase_entry_reporter: "app"`，通过现有 window、localStorage 与 bridge 同步路径传递，
刷新和登录恢复时保留。没有 funnelContext 时不声明 App 已接管入口，避免抑制官网的旧入口。
兼容官网读取该标记后跳过自身入口上报；不识别标记的旧官网仍须升级或热修，单独注入
标记不能消除该组合的重复计数。本次不引入新的远程开关或改变平台上报能力。
回归覆盖：上下文构建有/无漏斗、注入脚本实际执行后的三个读取出口，以及 CPUW-01
首次打开和刷新后标记均为 app、App 入口仍只上报一次。

本轮验证：37 个相关单测、CPUW-01 / CPUW-03 桌面 E2E、全量 typecheck、desktop
typecheck:e2e、architecture 检查通过；lint 为 0 errors、46 个存量 warnings。
E2E 运行 ID：`desktop-e2e-20260909110500640-p67041-68bb882e397264f5`。
官网生产去重、Windows/Linux、手机实机未验证。

验收：一次点击产生一个 App 入口事件，字段与 WebView 上下文一致；刷新不新增；
第二次点击再次上报；异常不阻塞打开；重渲染和恢复不重复上报。

## 上报出口

> 2026-09 死代码清理：App 原生面板（`CodingPlanPurchasePanel` 及
> `packages/ui/src/lib/codingPlanPurchaseTelemetry.ts`）已整体删除，App 侧不再有
> `purchase_pay_ck` / `purchase_result` 的原生上报方，购买过程埋点完全由官网
> webview 页面上报（依赖 App 注入的 `__zcodeReportContext__` 漏斗上下文）。

App 原生面板时期主链路复用 UI 侧
`reportAppTelemetryEvent(platform, payload, "codingPlanPurchaseTelemetry")`，由 desktop main
转交 `appTelemetryCore.reportEvent(...)`。WebView 迁移后，官网通过
`ReportService.report(...)` 直连同一事件网关。现有主出口当前为：

```text
https://zcode.z.ai/api/v1/event/report
```

历史需求文案里出现过 `/evnet/report` 拼写。上线前需要和服务端确认最终网关路径；在服务端明确切换前，客户端继续复用现有 `event/report` 能力，避免为单个业务埋点绕开统一 telemetry 出口。

Web fallback 当前是 no-op，Desktop 会自动补齐 `device_mid`、`app_version`、系统、屏幕、语言和时区。UI helper 只构造业务字段，且吞掉上报异常，不阻塞支付流程。

## 事件字段

`eventExtraDetail` 的值必须全部转成字符串，空值写空字符串，不传 `undefined` / `null`。

公共字段：

| 字段 | 说明 |
| --- | --- |
| `purchase_funnel_id` | 同一次入口到购买流程复用的漏斗 ID，优先使用 App WebView 注入值 |
| `entry_plan_list` | 进入购买流程时用户已有的套餐列表；使用动态 key，逗号拼接 |
| `purchase_attempt_id` | 同一次点击与结果共用的 UUID |
| `purchase_audience` | `personal` / `team` |
| `provider_family` | `bigmodel` / `zai` / `unknown` |
| `channel` | BigModel 默认 `MaaS`，Z.ai 默认 `Z_AI` |
| `product_id` | 当前商品 ID |
| `product_name` | 商品展示名或后端名 |
| `plan_tier` | `lite` / `pro` / `max` / `team_standard` / `team_advanced` / 原始值 |
| `billing_period` | `month` / `quarter` / `year` / `unknown` |
| `purchase_method` | `continuous` / `one_time` / `unknown` |
| `payment_method` | 最终提交支付使用的方式：`alipay` / `paypal` / `stripe` / `unknown` |
| `seat_count` | 团队席位数；个人为空 |
| `duration_months` | 团队一次性采购时长；个人和连续订阅为空 |
| `currency` | 后端或商品币种 |
| `cashAmount` | 个人套餐取单品 preview `cashAmount`；团队套餐取试算 `balanceDeductAmount` |
| `giveAmount` | 个人套餐取单品 preview `giveAmount`；团队套餐取试算 `giveDeductAmount` |
| `thirdPartyAmount` | 个人套餐取单品 preview `thirdPartyAmount`；团队套餐取试算 `thirdPayAmount` |
| `refundAmount` | 个人套餐取单品 preview `refundAmount`；团队套餐无对应字段时为空 |
| `residualAmount` | 个人套餐取单品 preview `residualAmount`；团队套餐无对应字段时为空 |
| `totalOriginalAmount` | 团队试算返回的订单原价；个人套餐为空 |
| `campaignDiscountAmount` | 团队试算返回的活动优惠金额；个人套餐为空 |
| `totalPayAmount` | 团队试算返回的优惠后应付总额；个人套餐为空 |

不再上报语义模糊的 `amount`。金额字段保留后端返回的组成语义，不使用
`payAmount` 冒充 `thirdPartyAmount`，也不在客户端反推缺失的金额。数值统一转换为两位
小数字符串，明确的零值写 `"0.00"`，接口未返回的字段写空字符串。

### 金额快照时序

```text
个人 pay/preview / 团队 order/calculate
  -> 冻结本次购买的 Amount 快照
  -> purchase_pay_ck
  -> 提交支付并轮询终态
  -> purchase_result 复用同一份 Amount 快照
```

团队支付成功的 order status 响应不含金额。因此团队链路必须在 `order/calculate`
成功后冻结 `totalOriginalAmount` / `campaignDiscountAmount` / `totalPayAmount` /
`giveDeductAmount` / `balanceDeductAmount` / `thirdPayAmount`，不能在支付成功后重算。

结果字段：

| 字段 | 说明 |
| --- | --- |
| `failure_stage` | 失败阶段；成功为空 |
| `error_code` | 稳定错误码；成功为空 |
| `error_message` | 归一后的短错误文案，禁止上传 HTML、schema、token、银行卡等敏感内容 |
| `order_status` | 后端支付状态原文；成功归一为 `SUCCESS`，超时为 `TIMEOUT` |
| `biz_id` | 个人支付检查 ID |
| `order_no` | 团队订单号 |
| `elapsed_ms` | 从点击继续支付到结果上报的耗时 |

## 结果映射

`purchase_result` 不单独增加 `result` 字段，通过 `order_status` + `error_code` 表达：

| error_code | failure_stage | order_status | 链路 | 说明 |
| --- | --- | --- | --- | --- |
| 空字符串 | 空字符串 | `SUCCESS` | 个人 / 团队 | 支付成功 |
| `create_sign_failed` | `create_sign` | `FAIL` | 个人 BigModel | 首购签约失败 |
| `update_sign_failed` | `update_sign` | `FAIL` | 个人 BigModel | 变更套餐签约失败 |
| `paypal_setup_failed` | `paypal_setup` | `FAIL` | 个人 Z.ai | PayPal setup 失败 |
| `paypal_subscribe_failed` | `paypal_subscribe` | `FAIL` | 个人 Z.ai | PayPal subscribe 失败 |
| `stripe_pay_failed` | `stripe_pay` | `FAIL` | 个人 Z.ai | Stripe 支付失败 |
| `create_order_failed` | `create_order` | `FAIL` | 团队 | 创建订单失败 |
| `continue_order_payment_failed` | `continue_order_payment` | `FAIL` | 团队 | 继续支付待支付订单失败 |
| `payment_status_failed` | `terminal_status` | `FAIL` | 个人 / 团队 | 后端失败终态 |
| `payment_status_closed` | `terminal_status` | `CLOSED` | 团队 | 后端关闭终态 |
| `payment_status_cancelled` | `terminal_status` | `CANCELLED` | 个人 / 团队 | 取消终态 |
| `payment_check_timeout` | `timeout` | `TIMEOUT` | 个人 / 团队 | 轮询超时 |
| `user_cancelled` | `user_cancel` | `CANCELLED` | 个人 / 团队 | 用户主动关闭或返回导致本次支付尝试终止 |
| `unknown_error` | `unknown` | `FAIL` | 个人 / 团队 | 未归类异常 |

购买安全校验属于 `pay/preview` 前置校验。当前实现只有 preview 成功并进入支付提交链路时才生成 `purchase_attempt_id` 和上报 `purchase_pay_ck`；因此用户取消安全校验不会上报 `purchase_result`。

## 验证要求

- 点击继续支付只上报一次 `purchase_pay_ck`。
- 同一次购买的点击和结果 `purchase_attempt_id` 一致。
- 用户取消、关闭支付弹窗、支付失败、轮询超时均上报 `purchase_result`。
- `purchase_pay_ck` 和对应的 `purchase_result` 必须带相同 `payment_method`。
- `purchase_pay_ck` 和对应的 `purchase_result` 必须带相同的 Amount 快照。
- `eventExtraDetail` 不得再包含 `amount`。
- 金额缺失与明确为零必须分别上报为空字符串和 `"0.00"`。
- 成功链路 `error_code`、`failure_stage`、`error_message` 为空字符串。
- 团队订单 `order_no` 有值，个人链路 `biz_id` 有值，互不混用。
- 上报失败只记录 warn，不影响 UI 和支付状态。

## 2026-09-09 验证记录

- 32 个相关单测通过，覆盖入口字段、重渲染不重复、再次点击、上报异常不阻塞。
- `coding-plan-upgrade-webview-refresh-provider.test.ts` 的 BigModel / Z.ai 两例通过。
  在 App `net.fetch` 边界捕获请求，校验入口一次、同漏斗上下文、刷新不新增；网关响应为 mock，
  不等同于生产网关收包成功。报告运行 ID：`desktop-e2e-20260909-083415-672`。
- CUA 在开发版点击 Start Plan 升级，官网购买页正常打开。
- `pnpm typecheck`、desktop `typecheck:e2e`、架构检查通过；lint 0 errors、46 个存量 warnings。
- 未发布官网/App；生产双端联合收包、手机 Web 实机和 Windows/Linux 实机待发布前回归。

## 全连接套餐快照修复

`entry_plan_list` 表示当前用户已拥有的所有套餐连接，不表示点击卡片。统一购买入口
汇总 BigModel/Z.ai 的 Start Plan、个人套餐权益及 authenticated pricing 中 subscribed=true
的团队产品。未激活但仍有效的连接也纳入；未购买、已失效、普通 API Key、自定义供应商不
伪造成套餐。按每份快照所属 provider/团队身份分类，不用入口的 entry_plan_status 给全列表分类。
去重并稳定排序。入口 source/status/level 仍描述点击位置，不覆盖为其他套餐。

```text
现有权益 hooks（独立 provider 缓存）+ authenticated 团队订阅查询
  -> 全部已知有效套餐 -> 去重排序
  -> 显式购买入口冻结快照 -> App 上报 + WebView 注入同一列表
  -> 后续权益刷新不修改已经打开的漏斗
```

使用现有查询/缓存能力，不新增业务缓存或持久化状态，不依赖当前选中的连接。
购买入口必须等待本轮全部查询完成且成功，禁止用部分结果放行。未配置的来源不查询；
已配置来源的 no_plan 是成功空结果，异常/缺失快照不是空列表。
统一状态由 useCodingPlanEntryPlanList 持有，Provider 同时守卫点击，所有按钮/菜单读取同一状态。
查询中禁用入口并显示加载提示；查询失败将入口呈现为“套餐查询失败，重试”，重试只刷新数据，
不自动打开购买页、不上报入口。全部成功后需用户再次显式点击。账号或连接变化立即失效旧结果，
旧异步响应不能放行新一轮查询；已打开的漏斗不随后台查询改变。
Desktop/Web 使用相同聚合；不改变 continuous/replayable
或远控 host 边界。当前修复不改变官网上报协议，仍传 entry_plan_list 字符串。

验收：同时持有 Start Plan + Lite 时，从两个入口上报相同列表；团队产品显式按团队分类；
未订阅团队项、过期项排除；重复数据去重；切换入口不影响列表；App 与 WebView 字段相同。

### 本次修复验证

- 16 个相关单测通过，覆盖跨 family 汇总、未启用连接、过期过滤、团队登录切换和点击快照冻结。
- 桌面 CPUW-01 / CPUW-03 两例通过；CPUW-01 在 App `net.fetch` 边界断言
  `coding_plan__personal_pro,start_plan__zcode_v3_start_plan`，并核对 WebView 上下文完全一致。
  预置 Start 连接为 disabled，证明已购但未激活连接也被统计；网关响应仍为 mock。
- CUA 点击当前开发账号个人 Pro 的升级入口，通过只读 CDP 检查 WebView 上下文，
  得到 `coding_plan__personal_pro,coding_plan__team_pro`，包含未点击的团队套餐。
  此次不把 WebView 上下文核对称为生产网关收包成功。
- `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过。
- 未进行 Windows/Linux 和手机 Web 实机回归。

### 完整性门禁回归场景

慢响应期间设置卡片、个人/团队购买横幅、头像菜单、会话额度、Start 用量和闲时购买入口均不能打开购买页。
失败重试只读取套餐，不产生入口事件；全部成功后点击才产生一次带完整列表的 App 事件。
状态链路：账号/连接变化 -> loading -> ready 或 error -> retry -> loading；无套餐确认成功也进入 ready。
Provider 是入口唯一执行点，不新增等待点击队列，也不自动重放用户被拦截的点击。

验证结果：231 个相关单测通过；CPUW-01/CPUW-03 两个桌面 E2E 通过。
CPUW-01 在 authenticated pricing 边界挂起请求，确认菜单禁用；返回 503 后显示重试，
重试成功前后均没有入口事件，只有后续显式购买点击才在 App net.fetch 产生一次完整列表。
同时验证 WebView 注入相同列表、刷新不重报以及 BigModel/Z.ai 购买完成刷新。
开发日志使用 UI logger.debug 输出 `[purchaseTelemetry] 套餐入口查询状态`，不输出凭据。
未执行 Windows/Linux 或手机实机回归；共享按钮与菜单使用相同状态及中英文文案。

### MR !2508 建议项收敛

- SG-01：已有未购买快照、单卡登录/同步仍 pending 时，Subscribe 保持禁用并展示与 Upgrade 相同的 spinner；完成后移除 spinner。全局 inventory loading/error 文案仍优先，不改变门禁或重试语义。桌面与手机共用组件，沿用主题与翻译。
- SG-02：入口构建器只建立来源、套餐状态和漏斗 ID，entryPlanList 初始为空；Provider 在完整查询成功后的显式点击中填入唯一的全连接快照。删除按英文名称推断 audience 的旧列表构建器及只服务该逻辑的参数。
- SG-03：按用户确认保留现有主动查询，本轮不改查询时序或缓存。

```text
单卡同步 -> Subscribe disabled + spinner -> 同步完成恢复
入口上下文（列表待填）-> Provider 完整快照 -> App 上报 + WebView 注入
```

回归：未购买卡片在同步中/完成后分别展示/移除 spinner；入口 builder 不从卡片推断列表；Provider 冻结完整快照；现有购买 WebView E2E 保持列表一致及刷新不重报。

本轮验证：194 个相关单测通过；桌面无权益账号的购买 E2E 在 customerInfo 网络边界挂起单卡同步，确认 Subscribe 的 spinner、禁用、恢复及进入购买页，运行 ID `desktop-e2e-20260909112055848-p74517-0093597585192353`。CPUW-01 / CPUW-03 亦通过；新场景早期的菜单渲染等待/指针点击问题已修正后重跑通过。typecheck、desktop typecheck:e2e、lint（46 个存量 warnings）及 architecture 检查通过。Windows/Linux、手机实机与双主题全量对照未执行。
