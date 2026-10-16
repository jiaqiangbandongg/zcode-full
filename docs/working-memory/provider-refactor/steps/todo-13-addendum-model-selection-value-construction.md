# Todo 13 补充裁决：ModelSelection 值构造与 Option 缺省语义

> 状态：已吸收并完成
>
> 日期：2026-08-25
>
> 关联任务：[`todo-13-target-host-model-selection-authority.md`](./todo-13-target-host-model-selection-authority.md)

本文独立保留 Todo 13 讨论后的补充裁决；其稀疏值构造与 Select/Submission 两阶段语义已经吸收到 Todo 13
正式实现和 Design 中。

## 1. 核心结论

`ModelSelection` 是一个不可变的选择值，不是一个在原对象上持续 patch Provider、Model 和 Options 的可变
容器。

```ts
interface ModelSelection {
  providerId: ProviderId;
  modelId: ModelId;
  options?: {
    reasoningLevel?: string;
    maxOutputTokens?: number;
  };
}
```

模型身份切换或 Option 调整完成后，发起方提交的都是一份新的完整 `ModelSelection` 值。Registry 和
ModelFactory 消费该值，但不负责把旧 Selection 改造成新 Selection。

术语应当区分：

- `ModelSelection`：包含 `providerId`、`modelId` 和可选 `options` 的完整选择值；
- `ModelSelection.options`：Selection 内部只保存显式 option 覆盖的稀疏子结构；
- 不使用“重新构造一个 Model Selection Option”指代整体切换，应称为“重新构造一个
  `ModelSelection`”。

## 2. 模型身份切换由发起方重新构造 Selection

从模型 A 切换到模型 B，不是在旧 Selection 上覆盖 `providerId/modelId`，也不需要公共层设计一套“清空、
迁移或兼容旧 options”的算法。

```text
旧 ModelSelection A
|- providerId: provider-a
|- modelId: model-a
`- options: A 的显式意图

用户选择目标模型 B
        |
        v
切换方依据目标候选和本次用户意图重新构造
        |
        v
新 ModelSelection B
|- providerId: provider-b
|- modelId: model-b
`- options: 只包含这次明确指定给 B 的值
```

推荐语义：

```ts
const nextSelection: ModelSelection = {
  providerId: target.providerId,
  modelId: target.modelId,
};
```

禁止把展开旧对象作为通用切换机制：

```ts
const nextSelection = {
  ...previousSelection,
  providerId: target.providerId,
  modelId: target.modelId,
};
```

后者会把源模型的显式 options 偶然带入目标模型，使切换行为依赖旧对象形状。即使两个模型当前恰好支持同名
option，也不能由公共层推断用户希望继承；如果某个具体交互以后要支持“带着某项设置切换”，应由该交互明确
构造目标 Selection，并单独留下产品契约。

## 3. 同一模型的 Option 调整仍然产生新值

只修改当前模型的 reasoning 等 option 时，模型身份不变，但结果仍是一份新的 `ModelSelection`：

```ts
const nextSelection: ModelSelection = {
  providerId: current.providerId,
  modelId: current.modelId,
  options: {
    reasoningLevel: "high",
  },
};
```

同一模型的 Option 编辑器可以有意识地保留该 Selection 中其他仍然有效的显式叶子；这是编辑同一个选择意图，
不同于跨模型时自动迁移源模型 options。无论哪种情况，最终都提交新值，不要求 Registry、ModelFactory 或
Session owner 原地修改 Selection。

## 4. Options 只保存显式意图

`ModelSelection.options` 是稀疏结构：

- 没有显式指定的叶子不写入 Selection；
- `options: {}` 应归一化为整个 `options` 字段缺失；
- 正式 Selection 不保存 `null`；patch API 可以用 `null` 表达清除，但落盘结果删除相应叶子；
- 用户明确选择一个恰好等于当前默认值的值，仍然属于显式 pin，应当保存；
- UI 仅仅展示当前默认值，不构成显式赋值。

```text
新 ModelSelection（显式 options）
        |
        | + 当前 Model Config Option Spec 默认值
        v
Target Worker ModelFactory
        |
        v
Active Model.options（完整且不可变）
```

ModelFactory 解析出的默认值只进入 Active Model，不反写 Draft、App Recent、Session Selection 或其他产品
record。

## 5. maxOutputTokens 的当前边界

`maxOutputTokens` 合理地属于通用 `ModelSelection.options` 契约，但当前模型选择接口不会有意为它赋值。因此
本轮正常行为就是保持该叶子缺省，由 ModelFactory 使用 Model Config 中的默认值。

这意味着当前不需要：

- 为模型切换设计 `maxOutputTokens` 的继承或清空策略；
- 为了形成“完整 Selection”而把默认 `maxOutputTokens` 写回 Selection；
- 在当前没有对应显式交互的 UI、RPC 或 repository 中主动补这个字段。

未来如果某个产品真正开放 `maxOutputTokens` 编辑，需要先明确交互、持久化和继承语义；届时调用方把用户
显式选择写入新 Selection，不改变本文的通用边界。

## 6. 实施与审阅检查点

1. 模型切换调用方根据目标候选重新构造 `ModelSelection`，不展开旧 Selection 覆盖身份；
2. Registry/ModelFactory 不提供跨模型 Options 迁移、清空或猜测 helper；
3. 当前没有显式 `maxOutputTokens` 输入的路径保持字段缺失；
4. ModelFactory 对缺省叶子应用 Model Config 默认值，并只把完整结果固定进 Active Model；
5. Session restore、RPC round-trip、UI 展示和 repository 保存不得把 Effective Options 反写 Selection；
6. 测试分别证明跨模型新建 Selection、同模型显式 Option 编辑，以及缺省 `maxOutputTokens` 不被物化。

