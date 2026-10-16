# Todo 83：Account Provider 权益状态与领取流程收口

> 验证归属更新（2026-09-09）：本文残余欠测/失败/人工晋级统一转交 [Todo102](todo-102-verification-debt-closeout.md)，关闭在本文中的独立验证排期；历史证据保留，转交不代表测试通过。

> 状态：已实施（首轮收口）
>
> 日期：2026-09-04
>
> 来源：Start Plan 领取后待生效、模型设置页状态异常，以及领取页跳转行为复盘

## 1. 目标

修复 Account Provider 在“已领取但尚未生效”“已生效但暂时没有可用模型”“当前未选中”等状态下的表示和跳转行为，避免把账号权益、设置页展示、当前连接和模型可选性混成一个布尔值。

本 Todo 只处理 Account Provider 状态解析、领取后的 UI 流程和运行时投影，不改变普通 Built-in Provider、Personal Provider 或 Off-Peak 的既有配置语义。

## 2. 固定的数据层次

```text
ProviderFamilyConnectionSelectionSettings（持久化）
  └─ 用户在每个 Family 选择的连接方式

Account Provider State（运行时）
  └─ 每次刷新依据账号凭据、权益接口、模型/额度结果重新计算

Account Provider Config Overlay（运行时配置投影）
  └─ 仅提供 Provider Runtime 所需的账号配置事实
```

- `ProviderFamilyConnectionSelectionSettings` 继续使用现有字段，不新增每个 Provider 的 `current`、`visible` 或 `entitled` 持久化字段。
- `current` 由当前 Family 的连接选择运行时推导，只适用于可切换的 Account Provider（Start、个人 Coding Plan、Team Coding Plan）；普通 Built-in、Personal Provider 和 Off-Peak 不使用该概念。
- Account Overlay 只承载运行所需的账号配置和动态模型成员，不承载设置页展示状态。
- 本 Todo 不新增持久化迁移；已有选择数据仍按现有 Family 选择语义解释。

## 3. 统一的 Account Provider 状态

Account Provider Resolver 必须集中生成状态结果，UI、Registry 和 Model Selection 不得各自重复判断：

```ts
{
  availability, // available | pending | unavailable | unknown
  entitled,     // 当前是否已经可以使用该账号权益
  effectiveAt,  // 待生效时刻（没有则为空）
  current,      // 当前 Family 是否选中了该连接方式
  models,       // 账号返回的模型成员
  executable,   // 是否存在可执行模型
  selectable    // 是否可以进入当前模型选择器
}
```

### 3.1 上游状态的映射

优先复用权益服务已有的 `available`、`unavailable`、`unknown` 语义，只增加明确的 `pending` 表示未来生效，不在不同页面重新猜测状态。

```text
available
  -> entitled = true

pending（已领取，effectiveAt 在未来）
  -> 设置页可展示
  -> entitled = false（当前还不能使用）
  -> 保留 effectiveAt

unavailable（服务端明确当前无权益或账号不可用）
  -> entitled = false

unknown（网络/服务端暂时无法确认）
  -> 保留上一次可展示状态，不因一次失败突然隐藏
```

如果上游同时返回“套餐已领取”和未来的 `effective_at`，不得简单把上游字段静默改写成另一个含义。应保留原始时间和来源状态，再由集中映射明确表达“已领取但当前未生效”，并补充测试说明该映射。

### 3.2 展示、执行和选择边界

- Account Provider 是否出现在设置页，由统一状态中的 Account 连接展示结果决定；不与 Built-in Provider Config 的静态 `visibility` 混用。
- `entitled` 只表示当前账号权益是否已经可以使用。
- `executable` 取决于是否存在可执行模型；即使 `entitled=true`，没有模型也不能执行。
- `selectable` 只对当前连接且存在可执行模型的 Account Provider 成立。待生效、未选中、无模型或不可用的 Provider 不能进入 Model Selection。
- 没有模型时只表示当前不能形成有效的 Model Selection；不能反过来把 Account Provider 判成未授权，也不能因此丢掉它的状态或配置快照。Provider 壳是否保留在 Registry 按现有 Runtime 投影规则处理，但绝不能产生可执行的模型请求。
- 一个 Family 可以同时查询 Start、个人 Coding Plan 和 Team Coding Plan 的状态；不能因为当前选中了其中一种连接，就把其他连接错误标成未授权。
- 只有当前选中的 Account Provider 才投影进入运行时 Registry；“已拥有”不等于“当前正在使用”。

## 4. Start Plan 领取与跳转

### 4.1 领取成功后的展示

- 领取成功卡片必须保留结果状态，并展示 `effectiveAt`（例如“明天 09:00 生效”），不能只显示成功而隐藏生效时间。
- 待生效时保留“知道了”和“模型设置”等结果操作；不能提供会立即切换到 Start Plan 的“开始体验”路径。
- 已生效且存在可执行模型时，用户主动点击“开始体验”才切换当前连接；点击前再次读取最新状态，不能依据领取成功时的旧快照直接切换。
- 领取成功不自动改变当前连接方式。
- “开始体验”只能在最新状态同时满足“权益当前可用”和“存在可执行模型”时出现或生效；待生效、状态未知、明确不可用或没有模型时，不提供会导致切换的操作。

