# Todo 36：Provider Family 权益对称性与失败语义收口

> 状态：已完成（后续 Todo 57 已完成全仓回归与 macOS Provider E2E 实跑）
>
> 日期：2026-08-28
>
> 来源：Provider Refactor 合并后代码 Review、Start Plan/Team Plan 实机问题复盘
>
> 关联文档：[`Z.AI / BigModel Start Plan Provider`](../../../zai-start-plan-provider.md)、
> [`Todo 32`](./todo-32-team-plan-settings-effective-provider-boundary.md)、
> [`Provider Family Merge`](../../../model-provider-family-merge.md)

## 1. 背景与结论

当前实现已经确立了正确的产品语义：Z.AI 与 BigModel 是结构对称的 Provider Family；每个 Family 都包含 API
Key、Start Plan、Individual Coding Plan 和 Team Coding Plan Provider。Start Plan 是可与付费 Coding Plan
并存并由用户显式选择的独立连接，不是 Coding Plan 查询失败后的 fallback。

但实现仍带有多轮历史修复的形状：同一组 Family Provider ID 在 UI、OAuth 恢复和权益查询中反复通过
`family === "zai" ? ... : ...` 映射；Z.AI/BigModel 查询被复制成四条 Hook 链路；旧注释仍宣称 Coding Plan
会禁用 Start fallback；部分页面甚至通过展示名称反推 Family。失败状态在设置页与启动恢复链路中的解释也不一致。

本 Todo 不改变既有套餐产品设计，而是完成以下收口：

1. Z.AI 与 BigModel 的编排完全由 `ModelProviderFamilySpec` 驱动；
2. Start、Individual、Team 使用同一套确定/未知/失效状态语义；
3. 真实 API、鉴权材料和 Team scope 差异继续留在 Service/Adapter 边界；
4. 只有权威结果明确证明无权益时才破坏已有选择；
5. UI 不再从名称、文案或 BigModel 常量反推 Provider Family。

## 2. 已裁决的领域模型

### 2.1 Family 是静态拓扑

`packages/shared/src/model-provider-family.ts` 中的 `MODEL_PROVIDER_FAMILY_SPECS` 是 Family 到各 Provider 身份的
唯一映射：

```text
ModelProviderFamilySpec
├─ id
├─ label
├─ oauthProviderId
├─ apiKeyProviderId
├─ startPlanProviderId
├─ individualCodingPlanProviderId
└─ teamCodingPlanProviderId
```

UI、OAuth 恢复、套餐导航、权益查询和 Team item 构造不得另建 Z.AI/BigModel Provider ID 对照表，也不得使用
二选一三元表达式重复这份映射。

Family 特定的购买、管理、注册等页面地址同样属于 Family 展示/产品元数据。它们应进入单一 Family 元数据来源，
不能藏在通用 Team item 构造函数中。

### 2.2 Plan 是独立连接，不是 fallback 链

```text
一个 Provider Family
├─ Start Plan
├─ Individual Coding Plan
└─ Team Coding Plan
```

- Start entitlement 在存在对应 Account Access 时独立查询；
- Individual 与当前所选 Team 使用各自稳定 Provider ID；
- Team 查询额外携带 `productId / organizationId / projectId`；
- Coding Plan 有效不能隐藏 Start、禁止 Start 查询或覆盖用户已选 Start；
- Start 有效也不能覆盖用户显式选择的 Individual/Team；
- 自动选择只用于没有可保留选择或当前选择已经被权威结果明确判定失效的场景。

### 2.3 状态语义必须对称

所有套餐连接统一区分三类事实：

```text
确定可用
└─ 有有效 subscription / quota / remaining 等权威权益事实

确定无权益
└─ 当前协议下服务端明确返回 no_plan

暂时未知
├─ loading
├─ 请求抛错
├─ unavailable
└─ 不完整或无法归类的快照
```

暂时未知不能投影成“未购买”，也不能破坏当前已保存的连接选择。只有“确定无权益”可以移除 Start 入口或触发自动
回退。

`not_authenticated/not_configured` 不在这套套餐证据状态机中独立决定连接选择：Account Source 已确认未连接时，
外层 `accountConnected` 直接投影为 `disconnected`；主动 logout 由 OAuth、Account Source 与 Provider Family 清理链路
负责。Entitlement 不能根据这两个错误反推用户是否已经退出，也不能把它们误报成“未购买”。

