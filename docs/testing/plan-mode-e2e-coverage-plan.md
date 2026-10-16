# Plan Mode E2E Coverage Plan

## Scope

Plan mode 的端到端验收面是桌面本地 `desktop-continuous` 会话里的用户操作链路和 provider-visible request body，不把内部实现结构作为验收目标。当前 E2E 使用 synthetic DeepSeek replay fixture 固定模型工具调用，避免把真实模型是否选择工具混入产品语义断言。

## Existing Coverage

- `conversation-session-tool-cross-product.test.ts` 已覆盖 `EnterPlanMode` 成功入工具块，以及非 plan mode 下 `ExitPlanMode` 快速失败的普通工具展示边界。
- `conversation-session-plan-approval-feedback-user-message.test.ts` 覆盖 `ExitPlanMode` 被用户输入 custom feedback 拒绝后，feedback 作为真实 user message 进入下一次 provider 请求。
- `conversation-session-plan-file-compact-continuity.test.ts` 覆盖 `ExitPlanMode` 审批通过后 plan 原文写入 `.zcode/plans`，并在手动 `/compact` 后通过 `plan_file_reference` 回到 provider-visible context。

## Added Coverage

`conversation-session-plan-mode-capabilities.test.ts` 补齐两个 plan mode 能力边界：

1. `ExitPlanMode` 被用户无反馈拒绝时，当前 turn 必须停止，不应继续发带 `ExitPlanMode` tool_result 的 provider 请求；后续用户普通输入仍处于 plan mode，并在 provider-visible context 中带上 plan mode active reminder。
2. plan mode 下同一条 assistant 回复里先调用写工具再调用只读工具时，写工具必须被 `mode.plan.nonReadOnly` 拒绝且不落盘，后续只读工具仍必须执行并把真实 tool_result 返回给模型。

## Out Of Scope

- 手机 `web-remote-replayable` 的 snapshot/gap 恢复不从本组推断。
- 子 agent 内部触发 `ExitPlanMode` 的审批代理不从本组推断，归入 subagent human-in-the-loop delegate 后续组合。
- plan file 保存失败是否阻断退出 plan mode 已由 core 单测覆盖；E2E 只覆盖用户批准后的正常文件连续性。
