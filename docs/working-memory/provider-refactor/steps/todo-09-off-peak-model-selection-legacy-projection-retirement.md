# 09 Off-Peak 模型选择旧投影退役

> 闲时任务 Desktop 图形 E2E 的未完成运行与失败定位统一由 Todo 78 收口，本 Todo 不再单独排期。

> 状态：已完成
>
> 日期：2026-08-24
>
> 来源审查：[`../research/model-abstraction-unification-cleanup-audit.md`](../research/model-abstraction-unification-cleanup-audit.md)
>
> 总路线图：[`todo-00-model-abstraction-unification-roadmap.md`](./todo-00-model-abstraction-unification-roadmap.md)

## 1. 任务目标

删除 Off-Peak 将新 Provider Registry / Effective Model Config 反向投影为旧
`ModelProviderModelConfig` 的过渡链。Off-Peak 的模型候选、Reasoning Option Spec、提交校验和派发校验统一
消费同一份 Registry 模型事实；真正执行继续提交标准 `ModelSelection`，由普通 Registry / ModelFactory 创建
Active Model。

本 Todo 只收口模型选择事实和校验边界，不重新设计 Off-Peak 产品：

- 远端 `client/configs.offPeak.enable_offpeak_task` 继续只负责入口曝光；
- Account / Coding Plan 继续负责账号支持、Ticket 准入和请求期鉴权；
- 隐藏的 Built-in `builtin:offpeak-idle-plan` Provider 继续负责模型成员和完整 Model Config；
- Off-Peak Task 继续拥有自己的表单草稿、任务记录和调度状态；
- idle 自动 turn 继续使用 execution-scoped 标准 `ModelSelection`，不修改 Session Selection。

```text
当前

Built-in Provider / Model Config
              |
              v
Effective Provider Resolution
              |
              v
buildOffPeakBuiltInModels()
              |
              +--> allowedModels: string[]
              `--> allowedModelConfigs: ModelProviderModelConfig[]
                            |
                            +--> UI 手工构造候选和 Reasoning 控件
                            `--> Host 从 allowedModels[0] 取默认模型

目标

完整 Provider Registry
              |
              | 固定 OFF_PEAK_PROVIDER_ID 精确读取
              v
Scoped ModelSelectionView
|- revision
`- builtin:offpeak-idle-plan
   `- models[]
      |- modelId
      `- Registry Model Config
         |- properties
         `- optionSpecs.reasoningLevel
              |
              +--> Off-Peak UI 草稿
              +--> 创建 / 编辑校验
              +--> Host 默认选择
              `--> 派发前校验 -> ModelSelection -> ModelFactory
