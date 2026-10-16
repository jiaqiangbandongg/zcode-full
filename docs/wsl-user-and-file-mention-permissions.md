# WSL 用户与文件 mention 权限

## 背景

WSL remote workspace 通过 `wsl.exe` 启动远端 host 和 agent。WSL 不需要 SSH 密码鉴权，但每个命令仍然会在某个 Linux 用户身份下运行。默认情况下，ZCode 使用该 distro 的默认用户。

文件 mention 的 `@` 菜单会从 workspace 根目录递归建立候选列表。Linux 列目录需要目录的 read/execute 权限；当某个子目录由 root 或其他用户创建且当前用户不可读时，`readdir` 会返回 `EACCES` / `EPERM`。

## 设计

- WSL 连接支持可选 `user` 字段。空值表示继续使用 distro 默认用户；填写 `root` 时以 root 身份启动 WSL host / agent / terminal 链路。
- 空 `user` 是兼容旧版本的默认用户语义，不能生成新的 workspace identity，也不能让历史 WSL 连接因为新增用户选择而走全新部署路径。
- WSL `user` 参与 remote workspace identity，避免默认用户和 root 用户连接同一路径时共用 session、缓存、队列或持久化 key。
- WSL `user` 非空时只允许可展示的普通字符串：拒绝控制字符、冒号、斜杠和反斜杠，并限制长度，避免非法用户名延迟到连接阶段才失败，也避免污染 identity 和日志标签。
- 开发态 remote assets 的 `mock-cdn` 只是离线缓存；当前版本缓存不存在时必须回退 CDN/cache，避免 WSL 重连旧地址时被本机缺包误判为连接失败。
- 连接 UI 对 root 用户展示 warning，提示后续创建的文件可能属于 root。该 warning 不阻止连接。
- 文件 mention 索引遇到单个不可读或已消失目录时跳过该目录，继续展示其余可访问文件。不可读目录不应让整个 `@` 菜单失败。
- remote workspace 的 prompt 附件会先从 host 侧上传到远端用户私有目录 `~/.zcode/tmp/prompt-attachments/<trace>/<random>/...`，再把 prompt 中的 host 路径改写为远端路径。上传前会将目录 chmod 为 `700`，上传后会将文件 chmod 为 `600`，避免长文本粘贴、图片或本地缓存附件落到公共 `/tmp` 后被同机其他用户读取。
- 当前版本不在 task 结束时自动删除远端 prompt 附件目录：这些文件位于当前远端用户的 `~/.zcode/tmp` 下，便于同一会话内重试/恢复时继续读取。后续如果引入自动清理，必须绑定 task/session 生命周期并只删除本次 trace 的随机私有目录，失败仅记录 warn。

## 非目标

- 不在 `@` 菜单中自动 sudo 或静默提权。
- 不为 WSL user 增加密码字段；`wsl.exe --user` 要求目标 Linux 用户已存在，本身不消费密码。
- 不改变桌面 `desktop-continuous` 与手机 `/remote` `web-remote-replayable` 的 realtime 边界。
- 不在本次修复里自动清理历史已经写入 `/tmp/zcode-prompt-attachments` 的附件目录；旧目录需要用户或后续迁移脚本手动处理。

## 验证点

- WSL 默认用户连接仍不带 `--user`。
- WSL 自定义用户连接带 `--user <user>`。
- WSL root 连接可以建立独立 workspace identity。
- WSL 非法用户名（如包含 `/`、`:`、控制字符或超长）在 UI 和 schema 层被拒绝。
- `@` 文件索引遇到 `EACCES` / `EPERM` / `ENOENT` 子目录时不中断。
- remote prompt 附件上传前会创建远端私有目录并收紧到 `700`，上传后会把文件收紧到 `600`，且远端路径包含不可预测随机段。
