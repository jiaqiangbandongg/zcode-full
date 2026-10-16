# Model Provider Family Entitlement 优先选择

Z.ai / BigModel provider family 的右侧详情以 `entitlement snapshot` 作为连接方式主判断来源。family 数据还没有准备好时，UI 不再猜测 API Key、Start Plan、Coding Plan 或 Team Plan，而是先显示 loading。

## 规则

- Family 详情必须等待 settings、provider 缓存和对应 entitlement snapshot 准备好，再渲染最终详情。
- `UsageEntitlementSnapshot.context` 表达本次 entitlement 查询使用的套餐上下文：
  - `personal` 表示个人 Coding / Start Plan 额度。
  - `team` 表示 BigModel Team Plan 额度，并携带 `organizationId` 和 `projectId`。
- 当 snapshot 中有完整团队身份时，Team Plan 连接项优先由 snapshot context 生成。
- BigModel enterprise pricing / customerInfo 只做 Team Plan 元数据校正或补全：展示名、商品 ID、组织/项目名称，以及 snapshot 未覆盖但后端明确存在的已订阅项目。
- 校正数据晚到时，不能让已经由 entitlement 推导出的 Team Plan 消失，也不能临时退回 Coding Plan。
- Settings 读取失败是错误态，不是 loading 态。UI 可以展示已有的连接方式读取失败提示，但不能据此推断另一种套餐。

## Loading 边界

打开 Z.ai 或 BigModel family 节点时，右侧详情保持现有 loading card，直到：

- app settings 完成首次读取；
- model providers 完成首次读取；
- 当前 family 的连接方式可以从 settings 和 pending state 中确定；
- OAuth mode 下，当前 family provider 的 entitlement 已完成首轮解析，或明确返回 entitlement 错误；
- 已保存的 selected connection key 能解析到连接项，除非该 key 对当前 family 已无效。

自定义 provider 和 Add Provider 不使用这条 family loading 边界。

## Context hover 余额展示

聊天输入框 context hover 中的「今日余额」和「剩余额度」必须同时满足三个条件：

- 当前实际使用的 model provider 属于对应 Plan provider；
- Settings 中当前 family 连接方式属于同一种连接方式；
- 当前连接方式对应的 entitlement 有可展示权益。

展示矩阵：

| 当前使用的 model provider     | 当前连接方式          | 权益状态      | Context hover 显示               |
| ----------------------------- | --------------------- | ------------- | -------------------------------- |
| API Key provider              | 任意                  | 任意          | 不显示「今日余额」和「剩余额度」 |
| 自定义 provider               | 任意                  | 任意          | 不显示「今日余额」和「剩余额度」 |
| 个人 Coding Plan provider     | 个人 Coding Plan      | 有个人权益    | 显示「剩余额度」                 |
| 个人 Coding Plan provider     | 个人 Coding Plan      | 无个人权益    | 不显示                           |
| BigModel Coding Plan provider | 团队 Coding Plan      | 有该团队权益  | 显示「剩余额度」                 |
| BigModel Coding Plan provider | 团队 Coding Plan      | 无该团队权益  | 不显示                           |
| Start Plan provider           | Start Plan            | 有 Start 权益 | 显示「今日余额」                 |
| Start Plan provider           | Start Plan            | 无 Start 权益 | 不显示                           |
| Coding Plan provider          | API Key / Start Plan  | 任意          | 不显示                           |
| Start Plan provider           | API Key / Coding Plan | 任意          | 不显示                           |

实现原则：

- 连接方式从 `modelProviderFamilyModes` 和 `modelProviderFamilySelectedKeys` 读取。
- 当前实际 provider 从工具栏当前 model value 或 supplier key 解析。
- API Key 和自定义 provider 不读取、不展示 Plan 余额。
- 个人 Coding、团队 Coding、Start Plan 之间不互相兜底；后端 entitlement 只填充当前连接方式的数据。
