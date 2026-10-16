# Provider Refactor 考证与矛盾审计

> 状态：持续维护
> 目的：解释现行设计从何而来，记录旧材料与当前事实不一致之处；本文不是第二份设计。

## 1. 审计方法

本次考证同时检查：

- 当前分支相对 `origin/staging` 的提交和文件差异；
- `docs/working-memory/provider-refactor` 下的 `design`、`steps`、`plan`、`research`、Bugfix 和实施记录；
- 当前 `@zcode/provider`、`@zcode/provider-node`、Services、UI、CLI Bootstrap、Adapter 和 Built-in Config；
- 与 Provider 核心行为直接相关的测试；
- Todo 32 的设计、实现提交和验证记录。

判定时区分：

| 类别       | 回答的问题                         |
| ---------- | ---------------------------------- |
| 目标事实   | 最新裁决要求系统最终怎样工作       |
| 实现事实   | 当前代码和测试现在怎样工作         |
| 历史证据   | 某个设计为何出现、何时被替代       |
| 待完成事项 | 已裁决但尚未完成，或尚待讨论的工作 |

不能因为旧文档写得详细就赋予其更高权威，也不能因为当前代码存在某个偶然分支就把它升级为设计。

## 2. 分支与差异事实

建立本文时采用实现基线 `e01862000f`：

- 当前 HEAD 与 `origin/staging` 的 merge-base 为 `65fb4532d347194095cca8848e768f0fdbb28939`；
- 该实现基线相对 staging 有 238 个独有提交，staging 有 236 个独有提交；
- `origin/staging...HEAD` 全仓差异约 1,271 个文件，包含大量并行产品演进，不能把全量 diff 等同于 Provider Refactor；
- Provider 核心是本分支新增的 `packages/provider`、`packages/provider-node` 和 `config/provider/zcode-builtin.json`，
  staging 仍主要使用已经被本分支退役的旧 Model Provider Service；
- 当前 Built-in 内容外壳为 `schemaVersion + revision + config`，内容层有 21 个 Provider、120 条 Model Rule；
- Todo 32 已由提交 `e01862000f` 完成，相关 UI、i18n、测试和 Design 结果已纳入本次审计。

因此 staging 独有提交必须逐项提取产品不变量，不能机械 cherry-pick 旧实现。

### 2.1 staging 独有 Provider 修复的判定

| staging 提交                                                                         | 它证明的有效问题                                                           | 对 V2 的裁定                                                                                                                                                              |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `1ccf6f906e fix(model-provider): honor selected Start Plan runtime`                  | 同一 Family 同时具备 Start 与 Coding Plan 时，用户显式选择必须进入真实执行 | 产品不变量有效；旧 `modelProviderService` 修法不可搬。新架构应由 Account Connection Resolver 把未选 Provider 置为 unavailable，并通过 Account Overlay 只启用所选 Provider |
| `b89263389e fix(model-provider): decouple start plan selection`                      | 套餐选择、Family 导航和模型候选不应互相错误推断                            | 问题有效；归入 Account Connection、Settings View 和独立套餐投影，不恢复旧 family runtime filter                                                                           |
| `198a013a95 fix(model-provider): avoid boundary token budget in connectivity probes` | 连通性探测使用极小 token 边界值会造成假失败                                | 连接测试产品行为有效，但旧 connectivity helper 已删除；应在正式 ModelFactory/Adapter 测试链中独立核对，不恢复旧服务                                                       |
| `08862385c3 fix(ui): clarify pending start plan entitlements`                        | pending、unknown、unavailable 不能混为“未分配”                             | 状态语义有效；Todo 32 进一步规定套餐状态不能决定 Effective Provider/模型配置区是否存在                                                                                    |

当前 `AccountProviderConnectionResolver` 已按 Family 的显式 selection 只把所选模式解析为 available；
`resolveAccountProviderConfigs` 再将其投影为 `access.entitled`，Start Plan 同时投影账号模型集合。这个落点替代旧 Registry
投递筛选。

## 3. 当前事实的主要代码证据