### 2.4 对称不等于抹掉协议差异

以下差异是正常事实，必须保留：

- Start Plan 使用 balance/权益接口，并可能返回当前账号专属模型成员；
- Individual 使用个人账号访问上下文；
- Team 需要完整的产品、组织和项目上下文；
- Z.AI 与 BigModel 可以具有不同 Endpoint、OAuth、注册页、购买页和管理页；
- 具体请求 Header、凭据获取和服务端错误协议由 Service/Adapter 负责。

正确边界是“上层编排和状态机对称，差异通过 Spec/Access Context 输入，底层协议实现各自处理”，而不是让 UI 到处
判断 Family 或 Plan Kind。

## 3. 已发现的问题

### 3.1 Start 临时不可用会在恢复链路中被当成失效

设置页导航已经正确保留 `checking/unavailable` 的已选 Start，但
`resolvePreservedStartPlanSelection()` 对所有非空且非 active 的快照统一返回“不保留”。Service 在网络失败时会返回：

```ts
{
  unavailableReason: "unavailable",
  subscription: null,
  quota: null,
  remaining: null,
}
```

该快照不是 `null`，因此登录或启动恢复可能把已选 Start 改写成 Individual/Team。这与“只有明确 `no_plan` 才允许
切走”相冲突。

目标修复：建立一个最小纯函数判断 entitlement 证据，只在明确 `no_plan` 时返回 inactive；已有权威权益事实时返回
active；`null`、异常、`unavailable` 和不完整快照返回 unknown，并保留已有选择。该函数不处理 logout，也不拥有
Account 连接状态。

### 3.2 `notPurchased` 兜底违反注释与协议

`resolveCodingPlanEntitlementState()` 的注释声明“只有服务端明确返回 `no_plan` 才展示未购买”，但未命中已知分支时
仍无条件返回 `notPurchased`。这会把 `not_authenticated` 或未来新增/不完整状态误报成未购买。

目标修复：对 `UsageEntitlementSnapshot.unavailableReason` 做穷尽、类型安全的投影；默认未知状态只能进入
`unavailable/checking/disconnected` 中符合上下文的一种，不能进入 `notPurchased`。

其中 `disconnected` 必须由 `accountConnected` 或其他权威 Account 状态决定，不能仅凭 entitlement 快照清理连接。

### 3.3 Family Provider ID 映射被重复硬编码

当前多个模块重复以下模式：

```ts
family === "zai"
  ? BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan
  : BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan;
```

已确认至少分布在：

- `modelProviderFamilyConnectionSelection.ts`；
- `providerFamilyConnectionVisibility.ts` 的 Individual/Team 查找、构造和 quota 判断；
- `useEnterpriseCodingPlanProducts.ts`；
- `oauthProviderFamilySelectionRefresh.ts` 的 OAuth 到 Provider ID 数组转换。

目标修复：统一使用 `getModelProviderFamilySpec(family)` 或
`resolveModelProviderFamilySpecByProviderId(providerId)`；删除重复映射和基于数组位置的 `[0]/[1]` 读取。

### 3.4 权益 Hook 复制为四条链路

`useCodingPlanEntitlements()` 手工维护 Z.AI Coding、Z.AI Start、BigModel Coding、BigModel Start 四套 Access、
Fingerprint、Query、Refresh、Result 和依赖数组。代码虽然当前行为基本对称，但任何后续修复都容易只落到其中一侧。

目标结构：

```text
useProviderFamilyEntitlements(familySpec, selection, settingsView)
├─ resolve Coding target（Individual 或当前 Team）
├─ resolve Start target
├─ 生成各自 Account Access / cache identity
├─ 独立调用 entitlement hook
└─ 返回同构 family result

useCodingPlanEntitlements
├─ 显式调用 Z.AI family hook
├─ 显式调用 BigModel family hook
└─ 合并结果与 refresh
```

外层必须显式调用两个自定义 Hook，不能在动态循环中调用 React Hook。抽取只消除 Family 复制，不建立第二份权益缓存、
Provider DTO 或状态权威。

### 3.5 OAuth 恢复使用无名称的位置数组和冗余门禁

