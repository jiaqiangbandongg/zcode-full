# 企业版编程套餐接入

## 范围

设置页的 BigModel 编程套餐购买面板支持在 `Personal / Team` 之间切换。个人页沿用个人 Coding Plan 新购买面板状态机；Team 页复用同一弹出面板，按 `planSelect -> billingCycleSelect -> paymentConfirm -> payment -> success` 串起企业套餐购买闭环，不再打开旧的二级确认弹窗和二维码弹窗。

## 企业页规则

- 产品来源：
  - `planSelect` 团队版列表只展示基础套餐卡片，读取公开定价：`GET /campaign/partner/enterprise/pricing`
  - `billingCycleSelect` 套餐配置进入购买链路，按同一个 `tier` 重新读取登录态定价：`GET /subscription/enterprise/v2/pricing`
  - 套餐配置没有公开接口兜底；登录态定价失败时应展示加载/错误态，不得复用列表页公开数据。
- 产品等级按接口返回展示，不在前端限定 `LITE` / `PRO` / `MAX` 的可见范围。
- `subscribePeriod` 继续映射到月、季、年分组；接口返回季度时可展示，但 UI 不主动制造季度入口。
- `subscribeMode` 作为购买方式展示：
  - `CONTINUOUS`：连续包月 / 连续包年
  - `ONE_TIME`：按月采购
- 单笔支付按年采购商品不再售卖，前端必须过滤 `ONE_TIME + YEARLY`，即使接口仍返回也不展示、不允许选中。
- 企业页右侧购买方式切换按 `subscribeMode + subscribePeriod` 去重，按钮文案只使用接口下发的 `purchaseMethodName`；展示顺序固定为连续包月、连续包年、按月采购。桌面宽度下三个选项横向排列，窄屏下自适应换行。
- 套餐配置布局固定为：套餐席位、服务方式、余额抵扣、继续支付；当赠金和现金余额都没有可用数据或都不可选中时，不展示余额抵扣区。
- 套餐席位合并展示第一步已选择的团队标准版/团队高级版、接口价格和席位数量；左侧展示套餐名与单席月价，右侧展示带输入框边界的席位数步进输入，席位输入框使用较套餐卡片更小一号的圆角。配置页不再提供套餐切换；用户需要返回第一步才能更换套餐。不展示本地写死权益说明。
- 席位数量范围为 `2~10000`，默认 `2`。席位输入框允许手动输入，输入过程中不即时拦截；失焦后再校验，低于最小值回到 `2`，高于最大值回到 `10000`，空值或非数字回退到修改前的合法值。
- 服务方式按 `subscribeMode + subscribePeriod` 展示连续包月、连续包年、按月采购；年付有续费折扣时展示折扣角标。
- `ONE_TIME + MONTHLY` 采购时长始终展示在“按月采购”选项卡同一行右侧，使用小号 ghost 下拉选择，即使当前未选中按月采购也要显示。只允许 `1 / 3 / 6 / 12` 个月，默认 `1`。下拉触发器只展示当前月份；用户在未选中按月采购时修改月份，应同时选中按月采购，并按所选 `duration` 参与试算和下单。不得再允许用户手动输入任意月份，也不再在服务方式选项下方单独展示采购时长控件。12 个月九折活动暂未上线，当前不展示菜单和标题里的九折标识，活动上线后再开启。
- 服务方式右侧的自动续费授权文案只在选中 `CONTINUOUS` 连续订阅时展示；选中 `ONE_TIME` 按月采购时不展示。
- 套餐配置页读取 `GET /subscription/enterprise/v2/balance`，允许用户选择是否使用赠金和现金余额抵扣。前端把所选可用金额传给试算接口，实际抵扣以试算返回的 `giveDeductAmount`、`balanceDeductAmount` 为准。赠金和现金余额都不可用时需要清理已选抵扣状态，避免隐藏面板后仍把旧抵扣选择带入试算或下单。
- 现金余额旁的“去充值”跳转到 BigModel 充值中心：`https://bigmodel.cn/finance-center/finance/pay`。
- 继续支付区域用一个无圆角的吸底容器包裹配置摘要和继续支付按钮。吸底悬浮时顶部展示分割线，滚动到底部回到自然位置时隐藏分割线。容器内始终使用上下结构：上方展示配置摘要和价格，下方展示满宽继续支付按钮，以保证桌面端和窄屏下金额、按钮都有稳定点击区域。摘要左侧按“套餐 · 服务方式 · 席位 · 一次性采购时长”展示，例如“团队标准版 · 按月采购 · 2 席 · 1月”，使用正常正文颜色；摘要右侧金额使用套餐卡片价格格式，金额大号展示，币种和“起”小号跟随，优先使用试算返回的 `thirdPayAmount`。试算中显示“试算中”，无试算结果时用当前商品单价按席位和时长计算占位价。
- 确认支付页样式对齐个人确认支付页，按“金额卡片、协议勾选、继续支付按钮”纵向排列，协议勾选区域左右使用和个人页一致的 `px-3` 内缩，按钮不单独贴底；Team 只展示固定内容。金额卡片顶部展示购买套餐，即第一步选择的团队标准版/团队高级版；金额明细顺序固定为席位数量、服务方式、订单原价、折扣优惠、分割线、实付金额；订单原价取 `totalOriginalAmount`，折扣优惠取 `totalOriginalAmount - totalPayAmount`，实付金额取 `thirdPayAmount`，实付金额的金额格式对齐套餐列表卡片价格格式。支付前必须勾选“团队套餐购买协议”，协议链接为 `https://docs.bigmodel.cn/cn/terms/subscription-agreement-team`。
- 支付成功页个人和 Team 使用同一种摘要卡片样式。个人展示套餐、服务方式、服务周期、实付金额和状态；Team 展示套餐、席位数量、服务方式、服务周期、实付金额和状态。Team 一次性采购的服务周期展示为“数量 + 周期单位”，例如 `3月`；连续订阅展示为“每周期自动续费”。支付金额取支付确认上下文的实际第三方支付金额，格式保持与套餐卡片金额一致。
- Team 套餐列表点击选择时必须先查询待支付订单。没有待支付订单时正常进入套餐配置；存在待支付订单时弹窗提示“您有一笔尚未支付的订单，是否继续？”，提供“取消订单”和“继续支付”。“取消订单”调用取消接口后进入用户刚点击的套餐配置；“继续支付”直接进入确认支付页，确认页展示待支付订单对应的商品、席位和金额，最终调用继续支付接口获取二维码，不再重新创建订单。
- Team 创建订单进入支付页后，如果用户返回确认支付页再点击返回套餐配置，必须弹出待支付订单提示，不允许静默返回配置页。用户选择“取消订单”时调用 `POST /subscription/enterprise/v2/order/{orderNo}/cancel`，取消成功后清理本次订单恢复状态并回到套餐配置；用户选择“继续支付”时留在确认支付页，下一次继续支付复用本次已创建订单调用继续支付接口，不再创建新订单。