| 设计事实                                   | 主要实现证据                                                                      | 主要测试证据                                                     |
| ------------------------------------------ | --------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Provider Schema 与 Access 联合类型         | `packages/provider/src/config/provider-config.ts`、`config/schema.ts`             | `packages/provider/test/provider-config-kinds.test.ts`           |
| Model Schema、嵌套格式和 Rule 顺序         | `packages/provider/src/config/model-config.ts`                                    | `model-config-rules.test.ts`、`todo21-source-contracts.test.ts`  |
| Built-in -> Account -> Personal            | `packages/provider/src/resolver.ts`                                               | `resolver.test.ts`、`todo21-resolution.test.ts`                  |
| Settings 候选与 Registry 可执行集同源      | `resolver.ts`、`facades.ts`                                                       | `facades.test.ts`、`registry.test.ts`                            |
| Account 只投影 entitlement 与 Start models | `account-provider-resolution.ts`、Services `accountProviderConnectionResolver.ts` | `account-provider-resolution.test.ts`、Services 对应测试         |
| Built-in / Account revision 原子配对       | `registry-service.ts`、`account-provider-service.ts`                              | `registry-service.test.ts`、`account-provider-service.test.ts`   |
| Personal 持久化、远端 Built-in 与 LKG      | `packages/provider-node/src/*`                                                    | `provider-node-runtime.test.ts`、`zcode-builtin-release.test.ts` |
| ModelFactory 固定完整执行事实              | `apps/zcode-cli/packages/bootstrap/src/app/provider-registry-model-runtime.ts`    | Bootstrap、Core、Adapter Provider 定向测试                       |
| Active Model 使用同结构 properties         | CLI Contracts Model 与 Adapter/Core 消费链                                        | Model input/output、媒体、Compact/Subagent 定向测试              |
| 设置页经 Facade 读写                       | `packages/provider/src/facades.ts`、UI `useProviderSettingsView.ts`               | Provider settings / coding plan UI tests                         |
| Built-in 正式内容                          | `config/provider/zcode-builtin.json`                                              | `packages/provider-node/test/zcode-builtin-integrity.test.ts`    |

## 4. 矛盾表述与裁定

### C01. `Official Config` 与 `ZCode Built-in Config`

**历史表述**：M2/M3 早期材料和实施日志大量使用 `Official Config`。
**后续裁决**：Todo 10 明确进行一次性命名切换，不保留别名。
**当前事实**：类型和文件均使用 `zcodeBuiltin*` / `zcode-builtin.json`。
**裁定**：现行名称只有 `ZCode Built-in Provider Config` 与 `ZCode Built-in Model Config Rules`。
旧名称只作为历史引用。

### C02. `Config Document` 是不是领域概念

**历史表述**：早期 Provider Domain 暴露 `ProviderConfigDocument`、`ModelSelectionConfigDocument`。
**后续裁决**：用户明确要求设计中删除 document 概念；Todo 06 将版本外壳和 migration 收回 Repository。
**当前事实**：Domain 只处理 Config/Rules/Snapshot；`schemaVersion/revision` 属于 codec、repository 或远端发布外壳。
**裁定**：没有 Config Document 领域中间态。物理文件仍然可以有存储外壳。

### C03. Provider Overlay 顺序

**历史冲突**：早期图把 Personal 与 Account 顺序写反，或把 Account 当成最终覆盖。
**明确裁决**：`ZCode Built-in -> Account -> Personal`，Personal 最后。
**当前事实**：`ProviderConfigResolver` 先得到 `effectiveBuiltinProviders`，再 Overlay Personal。
**裁定**：现行顺序固定；Account 的职责是约束 Built-in 账号 Provider，Renderer 不再额外应用它。

### C04. Model Rules 是覆盖还是拼接

**历史冲突**：部分材料把 Personal Model Config 当单份替换。
**明确裁决**：Built-in 与 Personal 是数组拼接，Personal 在后。
**当前事实**：`composeEffective()` 保持 Built-in 顺序，最后放 Personal 精确规则。
**裁定**：有序 Overlay；Personal 只允许精确 `providerId + modelId`，具有最高优先级。

