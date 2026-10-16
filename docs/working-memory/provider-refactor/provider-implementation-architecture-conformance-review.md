# Provider 实现架构一致性审查

## 文档状态

- 状态：讨论草案
- 审查基线：`bcb119437370b74b6460b89975afae2ef5cdea33..6ddf899d6863d7cdede91a47fa6d718541284326`
- 审查对象：Provider Refactor 已提交的生产实现
- 不在本次范围：基线之前的既有老代码清理、M4 Model Execution Cutover、当前工作区未提交改动、远程配置同步产品能力
- 目的：记录当前实现相对既定 Design 的一致性、结构性桥接和待裁决边界；本文不直接批准最终方案

“干净”容易被理解为代码风格、文件大小或主观整洁度。本文使用“架构一致性”，专门检查实现是否贯彻已经确认的状态归属、Overlay 顺序、Source/Repository、Registry、Facade 和 Account 边界。

## 与老代码清理审查的分工

当前同时存在另一项以“清理既有老代码”为重点的审查。两项审查分工如下：

```text
老代码清理审查
└─ 基线之前已经存在的旧实现、旧入口和兼容链

本审查
└─ Provider Refactor 新增代码
   ├─ 是否直接表达目标 Design
   ├─ 是否新增了长期合理的边界 Adapter
   └─ 是否把旧问题重新包装成新的桥接层
```

本审查不枚举或规划删除基线之前的老代码。若一段新增代码连接旧系统，本审查只判断“这段新增连接是否是合理的临时 Adapter，是否泄漏进目标领域，是否具备明确退出边界”；被连接的旧实现本身归老代码清理审查。

文中约 2,850 行显式 legacy/transition glue 仅用于说明新增代码的总体构成和避免统计误解，不构成本审查的老代码整改清单。两个审查可以互相引用依赖，但不能重复认领同一清理任务。

## 审查目标

本次审查回答以下问题：

1. 新增生产代码中，哪些是真正的目标态领域实现？
2. 哪些是跨进程、序列化、文件和网络边界长期需要的 Adapter？
3. 哪些代码虽然位于正式主链路，但本质上是在弥补抽象没有贯彻到底产生的结构性桥接？
4. 哪些问题已经是 Design 与实现的直接冲突，哪些仍需要产品或架构裁决？
5. 后续清理应删除什么、改写什么，又必须保留哪些合理边界？

审查不按文件名判断性质。一个没有 `legacy` 或 `compat` 名称的文件，也可能在反向推导状态、重复解析隐式协议或跨层补洞；一个 Adapter 文件也可能是目标架构长期需要的正式组成部分。

## 分类口径

| 分类             | 定义                                                   | 典型例子                                                        |
| ---------------- | ------------------------------------------------------ | --------------------------------------------------------------- |
| 目标态核心实现   | 直接表达已经确认的领域模型和状态归属                   | Config Overlay、Resolver、Registry、Facade、Account Config 投影 |
| 长期边界 Adapter | 目标架构中仍然需要的形态转换                           | RPC 序列化、Node 文件 IO、网络 API Adapter                      |
| 结构性桥接       | 因权威状态或抽象边界缺失而反向推导、重复解析或维护例外 | Effective 反推 Personal、UI 解析 `accessId`                     |
| 显式迁移胶水     | 为旧格式或旧调用方保留的临时兼容                       | legacy importer、旧 Provider store reader                       |
| 机械样板         | 不偏离 Design，但实现方式造成重复                      | Config Input/Object/Class、Overlay、`toJSON()`、完整性校验样板  |

## 当前数量判断

此前约 19,250 行被归为“核心 Design 实现”。重新按语义链路审查后，暂估如下：

| 分类                       |       暂估新增行 | 说明                     |
| -------------------------- | ---------------: | ------------------------ |
| 真正贯彻目标设计           | 约 14,000–15,000 | 仍是新增实现主体         |
| 长期合理的边界 Adapter     |   约 1,400–1,900 | 不应为了减少行数而删除   |
| 抽象不完整造成的结构性桥接 |   约 2,100–2,800 | 本文重点                 |
| 机械性抽象样板             |       约 600–900 | 可优化，但不等于架构偏离 |

