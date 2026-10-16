# Mobile Remote Workspace Reconnect

手机端 Web 远程控制的 workspace 列表会保留桌面端当前窗口中的 SSH 远程项目，即使该项目已经断开连接。断开项通过 `connectionState: "disconnected"` 和可选的 `lastConnectionError` 展示状态，但不会创建 workspace bridge。

重连由手机端发送 `workspace-reconnect-request` app payload 到 desktop main，desktop main 再通过 renderer IPC 调用桌面端已有的远程 workspace 重连流程。renderer 仍是 SSH 连接、凭据和 tab 状态的唯一拥有者；手机端只负责触发重连并刷新列表。

未连接的远程 workspace 在重连成功前不能打开任务或新建任务。重连成功后，下一次 workspace list 会带回新的 `remoteSessionId`，此时手机端才可以创建 bridge 进入聊天。

进入聊天后，消息流仍按手机远控的 replayable 语义恢复：

- 手机 bridge attach 到桌面端已经存在的 remote session host，不创建新的 SSH/WSL/Docker session。
- 断线重连后先恢复 bridge，再通过 task snapshot 对齐当前 task。
- `runtime.streamWatermark` 用于判断 snapshot 是否覆盖 replayable stream gap。
- `pendingPermissions`、`pendingElicitations` 和 `pendingCommands` 会随 snapshot 恢复，避免权限、askUserQuestion 或已 accepted 的发送队列只留在手机页面内存里。
