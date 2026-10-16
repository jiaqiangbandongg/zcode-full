# Todo 104：上线前持久化 Schema 梳理与精修

> 后续裁决（2026-09-11）：[Todo130](todo-130-manual-model-config-editable-field-boundary.md) 已取代本文中“推荐未就绪禁用开关／手动整份配置固化与完整校验”的相关规则：仅保存中禁用，手动只要求可编辑字段，系统字段继续解析。**Todo130 待执行**；下文旧实现与验收保留为历史，不代表新语义已经落地。

> 2026-09-10 后续数据库专项：[Todo109](./todo-109-database-migration-consolidation-and-rollback-readability.md) 承接全库 migration 收口及回滚内容可读性。沿用已裁决转换语义，保留旧字段/值；未执行本次 migration 时可按明确旧来源重建目标新字段，不兼容未上线中间态。已完成 migration 不重跑，缺新配置不得阻碍内容读取。尽量不双写，内容不可读时最小必要双写。本文既有实现证据保留，冲突的迁移/兼容条款在数据库范围内以后续专项为准；不影响非数据库裁决。

> 状态：功能实现与整批复审已收口，最终制品验收仍有限制；2026-09-10。6.18 三项回滚快照、核心 Schema/规则外层/名称/模板、Personal 同文件默认选择及分发、运行路径和来源标识均已实现。155 文件 1296 测试、Wiki/闲时 156 测试及 Pro 设置/会话恢复验证通过；CLI 迁移测试修正真实旧数据播种后通过。Server/SEA 的既有打包问题和 Windows 实机限制见账本，不宣称所有制品均可上线。6.19 的 13 项配套内容逐项复核；Subagent Markdown 沿用 Todo97，本 Todo 不改。
> 当前授权（2026-09-10 更新）：用户已明确授权执行正确且可按既有裁决决定的部分；真正需要新裁决的部分保留。下文“仅讨论／尚未授权／未实施”保留为来源历史，不代表本轮授权或完成状态。
> 来源：m2 原 Todo99，固定提交 02dfc1b45819626dc6d1614a8e528c72eaed31af；为避免与 Worker 修复 Todo99、已完成调查 Todo100 重号，合入时改编号为 Todo104。实施状态与证据统一见 [实施账本](../research/todo104-schema-implementation-ledger.md)。
> 当前设计入口：[Design V2](../design-v2/design.md)。本文保留本轮背景、裁决和目标结构，不把未实施的改名写成现行代码事实。

### 执行粒度补充（2026-09-10，最新用户要求）

不要每改一个字段或小点就执行大规模回归和 Pro 验证。已完成提交及证据保留，后续按完整功能链批量实施，不再把 B2 内的细小改名拆成各自一套完整验收。

- 开发中：先写有区分力的测试，运行直接覆盖当前改动的定向测试；必要时做局部类型检查。字段传播、fixture 更新等小步骤不重复触发全仓测试、全仓类型检查、共享构建或 Pro 重建。
- 批次划分：剩余 Provider/Model 规则最终结构、名称/模板归属及对应读写入口作为完整规则批次推进；与 Personal 新 envelope 强耦合的默认选择同文件保存/分发配套一起接通后再验收。运行路径与来源 revision 作为另一完整链路批次。允许因实际耦合合并批次，不为了小提交数拆分工作。
- 批次收口：统一运行所需类型检查、lint、架构检查和相关跨域回归，复审所有条款及上下游；已通过且未受后续变更影响的证据不重复制作。
- Pro/E2E：留到涉及的完整设置/执行链路稳定后共享构建、批量验证；不为每个结构字段分别重建跑同一套用例。先完成静态及定向验证，再启动昂贵验证，避免边查类型边跑 Pro 导致重复重建。
- 失败先分类。只有新变更、修复或尚未证明的关键边界才重跑对应检查；既有问题记录，不将每次失败扩成独立修复。真实交互缺陷可提前定向复现，但不以此重新启动全套回归。
- Goal 全部范围、先 spec/测试、最终完整复审与关键验收要求不变；仅调整执行与验证粒度，不省略必要覆盖，不将未测写成通过。

## 1. 背景与讨论方式

本轮从“相比 staging，本分支新增了哪些可能持久化的 schema”开始。用户希望在上线前把字段名字和结构设计清楚，避免正式发布后才发现问题、被迫迁移用户数据。Model Selection、Provider Config、Model Config 是首先关注的核心结构；审阅范围不止这三个名称，后续仍要沿实际存储位置梳理其他新增结构。

用户允许对本分支尚未正式发布的 schema 整体重命名、重组，以长期设计为准；staging 已发布数据的升级兼容单独保留。这不等于已经裁决所有兼容、回滚或命名策略，也不代表授权立即修改实现。

本轮明确的协作约定：

- 先梳理，再从核心结构开始逐项讨论。用户明确纠正过“不是让你直接改，而是咱俩讨论怎么改”。
- “落盘”只更新裁决文档。此前误把“前两个最好修复一下”当成实施授权，已撤回当轮全部代码、测试及临时文档修改；没有产品提交。本次重新落盘的是待修裁决，不是修复完成。
- 聚焦 schema。字段、类型、可选性、null、嵌套等是讨论角度，不机械套一份通用 checklist。
- 发现有代码依据的具体问题可以提出，但不能把猜测、未确认的建议写成已发现缺陷或用户裁决。
- 用户询问字段调用时，先回答实际调用；不自动扩展成架构整改任务。
- 用户随后明确要求“别太激进”：没有明确收益的纯命名和包裹精简不继续扩大；刷新 / 分发记录按 6.13 的收缩方案实施，不恢复已经撤回的建议。
- 风险判断以可验证性为主：用户明确“容易验证的都不算高风险”。工作量大、影响面广不单独作为撤回设计的理由；需要说明场景能否稳定构造、结果能否判定，以及现有测试与待补验证的区别。全面复评见 6.17。
- 讨论和落盘统一用接口按层展示 schema：先顶层，再分别展示成员结构；每层用一句话说明修改点，再给该层代码。接口字段直接展开，不用 Omit 或中间 Identity 类型遮住本层结构；实施时仍复用 schema 并推导类型，不把展示接口复制成另一套实现定义。同一层的普通字段不逐个长篇解释，不一次塞进一个完整嵌套大结构。
- 每轮总结只覆盖当前讨论的结构，不重复捎带前面已确认的其他结构；落盘时则保留全部历史裁决。
- 文件 / 数据表、schemaVersion、revision 分开逐项讨论；范围限于相比 staging 新增或改变的持久化结构，不展开无关的既有机制。
- 已确定的结构调整分别见第 3、5、6 节；记录裁决不等于授权实施，其他结构也不能因为列入本 Todo 就自动实施。
- 最新范围收缩：用户只裁决本 Todo 要改的内容，其他 Todo 及本分支已有但本 Todo 不改的行为不再列为复审任务。允许遗漏另记，重点是已授权改动不要破坏既有行为；不能为了追求全覆盖顺手扩项。

### 1.1 Schema 与类型的唯一事实来源（本轮新增原则）

对本 Todo 涉及的持久化 / 协议数据结构，schema 是字段、嵌套及约束的唯一事实来源。禁止已有 schema，却再独立手写一份同语义 interface / type 字段清单；类型从 schema 推导，或通过派生类型复用。

- 普通数据类型使用 `z.infer` / `z.output`；schema 带 transform 且需要表达解析前输入时，使用 `z.input`，不能把输入数据与转换后的 class 混成同一类型。
- 完整、稀疏覆盖、固定模式等变体复用基础 schema，通过 extend / pick / omit 等组合并明确处理嵌套必填约束，不分别抄写字段。只对顶层 required 并不能使全部嵌套成员完整。
- 保存校验和解析校验复用相应 schema 及共享内容约束，不再维护平行的完整性字段清单。编辑时先确定智能 / 手动规则所属集合，再用对应 schema 校验完整规则；当前代码的 useRecommendedConfig 及中间方案 useSmartConfig 不进入最终持久化结构。
- `overlay`、`toJSON` 等有行为的 class 可以保留；class 的存在不等于重复数据 schema。构造输入、序列化形状以及必要的类型收紧仍须复用推导类型。
- 当前 schema 模块依赖 class；实施时基础数据 schema 与行为类应保持单向依赖，不能为推导类型制造循环引用，也不能靠 any / 类型断言假装已完成推导。
- 本文 interface 代码块用于逐层沟通目标结构，不代表实施时要求手写第二套类型定义。

本原则已获用户要求纳入 Todo；当前只完成定向核查和记录，未改实现。

### 1.2 阅读与实施依据

本 Todo 的最终目标结构优先于本文明确标为“此前方案”“当前代码”的历史说明；历史名称只用于定位改造入口，不作为第二套可接受格式。进入实施后，本文裁决取代旧设计中对应的冲突部分，并同步更新 Design V2 的现行描述。未涉及的行为沿用现状；“没有另作裁决”不等于可以自行补一套新机制。

本文接口只展示字段形状，未在 TypeScript 中表达的现有运行时约束仍须保留，例如非空 ID、正整数上限、非空选项数组、合法正则和可编译 map。不能因为接口写成 string / number 就放宽校验，也不能把稀疏覆盖 schema 全部改成完整配置 schema。

## 2. ModelSelection：已确认

用户接受以下通用结构：

### 2.1 顶层

保留 Provider、模型身份和可选的 options。

```ts
interface ModelSelection {
  providerId: string;
  modelId: string;
  options?: ModelSelectionOptions;
}
```

### 2.2 options

只保留 reasoningLevel；此处命名接口仅用于分层展示，不新增类型改造裁决。

```ts
interface ModelSelectionOptions {
  reasoningLevel?: string;
}
```

### 2.3 裁决背景

具体裁决：

1. “未选择 / 跟随默认”的表达属于使用者的上层 schema，不给通用 ModelSelection 新增区分字段。
2. `maxOutputTokens` 不属于模型选择，故意不放进 `options`。后续确认的 ModelConfig 选项定义见第 5 节，与选择值保持区分。
3. 执行时完整性属于运行校验，不因此扩张本轮 ModelSelection schema 讨论。
4. 本轮没有要求为 `reasoningLevel` 新增 enum、改名或改变可选性，也没有授权补其他 options 字段。

后续用户统一通过了“在已有结构上接入这一份 ModelSelection”的设计，不再逐个讨论消费位置；具体范围见 6.14。通过的是结构取舍，旧数据迁移和消费者适配仍需在实施时验证。

## 3. ProviderConfig：已确认的变更与保留项

| 项目                               | 最终裁决                                            | 背景                                                                                                                                          |
| ---------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `modelIds`                         | 改为 `personalModelIds`                             | 原字段只表示用户添加的模型，与 `builtinModelIds` 并列时容易被误解为全量模型集合。                                                             |
| `api.baseURL`                      | 改为 `api.baseUrl`                                  | 与 `apiKeyManagementUrl` 的缩写命名风格保持一致。裁决限于当前讨论的 schema，不是全仓所有 SDK 参数的机械改名。                                 |
| `label`                            | 从 ProviderConfig 删除，外层规则改用 `providerName` | 模板只保留 templateNameMap；默认 Provider 名称创建时按当前语言生成、去重并保存，见 6.5。                                                      |
| `api` / `ProviderApiConfig`        | 保留嵌套和独立结构                                  | 最初质疑是否需要这一层，随后讨论过顶层 `apiType`、`baseUrl`、`headers`。用户想起原先有未来 OAuth 的考虑，明确要求恢复 `api`。拍平建议已撤回。 |
| `access`                           | 保留现有联合结构                                    | 本轮未裁决新增 OAuth 类型或具体 OAuth 字段；“未来可能搞 OAuth”是保留分组的理由，不是现在实现 OAuth。                                          |
| `entitled`                         | 保留名字、位置与现有语义                            | Provider Config 可以包含动态事实，且不是最终授权方；详见下一节。                                                                              |
| `group`、`logo`、`visibility`      | 保留现有设计                                        | 已解释含义和调用，本轮没有确认改名、改类型或扩展字段。                                                                                        |
| `ProviderConfigOverlay` 等类型命名 | 不继续纠结，不安排改名                              | 用户明确结束该命名讨论。                                                                                                                      |
| 字段可选性与 `null`                | 本轮保持现状                                        | 没有形成改变这些字段可选性或清除语义的新裁决。                                                                                                |

最初保留 providerId 为外层 map key、templateId 位于 ProviderConfig 内；这一阶段方案已被第 6.4 节最终外层结构取代：providerId 和 templateId 都进入实例规则，ProviderConfig 只承载配置内容。`builtinModelIds` 和 `modelOrder` 保留现名。

### 3.1 目标结构（讨论结果，尚未落地）

以下接口只表达本轮讨论的 schema 形状，不要求将当前 class、ID 类型或 readonly 实现改写为这些接口。

**顶层**：`modelIds` 改为 `personalModelIds`；templateId 移到外层规则，label 移出并改为外层 providerName，其余字段及分组保持。

```ts
interface ProviderConfig {
  group?: ProviderGroup | null;
  logo?: ProviderLogoRef | null;

  api?: ProviderApiConfig | null;
  access?: ProviderAccessConfig | null;

  builtinModelIds?: string[] | null;
  personalModelIds?: string[] | null;
  modelOrder?: string[] | null;

  visibility?: "visible" | "hidden" | null;
}
```

**group**：保留现有三个取值。

```ts
type ProviderGroup = "standard-personal" | "zai-family" | "bigmodel-family";
```