`resolveCodingPlanProviderIdsFromOAuth()` 返回 `[individual, start, team]`，调用方再用下标读取。这使第三个 Team ID
容易被忽略，也掩盖了现有 Family Spec。

`ProviderFamilyDomain` 已限定为 `zai | bigmodel`，启动恢复中再次写
`if (domain === "bigmodel" || domain === "zai")` 没有新的保护意义。

目标修复：OAuth Provider 先规范化为 Family，再读取具名 Family Spec；删除位置数组和冗余 Family 白名单。

### 3.6 Team 管理地址错误依赖 BigModel 常量

通用 Team item 构造当前对 Z.AI 和 BigModel 都写入 `BIGMODEL_CODING_PLAN_TEAM_MANAGE_URL`。这意味着 Z.AI Team
的“管理/升级”操作也可能打开 BigModel 页面。

目标修复：

- BigModel Team 使用 BigModel Team 管理地址；
- Z.AI Team 使用 Z.AI 对应的管理地址；
- 地址从 Family 产品元数据取得；
- 若当前只有 Z.AI 通用订阅管理地址，则显式配置该地址，不允许用 BigModel 常量作为 fallback；
- 增加两 Family 的点击目标测试。

### 3.7 UI 从 `providerName` 反推 Family

`StatusCards.tsx` 当前使用：

```ts
providerName.toLowerCase() === "bigmodel" ? "bigmodel" : "zai"
```

这会把任何不是精确 `BigModel` 的展示名称都解释为 Z.AI，并让本地化或文案调整改变业务行为。由该结果控制的图标、
账号提示和注册提示都可能错误。

目标修复：状态卡接收明确 `providerId` 或 `family`，通过 Family Spec 解析身份；`providerName` 只用于展示，不参与任何
状态、路由或交互判断。

### 3.8 旧注释与已删除 fallback 语义冲突

`useCodingPlanEntitlements.ts`、`V4ComposerToolbar.tsx` 和相关测试仍存在“Coding Plan 激活后 Start Plan fallback
查询被禁用”的注释。实现已经改为 Start 独立查询，这些注释会误导后续维护者重新引入互斥逻辑。

目标修复：删除或改写所有旧 fallback 注释、测试名称和变量说明。`enabledStartPlanProviderIds` 若仍有真实调用价值，应只
表达“当前具备查询身份的 Start Provider”，不得继续用 fallback 解释。

### 3.9 无生产调用的选择 Resolver

`resolveMissingModelProviderFamilyConnectionSelection()` 目前只有测试引用，没有生产调用，并且与实际使用的
`resolveLatestModelProviderFamilyConnectionSelection()` 具有不同优先级。两套相似算法会让设计看起来存在两种默认选择
规则。

目标修复：再次使用静态引用检查确认后删除无调用 Resolver 及其孤立测试；保留的 Resolver 按真实使用语境重新命名，
明确它只用于“无法保留当前选择后的自动选择”，不要用含义模糊的 `Latest/Missing`。

### 3.10 Team Family 列表和 legacy 默认散落在业务流程

`providerFamilyConnectionVisibility.ts` 另建 `TEAM_PLAN_DOMAINS = ["bigmodel", "zai"]`，部分商品数据还在深层
使用 `product.family ?? "bigmodel"`。这些都是潜在的扩展断点。

目标修复：

- Team Family 遍历直接来源于 `MODEL_PROVIDER_FAMILY_SPECS`；
- 历史商品缺失 `family` 的 BigModel 兼容只允许存在于 importer/normalizer 边界；
- 进入导航与状态构造前，产品必须已经具有明确 Family；
- 不改变现有历史数据的兼容结果。

## 4. 目标实现结构

```text
MODEL_PROVIDER_FAMILY_SPECS
          |
          +-------------------------------+
          |                               |
          v                               v
Z.AI Family Context               BigModel Family Context
├─ static provider ids            ├─ static provider ids
├─ product/manage URLs            ├─ product/manage URLs
└─ selected connection            └─ selected connection
          |                               |
          +---------------+---------------+
                          |
                          v
              统一 Family Entitlement 编排
              ├─ Coding target
              │  ├─ Individual
              │  `─ Team + product/org/project
              ├─ Start target
              ├─ cache / refresh
              `─ entitlement outcome
                          |
          +---------------+----------------+
          |                                |
          v                                v
连接选择恢复与自动选择                 Settings / Composer 投影
├─ active -> 保留/可选                  ├─ checking
├─ inactive -> 允许回退                 ├─ purchased
`─ unknown -> 保留当前选择              ├─ notPurchased（仅明确无权益）
                                       `─ unavailable/disconnected
```