```

## 2. 已确认的架构边界

### 2.1 Hidden Provider 不进入普通模型选择 View

普通 `ModelSelectionFacade.getView()` 继续过滤 `visibility: "hidden"` 的 Provider。这是普通用户选择面的
正确边界，不能为了 Off-Peak 放宽。

Off-Peak 产品服务只允许按固定 `OFF_PEAK_PROVIDER_ID` 从完整 Registry 精确读取目标 Provider，并使用与普通
Model Selection 相同的投影逻辑生成 scoped View。禁止增加以下入口：

- 普通模型选择器包含隐藏 Provider；
- Renderer 按任意 Provider ID 查询隐藏 Provider；
- `includeHidden`、`trusted`、`executionOnly` 等通用逃逸参数；
- Off-Peak 专用完整 Model Config DTO。

目标可以返回现有 `ModelSelectionView`，其中最多包含一个 `builtin:offpeak-idle-plan` Provider；也可以在服务接口中直接
返回现有 `ModelSelectionProviderView`。无论选择哪一种物理外壳，Provider 和 Model 的内部结构必须复用正式
Selection View 类型和同一个 projector，不能复制字段定义。

### 2.2 四类事实保持分离

| 事实                            | 权威来源                                                            | 本 Todo 行为                                     |
| ------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------ |
| Off-Peak 入口曝光               | `client/configs.offPeak.enable_offpeak_task`                        | 保留，只与 Registry 候选非空共同形成创建入口门控 |
| 模型成员与 Model Config         | Built-in / Account / Personal 解析后的完整 Registry                 | 统一候选、Reasoning、默认模型和校验来源          |
| 账号是否支持、Ticket 与请求鉴权 | 当前 Account Access、Off-Peak availability/ticket API、Request Auth | 不迁移到 Model Config，不改变                    |
| 任务草稿、选择和调度状态        | Renderer draft、Off-Peak Task Service/Repo、Scheduler               | 继续由产品自己拥有，不写 Session Selection       |

Account Provider 的动态 `allowedModelIds` 不参与闲时模型列表。当前 Off-Peak 模型成员是隐藏 Built-in Provider
的产品级成员；Coding Plan Account 只决定账号准入和请求鉴权。

### 2.3 删除旧反向投影

删除以下模型事实桥接：

- `OffPeakBuiltInModels.allowedModels`；
- `OffPeakBuiltInModels.allowedModelConfigs`；
- `OffPeakClientConfig.allowedModels`；
- `OffPeakClientConfig.allowedModelConfigs`；
- `buildOffPeakBuiltInModels()` 及其旧 DTO 构造职责；
- `createOffPeakModelConfig()`；
- `createLegacyReasoningSpec()`；
- Off-Peak 对 `ModelProviderModelConfig`、`ModelProviderModality` 和
  `ModelProviderReasoningSpec` 的依赖。

不得保留 deprecated alias、双写或“迁移期 DTO”。当前分支的 Provider Refactor 配置尚未作为独立兼容协议
发布，本 Todo 不设计所谓新旧版本兼容。

### 2.4 Product View 只组合事实，不重新解释事实

现有 `OffPeakClientConfig` 同时装了远端开关和旧模型 DTO，名字与职责已经不准确。目标服务返回值应收口为
类似 `OffPeakClientView` 的只读产品 View：

```ts
interface OffPeakClientView {
  readonly enabled: boolean;
  readonly modelSelectionView: ModelSelectionView;
  readonly codingPlanActive?: boolean;
}
```

`enabled` 的目标判据仍为：

```text
产品开关命中
AND scoped Registry 中至少存在一个可创建的模型候选
```

`modelSelectionView` 是 Registry View 的产品作用域投影，不是新的 Config 或模型事实源。最终物理命名可以在
实现时按现有 Service 类型组织微调，但不得重新定义模型字段。

## 3. UI、草稿与持久化

### 3.1 UI 直接读取标准候选

`OffPeakEditView` 从 scoped `ModelSelectionView` 直接生成扁平模型候选：

- 模型 ID 来自 `provider.models[].modelId`；
- Reasoning 档位和默认值来自 `model.config.optionSpecs.reasoningLevel`；
- Reasoning 控件复用现有 Registry Model Thought Option helper；
- 不读取 `reasoningMapping`，Provider 请求参数仍只在 ModelFactory / Adapter 正向消费；
- 不把 Context、Input/Output Format、Tool 能力或 Provider patch 复制进 Off-Peak 草稿。

继续复用 `ModelConfigSelect` 的扁平展示模式，但不带入普通对话的 Provider 管理入口、Session 状态或继承语义。

### 3.2 草稿使用标准 Selection 语义

创建/编辑页的模型草稿应按一个标准选择解释：

```ts
{
  providerId: OFF_PEAK_PROVIDER_ID,
  modelId,
  options?: { reasoningLevel?: string }
}
```

切换模型时，Reasoning 当前值必须重新按新模型的 Option Spec 解析；无 Reasoning Option Spec 的模型不显示该
控件，也不能保留前一个模型的档位作为提交值。

### 3.3 暂不改 Task 数据库形态

`ZCodeOffPeakTask.model` 和 `thoughtLevel` 是 Off-Peak Task 的产品持久化/API 边界，不是模型事实全集。本
Todo 不要求修改 SQLite 列或服务端任务接口：

```text
ModelSelection.modelId                 -> task.model
ModelSelection.options.reasoningLevel  -> task.thoughtLevel
```

该投影只允许存在于 Off-Peak Task 提交/读取边界。执行时必须正向构造标准 `ModelSelection`，不能由任务字段
反向推断 Model Properties、Reasoning Mapping 或 Provider API。

新建表单始终提交一个明确模型。是否继续允许历史任务记录缺少 `model`，按现有 Off-Peak 产品兼容范围处理，
但不能因此在 Registry 外制造默认或假 Model；缺省时只允许从当前 scoped Registry 的有序候选中取第一项。

### 3.4 已保存选择失效时的行为

| 场景                                        | 行为                                                           |
| ------------------------------------------- | -------------------------------------------------------------- |
| History / 终态只读任务的模型已退出 Registry | 继续展示任务保存的字符串事实，不把它重新加入候选，也不修改任务 |
| queued / paused 编辑时保存模型已失效        | 显示不可用状态并阻止原样保存；用户需选择当前有效模型           |
| 保存的 Reasoning 档位已失效                 | 显示不可用状态；保存前选择有效档位或清除为当前默认语义         |
| 创建期间 Registry 更新                      | 提交边界按当前 Registry 重新校验，不信任页面初始快照           |

禁止静默替换为第一项并覆盖用户原选择。

## 4. 校验与 fail-closed

### 4.1 创建和编辑校验

当前创建只验证标题、Prompt、Workspace 和权限模式，编辑也会把 `model` / `thoughtLevel` 原样落库。目标是在
真正取 Ticket 或写 Repo 前，用当前完整 Registry 校验标准 `ModelSelection`：

```text
Renderer Submission
        |
        v