**logo**：保留内置资源引用结构。

```ts
interface ProviderLogoRef {
  type: "builtin";
  key: string;
}
```

**api**：保留嵌套，`baseURL` 改为 `baseUrl`。

```ts
interface ProviderApiConfig {
  type?: ProviderApiType | null;
  baseUrl?: string | null;
  headers?: Record<string, string> | null;
}
```

**API 类型**：保留现有三个取值。

```ts
type ProviderApiType = "anthropic-messages" | "openai-chat-completions" | "openai-responses";
```

**access**：保留两种访问结构，不新增 OAuth 分支。

```ts
type ProviderAccessConfig = ApiKeyAccessConfig | ZhipuAccountAccessConfig;
```

**API Key 访问**：字段保持。

```ts
interface ApiKeyAccessConfig {
  type: "api-key";
  apiKey?: string | null;
  apiKeyManagementUrl?: string | null;
}
```

**账号访问**：字段保持，包括 entitled。

```ts
interface ZhipuAccountAccessConfig {
  type: "zhipu-account";
  accountType?: "zai" | "bigmodel" | null;
  mode?: "start-plan" | "individual-coding-plan" | "team-coding-plan" | "off-peak" | null;
  entitled?: boolean | null;
}
```

**外层规则集合**：统一见第 6.4 节，不再以 Record key 承载序列化的 Provider 身份；内部查询仍可建立 Map 索引。

### 3.2 已解释的字段背景

- `group` 是产品分组：`standard-personal` 对应普通个人 Provider（包括从模板创建的 API Key Provider），`zai-family` / `bigmodel-family` 对应账号套餐 Provider。当前用于分组排序、设置导航、删除限制和保存分组校验；本轮未决定重构这些调用。
- `logo` 已有 schema：`{ type: "builtin", key: string }`，运行时校验 key 非空，未限制为固定 key enum。UI 将 key 映射到内置图标，未知 key 有兜底；没有在本轮增加 URL、自定义上传或其他 logo 类型。
- `visibility` 控制普通设置和模型选择入口是否展示，不等于关闭执行。hidden 的 Off-Peak Provider 仍可由专门执行入口使用。

## 4. entitled 的裁决与调用背景

用户的最终解释：这份 Config 决定 ZCode 认为能不能用这个模型、请求时怎么用；最终是否有资格使用，仍由账号和远端等共同决定。因此 `entitled` 放在 Provider Config 中说得通。

```text
内置 / 账号 / 个人配置
          |
          v
Effective Provider Config（可以包含动态事实）
          |
          v
ZCode 本地可用性判断与请求装配
          |
          v
账号服务提供请求期访问材料 -> 模型服务端最终鉴权 / 授权
```

明确撤回的推论：

- 不能因为名字叫 Config，就断言它只允许静态事实、必须等同于用户落盘配置。
- 不能仅凭 `entitled` 会动态变化，就认为它放错位置、需要移到别处。
- 之前从 App/CLI 赋值差异、状态投影及埋点用法推导出的“设计问题”未获用户认同，不列为待修缺陷。
- 本轮没有授权更改 `entitled`、`accountState`、协议访问对象或相关消费者。

以下仅保存本次静态调用梳理，便于后续理解字段，不是整改清单：

| 路径                         | 当前作用                                                                                                                                                        |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account 结果解析             | `available` 生成 true，`pending` / `unavailable` 生成 false；unknown 可沿用同身份旧结果，没有旧结果则为 false。初次账号事实未到达时为 false。                   |
| App Off-Peak                 | 从当前选中的同账号体系个人 / 团队套餐是否 available 推导值。                                                                                                    |
| 独立 CLI                     | 根据本地账号身份及对应 API Key 是否存在生成值；配置检查判断是否存在 entitled 的账号 Provider。                                                                  |
| Provider Resolver / Registry | 账号 Provider 的执行资格要求 entitled 为 true，同时检查 current、配置完整性等；可选择性还受 visibility 影响。                                                   |
| 设置页                       | 参与导航项账号状态、套餐卡片、Start Plan 可见性、连接 / 重新授权完成判断和首次补同步。                                                                          |
| 额度及套餐查询               | 侧栏、设置页、输入框和套餐身份快照，通过公共 helper 获取账号访问对象及刷新指纹。                                                                                |
| 套餐只读查询                 | 专用 inspection helper 允许部分尚未 entitled 的状态查询权益；没有 accountState 时才回退到 entitled 判断。用于设置详情、权益 hook、手动领取横幅及 OAuth 后刷新。 |
| 购买入口埋点                 | 用 entitled Provider 推断进入购买入口时的套餐状态，供 Automations、Off-Peak 新建等入口使用。                                                                    |
| 类型与投影                   | 字段出现在 Provider Access Config、AccountProviderState 投影以及协议账号访问对象；本轮不改变这些结构。                                                          |

主要代码证据（记录时字段仍是原名）：

- [ProviderConfig 与 Access 类型](../../../../packages/provider/src/config/provider-config.ts)
- [运行时 Schema](../../../../packages/provider/src/config/schema.ts)
- [Account 结果解析与状态投影](../../../../packages/provider/src/account-provider-resolution.ts)
- [执行资格判断](../../../../packages/provider/src/resolver.ts)
- [App 账号连接解析](../../../../packages/services/src/model-provider/accountProviderConnectionResolver.ts)
- [独立 CLI 账号配置](../../../../apps/zcode-cli/packages/bootstrap/src/app/standalone-account-provider-runtime.ts)
- [UI Account Access helpers](../../../../packages/ui/src/lib/accountProviderAccess.ts)
- [Provider 设置页](../../../../packages/ui/src/settings/ModelProviderSection.tsx)
- [套餐状态计算](../../../../packages/ui/src/settings/model-provider-section/providerFamilyConnectionVisibility.ts)
- [套餐身份快照](../../../../packages/ui/src/hooks/usePlanIdentitySnapshot.ts)
- [购买入口埋点](../../../../packages/ui/src/lib/codingPlanFunnelTelemetry.ts)
- [协议账号访问对象](../../../../packages/shared/src/zcode-protocol/index.ts)

## 5. ModelConfig：已确认的变更与分层目标结构

本轮用户已确认以下三项，尚未修改实现：

- `properties.input_format` / `output_format` 改为 `inputFormat` / `outputFormat`，内部 `support_text`、`support_image`、`support_video`、`support_audio`、`support_pdf` 分别改为 `supportsText`、`supportsImage`、`supportsVideo`、`supportsAudio`、`supportsPdf`。
- `requiresMfjsToolSchema` 从 ModelConfig 顶层移入 `properties`，与其他模型能力及约束放在一起。
- 删除 `optionSpecs.reasoningLevel.type` 和 `optionSpecs.maxOutputTokens.type`。用户先要求查看实际 schema，确认成员名已经分别绑定 enum / limit 结构后，明确同意删除。

删除 `type` 的依据是当前 schema 已将 `reasoningLevel` 绑定到 `enumOptionSpecSchema`，将 `maxOutputTokens` 绑定到 `limitOptionSpecSchema`；并非靠 `type` 在不同成员形态之间分派。`map` 的变量名也分别绑定到这两个选项。本阶段先确认删除两个选项 type；随后 6.6 又单独确认删除按集合分类的规则 type。Provider Access 等仍需要成员形态区分的 type 保留，不做全仓机械删除。

其余字段、可选性和 null 保持现状；`enabled` 仍是模型启停配置。下列接口用于表达目标形状，不要求替换当前 class / readonly 实现。普通字段不另加通用设计检查清单。

### 5.1 顶层

`requiresMfjsToolSchema` 移出顶层，放入 properties。

```ts
interface ModelConfig {
  enabled?: boolean | null;
  properties?: ModelPropertiesConfig | null;
  optionSpecs?: ModelOptionSpecsConfig | null;
}
```

### 5.2 properties

加入 `requiresMfjsToolSchema`，输入输出格式字段改为驼峰命名。

```ts
interface ModelPropertiesConfig {
  requiresMfjsToolSchema?: boolean | null;
  contextWindow?: number | null;
  inputFormat?: ModelInputFormatConfig | null;
  outputFormat?: ModelOutputFormatConfig | null;
  supportsToolCall?: boolean | null;
  supportsJsonSchemaOutput?: boolean | null;
  supportsNativeWebSearch?: boolean | null;
  supportsMidConversationSystem?: boolean | null;
}
```

### 5.3 输入输出格式

内部字段统一为 `supportsXxx`。

```ts
interface ModelInputFormatConfig {
  supportsText?: boolean | null;
  supportsImage?: boolean | null;
  supportsVideo?: boolean | null;
  supportsAudio?: boolean | null;
  supportsPdf?: boolean | null;
}

interface ModelOutputFormatConfig {
  supportsText?: boolean | null;
}
```

### 5.4 optionSpecs

这一层不变。

```ts
interface ModelOptionSpecsConfig {
  reasoningLevel?: EnumOptionSpecConfig | null;
  maxOutputTokens?: LimitOptionSpecConfig | null;
}
```

### 5.5 选项定义

删除 enum / limit 结构中的两个 `type` 字段。

> 实施进度（2026-09-10）：本项已由 B2c 接入 schema、行为类、Built-in、CLI 合同、设置保存及测试；第5节媒体改名/MFJS移动也已由 B2d 完成。Pro SC90/F98 通过。后续规则归组/手动配置独立集合仍未完成，不能把第5节字段收口视为整个 Todo 完成。完整证据见实施账本。

```ts
interface EnumOptionSpecConfig {
  values?: string[] | null;
  map?: string | null;
}

interface LimitOptionSpecConfig {
  max?: number | null;
  map?: string | null;
}
```

`values` 保留有序档位语义，`max` 保留支持上限语义，`map` 保留转换请求参数的表达式字符串。本轮未决定重命名 `EnumOptionSpecConfig` / `LimitOptionSpecConfig`，也未新增选项。

稀疏覆盖语义保持：字段缺省表示沿用前层，null 表示显式清除；配置对象按现有规则递归覆盖，数组和 headers 等普通值整体替换。改名和移动字段时不能把 null 转成缺省，也不能顺手改成数组追加或 headers 深合并。ManualModelConfig 的完整参数约束是单独的例外，见 6.2。

代码依据：[ModelConfig 类型与选项定义](../../../../packages/provider/src/config/model-config.ts)、[字段绑定的运行时 schema](../../../../packages/provider/src/config/schema.ts)。记录时实现仍保留旧命名、顶层 `requiresMfjsToolSchema` 和两个 `type` 字段。

## 6. 本轮规则结构讨论与状态

### 6.1 Match 字段改名：已确认

`baseURLMatch` 改为 `baseUrlMatch`，`apiMatch` 改为 `apiTypeMatch`。随后进一步确认删除 providerMatch 字段及对应匹配逻辑；下列只展示可复用的公共字段，不是允许直接写入文件的第四种 Match 规则。文件各集合必须使用 6.3 的具体严格 schema，不能以此宽泛结构接受越层条件。

```ts
interface MatchModelConfigRule {
  modelMatch: string;
  apiTypeMatch?: string;
  baseUrlMatch?: string;
  config: ModelConfig;
}
```

### 6.2 智能配置与手动配置：两种规则、两个集合，已确认

用户提出按智能配置模式区分 config 的完整程度，避免关闭智能配置时仍能保存不完整参数，并要求实施时派生复用而非抄写结构。讨论先从 useRecommendedConfig 改名 useSmartConfig，随后明确改成 ProviderModelConfigRule / ManualProviderModelConfigRule 两种规则，分别放入两个集合。最后确认持久化规则不再保存重复 type，模式由所属集合表达，useSmartConfig 也不再持久化。UI 概念仍叫“智能配置”。

关闭后的完整配置叫 ManualModelConfig，对应 manualModelConfigSchema，取代此前方案中的 FixedModelConfig / fixedModelConfigSchema。智能配置开启时仍允许局部覆盖，“手动配置”专指关闭智能配置后的完整配置模式。

当前代码 schema 仅声明 useRecommendedConfig 可选 boolean + 稀疏 ModelConfig；新增 / 编辑入口通过 `assertFixedModelConfigComplete` 调用 `validateComplete` 并排除 enabled 缺失项，固定模式解析也不会从推荐配置补缺，最终 Registry 再检查完整性。

个人集合层：两种规则分为两个成员，不混在一个 union 数组中。

```ts
interface PersonalModelConfigRules {
  providerModelRules: ProviderModelConfigRule[];
  manualProviderModelRules: ManualProviderModelConfigRule[];
}
```

普通精确规则层：参与前层配置叠加，个人集合中表示智能配置；内置精确规则复用这一类型。

```ts
interface ProviderModelConfigRule {
  providerId: string;
  modelId: string;
  config: ModelConfig;
}
```

手动精确规则层：模型参数完整，不从推荐配置补缺。

```ts
interface ManualProviderModelConfigRule {
  providerId: string;
  modelId: string;
  config: ManualModelConfig;
}
```

同一个 providerId + modelId 在个人配置中只能属于其中一组，不允许同时声明智能和手动配置。切换模式改变条目所属集合，不维护第二份模式布尔值；保存校验复用所属集合的规则 schema。

手动配置层：除独立管理的 enabled，模型参数及嵌套必要成员均完整。完整类型名用于展示职责，实施时复用基础 schema。

```ts
interface ManualModelConfig {
  enabled?: boolean | null;
  properties: CompleteModelProperties;
  optionSpecs: CompleteModelOptionSpecs;
}
```