## 7. 非目标

- 不新增另一套 Selection Builder 领域服务；普通调用方可以使用小型纯函数减少重复，但函数不拥有状态或默认值；
- 不把 `ModelSelection` 改成可变 class；
- 不改变 Model Config Option Specs、ModelFactory 校验或 Active Model 生命周期；
- 不为当前未开放的 `maxOutputTokens` 增加设置页面或产品入口；
- 不把 Select 阶段和 Submission 阶段实现成两套模型身份或 Options Schema。

## 8. Select 与 Submission 两阶段

所有会引用模型的产品状态按现有行为归入两种阶段，不再为 Automation、Repo Wiki、Bot、Off-Peak、Subagent
和 Sidecar 分别发明模型生命周期：

```text
Select
|- 用户偏好、草稿或可复用产品配置
|- modelSelection 可以缺失
|- 缺失表示按该产品既定来源取得首选模型
`- 可以反复编辑，不代表一次工作已经提交
        |
        | 产品触发执行
        | 解析出具体 provider/model
        v
Submission
|- 必须携带确定的 ModelSelection
|- options 仍然只保存显式覆盖
|- 进入 Queue、等待、远程传输或重试后不重新读取首选模型
`- 最终交给 Target Worker Registry / ModelFactory
        |
        | Model Config 默认值只在创建时补齐
        v
Active Model
`- 完整、不可变的本次执行事实
```

这里的 Select 是产品状态阶段，不新增名为 `ModelSelect` 的领域类型。Select 和 Submission 中引用模型时都
使用同一个 `ModelSelection` Schema；差异只在外层状态是否允许缺失以及何时固定模型身份。

### 8.1 阶段切换规则

判断依据不是产品名称，而是对象当前表达什么：

- 草稿、用户偏好和可复用配置属于 Select；
- 已经被系统接受、将要执行的一次工作属于 Submission；
- Select 中缺少 `modelSelection` 时，在产品触发执行、形成 Submission 的边界解析首选模型；
- Submission 一旦被接受，后续 Queue、等待、取票、远程传输、恢复和 Retry 都使用其中已经确定的 Selection；
- 等待期间即使 Host preferred、Provider Config 或模型可见性发生变化，也不静默重选；Target Worker 在实际
  构建 Model 时按当前 Registry 校验，失败就明确失败；
- “确定的 Selection”只要求 `providerId/modelId` 已确定，不能借此把 Option Spec 默认值物化进
  `ModelSelection.options`。

```text
Select.modelSelection 缺失
        |
        | 读取触发时的既定首选来源
        v
Submission.modelSelection
|- providerId/modelId：确定
`- options：仍然稀疏
        |
        | 等待 / Queue / Retry
        `----------------------> 不重新 Select
```

Edit、Retry 等操作如果产生一份新的 Submission，可以按该产品既有语义从源 Submission 继承 Selection；这
是在创建新 Submission 时显式构造新值，不是让旧 Submission 在执行前重新读取默认模型。

### 8.2 现有产品归类

| 产品/场景        | Select 阶段                                       | 形成 Submission 的边界                     |
| ---------------- | ------------------------------------------------- | ------------------------------------------ |
| 普通会话         | Composer / Draft                                  | 用户发送并被系统接受                       |
| Automation       | Automation record 中的可选模型偏好                | 每次定时触发                               |
| Repo Wiki        | 生成页面或保存配置中的模型选择                    | 用户点击生成                               |
| Bot              | Bot 配置中的模型偏好                              | 收到消息并创建一次任务                     |
| Subagent         | Profile 中的可选 model override                   | 创建 Child Agent                           |
| Off-Peak         | 创建页面中的模型选择                              | 用户提交闲时任务并被系统接受               |
| Title/Memory/Git | 通常没有独立长期 Select，从当前调用上下文取得意图 | 每次 Sidecar 调用形成自己的执行 Submission |

Automation record 是可复用 Select。它保持“跟随 Workspace”时不保存 `modelSelection`；每次定时触发都读取
当时的 Host preferred，形成该次确定的 Submission。Host preferred 后续再次改变，不影响已经形成的那次
Submission。

Off-Peak 在用户确认创建闲时任务并被系统接受时形成 Submission，因此 Selection 在该边界固定。后续等待、
取票和派发只执行这份 Submission，不重新读取 Host preferred。

Subagent Profile 没有 override 时，创建 Child Submission 的边界从 Parent Active Model 取得模型身份；形成
Child Submission 后同样不再跟随父级后来发生的模型变化。

### 8.3 实施检查点

1. 每个产品明确自己的 Select owner 和形成 Submission 的现有事件，不新增共享可变 Select Store；
2. Select 可以缺少 `modelSelection`，Submission 不允许缺少具体 provider/model；
3. 解析首选模型只发生在 Select 转 Submission 的边界；调度器、Queue consumer 和 Retry runner 不再次解析；
4. Submission 持久化、协议和远程传输完整保留稀疏结构化 `ModelSelection`；
5. Registry 更新只可能让已有 Submission 在 ModelFactory 处明确失败，不触发静默 fallback；
6. 测试至少覆盖“首选模型在 Submission 形成前变化”和“形成后变化”两种时序，证明固定边界正确。
