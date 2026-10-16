# Linux AppImage Deep Link 回调

## 背景

Linux `.deb` / `.rpm` 安装包会通过系统级 desktop entry 注册 `zcode://` 协议，登录回调可以稳定回到已安装应用。AppImage 直跑没有固定安装入口，ZCode 会在启动时写入用户级 `~/.local/share/applications/zcode.desktop`，让浏览器登录后的 `zcode://...` 能交给当前 AppImage（前提是系统中不存在系统级同 ID 条目，见下文"与系统安装共存"）。

用户在 Ubuntu 24.04 + NVIDIA 环境中发现：手动启动 AppImage 时带了 `--no-sandbox`、`--disable-gpu`、`--use-gl=swiftshader` 等参数，窗口和登录页都能打开；但浏览器回调触发 `.desktop Exec` 后，系统按裸 AppImage 路径二次启动，缺少这些参数，进程在 Electron sandbox/GPU 初始化阶段崩溃，导致应用一直停留在“等待浏览器回调”。

## 方案

- 仅在 AppImage 场景使用 `APPIMAGE` 环境变量作为协议处理器 executable；前提是无系统级同 ID 条目（存在时跳过用户级写入，见"与系统安装共存"）。
- AppImage 场景下，从当前 `process.argv` 中保留一小组会影响 Electron/Chromium 启动成败的安全启动开关，写入 `.desktop Exec`。
- `.deb`、开发态和普通二进制安装继续写裸 executable，不复制当前 argv。
- 不持久化 deep link URL、工作区路径、调试端口、用户数据目录等一次性或敏感参数。

当前允许持久化的开关：

- `--no-sandbox`
- `--disable-gpu`
- `--disable-software-rasterizer`
- `--use-gl=...`
- `--use-angle=...`
- `--disable-features=...`
- `--enable-features=...`

## 与系统安装（rpm/deb）共存

用户级 desktop entry 在 XDG 解析中永远优先于系统级同 ID 条目（`~/.local/share/applications` 先于 `/usr/share/applications`）。历史上旧 AppImage 写入的用户级 `zcode.desktop` 会在用户迁移到 rpm/deb 后持续遮蔽 `/usr/share/applications/zcode.desktop`，导致快捷方式和 `zcode://` 回调仍指向旧 AppImage（文件还在时）或直接失效（文件被删后）。为此注册逻辑按以下优先级工作：

1. 启动时按 `XDG_DATA_DIRS`（默认 `/usr/local/share:/usr/share`）探测系统级 `zcode.desktop`，**必须是普通文件**才视为有效系统条目。
2. **存在系统级条目时**：AppImage 运行不再写入用户级同名条目和用户级图标，避免再度遮蔽系统安装；rpm/deb 等系统安装形态运行时会清理本应用写入的遗留用户级条目。归属识别依赖 `Comment=ZCode Desktop App` 标记行——只有带该标记的条目会被删除，用户手写的自定义 `zcode.desktop`（无标记、读取失败或无法确认归属）一律保留不清理。
3. **不存在系统级条目时**：保持原有 AppImage 用户级注册行为不变。

清理与读取失败只记录 `warn` 降级，不阻断 `update-desktop-database` / `xdg-mime` 协议注册。

## 边界

这次只修 AppImage 协议回调二次启动参数丢失，不改变 OAuth state 路由、单实例转发和 `.deb` 协议注册语义。若用户环境仍需要 `chrome-sandbox` SUID 或 `libfuse2`，安装文档需要单独说明。