与完整配置的关系：完整配置用于描述已齐备的模型配置，enabled 也必填；手动配置只放宽 enabled，其余成员复用。下列是目标数据形状，当前实现没有可直接复用的独立 completeModelConfigSchema，需要从共享字段 schema 派生，而不是假定它已经存在。

```ts
interface CompleteModelConfig {
  enabled: boolean;
  properties: CompleteModelProperties;
  optionSpecs: CompleteModelOptionSpecs;
}
```

手动规则参与解析时保留前层 enabled，再应用手动规则自己的 enabled 覆盖；properties / optionSpecs 则使用完整手动值，不从智能配置补缺。不能因关闭智能配置而丢掉原来的模型启停状态。这延续当前固定模式行为，不新增第三种模式或额外状态字段。

完整属性层：叶子字段必填且非 null。

```ts
interface CompleteModelProperties {
  requiresMfjsToolSchema: boolean;
  contextWindow: number;
  inputFormat: CompleteModelInputFormat;
  outputFormat: CompleteModelOutputFormat;
  supportsToolCall: boolean;
  supportsJsonSchemaOutput: boolean;
  supportsNativeWebSearch: boolean;
  supportsMidConversationSystem: boolean;
}
```

完整输入输出格式层：各能力显式声明。

```ts
interface CompleteModelInputFormat {
  supportsText: boolean;
  supportsImage: boolean;
  supportsVideo: boolean;
  supportsAudio: boolean;
  supportsPdf: boolean;
}

interface CompleteModelOutputFormat {
  supportsText: boolean;
}
```

完整选项层：两个选项的必要字段全部齐全。

```ts
interface CompleteModelOptionSpecs {
  reasoningLevel: EnumOptionSpec;
  maxOutputTokens: LimitOptionSpec;
}
```

选项成员层：复用相应选项 schema 的完整版本，不恢复已删除的选项 type。

```ts
interface EnumOptionSpec {
  values: string[];
  map: string;
}

interface LimitOptionSpec {
  max: number;
  map: string;
}
```

实施层复用约定：从已有精确规则基础 schema 派生手动版本，仅替换 config 为 manualModelConfigSchema，再分别 infer 类型；manualModelConfigSchema 从完整配置 schema 派生，仅放宽 enabled。不新增 ProviderModelRuleIdentity，也不保留此前的 PersonalProviderModelConfigRule 条件类型作为第二套持久化结构。

保存时可直接用对应规则 schema 解析整条规则，替代单独维护的固定模式完整性检查；数值范围、数组内容和 Map 等约束也需一并复用。普通智能规则仍可稀疏，手动规则必须完整，不能一并放宽或收紧。文件读取目前允许不完整配置；未来手动规则校验失败时沿用所属个人文件的错误处理边界，本轮没有授权新增删除整份文件、自动补齐参数或偷偷改回智能模式的行为。若实施时现有错误处理无法适配，应报告具体冲突。

证据：[新增 / 编辑及固定模式校验](../../../../packages/provider/src/config-service.ts)、[规则 schema](../../../../packages/provider/src/config/schema.ts)、[固定模式解析](../../../../packages/provider/src/config/model-config.ts)。

### 6.3 各层 Model Rule：边界及内置成员命名已确认

当前代码中 modelRules、modelApiRules、providerSiteRules 全部复用宽泛的 matchModelConfigRuleSchema，序列化按 API / URL 字段是否存在重新分组。本轮确认各层建立独立严格 schema，通过 extend 复用公共定义；三个 Match 层都禁止 providerMatch，实例身份只通过精确规则的 providerId + modelId 表达。

集合层：内置成员 providerModelRules 改为 builtinProviderModelRules，仅加 builtin 前缀；不采用之前误提的 providerInstanceModelRules / ProviderInstanceModelConfigRule 改名。个人集合的 providerModelRules 不加 builtin 前缀，规则类型保持 ProviderModelConfigRule。

```ts
interface BuiltinModelConfigRules {
  modelRules: ModelMatchConfigRule[];
  modelApiRules: ModelApiMatchConfigRule[];
  providerSiteRules: ProviderSiteMatchConfigRule[];
  templateModelRules: TemplateModelConfigRule[];
  builtinProviderModelRules: ProviderModelConfigRule[];
}
```

Model 层：modelMatch 必填，不接受 Provider、API、URL 条件。

```ts
interface ModelMatchConfigRule {
  modelMatch: string;
  config: ModelConfig;
}
```

Model + API 层：复用 Model 层，增加必填 apiTypeMatch，不接受 Provider、URL 条件。

```ts
interface ModelApiMatchConfigRule {
  modelMatch: string;
  apiTypeMatch: string;
  config: ModelConfig;
}
```

Site 层：复用 Model 层，增加必填 baseUrlMatch 和可选 apiTypeMatch，不接受 Provider 条件。

```ts
interface ProviderSiteMatchConfigRule {
  modelMatch: string;
  baseUrlMatch: string;
  apiTypeMatch?: string;
  config: ModelConfig;
}
```

三层 modelMatch 均必填；整个站点通用时显式写 `".*"`。已有 Z.ai / BigModel Anthropic 站点的搜索、中途 System 规则就是这一用法，用户已确认保留。以上接口用于分层展示，实际类型仍须由相应 schema 推导；不能仅删 TypeScript 字段而让运行时 schema 接受未知 providerMatch。

匹配字段仍为正则表达式字符串，apiTypeMatch 不改成单个 API 枚举值。保留当前整串匹配、modelMatch 忽略大小写及 URL 规范化语义；不要把改名顺带变成相等判断或子串匹配。站点路径中的点等字符需要按正则语义正确转义。

各数组内部保留原顺序，模型配置仍按下图逐层覆盖；分组和删除 type 不改变优先级，也不允许序列化时再次根据字段猜回集合。普通与手动个人规则按 6.2 互斥，不依赖两组谁排在后面解决冲突。

```text
modelRules -> modelApiRules -> providerSiteRules
    -> templateModelRules -> builtinProviderModelRules
    -> 个人普通规则 或 个人手动规则
```

模板精确模型规则层：由 templateModelRules 集合确定类别，不再保存重复 type。

```ts
interface TemplateModelConfigRule {
  templateId: string;
  modelId: string;
  config: ModelConfig;
}
```

Provider 精确模型规则见 6.2；内置集合只接受普通 ProviderModelConfigRule，不混入手动规则。

### 6.3.1 现有四条越层规则：全部归入 Site 层，已确认

本轮通过实际配置及提交记录核查发现：Model 层有一条账号 Provider 通配规则，Model + API 层有三条 Provider 条件规则。此前以“当前已有用法”为由建议保留 providerMatch，用户明确否决；schema 应按层职责约束，不能为越层规则放宽。

| 原位置及条件                                                       | 覆盖内容                      | 确认后的处理                                                                                         |
| ------------------------------------------------------------------ | ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| Model：账号个人 / 团队 / Start Plan Provider，modelMatch 为 `".*"` | 图片、视频输入为 true         | 改为 Endpoint 条件，移入 providerSiteRules；保留 modelMatch `".*"`                                   |
| Model + API：anthropic，Claude 模型，Anthropic Messages            | 原生搜索、中途 System 为 true | 移入 providerSiteRules，按 Anthropic Endpoint 匹配，保留模型及 API 条件                              |
| Model + API：moonshot-kimi，K3 系列，Anthropic Messages            | MFJS 工具 Schema 为 true      | 移入 providerSiteRules，按 Moonshot Endpoint 匹配，保留 K3 模型及 API 条件，不提升为所有站点通用规则 |
| Model + API：deepseek，所有模型，Anthropic Messages                | 原生搜索、中途 System 为 true | 移入 providerSiteRules，按 DeepSeek Endpoint 匹配，保留 modelMatch `".*"` 及 API 条件                |

Endpoint 依据当前配置 / 模板记录，实施时按对应路径生成匹配条件，不因转换成 Site 规则随意放大到整个域名：

- 图片 / 视频对应当前个人、团队、Start Plan 使用的三个 Endpoint：`https://api.z.ai/api/anthropic`、`https://open.bigmodel.cn/api/anthropic`、`https://zcode.z.ai/api/v1/zcode-plan/anthropic`。
- Anthropic：`https://api.anthropic.com/v1`。
- Moonshot：`https://api.moonshot.cn/anthropic`。
- DeepSeek：`https://api.deepseek.com/anthropic`。

用户明确同意图片 / 视频按 Endpoint 声明：同 Endpoint 的普通 API Key 实例与账号实例得到相同站点能力。此前“账号能力必须留在 builtinProviderModelRules，以避免普通 API Key 实例命中”的建议已被本裁决取代，不能继续作为约束实施。原账号规则未包含 Off-Peak，本次不额外把其独立 Endpoint 加进来。

已有匹配 Z.ai / BigModel 上述两个普通 Anthropic Endpoint 的站点规则保留：modelMatch 为 `".*"`、API 为 Anthropic Messages，声明 supportsNativeWebSearch 与 supportsMidConversationSystem 为 true。本次不将这条已有搜索规则无依据扩大到 Start Plan Endpoint；不要因图片 / 视频规则含 Start Plan 而把不同规则的 URL 条件混在一起。

最终删除 providerMatch 字段及对应解析、匹配、序列化逻辑；四条原规则改为站点规则，不以兼容新格式为由保留第二套 Provider 正则匹配入口。按 providerId + modelId 的精确实例规则仍保留。

证据：[当前 Built-in 配置](../../../../config/provider/zcode-builtin.json)、[规则解析及序列化](../../../../packages/provider/src/config/model-config.ts)。账号媒体通配规则在模板重构提交 `9d3289240d4` 中加入；这些是静态实现事实和本轮设计裁决，不宣称已完成真实服务端能力验证。

### 6.4 Provider 模板、实例与规则集合：已确认

用户认为 templateId 放在 ProviderConfig 内别扭；最初 ProviderDefinition 外壳方案被指出“多一层、身份仍分散、命名不对称”。后续把 providerId 一并放入外层，命名与 ModelConfigRule 对称，再将 Template 合入规则体系。用户进一步指出 Provider 使用 Rule[]、Model 使用 Rules 不对称，最终统一为规则集合对象，内部按类别放数组。

内置配置内容层：两边都使用规则集合对象。

```ts
interface BuiltinProviderConfig {
  providerConfigRules: BuiltinProviderConfigRules;
  modelConfigRules: BuiltinModelConfigRules;
}
```

Provider 规则集合层：模板与实例分别归组，取代原先独立 providerTemplates 和 providers 的包装。

```ts
interface BuiltinProviderConfigRules {
  templateRules: ProviderTemplateConfigRule[];
  providerRules: ProviderConfigRule[];
}
```

模板规则层：承载模板身份、展示名称和配置内容。

```ts
interface ProviderTemplateConfigRule {
  templateId: string;
  templateNameMap: ProviderTemplateNameMap;
  config: ProviderConfig;
}
```

实例规则层：承载具体 Provider 身份及可选模板关系。

```ts
interface ProviderConfigRule {
  providerId: string;
  templateId?: string | null;
  providerName?: string | null;
  config: ProviderConfig;
}
```

类型名明确恢复为 ProviderConfigRule，不采用此前误加的 ProviderInstanceConfigRule。用户要求的 builtin 前缀只针对 Model 规则集合的 builtinProviderModelRules 成员，不改变这些规则类型的命名。

内部 ProviderConfig 移除 templateId 和 label。两种规则虽然复用配置内容，具体运行时 schema 仍限制各自允许字段，例如模板不允许保存 API Key。个人配置只允许实例规则，不因此增加用户自定义模板功能；个人文件包装已确认，见 6.7。来源专用配置的进一步展开要求见 6.8。名称最终裁决见 6.5。

结构转换边界：

- 原 Record key 移到规则 providerId，原 config.templateId 移到规则 templateId，实例原 label 转为外层 providerName，其余配置字段保留在 config；模板原 config.label 不再作为第二份默认名来源。
- 已处于新 Provider 身份体系的 providerId、modelId 保持，不因本次外移更换已保存 ModelSelection 的身份。staging 的旧身份仍按既有 importer / 身份转换规则迁入新体系；不能把“外移不改 ID”误解为取消旧身份迁移。
- 原 Provider / Template 映射的同层身份唯一性随 Record 转数组保留：同一来源的 providerRules 不重复 providerId，templateRules 不重复 templateId；不同来源对同一 Provider 的覆盖仍合法。不能先转 Map 再悄悄用末项吞掉重复条目。此约束不推广成禁止多条 Match 规则命中同一模型。
- providerOrder 继续独立表达展示顺序，不自动改为数组顺序。
- 解析时先建立模板索引，不要求模板和实例按引用先后排列。
- 旧 staging 数据的升级入口应输出最终结构；本分支未发布中间格式不要求过渡迁移，版本边界见 6.11，已有迁移入口及实施核对位置见 6.16。

```text
providerConfigRules
    +-- templateRules -> 模板索引
    +-- providerRules -> 按 templateId 查模板 -> 合成实例配置
```

此前 ProviderDefinition、ProviderConfigRules = ProviderConfigRule[] 以及模板另放 providerTemplates 的方案均被上述结构取代，不作为并行实施方案。

### 6.5 模板名称与 Provider 名称：已确认

模板只保留多语言名称：nameMap 改为 templateNameMap，不采纳此前提议的 displayNames。模板不再另存 name 或 config.label 作为实例默认名。