这些是语义估算，不是可以由路径机械计算的精确 LOC。约 4,000–4,800 行正式实现处于受影响代码面中，但同一文件通常同时含有正确领域逻辑和桥接逻辑；预计真正可以通过重新划定边界删除或显著缩减的结构性桥接约为 2,100–2,800 行。

显式 legacy/transition glue 约 2,850 行，不在上述 19,250 行内部。两者合并后，生产新增代码中的广义迁移或结构债务约为 5,000–5,700 行。

## Feature Summary

| Field            | Value                                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Developer intent | 审查 Provider Refactor 正式实现是否贯彻既定架构，并为后续裁决建立问题清单                                                                        |
| Capability       | Provider Config、Account Overlay、Registry、Settings/Selection Facade、Repository                                                                |
| Change layer     | option-source / validation / commit-effect / persistence                                                                                         |
| Operating mode   | impact-only；只记录发现和候选方向                                                                                                                |
| Primary seeds    | `ProviderConfigService`、`projectEffectiveProvidersToPersonalConfig`、`ProviderConfigDocument`、`AccountProviderService`、`ModelSelectionFacade` |
| Out of scope     | M4、Model 生命周期、远程配置同步产品能力、队列与恢复语义                                                                                         |

## 已确认的目标结构

Provider Overlay 顺序保持既有裁决：

```text
ZCode Built-in Provider Config
              |
              v
 overlay Account Built-in Provider Config
              |
              v
Effective Built-in Provider Config
              |
              v
 overlay Personal Provider Config
              |
              v
    Effective Provider Config
```

`Effective Built-in Provider Config` 表示“ZCode Built-in 经当前 Account Built-in 事实解析和约束后的
结果”。它是正式概念层和 Settings 只读基线，不要求新增持久化对象或独立 Source；实现可以把它保持为
Resolver/Registry Snapshot 中的推导值。

两条不变量同时成立：

- Account 只处理 Built-in 已声明的账号 Provider，不读取或约束 Personal-only Provider。
- Personal 在 Account 之后生效，是用户的最终覆盖。

## 当前发现

### F1. Settings 保存链路从 Effective 反向重建 Personal

状态：`must-inspect`、Design 冲突候选、最高优先级。

当前链路：

```text
Effective Provider Config
          |
          v
Renderer 克隆完整 Effective Draft
          |
          v
saveEffectiveProvider()
          |
          v
只相对 Built-in/Official 计算 Personal diff
          |
          +--> 特判丢弃 Account accessId
          `--> 其他 Account 结果可能进入 Personal