Host / Service 构造 Off-Peak ModelSelection
        |
        v
完整 Registry 精确校验
        |
        +--> 无效：返回稳定的本地校验错误，不请求 Ticket、不写 Repo
        `--> 有效：继续创建或编辑
```

Renderer 的禁用态只是及时反馈，Host / Service 校验才是提交边界，不能只信任 UI 快照。

### 4.2 派发前重新校验

任务可能在队列中等待较长时间，因此 Scheduler/Host 派发前必须针对当前 Registry 再校验一次：

- Provider 不存在；
- Model 不存在或已停用；
- Reasoning Level 不再受支持；
- scoped Provider 当前没有可创建候选。

这些都是确定性配置错误，必须在模型网络请求前 fail-closed，并映射为 Off-Peak permanent dispatch failure：
任务转 `failed`，停止重试和重取号。网络、Agent 生命周期等可能自愈错误继续沿用 transient 退避。

本 Todo 不修改普通用户 `ModelSelectionFacade.validate()` 的 hidden 可见性语义；Off-Peak 内部校验应直接使用
完整 Registry 的精确选择校验，不能借普通用户候选 View 反推。

## 5. Mock 边界

### 5.1 保留 Off-Peak Mock 网关

`ZCODE_OFFPEAK_MOCK=1` 及其 Ticket/Availability/生命周期场景变量继续用于本地开发和 Desktop E2E：

- 模拟远端入口开关和套餐展示态；
- 模拟 Ticket、queued/ready/active、过期和核销；
- 模拟 availability、配额、429 和 Retry-After；
- 模拟请求期凭据及 Off-Peak 模型 API Endpoint。

本 Todo 不删除 `offPeakMockGateway`，也不把 Mock 扩散到普通 Provider、Official MCP 或生产凭据解析。

### 5.2 删除模型列表环境变量

删除 `ZCODE_OFFPEAK_MOCK_ALLOWED_MODELS`。它来源于旧设计中远端 `client/configs.allowed_models` 是模型列表
事实源的阶段；当前真实 E2E 不依赖该变量，继续保留会允许 Mock 制造 Registry 不存在的模型。

目标测试链为：

```text
ZCODE_OFFPEAK_MOCK
|- 模拟产品开关、Ticket 和模型服务
`- 不模拟模型 Registry

测试 ZCode Built-in Config
`- 声明 builtin:offpeak-idle-plan 的 Provider API 和模型成员
```

测试需要自定义模型时，必须通过测试 ZCode Built-in Config / Built-in Model Rules 声明完整事实，不得用环境变量字符串、
临时 Model Config、假 Model 或 fallback Model 注入。

保留 `ZCODE_OFFPEAK_MOCK_NO_PLAN` 以及 Ready/Active/Availability/Retry 等场景变量；它们模拟产品或服务状态，
不与模型 Registry 争夺事实所有权。