```ts
interface ProviderTemplateNameMap {
  "zh-CN"?: string;
  "en-US"?: string;
}
```

Provider 名称在外层 ProviderConfigRule 中叫 providerName，可选性和 null 暂保持前述形状；取代中间方案中的 name。用户手动指定名称时使用用户名称；本轮明确的默认名称生成契约如下：

1. 创建时从 templateNameMap 取当前语言的非空名称，缺少时回退到 en-US，再回退到 templateId。
2. 与已有 Provider 名称去重，比较时去除首尾空白、忽略大小写。
3. 已占用时依次尝试 `名称 2`、`名称 3` 等，取第一个未占用的名称。例如已有 Anthropic、Anthropic 2，再创建得到 Anthropic 3。
4. 结果实际保存到外层 providerName；切换语言或模板名称更新不自动修改已创建实例名称。默认名不是每次展示时临时从模板读取。
5. 读取已有名称、生成可用名称和保存放在同一次配置更新中，避免并发创建得到重复名称。

```text
创建 Provider（当前语言）
    -> 模板当前语言名称 / en-US / templateId
    -> 同一次配置更新内检查重名、选取可用名称
    -> 保存 providerName
    -> 后续展示读取已保存名称
```

本轮确认的是模板默认名与创建去重；不额外推导出全仓名称统一规范。保留历史裁决背景：先提出 label 改 name 并外移，随后用户明确模板只用名称 map、默认实例名也从该 map 生成，最终要求实例字段更明确地叫 providerName，并确认创建时去重后保存。

现状依据：[创建与名称去重](../../../../packages/provider/src/config-service.ts)、[模板名称语言回退](../../../../packages/provider/src/config/provider-config.ts)。当前代码创建仍取 template.config.label；将默认名称源改为当前语言 templateNameMap 是本 Todo 待实施的变更。

### 6.6 规则集合确定类别，删除持久化规则的 type：已确认

每种规则已独占一个数组，因此模板、Provider、Model Match、Model + API Match、Site Match、模板精确模型、Provider 精确模型和手动模型规则都不再保存重复 type。前面各层目标接口已同步删除，而不是只在文字中记录。

| 所属集合                                        | 成员类型                      |
| ----------------------------------------------- | ----------------------------- |
| providerConfigRules.templateRules               | ProviderTemplateConfigRule    |
| providerConfigRules.providerRules               | ProviderConfigRule            |
| modelConfigRules.modelRules                     | ModelMatchConfigRule          |
| modelConfigRules.modelApiRules                  | ModelApiMatchConfigRule       |
| modelConfigRules.providerSiteRules              | ProviderSiteMatchConfigRule   |
| modelConfigRules.templateModelRules             | TemplateModelConfigRule       |
| 内置 modelConfigRules.builtinProviderModelRules | ProviderModelConfigRule       |
| 个人 modelConfigRules.providerModelRules        | ProviderModelConfigRule       |
| 个人 modelConfigRules.manualProviderModelRules  | ManualProviderModelConfigRule |

内部执行若需要合并处理，可以从所属集合补出内部类别标签；不能要求文件再保存一份类别，也不能通过 Map/API/URL 字段猜回规则所属集合而丢失其来源边界。UI 智能配置开关对应个人规则所属的普通 / 手动集合，不另存 useSmartConfig。

本裁决只删除规则对象中由集合确定的 type。Provider API 的协议 type、Access 的 api-key / zhipu-account type、Logo 资源 type 保持；不要全仓机械删除 type 字段。历史先按 type 拆智能 / 手动规则，随后分两个数组，最终又去掉重复 type；最终版本以本节及 6.2 为准。

### 6.7 内置 / 个人配置文件包装：已确认

内置文件层：保留版本、发布 revision 和 config 内容层。用户已确认本分支新增、未发布的内置格式从当前 schemaVersion: 3 收口为 schemaVersion: 1；发布 revision 的规则及 review 见 6.12。

```ts
interface ZCodeBuiltinRelease {
  schemaVersion: 1;
  revision: number;
  config: BuiltinProviderConfig;
}
```

内置内容层与两种规则集合复用 6.3 / 6.4 的完整定义。

个人文件层：增加 config 层，与内置文件保持版本与内容分离。

```ts
interface PersonalProviderConfigFile {
  schemaVersion: 1;
  config: PersonalProviderConfig;
}
```

个人内容层：保存独立的展示顺序、两类规则集合和默认模型选择。原 providers 改为 providerConfigRules，原 Record 转为规则数组分组；默认选择合并裁决见 6.9。

```ts
interface PersonalProviderConfig {
  providerOrder?: string[];
  providerConfigRules: PersonalProviderConfigRules;
  modelConfigRules: PersonalModelConfigRules;
  defaultModelSelection?: ModelSelection;
}
```

个人 Provider 集合层：只声明具体 Provider，不包含模板集合。

```ts
interface PersonalProviderConfigRules {
  providerRules: ProviderConfigRule[];
}
```

个人 Model 集合层：完整定义见 6.2，分别保存 providerModelRules 和 manualProviderModelRules，禁止同一模型身份同时出现在两组中。

接口中未标问号的集合在最终文件中必须存在，无条目时写空数组；例如个人配置同时保留 providerRules、providerModelRules、manualProviderModelRules 三个数组。providerOrder 和 defaultModelSelection 仍可缺省，不为了凑齐字段写 null。这是上述接口的读写约定，不新增另一种空配置格式。

```text
内置文件
|-- schemaVersion
|-- revision
`-- config
    |-- providerConfigRules
    |   |-- templateRules[]
    |   `-- providerRules[]
    `-- modelConfigRules
        |-- modelRules[]
        |-- modelApiRules[]
        |-- providerSiteRules[]
        |-- templateModelRules[]
        `-- builtinProviderModelRules[]

个人文件
|-- schemaVersion
`-- config
    |-- providerOrder[]
    |-- providerConfigRules
    |   `-- providerRules[]
    |-- modelConfigRules
    |   |-- providerModelRules[]
    |   `-- manualProviderModelRules[]
    `-- defaultModelSelection?
```

providerOrder 继续独立表达展示顺序，不用规则数组顺序代替。此前个人文件直接把 providerOrder / providerConfigRules / modelConfigRules 放在根层的方案已被替代；个人文件是否加 config 不再是待确认项。文件版本见 6.11，迁移实现与验证见 6.15。

### 6.8 来源专用配置 schema：保留现有边界，审阅通过

仅把所有规则的 config 标成公共 ProviderConfig 会掩盖来源差异。它们表示同一个公共配置在不同写入口允许的字段不同，不是新增配置文件或另一套 Provider 领域结构。用户最初同意展开讨论，随后要求只检查明显问题、无大问题就保留；定向核查未发现需要重做的结构问题，本项通过。

当前代码已有如下边界，结合本轮名称 / 身份外移后需要继续贯彻：

| 来源     | 已核实的允许 / 限制背景                                                                                                                                                                             |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Template | 目前提供 logo、api、builtinModelIds 及不含 apiKey 的 API Key Access 元数据；不声明个人模型。旧 label 按本轮裁决删除，模板名称只在外层 templateNameMap。                                             |
| Built-in | group 必填且限 zai-family / bigmodel-family；允许 logo、api、access、builtinModelIds、visibility，不声明 personalModelIds / modelOrder。身份与名称按 6.4 / 6.5 移到外层。                           |
| Personal | 不允许 builtinModelIds；group 只允许 standard-personal 的覆盖值；固定 Account Provider 的 access 不能由个人层覆盖。个人 Endpoint 目前允许保留尚未完成编辑的字符串，由最终完整性校验决定是否可执行。 |
| Account  | 目前只提供 builtinModelIds，以及 zhipu-account Access 的 entitled 覆盖；不是任意 ProviderConfig 字段的写入口。Access 的 type 仍保留。                                                               |

实施时保留这些已有字段限制，通过基础 schema 派生，配合已确认的改名和身份 / 名称外移；不追加来源重组或专用类型命名工程。6.4 / 6.7 用公共 ProviderConfig / ProviderConfigRule 展示共同形状，不表示各来源可无差别写入全部字段。固定 Account Provider 的个人 access 禁写等依赖 providerId 的校验，在 ID 外移后仍须保留在外层规则校验，不能只搬字段而丢失约束。

验证依据：provider-config-kinds、config-overlay、config-service、todo21-source-contracts 四个现有测试文件共 66 个用例通过。此处验证的是当前限制和合并行为，不代表目标结构已经实现；产品代码未修改。

证据：[当前来源专用 schema](../../../../packages/provider/src/config/schema.ts)、[个人文件 codec](../../../../packages/provider-node/src/provider-config-file-codec.ts)、[内置发布外壳](../../../../packages/provider-node/src/zcode-builtin-release.ts)。本轮没有实现这些结构改造或数据迁移。

### 6.9 默认模型选择合并进个人配置文件：已确认

背景：当前代码另外创建 model-selection.json，保存 schemaVersion 和 configuredDefault。用户认为单独新开文件没有必要，接受合并到个人配置，并进一步确认字段的位置和名字。逻辑结构独立不要求物理文件独立；本裁决取代此前文档要求 model-selection.json 保持独立的方案，尚未改动当前实现。

最新裁决：风险讨论中用户曾暂时取消合并；随后确认并发、通知、分发和回滚均能构造明确的验证场景，明确要求“恢复吧”。因此本节的文件合并、config.defaultModelSelection、分发信封随之合并和统一回滚方案全部恢复；五处 schemaVersion 边界保持。临时取消未进入产品代码，也不作为最终方案保留。

文件层：复用 6.7 的 PersonalProviderConfigFile，schemaVersion 管理整份文件格式，config 保存用户配置内容；默认选择不放到文件元数据层，也不保留自己的版本外壳。

```ts
interface PersonalProviderConfigFile {
  schemaVersion: 1;
  config: PersonalProviderConfig;
}
```

内容层：默认选择与 Provider / Model 规则和排序同层，字段定名 defaultModelSelection。configuredDefault 沿用的是运行时术语，在配置内容中 configured 重复，default 又没有指明对象，因此不采用该名称。

```ts
interface PersonalProviderConfig {
  providerOrder?: string[];
  providerConfigRules: PersonalProviderConfigRules;
  modelConfigRules: PersonalModelConfigRules;
  defaultModelSelection?: ModelSelection;
}
```

选择成员层：复用第 2 节已经确认的 ModelSelection，包含 providerId、modelId 和可选 options，不再新增一层包装或往通用 ModelSelection 塞入默认语义。defaultModelSelection 缺省表示用户没有指定环境默认模型选择；这是环境级偏好，不是会话选择历史集合。

实施时将当前独立文件的读写入口接到个人文件中的 config.defaultModelSelection。文件名统一风格尚未裁决，不把 provider_config.json 改为 provider-config.json 的建议顺带写成已确认。具体版本见 6.11；合并后的保存冲突标识范围及已发布数据迁移安排仍需落实。本节只确认物理文件合并、字段位置和命名，不额外决定删除旧文件的行为；未发布中间格式不要求兼容的边界见 6.10。

合并后的读写必须完整承载这个字段：保存 Provider、Model 或排序时保留当前默认选择；设置 / 清除默认选择时保留其他个人配置。清除默认选择只移除该可选成员，不能删除整份 provider_config.json。当前默认选择 Repository 在独立文件解码失败时会 rm 文件，这段处理不能原样接到合并后的个人文件上，否则会连同 Provider 和 API Key 配置一起删除；合并后由个人文件 Repository 统一处理文件错误。

同一物理文件的更新复用个人配置持锁读改写与冲突检查，持久化 revision 覆盖文件中的默认选择，变更通知也必须到达默认选择消费者。不指定额外的 revision 字段或新锁协议，运行时各视图是否发布继续由其实际内容决定。

```text
Provider / Model / 排序修改 --+
默认选择设置 / 清除 ---------+-> 同一个人文件更新入口
                                -> 持锁读取最新内容
                                -> 修改目标成员，保留其他成员
                                -> 原子写入并通知对应消费者
```

有最终个人文件但缺少 defaultModelSelection 时表示未指定默认；不能仅凭这一成员缺省，每次启动又从旧配置恢复用户已清除的选择。旧数据导入与最终文件是否存在的判断需要一起适配。

证据：[当前默认选择文件 codec](../../../../packages/provider-node/src/model-selection-config-file-codec.ts)、[当前默认选择 Repository](../../../../packages/provider-node/src/model-selection-config-repository.ts)、[当前独立文件装配](../../../../packages/services/src/node.ts)。

### 6.10 新增文件取舍与程序维护目录：已确认

背景：用户要求只看相比 staging 新增的文件和数据表，并逐份确认必要性，不把文件、schemaVersion 和 revision 混在一轮解释。本轮 Provider / ModelSelection 改造未新增数据库文件或数据表，但在现有 tasks-index.sqlite 的 automations、automation_runs、off_peak_tasks 三个表分别新增 model_selection TEXT 列，不能把“没有新表”理解为“没有新列或迁移”。这些列和其他既有结构接入 ModelSelection 的设计已统一通过，见 6.14。以下只记录本轮确认的文件取舍，不对全仓既有文件发起目录重构。

用户配置层：保留 provider_config.json，集中保存个人 Provider / Model 配置、排序及 6.9 的默认模型选择。旧综合 config.json 仍承担其他配置，旧 Provider 内容仅作升级输入。尚未确认全局文件命名风格，不顺带将 provider_config.json 改为中划线。

