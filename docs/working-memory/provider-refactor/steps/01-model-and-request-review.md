# M1 全面复核

> 状态：历史复核快照；当前阶段结论见 [`01-model-and-request.md`](./01-model-and-request.md)
>
> 日期：2026-08-13
>
> 实施目标：[`01-model-and-request.md`](./01-model-and-request.md)
>
> 目标设计：[`../design/model/model.md`](../design/model/model.md)
>
> 实施事实：[`01-model-and-request-implementation-log.md`](./01-model-and-request-implementation-log.md)
>
> 后续裁决：Guide/“立即”已经确定为在当前 Loop 内生效，见 [`../design/interaction/interaction.md`](../design/interaction/interaction.md)。正文保留复核当时的未决状态。
>
> 复核基线：M1 merge commit `84f12ba306`，最新 `staging` `bfc91c54a9`

## 结论

M1 已经建立统一的 `Model` / `ModelRequest` 调用边界，主 Agent、Compact、Subagent、Title、Goal、Memory、模型型工具、Git、workspace generateText 和 Repo Wiki 的生产模型请求均已进入这条链路。生产代码扫描没有发现仍然绕过 Model、直接调用 OpenAI、Anthropic 或其他 Provider SDK 的业务客户端。

这次复核没有发现 P0 问题。这里的 P0 指会导致主模型调用在大范围环境中不可用、数据破坏或丢失、凭据泄露、安全边界失效，或者 Desktop、CLI、Remote 等主要入口同时失效的问题。目前没有相应证据。

最高优先级的问题是 Workflow Child 的生产装配没有携带正式 `modelFactory`。它仍然通过 Core 的兼容工厂创建 Model，破坏了“正式运行统一从 Model Factory 取得不可变 Model”的完成条件。这是一个作用域明确的 P1 收口缺口：可能使 Workflow 在同一 Loop 中受到 Registry 更新影响，但不会让普通 Agent 主链或整个产品不可用。

因此，M1 更准确的状态是：

```text
公共调用边界        已完成
生产调用入口迁移    已完成
普通 Agent 生命周期 已完成
生产装配机械收口    尚有 Workflow 缺口
历史兼容入口退场    尚未完成
```

建议增加一个短周期的 M1.1 收口，不重新打开整个 M1，也不把这些问题混入 M2 Registry 设计。

## 复核范围

本次复核围绕四个问题展开：阶段目标是否完整落地、模型调用是否仍有旁路、迁移是否改变现有功能语义、以及新边界是否真正阻止旧设计继续扩散。

检查覆盖了生产 `AgentRuntime` 的构造位置、`Model` 创建与调用位置、Model Properties 和 Options 的校验、动态 Header 刷新、Guide 的 Loop 内行为、Usage / Trace 归因以及 Repo Wiki 的迁移结果。最新 `staging` 合入的 CLI 变化集中在 Desktop presentation context，没有改变 M1 的 Model、Adapter 或 Workflow 装配结论。

## P1：Workflow Child 没有进入正式 Model Factory

普通 Runtime 的装配链已经明确：

```text
createZCodeApp
    |
    v
Runtime Model Factory
    |
    v
AgentRuntime
    |
    v
Loop 持有不可变 Model
```

Direct Expert Workflow 和 Script Workflow Child 则只向新的 `AgentRuntime` 注入 `modelAdapter`：

```text
父 Agent Runtime
    |
    +-- 普通 Subagent
    |      └─ 继承或取得正式 Model Factory
    |
    +-- Direct Expert Workflow Child
    |      └─ modelAdapter -> Core Compatibility Model
    |
    └-- Script Workflow Child
           └─ modelAdapter -> Core Compatibility Model
```

对应代码位于：

- `apps/zcode-cli/packages/bootstrap/src/app/workflow-facade.ts`
- `apps/zcode-cli/packages/bootstrap/src/app/script-workflow-child-runtime.ts`
- `apps/zcode-cli/packages/core/src/runtime/methods/runtime-model.ts`

兼容 Model 仍然满足 `Model.generateText()` / `streamText()` 的表面接口，所以常规模型调用扫描不会把它识别成旁路；差异发生在 Model 的形成过程。兼容路径使用宽松缺省值，并在 Adapter 调用时重新查询可变 Registry。只要 `providerId/modelId` 没变，API Key、Endpoint 或物理 Provider 对象的更新就可能影响正在运行的 Workflow Loop。

