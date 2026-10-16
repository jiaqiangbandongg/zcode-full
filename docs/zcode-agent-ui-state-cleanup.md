# ZCode Agent UI 状态收口记录

## 目标

UI 层只保留视图状态和必要的短期乐观态，session/runtime 的真实状态由 ZCode Agent 与 ZCode Protocol V4 projection 持有。新改动不得围绕旧协议命名扩展。

## 当前收口

- 旧 `workspaceInitByProvider` 已收敛为单一 `workspaceInit`。
- `setWorkspaceInitState` / `setWorkspaceInitAttempts` 不再接收 provider 参数，写入语义变成 workspace 级初始化状态。
- `getWorkspaceProviderInitState` 已替换为 `getWorkspaceInitState`，避免 UI 继续表达多 agent 初始化状态。
- 默认 workspace state 使用稳定单例引用，避免未写入 workspace bucket 的 selector 连续读取生成不同快照。
- `taskStatus` / `taskError` 已从 workspace 根状态移除。草稿态保留短期 `draftRuntime`，已有 task 的显示状态统一通过 `getWorkspaceDisplayedTaskState` 从 active task runtime 派生。
- `availableModes` / `currentModeId` 已从 workspace 根状态移除。UI 通过 `getWorkspaceModeState` 从 `configOptions` 派生模式状态，`setAvailableModes` / `setCurrentModeId` 仅作为 `mode_update` 等旧入口的 `configOptions` 补丁兼容层。

## 后续方向

- `configOptions` 后续继续对齐 `ZCodeSessionSettingsState`，UI 不再新增独立的模型、模式、思考级别镜像字段。
- `queuedPromptsByTaskId` 和 replayable mirror 状态后续迁到 ZCode session runtime / host command queue。
