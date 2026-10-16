# 12 Model Selection 校验边界收口

> 状态：已完成
>
> 日期：2026-08-25
>
> 来源审查：[`../provider-implementation-architecture-conformance-review.md`](../provider-implementation-architecture-conformance-review.md)
>
> 相关设计：[`../design/registry/registry.md`](../design/registry/registry.md)、[`../design/registry/model-creation.md`](../design/registry/model-creation.md)

## 0. 已确认目标

Model Selection 的权威校验发生在任务真正开始执行、`ModelFactory` 准备构建 Model 的边界。用户 Facade
只负责提供用户可见候选，不再同时充当内部执行校验器。

```text
用户候选

ModelSelectionFacade
|- getView()
`- onDidChange()
        |
        v
visible Provider / Model


执行事实

提交任务携带 ModelSelection
        |
        v
当前 Agent 进程 Provider Registry
        |
        v
validateSelection()
        |
        v
ModelFactory 构建 Model
```

Off-Peak 在创建、编辑和派发前使用同一 Registry 语义提前校验：创建校验发生在申请 Ticket 前，派发校验防止
排队期间配置失效；这些检查都不替代 ModelFactory 的最终校验。Visibility 只影响用户候选，不是权限，也不
产生 `trusted`、`execution-only` 等新概念。

## 1. 当前问题

1. `ModelSelectionFacade.getView()` 过滤 hidden Provider/Model，但 `validate()` 直接委托完整 Registry，同一个
   Facade 同时表达了用户候选和内部精确执行两种语义；
2. 普通 UI 当前只消费 `getView()`/`onDidChange()`，`IModelSelectionService.validate()` 的生产调用主要是
   Desktop Off-Peak 派发，实际成为 hidden Provider 借用的内部捷径；
3. `ApiProviderModelRuntime.modelFactory` 当前只精确查找 Provider/Model，没有在构建入口统一调用 Registry 的
   reasoning level、max output tokens 等 Selection option 校验；
4. Off-Peak 另一条创建/编辑链已经直接使用 Registry 精确校验，当前同一产品存在两条校验入口。

## 2. 改动原则与要点

### A. 用户 Facade 退役执行校验

- 删除 `ModelSelectionFacade.validate()`；
- 删除 `IModelSelectionService.validate()` 及 RPC adapter、Home-only stub、mock 和对应测试；
- 从 `ProviderRegistryFacadeSource` 删除只为 Facade 暴露的 `validateSelection()`；
- 保留 `ProviderRegistryService` / `ProviderRegistry` 的 `validateSelection()`，供 ModelFactory 和内部产品使用；
- Facade 只保留用户候选 View 与变化事件；
- 不让 Renderer 根据 View 复制一套权威 option 校验。

### B. ModelFactory 成为最终校验边界

- `ApiProviderModelRuntime.modelFactory` 在读取并冻结 Provider/Model 事实前，使用当前进程 Registry 完整校验
  `ModelSelection`；
- Provider/Model 不存在、Reasoning Level 不支持、Max Output Tokens 越界都在创建 Model 前 fail-closed；
- 从现有 Registry selection helper 提取共享的 `ModelSelectionValidation -> ModelProtocolError` 映射；
- `provider-not-found` 映射为 `ProviderNotFound`、`model-not-found` 映射为 `ModelNotFound`，option 错误映射为
  `InvalidModelRequest`；ModelFactory 与现有 Selection 解析不能分别维护两个 `switch`；
- 不能直接复用会把 `provider-not-found` 返回 `undefined` 的 fallback helper；ModelFactory 必须明确失败；
- hidden 但完整、enabled 的模型仍在 Registry 中，可被内部精确 Selection 正常创建；
- 每个新创建的根执行 Model 都经过同一个 ModelFactory 边界；`Model.bind()` 和复用当前 Active Model 的
  Automatic Compact 继承已经校验并冻结的事实，不重新查询 Registry。

### C. Off-Peak 保留窄提前检查

- Desktop Off-Peak 不再调用用户 `IModelSelectionService.validate()`；
- 复用 `OffPeakTaskServiceDeps.resolveModelSelection` 现有完整 Registry 解析依赖；如 Desktop Host 需要调用，
  只在具体 `OffPeakTaskService` 上提供 Host 私有派发校验方法，不加入 Renderer RPC 接口；
- 不新增 Registry Service、RPC 或拥有状态的通用 Validation Service；
- 创建阶段在 `takeTicket()` 前校验，编辑阶段在持久化前校验，派发阶段在启动 Agent turn 前重新校验；
- 派发提前校验失败继续形成 `OffPeakModelUnavailableError` 和 permanent dispatch failure；
- 提前校验通过后，真正构建闲时 Model 时仍再次执行最终校验，防止派发等待期间 Registry 已变化。

### D. 不改变选择状态

- 不修改 Composer Draft、App Recent、Configured Default 或 Session Selection；
- 不改变 Configured Default/fallback 的候选解析；
- 不改变 Model Selection 的协议和持久化结构；
- 不改变 UI 候选排序、分组或 hidden 过滤；
- 不改变 Desktop continuous、Mobile replayable、remote workspace、Queue 或恢复语义。

## 3. Impact Brief

| 字段             | 结论                                                                                                           |
| ---------------- | -------------------------------------------------------------------------------------------------------------- |
| Developer intent | 删除用户 Facade 的内部执行校验语义，把权威校验归位到 Model 构建边界                                            |
| Capability       | Model Selection、Provider Registry、ModelFactory、Off-Peak execution                                           |
| Change layer     | `validation`、`commit-effect`                                                                                  |
| Operating mode   | planning / implementation-handoff                                                                              |
| Primary seeds    | `ModelSelectionFacade`、`IModelSelectionService`、`ApiProviderModelRuntime.modelFactory`、`dispatchOffPeakRun` |
| Out of scope     | 候选 UI、选择状态、持久化、Access/Auth、Runtime composition、Telemetry                                         |

### 3.1 UI Surface Matrix

| 用户场景                      | 候选来源                          | 提交落点              | 最终校验                                   | 本 Todo 可见变化 |
| ----------------------------- | --------------------------------- | --------------------- | ------------------------------------------ | ---------------- |
| 普通对话选择模型              | `ModelSelectionFacade.getView()`  | Submission / Session  | Agent Registry + ModelFactory              | 无               |
| Automation/Subagent/Repo Wiki | 同一候选 View，各自保持独立 Draft | 各自既有配置/提交命令 | 真正创建 Model 时                          | 无               |
| Off-Peak hidden 模型          | 内部产品配置/精确 Selection       | Off-Peak dispatch     | 提前 Registry 检查 + ModelFactory 最终校验 | 无               |

### 3.2 关系与 owner

| 等级           | 关系                          | 要求                                                 |
| -------------- | ----------------------------- | ---------------------------------------------------- |
| must-inspect   | Facade -> Services/RPC/mocks  | `validate()` 全链删除，不留空实现                    |
| must-inspect   | ModelFactory -> Registry      | 构建前执行完整 Selection 校验，共用错误映射          |
| must-inspect   | Off-Peak dispatch -> Registry | 复用既有 resolver，保留 permanent failure            |
| should-inspect | Client/Remote service proxy   | 接口收窄后代理、Bot 和 remote workspace 装配继续成立 |
| should-inspect | Configured Default/fallback   | 既有提前解析不替代最终校验，行为不变                 |
| invariant-only | 所有模型选择 UI               | 候选、Draft、commit sink 和持久化不变                |
| invariant-only | Desktop/Mobile/Remote         | delivery、Queue、Recovery 和 workspace identity 不变 |

当前环境没有可调用的 codegraph 接口。影响面以 Feature Graph、`dep:refs`、精确调用扫描和目标源码为证据；
实现前重新执行引用归零和受影响测试发现。

## 4. 已接受用例与剪枝

| Case ID | Setup                                    | Action                        | Assertions                                           |
| ------- | ---------------------------------------- | ----------------------------- | ---------------------------------------------------- |
| MSV-01  | visible Provider/Model                   | 正常提交并创建 Model          | Registry 校验通过，创建一次 Model                    |
| MSV-02  | Provider 或 Model 已从当前 Registry 消失 | 开始构建 Model                | 创建前返回稳定的 Provider/Model 错误                 |
| MSV-03  | Reasoning 或 Max Output option 无效      | 开始构建 Model                | 创建前返回 `InvalidModelRequest`，不进入 Adapter     |
| MSV-04  | hidden Off-Peak Provider 完整且 enabled  | 派发并构建 Model              | 提前检查和最终校验均通过，用户 View 仍不可见         |
| MSV-05  | Off-Peak 提前检查后 Registry 发生变化    | 最终构建 Model                | ModelFactory 按最新 Registry fail-closed             |
| MSV-06  | 普通模型候选 UI                          | 读取并切换候选                | View、选择状态和提交行为不变，不调用 Facade validate |
| MSV-07  | 已创建并校验的 Active Model              | `bind()` 或 Automatic Compact | 继承冻结事实，不重新读取当前 Registry                |

剪枝：不展开 UI surface × Provider API，因为本 Todo 不改变候选或 Adapter 编码；不新增大规模 E2E。普通
ModelFactory 和 Off-Peak 的跨边界单测足以证明核心行为，已有代表性 UI/Off-Peak E2E 只做回归。

## 5. 实施与验收

1. 先更新正式 Design 中 Facade 与 ModelFactory 的校验职责；
2. 先写 ModelFactory option fail-closed、hidden 精确创建、绑定 Model 不重查 Registry 和 Off-Peak permanent
   failure 测试；
3. 提取共享 Validation -> Protocol Error 映射，并补齐 ModelFactory 最终校验；
4. 让 Off-Peak 派发复用 `OffPeakTaskServiceDeps.resolveModelSelection`，删除对用户 Facade 的调用；
5. 删除 Facade/Service `validate()`、`ProviderRegistryFacadeSource.validateSelection()` 和全部占位实现；
6. 用 `rg`、`dep:refs` 确认以下生产引用归零：

```text
ModelSelectionFacade.validate
IModelSelectionService.validate
modelSelectionService.validate
ProviderRegistryFacadeSource.validateSelection
```

7. 执行 Provider、Services、Bootstrap、Client、Server、Desktop、Web 受影响单测；显式覆盖
   `RemoteServiceAccess`、Bot remote proxy、remote workspace service collection 和 Web Home-only stub，以及：

```text
pnpm typecheck
pnpm lint
pnpm fmt:check
```

8. 完成后回写 Todo 状态和实现结果，以 Conventional Commit 提交。

## 6. 非目标

- 不修改 Provider/Model visibility、enabled、成员或 Overlay；
- 不把 hidden 解释为权限或受信身份；
- 不改变 Model Selection persistence 或 Session 生命周期；
- 不把 Off-Peak Selection 写入普通 Session Selection；
- 不处理 Provider Runtime composition；
- 不重构 Access、Request Auth、Telemetry、Queue 或 Recovery。

## 7. 实施结果（2026-08-25）

- `ModelSelectionFacade` 与跨 Host `IModelSelectionService` 已删除通用 `validate()`，Web Home-only stub、测试和
  Facade Source 同步归零；
- `ApiProviderModelRuntime.modelFactory` 在 Adapter 创建前使用当前 Agent Registry 完整校验 Selection，且与
  Registry selection resolver 共用唯一的 `ModelSelectionValidation -> ModelProtocolError` 映射；
- Provider/Model 缺失分别稳定映射为 `ProviderNotFound` / `ModelNotFound`，非法 reasoning 与 max output 在
  Adapter 前映射为 `InvalidModelRequest`；
- hidden、完整且 enabled 的 Provider/Model 继续通过普通 Registry 精确创建；
- Off-Peak 派发改用具体 `OffPeakTaskService.validateDispatchModelSelection()` 窄检查，创建/编辑仍复用同一
  resolver，最终 ModelFactory 校验保持不变；
- 归零扫描未发现 `ModelSelectionFacade.validate`、`modelSelectionService.validate` 或 Facade Source
  `validateSelection` 残留；专项 Provider、Services、Web 与 Bootstrap 测试及根 `pnpm typecheck` 通过。
