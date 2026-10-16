# Todo 38：Project Memory Turn Model 归属与 Off-Peak Extraction 收口

> 状态：已完成
>
> 日期：2026-08-28
>
> 来源：Provider Refactor 后台模型选择 Review
>
> 关联设计：[`Project Memory 模型归属与单轮 Extraction 控制`](../../../design/v2/project-memory-model-selection.md)

## 1. 背景

Project Memory 当前包含三条用途和生命周期不同的模型链路：

```text
当前 Turn 开始
      |
      +--> Semantic Recall
      |
      `--> Main Agent Loop
                 |
                 `--> Turn 成功后自动 Extraction

Dream
`--> 独立后台整理链路
```

它们不能因为都属于 Memory，就共享一套模糊的后台模型选择规则：

- Recall 服务正在执行的 Turn；
- Extraction 由已经完成的 Turn 产生；
- Dream 将来需要独立重构，目前没有开放的产品入口。

Provider Refactor 已确立 Active Model 冻结语义：一个 Turn 一旦创建 Model，后续 Registry、Personal Config 或 Session
Selection 变化不得改写该 Turn 的模型事实。Recall 和 Extraction 应当遵循同一原则，不得在异步工作开始时重新读取可变
Session Selection，也不得从 Registry 自动寻找另一个“更便宜”或“能力更合适”的模型。

Off-Peak 使用 execution-scoped Model 和请求期访问材料。其自动 Turn 完成后不应继续派生 Project Memory Extraction，避免
一次性执行材料被主 Turn 之外的后台请求再次消费。

## 2. 已裁决目标

### 2.1 模型归属

```text
Turn admission
      |
      v
创建本轮 Active Model
      |
      +--> Main Agent Loop
      +--> Semantic Recall
      `--> 成功 Turn 产生的 Extraction Snapshot
```

1. Semantic Recall 使用当前 Turn 的 Active Model；
2. Extraction 使用产生该工作的已完成 Turn Active Model；
3. 两条链路都不重新读取 Session Selection；
4. 两条链路都不重新按 Provider ID、Model ID 或 API Type 推断模型能力；
5. Registry 和 Config 更新只影响后来创建的 Model；
6. 已进入 Extraction Scheduler 的 Snapshot 保持冻结；
7. Dream 本轮不调整，后续单独重构。

### 2.2 单轮跳过 Extraction

在 CLI/Core 既有的单轮执行上下文中增加显式策略：

```ts
modelExecution: {
  selectionScope: "execution";
  memoryExtraction?: "skip";
}
```

这里的“CLI 参数”指 App 经 Protocol 传给 CLI/Core 的执行参数，不是面向终端用户的公开命令行 flag。

该字段语义固定为：

- 只影响携带它的一个成功 Turn；
- 不修改 Session 的 `memory.extractionEnabled`；
- 不写入 Session Selection、消息历史或持久 Config；
- 不影响普通 Turn；
- 不影响前台 Memory 工具调用；
- 不改变失败或取消 Turn 的行为；
- 当前由 Off-Peak 派发显式传入 `"skip"`。

不使用 boolean，避免 `false` 究竟表达“缺省”“允许”还是“覆盖关闭”的歧义；不增加 Session 级第二套 Memory 开关。

### 2.3 Recall 请求 Option

Recall 的模型身份来自当前 Turn Active Model，但单次调用参数可以独立覆盖：

```text
Active Model
    |
    | 身份、Provider、Properties、访问绑定不变
    v
Recall Model Request
    ├─ 继承 Active Model 总输出预算
    `─ reasoningLevel = optionSpecs.reasoningLevel.values[0]
```

reasoning 和 max output 是调用 Option，不是重新选择模型的理由。实现必须通过统一 Model 契约表达，不得在 Recall 业务代码中
拼装 Anthropic、OpenAI 或 OpenAI-compatible 方言参数。

Recall 直接从 Active Model 按强度低到高排列的 `reasoningLevel.values` 中选择首项，
作为当前 `ModelRequest.options.reasoningLevel`，因此不要求模型支持关闭 Reasoning。

如果 Active Model 不支持严格 JSON Schema 输出：

```text
Active Model.supportsJsonSchemaOutput
        |
        +-- true  --> 允许运行 Semantic Recall
        `-- false --> 不运行 Selector，不自动换模型
```

