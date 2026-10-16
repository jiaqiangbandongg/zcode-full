# 模型选择如何进入一次执行

输入框中的模型选择表达下一次提交的用户意图。消息提交后，这份选择随 Submission 固定下来；Submission 开始执行时，Session 记录后续延续使用的 Selection，Agent Loop 创建并持有真正发起请求的 Model。

```text
Composer Selection
        |
        | submit
        v
Submission ModelSelection
        |
        | start Agent Loop
        v
Session Selection
        |
        | ModelFactory（Registry lookup / validate）
        v
Active Model
```

这条链路把“下一次想用什么”和“当前正在用什么”分开。模型选择器始终服务下一次提交，运行中的模型由独立执行状态表达。

## 一条消息的正常路径

假设 Session 上一次使用模型 A，用户在输入框中选择模型 B，然后发送消息：

```text
Session Selection = A
Active Model = A

用户在 Composer 选择 B
        |
        v
提交 prompt + ModelSelection B
        |
        v
Core 接收完整 Submission
        |
        v
启动新的 Agent Loop
├─ Session Selection: A -> B
├─ Registry 根据 B 创建 Model B
└─ Active Model = B
        |
        v
本 Loop 的模型请求使用 Model B
```

Provider Config 或 Registry 在 Loop 运行期间发生变化，不修改已经创建的 Model。下一次创建 Model 时重新读取当前 Registry，因此新的配置从下一段执行生效。

## 三个核心状态

| 状态               | 表达的含义                   | 所有者            | 生命周期                              |
| ------------------ | ---------------------------- | ----------------- | ------------------------------------- |
| Composer Selection | 下一次提交想使用哪个模型     | Entry 的 Composer | 提交前可编辑                          |
| Session Selection  | Session 后续执行延续哪个模型 | Session Store     | 提交开始执行或 Guide 被接收时更新     |
| Active Model       | 当前 Loop 真正调用的模型     | Agent Loop        | Loop 内持有；Guide 可在 Step 边界切换 |

Draft 是 Composer 状态的持久化载体。Workspace App Recent 和 Host `preferredSelection` 只负责为 Composer
提供初始 Selection，不参与当前模型请求；`preferredSelection` 已经包含 Host 对 Configured Default 与
Fallback Policy 的原子解析。

```text
Draft / workspace Recent / Host preferred
                 |
                 | initialize
                 v
        Composer Selection
                 |
                 | submit
                 v
       Submission Selection
                 |
                 | accepted for execution
                 v
         Session Selection
                 |
                 | create
                 v
            Active Model
```

各状态的持久化范围和 App、TUI、Prompt CLI 初始化规则见 [`selection-state.md`](./selection-state.md)。

## 接收方式决定更新时间

同一个 Submission 可以立即启动、进入 Queue，或者作为 Guide 进入当前 Loop。Selection 始终属于 Submission；不同接收方式只改变它何时成为 Session 和执行状态。

```text
CoreSubmission B
├─ start now
│  └─ 启动 Loop B，Session Selection 与 Active Model 更新为 B
│
├─ queue
│  └─ 完整保存 B；真正出队启动时再更新 Session 和 Model
│
└─ Guide / 立即
   └─ 当前 Loop 接收后，Session 更新为 B，后续 Model Step 使用 Model B
```

上图描述普通用户 Submission。闲时任务是特殊的 `start-now`：Submission 仍携带一个标准
`ModelSelection`，但执行 context 明确它只作用于本次 Loop。Core 使用同一个 Registry 和 ModelFactory
创建闲时 Model，不写 App Recent，不改 Session Selection，也不进入普通 Queue；Core 忙碌时直接拒绝。

以 App 为例，状态变化如下：

| 事件                                    | App Recent | Session Selection | Active Model                           |
| --------------------------------------- | ---------- | ----------------- | -------------------------------------- |
| Loop A 正在执行，用户在 Composer 选择 B | A          | A                 | A                                      |
| Submission B 被接收并进入 Queue         | B          | A                 | A                                      |
| Queue 中的 B 开始执行                   | B          | B                 | B                                      |
| Guide C 被当前 Loop 接收                | C          | C                 | 当前请求保持原 Model，后续 Step 使用 C |

App Recent 在 App 确认 Submission 被接收为 start-now、queue 或 Guide 时更新。Session Selection 在 Submission 真正启动 Loop，或被当前 Loop 作为 Guide 接收时更新。Prompt CLI 和 TUI 不读写 App Recent。

Queue、Guide 和派生提交的完整时序见 [`submission-delivery.md`](./submission-delivery.md)。

## Composer 的初始选择

新建或恢复 Composer 时，Entry 从自己有权使用的状态取得初始值：

| 场景                    | 初始化顺序                                                              |
| ----------------------- | ----------------------------------------------------------------------- |
| App 新 Session          | Draft → 当前 Host View 中仍可选的 workspace App Recent → Host preferred |
| TUI 新 Session          | Draft → domain preferred                                                |
| App / TUI 恢复 Session  | Draft → Session Selection                                               |
| Prompt CLI 新 Session   | 显式模型参数 → domain preferred                                         |
| Prompt CLI 恢复 Session | 显式模型参数 → Session Selection                                        |

初始化只发生在创建或恢复 Composer 时。Composer 存活期间以正在编辑的内存状态为准；Provider Registry 更新可以把当前选择标记为不可用，但不会静默替换用户尚未提交的选择。

## Queue 与 Guide

Queue item 保存完整 Submission，包括当时已经确定的 ModelSelection。重新排序 Queue 不改变 Selection；点击“立即”也使用 Queue item 自己的 Selection，不读取此刻 Composer 中的值。

Guide 与产品中的“立即”采用同一个 Core 语义。Guide 被接收后，Context 注入、Session Selection 更新和 Active Model 切换形成一次原子变化。已经发出的请求继续由旧 Model 完成；从下一个 Model Step 开始使用新 Model。创建新 Model 或注入失败时，完整 Submission 保留为普通 Queue item。

## Edit、Retry 与运行态展示

Edit 和 Retry 从已有 Submission 派生，缺省继承源 Submission 的 ModelSelection。它们不会读取当前 Composer Selection；未来若产品支持“使用当前模型重试”，需要在新 Submission 中显式携带新的 Selection。

模型选择器继续显示下一次提交的 Selection。当前执行模型、闲时任务模型和 Guide 切换结果属于运行态，可以在执行详情或专门横幅中展示，不回写模型选择器来模拟运行状态。

## 稳定约束

- prompt、attachments、mode 和 ModelSelection 作为一个 Submission 被接收。
- Queue 和 Guide 使用 Submission 中已经固定的 Selection。
- Session 只持久化 ModelSelection，不持久化 Model。
- Usage、Trace 和错误归因读取实际发起请求的 Model。
- Composer Selection、Session Selection 和 Active Model 各有独立写入事件，不互相充当投影。
- 闲时任务仍只携带一个标准 ModelSelection；Request Auth、Ticket、归因信息和 Subagent override
  属于执行 context，见 [`../execution/execution.md`](../execution/execution.md)。它们不会形成第二套
  Execution Model、Selection 或临时 Provider 静态配置。

## 子文档

- [`selection-state.md`](./selection-state.md) 说明 Selection 状态的所有权、内存与持久化载体，以及不同 Entry 的初始化规则。
- [`submission-delivery.md`](./submission-delivery.md) 说明 CoreSubmission、start-now、Queue、Guide、Edit 和 Retry 的接收与状态更新时间。