```

证据：

- `packages/ui/src/lib/providerSettingsFormProjection.ts` 将 `effectiveConfig` 和模型 `effectiveConfig` 完整复制为表单状态。
- `packages/ui/src/lib/providerPersonalSave.ts` 将完整 Draft 交给 `saveEffectiveProvider()`。
- `packages/provider/src/config-service.ts` 保存时只读取 Built-in/Official Source。
- `packages/provider/src/personal-config-projection.ts` 只能手工排除 `zhipu-account.accessId`。

风险：

- Account 返回的 Built-in 模型成员可能在用户修改无关字段时被固化进 Personal。
- 后续账号模型成员变化会被 Personal 的整列表覆盖遮蔽。
- 每增加一个 Account 动态字段，都可能继续增加字段黑名单。
- 保存基线与产生 Effective Config 的 Overlay 基线不一致。

Design 内部也存在需要裁决的表述冲突：

- `registry/configuration.md` 要求 Personal 保持稀疏，Effective View 不得反向污染 Personal。
- `registry/settings.md` 写成相对 ZCode Built-in 基线计算 Personal。

候选方向，不在本文直接裁决：

1. 保存完整 Effective Draft，但相对同一 revision 的 `Effective Built-in Provider Config` 计算 Personal。
2. Renderer 或 Facade 直接提交稀疏 Personal 意图，不再反向 diff 完整 Effective Draft。
3. 保留当前 Built-in diff 并继续维护 Account 字段例外；该方案会延续结构性桥接，不建议作为目标态。

#### 后续裁决（2026-08-24）

本项已经在正式 Design 中裁决，不再保留上述三选一：

- Settings 直接感知 `Effective Built-in Provider Config` 与稀疏 Personal Config，只提交用户实际修改的
  稀疏 Personal Overlay；Renderer 不从 Effective Config 反推 Personal；
- 单个完整暴露给用户的配置项继续整体替代，未触碰的继承值不能因无关保存而物化；
- Provider 模型成员不再使用三层共同覆盖的 `models[]`，而是拆成 Built-in/Account Built-in 拥有的
  `builtinModelIds` 与 Personal 拥有的 `modelIds`；
- 两个成员字段重名时形成显式 Model ID 冲突。冲突模型的旧 Personal 配置不可执行，Settings、模型
  选择器和模型编辑器共同显示诊断并要求用户重命名或删除 Personal 模型；
- Model Config 增加 `enabled`，Provider 页面直接提供启停操作。Built-in ID 不可删除，用户通过
  `enabled` 管理普通模型选择器中的候选集合。

正式事实见
[`design/registry/model-membership-and-enablement.md`](./design/registry/model-membership-and-enablement.md)
和 [`design/registry/configuration.md`](./design/registry/configuration.md)。

### F2. `Config Document` 已进入 Provider 领域层

状态：`must-inspect`、已确认与 Design 不一致。

Design 规定：Config Map、Rules 和 Effective Config 是领域对象；`schemaVersion`、JSON 外壳、文件名和 migration 属于 Source/Repository。

当前实现却公开了：

- `packages/provider/src/config/document.ts` 中的 `ProviderConfigDocument`；
- `packages/provider/src/model-selection-config.ts` 中的 `ModelSelectionConfigDocument`；
- 返回 `ProviderConfigDocument` 的 Personal 投影函数；
- 围绕 Document 传递的 Node Repository、Official Source 和 Importer。

版本迁移、JSON 校验、备份和原子写是长期需要的持久化能力。问题不是这些代码存在，而是 Repository envelope 被塑造成了 Provider Domain 的公共对象。

候选目标边界：

```text
Provider Domain
└─ ProviderConfigMap + ModelConfigRules + Layer Update
                    |
                    v
Repository Boundary
├─ schemaVersion
├─ JSON envelope
├─ migration
├─ backup
└─ atomic write
```

待裁决点是公开 API 的最终形态和迁移顺序，而不是是否保留版本化存储。

### F3. `accessId` 被多层当作产品协议解析

状态：`must-inspect`、边界设计待裁决。

`accessId` 的既定职责是稳定、非敏感的账号连接身份。当前它还被多层用于推导：

- Start / Individual / Team Plan；
- Provider Family；
- organization/project；
- Credential key；
- UI 分组、标签和 Badge。

当前 Account Resolver、Request Auth、Team Plan Runtime Key 和 UI 分别解析 `start-plan:`、`coding-plan:`、`team-plan:` 等前缀。尤其 `packages/ui/src/lib/modelSelectionGroups.ts` 直接通过 `accessId.startsWith(...)` 决定产品展示。

这使 accessId 从 opaque identity 变成了没有集中类型定义的跨层字符串协议。

候选方向：

```text
Provider Config
└─ accessId（保持稳定、opaque）