Semantic Recall 当前尚未开放。本轮只实现低成本且不会引入第二套模型事实的部分；完整的默认索引降级在正式开放 Recall 前
处理，不为关闭中的功能扩张新的 Context 装配链路。

## 3. 目标调用链

### 3.1 Off-Peak Extraction Policy

```text
Desktop Off-Peak Host
        |
        | modelExecution.memoryExtraction = "skip"
        v
Protocol V4 Schema
        |
        v
Bootstrap Command Adapter
        |
        v
Core ModelExecutionContext
        |
        v
Turn 成功
        |
        +-- skip --> 不调度 Extraction
        `-- absent -> 按 Session Memory 配置调度
```

每一层都必须原样传递该字段。不能只分别证明 Protocol 接受和 Core 能处理，而缺少中间 DTO 转换的纵向证明。

### 3.2 Extraction Active Model

```text
Main Loop 使用 Active Model
        |
        v
Turn 成功
        |
        | Active Model + 消息边界 + 工具/读取状态
        v
Extraction Snapshot
        |
        +--> running（最多一个）
        `--> latest pending（最多一个）
```

Scheduler 保持既有有界语义，不新增 Model Registry、Model Snapshot DTO 或后台 Selection。Snapshot 直接持有不可变 Model；
如果 Model 将来引入需要显式释放的资源，再单独设计生命周期，当前不提前增加引用计数或 dispose 协议。

### 3.3 Recall Active Model

```text
Turn 创建 Active Model
        |
        +--> Main Loop
        `--> Recall Prefetch
                 |
                 +--> 能力检查
                 +--> 单次请求 Option
                 `--> Invocation Context / Telemetry
```

Invocation Context、Telemetry、Header 刷新和 abort signal 可以为 Recall 单独绑定，但不得借此重新创建或重新选择 Model。

## 4. 实施范围

### 4.1 Spec 与契约

- 更新 Project Memory 模型归属设计；
- 在 Protocol V4 的 `modelExecution` 严格 Schema 中增加 `memoryExtraction?: "skip"`；
- 在 Core `ModelExecutionContext` 使用同名同值字段；
- 保证 Protocol、Bootstrap 和 Core 不建立重命名后的第二套 Policy DTO；
- 明确该参数不是持久配置，也不是普通用户命令行参数。

### 4.2 Off-Peak 调用方

- Desktop Off-Peak 派发显式传入 `memoryExtraction: "skip"`；
- 首跑与续跑使用同一链路；
- 普通模型请求、Automation、用户 start-now 和队列输入不自动携带该字段；
- 不根据固定 Provider ID 或 Model ID 在 Core 内推断 Off-Peak。

### 4.3 Bootstrap 投影

- Bootstrap 将 Protocol payload 中的 `memoryExtraction` 原样投影到 Core；
- 保留既有 `requestAuth` 冻结与 `requestDependencies` 装配；
- 不让该字段进入可持久化 Submission Intent；
- execution-scoped admission 继续要求显式 Model Selection 和 idle/start-now。

### 4.4 Extraction

- 在 Turn 创建并固定 Active Model；
- 成功 Turn 调度 Extraction 时传递该 Model；
- Extraction Snapshot 保存该 Model；
- 执行阶段不调用 `runtime.getSessionModelSelection()` 或 Model Factory；
- `skip` 只包围调度入口，不改变 Scheduler、Drain、Shutdown 或 Session Residency 语义；
- Extraction 的 telemetry、`skipTranscript`、Memory 工具权限和独立 abort signal 保持不变。

### 4.5 Recall

- Recall Prefetch 接收当前 Turn Active Model；
- 不再通过 Session Selection 创建 Recall 专用模型；
- 使用同一 Model 的请求级 `reasoningLevel: values[0]` 选择最低 reasoning 档位；
- 总输出预算继承 Active Model，不在 Core 猜测 Provider fixed-thinking budget；
- 不支持严格结构化输出时直接跳过；
- 不自动从 Registry 寻找替代模型；
- 不打开 Semantic Recall 产品开关。

最低档必须直接取有序公开档位的 `values[0]`；不得扫描 `off`、`nothink` 等名称猜测关闭能力，
也不得为了保留旧行为重新读取 Session Selection。

### 4.6 Dream

- 不修改入口、模型选择、队列、Prompt、工具或持久化；
- 如果共用 helper 需要增加参数，Dream 必须保持原行为；
- 不借本 Todo 清理或重构 Dream。