这与 M1 的生命周期目标不一致：

```text
预期
Loop 开始 -> 创建 Model A -> 所有 Step 使用 A -> Loop 结束

Workflow 当前风险
Loop 开始 -> Compatibility Model
          -> Step 1 查询 Registry A
          -> Registry 更新
          -> Step 2 查询 Registry B
```

需要让两类 Workflow Child 显式取得正式 Model Factory。测试应覆盖 Registry 在 Child Loop 运行期间变化时，模型身份、连接和绑定 Options 都保持稳定；Child 显式选择另一模型时，则从正式工厂创建新的 Model。

## P1：Property 的“未知”可能被解释为“不支持”

M1 让 Model 在请求发出前统一校验图片、PDF、Tool Call 和 Structured Output。这一边界本身成立，但当前 Catalog 合并结果使用布尔值表达能力，部分未知事实会被填成 `false`。一旦这个值进入 Model Properties，请求就会被硬拒绝。

```text
Catalog 没有明确事实
        |
        v
合并结果填入 false
        |
        v
Model Property = false
        |
        v
请求在 Adapter 之前被拒绝
```

风险最明显的场景是未被 Catalog 收录、但实际支持图片或 PDF 的自定义模型。旧链路可能把请求交给 Provider，新链路可能依据缺省 `false` 提前拒绝。Structured Output 也存在同样的建模问题；当前真正发送 JSON Schema 的 Memory Selector 位于默认关闭的 Semantic Recall 分支，因此它暂时不是线上 P0，但未来开启该分支前必须处理。

Tool Call 的默认值当前为 `true`，没有同样的缺省回归；显式配置为 `false` 时，Coding Agent 请求工具被拒绝符合声明语义。

这里不适合简单删除统一校验。需要为每项 Property 分别确认事实来源和未知状态策略：哪些能力是进入 Registry 的硬前提，哪些可以在缺少事实时继续尝试，哪些需要三态表达。完成这项裁决前，不应继续增加新的硬校验字段。

## P2：Guide 的模型语义已经发生变化，但产品语义仍未裁决

M1 固定了 Agent Loop 的 Model。Guide 则会在当前 Loop 中内联一条用户输入，不开启新 Loop。用户在发送 Guide 前选择模型 B 时，Session Selection 可以更新为 B，但当前 Loop 仍然持有 A：

```text
Turn 开始，绑定 Model A
        |
        v
用户在 Composer 选择 Model B
        |
        v
Guide 内联当前 Turn
        |
        +-- 当前 Turn 继续使用 A
        |
        └-- 下一次新 Turn 使用 B
```

这符合“一个 Loop 内模型身份稳定”的 M1 规则，却可能不符合 Guide/“立即”的产品心智。如果产品最终要求 Guide 立即换模，就需要把它定义为当前 Loop 内一次显式的 Model 切换边界，同时更新当前执行的 Selection、Model、Usage 和“已切换模型”消息。该决定属于 Submission / Guide 专题；M1 不应通过恢复逐 Step 读取 Session 默认模型来解决。

它目前是局部、可预期的行为差异，不是 P0。

## P2：动态 Header 刷新仍会重新取得完整 Provider 对象

Start Plan 等 Provider 需要在每个物理请求前刷新一次性 Header。当前 Adapter 在刷新后重新从 Registry resolve 同一个 `providerId/modelId`，并只检查模型身份没有改变：

```text
已绑定 Model A
    |
    v
刷新一次性 Header
    |
    v
重新 resolve providerId/modelId
    |
    +-- 身份相同：接受新的 Resolved Model
    └-- 身份不同：报错
```

这样可以保持现有 Plan 行为，但刷新范围比“只更新动态认证材料”更大。同一模型的 Endpoint、API Key 或 Provider 实例也可能随 Registry 更新进入当前 Loop。它延续了旧 Plan 链路的行为，并非 M1 新引入的普遍回归；从目标架构看，它仍然削弱了 Model 不可变性。

后续重构 Builtin Provider / Adapter 时，应把动态认证材料刷新与完整 Model/Connection 重新解析分开。当前阶段不适合顺手改变 Plan 的认证协议。

## P2：兼容入口仍然过于容易进入

Core 当前接受 `modelFactory` 或 `modelAdapter`，缺少 Factory 时自动进入兼容 Model。该设计保证旧测试和嵌入调用继续运行，也使生产 Workflow 的装配遗漏无法被类型系统或启动检查发现。

