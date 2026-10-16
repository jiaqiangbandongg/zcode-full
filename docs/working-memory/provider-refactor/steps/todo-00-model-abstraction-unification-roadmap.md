# 00 模型抽象统一清理路线图

> 状态：已完成
>
> 日期：2026-08-25
>
> 来源审查：[`../research/model-abstraction-unification-cleanup-audit.md`](../research/model-abstraction-unification-cleanup-audit.md)
>
> 目标设计：[`../design/design.md`](../design/design.md)

## 0. 完成结果

Todo 01–10 已全部实施。生产主链只保留 `ModelSelection -> Provider Registry -> ModelFactory -> Model`：
Core 不再查询 Connection 或 Adapter Registry，模型能力和请求兼容只来自完整 Model Config；账号连接选择、
Off-Peak 和 ZCode Built-in Config 也已切入同一结构化事实链。

新增的 Todo 11 只保存 Provider Runtime 组合边界的后续审查，当前为“草案/不得实施”。Todo 12–14 已完成：
用户选择 Facade 与执行校验分离；目标 Host、workspaceKey、稀疏结构化产品 Selection 和 Local-only Subagent
Settings 已收口；MCS、Factory Contract、Legacy DTO 与死代码机械残留也已归零。这些后续工作不改变 Todo
01–10 的完成结论。

2026-08-27 的完成后反向审查发现：Todo 05/07/12–14/20/21 的部分完成声明与当前代码仍有差异，包括公共
`accessId`、`ForkModelRef`、Selection 字符串、Model 编辑事务和继承 UI。Todo 23 已关闭 Selection 与 Settings
事务缺口；Todo 24 以最终裁决取代其 Access 切片，删除创建时账号绑定并收口请求期鉴权与签名；Todo 25 同时退役
ZAPI 产品入口。当前路线图的机械归零结论已覆盖这些反向审查缺口。

保留的旧字段只存在于明确的历史读取边界：Session Store codec 和 CLI Personal Config importer。它们只把
已发布数据转换为当前结构，不向 Registry、Runtime 或新写入路径暴露旧类型。恢复旧会话的脚本已经改为
直接写当前消息契约，不再制造新的 legacy 数据。

## 1. 规划目标

Provider Refactor 已建立 `ModelSelection -> Provider Registry -> ModelFactory -> Model` 主链，M4 也已把
闲时任务、Compact 和 Subagent 等特殊执行并入这条链。本路线图负责完成下一步：物理删除仍能表达、装配
或执行模型的旧抽象，使系统最终只有一套业务模型语义。

本路线图与并行的“新增 Provider/M4 代码符合性审查”分工如下：

```text
新增代码符合性审查
`- 检查新 Config / Registry / ModelFactory 是否正确实现已确认设计

本清理路线图
`- 删除新链建立后仍存活的旧执行接口、旧查询接口和混合身份类型
```

最终结构为：

```text
持久化 / Protocol
    ModelSelection
          |
          v
Effective Provider Config + Effective Model Config Rules
          |
          v
  业务 Provider Registry
          |
          v
      ModelFactory
          |
          | 一次解析并冻结 Provider / Model 静态事实
          v
      Active Model
      |- providerId / modelId
      |- properties / optionSpecs / options
      `- generateText / streamText
          |
          v
 Adapter 内部 AI SDK 执行实现
 |- Provider API 编码
 |- execution-provided 按 attempt 解析
 |- proxy / CA / endpoint routing / signing
 |- retry / stream recovery / error normalization
 `- status / telemetry（本轮保持现状）
          |
          v
      Provider API
```

## 2. 要消失的并行抽象

```text
Todo 02/03 完成后的残留

Core ------------------> ModelConnectionPort
  |
  +--> ModelFactory --> Model --> Adapter 私有执行闭包 --> AI SDK
  `--> ModelRef 仍同时表达 identity / result / event 等多种语义

目标

Core --> ModelFactory --> Model --> Adapter 私有执行闭包 --> AI SDK
  |
  +--> 未来选择只使用 ModelSelection
  `--> 当前执行只使用 Model
```

需要退役的不是 Adapter 的网络能力，而是它向业务层暴露的第二套模型装配和查询语义。

## 3. 已确认边界

### 3.1 唯一业务抽象

- `ModelSelection` 表达未来要创建什么 Model，可以持久化和跨进程传输；
- `ModelFactory` 是业务层创建根执行 Model 的唯一入口；已有 `Model` 可以通过 `Model.bind()` 派生同身份、
  同静态事实和同 Executor 的绑定 Model；
