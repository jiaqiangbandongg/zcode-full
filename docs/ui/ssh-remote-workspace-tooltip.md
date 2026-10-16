# SSH Remote Workspace Tooltip

## Goal

没有 SSH config alias 的远程 workspace 仍需要能在左侧任务列表里区分服务器。用户 hover SSH 远程 workspace 的侧栏 tab 主标签区域时，显示连接信息 tooltip。

## Behavior

- 仅 SSH remote workspace 显示该 tooltip；本地、WSL、Docker workspace 保持现状。
- tooltip 展示非敏感连接信息：
  - `Alias`：仅当 `remoteTarget.sshConfigAlias` 存在时显示。
  - `Host`：显示 `username@host:port`，端口缺省时按 SSH 默认端口 `22` 展示。
  - `Path`：显示当前远程 workspace 路径。
- tooltip 只用于识别 workspace，不参与排序、去重、持久化 key 或 workspace identity 计算。
- 右侧已有操作按钮的 tooltip（新建任务、文件树、重连、错误日志）保持不变。

## Implementation Notes

- 数据来源为 `WorkspaceTabState.remoteTarget` 和 `workspacePath`，不读取凭据，也不显示密码、私钥路径或 passphrase。
- 仅修改 UI 展示层，不新增或修改 ZCode session/task realtime、snapshot、queue、stream、owner command 或 web remote-control 状态。
- 桌面端与 Web 端共用 `packages/ui` 组件；手机远控任务首页不使用桌面侧栏，不受该 tooltip 影响。
