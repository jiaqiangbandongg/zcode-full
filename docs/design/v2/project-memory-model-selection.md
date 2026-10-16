# Project Memory 模型归属与单轮 Extraction 控制

## 结论

Project Memory 的模型选择遵循因果归属，而不是在后台工作开始时重新读取可变的
Session Selection：

```text
当前 Turn 的 Active Model
        |
        +--> Semantic Recall（功能仍关闭）
        |
        `--> Turn 完成后调度的 Extraction

Dream
`--> 当前没有产品入口，本轮不调整；后续整体重构时单独裁决
```

- Semantic Recall 服务当前 Turn，因此使用当前 Turn 已创建的 Active Model。
- Extraction 由成功 Turn 产生，因此 Snapshot 保存该 Turn 的 Active Model。
- 两条链路都不得在异步边界重新读取 Session Selection 或可变 Registry 来选择模型。
- Model 的身份、Provider、Properties、访问绑定保持冻结；单次 Memory 请求仍可通过
  `ModelRequest.options` 覆盖 `maxOutputTokens`、reasoning 等调用选项。

## Semantic Recall

Semantic Recall 当前保持关闭。本轮只收正模型归属这一项低成本实现，为后续开放清除
Session Selection 重读：

```text
Turn admission
      |
      v
创建本轮 Active Model
      |
      +--> Main Loop
      `--> Recall Selector
             ├─ 继承 Active Model 已装配的总输出预算
             └─ 单次使用最低公开 reasoning 档位（模型声明该 Option 时）
```

Selector 依赖严格 JSON Schema 输出。Active Model 未声明该能力时不得自动从 Registry
寻找另一个模型。完整的 `MEMORY.md` 默认索引降级必须在 Semantic Recall 正式开放前完成；
在功能仍关闭期间不为它新增第二套 Context 装配分支。

Recall 通过请求专用 Option 表达低成本推理：

```ts
model.generateText({
  // ...
  options: {
    reasoningLevel: model.optionSpecs.reasoningLevel?.values[0],
  },
});
```

`reasoningLevel.values` 按强度从低到高排列；Recall 在当前 `ModelRequest` 直接使用首项，并继续走正常
Option Spec Map/Adapter 链路。最低档不要求模型支持关闭 Reasoning。
Recall 不在 Core 猜测 Provider thinking budget；总输出预算继承 Active Model，reasoning 与
max-output 分别通过同一 Option Map 链投影。严格 JSON Schema 继续约束响应形状。

## Extraction

Extraction Scheduler 保持现有有界语义：最多一个 running Snapshot 和一个 latest pending
Snapshot。当前实现已经在 Snapshot 中持有一个调度时创建的 Model；改为保存产生工作的
Turn Active Model 不增加 Model 的滞留数量，也不新增资源生命周期。

```text
成功 Turn
   |
   | Active Model + 消息边界 + 工具/读取状态
   v
Extraction Snapshot
   |
   +--> running（最多一个）
   `--> latest pending（最多一个，覆盖更早 pending）
```

Extraction 继续为自己的模型请求附加独立 telemetry、`skipTranscript` 和 Memory 工具权限，
但这些属于 Invocation Context，不得借此重新创建或重新选择模型。

## 单轮跳过 Extraction

CLI/Core 在现有单次 `modelExecution` 中增加可选参数：

```ts
modelExecution: {
  // ...既有 execution-scoped Selection 约束
  memoryExtraction?: "skip";
}
```

它具有以下边界：

- 只影响携带该参数的成功 Turn。
- 不修改 Session 的 `memory.extractionEnabled`。
- 不写入 Session Selection、消息历史或持久配置。
- 不影响 Recall、前台 Memory 工具调用或 Dream。
- 普通 Turn 缺省不传，继续遵循 Session 级 Extraction 开关。
- Off-Peak 派发显式传入 `"skip"`，确定不运行自动 Memory Extraction，避免一次性执行
  凭据在主 Turn 结束后被后台工作再次使用。

协议和调用链：

```text
Host Off-Peak dispatch
        |
        | sendText.modelExecution.memoryExtraction = "skip"
        v
Protocol V4 admission
        |
        v
SubmitPromptOptions / ExecuteTurnOptions
        |
        v
Turn 成功
        |
        +-- skip --> 不调度 Extraction
        `-- absent -> 按 Session 级开关调度
```

该字段与 execution-scoped Selection、请求期访问材料和子 Agent 约束共用既有的
`modelExecution` 单轮边界；它不进入可排队的普通 Submission Intent。当前调用方仅为要求
idle start-now 的 Off-Peak 派发，因此不会在 CommandInbox 中丢失。