## 6. 影响面与状态所有权

### 6.1 Feature Summary

| 字段             | 内容                                                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| Developer intent | 删除 Off-Peak 新 Registry 到旧 Model Config 的反向投影                                                               |
| Capability       | Off-Peak Model Selection / Off-Peak Model Execution                                                                  |
| Change layer     | option-source、draft-default、validation、commit-effect、persistence boundary                                        |
| Operating mode   | planning                                                                                                             |
| Primary seeds    | `buildOffPeakBuiltInModels`、`getOffPeakClientConfig`、`OffPeakEditView`、`OffPeakTaskService`、`dispatchOffPeakRun` |
| Out of scope     | Ticket 状态机、Account Access、Request Auth、Telemetry、Queue/Recovery、数据库迁移                                   |

### 6.2 UI Surface Matrix

| 用户场景                | UI 入口                                           | 展示/草稿 owner      | 候选/默认来源                              | 校验/gating                                         | 提交与落点                                                | 模式边界                          |
| ----------------------- | ------------------------------------------------- | -------------------- | ------------------------------------------ | --------------------------------------------------- | --------------------------------------------------------- | --------------------------------- |
| 创建闲时任务            | Automations / New Task 模板进入 `OffPeakEditView` | Renderer local draft | scoped Registry View；首个候选作为新建默认 | 远端开关、Plan support、availability、当前 Registry | `OffPeakTaskService.createTask` -> Ticket + Off-Peak Repo | Desktop 本地；不新增手机/远程入口 |
| 编辑 queued/paused 任务 | Automations `OffPeakEditView`                     | Renderer local draft | 已保存选择；当前 Registry 负责可用性       | 状态守卫 + 当前 Registry                            | `updateTask` -> Off-Peak Repo                             | 不修改 Session Selection          |
| 查看终态/运行任务       | Off-Peak 卡片/History                             | 已保存任务事实       | 保存的 model/thought 字符串                | 只读                                                | 无模型提交                                                | Registry 变化不重写历史           |

### 6.3 State Owners And Commit Sinks

| 状态/事实                          | 展示或缓存                    | 权威 owner                                  | Commit sink / 持久化                 |
| ---------------------------------- | ----------------------------- | ------------------------------------------- | ------------------------------------ |
| 入口曝光                           | Off-Peak Zustand 快照         | Remote `client/configs`                     | 不独立持久化                         |
| 模型候选、Properties、Option Specs | scoped Selection View         | Provider Registry                           | 不独立持久化                         |
| Plan 支持和 Ticket availability    | Renderer 脱敏快照             | Account Access / Off-Peak Server            | 现有 Service 缓存                    |
| 创建/编辑草稿                      | `OffPeakEditView` local state | Renderer draft                              | 用户确认前不持久化                   |
| 已选 model / thought               | Task UI 投影                  | Off-Peak Task Service/Repo                  | `off_peak_tasks.model/thought_level` |
| 实际执行 Model                     | 当前 automatic turn           | Registry / ModelFactory 创建的 Active Model | 不写 Session Selection               |

### 6.4 分级关系

| 等级           | 关系                                                  | 原因                                        |
| -------------- | ----------------------------------------------------- | ------------------------------------------- |
| must-inspect   | Registry -> scoped Off-Peak Selection View            | 新唯一候选和 Reasoning 来源                 |
| must-inspect   | Off-Peak create/update -> Registry validation         | 避免无效选择先取 Ticket 或入库              |
| must-inspect   | Scheduler/Host -> dispatch validation -> ModelFactory | 排队后失效必须 permanent fail-closed        |
| should-inspect | `ModelConfigSelect` / Model Thought helper            | 共享展示实现，但草稿和提交仍属于 Off-Peak   |
| conditional    | Mock Gateway / E2E ZCode Built-in Config              | 只影响本地开发和 E2E，不进入生产模型事实    |
| invariant-only | Account Access / Ticket / Request Auth                | 继续负责准入与动态访问材料，不决定模型成员  |
| invariant-only | desktop continuous / mobile replayable                | 不改变执行和恢复语义，不新增移动端 Off-Peak |
| invariant-only | Session Selection / App Recent / Queue                | idle selection 只作用于 automatic turn      |