Account 连接和主动退出位于图外：Account Source 决定 Provider 是否连接、启用和可执行；logout 链路负责清理账号、
凭据与当前 Family。Entitlement outcome 不参与这两项所有权裁决。

不得新增：

- 第二套 Provider Family 注册表；
- Renderer 自己维护的 Account Overlay；
- Plan capability DTO；
- 用显示文案、URL 或 Provider 名称反推身份的 helper；
- 具体模型 ID 或 Provider ID 的运行时业务硬编码。

## 5. 实施顺序

### 5.1 先写失败测试

1. 已选 Start 收到 `unavailable` 快照时，登录和启动恢复均保留选择且不写 Settings；
2. 已选 Start 查询抛错或返回 `null` 时继续保留；
3. 已选 Start 明确返回 `no_plan` 时允许自动选择其他连接；
4. `not_authenticated/not_configured/unavailable` 均不投影为 `notPurchased`；前两者的连接语义由
   `accountConnected`/Account Source 决定；
5. Z.AI 与 BigModel 使用参数化测试共享同一状态矩阵；
6. Z.AI/BigModel Start、Individual、Team 均从 Family Spec 取得 Provider ID；
7. Z.AI Team 管理按钮打开 Z.AI 地址，BigModel Team 打开 BigModel 地址；
8. 修改 Provider 展示名称或本地化文案不会改变 Family、图标和交互；
9. 当前用户选择优先于自动选择；只有明确失效才执行自动选择；
10. entitlement refresh 继续按 Provider/Team scope 使用独立 cache key，并保持 in-flight 合并。

### 5.2 修正失败语义

- 建立最小纯函数将套餐证据归一为 `active | inactive | unknown`：只有明确 `no_plan` 是 inactive，已有权威权益事实
  是 active，其余是 unknown；
- 设置页状态和选择恢复共同复用该判断，不得各自解释一次；
- 修正 Start preservation 和 `notPurchased` 兜底；
- 对联合类型使用穷尽检查，使未来新增状态在编译或测试中暴露。
- 不把 logout、Account 连接或凭据清理并入该函数。

### 5.3 收敛 Family 编排

- 使用既有 `ModelProviderFamilySpec` 替代所有重复 Provider ID 三元映射；
- 抽取对称的 Family Entitlement Hook；
- OAuth/启动恢复读取具名 Spec 字段；
- Team 导航与 quota 判断统一按 Spec 工作；
- legacy Family 缺省值移到单一规范化边界。

### 5.4 修正 UI 身份和管理链接

- 状态卡改为接收显式 Provider/Family 身份；
- 删除 `providerName` 身份推断；
- Family 元数据补齐各自 Team 管理地址；
- 删除通用 Team item 对 BigModel URL 的硬编码；
- 保持多语言展示名称只承担文案职责。

### 5.5 删除残留

- 删除无生产调用的 Resolver；
- 删除失真的 fallback 注释和测试说明；
- 删除已被 Family Spec 替代的映射 helper、常量列表和分支；
- 使用 `rg`、`pnpm dep:refs` 和 `pnpm knip` 检查孤立导出与旧语义残留。

## 6. 验证矩阵

### 6.1 Family 对称性

以下矩阵对 Z.AI 与 BigModel 使用同一组参数化断言：

| 连接 | Access 条件 | 查询目标 | 额外上下文 |
| --- | --- | --- | --- |
| Start | Start Account Access 存在 | `startPlanProviderId` | 无 Team scope |
| Individual | Individual Access 存在 | `individualCodingPlanProviderId` | Personal |
| Team | 已选有效 Team connection | `teamCodingPlanProviderId` | product/org/project |

### 6.2 失败状态

| Entitlement 结果 | 已有选择 | 是否保留 | UI 状态 |
| --- | --- | --- | --- |
| active | 任意匹配连接 | 是 | purchased |
| no_plan | 对应连接 | 否，可自动回退 | notPurchased |
| unavailable | 对应连接 | 是 | unavailable |
| not_authenticated | 由 Account Source 决定 | Entitlement 不单独裁决 | disconnected/unavailable |
| not_configured | 由 Account Source 决定 | Entitlement 不单独裁决 | disconnected/unavailable |
| 请求抛错 / null | 对应连接 | 是 | unavailable/checking |
| 不完整未知快照 | 对应连接 | 是 | unavailable |

