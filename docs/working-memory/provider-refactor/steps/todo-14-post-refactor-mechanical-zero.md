# 14 Provider Refactor 最终机械归零

> 状态：已完成
>
> 日期：2026-08-25
>
> 相关任务：[`04`](./todo-04-core-model-connection-port-retirement.md)、
> [`08`](./todo-08-legacy-model-catalog-retirement.md)、
> [`12`](./todo-12-model-selection-validation-boundary-cutover.md)、
> [`13`](./todo-13-target-host-model-selection-authority.md)
>
> 相关设计：[`../design/model/contract.md`](../design/model/contract.md)、
> [`../design/registry/model-creation.md`](../design/registry/model-creation.md)、
> [`../design/execution/execution.md`](../design/execution/execution.md)

## 0. 任务目标

删除 Provider Refactor 已完成设计在当前实现中留下的机械残余，并修复一处违反既有 MCS 公式的明确 Bug。
本 Todo 不建立新抽象，也不重新讨论已经确认的产品语义。

```text
Model Config / Registry
        |
        v
Minimal RuntimeModelFactoryInput
        |
        v
Active Model
        |
        +--> Provider message projection
        |      `- force || Model property
        |
        `--> Compact / Memory / Title / Child execution

Released legacy provider storage
        |
        v
Importer-private parser/types
        |
        v
Current Provider Config

Unused compatibility files
        `--> delete
```

完成后：Core 不再向 ModelFactory 传递无效的旧 Config/Capability 参数；Full Compact 与其他请求路径使用同一
MCS 判定；旧 Provider DTO 只存在于 Legacy importer 私有边界；已确认无调用方的重构遗留文件归零。

## 1. 已确认问题与裁决

### 1.1 Full Compact 忽略 `force MCS`

既有设计已经固定：

```ts
useMidConversationSystem =
  runtime.config.midConversationSystem?.mode === "force" ||
  activeModel.properties.supportsMidConversationSystem;
```

普通 Provider message projection 和 Microcompact 已使用该公式，但 Full/Active Compact 当前只读取
`compactModel.properties.supportsMidConversationSystem`。当模型 property 为 `false`、执行参数为 `force` 时，
Full Compact 的 selection、token estimate、preserved entries 和最终 compact request 会使用错误的历史消息形态。

目标行为：

- Full/Active Compact 在取得本次 `compactModel` 后，使用与普通请求、Microcompact 相同的公式；
- 该布尔值统一传给 compact selection、token estimate、summary request 和 preserved segment；
- `force` 只覆盖本次执行，不修改 Model properties，不进入 Model Config；
- Automatic Compact 继续使用当前 Loop Active Model；手动 Compact 继续按自己的 Submission/Loop 语义创建
  Model；
- 不重新引入 Provider kind、Endpoint、baseURL 或 modelId 推断。

这是既有契约的 Bugfix，不需要新的产品裁决。

### 1.2 收紧 `RuntimeModelFactoryInput`

当前接口仍暴露四个已经不被生产 ModelFactory 消费的旧字段：

| 字段                        | 当前事实                                      | 裁决 |
| --------------------------- | --------------------------------------------- | ---- |
| `contextWindow`             | Registry Model properties 已提供完整事实      | 删除 |
| `properties`                | 调用方不能覆盖 Registry 的完整 Model facts    | 删除 |
| `midConversationSystemMode` | MCS override 在 Provider message 投影处判断   | 删除 |
| `providerOptions`           | Provider 参数由 Model Config reasoningMapping | 删除 |
| `selection`                 | ModelFactory 的选择输入                       | 保留 |
| `visibleMaxOutputTokens`    | 当前仍参与 fixed-thinking 可见输出预算计算    | 保留 |
| `reasoningMode`             | 当前仍表达辅助调用禁用 reasoning 的执行意图   | 保留 |
| `requestDependencies`       | 当前仍绑定 request-auth 等本次执行依赖        | 保留 |

本 Todo 只删除已证明无效的字段，不顺带重新设计后三个有效执行参数。所有 Core 调用点删除相应透传；不得为了兼容
保留 deprecated alias、可选字段或无消费参数。

`RuntimeModelFactoryInput` 仍只表达“从 Registry 创建本次 Model 所需的输入”，不能成为另一份 Sparse Model
Config、Capability snapshot 或 Provider options 通道。

### 1.3 Legacy Provider DTO 退出 Shared 公共契约

当前 `ModelProviderConfig`、`ModelProviderModelConfig`、`ModelProviderModelEntry` 及其创建/判断 helper 的生产
引用已经集中在：

- `legacyModelProviderStoreReader.ts`；
- `legacyPersonalProviderConfigImporter.ts`；
- `ProviderConfigRuntime` 的一次性 Legacy reader 注入边界。

这些类型描述已发布旧 Provider store，不是当前 Provider Domain。目标边界固定为：

```text
@zcode/shared public contracts
        `- 不再导出 Legacy Provider store DTO/helper

packages/services/src/model-provider/legacy-*
        |- 私有 Legacy serialized types
        |- 私有 normalize/parser/helper
        `- 单向转换为 ProviderConfigLayerUpdate