## 5. 测试计划

坚持测试先行。

### 5.1 Protocol

- `memoryExtraction: "skip"` 可以通过严格 Schema；
- 其他字符串、boolean 和额外字段被拒绝；
- `modelExecution` 继续要求显式 `modelSelection`。

### 5.2 Bootstrap

- execution-scoped payload 转换后保留 `memoryExtraction: "skip"`；
- `requestAuth`、Subagent Policy 和 Selection 不受影响；
- 增加一条 Protocol payload → Core `SendInputOptions` 的纵向断言，防止中间投影漏字段。

### 5.3 Core Extraction

- 携带 skip 的成功 Turn 不创建或调度 Extraction；
- 下一条普通 Turn 仍正常 Extraction，证明不是 Session 级修改；
- 普通 Turn 的 Extraction 复用完成该 Turn 的 Model；
- execution-scoped Selection 不会在 Extraction 时回退 Session 默认模型；
- Registry 更新只影响后来创建的 Model；
- failed/cancelled Turn 保持既有不调度行为；
- Scheduler 的 running + latest pending 有界语义不变。

### 5.4 Recall

- Recall 使用 Main Loop 的同一 Model 身份和冻结事实；
- 总输出预算继承 Active Model，不在 Core 猜测 fixed-thinking budget；
- reasoning 直接使用有序公开档位的 `values[0]`；
- 不支持严格 JSON Schema 时不发 Selector 请求；
- 不隐式创建或选择另一个 Model；
- 默认关闭分支不产生额外模型请求。

### 5.5 回归与机械验证

1. Protocol 定向测试；
2. Bootstrap V4 Command 定向测试；
3. Core Memory Recall、Extraction 和 Model Lifecycle 定向测试；
4. CLI package typecheck；
5. 根 `pnpm typecheck`；
6. 根 `pnpm lint`；
7. 修改文件格式检查与 `git diff --check`。

## 6. 明确不做

- 不新增公开 CLI flag；
- 不新增 Session 级 Memory Policy；
- 不把 Off-Peak 请求期访问材料写入 Config；
- 不新增 Memory 专用 Model Selection；
- 不新增第二个 Registry 或 Model capability DTO；
- 不自动选择便宜模型、隐藏模型或其他 Provider；
- 不以 Provider ID、Model ID、API Type 或字符串正则推断 Memory 行为；
- 不开放 Semantic Recall；
- 不重构 Dream；
- 不改变普通队列、恢复、Desktop continuous 或 Mobile replayable 语义。

## 7. 完成标准

- Off-Peak 的真实 Host → Protocol → Bootstrap → Core 链路能够跳过自动 Extraction；
- 普通 Turn 继续按 Session Memory 配置运行 Extraction；
- skip 不持久化、不污染下一 Turn；
- Extraction 始终使用产生该工作的 Turn Active Model；
- Recall 始终使用当前 Turn Active Model，不隐式换 Provider/Model；
- Recall 请求 Option 通过统一 Model 契约生效，不出现 Provider 方言 hardcode；
- Dream 无行为变化；
- Protocol、Bootstrap 和 Core 都有直接测试，且纵向转换不再存在未覆盖缝隙；
- 定向测试、typecheck、lint、格式与 diff 检查全部通过；
- 完成后补实施记录并提交 Conventional Commit。

## 8. 实施记录（2026-08-28）

- Off-Peak Host 通过 Protocol V4 显式传入 `modelExecution.memoryExtraction: "skip"`，Bootstrap 原样投影到 Core；
- Core 只在携带该字段的成功 Turn 跳过 Extraction，普通 Turn 与后续 Turn 不受影响；
- Extraction Snapshot 直接持有完成该 Turn 的不可变 Active Model，执行阶段不再读取 Session Selection；
- Recall Prefetch 直接使用当前 Turn Active Model，不支持严格结构化输出时不发送 Selector 请求；
- Recall Request 直接使用 Active Model 有序公开档位的 `values[0]` 作为 `reasoningLevel`，
  再使用正常 `reasoningMapping` 解析协议参数；Active Model 绑定状态不变；
- 增加 Protocol、Bootstrap 纵向投影、Core Extraction/Recall、Model 请求边界和 Adapter 协议映射测试；
- Dream 未修改，Semantic Recall 产品开关未打开。
