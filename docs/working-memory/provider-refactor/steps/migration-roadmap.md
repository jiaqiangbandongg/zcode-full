# Provider 重构迁移路线

> 状态：工作规划
>
> 最近更新：2026-08-24
>
> 当前阶段：M4 与已知清理 Todo 已完成；正在执行 Provider Refactor 最终全量验证

## 迁移策略

迁移沿模型调用主链逐步向上收敛：先统一模型执行接口，再整理 Registry 与 Provider 来源，随后收敛 Submission、配置和 Environment 所有权。

每个阶段可以拆成多个可合并的代码切片，但阶段结束时不能保留平行业务语义。旧系统只允许通过一个明确兼容入口接入新抽象。

## 阶段概览

| 阶段     | 主题                                  | 状态                                         | 完成标志                                                                                                 |
| -------- | ------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| M0       | 宏观架构与现状地图                    | 已完成第一轮                                 | 工作目标和主要历史分叉已落盘                                                                             |
| M1       | Model 与 ModelRequest                 | 已完成                                       | 所有生产模型调用使用统一 Model                                                                           |
| M2       | Provider 配置、Registry 与 Model 创建 | 已完成，作为当前 M3 Merge Request 的基础切片 | 三层配置与普通 Model 创建已进入统一链路；旧 Snapshot、Workspace Provider Catalog fallback 和死代码已退出 |
| M3       | Provider 架构切换与 Model 格式收口    | 已完成                                       | Config/Registry、原子 Submission、模型选择、设置页与输入输出格式形成唯一生产链路                         |
| M4       | 模型执行链、闲时任务与 Subagent       | 已完成                                       | 闲时任务使用完整 hidden Provider、同一 Registry/ModelFactory 与请求时鉴权，不改 Session Selection        |
| M5       | Config 存储边界与 Built-in 装配       | Provider Refactor 范围已完成                 | 存储外壳已私有化；Built-in/Personal/Selection 只通过正式 Source/Repository 装配                          |
| M6       | Account Provider                      | Provider Refactor 范围已完成                 | 结构化选择、Account Overlay、完整 Access 与请求期鉴权形成唯一链路                                        |
| 独立专题 | Environment 配置与 Provisioning       | 不属于本次 Provider Refactor                 | 远程设置、登录、配置同步与目标 Environment 的产品能力另行设计                                            |

阶段顺序可以根据实现事实微调。调整时更新本路线和 Working Memory，不为保持编号而制造临时代码。

## M0：宏观架构与现状地图

M0 建立了当前工作语言：

```text
事实来源
    -> Provider 构造
    -> Registry 聚合
    -> Model
    -> ModelRequest
```

同时完成了 Runtime、Registry、Provider Options、Reasoning、Plan、闲时任务、Subagent 和外围模型调用的第一轮调查。

M0 后续只补充新的事实证据，不再承载实现细节。

## M1：Model 与 ModelRequest

> 完成于 2026-08-12，已通过 MR !2006 合入 `staging`。

M1 先把所有生产模型调用放到一个最终公共边界下。阶段目标是统一“模型如何被调用”，不要求同时完成最终 Registry 和 Provider 来源重构：

```text
Model
├─ Properties
├─ Option Specs
├─ Options
├─ bind()
├─ generateText()
└─ streamText()
```

主要切片：

1. M1.1：固定类型（包括 ModelResult / ModelEvent），建立 Model Adapter Wrapper 和单元测试。
2. M1.2：迁移主 Agent Loop、Automatic Compact、Usage 与 Trace。
3. M1.3：迁移 Child Agent、Title、Goal verifier 和 Project Memory。
4. M1.4：迁移 Git、workspace generateText、WebFetch 与 WebSearch。
5. M1.5：迁移 Repo Wiki。
6. M1.6：删除业务调用方对 Runtime model state、Provider options、ModelPort 和独立 Provider 客户端的读取。

现有 Runtime、Registry、Plan 和临时模型输入通过唯一兼容 Model Factory 进入新链路。M1 不要求同时重构 Registry Service、Builtin Provider、设置页、原子 Submission 或配置刷新，但新 Model 必须能承接这些现有输入。