Account/Product Facade View
├─ family
├─ planKind
├─ connectionId
├─ organization/project display
└─ presentation label/badge
```

这个候选不要求把套餐展示字段加入 Provider Config，也不建立新的 Registry Source。需要讨论的是：类型化 Account/Product 投影由哪个现有 Service/Facade 拥有，以及请求鉴权侧如何保证只有一个 accessId parser。

### F4. Account last-known-good 使用整份原子快照（已裁决）

Account Built-in Provider Config 是同一次 Settings、当前账号、连接选择和权益解析产生的原子快照。刷新
全部成功时整体发布；任一外部依赖失败时不发布部分新结果，继续保留整份上一版成功 Snapshot。

本轮不实现按 Family 或按 Provider 的局部 last-known-good。短暂陈旧由后续刷新恢复；动态凭据仍由
Request Auth 和服务端鉴权，不能因为展示旧 Snapshot 绕过授权。相比混合多个解析代次，整份快照语义更
简单，也不需要维护账号代次、选择 revision 和依赖故障作用域。

当前 `unknown + previousProviders` 的逐 Provider 分支属于与目标语义重叠的半套恢复机制；Todo 07 修改
Account Resolver 时可以随手简化，但不为故障隔离建立独立任务。

### F5. Selection Facade 的 View 与校验边界不一致

状态：已裁决，进入
[`steps/todo-12-model-selection-validation-boundary-cutover.md`](./steps/todo-12-model-selection-validation-boundary-cutover.md)。

`ModelSelectionFacade.getView()` 过滤 hidden Provider，但 `validate()` 直接委托完整 Registry。因此用户在候选 View 中看不到的 hidden Provider，仍可能通过用户 Facade 的校验。

这与既有设计不一致：

- 用户候选和用户选择校验以 Selection Facade 的 visible candidates 为准；
- 内部产品能力按精确 ID 使用完整 Registry。

进一步调用审查确认，普通 UI 只消费 View，Facade `validate()` 的主要生产调用方反而是 hidden Off-Peak
派发。最终裁决是不在用户 Facade 保留执行校验：删除 Facade/Service `validate()`，Off-Peak 改用内部 Registry
窄提前检查；所有 Selection 在真正提交任务、构建 Model 时由当前 Agent Registry/ModelFactory 最终校验。

### F6. Provider Runtime composition 存在重复外壳

状态：已进入待裁决草案
[`steps/todo-11-provider-runtime-composition-boundary-cleanup.md`](./steps/todo-11-provider-runtime-composition-boundary-cleanup.md)，
不得实施。

以下实现分别包装了相近的 Config/Registry 生命周期：

- `packages/provider-node/src/provider-config-runtime.ts`
- `packages/provider-node/src/provider-registry-runtime.ts`
- `packages/services/src/model-provider/providerRuntime.ts`
- `packages/services/src/model-provider/providerConfigRuntime.ts`

文件路径注入、watcher、RPC Facade 和 Account Source 都是合理边界。问题是 Empty Account Source、start/dispose、ready promise 和 Config/Registry 组装存在重复。

进一步代码审查确认，这四层对应两个不同的真实组合根：Host 负责 Settings/Selection，Agent 进程负责
ModelFactory/执行；两边各自拥有 Registry 是正确边界。草案记录了共享 Node Config 资源加两个显式组合根的
候选方向，同时保留当前结构和统一 Runtime 等备选方案，等待逐项裁决。

另发现一个具体生命周期 bug candidate：`startProcessProviderRegistryRuntime()` 的外层 `dispose()` 还负责
Model Selection Repository，并在 Standalone 模式管理 Credential subscription；Protocol entrypoint 直接调用
内层 `runtime.dispose()`，会绕过外层 Repository 清理。草案阶段只记录，不顺手修改。

### F7. 物理 `official` 命名仍向领域 API 扩散

状态：已裁决，进入
[`steps/todo-10-zcode-builtin-provider-config-naming-cutover.md`](./steps/todo-10-zcode-builtin-provider-config-naming-cutover.md)。

当前 `officialProviders`、`officialSource` 和 `OfficialProviderConfigSource` 仍大量存在。领域语义统一为
ZCode Built-in Provider Config。

领域类型、服务、Source、Facade、变量、物理文件、环境变量和 SEA asset 必须在同一次切换中统一迁移到
`zcodeBuiltin*` / `zcode-builtin` 语义。当前分支尚未上线，不保留旧字段、旧路径、alias、fallback 或 importer。

### F8. 完整 Model Properties 仍被作为未知态跨层传播

状态：`must-inspect`、Design 已明确、待实施。

目标 `ModelProperties` 已把所有 `support_*` 定义为必填 boolean，Built-in 通用 Model Rule 也负责提供完整
默认。但是 Resolver 在 `validateComplete()` 成功后仍把稀疏 `ModelConfig` 类型直接发布给 Registry，导致
下游反复适配一个实际上不应存在的“未知能力”状态：

- Bootstrap Runtime 用 `requireCompleteProperties()` 再次逐字段判断并复制；
- Selection 只有在全部字段存在时才发送 Protocol `properties`，否则静默省略；
- Protocol 的格式叶子必填，但 `ZCodeModelOption.properties` 整体 optional；
- Settings Draft 用 `support_text ?? true`、其他格式 `?? false` 补默认；
- Adapter 已解析模型和消息转换继续接受 optional `properties/input_format`；
- 旧 Catalog merge 在缺能力时硬编码 true/false。

```text
Sparse Model Config Rule                    正确
          |
          v
