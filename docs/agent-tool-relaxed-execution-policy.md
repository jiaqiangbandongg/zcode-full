# Agent tool relaxed execution policy

## 背景

2026-06-29 的日志排查显示，连续 subagent 失败的第一层原因不是同类型 `Agent` tool call 被拒绝，而是：

- `TodoWriteInputSchema` 在 schema 层拒绝多个 `in_progress` todo，导致 `TodoWrite` 失败；
- `executeToolSchedule` 看到前序非 `concurrentSafe` 工具失败后，对后续调度组生成 skipped 结果并停止执行。

这两个策略都会把模型一次性产出的后续工具调用提前截断。为了让 agent 能继续执行模型已经排好的后续 tool calls，本次放宽这两个本地策略。

## 行为

- `TodoWrite` 不再在 runtime schema 层硬拒绝多个 `in_progress` todo。`summary.inProgress` 继续按真实数量统计。
- `TodoWrite` 的 provider-visible description 保持原样，不主动提示模型写入多个 `in_progress`。
- 工具调度按既有 `parallelGroups` 顺序执行。某一组出现普通失败后，不再自动跳过后续组；后续工具是否能运行仍由各自权限、取消信号、handler 错误和调度分组决定。
- `turnControl.stopTurnAfterResult` 是显式 turn 边界。某个工具结果请求停止当前 turn 时，后续调度组不再执行真实 handler，并会生成取消结果来闭合 provider-visible tool call history。

## 非目标

- 不修改 todo 存储结构，也不引入 id-based task store。
- 不扩展 UI/TUI 摘要展示策略；如果界面当前只突出一个 `in_progress`，本次不改变该展示语义。
- 不删除旧策略代码。旧校验和跳过分支保留为注释，方便后续对比或回滚。

## 验收

- 多个 `in_progress` 的 `TodoWrite` 能成功写入并读回。
- plan mode 下前序写工具被权限拒绝时，后续只读工具仍会执行并把真实结果返回给模型。