程序维护层：统一放进环境目录下 runtime/provider/。runtime 在这里表示程序维护的数据，不表示可随意清空的临时文件。此前讨论的 cache/、state/ 两套顶层目录方案均被替代。

```text
~/.zcode/v2/
|-- provider_config.json
|-- bot-config.v3.json
|-- bot-state.v3.json
`-- runtime/
    `-- provider/
        |-- <平台>/<应用版本>/<服务端地址标识>/
        |   |-- zcode-builtin.json
        |   `-- zcode-builtin-refresh.json
        |-- provisioning.json
        `-- bundled/
            `-- zcode-builtin.json
```

图中用户目录是默认环境示意，实际路径继续由所属环境的路径解析和宿主注入决定，不能硬编码用户主目录。下载配置及刷新记录继续保留现有平台 / 应用版本 / 服务端地址的隔离维度。

各文件裁决：

| 当前实现或资源                                  | 已确认的目标                                       | 理由                                                                                                           |
| ----------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| provider_config.json                            | 保留                                               | 个人 Provider / Model 配置集中保存，不占用旧综合 config.json                                                   |
| model-selection.json                            | 合并进 config.defaultModelSelection                | 逻辑成员独立不要求再开物理文件，见 6.9                                                                         |
| active.json                                     | runtime/provider/隔离目录/zcode-builtin.json       | 名字直接说明配置内容；作为下载后当前采用的内置配置，缺失时可用随包配置重建                                     |
| refresh-control.json                            | 与下载文件同目录的 zcode-builtin-refresh.json      | 记录多进程刷新占用、刷新时间和失败重试信息；不是用户配置                                                       |
| provider-provisioning-state.json                | runtime/provider/provisioning.json                 | 保存已成功执行的分发请求 ID 和结果，避免重发请求重复覆盖目标配置；不是完整配置副本，丢失后去重历史不能直接重建 |
| bot-config.v3.json                              | 保留当前新文件方案                                 | 从 staging 的 bot-config.json 导入，旧文件保持；不持续双写，不改回原文件覆盖                                   |
| bot-state.v3.json                               | 保留当前新文件方案                                 | 从 staging 的 bot-state.v2.json 等既有输入导入，旧文件保持；不改回原文件覆盖                                   |
| 随包 zcode-builtin.json                         | 保留随包资源                                       | 为首次启动和离线提供内置基线；与远端下载内容使用同一种发布 schema                                              |
| 内嵌资源释放出的 zcode-builtin-<内容 hash>.json | 固定为 runtime/provider/bundled/zcode-builtin.json | 单文件 CLI / Server 等形态复用文件读取链路；是资源副本，不是新的用户配置 schema                                |

资源副本的覆盖语义：用户随后明确要求覆盖，不保留按 hash 命名的历史副本。因此固定使用 runtime/provider/bundled/zcode-builtin.json，新程序启动时比较包内配置，内容不同则写临时文件后原子替换；内容相同可以复用。该裁决取代此前按 hash 保留历史副本的方案，下载配置与随包资源仍分开。讨论以正常退出旧程序及子进程后升级为前提，不再要求并行的新旧程序各自保留旧基线；若旧进程仍在运行，之后重读固定路径会看到新内容。替换由程序启动完成，不要求安装器额外处理。

兼容边界：staging 已发布数据需要升级到最终格式；本分支开发过程中产生的未发布中间格式不要求兼容或迁移。不把“保留不支持格式的文件”与“支持读取该格式”混为一谈；非法文件、未来版本文件的处理没有在本节扩展成新的实现要求。

Bot 误记纠正：此前本文将“沿用原文件迁移”写成用户裁决，并据此提出改变迁移触发条件，这是记录错误。用户明确指出本来就要换文件，要求撤销误记；不是用户撤回原本认可的方案。最终保留当前 bot-config.v3.json / bot-state.v3.json 及其 version: 3，新文件不存在时从旧文件导入，不再实施原路径覆盖或相应触发条件重构。图中只展示当前写入文件，旧文件继续作为导入输入保留；不把既有 Bot version 纳入 6.11 的五处新增 schemaVersion 重置。

证据：[既有独立个人文件裁决](./todo-33-personal-provider-config-file-cutover.md)、[当前下载路径](../../../../packages/provider-node/src/zcode-builtin-cache-paths.ts)、[分发状态记录](../../../../packages/services/src/model-provider/providerProvisioningTarget.ts)、[Bot 文件与迁移入口](../../../../packages/services/src/bots/repo.ts)、[内置资源释放](../../../../packages/provider-node/src/zcode-builtin-provider-config-materializer.ts)、[CLI 内嵌资源释放](../../../../apps/zcode-cli/packages/cli/src/provider-runtime-env.ts)。本轮仅记录目标，文件移动、改名等尚未实施；Bot 继续使用已有 v3 文件方案。

### 6.11 schemaVersion 的范围与用途：已确认

文件层：合并独立 Model Selection 文件后，本轮新增的版本边界从六处减少为五处，其中四种文件格式、一种传输格式。各自从版本 1 收口；版本号用于识别格式、选择迁移或拒绝不支持的输入，不随普通配置值的修改而递增。

| 版本边界                   | 目标版本         | 管理范围                                                          |
| -------------------------- | ---------------- | ----------------------------------------------------------------- |
| PersonalProviderConfigFile | schemaVersion: 1 | 个人文件的整份 config，包括 defaultModelSelection                 |
| ZCodeBuiltinRelease        | schemaVersion: 1 | 随包、释放副本、下载内容共用的内置发布格式；当前实现的 3 收口为 1 |
| 内置刷新记录               | schemaVersion: 1 | 刷新占用、时间、失败计数等记录                                    |
| Provider 分发状态文件      | schemaVersion: 1 | 已完成请求及结果的保存格式                                        |
| Provider 分发信封          | schemaVersion: 1 | 发往目标环境的整包配置、设置、凭据等内容                          |

成员层：ProviderConfig、ModelConfig、ModelSelection 不另设版本，由所在文件或信封管理。独立 Model Selection 文件及其版本外壳取消；Bot 的 version 字段 staging 已有，不算新增版本边界。

版本字段本身不执行迁移。用户配置通常通过迁移保留数据，可重建刷新记录可以重建，下载内容或传输信封可以拒绝不支持的格式。用户认可用途及上述版本边界；不因此为未发布中间格式补迁移，也不把每一处现有错误处理策略都算成已审完。

开发中间格式可能同样写着 schemaVersion: 1，不能只凭数字相同就认定它是最终格式；仍须按最终 schema 解码。不要求为这些中间文件补迁移。staging 的旧配置文件及 Bot 原文件则是已发布升级输入，不能因为新的 Provider 文件从 1 开始就跳过它们的导入。

### 6.12 内置发布 revision 与定向 review：裁决及待实施修复

发布层：用户主要关注内置配置的发布 revision。对会被同一客户端在同一配置来源内比较的随包 / 在线内容，采用统一的发布序号规则，不让打包和在线发布各自独立编号：

- 配置内容发生变化，发布 revision 必须增大。
- 相同 revision 必须对应相同内容；内容未变的重新打包可复用原序号。
- 回滚到旧内容也作为更大的 revision 重新发布，否则客户端会按旧发布忽略。
- schemaVersion 管格式，与发布 revision 分开；本轮 schemaVersion 收口为 1 不意味着重置发布序号。

revision 保留当前非负安全整数约束（不大于 Number.MAX_SAFE_INTEGER）；改为 schema 推导类型时不能放宽成任意 number。

运行时层：代码生成的内容标识、组合标识、视图计数不需要用户手动维护。staging 已有整份 Provider Registry 的内容 hash，本轮增加了分层标识和新的视图计数实现；不能把同一标识的传递字段都算成独立版本系统。

Review 结论：内置新旧序号比较、同序号内容冲突检查、个人配置在文件锁内校验保存依据的主路径暂未发现问题。另有一个行为问题已用真实文件 Source / ConfigService / RegistryService 组合复现，两处字段精简 / 命名问题已核实。用户询问的是三个修复方向本身是否有明显问题，并在无明显设计障碍的前提下要求落盘；以下记录为待实施方案，不表示当前实现已修好。

1. 运行时内置标识包含来源范围。当前 snapshotFromRelease 仅产生 zcode-builtin:<发布序号>，不同 Endpoint 有独立缓存且可出现相同发布序号。两个地址的配置序号相同、内容不同时，切换后 Source 已读取新内容，Registry 却因组合标识未变而跳过发布。运行时标识应纳入规范化 Endpoint 来源，并贯穿内置、组合配置及 Account 的依据标识；文件里的数值发布 revision 和比较规则保持。直接文件 Source / Worker 的来源传递也需一起核对，不能只在一个界面补刷新。

```text
地址 A：revision 20，model-a
               |
               | 切换到已有缓存的地址 B
               v
地址 B：revision 20，model-b
               |
当前复现：Source = model-b，Registry = model-a
修复目标：来源改变后运行时标识改变，Registry 发布 model-b
```

2. 删除 Provider 分发信封的 sourceRevision。当前字段计算后仅传输，没有消费者用它做判断；目标端去重使用 syncId。同步删除对应 schema / 推导类型成员和专用计算逻辑，保留实际使用的 syncId 去重，以及个人配置读取一致性校验所需的内容 hash。

3. Provider 分发结果的 registryRevision 改名为 configRevision。当前实际值是 snapshot.sourceRevisions.config，语义为配置来源组合标识，不是 Registry 的整数计数。同步调整共享结果 schema、结果写入、状态文件中的结果成员及相关消费者 / 用例；不额外增加另一份 revision 字段。

验证依据：8 个现有相关测试文件共 95 个用例通过；额外临时测试确认了同序号跨 Endpoint 切换后 Registry 不更新的问题。临时复现文件已从工作区移除，产品代码没有修改。修复实施时应把该场景补成正式回归测试，并验证真实 Host / Worker 的来源传递。以上三个方案没有发现明显的设计障碍，仍需实施后的验证，不能将本节理解成“现有实现全部无问题”。

证据：[内置运行时标识](../../../../packages/provider-node/src/zcode-builtin-provider-config-source.ts)、[Endpoint 切换](../../../../packages/provider-node/src/endpoint-scoped-zcode-builtin-source.ts)、[Registry 依据标识去重](../../../../packages/provider/src/registry-service.ts)、[分发标识生成](../../../../packages/services/src/model-provider/providerProvisioningSource.ts)、[分发结果写入](../../../../packages/services/src/model-provider/providerProvisioningTarget.ts)、[共享分发 schema](../../../../packages/shared/src/provider-provisioning.ts)。

### 6.13 刷新 / 分发记录：按最小必要改动收口

背景：用户起初接受第四组刷新 / 分发记录的建议，随后询问改动规模并要求“别太激进”。核对实际读写范围后，收缩为两个明确的小调整，以及默认选择文件合并所需的分发适配；不再为命名或少一层包裹单独改格式。本节为最终方案，取代曾提出的 endpointOrigin 和 results 数组方案。

#### 6.13.1 刷新文件

保留原字段及形状；文件目录 / 名称仍按 6.10 调整。endpointKey 当前对应规范化的配置服务来源，名字虽可更精确，本轮不改为 endpointOrigin。

```ts
interface RefreshControl {
  schemaVersion: 1;
  endpointKey: string;
  leaseId?: string;
  leaseUntil: number;
  nextEligibleAt: number;
  failureCount: number;
}
```

leaseId 标识一次刷新占用，leaseUntil 和 nextEligibleAt 为毫秒时间戳；保留现有锁、占用及重试机制，不借 schema 精修重写刷新流程。

#### 6.13.2 分发信封

删除无消费者的 sourceRevision（同 6.12）；personalConfig 随既定文件合并采用最终 PersonalProviderConfig 内容，包含 defaultModelSelection，去掉外层 configuredDefault。不为传输再保存一份默认选择。

```ts
interface ProviderProvisioningEnvelope {
  schemaVersion: 1;
  syncId: string;
  personalConfig: PersonalProviderConfig;
  accountSettings: ProviderProvisioningAccountSettings;
  credentials: ProviderProvisioningCredentialEntry[];
}
```

personalConfig 的具体层次复用 6.7；代码复用数据 schema 时保持包依赖单向，不因展示接口而要求 shared 反向依赖 provider 的行为实现。

#### 6.13.3 分发成员

账号设置和凭据项保持；账号连接选择不在本轮继续改名或重组。

```ts
interface ProviderProvisioningAccountSettings {
  providerFamilyDomain: "zai" | "bigmodel" | null;
  providerFamilyConnectionSelections: ProviderFamilyConnectionSelectionSettings;
}
```

```ts
interface ProviderProvisioningCredentialEntry {
  scope: "oauth-session" | "account-provider";
  key: string;
  value: string;
}
```

继续保留当前凭据范围校验及数组数量约束；不扩大可分发凭据的种类。

#### 6.13.4 分发状态文件

保留 records 包裹及记录层 syncId；不改成 results: ProviderProvisioningResult[]。现有结构虽有重复 ID，但没有发现必须为此改格式的行为问题。

```ts
interface ProvisioningStateFile {
  schemaVersion: 1;
  records: ProvisioningStateRecord[];
}
```

```ts
interface ProvisioningStateRecord {
  syncId: string;
  result: ProviderProvisioningResult;
}
```

#### 6.13.5 分发结果

仅将 registryRevision 改为 configRevision，准确表达已有值；状态、计数和回滚字段保持。当前状态文件保存成功结果，失败结果可返回给调用方，不因此增加失败历史持久化。

```ts
interface ProviderProvisioningResult {
  syncId: string;
  status: "applied" | "already-applied" | "unsupported" | "failed" | "rollback_failed";
  personalProviderCount: number;
  credentialCount: number;
  configRevision?: string;
  errorMessage?: string;
  rolledBack: boolean;
}
```

默认选择合并不是单纯改名，需要随个人文件合并调整写入、校验和失败回滚，避免仍按两份独立文件处理；保留目标端 syncId 去重及已有防止回滚覆盖新值的检查。不另外重构分发状态机。

此处 personalConfig 表示源端的整份个人配置快照，不是局部 patch；源端没有 defaultModelSelection 时，目标应用后也不保留旧的默认选择。对应回滚以合并后的个人文件作为同一份写入前 / 写入后快照，保留“期间被其他操作修改就不覆盖”的现有保护；不能再分别回滚规则和默认选择两次，造成整文件相互覆盖。这与普通字段编辑时保留未修改成员的语义不同。

```text
源端个人配置（含 defaultModelSelection）
            |
            v