resolve + validateComplete
          |
          +--> 继续发布 Sparse ModelConfig  当前根因
                       |
                       +--> Runtime 再校验
                       +--> Protocol 可省略
                       +--> Settings 补默认
                       `--> Adapter optional
```

目标是在 Resolver/Registry 发布处关闭类型边界：Rule 与 Personal Overlay 可以稀疏，Effective/Registry
Model 及 Protocol、Active Model、Runtime、Adapter 必须只看到完整 boolean。缺字段是配置错误，不是
`unknown`；下游不得补默认或静默省略。

这不涉及开放 JSON 的 TypeScript `unknown`。Legacy importer 仍可在一次性边界读取旧格式，但只能产生由明确旧事实构成的稀疏 Personal
Config；缺失项继承 Built-in Rule，不能补迁移默认或形成通用 Runtime fallback。强制升级跨过兼容窗口后，
无版本旧格式 importer、parser、Catalog 依赖和测试整体删除。实施计划见
[`steps/todo-03-provider-model-ownership-and-property-totality.md`](./steps/todo-03-provider-model-ownership-and-property-totality.md)。

## UI Surface Matrix

| User scenario      | UI entry                           | Display/draft owner          | Default/inherit source        | Validation/gating                      | Commit action             | Authority/persistence   | Must remain isolated from          |
| ------------------ | ---------------------------------- | ---------------------------- | ----------------------------- | -------------------------------------- | ------------------------- | ----------------------- | ---------------------------------- |
| 编辑 Provider      | Provider Settings                  | Renderer 稀疏 Personal Draft | Effective Built-in + Personal | Facade Preview / Registry completeness | 保存 Personal Overlay     | Personal Repository     | Account 动态结果不能被无意固化     |
| 选择用户可见模型   | Model selector                     | 各 Surface 本地 Draft        | Model Selection Facade View   | Selection Facade validate              | 各 Surface 自己的提交动作 | 各自状态 owner          | hidden Provider、其他 Surface 状态 |
| 展示套餐 Provider  | Model selector / Provider Settings | Renderer projection          | Effective Provider + 产品数据 | Account availability                   | 无或各产品连接动作        | Account/Product Service | UI 不解析请求鉴权协议              |
| 启停模型           | Provider 模型列表 / 模型编辑器     | Renderer Personal Draft      | Effective Model Config        | enabled + completeness + conflict      | 保存 Personal 精确 Rule   | Personal Repository     | 不修改 Built-in 成员或服务端授权   |
| 处理 Model ID 冲突 | Provider 列表 / 编辑器 / 选择器    | Renderer 只显示权威诊断      | source-aware Model Inventory  | Resolver `id-conflict`                 | 重命名或删除 Personal 项  | Personal Repository     | 不自动改写 Personal 或选择来源     |

## State Owners And Commit Sinks

| State/fact                       | Draft/display owner          | Authoritative owner          | Commit command/service    | Persistence/cache                    |
| -------------------------------- | ---------------------------- | ---------------------------- | ------------------------- | ------------------------------------ |
| Built-in Provider/Model Config   | Settings View 只读投影       | Built-in Config Source       | 产品发布                  | `config/provider/zcode-builtin.json` |
| Account Built-in Provider Config | Settings/Selection View 投影 | Account Provider Service     | Account refresh           | process-local last-known-good        |
| Personal Provider/Model Config   | Renderer Draft               | Personal Config Repository   | Provider Settings Service | 当前 Environment Personal Config     |
| Effective Provider Config        | Facade View                  | Resolver/Registry Snapshot   | Source refresh/rebuild    | 不独立持久化                         |
| Account request credential       | UI 不拥有                    | Account Request Auth Service | 每次 request attempt      | Credential Store/动态接口            |
| 用户可见模型候选                 | 各 Surface 展示              | Model Selection Facade       | Registry refresh          | 不独立持久化                         |
| Built-in 模型成员                | Settings View 只读投影       | Effective Built-in Config    | Built-in/Account refresh  | `builtinModelIds`                    |
| Personal 模型成员                | Renderer Personal Draft      | Personal Config Repository   | Provider Settings Service | `modelIds`                           |
| Model ID 冲突                    | Renderer 只读诊断            | Resolver/Registry Snapshot   | Source refresh/rebuild    | 不独立持久化                         |
| Model enabled                    | Renderer Personal Draft      | Effective Model Config       | Personal Rule update      | Personal Model Config Rules          |

