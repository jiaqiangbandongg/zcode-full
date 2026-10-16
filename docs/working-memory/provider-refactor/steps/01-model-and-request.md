# M1：Model 与 ModelRequest 实施

> 状态：已完成并合入 staging
>
> 完成日期：2026-08-12
>
> MR：!2006

目标设计见 [`../design/model/model.md`](../design/model/model.md)。本篇只记录 M1 的实施范围、实际结果和遗留问题。

## 实施目标

M1 统一“模型如何被调用”。此前主 Agent、Compact、Repo Wiki 和其他辅助任务分别读取 Runtime model ref、capability、provider options、API Key 或 Adapter Registry，模型身份、请求参数和 Usage 归因可能来自不同状态。

阶段目标是让所有生产模型请求经过同一个公共边界：

```text
现有 Config / Registry / Runtime / Plan 输入
                    |
                    | 唯一兼容装配入口
                    v
                  Model
                    |
                    v
              ModelRequest
                    |
                    v
            现有 Provider Adapter
```

M1 不重构最终 Provider Registry。旧输入允许在唯一兼容入口中继续存在；Model 后面的业务调用方不得理解旧 Runtime 和 Registry。

## 计划切片

```text
M1.1  公共类型、Model Adapter Wrapper 与单元测试
M1.2  主 Agent Loop、Automatic Compact、Usage 与 Trace
M1.3  Child Agent、Title、Goal verifier 与 Project Memory
M1.4  Git、workspace/generateText、WebFetch / WebSearch
M1.5  Repo Wiki
M1.6  删除调用方的旧 ModelPort、Runtime 与 Registry 读取
```

阶段完成判据按整个 M1 计算。实现可以分批提交，但不能因为部分调用方已经迁移而长期保留平行模型客户端。

## 实际结果

M1 已将所有已知生产模型调用收敛到 `Model.generateText()` 或 `Model.streamText()`，包括 Repo Wiki 原有的独立 Provider 请求链。

Agent Loop 在开始时取得 Model，并在连续执行期间保持引用。普通 Step、Automatic Compact 和 Child Agent 不再通过可变 Runtime 决定后续请求的模型身份。Usage、Trace 和消息归因使用实际 Model。

公开 ModelRequest 不再携带 model、Provider connection 或任意 provider options。Properties、Option Specs 和 Options 在统一入口处理；Provider-specific reasoning 转换仍由现有 Adapter 路径承担。

M1 按当时输入结构保留 `ModelDescriptor`。新的 Registry 设计会用 ProviderConfig 与 ModelConfig 提供静态查看数据，不改变已经完成的 Model 调用边界。

完整实施事实和自主决策见 [`01-model-and-request-implementation-log.md`](./01-model-and-request-implementation-log.md)。

## 实施中扩展的范围

Repo Wiki 迁移时确认其截断恢复属于 Wiki 业务策略，应继续保留在统一 Model 之上。旧 app-server 的最小 Model Adapter 注入也保留了明确兼容边界。

输出预算的责任在实施中进一步明确：Model 严格校验调用方输入；Compact、Memory 等任务如果需要较小预算，由任务自己计算，不在 Model 内静默 clamp。

这些决策没有改变 M1 目标，但超出了最初类型定义的细节，均记录在 implementation log。

## 合入后复核

复核未发现 P0，确认 Model 与 ModelRequest 主边界已经成立，同时发现以下收口项：

- Workflow Child 尚未使用正式 Model Factory。
- 部分 Property 的未知状态可能被硬化为“不支持”。
- Guide 的模型切换行为在复核时尚未裁决，随后已经确定为在当前 Loop 内从下一 Model Step 生效。
- 动态 Header 刷新仍会重新取得完整 Provider 对象。
- 兼容入口仍然比最终目标更容易被新代码使用。

详细证据和优先级见 [`01-model-and-request-review.md`](./01-model-and-request-review.md)。其中与 Model 来源有关的问题由 M2 的 Registry 和 ModelFactory 设计继续收敛。

Guide/“立即”的目标时序见 [`../design/interaction/interaction.md`](../design/interaction/interaction.md)；Review 中的“未裁决”保留为当时的历史事实。

## 完成判断

M1 已完成。它交付的稳定边界是：

```text
业务模型调用
└─ Model.generateText() / streamText()

单次调用输入
└─ ModelRequest

连续执行模型身份
└─ Agent Loop 持有的不可变 Model
```

M2 替换 Model 的创建来源，不回退这条公共调用链。