### 6.5 Graph Drift 与后续 Graph Delta

当前 Feature Graph 已记录 `off-peak-model-execution -> provider-registry/model-capabilities`，但尚未明确记录
创建/编辑 UI 的候选来自固定隐藏 Provider 的 scoped Selection View，以及提交/派发的双重 Registry 校验。

实施本 Todo 时补充以下已确认语义边：

```text
surface.off-peak-creation
  --options-from--> scoped offpeak ModelSelectionView

service.off-peak-task
  --validates-with--> complete Provider Registry

service.off-peak-task
  --persists-selection-boundary-to--> off_peak_tasks model/thought_level

capability.off-peak-model-execution
  --revalidates-before-dispatch-with--> complete Provider Registry
```

功能图当前存在并发修改，本计划落盘时不改图文件，避免覆盖相邻工作的图谱更新。

## 7. 用例与剪枝

### 7.1 已接受用例

| Case ID | Setup                                     | Action                   | Assertions                                                            | 证据层                       |
| ------- | ----------------------------------------- | ------------------------ | --------------------------------------------------------------------- | ---------------------------- |
| OPM-01  | hidden Off-Peak Provider 有两个可创建模型 | 打开创建页               | 普通选择 View 不含该 Provider；Off-Peak scoped View 精确包含两个模型  | Provider + Service + UI unit |
| OPM-02  | 模型有 Reasoning Option Spec              | 切换模型和档位           | UI 只读 values/default；提交为标准 Selection 语义                     | Provider + UI unit           |
| OPM-03  | 模型无 Reasoning Option Spec              | 从推理模型切换到该模型   | Reasoning 控件隐藏，旧档位不随提交泄漏                                | UI unit                      |
| OPM-04  | 提交时模型或档位已失效                    | 创建任务                 | 本地稳定错误；不调用 takeTicket；不写 Repo                            | Service unit                 |
| OPM-05  | queued/paused 保存选择已失效              | 编辑并保存               | 展示不可用且阻止原样保存；不静默换成首项                              | UI + Service unit            |
| OPM-06  | History 模型已退出 Registry               | 查看历史                 | 仍展示已保存字符串，不把它加入候选或重写记录                          | UI unit                      |
| OPM-07  | 排队后模型/档位退出 Registry              | Scheduler 派发           | 网络前拒绝；任务 permanent failed；不进入 transient 重试              | Host/Scheduler unit          |
| OPM-08  | Task 未显式模型且 scoped View 非空        | Host 解析默认            | 只取当前 View 有序第一项，不从 Connection/Catalog/假 Model 推断       | Host unit                    |
| OPM-09  | `ZCODE_OFFPEAK_MOCK=1`                    | 运行 Off-Peak E2E        | 产品服务由 Mock 驱动；模型候选只来自测试 ZCode Built-in Config        | Services + Desktop E2E       |
| OPM-10  | 测试试图用未知模型                        | 构造测试 Registry / 提交 | 无 `ZCODE_OFFPEAK_MOCK_ALLOWED_MODELS` 入口；缺完整 Config 时明确失败 | Config + Service unit        |

### 7.2 明确剪枝

| 组合                                                 | 处理   | 原因                                                  |
| ---------------------------------------------------- | ------ | ----------------------------------------------------- |
| 手机 `/remote` 创建或编辑 Off-Peak                   | pruned | 当前产品明确不支持，不因 DTO 清理新增入口             |
| 远程 Workspace Off-Peak                              | pruned | 当前 Off-Peak 只面向 Desktop 本地 Workspace           |
| Registry 更新后自动重写已保存任务                    | pruned | 任务记录保存历史选择；只在编辑/派发边界校验           |
| Account allowedModelIds 过滤 idle models             | pruned | Account 负责准入和鉴权，不拥有闲时产品模型成员        |
| Mock 注入任意模型                                    | pruned | 模型事实必须来自测试 ZCode Built-in Config / Registry |
| 修改 Session Selection、App Recent 或普通 busy queue | pruned | execution-scoped idle turn 的既有不变量               |

