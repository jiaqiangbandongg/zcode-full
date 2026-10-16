# SSH Config Alias

## Goal

在 SSH 连接弹窗里支持直接选择本机 `ssh config` 的 `Host alias`，减少手工填写 `host/port/user/privateKey` 的成本。

## Behavior

- SSH 模式下新增 `SSH Config Alias` 下拉框，按需懒加载候选。
- 选择 alias 后自动回填：
  - `HostName -> host`
  - `Port -> port`
  - `User -> username`
  - `IdentityFile -> privateKeyPath`
- 当 alias 含 `IdentityFile` 时，认证方式自动切换为 `privateKey`。
- 用户后续手动改动 SSH 关键字段（host/port/username/privateKey）会清除“已选 alias”状态，避免误导。
- 通过 alias 建立的 SSH remote workspace 会把 alias 作为非敏感连接元数据写入 remote target snapshot。
- 左侧任务列表和聊天区域 header 里的 SSH remote workspace 若带 alias，工作区标题显示为 `<workspaceName> [SSH: <alias>]`，例如 `root [SSH: linux-arm64]`；未使用 alias 或历史记录无 alias 时保持原工作区名/原 host 辅助信息。
- Web 端非 remote-control 场景返回空列表，保持兼容。

## Implementation Notes

- 解析能力下沉到 `packages/services/src/system/sshConfigAlias.ts`，desktop main 只做平台通道转发。
- 支持 `Include` 展开、单 alias 过滤（排除 `*`/通配符/否定 pattern/多 pattern Host 行）。
- 优先使用 `ssh -G` 获取最终配置；并带有保护策略：
  - 单 alias 超时（1.5s）
  - 并发上限（3）
  - alias 数量上限（200）
  - 缓存 TTL（30s）
  - 失败隔离与回退到本地解析结果
- `SSHConnectOptions` / `SSHRemoteTargetSnapshot` 保存可选 `sshConfigAlias` 字段；该字段不参与 workspace identity 计算，避免用户重命名 alias 或同目标 alias 变化导致同一远端 workspace 被误拆分。
- 断连恢复、重连失败记录和 tab 持久化继续以 `workspaceIdentity?.trim() || workspacePath` 作为隔离 key；alias 只用于 UI 展示。
- 兼容 macOS / Linux / Windows：
  - 配置入口统一从 `os.homedir()` 解析 `~/.ssh/config`
  - Windows 额外探测常见 OpenSSH/Git `ssh.exe` 路径
  - 无 `ssh` 可执行文件时自动回退到本地解析
