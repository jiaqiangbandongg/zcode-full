# 05 ModelRef 退役

> 状态：已完成
>
> 已确认边界：`ModelSelection` 保存已经接受的选择意图，不能一般性地从包含默认值的 `Model.options`
> 反向重建；不建立统一的 Selection/Target 比较 helper，各消费者按自己的业务语义显式比较；Telemetry
> 本轮只做类型脱钩，不重构其总体设计。
>
> 日期：2026-08-24
>
> 总路线图：[`todo-00-model-abstraction-unification-roadmap.md`](./todo-00-model-abstraction-unification-roadmap.md)
>
> 已完成前置任务：[`todo-01-core-model-adapter-boundary-cleanup.md`](./todo-01-core-model-adapter-boundary-cleanup.md)
>
> 关联但不阻塞本任务：[`todo-04-core-model-connection-port-retirement.md`](./todo-04-core-model-connection-port-retirement.md)

## 0. 实际交付

- `ModelSelection` 已收口到 `@zcode/shared`，作为跨进程选择意图的唯一严格契约；
- 当前执行统一持有 `Model`，Core、Compact、Memory、Subagent 和 Adapter 不再接收公共 `ModelRef`；
- `ModelRef`、`ZCodeModelRef`、`variant` reasoning identity、parse/format/equality helper 及同形公共 alias 已删除；
- Result、Stream、Session persistence 与 Telemetry 按各自语义保存 Selection 或明确的 provider/model 字段，
  不再共享一份伪身份对象；
- Bot、TUI、Protocol、CLI admission、历史 hydration 和 SQLite codec 已切到标准 `ModelSelection`；只有明确的
  已发布历史字段在 migration/codec 边界读取，当前写入不再产生旧形态。

## 1. 任务目标

删除同时承担 Selection、执行身份、reasoning variant、请求归属和结果归属的旧 `ModelRef`。每个调用点按
真实语义改用已有抽象或删除冗余字段，不新增通用 `ModelIdentity`。

```text
当前 ModelRef
├─ providerId
├─ modelId
└─ variant?
   |
   +--> runtime selection
   +--> adapter resolution
   +--> request / result / stream event
   +--> session event / persistence
   `--> network status / telemetry

目标