```

实施规则：

- 先以无 scope 的 `pnpm dep:refs` 列出 `model-provider-types.ts` 每个 export 的实际调用者；
- 仅将 Legacy reader/importer 确实需要的最小类型和 helper 移入其私有模块；该模块不从 Services barrel 导出；
- Shared 删除已经没有当前协议、UI、Service 或 Runtime 消费者的旧 Provider Catalog/store 类型和 helper；
- Legacy importer 的兼容读取行为暂时保留，直到既有发布兼容窗口另行结束；本 Todo 只私有化，不提前删除用户
  数据迁移能力；
- importer 测试直接构造旧 serialized fixture，UI 与 E2E 测试不得继续借用 Shared Legacy constructor 生成
  当前配置；
- 如果某个 Shared export 仍有真实当前消费者，停止删除并明确归属，不复制一份同形类型绕过检查。

### 1.4 删除已确认无调用方的重构遗留文件

当前 `knip` 与符号级扫描已确认至少以下文件没有生产或测试调用方：

- `packages/ui/src/lib/zcodeDraftThoughtLevelSync.ts`：旧 Draft Session 的字符串 Model/Thought 同步 helper；
- `packages/ui/src/lib/modelInputPresentation.ts`：仍依赖 Legacy `ModelProviderModality` 的旧展示 helper；
- `packages/ui/src/settings/OffPeakToolbarSelect.tsx`：Todo 09 后未再使用的闲时专用选择器。

实施时先重跑 `knip`、`rg` 和 `dep:refs`：

- 仍为零引用则直接删除文件和仅服务它们的测试/exports；
- 若 Todo 13 已经先行删除其中某项，本 Todo 只验证归零，不恢复文件；
- 若出现新的真实调用方，先判断调用方是否重新依赖旧抽象，不以“现在有人用了”为由机械保留；
- 不把全仓 `knip` 的其他既有噪音扩入本 Todo。

## 2. 不属于本 Todo

- Todo 11 的 Node Config、Host/Agent composition root 与唯一 dispose owner；
- Todo 12 的 Selection Facade/ModelFactory 校验迁移；若修改同一 ModelFactory 文件，应按依赖顺序协调；
- Todo 13 的目标 Host、Environment ID、结构化产品持久化和临时 App 删除；
- Dynamic Request Auth、Runtime Header Refresh、官方版本安全校验或账号凭据生命周期；
- Telemetry、Status、Context、Observation 重构；
- Provider Adapter 编码、Reasoning Mapping、MFJS Tool Schema 或新的模型能力；
- Queue、Goal、Background、Off-Peak 调度、desktop continuous、mobile replayable 或 remote workspace 状态语义；
- 结束 Legacy importer 兼容窗口。

## 3. Impact Brief

### 3.1 Feature Summary

| 字段             | 结论                                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------- |
| Developer intent | 把已确认的新 Model/Registry 抽象在类型、执行与迁移边界上机械归零                                           |
| Capability       | Model capabilities、ModelFactory、Compact、Legacy Provider import                                          |
| Change layer     | `commit-effect`、`validation`、`persistence boundary`                                                      |
| Operating mode   | implementation-handoff                                                                                     |
| Primary seeds    | `compactActiveConversation`、`RuntimeModelFactoryInput`、`ModelProviderConfig`、三个 unused UI helper 文件 |
| Out of scope     | Runtime composition、Selection product semantics、Auth、Telemetry、Queue/Recovery                          |

### 3.2 UI Surface Matrix

| 用户场景          | UI 入口             | 状态 owner                  | 本 Todo 变化                     | 必须隔离                        |
| ----------------- | ------------------- | --------------------------- | -------------------------------- | ------------------------------- |
| 普通对话请求      | Composer/Session    | 当前 Loop Active Model      | 无 UI 变化；MCS 公式保持既有行为 | Draft/Selection 不改变          |
| Full/Auto Compact | Conversation        | 当前 Compact + Active Model | `force` 与普通请求一致           | Queue/Timeline/恢复语义不改变   |
| Provider 设置     | Settings            | 当前 Provider Config        | 不再依赖 Legacy Shared DTO       | 当前表单与保存结构不改变        |
| 启动后旧配置迁移  | 无直接 UI           | Legacy importer             | 私有类型单向导入                 | 已发布旧配置继续可读            |
| Off-Peak 编辑     | Automation Settings | Off-Peak product draft      | 只删除无调用方旧组件             | 当前 scoped Selection View 不变 |

### 3.3 Shared And Divergent Behavior

| 关注点             | 共享规则                         | 保持差异                                 |
| ------------------ | -------------------------------- | ---------------------------------------- | --------- | -------------------------------------- |
| MCS                | 所有请求投影都使用 `force        |                                          | property` | Full 与 Micro Compact 保留各自压缩算法 |
| Model 创建         | 静态事实只来自 Registry          | 辅助执行可继续传有效的执行参数           |
| Legacy persistence | 只在 importer 边界读取后单向转换 | 不改变当前 Config Repository             |
| UI                 | 不再引用 Legacy Provider DTO     | 各产品 Draft、commit sink 和控件保持独立 |

### 3.4 Feature Relationships

| 等级           | From                         | 关系                 | To                            | 原因                     |
| -------------- | ---------------------------- | -------------------- | ----------------------------- | ------------------------ |
| must-inspect   | Active Model + runtime force | projects-mcs-through | Full Compact                  | 当前 Bug 所在            |
| must-inspect   | Core helper calls            | creates-through      | Runtime ModelFactory          | 删除无效参数的所有调用方 |
| must-inspect   | Legacy store                 | imports-through      | Personal Provider Config      | 保持已发布数据兼容       |
| should-inspect | Shared barrels/tests         | exposes/depend-on    | Legacy Provider DTO           | 防止旧契约继续扩散       |
| invariant-only | Conversation/Off-Peak UI     | must-not-change      | Draft/commit semantics        | 本 Todo 不改产品状态     |
| invariant-only | local/remote delivery        | must-remain-isolated | continuous/replayable runtime | 无协议或恢复改动         |

### 3.5 State Owners And Commit Sinks

| 事实                       | 权威 owner                          | 本 Todo 后的边界                        |
| -------------------------- | ----------------------------------- | --------------------------------------- |
| MCS 静态支持               | Active Model.properties             | 不变                                    |
| MCS `force`                | 当前 Agent Runtime execution config | 请求/Compact 投影时消费，不进入 Factory |
| Model 静态 Config          | 当前进程 Registry                   | 调用方不能通过 Factory input 覆盖       |
| Legacy serialized provider | Legacy reader/importer 私有边界     | 立即投影为当前 Layer Update             |
| 当前 Provider Config       | Provider Config Service/Repository  | 不依赖 Legacy Shared DTO                |

### 3.6 Graph Drift Candidates

- Feature Graph 尚未声明 Full Compact 必须与普通请求共享 MCS force 公式；本 Todo 补充该 invariant 和 code seed；
- Provider Registry 节点仍保留已退役 `ModelConnectionPort`、`ModelRef`、`AiSdkModelRegistry` code seed。实施本
  Todo 或最终图谱审计时应替换为当前 Registry/ModelFactory seeds；
- Graph 的模型能力 code seed 仍包含已确认 unused 的 `modelInputPresentation.ts`，实施删除后必须移除。

## 4. 实施顺序

### Step A：先补失败测试与 Spec 精确性

1. 在 Core Compact 测试中增加 `property=false + mode=force` 的 Full/Auto Compact 失败用例；
2. 断言 selection、token estimate、preserved history 与最终 Provider request 使用同一 MCS 布尔事实；
3. 更新 MCS/Compact 当前 spec，说明该修复覆盖 Full Compact；
4. 为 Legacy importer 私有边界建立结构测试，先证明 Shared export 和 UI/E2E 依赖需要退出。

### Step B：修复 Full Compact

1. 在 `compactActiveConversationImpl()` 取得 `compactModel` 后计算统一公式；
2. 复用同一个 boolean 完成 Compact 内所有投影，不在下游 helper 重复推断；
3. 保持普通请求和 Microcompact 现有实现；
4. 删除向 ModelFactory 传递的 `midConversationSystemMode`。

### Step C：收紧 Runtime ModelFactory Contract

1. 从 `RuntimeModelFactoryInput` 删除四个无效字段；
2. 删除 Turn、Compact、Memory、Title、Verifier 等调用点的无效透传；
3. 保留并回归 `visibleMaxOutputTokens`、`reasoningMode`、`requestDependencies`；
4. 与 Todo 12 协调 `ApiProviderModelRuntime` 的同文件改动，保证最终校验先于 Model 创建；
5. 增加静态归零检查，禁止再次把 Sparse properties/providerOptions 送入 Factory。

### Step D：Legacy Provider Contract 私有化

1. 用 `dep:refs --list-exports` 和逐符号扫描确定最小集合；
2. 在 Services Legacy 目录建立不导出的 serialized DTO/parser/helper；
3. 迁移 Legacy reader、importer、runtime 注入和专项测试；
4. 从 Shared 删除对应 export、helper 和只验证旧公共类型的测试；
5. UI/E2E fixtures 改用当前 Config fixture，确需验证迁移时直接写旧 JSON；
6. 保持旧数据到当前 Config 的转换结果完全一致。

### Step E：删除死代码并机械验收

1. 复核并删除已确认 unused 文件；
2. 清理 barrel、mock、fixture、注释和 Feature Graph stale seed；
3. 运行归零命令、专项测试和仓库强制门禁；
4. 更新 Todo 状态和路线图后提交独立 Conventional Commit。

## 5. Accepted Cases

| Case ID | Setup                                 | Action                   | Assertions                            |
| ------- | ------------------------------------- | ------------------------ | ------------------------------------- |
| MZ-01   | Model MCS=false，runtime mode=force   | Full Compact             | 全链按 MCS shape 选择、估算并请求     |
| MZ-02   | Model MCS=false，runtime mode=auto    | Full Compact             | 保持 legacy user reminder shape       |
| MZ-03   | Model MCS=true，runtime mode=auto     | Full Compact             | 按 MCS shape 请求                     |
| MZ-04   | Automatic Compact 持有 Active Model A | Registry 更新到 B 后触发 | 仍使用 A 与当前 runtime force         |
| MZ-05   | 各 Core ModelFactory 调用点           | Typecheck/单测           | 不再传四个无效字段                    |
| MZ-06   | fixed-thinking/辅助执行/request-auth  | 创建并调用 Model         | 三个仍有效执行参数行为不变            |
| MZ-07   | 已发布 Legacy Provider store fixture  | 启动 importer            | 转换结果与迁移前一致，Shared 无旧 DTO |
| MZ-08   | 当前 Provider/Model Config            | 正常启动与设置读取       | 不进入 Legacy parser/type             |
| MZ-09   | 三个候选 dead files                   | knip + dep:refs + 删除   | 无生产、测试、barrel 或动态入口残留   |

本 Todo 不新增 conversation 状态组合，不需要修改 Formal Proof 状态机；MZ-01 至 MZ-04 使用 Core unit/integration
测试证明。不存在新的 UI 行为，因此不新增 Desktop E2E，只运行受影响的既有 Provider/Compact 回归。

## 6. 机械归零与验证

### 6.1 必须归零

```text
RuntimeModelFactoryInput.contextWindow             = 0
RuntimeModelFactoryInput.properties                = 0
RuntimeModelFactoryInput.midConversationSystemMode = 0
RuntimeModelFactoryInput.providerOptions            = 0