M1 完成时，所有生产模型调用都使用 `Model.generateText()` 或 `Model.streamText()`。阶段内允许分批合并，阶段结束不保留平行业务模型客户端。

## M2：Provider 配置、Registry 与 Model 创建

M2 的实施计划见 [`02-provider-config-and-registry.md`](./02-provider-config-and-registry.md)，目标设计见
[`../design/registry/registry.md`](../design/registry/registry.md)。普通长期 Provider 的三层 Config、Registry
聚合、Model 创建与主要生产装配已经完成，退役结果见
[`02-provider-config-and-registry-cleanup.md`](./02-provider-config-and-registry-cleanup.md)。这些改动作为 M3
实现分支的基础切片，与 Submission、选择状态和设置页一起完成统一切换。

Registry 聚合、通知和 M2 开始时跨进程刷新链路的调研见 [`../research/m2-registry-aggregation-and-refresh.md`](../research/m2-registry-aggregation-and-refresh.md)。

M2 将第一阶段的兼容装配收敛成正式 Registry：

```text
ProviderConfigService
├─ ZCode Built-in Provider Config
├─ Account Provider Config
├─ Personal Provider Config
├─ ZCode Built-in Model Config Rules
└─ Personal Model Config Rules
                   |
                   v
            ProviderRegistryService
                     ├─ Provider[] / { modelId, config: ModelConfig }[]
                     └─ createModel(selection)
                                  |
                                  v
                             ModelFactory
                                  |
                                  v
                                Model
```

主要问题：

- ProviderConfig 与 ModelConfigRules 的有序、逐字段覆盖语义。
- Account Source 产生 Account Provider Config，并在 Built-in 之后、Personal 之前补入 account-kind 的
  `accessId` 与 `models`。
- Registry 的 Provider/ModelConfig View、查询索引、变化通知与对象生命周期。
- 设置 Facade 与模型选择 Facade 的专用 View。
- ModelFactory、Adapter 和动态鉴权依赖。
- 设置写入、外部文件修改和官方更新的刷新链路。
- 闲时任务的过渡 Runtime Model 复用解析与 ModelFactory，并把生命周期限制在单次执行。

M2 完成后，Agent Loop 从进程级 Registry 取得当前 Model；更新创建新对象，旧 Loop 继续持有旧 Model。

M2 只为 Account Provider 和闲时任务过渡链建立能够接入统一 ModelFactory 的边界，并保持当时行为。
Account Provider 的身份、权益、动态凭据和刷新状态在 M6 重构；闲时任务与 Subagent 的提交和生命周期
语义在 M4 收口，并删除这条过渡 Runtime Model 链。

## M3：Provider 架构切换

完整实施计划见 [`03-provider-architecture-cutover.md`](./03-provider-architecture-cutover.md)，目标语义见 [`../design/interaction/interaction.md`](../design/interaction/interaction.md) 和 [`../design/registry/settings.md`](../design/registry/settings.md)。

M3 把 M2 已完成的 Config/Registry 基础与原子 Submission、模型选择状态、Provider 设置页和 Model 输入
输出格式组合成一次完整切换。实现集中在同一条集成分支，内部仍以职责清晰的提交和评审区域组织。

交互主链把当前“先切模型，再发送文本”改为一个原子 Submission：

```text
Submission
├─ prompt
├─ attachments
├─ mode
└─ modelSelection
```

同时需要收敛 Composer Draft、App Recent、Session Selection、Queue、Guide/“立即”、Edit、Retry、Prompt CLI 与 TUI 的模型语义，完成设置页自动保存、调序和正式 Model 连通性测试，并删除 ModelRef、共享可变 Runtime 模型状态和独立 Connectivity Probe。

Session 只持久化 Selection。Submission 启动新 Agent Loop 时，从 Registry 取得 Model 并 bind Options。

M3 以一次大 MR 完成。阶段内按 Config/Registry、Submission、CLI admission、ModelRef 退役、Settings
Service、Settings UI、Connectivity、Model Format 和清理测试分区评审；最终没有让任一分区以长期双轨
语义单独收尾。

## M4：模型执行链、闲时任务与 Subagent

正式阶段设计见 [`04-model-execution-cutover.md`](./04-model-execution-cutover.md)，长期目标语义见
[`../design/execution/execution.md`](../design/execution/execution.md)。