## Feature Relationships

| Rank           | From                         | Semantic edge                   | To                         | Why inspect it                                 |
| -------------- | ---------------------------- | ------------------------------- | -------------------------- | ---------------------------------------------- |
| must-inspect   | Provider Settings Draft      | commits-effective-config-to     | Personal Config projection | 当前存在 Effective 反推和 Account 字段泄漏风险 |
| must-inspect   | Account Provider Service     | overlays                        | Built-in Provider Config   | 决定 Personal 保存的正确基线                   |
| must-inspect   | Account connection identity  | authenticates-through           | Account Request Auth       | accessId 必须稳定且解析集中                    |
| must-inspect   | Account product presentation | projects-to                     | Settings/Selection UI      | UI 不应解析鉴权 identity 字符串                |
| must-inspect   | Selection Facade             | validates-visible-candidate-for | User selection surfaces    | 当前 validate 使用完整 Registry                |
| must-inspect   | Built-in/Personal membership | conflicts-by-same-model-id      | Settings/Selection/Editor  | 同一执行身份不能静默选择配置来源               |
| must-inspect   | Personal Model Rule          | controls-enabled-for            | Model Selection Facade     | disabled 留在 Settings，但退出普通候选         |
| must-inspect   | Complete Model Config        | freezes-properties-for          | Protocol/Model/Runtime     | 稀疏类型泄漏导致多层 unknown 兼容              |
| should-inspect | Repository envelope          | serializes                      | Provider Config Layer      | versioning 必须保留但不进入领域层              |
| should-inspect | Provider Runtime composition | assembles                       | Config/Registry/Facade     | 可以减少重复但不能破坏 Source 边界             |

## Must-Preserve Invariants

1. Provider Overlay 顺序始终是 ZCode Built-in -> Account Built-in -> Personal。
2. Account Built-in 只读取 ZCode Built-in account Provider，不读取 Personal-only Provider。
3. Personal 是最终用户覆盖，同时保持稀疏；未编辑的 Account 动态事实不能被意外写入 Personal。
4. Effective Config 不独立持久化，也不能成为反向污染上游 Source 的事实源。
5. `accessId` 是非敏感连接身份，不是模型静态能力、服务端授权结果或 UI 产品协议。
6. Account 请求凭据不进入 Provider Config、Settings View 或持久化 Personal Config。
7. Visibility 只影响用户 Facade；内部精确 Registry lookup 不引入权限或“受信”概念。
8. JSON envelope、schema version、migration 和原子写属于 Repository，不属于 Provider Domain。
9. Desktop、Web、Mobile 和 Remote Environment 使用各自目标 Environment 的 Provider Service；本次审查不改变现有远端同步产品边界。
10. Model Rule 可以稀疏；`resolve + validateComplete` 以后的 Effective/Registry Model Properties 必须完整，
    下游不得维护能力 unknown 或补默认。
11. Legacy importer 只迁移明确旧事实，不猜能力；强制升级跨过兼容窗口后删除整条无版本旧格式导入链，
    但正常 schemaVersion migration 继续属于 Repository。

## 合理 Adapter 与禁止误删项

以下代码即使行数较多，也不能仅以“胶水”为由删除：

- Node Repository 的文件锁、原子写、watcher、备份和 migration；
- RPC Service 将 Config Class 投影为普通可序列化对象；
- Account API、Start Plan、Personal Coding Plan、Team Plan 的真实业务差异；
- Provider Source/Repository 接口和 process-local Registry；
- SEA 环境下 Built-in 配置物理 materialization；
- Protocol 运行时 Schema；
- Config 三态 Overlay 和完整性校验。

`ModelPropertiesConfig` 等 Config Class 存在明显机械样板，但这是声明式 Overlay 工具不足带来的实现成本，不自动等于架构偏离。

## Evidence And Limitations

本轮沿以下路径检查到深度 2：

```text
Provider Settings UI
  -> Provider Settings Service/Facade
  -> ProviderConfigService
  -> Personal projection
  -> Personal Repository

Built-in Config
  -> Account connection resolver
  -> Account Provider Service
  -> Provider Resolver/Registry
  -> Settings/Selection Facade

accessId
  -> Account Config
  -> Request Auth
  -> Product UI presentation
```

