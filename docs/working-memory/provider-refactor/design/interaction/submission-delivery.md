# Submission 接收与投递

CoreSubmission 固定一次输入的完整意图：

```ts
interface CoreSubmission {
  prompt: string;
  modelSelection: ModelSelection;
  attachments?: readonly SubmissionAttachment[];
  mode?: AgentMode;
}
```

特殊执行可以携带额外的 execution context，但不会改变 prompt、attachments、mode 和唯一一份
ModelSelection 必须原子接收的原则。闲时任务的 Request Auth、Ticket、归因信息和 Subagent override
由执行设计定义；它们不会形成第二套 Selection，Submission 也不携带完整 ProviderConfig 或
ModelConfig。

## Start now

Core 空闲时，Submission 直接启动新的 Agent Loop：

```text
Submission B accepted
        |
        +-- Session Selection = B
        +-- Registry 创建 Model B
        `-- 启动 Agent Loop B
```

如果 Model 无法创建，Submission 不会只更新 Session Selection。创建和启动成功后再提交对应状态变化。

### 特殊 start-now：闲时任务

闲时 Submission 同样携带标准 ModelSelection，但 execution context 将它标记为只作用于当前 Loop：

```text
Idle Submission accepted while Core is idle
        |
        +-- App Recent：不变
        +-- Session Selection：不变
        +-- Registry 创建闲时 Model
        +-- Request Auth 在请求期注入
        `-- 启动闲时 Agent Loop
```

这不是临时 Provider，也不是第二套 ModelFactory。Core 忙碌时闲时 Submission 直接拒绝，不进入普通
Queue；它结束后也不需要“恢复”Session Selection，因为执行前从未改写该状态。

## Queue

### Todo151：提交字段保真

CLI 的 `TurnInputIntentMetadata -> QueueItem -> TurnInputIntentMetadata` 必须保留模型选择、权限、
附件／共享上下文和来源关联。QueueItem 是协议投影，同时被提升执行路径读取，不能把字段遗漏
当成纯展示问题。原位编辑只改正文；重排不改内容；自动／手动提升保留原 sourceCommandId。
兼容旧事件时可保留同一项已有字段，不能读取当前 Composer 或可变 Session 补成新选择。
新增 Plan 状态沿同一路径传递，false 与缺失不同。不引入 Host 队列或新的调度／重放语义。

Core 忙碌时，Queue item 保存完整 Submission：

```text
Queued Submission
├─ prompt
├─ attachments
├─ mode
└─ ModelSelection
```

进入 Queue 时，App 可以更新 App Recent；Session Selection 和 Active Model 保持当前执行值。Queue item 真正出队并启动新 Loop 时，再更新 Session Selection 并创建 Model。

Queue 重排不改变任何 Submission 内容。未来若允许编辑排队项的模型，操作需要直接修改该 Queue item 的 ModelSelection，并形成可追溯的显式事件。

## Guide 与“立即”

Guide 是“立即”进入当前 Agent Loop 的 Core 语义：

```text
Active Loop
├─ Session Selection A
└─ Active Model A
          +
Guide Submission B
          |
          | 创建 Model B 并完成 admission
          v
Active Loop
├─ Context 加入 Guide input
├─ Session Selection A -> B
└─ Active Model A -> B
```

Context 注入、Session Selection 更新和 Active Model 切换构成一个接收结果。创建 Model、Context 注入或 admission 失败时，不提交其中一部分；完整 Submission 转入普通 Queue。

已经发出的模型请求继续由 Model A 完成，Usage 归因到 A。切换发生在 Model Step 边界，后续 Step 和后续自动 Compact 使用 Model B。

“立即”可以来自当前 Composer，也可以来自已有 Queue item。两种情况都使用目标 Submission 已经保存的 Selection，不读取点击时 Composer 的当前选择。

## App Recent 与 Session Selection

```text
App 接受 Submission
├─ start-now -> 更新 App Recent
├─ queue     -> 更新 App Recent
└─ Guide     -> 更新 App Recent

Core 开始执行 Submission
├─ start new Loop -> 更新 Session Selection
└─ accept Guide   -> 更新 Session Selection
```

这两个时间点解决不同问题：App Recent 服务下一次新建 App Session；Session Selection 服务当前 Session 的延续执行。排队但尚未执行的 Submission 不提前改变 Session Selection。

## Edit 与 Retry

Edit 和 Retry 以已有 Submission 为来源：

```text
Source Submission
├─ prompt X
└─ ModelSelection A
        |
        ├─ Edit  -> prompt Y + ModelSelection A
        └─ Retry -> prompt X + ModelSelection A
```

缺省继承源 Selection，使操作不受当前 Composer 状态影响。如果产品增加“使用当前选择重试”，该命令应显式提供新的 ModelSelection，并生成新的完整 Submission。

## 接收约束

- Submission 的 Selection 在 Entry 提交时固定。
- start-now、Queue 和 Guide 共用同一个 Submission 类型。
- App Recent 的更新不代表 Submission 已经开始执行。
- Session Selection 的更新必须与执行接收保持一致。
- Active Model 切换不修改旧 Model，也不重新归因已经发出的请求。
- 投递失败时保留完整 Submission，不留下只更新部分状态的中间结果。
- 闲时特殊 start-now 不写 App Recent 或 Session Selection，也不进入普通 Queue。