同一信封 -> 目标端按 syncId 查重
                       |
                       +-- 已成功：返回既有结果
                       |
                       `-- 未执行：应用配置 / 设置 / 凭据并校验
                                      |-- 成功：保存 records
                                      `-- 失败：按实际写入范围回滚
```

证据：[刷新控制](../../../../packages/provider-node/src/zcode-builtin-remote-synchronizer.ts)、[共享分发 schema](../../../../packages/shared/src/provider-provisioning.ts)、[发送](../../../../packages/services/src/model-provider/providerProvisioningSource.ts)、[接收 / 回滚 / 状态记录](../../../../packages/services/src/model-provider/providerProvisioningTarget.ts)。

### 6.14 明确通过或不调整的其他结构

#### 6.14.1 既有结构接入 ModelSelection：统一通过

用户明确裁决：“所有在原有基础上新增一个 model selection 的，就都 pass 吧”。因此不逐一重新讨论会话 / 消息、最近选择、Subagent 状态、Wiki、Bot、Automation、Off-Peak 等消费位置的选择字段。它们复用第 2 节的通用选择；各入口原有的未选择 / 跟随默认语义属于上层，不扩张 ModelSelection 本身。

用户随后明确“pass 就是认可”：不得把这些项改标为跳过、未确认或要求重新批准。后续又明确旧字段不能删除，Off-Peak / Wiki 两处保留旧值的补充按 6.18 记录，不以此推翻已通过的 ModelSelection 结构。

本轮数据库改动清单补正如下；三列均位于既有 tasks-index.sqlite，不新增数据库或表：

| 既有表          | 新增列               | 本轮裁决                  |
| --------------- | -------------------- | ------------------------- |
| automations     | model_selection TEXT | 复用 ModelSelection，通过 |
| automation_runs | model_selection TEXT | 复用 ModelSelection，通过 |
| off_peak_tasks  | model_selection TEXT | 复用 ModelSelection，通过 |

最近选择的新 localStorage key（zcode-model-selection-recent-v1 加工作区身份）属于客户端存储，不是新 JSON 文件或数据表。Subagent Markdown 仍有原有 model / thoughtLevel 文本表达，不因本次通过而要求全改为 JSON。Bot 按 6.10 纠正后的裁决保留 v3 新文件；“通过选择结构”不要求额外调整 Bot 路径。

通过的是 schema 设计，不豁免 staging 数据迁移验证；例如 SQL NULL、JSON null 和明确选择的既有区别，实施时仍需保留其上层语义。

证据：[Automation 与运行记录](../../../../packages/services/src/session/automationRepo.ts)、[Off-Peak](../../../../packages/services/src/session/offPeakTaskRepo.ts)、[最近选择](../../../../packages/ui/src/lib/composerRecent.ts)、[Subagent Markdown](../../../../packages/shared/src/subagent-markdown-selection.ts)。

#### 6.14.2 账号连接选择：明确不调整

保留现有 setting.json 内 providerFamilyConnectionSelections：zai / bigmodel 分别保存连接选择；kind 为 start-plan、individual-coding-plan 或 team-coding-plan，团队项带 productId、organizationId、projectId。用户已将此前“先忽略”明确为“不调整”，不进行 kind / mode 命名统一，也不重组字段；不再列为待讨论的命名问题。

已有 schema 却重复手写类型的问题仍按第 1.1 节统一处理；这是实现的类型来源整理，不改变持久化格式。证据：[账号连接选择 schema 与重复类型](../../../../packages/shared/src/provider-family-connection-selection.ts)。

#### 6.14.3 账号凭据 key：保持现状

保留现有 credentials.json 内 account-provider:...:api-key 的 key 组成和编码方式：包含 Provider、账号身份及团队所需的产品 / 组织 / 项目 ID。用户明确不做这一项；不把 coding-plan / team 改成 individual-coding-plan / team-coding-plan，也不借此重做凭据存储。

证据：[凭据 key 生成](../../../../packages/services/src/model-provider/accountProviderCredentialKey.ts)。

来源专用 schema 的字段范围同样已明确“不调整”，沿用 6.8；原有 schema 推导类型原则及此前确认的公共字段改名保持，不因此新增来源限制。

### 6.15 本轮目标是否达到与实施边界

以“相比 staging 的 Provider / ModelSelection 改造”为范围，本轮已梳理核心 schema、规则及来源、物理文件与新增表列、schemaVersion、revision 和直接关联的分发记录。后续回滚讨论新增了 6.18 的旧字段保留约束；Session 已确定改为新增 modelSelection 字段。用户随后要求只复审本 Todo 要修改的内容，6.19 已据此收紧为 13 项并获认可；其他 Todo 的内容不重新打开。设计复审不代表实现或上线验证完成。

| 审阅项                                                | 当前结论                        |
| ----------------------------------------------------- | ------------------------------- |
| ModelSelection、ProviderConfig、ModelConfig           | 第 2、3、5 节已定               |
| 智能 / 手动、各层规则、Provider / Template 外层及名称 | 第 6.1–6.7 节已定               |
| 来源专用字段限制                                      | 第 6.8 节保留现状，定向审阅通过 |
| 默认选择、文件路径、Bot 文件、资源覆盖及新增表列      | 第 6.9–6.10、6.14 节已定        |
| 五处格式版本、发布 revision、运行时标识问题           | 第 6.11–6.12 节已定，修复未实施 |
| 刷新 / 分发记录                                       | 第 6.13 节按收缩方案处理        |
| 其他 ModelSelection 接入、账号选择及凭据 key          | 第 6.14 节通过或明确不调整      |
| schema 单一来源                                       | 第 1.1、7 节作为实施原则        |

尚未达到的是“实现完成，可以正式上线”：当前仍是旧实现，字段 / 文件改造、已复现的 revision 问题都未落实。正式上线前需要用实际结果证明：新安装写最终格式，staging 已发布数据直接迁入同一最终格式；不支持本分支未发布中间格式。这是已有裁决的实施验证，不是继续设计另一套 schema。

```text
全新安装 --------------------> 最终格式
staging 已发布数据 --升级----> 同一最终格式
本分支未发布中间格式 --------> 不要求兼容
```

实施验收集中在三件具体工作：按本文落地 schema / 读写 / 消费者；验证 staging 升级和重复启动不会丢失或复活旧配置；验证默认选择合并后的分发 / 回滚及同序号跨 Endpoint 切换修复。遇到实际冲突再报告，不预设新的字段和迁移版本。

本结论是设计审阅收口，不承诺永远无需后续迁移，也不是对整个分支无关功能的持久化做了全仓审计。非法手改文件、未来版本兼容等未新增裁决的行为保持本轮范围，不因本文自动获得扩大改造的授权。

### 6.16 实施定位与文档复核补充

以下只把已有裁决对应到实际入口，避免只改 schema 定义却漏掉写回、迁移或独立 CLI；不增加新的改造目标。本次核对的 staging 引用为 790884b1ce，后续实施若基线变化，应复核相关差异，不把快照当作永远不变的事实。

| 已有裁决                       | 必须一起核对的入口                                                                                                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 字段改名、规则分组及去掉 type  | provider/config/schema.ts 的解析、provider-config.ts / model-config.ts 的构造及 toJSON、toPersonalJSON、toZCodeBuiltinJSON；不能只改展示类型，写回仍出现旧字段                                                      |
| 个人 config 包装和默认选择合并 | provider-node 的 provider-config-file-codec.ts、personal-provider-config-repository.ts、model-selection-config-repository.ts，以及宿主装配和默认选择订阅；不得保留第二个持续写入的 model-selection.json             |
| staging 个人配置导入           | App 的 legacyPersonalProviderConfigImporter.ts 与独立 CLI 的 legacy-cli-personal-provider-config-importer.ts 都输出最终格式；保留现有用户意图提取和旧身份转换，不把旧 Effective Config 的系统默认能力冻结成用户覆盖 |
| Bot 保留 v3 新文件             | bots/repo.ts 与 storageMigration.ts 沿用当前新文件导入链路；验证旧配置 / 草稿选择进入 v3 文件，旧文件不被覆盖，不实施此前误记的原路径迁移                                                                           |
| 内置发布和运行时来源标识       | config/provider/zcode-builtin.json、release codec、下载 Source、固定资源释放路径及 CLI / Server 内嵌资源链路一起核对，随包与下载使用同一最终发布 schema                                                             |
| 分发适配                       | shared/provider-provisioning.ts 与 Source / Target / 状态结果编解码一起变更；发送、接收和失败回滚读取同一份 personalConfig                                                                                          |

已有迁移入口证据：[App 个人配置导入](../../../../packages/services/src/model-provider/legacyPersonalProviderConfigImporter.ts)、[独立 CLI 个人配置导入](../../../../apps/zcode-cli/packages/bootstrap/src/app/legacy-cli-personal-provider-config-importer.ts)、[Bot 存储迁移](../../../../packages/services/src/bots/storageMigration.ts)。其他代码入口见相应裁决章节，不再复制一套实现设计。

文档复核补全的是：公共 Match 示例与正式 schema 的区别、完整 / 手动配置关系、enabled 与 null 覆盖语义、规则顺序及身份唯一性、默认选择合并后的完整读写与回滚、最终版本 1 和旧数据导入的区别。以上均用于把已有裁决和必须保留的现有行为写明确；若实施发现需要改变这些行为，另报具体原因，不能将“文档完善”当作扩大产品改造的授权。

### 6.17 按可验证性全面复评：保留方案，区分验证难度与工作量

用户明确以“容易验证的都不算高风险”为本轮判断口径。此前将默认选择合并、外层重组等因影响面广而直接列为高风险，混入了工作量判断；本节取代该分级，不把复杂度等同于难以验证。恢复 6.9 的默认选择合并；Bot 按 6.10 纠正误记后保留现有 v3 新文件。没有新增字段裁决，也未授权开始产品实现。

复评结论：目前各项都有可构造的输入与可判定的结果，没有发现因验证困难而必须撤回的变更。默认选择合并、revision 传递和资源覆盖需要更完整的集成 / 打包验证，但验证方法明确。“能够验证”不表示“当前测试已经证明最终方案正确”；下表是实施时针对实际风险的验证依据。

| 改动组                                              | 明确的判定结果                                                                                         | 验证方式与目前边界                                                                                                                                |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| ModelSelection 及已有结构接入                       | 同一 providerId / modelId / reasoningLevel 读写后保持；各上层空值语义保持                              | 复用已有消费者和迁移测试，按用户裁决通过结构，不逐个重新设计；新增三列仍核对升级读写                                                              |
| Provider / Model 字段改名、属性归位、选项 type 删除 | 最终文件只含目标字段，读写往返不丢值；最终有效配置语义保持                                             | schema 正反例、序列化断言、转换前后有效值对照，易于确定结果；不拿“同一个错误 codec 自己往返成功”代替独立预期值                                    |
| Provider / Template 外层重组及名称                  | ID、模板关系、覆盖值和顺序保持；创建名称按语言取值并去重，重启后不变                                   | 现有创建 / 并发去重 / Overlay 测试可适配；补目标数组与字段外移的明确断言及设置操作 E2E。工作量较大，但结果直接可比                                |
| 智能 / 手动分组、来源专用 schema                    | 非法来源字段和不完整手动规则被拒绝且不留下半次修改；enabled 独立保留，手动参数不随前层更新             | 现有固定配置 / 来源限制 / 原子编辑测试有对应场景，补集合互斥和新 schema 用例，易于验证                                                            |
| Match 分层、删除 providerMatch、四条规则移 Site     | 各层拒绝越界字段；指定 Endpoint / API / 模型命中，邻近但不符合的输入不命中；规则顺序保持               | 用显式预期的命中 / 不命中矩阵验证，包含普通 API Key 同 Endpoint、Start Plan 与 Off-Peak 边界。验证本地声明的范围，不宣称由此证明远端模型真实能力  |
| 默认选择合并及分发适配                              | 修改任一成员不丢其他成员；清除后重启不恢复旧选择；并发修改均保留；分发失败恢复原值且不覆盖期间新修改   | 文件更新、导入、故障注入可以稳定构造；另补真实两个进程的写入 / 通知及实际分发集成。可验证，需较多集成工作                                         |
| staging 导入与 Bot 文件                             | 新安装和旧数据导入均生成最终格式，重复启动不重复导入；Bot 仍写 v3 文件，旧文件保持原样                 | App / CLI 已有 importer 及 Bot 测试可复用，以旧文件 fixture 和独立预期结果核对；不安排误记的 Bot 原路径改造                                       |
| schemaVersion 与内置发布 revision                   | 五个格式边界接受最终版本 1，拒绝不符合结构的输入；发布比较接受更高序号、拒绝同序号异内容               | codec / release 测试能验证比较机制；实际打包 / 在线发布还须在同一发布范围核对真实 revision 与内容，单测不能代替发布序号管理                       |
| 内置运行时 revision 来源修复                        | 两个 Endpoint 同序号不同内容时，切换后 Source、Account、Registry、Worker 最终一致且实际使用新配置      | 已有真实 Source / Config / Registry 的临时复现；补成正式回归并覆盖真实 Host / Worker。可观测、可重现，不能只用内存 mock 证明整条链路              |
| runtime/provider 路径及固定资源覆盖                 | 各宿主读写正确隔离目录；固定资源变更时替换、未变时复用，不新增按 hash 增长的副本，读取不到半份文件     | 临时目录文件测试、并发读写 / 失败场景，加 Desktop / CLI / Server 实际构建产物启动检查；原子替换在所支持系统上验证。沿用退出旧程序再升级的已定前提 |
| schema 单一来源与分发两处小调整                     | 类型从 schema 得到，解析前后 / class 序列化边界不混淆；sourceRevision 无残留消费者，结果值仍为配置标识 | 类型检查、负向类型用例按需要补充、codec 行为测试、依赖检查和发送 / 接收协议用例。不能只用类型通过证明运行时校验未被放宽；没有重写行为类的要求     |

本次只读核对发现的验证边界：provider-node-runtime.test.ts 中名为“多个进程并发首次读取”的用例实际是在同一进程创建两个 Repository，能验证多实例调用，不能独立证明跨进程锁与通知。providerProvisioningTarget.test.ts 已有失败回滚、并发凭据保护和空快照同步场景，但主要使用 mock；可以作为适配基础，不等于合并后的真实文件回滚已验证。资源物化测试目前验证按 hash 保留旧版本，实施固定路径方案时必须替换这一旧预期。

针对最需要集成验证的两条链路，使用可控执行屏障、故障注入和实际持久化结果判定，不靠多跑几次或任意 sleep 碰概率：

```text
进程 A 修改 Provider ----+
进程 B 修改默认选择 -----+-> 同一文件更新 -> 两项均保留 -> 另一进程读到新值
                                  |
                           分发应用后注入失败
                                  `-> 检查原值恢复 / 期间新值不被覆盖

Endpoint A(rev 20) -> 切换到 B(rev 20，内容不同)
                                  `-> Source -> Account / Registry -> Worker 使用 B