- `Model` 是当前执行使用的唯一模型对象，Core 不直接认识 Adapter 或 Connection；
- Adapter 只把已经解析好的静态事实和请求转换为 Provider API 调用。

### 3.2 不创建新的中间业务状态

本轮不引入 `ExecutionModelBinding`、`ExecutionModelConfig`、`ModelIdentity` 或另一种 Execution Registry。
Adapter 内部可以使用私有参数对象、闭包和缓存，但它们不成为可选择、可查询、可持久化或可同步的业务
模型状态。

### 3.3 生命周期

```text
Registry revision N ----> 创建 Model A ----> A 固定 revision N 的静态事实

Registry revision N+1 --> 创建 Model B ----> B 使用 revision N+1

请求期 Request Auth ----> 每个 attempt 解析动态访问材料
                         `- 不改写 A/B 的 endpoint、api.type 或 properties
```

Config 更新只影响后来创建的 Model。已创建 Model 不通过 Adapter Registry 热切换 Endpoint、API 类型、
Provider Options 或模型能力。动态鉴权仍可在当前 Model 的每次请求尝试中刷新。

### 3.4 Telemetry

Telemetry 当前设计另有问题，但本轮明确不重构：

- 不新增 Telemetry Context 或 Observation DTO；
- 不借清理 `ModelRef` 建立 `ModelIdentity`；
- 不拆分 Product Status 与 Telemetry；
- 必要的类型迁移以保持现有事件行为为限。

## 4. 分阶段 Todo

状态只使用三种稳定值：`草案` 表示仍需逐项讨论、不得直接实施；`待执行` 表示决策已经明确，可以实施或正在实施但
尚未完成验收；`已完成` 表示实现、测试、文档和提交均已完成。

| Todo                                                                         | 状态   | 任务                            | 目标                                                                                | 主要依赖                 |
| ---------------------------------------------------------------------------- | ------ | ------------------------------- | ----------------------------------------------------------------------------------- | ------------------------ |
| [`01`](./todo-01-core-model-adapter-boundary-cleanup.md)                     | 已完成 | Core Model Adapter 边界清理     | 删除 Core `modelAdapter`、Compatibility Model、旧 ModelPort 和 Adapter 直接执行入口 | M4 已完成                |
| [`02`](./todo-02-ai-sdk-execution-registry-retirement.md)                    | 已完成 | AI SDK 执行 Registry 退役       | 删除 Adapter 的可变 Provider Registry 和反向查询面，改为创建 Model 时一次装配       | 与 Todo 03 同步完成      |
| [`03`](./todo-03-provider-model-ownership-and-property-totality.md)          | 已完成 | Provider/Model 新实现符合性收口 | 完成成员所有权、enabled/visibility 和 Properties 完备性                             | 与 Todo 02 同步完成      |
| [`04`](./todo-04-core-model-connection-port-retirement.md)                   | 已完成 | Core Model Connection Port 退役 | 能力只读 Active Model.properties，Connection 留在 Adapter 私有实现                  | Todo 02、03 已完成       |
| [`05`](./todo-05-model-ref-retirement.md)                                    | 已完成 | ModelRef 退役                   | Selection 用 ModelSelection，执行用 Model，按消费者删除冗余身份字段                 | Todo 01 已完成           |
| [`06`](./todo-06-config-storage-envelope-repository-privatization.md)        | 已完成 | Config 存储外壳私有化           | Document、版本外壳与 migration 退出 Provider Domain                                 | 建议 Todo 03、05         |
| [`07`](./todo-07-account-connection-selection-and-access-context-cutover.md) | 已完成 | Account Connection 收口         | 结构化连接选择、Account Access、Request Auth、Off-Peak 与 MCP 使用同一事实链        | Todo 03 完整类型边界     |
| [`08`](./todo-08-legacy-model-catalog-retirement.md)                         | 已完成 | Legacy Model Catalog 退役       | 删除 Catalog/override、Reasoning State，并以 Config 驱动 MFJS Tool Schema 投影      | Todo 02、03 已完成       |
| [`09`](./todo-09-off-peak-model-selection-legacy-projection-retirement.md)   | 已完成 | Off-Peak 旧模型投影退役         | 隐藏 Provider 以 scoped Selection View 统一候选、Reasoning 与双重校验               | Todo 03、08              |
| [`10`](./todo-10-zcode-builtin-provider-config-naming-cutover.md)            | 已完成 | ZCode Built-in Config 命名切换  | Provider Config 的 `official` 领域、代码和物理命名原子退出，不保留兼容              | 可独立执行               |
| [`11`](./todo-11-provider-runtime-composition-boundary-cleanup.md)           | 草案   | Provider Runtime 组合边界清理   | 审查 Node Config 资源、Host/Agent 组合根和唯一生命周期 owner                        | 待人工逐项裁决           |
| [`12`](./todo-12-model-selection-validation-boundary-cutover.md)             | 已完成 | Model Selection 校验边界收口    | Facade 只提供用户候选，Registry/ModelFactory 承担权威执行校验                       | 可独立执行               |
| [`13`](./todo-13-target-host-model-selection-authority.md)                   | 已完成 | 目标 Host 模型选择权威收口      | local/remote 读取目标 Host，删除临时 App/字符串选择并按 workspaceKey 隔离状态       | 建议在 Todo 12 之后      |
| [`14`](./todo-14-post-refactor-mechanical-zero.md)                           | 已完成 | Provider Refactor 最终机械归零  | 修复 Full Compact MCS，收紧 Factory，私有化 Legacy DTO 并删除死代码                 | 与 Todo 12/13 协调       |
| [`23`](./todo-23-provider-refactor-decision-gap-closure.md)                  | 已完成 | 决策缺口与设置事务收口          | 删除公共连接 ID/同形 ModelRef，收口 Selection 与 Model 编辑事务                     | Todo 24 取代 Access 细节 |
| `24`（文档仅官方版本保留）                                                   | 已完成 | Access 与请求安全校验契约收口   | 收窄 Account Overlay，按当前连接鉴权，Access Type 与安全校验准入机械归零            | 取代 Todo 23 Access      |
| [`25`](./todo-25-zapi-product-entry-retirement.md)                           | 已完成 | ZAPI 产品入口退役               | 删除当前产品身份、专属 Gate、UI 入口和 Legacy 迁移特例                              | 独立产品裁决             |

编号表示清理清单的稳定身份。实施期间按逐项确认、逐项实施推进；最终依赖链已经全部闭合：

```text
Todo 01 完成并验收
        |
        v
