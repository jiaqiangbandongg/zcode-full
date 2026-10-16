# Coding Plan client configs 接入用例

日期：2026-07-23

## Feature/change summary

| Field                 | Value                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------- |
| Change                | “升级 Coding Plan”统一消费 `client/configs` 的个人、团队和 Start Plan 静态数据         |
| User-visible surfaces | 升级页套餐选择、个人周期选择、团队套餐选择、Start Plan 卡片                            |
| Existing docs         | `docs/bigmodel-coding-plan-subscription.md`、`docs/coding-plan-purchase-panel-flow.md` |
| Existing code owners  | host `codingPlanSubscriptionService`、UI purchase hooks/panel                          |
| Out of scope          | 支付协议、订单创建、entitlement、provider registry 与 realtime pricing 协议变更        |

## Clarification log

| Round | Question                 | User answer                                   | Boundary fixed                           | Follow-up needed |
| ----- | ------------------------ | --------------------------------------------- | ---------------------------------------- | ---------------- |
| 1     | 静态套餐和文案从哪里获取 | 使用 `client/configs`                         | configs 是静态目录权威源                 | no               |
| 2     | 本地开发如何读取测试数据 | 使用 `ZCODE_ENV=test`                         | 连接 ZCode 测试环境 endpoint             | no               |
| 3     | provider 如何隔离        | Team 区分 Z.AI/BigModel，当前 Z.AI 无团队套餐 | provider key 严格匹配，不跨品牌回退      | no               |
| 4     | Start Plan 如何处理      | 补入完整 configs                              | 保持 provider-neutral `startPlanPreview` | no               |
| 5     | 迁移后个人套餐描述文案   | `description` 恢复迁移前卡片文案              | 仅恢复描述，不回退商品、价格或权益        | no               |

## Boundary decisions

| Boundary      | Decision                     | Includes                                 | Excludes / prunes        | Source        |
| ------------- | ---------------------------- | ---------------------------------------- | ------------------------ | ------------- |
| 静态目录      | configs 为权威源             | 商品身份、名称、周期、静态价格、卡片文案 | 本地常量覆盖远端         | user          |
| 文案缺失      | 保持为空                     | 个人/团队权益、描述与 Start 文案         | 前端硬编码文案兜底       | user          |
| 实时状态      | preview/pricing 覆盖动态字段 | 实付价格、可购、售罄、订阅状态           | 覆盖远端卡片文案         | existing spec |
| 测试环境      | `ZCODE_ENV=test`             | 远端测试环境 `client/configs`            | 本地开发 mock            | user          |
| Team provider | 精确 provider key            | BigModel 8 SKU、Z.AI 空数组              | BigModel → Z.AI fallback | user          |
| Start         | 独立 preview                 | planId/name/entitlements                 | 伪装成支付 SKU           | existing spec |

## Domain scope and high-risk cross-products

| Domain                        | Include? | Reason                                       |
| ----------------------------- | -------- | -------------------------------------------- |
| Model/provider config         | yes      | provider key、静态目录、实时合并             |
| Architecture/process boundary | yes      | renderer 通过 service 获取 host 配置         |
| UI locale/responsive          | yes      | BigModel 中文、Z.AI 英文；布局不变           |
| Mobile remote/replayable      | pruned   | App-global 配置服务不改变 task realtime 语义 |

高风险组合为 `provider × audience × config result × realtime result`。mock 与生产 endpoint
只改变配置来源，不改变合并算法。

## State owners

| State / fact  | Authority                                     | Cache/mirror             | Evidence                 |
| ------------- | --------------------------------------------- | ------------------------ | ------------------------ |
| 个人静态目录  | `client/configs.codingPlanStaticProducts`     | host + UI 一天内存缓存   | service result / UI card |
| 团队静态目录  | `client/configs.codingPlanStaticTeamProducts` | host client-config cache | service result / UI card |
| Start Preview | `client/configs.startPlanPreview`             | host + UI cache          | service result / UI card |
| 个人实时状态  | `batch-preview`                               | UI hook snapshot         | network + card action    |
| 团队实时状态  | enterprise pricing                            | UI hook snapshot         | network + card action    |

## Candidate combinations and pruning

| Candidate ID | Setup                                      | Expected effect                     | Status              |
| ------------ | ------------------------------------------ | ----------------------------------- | ------------------- |
| CPCFG-01     | BigModel personal config + preview success | 静态文案保留，实时价格/状态覆盖     | accepted            |
| CPCFG-02     | Z.AI personal config + preview failure     | 保留 Z.AI 静态卡，不跨品牌          | accepted            |
| CPCFG-03     | BigModel team config + pricing success     | 按 productId 合并静态文案和实时状态 | accepted            |
| CPCFG-04     | BigModel team config + pricing failure     | 保留静态团队卡并显示刷新错误        | accepted            |
| CPCFG-05     | Z.AI team 空数组                           | 不展示团队商品                      | accepted            |
| CPCFG-06     | Start Preview 存在                         | 从 entitlements 计算额度            | accepted            |
| CPCFG-07     | Start Preview 缺失                         | 隐藏 Start Plan                     | accepted            |
| CPCFG-08     | mock 未显式启用                            | 访问正常 runtime endpoint           | accepted            |
| CPCFG-09     | 生产构建设置 mock env                      | 忽略 mock，禁止本地配置进入生产     | accepted            |
| CPCFG-10     | desktop/mobile/remote workspace            | 使用同一 App-global service 结果    | pruned by invariant |

## Accepted case list

| Case ID  | Setup                                  | Action           | Assertions                                           | Evidence layers       | Status   |
| -------- | -------------------------------------- | ---------------- | ---------------------------------------------------- | --------------------- | -------- |
| CPCFG-01 | BigModel config + preview fixture      | 打开个人升级页   | 名称/文案来自 config，价格/按钮来自 preview          | unit + E2E network/UI | planned  |
| CPCFG-03 | BigModel team config + pricing fixture | 切换团队         | 两行 equity 和 description 来自 config，实时状态合并 | unit + E2E network/UI | planned  |
| CPCFG-04 | Team pricing 失败                      | 切换团队         | 静态卡仍存在并展示错误                               | unit                  | planned  |
| CPCFG-05 | Z.AI team `[]`                         | 打开 Z.AI 升级页 | 无跨品牌团队卡                                       | unit                  | planned  |
| CPCFG-06 | Start fixture                          | 打开升级页       | Start 名称和 5M entitlement 汇总正确                 | unit + E2E UI         | planned  |
| CPCFG-08 | `ZCODE_ENV=test`                       | 请求 configs     | 使用测试环境 endpoint 并附加客户端参数               | unit                  | verified |

## E2E handoff notes

- Provider fixture：复用 `packages/desktop/test/e2e/fixtures/coding-plan-client-configs.json`，禁止复制商品数组。
- Timing：App 内 client-config 缓存测试需显式清理。
- Desktop/mobile：购买页已有响应式实现，本次不新增 conversation realtime 状态。
- Review risk：团队 pricing 按 `productId` 合并时必须保留 raw enterprise product，支付参数仍取 realtime product。
