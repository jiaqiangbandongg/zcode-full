# WSL 远端同步入口设计

## 背景

现有 Skill、MCP、Plugin 远端同步最初按 SSH workspace 设计，UI 入口和文案都以 SSH host 命名。但桌面 WSL workspace 已经走统一 `RemoteTarget` / `InitRemoteWorkspace` / remote service collection 链路，`skillSyncService`、`mcpSyncService`、`pluginSyncService` 均来自 WSL 远端 host。

## 目标

- SSH 和 WSL workspace 都显示同一套远端同步入口。
- 同步目标仍是当前远端 runtime 的用户目录：`~/.zcode/skills`、`~/.zcode/cli/config.json`、`~/.zcode/plugins`。
- 本地 workspace 不显示远端同步入口。
- Docker 本轮不扩展入口，避免把插件安装和 MCP 环境兼容风险扩大到容器场景。

## 设计

将 UI 层的 `shouldShowSshRemoteSyncActions` 泛化为 remote sync capability 判断，允许 `remoteTarget.kind` 为 `ssh` 或 `wsl`。远端 service wiring 不新增分支，继续复用现有 remote workspace services。

目标标签按 target 类型展示：

- SSH：`user@host:port · /remote/workspace`
- WSL：`WSL · distro · user · /remote/workspace`

文案从 “SSH host” 调整为 “remote target / 远端目标”，避免 WSL 场景看到错误描述。MCP 和 Plugin 的环境提醒继续说明同步后在远端环境运行；WSL 下如果本地 MCP 命令或插件依赖 Windows-only 能力，状态检查会暴露不可用，不在同步入口层做静默过滤。

## 写入权限预检

同步开始前由远端 sync service 执行写入预检：

- Skills：检查 `~/.zcode/skills`
- MCP：检查 `~/.zcode/cli`
- Plugins：检查 `~/.zcode/plugins` 和 `~/.zcode/cli`

预检只做 `mkdir -p` 等价目录创建、写入一个 `.zcode-sync-preflight-*` 临时文件并立即删除。它不做 `chmod` / `chown`，避免改变 WSL/SSH 用户已有权限模型。若目录被其他用户占用、目标路径是文件或当前远端用户不可写，UI 在导出本地资源前显示错误并停止同步。

预检属于同步生命周期的一部分。点击开始后必须在第一个远端 RPC await 前进入 `preflighting` 活动状态，并用 ref 级 in-flight guard 防止 React state 尚未提交时的快速重复点击。`preflighting` 和 `syncing` 都禁止关闭弹窗；预检失败后恢复 `selection`，不再继续导出、导入或启动插件安装。

预检远端 RPC 必须有 UI 侧有界等待，默认 15 秒。超时后 UI 恢复 `selection`、释放 in-flight guard 并显示本地化错误；底层 RPC 若迟到返回，不再推进本次同步流程。当前服务层没有取消令牌，预检只做可重复 marker 文件写删，因此本版本先保证 UI 主流程可恢复，不额外引入远端 runtime 或新的取消通道。

## Web 远控边界

同步入口只在桌面端 `desktop-continuous` surface 显示。手机 Web 远控使用 shared-host attachment，`baseServices` 表示当前 bridge host；当当前 bridge 本身是 WSL/SSH 远端 workspace host 时，`local*SyncService` 与 `remote*SyncService` 可能指向同一远端 host，无法满足“source 为桌面本地用户目录、destination 为当前远端用户目录”的同步不变量。

因此当前版本在 `web-remote-replayable` surface 隐藏 Skills/MCP/Plugins 远端同步入口，不为手机端另起独立 Agent runtime、local host 或新的远端 session。若后续产品要求手机端支持同步，需要通过已有 host attachment 显式注入桌面本地 source service，并保持 destination 仍是当前远端 workspace service。

## 验证

- UI helper 单测覆盖 SSH、WSL 显示同步入口，本地和 Docker 不显示。
- UI helper 单测覆盖 Web remote surface 隐藏同步入口，避免远端到自身同步。
- 连接成功目录页覆盖 WSL 显示同步下拉。
- Skill 同步目标格式覆盖 WSL label。
- Service 单测覆盖远端写入预检成功与目标路径不可写失败。
- 同步弹窗单测覆盖 `preflighting` 关闭保护与 in-flight guard。
- 同步预检 helper 单测覆盖超时收敛，避免远端 RPC 永久 pending 锁死弹窗。
- 执行 `pnpm typecheck` 与 `pnpm lint`。