### C05. Account Config 是否拥有 `accessId/productId/team scope`

**历史表述**：Research、Todo 07、Todo 20 和早期架构评审曾把 `accessId` 作为 Config 或 Model 固定字段，并把商品/团队
Scope 一并讨论。
**后续裁决**：Todo 24 删除 `accessId`，Todo 26 又删除静态 `planKind` 和伪通用协议字段。
**当前事实**：Account Provider Config Schema 只允许 `access.entitled` 与 `builtinModelIds`。账号协议、Subscription、Usage、
Request Auth 中仍合法存在 `planKind/productId/organizationId/projectId`。
**裁定**：这些字段可以属于账号/套餐/请求上下文，但不得回流 Provider Config、Registry Model 静态事实或 Selection。

### C06. Account 是否应该影响 Config

**历史摇摆**：讨论中一度倾向“所有账号事实都不应与 Config 有关”。多方确认后又明确 Start Plan 模型因账号而异，
账号 Provider 权益也必须参与最终解析。
**当前事实**：Account 是正式第三层 Provider Overlay；只投影 `access.entitled` 和账号接口明确返回的
`builtinModelIds`。
**裁定**：Account 必须影响 Effective Provider，但不能成为静态 Model Properties、Endpoint 或动态凭据的来源。

### C07. 是否只有 Start Plan 返回模型集合

**历史疑问**：早期曾假设所有账号套餐都可能返回模型，或把 `show_name` 回退成 Model ID。
**当前事实**：Account Resolver 只消费账号接口明确返回的 `models`；没有动态成员集合时沿用 Built-in。
Individual/Team/Start 的套餐资格统一写入 `access.entitled`，不修改顶层 `enabled`。
Start Plan 解析只接受上游明确模型事实，不应让展示文案成为 Registry 身份。
**裁定**：账号模型子集是 Start Plan 特例，不推广为所有 Account Provider 的通用动态成员协议。

### C08. Access 类型：`request-auth`、`execution-provided` 还是账号专用类型

**历史演进**：M4 使用 `request-auth`；Todo 24 改为通用 `execution-provided` 并增加请求协议字段；用户随后认为它过度
泛化。Todo 26 明确取代 Todo 24。
**当前事实**：正式 Access 只有 `api-key` 与 `zhipu-account`；Off-Peak 是 `zhipu-account + mode=off-peak`。
**裁定**：旧两种 Access 和 `challenge/requestSigning/executionProtocol` 均为已退出中间设计。

### C09. `family member`、`plan kind`、`group`、`mode`

**历史冲突**：讨论中曾尝试同时保留 family member 与 plan kind，或用 Provider group 推导访问方式。
**当前事实**：`group` 负责静态产品分组；`zhipu-account.family` 负责 Z.ai/BigModel；`mode` 负责 API Key、Start、
Individual、Team、Off-Peak。
**裁定**：三者正交，不能互相推导；账号运行协议可继续使用自己的 `planKind` 命名。

### C10. Provider 与 Model 是否都有 Visibility

**历史表述**：Todo 03 一度决定 Provider/Model 对称拥有 visibility；旧 `registry.md` 也残留“Provider/Model
Visibility”措辞。
**后续裁决**：Todo 21 明确删除 Model visibility，用户再次确认。
**当前事实**：Schema 只有 Provider `visibility`；Model 的 `selectable` 由执行资格和 Provider visibility 计算。
**裁定**：Model 没有独立 visibility。旧对称设计已失效。

### C11. `executionOnly` 与“受信执行”

**历史表述**：M4 前曾用 `executionOnly` 同时表达隐藏、内部执行和完整性豁免，并讨论 trusted lookup。
**明确裁决**：用户要求只是通用可见性，不与“受信”绑定；Provider Config 层也不负责限制用户能否通过其它接口使用。
**当前事实**：`visibility=hidden` 只影响普通 View；Registry 精确查找仍可执行，但完整性要求不放宽。
**裁定**：删除 `executionOnly` 和 trusted 概念；内部产品入口用固定 Provider ID 精确选择。