### 4.2 设置页手动进入

用户仍可从模型设置页手动查看待生效的 Start Plan 状态和生效时间，但该状态不能出现在当前模型选择器，也不能生成无效的 Model Selection。

### 4.3 非法跳转保护

所有由领取页或其他入口发起的 Provider 跳转都必须验证目标：

- 目标 Provider 不存在；
- 目标 Provider 不可展示；
- 目标 Provider 未取得当前权益；
- 目标 Provider 没有可执行模型。

遇到非法目标时应展示明确错误并回到稳定页面，不得让设置页停留在永久加载或空白状态。该保护集中放在跳转入口，不在各个页面复制一套判断。

## 5. 活动卡片刷新

恢复 staging 中已有的活动预览刷新行为：重新获得可见状态、登录后、领取完成后能够刷新；网络暂时失败时保留上一次有效结果。当前分支误删的轮询/刷新逻辑不能作为本 Todo 的无关清理带掉。具体轮询间隔不是 Provider 抽象的一部分，可沿用现有实现。

## 6. 验收重点

- 未领取、已领取待生效、已生效但无模型、已生效且有模型、查询未知五类状态均能正确展示和恢复。
- 当前使用个人 Coding Plan 时，Team 和 Start 的权益仍独立查询；已拥有但未选中的连接不会进入当前 Model Selection。
- Start Plan 领取后能看到生效时间；待生效时不会自动切换，生效且可执行时主动“开始体验”才切换。
- 没有可用模型时不会产生有效模型选择；Provider 页面、Registry 和 Model Selection 的结果一致。
- 非法 Provider 跳转不会卡死，并且不破坏用户当前页面。
- 领取卡片在登录、重新显示、领取完成和短暂网络失败后保持正确刷新行为。
- 覆盖桌面端和 Web/远程端的状态展示与入口行为；桌面图形 E2E 在 MacBook Pro 上复跑；不改变桌面 continuous 与 Web replayable 的消息链路边界。

## 7. 与现有 Todo 的关系

- Todo 50/51 已确定 Provider 配置启用、账号权益和 Off-Peak 的既有边界；本 Todo 不恢复 Provider 顶层 `enabled`，也不改变 Off-Peak 的静态隐藏配置。
- Todo 69/70/71/72 负责回滚兼容、旧数据迁移和 Model Selection 恢复；本 Todo 不新增选择迁移，也不让 Account 状态覆盖已恢复的用户选择。
- Todo 76 负责 Built-in Config 分层；本 Todo 只消费其统一的 Provider/Model Effective 配置，不把动态权益写入 Built-in Template。
- Todo 78 负责 Desktop Provider E2E 欠测；本 Todo 的状态矩阵和领取流程应并入该 E2E 收口，不以单元测试替代真实界面验证。
- Todo 81 负责模型选择失效提示按场景收口；本 Todo 只定义 Account Provider 的状态和跳转前置，不把待生效权益误报为 Composer 迁移错误。

## 8. 非目标

- 不把 Account Provider 展平为普通 Personal Provider。
- 不删除 Family 连接选择持久化，也不新增每个 Provider 的 `current` 持久化字段。
- 不用 Account Provider 的动态状态改写普通 Provider Config `visibility`。
- 不因为“已领取”就强制把用户切换到 Start Plan。
- 不通过默认模型或 Provider 列表第一项替代没有可用模型的 Account Provider。
- 不为已经错误迁移并写入磁盘的历史配置增加自动覆盖修复；此类个案继续人工处理。

## 9. 首轮实施记录（2026-09-04）

本轮先按“有明确行为风险才改动”的原则完成领取跳转门禁。现有代码已经覆盖以下既有行为：

- `CodingPlanAvailabilityResult` 的 `available / unavailable / unknown` 由服务层统一产生；Start Plan 的未来生效时间由权益快照的 `effectiveTime` 解析，并在领取结果弹窗中展示和禁用提前使用。
- 领取成功后仍会并行刷新活动预览、权益快照和 Provider Settings；网络失败时保留领取成功结果，未把一次失败降级成“未领取”。
- Family 选择仍是唯一持久化连接选择，未新增 Provider 级 `current`、`visible` 或 `entitled` 字段。

本轮新增的确定性修复：

- `ManualClaimPlanBanner` 在用户点击“开始体验”后，使用领取后的最新 `ProviderSettingsView` 做一次集中门禁。
- Provider 刷新失败、目标 Provider 不存在/不可执行，或没有至少一个同时 `executable` 且 `selectable` 的模型时，不写入 `providerFamilyConnectionSelections`，只提示“Start Plan 当前还不可用”。
- 领取成功但权益查询失败仍保留成功弹窗；只有 Provider 最新 View 通过门禁时才允许切换。

验证：

- 受影响测试：7 个文件、94 tests passed。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过（仓库已有 40 条 warning，0 error；本轮未新增 error）。

本轮没有把权益快照、Provider Runtime 和 Settings 展示强行合并成一套重复 DTO；它们目前分别消费服务层账号可用性、Provider Settings View 和权益展示快照。若后续要真正合并三者的数据契约，应先拿到跨页面重复状态的运行时证据，再单独拆 Todo，避免为“统一”引入第二套缓存或更复杂的异步同步。
