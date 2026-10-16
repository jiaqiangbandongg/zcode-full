# User Message Row（当前事实）

V4 user row 以纯文本/附件呈现，并提供 copy 与真实的 inline edit。编辑提交
`editUserQuery { target: { rowId, entityId }, newText, attachments, workspaceMode }`，信封同时携带
`baseRevision/baseLogEpoch`，由 CLI 按投影权威 `actions.canEdit` 裁决。编辑器固定提供“取消 / 文件重置图标 /
发送”：中间动作使用 `FileClock` 图标，与发送按钮同尺寸并保留 outline 颜色，hover/focus 提示
“与文件一起重置”。
禁用态由图标按钮外层的 hover trigger 承接指针事件并显示具体禁用原因，实际按钮仍保持 disabled。
普通发送使用 `workspaceMode=preserve`；组合重置使用 `workspaceMode=rewind`，冲突时显示文件列表并允许
降级为 preserve。取消编辑只恢复本地编辑态。

Retry 不在 user row 上，它属于 assistant turn action，并发送 `retryTurn`。
