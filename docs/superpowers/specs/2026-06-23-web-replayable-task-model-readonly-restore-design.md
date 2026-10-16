# Web Replayable Task Model Readonly Restore Design

## Background

手机 Web 远控打开历史 task 时走 `web-remote-replayable` 快照恢复。当前
`getTaskSnapshot` 在缺少显式模型参数时会从 task index 回填历史模型，再调用
`session/resume`。如果历史模型的 exact provider/model 已经从当前 registry 中不可用，
服务层会抛出 `ZCODE_RUNTIME_MODEL_UNAVAILABLE`。

桌面端 `desktop-continuous` 已经在 UI helper 中对这个错误做了降级：恢复历史显示，
并要求用户选择当前可用模型后再续聊。手机端没有同等降级，首屏 snapshot 直接失败，
外层 catch 又把错误写成 runtime string，最终被展示成普通聊天错误横幅。

## Goal

只优化手机 `web-remote-replayable` 打开 task 的恢复路径：历史模型不可用时仍能显示历史消息，
并把真正的 runtime 恢复延后到用户或工具栏选择可用模型之后。桌面
`desktop-continuous` 行为保持不变。

## Design

- 为 task snapshot 参数增加手机专用恢复策略：
  `resumeModelPolicy: "task-index" | "ui-resolved-only"`。
- 默认策略为 `"task-index"`，保持现有行为。
- 只有 `clientMode === "web-remote-replayable"` 且策略为
  `"ui-resolved-only"` 时，`zcodeTaskServiceAdapter.getTaskSnapshot` 不再从 task index
  回填历史模型。
- `useTaskRestore` 在手机 replayable 分支中，如果恢复前模型解析结果表明历史模型不可用，
  且没有可见模型 fallback，则首屏 snapshot 使用 `"ui-resolved-only"`。
- `useTaskRestore` 在手机 replayable 分支中，如果 provider snapshot 尚未水合，也先使用
  `"ui-resolved-only"`。此时 UI 还不能可靠判断历史模型是否可用，不能把旧模型 hint
  提前传给 runtime；工具栏会在模型列表水合后重新判断并自动切到第一个可见可用模型。
- provider snapshot 未水合时，UI 的 task meta 也可能尚未进 store；即使本地没有解析出
  历史模型 hint，也必须先禁止 host 从 task index 回填旧模型。
- provider snapshot 也可能已经被其它 workspace 提前水合，但当前 task meta 仍未进入
  UI store。只要手机 replayable 恢复前的 task meta source 为 `missing`，首屏 snapshot
  同样使用 `"ui-resolved-only"`，避免 host 在 UI fallback 判断前从 task index 回填旧模型。
- 同一只读恢复分支跳过后续 `resumeTask`，避免它再次从 task index 回填同一个不可用模型。
  UI 使用 snapshot meta 完成历史展示，并保留 task-scoped
  `ZCODE_RUNTIME_MODEL_UNAVAILABLE` 状态。
- 手机 `web-remote-replayable` 打开 task 后，stream event / session event / gap recovery
  触发的后续只读 snapshot 同步也使用 `"ui-resolved-only"`。这些同步只用于校准
  UI 消息、队列和运行态，不能在用户已经切到可用模型后再次从 task index 回填历史模型。
- 当工具栏自动切到第一个可见模型或用户手动选模型后，后续发送继续走现有
  task config model 恢复链路。

## Boundaries

- 不修改 `zcodeAgentService.resolveRuntimeModelConfig` 的历史 session 硬校验。
- 不让历史 session 静默切到 registry 第一个模型。
- 不改变桌面 `desktop-continuous` 的 snapshot、resume、queue 或 stream 语义。
- 不在 relay 或 desktop main 下沉 task/model 业务状态。

## Verification

- UI 单测覆盖手机只读恢复 snapshot 参数包含 `resumeModelPolicy: "ui-resolved-only"`。
- UI 单测覆盖手机端 provider snapshot 未水合时即使没有本地历史模型 hint 也使用只读恢复，
  桌面端不使用该策略。
- UI 单测覆盖手机端 provider snapshot 已水合但 task meta 尚未进入 UI 时仍使用只读恢复，
  桌面端不使用该策略。
- UI 单测覆盖手机 replayable 后续 snapshot 同步会携带
  `resumeModelPolicy: "ui-resolved-only"`，桌面端不改变 session read 路径。
- 服务单测覆盖该策略下 `web-remote-replayable` 不从 task index 回填历史模型。
- 回归单测覆盖默认 `web-remote-replayable` 仍会回填 task index 模型。
- 运行 `pnpm typecheck` 和 `pnpm lint`。