本 Todo 以 Provider/Services/UI/Host/Scheduler 单测为主。现有 Off-Peak Desktop E2E 只需验证 Mock + 测试
ZCode Built-in Config 的代表性主链，不新增大规模 Conversation E2E，也不改 conversation case catalog。

## 8. 实施顺序

### Step A：Spec 与失败测试

- 更新 Off-Peak spec 中候选 View、双重校验和 Mock 模型事实边界；
- 为 scoped hidden Provider View、UI Reasoning、create/update 校验、dispatch permanent failure 和 Mock
  ZCode Built-in Config 先写失败测试；
- 确认 Todo 03 已发布完整 Registry Model Config 类型；若 Todo 08 已删除独立 Reasoning State，直接复用其
  Selection View helper。

### Step B：统一 Registry 投影

- 在 Provider 层提取普通 Model Selection 与 scoped Off-Peak 共用的 Provider/Model View projector；
- 普通 Facade 继续先过滤 hidden，再调用 projector；
- Off-Peak 服务按固定 Provider ID 精确读取并调用同一 projector；
- 不新增 `includeHidden` 通用参数。

### Step C：Service Contract 与 UI

- 将 `OffPeakClientConfig` 收口为产品 View，携带 scoped 标准 Selection View；
- UI 直接用 Registry model candidates 构造扁平选择器；
- Reasoning 复用正式 Model Thought Option helper；
- 删除 `allowedModels` / `allowedModelConfigs` 和 Off-Peak legacy thought helper。

### Step D：提交和派发校验

- create/update 在 Ticket/Repo 前校验当前 Selection；
- 派发前重新校验，确定性失效映射 permanent failure；
- Host 默认模型读取 scoped View 的有序第一项；
- 不从 Connection、Catalog、Provider 类型或 modelId hardcode 制造 fallback。

### Step E：Mock 和旧代码归零

- 删除 `ZCODE_OFFPEAK_MOCK_ALLOWED_MODELS` 生产解析、测试和文档；
- 保留 Mock Gateway 及产品/服务状态场景变量；
- E2E 继续从正式 ZCode Built-in Config 派生测试 Provider，只覆盖 Endpoint 和必要测试事实；
- 删除失去调用方的 legacy DTO 构造、类型 import、helper 和测试 fixture。

### Step F：验证与提交

- 运行 Provider、Coding Plan Subscription、Off-Peak Service、UI、Host/Scheduler 受影响单测；
- 运行代表性 Off-Peak Desktop E2E；
- 运行 `pnpm typecheck`、`pnpm lint`、`pnpm fmt:check`；
- 更新 Feature Graph 已确认语义边；
- 独立 Conventional Commit。

## 9. 完成定义

- Off-Peak 生产代码不再引用 `ModelProviderModelConfig`；
- 无 `allowedModelConfigs` 和模型事实用途的 `allowedModels`；
- 无 `createOffPeakModelConfig()`、`createLegacyReasoningSpec()` 和旧 Off-Peak Reasoning helper；
- 普通 `ModelSelectionView` 仍过滤 hidden Provider；
- Off-Peak scoped View 只能解析固定 `OFF_PEAK_PROVIDER_ID`，且复用正式 View projector；
- UI、创建/编辑校验、默认模型和派发校验读取同一 Registry revision/结构；
- 无 `ZCODE_OFFPEAK_MOCK_ALLOWED_MODELS`；测试模型只来自测试 ZCode Built-in Config / Registry；
- 无假 Model、fallback Model、临时 Model Config 或 Registry 外模型能力推断；
- 失效选择在创建/编辑时不取 Ticket、不写 Repo，在派发时 permanent fail-closed；
- Task 数据库、Ticket、Account Access、Request Auth、Telemetry、desktop continuous 与 mobile replayable
  语义保持不变。

完成后，Off-Peak 从候选展示到真实执行只剩一条模型抽象链：

```text
Built-in / Account / Personal Config
              |
              v
Complete Provider Registry
              |
              v
Scoped ModelSelectionView
              |
              v
ModelSelection
              |
              v
ModelFactory -> Active Model -> Request
```