当前环境没有提供可调用的 codegraph 接口；直接调用方和状态链使用当前代码、`rg`、目标 Design 和测试证据核对。进入实现前应再运行一次 codegraph impact/affected-tests 检查，确认没有新增调用方。

## Graph Drift Candidates

| Candidate                                  | Live-code evidence                        | Missing/stale graph relation                                               | Proposed follow-up                                   |
| ------------------------------------------ | ----------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------- |
| Effective -> Personal 反向投影             | Settings Draft 和 `saveEffectiveProvider` | Feature graph 只记录 Settings 持久化，没有记录 Account 基线依赖            | 裁决保存语义后补图                                   |
| Account product presentation 解析 accessId | `modelSelectionGroups.ts` 等              | Provider Registry 与 Plan Entitlements 之间缺少 presentation projection 边 | 确认 Facade owner 后补图                             |
| Selection Facade hidden validation         | View 过滤、validate 委托完整 Registry     | 图中没有区分 visible validation 和 internal exact validation               | 确认 API 语义后补图                                  |
| Model member ownership / id conflict       | 新 Design 已确认                          | 图中原本没有 Built-in/Personal 成员及冲突边                                | 已补 capability invariant 与 Settings/Selection edge |
| Complete Properties -> Runtime             | Registry 后仍有 optional/默认兼容         | 目标边已存在，但实现未关闭 Sparse Rule 到 Complete Model 的类型边界        | 按 TODO 03 收紧 Registry 发布类型并删除下游 fallback |

本文处于 impact-only 阶段，不直接修改 feature graph。

## 待讨论与裁决

### D1. Personal 保存的权威输入（已裁决）

- Renderer 直接提交实际修改产生的稀疏 Personal Overlay；
- Settings View 同时提供 Effective Built-in、Personal 与权威 Effective Config，但 Effective 不是保存输入；
- 完整暴露的配置项一旦修改就保存完整替代值，未修改项不物化。

### D2. 保存时 Account 基线的一致性（已裁决）

保存携带 Settings View revision；Service 在当前 Effective Built-in 上应用 Personal Overlay，过期响应不能
覆盖更新 Draft。Account/Built-in 模型成员进入 `builtinModelIds`，用户成员进入 `modelIds`，因此上游
刷新不再需要对一个共享成员列表做 rebase。重名由显式 `id-conflict` 处理。

### D3. Repository envelope API

需要确认 `ProviderConfigDocument` 和 `ModelSelectionConfigDocument` 是移动到 `provider-node` 私有实现，还是保留为 Repository 包内部的非领域序列化 helper；两种方案都不得继续作为 Provider Domain 的公共状态。

### D4. Account/Product 类型化投影的 owner

需要在现有 Account Service、Provider Settings Facade 或独立产品 Facade 中选择 owner。禁止把 UI 展示语义继续编码进 accessId，也不应把产品 UI 字段塞进 Provider Config。

### D5. Account 可恢复失败粒度（已裁决）

不建立局部失败粒度。Account Built-in Config 成功时整份原子发布，失败时整份保留上一版成功 Snapshot。

### D6. Selection Facade validate 的调用者语义

已裁决：用户 Facade 只投影 visible 候选，不再公开 `validate()`。普通任务在 ModelFactory 构建边界权威校验；
Off-Peak 等内部产品直接使用 Registry 的精确校验，visibility 不成为权限或特殊执行身份。

### D7. Runtime composition 收口时机

已建立 Todo 11 草案保存现状、两个进程组合根、候选方案和待裁决项。当前明确搁置；它可以独立于前面语义
裁决，但在人工理解并逐项确认以前不得更新正式 Design 或实施。

## 建议讨论顺序

1. D1 + D2 已完成；实现审查应据此删除 Effective -> Personal 反向投影和共享 `models[]` 桥接。
2. D3：确认领域与 Repository 的序列化边界。
3. D4：确认 Account identity 与产品投影；D5 已裁决为整份原子 Snapshot。
4. D6：已裁决并进入 Todo 12，等待实施。
5. D7：Todo 11 已保存草案，待后续恢复讨论，不进入当前实施序列。

每一项裁决完成后，先回写 Provider Design，再制定测试和实现计划。本文负责保留审查轨迹，不应替代最终 Design。