### 6.3 回归

- Start 与 Coding 同时有效时均可见，用户选择不被刷新覆盖；
- Team 与 Individual 同时有效时，已选 Team 不因启动恢复被个人套餐覆盖；
- Team pricing 暂时失败仍保留已选 Team；
- Account Provider Settings 继续读取 `ProviderSettingsView`，不重新应用 Overlay；
- Start 账号模型成员覆盖、Team scope 和 Request Auth 行为不变；
- Settings、Composer、Sidebar 使用同一 entitlement cache identity；
- 主动 logout 继续由既有 OAuth/Account/Family 清理链路彻底退出，不由 entitlement 状态机兜底；
- Desktop、Web、手机远控不新增状态 Owner，不改变 continuous/replayable 语义。

## 7. 自动化要求

执行并通过：

1. UI entitlement、Provider Family navigation、OAuth callback/startup restore 定向单测；
2. Services usage entitlement 与 Team scope 定向单测；
3. Account Provider Settings 相关交互 E2E；
4. `pnpm typecheck`；
5. `pnpm lint`；
6. `pnpm test:unit`；
7. `pnpm fmt:check` 与 `git diff --check`。

当前 Review 基线的四个相关测试文件共 49 条测试全部通过，但缺少 `unavailable` 非空快照下的 Start selection
preservation，以及 `not_authenticated` 不得投影为 `notPurchased` 的证明。本 Todo 必须先补这两类失败测试，不能用
现有绿灯代替边界验证。

## 8. 完成标准

- Z.AI/BigModel 的 Provider ID、Team 管理地址和 OAuth 身份均来自单一 Family Spec/元数据；
- UI 业务代码不再通过展示名推断 Family；
- Family 编排不存在重复的 Z.AI/BigModel 查询实现；
- Start/Individual/Team 对 active、inactive、unknown 的处理一致；
- `notPurchased` 只由明确无权益产生；
- 临时请求失败不会破坏已保存连接；
- 旧 fallback 注释、位置数组、冗余 Family 门禁和无调用 Resolver 清理完成；
- 相关单测、交互验证、全仓 typecheck/lint/unit 均通过；
- 最终提交遵循 Conventional Commit，并在实施记录中列出实际删除的旧分支与验证证据。

## 9. 实施记录（2026-08-28）

- 新增 `active | inactive | unknown` 套餐证据归一：仅 `no_plan` 为 inactive；未知快照不再误报未购买，
  也不再越权解释 Account 断开状态。
- 登录与启动恢复只在 Start 明确 inactive 时破坏已有选择；`unavailable`、请求异常和不完整快照均保留。
- OAuth、Team 导航、Sidebar、Composer 与企业套餐查询改为读取具名 `ModelProviderFamilySpec`，删除位置数组、
  Family Provider ID 三元映射和无生产调用的第二套选择 Resolver。
- Z.AI/BigModel Team 管理地址进入 Family Spec；状态卡按 `providerId` 解析 Family，不再读取展示名称。
- 四条手写 entitlement Hook 链收口为一个 Family Hook，并显式调用 Z.AI、BigModel 两次；Start 与 Coding
  继续使用独立 Provider ID、Account Access 和 cache key。
- 历史商品缺失 Family 的 BigModel 解释集中到单一规范化函数，导航和使用量投影不再各自写 fallback。
- 删除“Coding 激活后禁用 Start fallback”的失真注释；Start 现在明确是独立查询目标。

阶段 Review 证据：相关 6 个 UI 测试文件共 278 条测试通过；`pnpm typecheck` 通过；`pnpm lint` 0 error
（33 条均为本阶段外既存 warning）；`git diff --check` 通过。最终 `test:unit/fmt:check` 随全部阶段统一执行。

后续回归证据：Todo 57 已在同一 Provider Refactor 最终基线上完成根 `typecheck`、`lint`、全量 unit
（12,797 条通过）以及 macOS Provider/Account/Selection WDIO 实跑。Todo 36 不再保留独立的“等待最终回归”状态。