```

保留全部已确认的目标改动；按数据结构、文件合并、来源标识与路径装配分别形成可验证的实施步骤。因共享依赖必须联动的代码在同一步改全，不为拆提交引入临时双写、中间迁移或新兼容格式。实施结束用验证结果确认，而非仅凭本次可验证性评估宣称上线完成。

证据：[配置与固定模式测试](../../../../packages/provider/test/config-service.test.ts)、[规则测试](../../../../packages/provider/test/model-config-rules.test.ts)、[Node 存储 / 物化测试](../../../../packages/provider-node/test/provider-node-runtime.test.ts)、[分发目标测试](../../../../packages/services/test/providerProvisioningTarget.test.ts)。本次未运行针对未来目标的产品测试，也未改产品代码。

### 6.18 实用回滚：旧字段保留与三处待修裁决

用户倾向新增字段 / 新增文件，方便实用回滚，并进一步明确“字段就是不能删除”。旧值保留供旧版使用，新版只更新自身字段，不要求把新版值持续反向同步成旧格式。该约束针对本 Todo 修改的 staging 已发布存储；本分支未发布的新 Provider 格式仍按前文裁决改名、分组和合并，不能把这两类“旧字段”混为一谈。Subagent Markdown 已在 Todo 97 明确采用原字段身份迁移，用户要求尊重其可读性取舍，本 Todo 不推翻该方案，见 6.19.2。

#### 6.18.1 Off-Peak：待修，旧模型列不再清空

现有表已新增 model_selection，但 updateEditableFields 保存时还会将 model / thought_level 置为 NULL。用户要求修复为：只更新新选择和本次业务编辑字段，旧模型列保留现存值，不清空，也不按新选择反向改写。新建记录没有旧值时，无须捏造旧版选择。

实现范围：从当前 UPDATE 中去掉 model = NULL / thought_level = NULL 两个赋值；沿用已有字段更新、校验和保存入口，不新增保存机制。

验收直接检查 SQLite 原始列：只改标题或修改新选择后，两个旧模型列仍与修改前相同，新版实际读取的 modelSelection 正确。此项目前未实施。

#### 6.18.2 Wiki / Draft：待修，保存时保留旧字段

当前读取会将 generationModel / generationOptions.thoughtLevel 转成新版 modelSelection，但输出给运行层的对象不再包含旧模型字段；直接把运行对象写回会删除磁盘旧值。用户要求修复为正常保存后旧字段仍保留，内容只作回滚快照，不参与新版选择解析。

改动应集中在 RepoWikiStorage 对 Wiki / Draft 的保存适配：保存时保留磁盘中上述几个旧值，复用现有文件锁及 atomicWriteText 原子写入能力。读取后旧字段已不在运行对象里，所以不能声称只删两行即可完成；但不需要重做保存服务、引入缓存或后台同步，也不改写通用 IO 工具。新增文件无旧值时不伪造旧参数。若实现必须超出这一局部范围，应说明具体原因，不能把保留字段扩成保存架构重构。

同样核实到 staging 的 generationOptions.maxOutputTokens 是已发布字段：旧字段保留原则也适用于这一存量值。新版依然使用模型 Limit，不恢复手动输出预算，也不为新文件生成旧预算；这是对 Todo 94“正常保存移除旧预算”的存储行为补充，不推翻它的执行和 UI 裁决。

验收覆盖 Wiki 和 Draft：保存新的选择后，旧模型 / reasoning / 预算原值仍在，正文及当前 generateDiagrams 正常保存；旧参数不进入当前请求。保留旧值以后还需验证显式清除或无效的新选择在重启后不会被旧字段复活。具体保存标记和读写实现不在本轮擅自定型，不能把前次已撤回实现里的 modelSelection: null 当成新的用户 schema 裁决。

```text
磁盘旧字段 -- 保留原值 ----------------> 回滚后的旧版读取
新版选择   -- 更新新字段 / 新文件 -----> 当前版本读取
               |
               `-- 清除后仍以新版状态为准，不重新导入旧值
```

#### 6.18.3 Session：新增 modelSelection 字段，保留旧字段

2026-09-10 实施更新：B1c 已落实磁盘包装与旧快照保留，局部集成回归通过，完整交付验证仍跟随 B5。下文“当前迁移后”为改造前的调查示例。逻辑 SessionStorePort 沿用 ModelSelection payload，adapter 统一包装/解包；不要求 core/bootstrap 感知回滚字段。证据及边界见 [实施账本](../research/todo104-schema-implementation-ledger.md)。

数据库 session_entry 中已有 type 为 runtime/model_selection 的“当前模型选择”记录。当前迁移若命中这条旧记录，会沿用其 id，改写它的 data JSON；从旧消息推导选择时则新增一条 entry。旧 message 行保持原字节。以能确定的旧 Z.ai Coding Plan 身份为例：

```text
同一条 session_entry.data（迁移前）
  providerId: "builtin:zai-coding-plan"
  modelId: "GLM-5.2"
  thoughtLevel: "high"
                 |
                 v
同一条 session_entry.data（当前迁移后）
  providerId: "account:zai-individual-coding-plan"
  modelId: "GLM-5.2"
  options: { reasoningLevel: "high" }
```

这里有两处原位损失：thoughtLevel 被替换；providerId 虽然字段名相同，但值也改变了。仅保留 thoughtLevel 不等于保留旧版原来的模型身份。再次对照 origin/staging@790884b1ce，旧版确实已有相同 type 和稳定 id 的选择记录，不是本分支新建的记录类别。

用户已确认这是遗漏，并明确要求改为新字段迁移。最终方案：保留同一条 entry 的 id / type，在 data 中新增 modelSelection；旧 providerId / modelId / thoughtLevel 保留原值，后续新版选择写入只更新新成员，不持续反向同步旧字段。不新增表、不另建 entry 类型；该裁决取代此前待讨论状态及“另存新版记录”的未定建议。

记录外层：沿用已有 session_entry 元数据与 runtime/model_selection 类别，不调整结构。

data 层：旧字段仅承载已有回滚快照，新成员承载当前选择。旧字段可选，因为新建记录无须伪造旧值；这里只展示相关成员，不授权删除 data 中其他已有字段。

```ts
interface SessionModelSelectionEntryData {
  providerId?: string;
  modelId?: string;
  thoughtLevel?: string;
  modelSelection?: ModelSelection;
}
```

modelSelection 层：复用第 2 节通用结构，不另建一套 Provider / Model 身份定义。

```text
首次升级：旧 providerId / modelId / thoughtLevel
             |-- 原值保留 ----------------> 旧版读取
             `-- 转换后写入 modelSelection -> 新版读取
后续修改：只更新 modelSelection，保留旧字段原值
```

已有旧 entry 时补新成员；没有 entry、仅有旧消息时仍可创建选择 entry，但将新选择放进 modelSelection，旧消息不改。新版读取、保存、恢复及 fork 等复制选择入口必须适配包装，不能只修改迁移函数。已经存在新版状态时不得重新从旧字段或历史消息补值；清除 / 无效选择后重启不复活旧值，具体空值标记继续沿用上层约束，不借本接口展示额外裁决 null 格式。

验收读取数据库原始 JSON：迁移前后旧字段逐值相同，新成员身份和档位转换正确；修改新版选择仍保留旧快照；重复迁移幂等；旧消息不变。另用目标旧版 reader 检查仍可读取原身份与档位。本项尚未修改代码或运行目标方案测试。

旧版行为核查仅为当前静态证据：上述 staging 的桌面 / Web 恢复链路能读陌生 ID，但将对应模型判为不可用；有可用模型时有回退路径，无可用模型时历史可打开、发送受阻。旧版不读取 options.reasoningLevel。因此本裁决解决的是原选择快照丢失，不应声称旧版必然打不开整个会话；也未宣称已完成旧 App 实机回滚。

证据：[Off-Peak 编辑](../../../../packages/services/src/session/offPeakTaskRepo.ts)、[Wiki 存储](../../../../packages/services/src/repo-wiki/repoWikiStorage.ts)、[Session 选择迁移](../../../../apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/model-selection-migration.ts)、[旧身份转换](../../../../packages/shared/src/legacy-model-provider-identity.ts)、[实用回滚原边界](./todo-69-provider-refactor-practical-rollback-compatibility.md)。

#### 6.18.4 仍需留意的具体边界

- Session 新字段迁移已经裁决，待实施；ModelSelection 通用结构和其他 pass 保持。6.19 只列本 Todo 要改的项目，用户已认可收紧后的范围。
- 保留旧值后的“新版清除选择不能复活旧值”属于三项待修的验证要求，不需要为此先扩大通用 ModelSelection。
- Todo 69 的回滚证据针对其文档中冻结的 staging Reader，且未宣称完整旧 App 实机回滚；实施验收应明确实际回滚目标，不把新版读写测试通过当作旧版可读的证据。

本轮仅落盘上述裁决及待讨论点。此前误开始的两处实现和测试已全部撤回，没有保留产品修改；未来须待用户明确开始实施后再落实，并重新按测试先行验证。

### 6.19 本 Todo 核心 schema 之外的修改清单：范围已收紧、已认可

用户明确“我只裁决我们这个 todo 要改的，其他的不看了”“确保别改坏了就行，漏了没事”。本节取代此前混入当前分支已有行为的 A/B/C 清单；仅保留 Todo 99 将要实施的改动，省略已在前文定案的 Provider / Model Config 和规则内部字段。用户已认可其他项，并在了解 Off-Peak / Wiki 的局部保存方案及 Todo 97 背景后再次确认；仍无产品实施授权。

#### 6.19.1 本 Todo 要修改的 13 项配套内容

| 编号 | 项目               | 已确认修改与边界                                                                                                                                                             |
| ---- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Session 选择迁移   | 原 entry.data 新增 modelSelection，保留旧 providerId / modelId / thoughtLevel 原值；读取、保存、恢复及 fork 等复制入口一起适配。不新增表或 entry 类型，见 6.18.3。           |
| 2    | Off-Peak 保存      | 当前 UPDATE 不再将旧 model / thought_level 置 NULL；沿用既有保存链路，见 6.18.1。                                                                                            |
| 3    | Wiki / Draft 保存  | 存储层保存时保留旧模型、档位及 maxOutputTokens 原值，复用已有锁与原子写；不恢复旧预算功能，不重构保存机制，见 6.18.2。                                                       |
| 4    | 默认选择文件合并   | model-selection.json 合并到 provider_config.json 的 config.defaultModelSelection；调整读写、持锁更新、冲突检查和通知。清除选择不删除整个文件，不授权顺带删除旧文件，见 6.9。 |
| 5    | 下载配置路径       | active.json 改为 runtime/provider/<平台>/<应用版本>/<服务端地址标识>/zcode-builtin.json，保留三个隔离维度。                                                                  |
| 6    | 刷新记录路径       | refresh-control.json 改为上述同目录的 zcode-builtin-refresh.json；内部字段、占用和重试机制保持。                                                                             |
| 7    | 分发记录路径       | provider-provisioning-state.json 改为 runtime/provider/provisioning.json；保留 records / syncId 及去重语义。                                                                 |
| 8    | 内嵌资源副本       | 固定 runtime/provider/bundled/zcode-builtin.json，启动时内容不同则原子覆盖，不再按 hash 产生多份资源副本。以上路径见 6.10。                                                  |
| 9    | 格式版本收口       | 最终五处 schemaVersion 统一为 1；默认选择独立版本外壳随合并取消，Bot 仍保留 version: 3，见 6.11。                                                                            |
| 10   | 来源切换刷新修复   | 运行时内置标识纳入 Endpoint 来源，并贯穿现有消费者；修复不同地址同 revision、不同内容时不刷新，不新增持久化 revision 字段，见 6.12。                                         |
| 11   | 分发信封与回滚适配 | 删除无调用的 sourceRevision；默认选择随 personalConfig 传递，移除外层 configuredDefault；整份个人文件统一应用、校验和失败回滚，保留并发修改保护，见 6.13。                   |
| 12   | 分发结果改名       | registryRevision 改为 configRevision，实际值和其他结果字段不变，不精简 records 包裹，见 6.13。                                                                               |
| 13   | 重复类型清理       | 本 Todo 范围从 schema 推导数据类型；核心之外包括账号连接选择重复类型，不改变其持久化字段，见 1.1 / 7。                                                                       |

已在核心 schema 定案中要求的解析、序列化、App / 独立 CLI staging 导入及消费者适配仍按 6.16 完整执行；上述清单不是把它们取消。内置发布 revision 的统一单调规则仍按 6.12 保持，但不把发布约定另列成一个新存储改造。

本 Todo 不要求重做消息 / Part 格式、用量表、全局 reasoning 偏好、最近选择、Automation、Bot、账号连接或凭据机制；6.14 中已 pass / 明确不调整的结论保持。核心接口变更所必需的调用适配仍要完成，不能据此顺带重构这些业务或修改其存储格式。

#### 6.19.2 Subagent Markdown：纠正误判，尊重 Todo 97 的取舍

此前将 A10 原位 Provider 身份转换写成“新发现、待本轮裁决”是错误记录，现撤销。原始依据是 [Todo 97 §1–3](./todo-97-subagent-markdown-in-place-migration-and-legacy-read-audit.md)：Markdown 供用户阅读、手动编辑，正式格式明确保留 model / thoughtLevel；仅用户数据目录中的旧 Provider 身份在原字段内迁移，项目 / 插件文件不自动写回。迁移保留模型 ID、档位、正文、注释和其他无关内容。原字段在这里属于正式格式，不能机械套用其他 JSON 存储的“旧字段”定义。

这是已裁决的可读性取舍，不只是因另有 Todo 而暂时搁置。本 Todo 不把 Markdown 改成嵌套 modelSelection，不新增字段、影子文件或旧身份兼容旁路，也不重新要求用户批准 Todo 97。既有执行与测试证据由 Todo 97 维护，不将它们转成 Todo 99 新任务。

#### 6.19.3 验证要求的具体含义

下列是已确认行为的验收例子，不是新增四套机制；优先复用现有读写和并发保护，不因检查要求重做架构。

```text
旧值保留：
旧字段存 A -> 新版选择 B -> 旧字段仍是 A，新字段是 B