Todo 02–10 逐项裁决并实施
        |
        v
机械归零、全量验证和最终审计
```

Todo 02/03 建立完整 Model Properties 和唯一 Registry 类型边界；Todo 04/05 随后删除 Core Connection 查询和
混合模型身份；Todo 06 收回存储外壳；Todo 07 建立结构化 Account Connection；Todo 08–10 最终删除 Catalog、
Off-Peak 旧投影和错误的 Official 命名。Todo 11 是上述工作完成后发现的独立组合边界草案，不纳入既有完成链，
不能在人工裁决前实施；Todo 12 是独立的已裁决校验边界清理；Todo 13 在 Todo 12 的最终校验边界上收口
Host 用户选择事实、Workspace 默认与产品持久化；Todo 14 只完成已确认契约的最终机械归零。Telemetry 整体
重构不属于本路线图。

## 5. Impact Brief

### 5.1 功能摘要

| 字段             | 结论                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------- |
| Developer intent | 删除旧模型抽象，统一 Provider/Model 装配和执行边界                                      |
| Capability       | Provider Registry、Model 创建、模型执行                                                 |
| Change layer     | `commit-effect`、`validation`、`persistence contract`                                   |
| Operating mode   | incremental cleanup                                                                     |
| Primary seeds    | `AgentRuntime`、`ApiProviderModelRuntime`、`ModelConnectionPort`、`ModelRef`            |
| Out of scope     | Telemetry 重构、账号鉴权产品设计、模型选择产品语义、Queue/Recovery、Remote Provisioning |

### 5.2 UI Surface Matrix

除 Todo 03 已明确的 Provider 模型启停、可见性、成员来源和冲突交互外，其余 Todo 不计划修改 UI。以下入口共享候选
事实，但各自的状态和提交落点仍保持独立：

| 用户场景                      | UI 入口                | 权威来源                                   | 本轮要求             | 必须隔离                  |
| ----------------------------- | ---------------------- | ------------------------------------------ | -------------------- | ------------------------- |
| 普通模型选择                  | Composer model control | Model Selection Facade / Session Selection | 过滤 disabled/hidden | Active Model 不被 UI 热改 |
| Provider 设置                 | Provider Settings      | Settings Facade / Personal Config          | 展示并保存 enabled   | 不暴露 hidden Provider    |
| Automation/Subagent/Repo Wiki | 各自模型控件           | 各自 Draft/Persistence + Selection Facade  | 选项来源不变         | 不统一各自 commit sink    |

### 5.3 分级影响面

| 等级           | 关系                                      | 为什么必须检查                                           | 证据                                                       |
| -------------- | ----------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------- |
| must-inspect   | Core Runtime -> ModelFactory/Model        | 删除旧 Adapter 和 Connection 入口                        | `apps/zcode-cli/packages/core/src/runtime`                 |
| completed      | Bootstrap -> Provider Registry -> Adapter | 已删除第二份可变 AI SDK Registry，Model 创建时一次装配   | `provider-registry-model-runtime.ts`                       |
| must-inspect   | Adapter runner -> AI SDK                  | 保留所有 Provider IO 行为，同时缩小装配接口              | `adapters/src/model/runner.ts`、`model-execution.ts`       |
| must-inspect   | Contracts -> ModelRef/Result/Event        | `ModelRef` 混合身份、选择和 variant                      | `contracts/src/model/index.ts`、`events/session.events.ts` |
| should-inspect | Compact/Memory/Subagent/Title/Tools       | 多个模型执行分支必须只消费 Active Model                  | Core 调用点与 Todo 01 测试                                 |
| conditional    | Protocol/session persistence              | 只在 Todo 05 删除或迁移字段时进入                        | Session events、timeline/message persistence               |
| invariant-only | Off-Peak/Goal/Background                  | 继续使用普通 Selection/Factory/Active Model              | M4 execution spec                                          |
| invariant-only | desktop/mobile/remote                     | 不改变 continuous、replayable、Queue、workspace identity | Provider Environment 设计                                  |
| completed      | Adapter 旧 Registry tests                 | 已按网络职责重组，不再保留 Registry 查询语义             | `adapters/tests/registry.test.ts` 等                       |

### 5.4 State owner 与提交落点

| 状态/事实               | 权威 owner                        | 本轮结果                                               |
| ----------------------- | --------------------------------- | ------------------------------------------------------ |
| Provider/Model 静态事实 | 业务 Provider Registry            | Adapter 不再复制为可变查询 Registry                    |
| 未来模型选择            | ModelSelection 所在产品状态       | 不用 ModelRef 或 Adapter 默认 Provider 表达            |
| 当前执行模型            | Agent Loop 的 Active Model        | Core 能力和执行统一读取它                              |
| Provider 网络资源       | Adapter 私有执行闭包/进程服务     | 不成为业务 Registry View                               |
| 动态 Request Auth       | Model request dependency          | 每个 attempt 解析，不进入 Config/Selection/Persistence |
| Session 事件/历史       | 既有 Session contract/persistence | Todo 05 逐字段判断保留 Selection、扁平身份或删除       |

### 5.5 必须保持的不变量

1. 所有生产模型调用通过 ModelFactory 创建的 Model；
2. 一个 Loop/Step 使用确定的 Active Model，Config 更新不热改它；
3. Automatic Compact 使用当前 Active Model，Subagent 创建自己的 Model；
4. hidden Provider 仍是普通完整 Registry 成员，只在用户 Facade 不可见；
5. execution-provided 缺失在网络前失败，且只覆盖动态访问材料；
6. Provider SDK 编码、代理、CA、Endpoint Routing、签名、Retry、Stream Recovery 和错误归一化不丢失；
7. 不改变 Session Selection、App Recent、Queue、Goal、Background、Off-Peak admission；
8. 不把 replayable 恢复语义扩散到 desktop continuous，也不改变 workspace identity；
9. 不新增第二套 capability、identity、connection 或 execution config DTO；
10. Telemetry 行为维持现状，不因清理扩大 payload 或引入新 context。

### 5.6 代码事实与图谱漂移

- `AiSdkModelRegistry`、配置热更新和 Bootstrap 全量同步已经在 Todo 02 归零；
- `ModelConnectionPort` 经 barrel export 扩散到 Core Runtime、Tool、WebSearch、MCS 和 Embedded Search；
- `ModelRef` 当前仍出现在约 50 个非测试生产文件；
- 仓库 `dep:refs` 默认 glob 不包含 `apps/zcode-cli/packages/*`，必须带
  `--scope apps/zcode-cli/packages`；barrel import 会让部分 interface 的符号结果低估，因此删除验收还要结合
  `rg`、TypeScript 和 package tests；
- 功能图已有 Provider Registry、Model capabilities 和 Off-Peak execution 节点，本计划补充执行抽象清理
  seeds 与不变量，不新增 UI surface。

## 6. 用例规划与剪枝

### 6.1 主要维度

| 维度            | 代表值                                                    | 处理                     |
| --------------- | --------------------------------------------------------- | ------------------------ |
| 模型生命周期    | 创建前 Config 更新 / 创建后更新                           | 必测                     |
| Access          | api-key / zhipu-account / execution-provided              | 必测                     |
| 请求形态        | generate / stream / retry                                 | 必测                     |
| 执行来源        | main / compact / subagent / off-peak                      | 代表性覆盖               |
| Provider API    | Anthropic / OpenAI Responses / OpenAI-compatible          | 必测投影                 |
| 客户端/远程模式 | desktop continuous / mobile replayable / remote workspace | 不变量回归，不展开状态积 |
| Telemetry       | status / trace / usage                                    | 仅回归，不设计新状态     |

### 6.2 剪枝决定

- 不枚举 UI surface × Provider API：本轮不修改 UI 或候选生成；
- 不枚举 Queue/Recovery × Adapter 实现：没有状态或协议语义变化，只做主链回归；
- 不为每个模型 ID 建用例：能力来自 Config，不允许 modelId hardcode；
- 不把 Adapter Registry 的每个旧单测原样迁移；按保留的网络职责重新组织行为测试；
- 不为 Telemetry 新建 case catalog；只验证现有事件没有因类型迁移丢失关键字段。

### 6.3 稳定验收用例

| Case ID | Setup                                | Action                  | Assertions                                      |
| ------- | ------------------------------------ | ----------------------- | ----------------------------------------------- |
| MAU-01  | Registry revision N 创建 Model A     | 更新到 N+1 后继续请求 A | A 的 API/Endpoint/Properties 不变               |
| MAU-02  | Registry 已更新到 N+1                | 创建 Model B            | B 使用 N+1                                      |
| MAU-03  | execution-provided Model             | 无 Source 发起请求      | 网络前类型化失败                                |
| MAU-04  | execution-provided Model             | Retry 时刷新 auth       | 只变 auth，不变静态执行事实                     |
| MAU-05  | Main/Compact/Subagent                | 各执行一次请求          | Core 只经 Model，无 Adapter/Connection fallback |
| MAU-06  | Image/PDF/Video capability           | 允许/拒绝请求           | 只读 Model.properties，Adapter 编码限制仍生效   |
| MAU-07  | legacy ModelRef persistence          | 恢复历史数据            | 只在边界转为当前语义，领域不继续保存 ModelRef   |
| MAU-08  | desktop/mobile/remote representative | 执行模型请求            | Selection、队列和恢复语义不变                   |

这些是跨 Todo 的稳定 Case ID。具体单测文件和更细断言写入各 Todo，E2E 只覆盖真正跨进程或已有主链
回归，不为纯 TypeScript 抽象删除新增大规模 UI E2E。

## 7. 每个 Todo 的统一实施规则

1. 开工前等待或避开并行工作树中的重叠文件；
2. 先更新对应 spec/Todo，再写失败测试；
3. 先迁移生产装配和测试 helper，再删除接口；
4. 不用 deprecated alias、`any` 或兼容 fallback 延长旧抽象；
5. 每个 Todo 都以 `rg`/`dep:refs` 归零条件、受影响单测、`pnpm typecheck`、`pnpm lint` 和
   `pnpm fmt:check` 验收；
6. Todo 原则上保持可独立审查；存在同一事实链和原子切换依赖时，可以合并为一个 Conventional Commit；
7. 若发现必须改变产品状态、Protocol 恢复或 Telemetry 语义，停止该 Todo 并单独裁决，不顺手扩 scope。

## 8. 暂不编号的后续问题

以下问题已知存在，但尚未完成逐项设计讨论，不进入上述 Todo：

- Account Provider 动态凭据和 runtime header refresh 的长期归属；
- Telemetry、Status、Context 和 Observation 的整体重构。

这些项后续逐一讨论。未裁决前可以在前置 Todo 中删除已经失去调用方的死代码，但不能借机发明新的长期
抽象或改变产品语义。