## 购买闭环

企业购买默认席位数为 `2`，`ONE_TIME` 默认采购时长为 `1`。套餐配置页默认不使用余额/赠金抵扣；用户启用抵扣后，试算和下单传入对应的 `giveAmount`、`balanceDeductAmount`。

购买流程：

1. 团队套餐列表选择套餐时，先调用 `GET /subscription/enterprise/v2/orders/pending` 查询待支付订单。
2. 无待支付订单时进入套餐配置，并调用 `GET /subscription/enterprise/v2/balance` 读取赠金、现金余额。
3. `POST /subscription/enterprise/v2/order/calculate` 试算。
4. 用户确认后 `POST /subscription/enterprise/v2/order` 下单。
5. 下单原样回传试算返回的 `totalOriginalAmount`、`totalPayAmount`、`thirdPayAmount`，并传入本次使用的 `giveAmount`、`balanceDeductAmount`。
6. 有待支付订单时展示提示弹窗；用户选择“取消订单”则调用 `POST /subscription/enterprise/v2/order/{orderNo}/cancel` 后进入套餐配置。
7. 用户选择“继续支付”则根据待支付订单的 `productId` 和 `seatCount` 直接进入确认支付页；确认后调用 `POST /subscription/enterprise/v2/order/{orderNo}/pay`，响应结构与创建订单一致。
8. 新创建订单进入支付页后，返回确认支付页再点击返回套餐配置时弹出提示；取消订单后回套餐配置，继续支付则留在确认页并复用本次已创建订单。
9. 支付二维码内容优先使用 `payUrl`；`alipayJumpSchema` 仅作为移动端直接跳转支付宝的兜底内容，不作为 PC 扫码二维码的首选。
10. `GET /subscription/enterprise/v2/order/{orderNo}/status` 轮询支付状态。
11. `SUCCESS` 视为支付成功；`FAIL`、`CLOSED`、`CANCELLED` 视为失败或关闭。
12. 成功后刷新企业定价和个人 Coding Plan 权益快照。

## 购买埋点金额

团队购买的 `purchase_pay_ck` 和 `purchase_result` 使用同一份试算金额快照。
快照保留 `order/calculate` 返回的全部 Amount 语义：

- `totalOriginalAmount` 取 `totalOriginalAmount`。
- `campaignDiscountAmount` 取 `campaignDiscountAmount`。
- `totalPayAmount` 取 `totalPayAmount`。
- `giveAmount` 取 `giveDeductAmount`。
- `cashAmount` 取 `balanceDeductAmount`。
- `thirdPartyAmount` 取 `thirdPayAmount`。
- 团队接口不提供 `refundAmount` / `residualAmount`，两者上报空字符串。

支付成功的 order status 响应不返回金额，结果埋点必须复用支付前冻结的快照，
不在成功后重新试算。历史待支付订单只能确认 `pendingOrder.amount`，将其记为
`thirdPartyAmount`，其他无法确认的金额字段保持空字符串。

## 暂不包含

首版不实现取消续费、恢复续费、续费、完整待支付订单列表页、企业成员席位管理，也不支持手动输入余额或赠金抵扣金额。团队购买入口仅处理单笔待支付订单的拦截、取消和继续支付恢复。