清除不复活：
新版清除 B -> 重启 -> 仍为未选择，不重新从旧字段导入 A

合并不误覆盖：
修改默认模型 -> 同文件中 API Key、Provider 配置仍保留

失败回滚不误覆盖：
分发写入 B -> 用户又保存 C -> 分发失败
                               `-> 不把用户的 C 覆盖成分发前的 A
```

清除示例只适用于原有业务允许清除的入口；Off-Peak 当前不允许保存空选择，不为该通用例子增加清除功能。这里只要求既有空值语义和保存正确性，不擅自新增 null 格式或全局兼容框架。遗漏的其他问题可以另记，不能作为本 Todo 无限扩项的理由。

## 7. Schema / 手写类型定向核查

范围为本轮讨论的核心结构及直接关联的完整配置 / 协议类型，不宣称已完成全仓持久化结构审计。

| 结构                                               | 核查事实                                                                                                                                | 后续整理方向                                                                                                |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| ModelSelection                                     | shared/model-selection.ts 已用 z.infer；provider/registry.ts 重导出并从 options 派生，不重复手写                                        | 保持                                                                                                        |
| ProviderConfig、API、Access、Logo、Template        | config/schema.ts 有运行时定义，provider-config.ts 仍手写 Input / Object / 接口等对应字段                                                | 从基础数据 schema 推导，区分带方法的 class 输入与序列化对象                                                 |
| ModelConfig、Properties、输入输出格式、OptionSpecs | config/schema.ts 有运行时定义，model-config.ts 另手写 Input / Object 等字段                                                             | 共享 schema，推导数据类型；不把 class 删除视作前提                                                          |
| ModelConfigRule 三种成员                           | schema 工厂定义规则结构，model-config.ts 又手写规则接口                                                                                 | 从各具体规则 schema 推导；工厂参数当前使用 ZodTypeAny，实施时需保留 config 的具体类型，不能让推导退化为 any |
| Registry 完整配置                                  | resolver.ts 另手写 RegistryModelConfig / RegistryModelConfigObject 等完整成员；目前完整性依靠 validateComplete，而非已有独立完整 schema | 与完整 / 稀疏 / 固定配置共享字段定义，不错误声称这里已存在完整 schema 只是没 infer                          |
| 协议 ZCodeProviderAccountAccess                    | shared/zcode-protocol/index.ts 已从 schema infer；Resolver 中仍有手写的同形 Registry 账号访问结构                                       | 保留已推导协议类型；共享数据形状时遵守包依赖方向                                                            |
| 账号连接选择及设置                                 | shared/provider-family-connection-selection.ts 已定义两个 schema，但又手写联合类型及设置映射类型                                        | 改为从 schema 推导；不改变 kind、团队 ID 或持久化形状，用户已跳过结构调整                                   |

证据：[ModelSelection](../../../../packages/shared/src/model-selection.ts)、[Registry Selection 重用](../../../../packages/provider/src/registry.ts)、[配置 schema](../../../../packages/provider/src/config/schema.ts)、[Provider 类型](../../../../packages/provider/src/config/provider-config.ts)、[Model / Rule 类型](../../../../packages/provider/src/config/model-config.ts)、[Registry 完整类型](../../../../packages/provider/src/resolver.ts)、[协议类型](../../../../packages/shared/src/zcode-protocol/index.ts)。

## 8. 后续 Todo 与当前边界

- [x] 记录审阅背景、允许重组未发布 schema 的原则，以及先讨论再实施的约定。
- [x] 记录已确认的 ModelSelection 形状及上层默认状态、max output 的边界。
- [x] 记录 ProviderConfig 两处改名、保留 API 嵌套的 OAuth 背景，以及 entitled 等保留项。
- [x] 记录 ModelConfig 的分层裁决：输入输出字段命名、MFJS 字段归位和两个选项 type 删除。
- [x] 记录两处 Match 字段改名、条件 config / 分层 Match / Provider 外壳的讨论状态，以及 schema 推导类型原则和定向核查。
- [x] 记录智能 / 手动配置演进与 ManualModelConfig 命名、Provider 规则集合和身份外移裁决；useSmartConfig 中间方案已被集合分组取代。
- [x] 确认不新增 ProviderModelRuleIdentity，直接复用现有规则 schema 派生智能 / 手动分支。
- [x] 记录 builtinProviderModelRules 命名、三层 Match 的严格边界、modelMatch 必填，以及 providerMatch 字段 / 匹配逻辑删除。
- [x] 记录四条旧 Provider 条件规则全部迁入 Site 层，取代账号媒体放实例层的旧建议；保留已确认的站点通用规则。
- [x] 记录 templateNameMap、外层 providerName、ProviderConfigRule 类型名纠正，以及模板默认名称在创建时去重并保存的裁决。
- [x] 记录普通 / 手动模型规则分为两个数组，同一模型身份在个人集合内互斥，不新增 Identity、不持久化 useSmartConfig。
- [x] 删除目标结构中由集合确定的重复规则 type，保留 API / Access / Logo 的有效 type。
- [x] 记录个人文件增加 config 内容层，以及完整的内置 / 个人文件分层结构。
- [x] 记录 model-selection.json 合并进个人文件，使用 config.defaultModelSelection，复用通用 ModelSelection；独立文件方案被本裁决取代。
- [x] 记录新增文件取舍、runtime/provider 目录与下载 / 刷新文件命名，取代 cache + state 方案；Bot 保留 v3 新文件，原路径迁移属于已撤销误记；内置资源改为固定文件原子覆盖，不保留 hash 历史副本。
- [x] 记录新增内置发布格式 schemaVersion 定为 1，以及不要求兼容未发布中间格式的边界。
- [x] 记录来源专用 schema 由基础 schema 派生的要求；现有边界经定向核查通过，不追加结构调整。
- [x] 记录五处 schemaVersion 边界、统一内置发布序号规则，以及 revision review 的事实和三个待实施方案。
- [x] 记录刷新 / 分发记录的收缩裁决：保留 endpointKey 和 records 包裹，只做两个明确字段调整及默认选择合并所需适配。
- [x] 记录其他既有结构接入 ModelSelection 统一通过；补齐三个现有表的新增列，区分无新表与无新列。
- [x] 记录账号连接选择、凭据 key 及来源字段限制明确不调整；账号选择重复手写类型仍按唯一来源原则整理。
- [x] 核对核心结构审阅覆盖并记录实施 / 上线验证边界；Session 回滚遗漏按 6.18 新字段迁移裁决处理。
- [x] 文档复核补清 Match / 手动配置边界、覆盖和顺序、身份迁移、合并文件读写 / 回滚及 Bot 既有导入入口，见 1.2、6.2–6.4、6.9–6.13、6.16。
- [x] 恢复默认选择文件合并，纠正 Bot 原路径迁移误记，并按可验证性重新评估全部变更，见 6.17。
- [x] 记录 pass 就是认可、已发布旧字段不删除、Off-Peak / Wiki 两处待修，以及只讨论 / 落盘文档的授权边界，见 6.18。
- [x] 确定 Session 在已有 entry.data 新增 modelSelection，保留旧字段原值，不新增表或 entry 类型；见 6.18.3。
- [x] Session 新字段迁移及读取 / 保存 / 复制入口适配，验证旧字段保留、迁移幂等及清除不复活；B1c 与 B5 证据见账本。
- [x] 6.19 收紧为本 Todo 要改的 13 项配套内容并获认可；撤销 Subagent A10 误判，链接 Todo 97 的已裁决取舍，不再列为待讨论或待实施项。
- [x] Off-Peak / Wiki 旧字段保留，验证旧值保留且不会复活新版已清除的选择。
- [x] 6.12 来源标识修复、sourceRevision 删除、registryRevision 改名；真实文件 Source/Registry 及实际构建 Worker 的来源交付与精确模型请求通过。
- [x] 按第 1.1 节原则整理第 7 节重复数据类型，复用 schema 并保持依赖单向；含账号连接类型，运行时字段不变。
- [x] 落实第 3、5、6 节字段、模式与结构，配套 schema、序列化、消费者及批次验证；保留 api 层，不实施被撤回或跳过的建议。
- [ ] 完成 6.15 的实施验收：全新安装与 staging 升级收敛到最终格式，验证重复启动、分发回滚及来源切换；不为未发布中间格式补迁移。

后续实施沿用仓库 spec / 测试约定；真正落地并验证后，再同步 Design V2 的现行描述和本 Todo 状态。本次只记录裁决，不直接创建迁移版本、OAuth 字段、全局命名规范或新的架构改造；defaultModelSelection 已按 6.9 确认，但仍须在用户授权实施后落到产品代码。

本次交付仅为文档与入口索引；本轮限定范围的设计审阅已收口，字段改名、运行逻辑调整和上线验证尚未完成。

首次落盘验证：基线新鲜度、当时的 13 个本地引用、本文格式、`git diff --check`、根 `pnpm typecheck` 和 `pnpm lint` 均通过（lint 有 39 条存量警告、0 错误）。文档记录不涉及产品代码修改，未新增或运行产品行为测试。

2026-09-09 全面收口落盘：仅更新本文和两个入口索引；基线新鲜度、三个文档格式、150 个本地引用、git diff --check、pnpm typecheck、pnpm lint 均通过（39 条存量警告、0 错误）。此前来源限制定向核查的 66 个现有测试通过；本次没有新增产品代码或重复执行产品测试。

2026-09-09 文档全面复核：补清已有裁决对应的解析 / 序列化、合并读写、迁移及回滚边界；仅修改本文，无产品实现变更。基线新鲜度、本文格式、60 个本地引用、git diff --check、pnpm typecheck、pnpm lint 均通过（39 条存量警告、0 错误），未新增或重复运行产品测试。

2026-09-09 可验证性复评：恢复默认选择合并，纠正 Bot 文件误记，更新本文及两个索引。基线新鲜度、三个文档格式、157 个本地引用、git diff --check、pnpm typecheck、pnpm lint 均通过（39 条存量警告、0 错误）。仅核对了现有测试的覆盖方式，未执行未来目标的产品验证，未改产品代码。