未来选择意图 ----------------> ModelSelection
当前执行 --------------------> Model
调用方已知当前 Model 的结果 ---> 删除重复 model 字段
需要继续执行的持久化状态 -----> ModelSelection
现有观测 --------------------> 在产生点从 Model 取 providerId/modelId
legacy input -----------------> importer 边界一次转换
```

## 2. 为什么不保留 ModelRef

当前 `variant` 实际重复 `ModelSelection.options.reasoningLevel`，而 `formatModelRef()` 和
`modelRefsEqual()` 又忽略 `variant`。这说明它既不是严格身份，也不是完整选择。

静态扫描显示 `ModelRef` 仍出现在约 50 个非测试生产文件，覆盖 Contracts、Core、Bootstrap、Adapter、
Session event、persistence 和 telemetry。不能全局替换成另一个同形 interface；必须逐消费者回答“这是未来
选择、当前对象、历史事实，还是根本冗余”。

## 3. 核心裁决

### 3.1 本轮不建立 ModelIdentity

- 进程内当前执行直接使用 `Model`；
- 需要以后重新创建模型的状态使用 `ModelSelection`；
- 结果由调用它的 Model 自然归属时删除重复 identity；
- 观测产生点可从 Model 扁平读取 providerId/modelId，保持现有 payload；
- 只有未来出现多个独立领域反复需要同一可序列化、无 options 的身份值时，才另行证明并设计 Identity。

### 3.2 Reasoning 离开 Identity

`variant` 退出：

- 用户/产品选择进入 `ModelSelection.options.reasoningLevel`；
- 已绑定执行值进入 `Model.options.reasoningLevel`；
- Provider wire 参数由 Model Config `reasoningMapping` 产生；
- 如现有 Telemetry 记录请求/映射值，继续放在其现有请求观测字段，不塞回 identity。

### 3.3 不因序列化需要制造领域类型

某个 event 确实需要 `providerId/modelId` 时，可以在该 event schema 中保留两个明确字段。只有该 event 表达
“后续应按此选择继续执行”时，才保存完整 `ModelSelection`。不要为了少写两个字段引入跨领域 ModelIdentity。

### 3.4 Selection 不从 Effective Model 反推

`Model.options` 是已经绑定的执行值，可能包含 ModelFactory 根据当前 Option Specs 补入的默认值；
`ModelSelection.options` 只表达调用方明确接受并准备持久化的选择意图。系统必须保存原始 Selection，不得把
`modelSelectionFromModel()` 作为通用反向投影，否则当前默认值会被错误固化为用户显式选择，并阻止以后
创建 Model 时继承新的 Config 默认。

Parent、Child、Compact 等消费者需要继承未来选择时，读取其权威 Selection；确实需要继续使用当前已绑定
执行值时，直接传递当前 Model 或在局部执行边界显式处理，不能混成通用 Model -> Selection 转换。

### 3.5 统一 Selection 契约，不统一比较语义

`@zcode/shared` 归属唯一严格的 `ModelSelection` Schema 和跨进程类型：

```ts
{
  providerId: string;
  modelId: string;
  options?: {
    reasoningLevel?: string;
    maxOutputTokens?: number;
  };
}
```

但公共层不提供 `sameModelSelection()`、`sameModelTarget()` 或可配置的通用 equality helper。是否相同是消费者
自己的领域判断，必须在调用点明确表达并通过测试锁定：

- 判断完整选择变化时，比较 `providerId`、`modelId` 及当前全部显式 options；当前即
  `reasoningLevel`、`maxOutputTokens`，其中 reasoning 不同必须判为不同；
- 判断物理模型目标、目录成员或跨模型兼容性时，只比较 `providerId`、`modelId`，忽略 options；
- 旧 `providerId/modelId/variant` 判断迁移后，在原来将 variant 视为变化的消费者中对应比较
  `options.reasoningLevel`；
- 不把某个局部比较函数提升为公共“身份”抽象，也不借格式化字符串完成比较。

目前公共 `modelRefsEqual()` 只比较 `providerId/modelId` 且已经没有静态引用，应直接随 `ModelRef` 删除，不能
改名后保留。

## 4. 消费者迁移分类

### 4.1 Selection 与 Runtime

迁移为 `ModelSelection`：

- Session 默认/当前选择；
- Submission、Guide、Queue item 中的未来执行意图；
- Subagent profile/override；
- 独立模型任务的选择；
- 任何需要 Registry/ModelFactory 重新创建 Model 的输入。

删除裸 model string/defaultProvider fallback。需要判断完整 Selection 变化的消费者必须显式比较 options 的
真实语义，不能复用忽略 reasoning 的 `formatModelRef/modelRefsEqual`，也不能改用新的公共比较 helper。

### 4.2 Core 当前执行

迁移为 `Model`：

- Agent Loop、Compact、Memory、Title、目标验证；
- Tool validation 和请求；
- Subagent child 当前执行；
- Message persistence 需要知道本次实际执行者的产生点。

Core helper 只需要 providerId/modelId 时直接从 Model 读取，不创建 identity DTO。

### 4.3 Adapter

- `createModel()` 接收显式 providerId/modelId 和静态执行事实；
- runner/transform/error helper 若只需模型 ID，接收明确标量或 Adapter 私有已绑定对象；
- 不接受 `ModelRef | string`；
- 删除 Adapter `parseModelRef()`、default provider 和 variant 分支；
- request/result 中重复的 `model: ModelRef` 在内部调用者已经持有 Model 时删除。

Adapter 私有函数接受两个标量并不等于建立新业务 identity 类型。

### 4.4 Result 与 Stream Event

逐字段判断：

- `Model.generateText()` 的 Result 由调用 Model 唯一归属，默认删除重复 `model`；
- `Model.streamText()` 事件同理，默认不在每个 chunk 重复 identity；
- 若一个聚合器确实混合多个并发 Model 流，由聚合边界保存来源，而不是污染所有 Model event；
- Usage、finish reason、content 和 error 保持现有语义。

### 4.5 Session Event 与持久化

按事件目的分类：

1. 表达选择变化：保存 `ModelSelection`，包括有效 options；
2. 表达 assistant message 实际来源：在 message schema 中保留明确 providerId/modelId（若产品需要展示/审计）；
3. 调用方或父事件已唯一确定来源：删除重复字段；
4. legacy 历史数据：只在 hydration/importer 转为上述当前形态。

不能把所有 `modelRef` 一律改成 `modelSelection`，否则会把请求 options 错误持久化为“模型身份”；也不能
一律删除，否则会丢失跨重启需要的选择或消息 provenance。

### 4.6 Network Status 与 Telemetry

本 Todo 不重构 Telemetry。处理限于：

- Adapter 在现有事件产生点从当前 Model/已绑定执行事实填充既有 providerId/modelId；
- 如现有 schema 暂时必须保留同形 `model` 对象，可先定义为该观测 schema 的局部字段结构，不能继续从
  Core 导出/复用 `ModelRef`；
- 不新增 Context、Observation、Identity 层；
- 不改变事件数量、采样、隐私、持久化和上报通道。

这是一项有意的临时边界：公共 `ModelRef` 可以退出，Telemetry 总体设计以后单独处理。

### 4.7 Protocol legacy 边界

若已发布协议或历史文件使用 `modelRef`/字符串：

- 严格 schema 继续识别必要的 legacy version；
- importer/hydrator 立即转换为 ModelSelection 或该事件的明确当前字段；
- 新写入、新命令和领域对象不再产生 ModelRef；
- 兼容代码集中在版本边界并有删除条件，不在 Core/Adapter 普遍双读。

### 4.8 已确认的具体风险点

实施时必须测试先行处理以下两处，不将其原样机械迁移：

1. `createInheritedSubagentModelFactory()` 当前只按 `providerId/modelId` 复用父 Model。若目标 Selection 带有
   不同 options，会错误复用已经绑定的父 Model。目标语义是：继承当前执行事实时直接传递父 Model；存在
   显式新 Selection 时交给 ModelFactory 创建或绑定，不能靠目标 ID 相同决定复用。
2. `SessionPane` 的 custom provider recovery 确认当前只比较 `modelId`。同一 modelId 可以存在于不同
   Provider，必须同时核对 `providerId/modelId` 后才能确认恢复成功。

## 5. 测试先行

### 5.1 Selection

1. providerId/modelId/reasoningLevel/maxOutputTokens 完整 round-trip；
2. 完整 Selection 变化的消费者不会忽略 options，reasoning/max output 不同按既有业务语义判为变化；
3. Queue/Guide/Subagent override 使用各自保存的 Selection；
4. 裸 modelId 不借 default provider 解析；
5. Registry/ModelFactory 创建只接收 ModelSelection/明确输入。
6. 只关心模型目标的兼容性和目录消费者继续忽略 options，不会因 reasoning 变化误判为跨模型。

### 5.2 执行与结果

1. generate/stream 结果在移除 model 字段后仍能正确归因；
2. 并发或嵌套调用不会因删除 chunk identity 混流；
3. Compact/Memory/Subagent 使用实际 Model；
4. reasoning level 从 Selection -> Model.options -> mapping，不经过 variant；
5. 错误和 Usage 保留实际 providerId/modelId 的现有观测。

### 5.3 Session/历史

1. 选择变化事件保存完整 ModelSelection；
2. assistant message provenance 按当前产品 schema 恢复；
3. legacy ModelRef/string 能在唯一 importer 边界恢复；
4. 新写入不产生 `variant` 或 `modelRef`；
5. hydrate -> continue 不改变 Session Selection；
6. desktop continuous 与 mobile replayable 对相同历史事实得到相同投影，但不改变各自恢复语义。

### 5.4 机械归零

- 公共 Contracts 不再导出 `ModelRef`；
- 生产代码无 `variant` 作为 reasoning identity；
- `parseModelRef`、`formatModelRef`、`modelRefsEqual` 删除；
- Adapter/Core 公共接口无 `ModelRef | string`；
- legacy 字面量只存在明确 importer/schema/test fixture；
- 不新增 `ModelIdentity`、同形 alias 或公共 Selection/Target equality helper。

## 6. 实施顺序

### Step A：建立消费者清单

以当前约 50 个生产文件为基线，把每个引用标记为：

- selection；
- active execution；
- redundant result/event；
- persisted provenance；
- telemetry/status；
- legacy importer。

清单必须逐文件有目标形态，不能直接 codemod。

### Step B：先迁移选择与 Adapter

- Runtime/Bootstrap 统一使用 ModelSelection；
- 跨进程 Selection 类型和严格 Schema 收口到 `@zcode/shared`，删除各包的同形公共定义；
- Adapter 接口改为显式已解析输入；
- variant 迁入 options；
- 删除 string/default provider 解析；
- 按消费者原有语义迁移比较，并先修复 Subagent 复用与 custom recovery 漏比较 Provider 的问题。

### Step C：迁移 Result/Event

- 新 Model Result/Event 脱离旧类型 alias；
- 删除调用方已知的重复 model 字段；
- 为真正跨边界的 provenance/selection 定义局部准确 schema。

### Step D：迁移持久化与 legacy importer

- 更新严格 Protocol/schema；
- 集中 legacy 转换；
- 验证历史 hydration、继续执行和 replay projection。

### Step E：删除公共类型并验证

- 删除 ModelRef、variant 和 parse/format/equality helper；
- 运行 Contracts、Core、Bootstrap、Adapter 单测；
- 运行 session hydration/replay 代表回归；
- 运行 `pnpm typecheck`、`pnpm lint`、`pnpm fmt:check`；
- 独立 Conventional Commit。

## 7. 完成定义

系统用 `ModelSelection` 表达未来选择，用 `Model` 表达当前执行。Result/Event 不重复携带调用方已经知道的
身份；需要持久化的选择和 provenance 使用各自准确 schema；Telemetry 只做最小类型适配。公共
`ModelRef`、`variant` 和同形替代类型全部退出；系统不存在统一模型相等性 helper，每个消费者显式表达并
测试自己的比较字段。