### C12. Enabled、完整性、Executable、Selectable

**历史混淆**：旧服务常用一个 `enabled` 或 availability 同时承担配置完整、账号可用、选择可见和执行资格。
**当前事实**：Resolver 分开保存 `enabled`、issues、`executable`、`selectable`；Settings 保留不完整项，Registry 只收
可执行项。
**裁定**：四个事实正交。配置不完整可以保存但不可用；账号套餐状态不能把 Provider 配置从设置页抹掉。

### C13. Built-in 与 Personal 模型重名

**历史表述**：一度写成“冲突模型全部隔离”。
**明确裁决**：用户要求 Built-in 与自定义重名时 Built-in 仍能运行。
**当前事实**：Resolver 先去重 Built-in，再丢弃与 Built-in 重名的 Personal 成员。
**裁定**：Built-in wins；冲突不拖垮 Provider，也不让 Personal 身份覆盖 Built-in。

### C14. Reasoning Compatibility 与具体模型硬编码

**历史表述**：`magic_name`、ox-alpha、GLM 特例、`adapterCompatibility`、`reasoningReplay` 等曾存在或被提议进入配置。
**明确裁决**：所有“按具体模型识别 reasoning 强度”的生产旧代码退出；`reasoningReplay` 和 Compatibility 全面删除。
**当前事实**：逻辑档位由 `optionSpecs.reasoningLevel` 声明，协议字段由该 Option 自身的受限 CEL `map(value)` 直接投影到最终原始 Request Body；正式 Schema 拒绝旧 `reasoningMapping` 字段。
**裁定**：具体模型差异写成声明式 Model Rule；Runtime/Adapter 不按 Model ID 打补丁。

### C15. 输入输出格式

**历史演进**：`modalities: { input: string[], output: string[] }`，随后出现平铺 `supportsImages/Pdf/Video`，最终裁决为
嵌套 snake_case property。
**当前事实**：Config、Registry、Protocol 和 Model 统一使用 `properties.input_format/output_format`；PDF/Audio 进入静态事实，
PDF 继续运行 gating，Audio 尚无内容编码入口。
**裁定**：旧字段只能在一次性 importer/历史测试输入中出现，不是正式事实。

### C16. Model 中间态：ModelRef、ConnectionPort、Capability DTO

**历史表述**：旧 CLI 设计和 trajectory 文档仍大量描述 `ModelRef`、`ModelConnectionPort`、Catalog capability。
**后续裁决**：Todo 01、02、04、05、08、14、16 完成退役。
**当前事实**：公共执行对象是不可变 Model，Factory 从正式 Registry 创建；媒体和选项读取 Model 自身结构。
**裁定**：旧 CLI design/trajectory 只能说明历史，不能作为 Provider Refactor 现行接口依据。

### C17. `Document`、Snapshot、Envelope 是否都要删除

**历史误解**：删除 Document 概念有时被扩展成“不应有任何快照或版本”。
**当前事实**：领域需要只读 Config Snapshot 和 Registry Snapshot 保证原子发布；Repository/远端同步需要版本外壳。
它们没有重新成为可编辑 Config DTO。
**裁定**：删除的是多余领域中间态，不是原子性所需的不可变快照和物理版本信息。

### C18. Registry 刷新是否需要 revision handshake

**历史方案**：曾提出 Host 保存后向 Agent 发送 revision 并等待 observed revision。用户认为过度抽象，倾向让 Host 直接测试。
**当前实现**：各 Environment 的 Source/Registry 自己读取配置；连接测试走正式 Host Registry/ModelFactory；Worker watcher
有失败自愈；Built-in 与 Account revision 在 Registry Service 原子配对。
**裁定**：不引入跨进程 Registry Snapshot 或通用 revision handshake。执行入口必须等待本 Environment 的正式刷新结果。

### C19. 设置页是否读取 Account Overlay