此外，少量 Core 能力仍以 `modelAdapter` 是否存在作为可用性判断，`AgentRuntimeDeps` 也保留 `modelConnectionPort`、Runtime limits 和 Provider Options 等迁移字段。当前正式 Runtime 同时拥有 Adapter 与 Factory，所以这些残留没有造成主链功能故障；它们会妨碍 M2 之后建立只依赖 Model 来源的 Runtime。

M1.1 应将生产装配与兼容装配分开：生产可执行 Runtime 必须提供正式 Model Factory；真正的 state-only Runtime 和测试兼容对象使用显式命名的构造路径。兼容入口保留多久可以另定，但不能再由缺少一个可选字段隐式触发。

## 已确认没有形成旁路的部分

Repo Wiki 已删除自己的 Provider 客户端，通过 `workspace/generateText` 使用 CLI 内的 Model。截断恢复仍属于 Repo Wiki 业务策略，Model 只返回 `finishReason` 和 Usage。旧 app-server 缺少 `finishReason` 时明确失败，是已确认的兼容边界，不是本次复核新发现的回归。

主 Agent、普通 Subagent、Automatic / Micro / Reactive Compact、Title、Goal verifier、Project Memory、WebFetch / WebSearch、Git Commit Message 和 workspace generateText 都通过 Model 发起请求。Provider-specific reasoning 参数仍由 Adapter 路径转换，没有重新暴露给业务调用方。

Usage、Trace 和消息持久化已经使用实际执行 Model 归因。当前扫描没有发现请求完成后再读取 Composer 或可变 Session 默认模型来记录 Usage 的生产路径。

## P0 判断及置信边界

目前没有确认的 P0。已发现的问题都有明确作用域：Workflow 装配只影响 Workflow Child；Property 缺省主要影响部分自定义多模态模型和默认关闭的 Semantic Recall；Guide 只影响当前 Turn 内联输入；动态 Header 风险只存在于需要请求前刷新认证材料的 Provider。

这不是“已经证明不存在任何 P0”。判断依据来自静态生产调用扫描、构造链检查、M1 合入前后的全量与重点测试记录，以及最新 staging 的增量复核。当前环境此前有少量测试因磁盘空间不足无法重跑，仓库也存在与 Provider 无关的既有失败，因此仍需通过 Workflow 与自定义多模态模型的定向测试提高置信度。

如果把严重度按当前证据排列：

| 等级 | 结论 | 影响 |
| --- | --- | --- |
| P0 | 未发现 | 没有大范围不可用、数据破坏或安全事故证据 |
| P1 | Workflow Child 未使用正式 Factory | 可能在同一 Workflow Loop 中混入更新后的连接或配置 |
| P1 | 未知 Property 被硬化为 `false` | 可能拒绝实际可工作的自定义图片/PDF模型 |
| P2 | Guide 继续使用当前 Loop Model | 产品语义未裁决，影响局部交互 |
| P2 | 动态 Header 刷新重取完整 Provider | 继承风险，影响特殊 Plan Provider 的不可变性 |
| P2 | 兼容入口与旧依赖仍可进入生产装配 | 收口不彻底，增加后续迁移风险 |

## 建议的 M1.1 收口顺序

第一步修复 Workflow Child 的正式 Model Factory 装配，并建立生命周期测试。这是唯一已经确认进入生产功能的结构性缺口。

第二步逐项定义 Property 的未知状态策略，优先验证自定义图片/PDF模型；Semantic Recall 保持关闭，直到 Structured Output 的策略有测试保护。

第三步把生产 Runtime 对 Model Factory 的要求变成机械约束，让兼容工厂只服务显式兼容场景。随后删除 Core 中以旧 Adapter 存在性判断模型能力的残留。

Guide 和动态 Plan Header 分别留给 Submission 与 Builtin Provider 专题。它们需要明确产品/协议语义，不与 Workflow 收口混做。

M1.1 完成条件为：

- 所有会执行模型请求的生产 `AgentRuntime` 都显式取得正式 Model Factory。
- Workflow Child 在 Registry 更新期间继续使用创建时的 Model 事实和连接。
- 自定义模型的图片、PDF 和 Structured Output 不会因为“缺少事实”被误判为“不支持”。
- 兼容 Model 的进入条件在代码中显式可见，并有测试证明正式装配不会落入该路径。
- Guide 与动态 Header 的未决语义继续保留在对应后续专题，不以临时兜底改变行为。
