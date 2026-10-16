# Remote Workspace Session Unified Settings

## 背景

之前 workspace 会话相关状态分散在三个字段里：

- `lastOpenTabs`
- `remoteWorkspaceHistory`
- `lastWorkspaceSession`

这会导致恢复、重连、移除三条链路维护多份真相源，容易出现状态漂移。

## 现在的结构

统一只保留 `lastWorkspaceSession`：

```json
[
  {
    "kind": "local",
    "workspacePath": "/Users/dev/ZCodeProject/3DAutoSnake"
  },
  {
    "kind": "remote",
    "workspacePath": "/home/ubuntu",
    "workspaceIdentity": "remote:docker:zcode-ssh-container:/home/ubuntu",
    "target": {
      "kind": "docker",
      "container": "zcode-ssh-container"
    },
    "lastOpenedAt": 1776220448653,
    "lastConnectionStatus": "failed",
    "lastConnectionError": "..."
  }
]
```

说明：

- `local` 条目只保存本地 workspace 路径
- `remote` 条目同时保存远端目标、身份键、最近一次连接状态
- `workspaceIdentity` 仍然保留，用于 remote workspace 隔离和去重

## 迁移策略

- 读取旧 `setting.json` 时，在 schema 解析阶段自动迁移
- 旧的 `lastOpenTabs` 会转成 `local` 条目
- 旧的 `lastWorkspaceSession.remote(historyId)` 会结合 `remoteWorkspaceHistory` 展开成完整 `remote` 条目
- 迁移后的运行态对象不再暴露 `lastOpenTabs` / `remoteWorkspaceHistory`

## 恢复与移除规则

- 启动时只按 `lastWorkspaceSession` 恢复 tab
- 远端 workspace 只恢复为“断开态 tab”，不再后台自动重连
- 用户关闭远端 tab 时，视为显式移除：
  - 从 `lastWorkspaceSession` 删除
  - 清理对应 SSH 凭据 key（如存在）

## 重连规则

- 远端 workspace 只允许用户手动点击 sidebar 的 reconnect
- 手动重连成功后，更新对应 `remote` 条目的 `lastOpenedAt` / `lastConnectionStatus`
- 手动重连失败后，仅更新失败状态并保留 tab，方便继续手动重试