**历史表述**：部分 UI 设计把 Account Overlay、套餐卡和 Provider 配置直接拼在 Renderer，甚至让 entitlement 状态控制模型区。
**明确裁决**：设置页只读最终 Provider Settings View；套餐状态独立投影。
**实现结果**：Todo 32 已在 `e01862000f` 完成。Team / Individual 详情按 `providerId` 从 Provider Settings View
精确解析；套餐状态不再控制配置区和模型列表是否存在；`not-allocated` 与 `credential-unavailable` 成为显式页面状态。
**裁定**：这一边界已进入现行事实；套餐投影不能再反向成为 Provider 配置权威。

### C20. Endpoint/API Schema 在 Account 页面是否展示

**历史冲突**：通用设置设计要求 Built-in Endpoint/Schema 可见但只读；Todo 32 最新裁决规定 Individual/Team Coding Plan
页面隐藏它们。
**裁定**：一般 Built-in 仍展示只读连接事实；Individual/Team 是产品展示例外。字段从未从 Effective Config 删除，Runtime
继续使用。

### C21. 设置反馈位置

**历史冲突**：旧 `settings.md` 一度写成页面/viewport 最底部全局 Toast；后续实机反馈明确要求位于右侧 Provider 详情列底部，
使用横幅样式，新状态替换旧状态。
**当前事实**：近期 Bugfix/Todo 已按详情列反馈收口。
**裁定**：核心设计采用 Provider 详情列底部横幅；这只是交互投影，不改变配置权威。

### C22. `modelContextBudget.strategy` 与所谓 Official Runtime Config

**历史讨论**：曾尝试把远端 `/client/configs` 中所有字段都纳入 Provider Config，或新建 Official Runtime Config。
**明确裁决**：该字段属于 Agent 参数/产品灰度，与模型静态配置无关，本轮不动，也不创建新配置域。
**裁定**：不属于 Provider Refactor。

### C23. Remote Provisioning

**历史计划**：部分收口计划把本地向远端同步、远程编辑和登录列为 Provider 重构未完成项。
**明确裁决**：Remote Provisioning 是独立产品能力，不属于本次重构。
**裁定**：Provider 只规定每个执行 Environment 拥有自己的事实源，不在本设计定义配置如何跨 Environment 分发。

### C24. Built-in 完整性由谁负责

**历史争议**：Todo 18/19 讨论在客户端做大量“静态完整性”门禁，用户认为规则难维护、可能应由发布者负责。
**明确裁决**：先不扩展完整性校验；Todo 19 的历史讨论已废弃，未来如有需要另立新的发布门禁任务。
**当前事实**：Schema、Resolver 和现有 Built-in integrity test 保护当前可执行契约；没有新增远端发布者工作流。
**裁定**：现有运行完整性继续保留；更强发布门禁不得在未讨论前写成现行设计。

### C25. Start 独立 Provider 与现行单连接语义

**冲突的旧表述**：Start／Individual／Team 共用唯一 current，Start 选择随当前套餐映射。讨论中又曾提出虚拟统一入口、跨品牌映射、全量选择迁移、升级连接快照、多 Provider 全局失效通知及额外鉴权竞态校验。这些候选不能作为最终契约。

**后续用户裁决（2026-09-16）**：保留两家 Start ID、统一名称和各自品牌 logo，放现有智谱分组；详情只去掉连接／断开。保留 current，允许 Start 与当前付费连接并存；Start 严格按原身份解析，付费间保持映射；JWT 复用登录，账号竞态沿用现状。用户明确“不迁移，加一个优化”：只在用户提交／创建保存时推荐有额度且思考兼容的同模型 Start；包括 Subagent 显式模型保存，最终排除立即运行。偏好跨入口、重启及同 Host 手机生效，不做账号云同步。失效时保留额度反馈，全局连接通知只处理付费套餐。