Core createRuntimeModel() 调用中的上述字段          = 0
Shared 当前公共出口中的 Legacy Provider store DTO  = 0
UI 当前实现对 ModelProviderModality 的依赖          = 0
zcodeDraftThoughtLevelSync.ts                       = deleted
modelInputPresentation.ts                           = deleted
OffPeakToolbarSelect.tsx                            = deleted
```

`ModelProviderConfig` 等字符串可以继续存在于 importer 私有类型名称中；归零目标是 Shared/当前业务公共契约，
不是禁止 Legacy parser 对已发布 JSON 建模。

### 6.2 必须运行

- Core MCS、Full Compact、Microcompact 和 Model lifecycle 单测；
- Bootstrap Provider Registry Model runtime 与 request-auth 单测；
- Services Legacy reader/importer 单测；
- Shared、UI 和 Desktop Provider fixtures 受影响测试；
- `pnpm dep:refs` 对每个待删除 Shared export 的无 scope 复核；
- `pnpm knip`，只要求本 Todo 目标文件/exports 不再出现，不把全仓既有结果伪装为本 Todo 回归；
- `pnpm typecheck`；
- `pnpm lint`；
- `pnpm fmt:check`；
- `pnpm test:unit:affected`。

## 7. 完成定义

1. Full/Auto Compact、Microcompact 与普通 Provider request 使用同一 MCS force 公式；
2. `force` 不修改 Model properties，也不进入 Model Config 或 ModelFactory；
3. Runtime ModelFactory 只接收仍有真实消费语义的字段；
4. Core 无法通过 Factory input 覆盖 Registry 的 context、properties 或 provider options；
5. Legacy Provider store 类型和 helper 不再是 Shared、Protocol、UI、Runtime 或测试公共契约；
6. 已发布 Legacy Provider 配置仍能单向迁移到当前 Config；
7. 已确认的三个 unused 文件及其引用全部归零；
8. Todo 11–13、Dynamic Auth、Telemetry、Queue/Recovery 和 Remote 语义没有被顺带修改；
9. 专项测试与强制门禁通过，并以 Conventional Commit 提交。

## 8. 实施结果

- Full/Auto Compact 在取得本轮 `compactModel` 后只计算一次
  `mode === "force" || model.properties.supportsMidConversationSystem`，selection、估算、summary request 与
  preserved history 共用该布尔事实；新增 `property=false + force` 回归测试；
- `RuntimeModelFactoryInput` 只保留 `selection`、`visibleMaxOutputTokens`、`reasoningMode` 与
  `requestDependencies`。Core 所有调用点已删除 `contextWindow`、`properties`、
  `midConversationSystemMode` 和 `providerOptions` 透传；测试 Factory 也从 Model 自身模拟 Registry facts；
- 已发布旧 Provider Store 的 DTO、parser 和 helper 已移入 Services 私有
  `legacyModelProviderSerialized.ts`，Shared 公共出口与旧公共类型测试均删除；Legacy reader/importer 仍保持
  单向迁移能力；
- `zcodeDraftThoughtLevelSync.ts`、`modelInputPresentation.ts`、`OffPeakToolbarSelect.tsx` 以及 Todo 13 一并证明
  无调用方的旧模型偏好、Snapshot、Runtime Catalog helper 已删除；
- Feature Graph 中 `ModelConnectionPort`、`ModelRef`、`AiSdkModelRegistry` 和旧 capability seed 已替换为当前
  Registry/ModelFactory/Active Model 入口；
- `dep:refs` 证明 Legacy DTO 只剩 importer 私有消费者；`knip` 未再报告本 Todo 目标文件，仓库其他既有
  unused baseline 不纳入本 Todo 扩张范围。

相关 Core、Bootstrap、Services、Shared、UI 与 Desktop 专项测试、TypeScript 和仓库门禁结果记录在本 Todo
所在提交中。