M4 不新增特殊 Model 类型，而是把闲时任务收口到普通模型执行链：

- `builtin:offpeak-idle-plan` 成为 `visibility: "hidden"` 的完整 Built-in Provider；hidden 只影响设置页与模型选择器。
- Provider 使用 `access.type = "request-auth"`，动态鉴权在每次请求上注入，缺失时在网络请求前失败。
- 闲时 Submission 携带标准 ModelSelection 和窄 execution context，通过同一 Registry/ModelFactory 创建 Model。
- 闲时执行不写 App Recent、Configured Default、Session Selection 或普通 Queue，因此没有恢复步骤。
- 权限批准或拒绝后，同一自动回合继续使用闲时 Provider，不发生 Provider handoff。
- 闲时前台 Child Agent 使用闲时选择与访问上下文并自行创建 Model；后台 Child Agent 被明确拒绝。
- 普通 Subagent override、Goal、Background、Guide 与 Compact 保持各自既有 Selection 所有权。

M4 删除未发布的 `executionOnly`、Runtime Provider Overlay 和临时 `setModel`；不建立特殊 Model 创建
接口、第二份模型绑定或第二个 Registry。

## M5：Config 存储边界与 Built-in 装配

Provider Refactor 已完成单个 Environment 内配置的物理存储边界和 Built-in 装配：

- Personal 配置的持久化与外部修改监听。
- ZCode Built-in 配置通过唯一发布文件、Node Source、watch/revision 和 Desktop/CLI 启动装配进入 Registry。
- Host、Prompt CLI 与 TUI 在各自目标 Environment 内使用相同配置读写实现。
- 旧 CLI Config 与当前 Environment Config 的迁移和清理。

旧配置兼容集中在 Storage 读取边界，不进入 Registry 解析和 Model 创建。

跨 Environment Provisioning、从本地向远端同步配置、远程编辑和远程登录属于独立产品专题，不是 M5
或本次 Provider Refactor 的完成条件。

## M6：Account Provider

静态与动态边界见 [`../design/environment/environment.md`](../design/environment/environment.md) 和 [`../design/registry/model-creation.md`](../design/registry/model-creation.md)。

本次重构已经完成 Start Plan、Individual Coding Plan 和 Team Plan 的身份与执行状态链：

- Settings 保存结构化 connection selection；
- Account Resolver 按 Built-in Provider 声明的 `family + planKind` 产生 Account Overlay；
- Registry/Active Model 固定完整 Account Access；
- Request Auth 在每次请求解析动态材料，并校验当前账号仍与 Access 匹配；
- Off-Peak 与 Official MCP 复用同一 Account Access，不再解析旧字符串 key；
- Account API 返回的模型成员只约束对应 Account Provider，不成为独立 Model Config 事实源。

套餐购买、额度、远端服务最终授权等产品逻辑仍各归其原有服务，不属于 Provider 静态事实。

## 独立后续专题：Environment 配置与 Provisioning

本专题不属于本次 Provider Refactor，也不作为 M4 或整个 Provider Refactor 的完成条件。

目标语义见 [`../design/environment/environment.md`](../design/environment/environment.md)。

Local、SSH 和 Cloud Environment 最终各自保存并执行 Provider 配置：

```text
Entry
  |
  v
Target Environment
├─ Provider facts
├─ Registry Service
└─ Agent execution
```

配置同步是显式操作，不成为模型请求的在线依赖。Management Service 发布 Catalog 和管理信息，Environment 在其离线时仍能运行已有配置。

## 跨阶段约束

- 新抽象使用最终语义，不建立长期过渡类型。
- 兼容逻辑集中在尚未迁移的一侧。
- 新调用方不能同时读取新 Model 与旧 Runtime/Registry 状态。
- 每个 Model Request 的 Usage、Trace 和错误必须归因到实际 Model。
- 共享命令协议发生变化时，只做代表性回归确认 Desktop continuous、Mobile replayable 和 Remote Workspace identity 未被误伤；这些投递与恢复机制本身不属于 Provider Refactor。
- 每个切片先更新阶段设计和测试，再实现代码。
- 阶段完成后更新对应阶段文档、Roadmap 和 Working Memory 总入口。