**实施前代码／测试事实**：current、公共账号映射和 Start 请求鉴权原先有旧连接约束，设置导航有连接副作用。普通 Session 在提交开始执行时写回本次选择，草稿在 accepted 后写回；因此“所有旧会话长期残留 Start”不成立。Automation 仅固定 run，显式 Subagent 执行不改长期配置；无迁移不等于旧有效行为完全不变。I27/MP-R03 实际注入的是 Recent，断言回退 Configured Default，不能用旧矩阵的 Start→Team 描述证明普通 Session 需要迁移。详见 [调研](../research/todo154-start-plan-independence-impact.md)。

**最终裁定**：目标进入 Design V2 §4.5，完整实施边界归 [Todo154](../steps/todo-154-start-plan-independent-provider.md)。保留现有数据并按新语义解析；不新增迁移机制、不重写历史、不因取消映射而偷偷选择付费模型。撤回上述扩大方案。用户随后于 2026-09-16 授权执行 Todo154 并全面 review；Todo101 其余内容继续延期。正式行为同步至 [Start 规格](../../../zai-start-plan-provider.md)。

**owner 与完成条件**：Todo154 负责状态／鉴权／选模／导航、提交推荐、偏好和失效反馈的实现与桌面／手机／Worker 回归。实施前的 17 项测试只作历史证据。现已实现独立 current／JWT、Start 精确身份解析、独立导航及四类入口的提交推荐；不增加数据迁移。定向单测、Pro admin SSH Electron 实跑和 review 结果统一记录在 Todo154 §8，不把窄屏模拟等同于实体手机验证。

### C26. 审批框完全访问是否可以修改已接纳队列的权限

**旧表述**：[Todo71](../steps/todo-71-persistent-composer-draft-and-submission-state.md) 和 [Todo151](../steps/todo-151-independent-plan-state-draft.md) 要求 Submission 入队后保留原配置，不因草稿或批准结果改写。

**后续裁决（2026-09-17）**：用户明确仅权限审批框新增的“完全访问”同步当前任务、Composer 和全部待执行队列消息为 `mode=yolo`；各自 `planEnabled` 及其他字段保持。普通 Composer 菜单仍只改草稿。

**当前事实**：即时切换命令仍被 Bot、自动化与兼容路径使用；`app.setMode()` 还写项目权限偏好，仅传 yolo 会关闭 Plan，且不更新队列或应答已有审批。共享归一化函数的 Plan 关闭已通过最小执行复现，审批新行为未实现。

**最终裁定**：增加审批专用的显式权限更新例外，不推翻模型选择冻结、Plan 独立、普通队列消费或草稿 owner。由 Agent 协调任务权限、全量目标队列和当前应答，客户端定向同步对应草稿；不继承项目默认写入副作用，不全局修改旧请求归一化语义。

**完成状态**：已按裁定实现，验收尚未全部收口，owner 为 [Todo158](../steps/todo-158-permission-dialog-full-access-and-queued-mode.md)。SQLite、Runtime、broker、V4 与 Composer 回归证据及基线失败见其第 9 节；手机 shared-host 整链路仍未验证，不将 pending 用例视为正式准入。

## 5. 旧材料的使用等级

### 5.1 可以作为现行设计证据

- `design/design.md` 中尚未被本表修正的双路架构和核心原则；
- `design/registry/configuration.md` 的当前字段契约；
- `design/model/input-output-format.md`；
- `design/registry/model-membership-and-enablement.md`；
- Todo 21、23、26、28、29、32 的最终裁决；
- 当前 Schema、Resolver、Registry、ModelFactory 和测试。

### 5.2 只可作为历史实施证据

- M1–M4 实施文档和 implementation log；
- Todo 00–10、12–14、16–18、20、24、25、27、30、31；
- Bugfix 01–06；
- Provider MR review、architecture conformance review；
- Research 与 dogfood 记录。

这些文档可以解释为何删除某个抽象，但其中的阶段性 Schema 不得覆盖后续裁决。

### 5.3 明确被取代的关键材料

- Todo 03 中 Model visibility：被 Todo 21 取代；
- M4、Todo 02、07、14、15 中 `request-auth/accessId`：被 Todo 24/26 取代；
- Todo 24 的 `execution-provided + executionProtocol`：被 Todo 26 取代；
- Research 中 `Official Config`、旧平铺能力和 `accessId` 草案：被 Todo 10、输入输出格式设计和 Todo 24/26 取代；
- 旧 CLI v2 ModelRef/Capability 文档：被 Todo 00–16 的实际清理取代；
- Settings 全局底部 Toast：被后续实机交互裁决取代。

### 5.4 尚不能进入现行事实

- Todo154 的旧候选：虚拟 Provider、跨品牌映射、全量迁移和新增鉴权屏障已撤回；当前实现及验证以 Todo154 §8 为准；
- Todo 11：Draft；
- Todo 11A：待执行；
- Todo 15：已废弃，不再作为独立执行项；
- Todo 19：已废弃，不再作为独立执行项；
- Todo 22：Draft；
- Research 报告中尚未实施的 Built-in 模型事实扩展；
- 人工 E2E、真实账号、正式包和跨平台验证中尚未完成的项目。

## 6. 完成证据与剩余审计项

### 6.1 Todo 32 完成证据

Todo 32 已在 `e01862000f` 提交，并将文件状态更新为“已完成”。实施记录证明：

- 套餐状态不再控制 Provider/模型配置区存在性；
- Team/Individual 模型来自 Provider Settings View；
- Team 模型继续支持既有排序、启停和 Personal Model Config 编辑；
- Endpoint/API Schema 只在产品 UI 隐藏，运行时配置不变；
- loading、明确未分配、凭据不可用和请求失败不再通过展示文案互相反推。

其记录的验证结果为 Provider UI 定向测试 220 条通过、全量 unit 1470 个测试文件和 12480 条测试通过，以及根
`typecheck`、`lint`、修改文件格式检查和 `git diff --check` 通过。该证据说明实现已经落地；真实 Team 账号和正式包
体验仍归发布验证，不反向改变设计状态。

### 6.2 staging 最终集成

当前与 staging 大幅分叉。最终合并前应按“产品不变量迁移”而不是“旧代码保留”审查 staging 独有 Provider 提交，重点验证：

1. Start/Individual/Team/API Key 显式选择进入 Account Overlay 和真实 Model 创建；
2. 连接测试不会因极小 output token 预算产生假失败；
3. pending/unknown 权益不会误报未分配；
4. staging 的新业务/UI 功能不重新引入旧 Provider Service、family runtime filter、capability DTO 或具体模型 hardcode。

### 6.3 发布验证

现有自动化已经证明主要领域契约，但以下仍是上线验证而不是设计缺口：

- 真实 API Key、Start、Individual、Team、Off-Peak 请求；
- Desktop/CLI 正式制品中的 Built-in 路径；
- macOS、Windows、Linux 及历史 Personal Config importer；
- Config 更新、进程重启和冷启动；
- 延后的人工 E2E 与容器环境门禁。

### 6.4 非 Provider Config 的相似字段

全仓仍可搜索到 `planKind`、`productId`、`modalities`、`supportsImages`、`ModelRef` 等名称。不能仅凭字符串判定回归：

- 账号、Subscription、Usage 协议中的 `planKind/productId` 是合法业务字段；
- legacy importer/test fixture 中的 `modalities` 是兼容输入；
- Adapter 局部转换 helper 中的 `supportsImages` 可以是函数参数，但不得成为第二份 Active Model 能力权威；
- CLI 历史设计/trajectory 中的 `ModelRef` 是文档残留，不是当前生产接口。

机械归零必须限定正式 Provider Config、Registry、Model 和 Runtime 权威路径，避免误删其它领域的合法概念。

## 7. 后续维护格式

新增矛盾时追加一项 `Cxx`，至少写明：

1. 冲突的旧表述；
2. 后续明确裁决；
3. 当前代码/测试事实；
4. 最终裁定；
5. 若未完成，标明 owner Todo 和验证条件。

历史文档原则上不回写成“仿佛当时就知道最终答案”。保留原始轨迹，在本文维护裁决，才能同时满足现行设计清晰和
历史审计可信。
