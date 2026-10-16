# Linux AppImage Desktop Icon Integration

## 背景

Linux AppImage 直跑不会像 deb 安装包一样稳定写入系统级 `.desktop` 文件和 hicolor 图标主题。部分桌面环境的任务栏/Dock 不会只依赖 Electron `BrowserWindow.icon`，还会通过 `.desktop` 的 `Icon` 与 `StartupWMClass` 匹配运行中的窗口，因此 AppImage 直跑可能显示默认图标。

## 目标

- 仅增强 Linux AppImage 直跑体验，不影响 deb、Windows、macOS、本地开发和远控链路。
- 启动时刷新用户级 `zcode.desktop`，让 `zcode://` 协议回调继续指向当前 AppImage 路径——仅在 `XDG_DATA_DIRS`（默认 `/usr/local/share:/usr/share`）中不存在系统级 `zcode.desktop` 普通文件时才写用户级；存在系统级条目（已装 rpm/deb）时跳过用户级写入与图标安装，避免遮蔽系统安装，系统安装形态还会清理带 `Comment=ZCode Desktop App` 标记的遗留用户级条目（详见 `docs/desktop/linux-appimage-deep-link.md`）。
- 启动时把包内 512x512 PNG 安装到用户级 hicolor 图标主题，提升 `Icon=zcode` 被任务栏/Dock 命中的概率。

## 实现

Linux 打包态启动时，`registerDeepLinkProtocol` 传入当前包内 512x512 图标路径。`registerLinuxDeepLinkProtocol` 解析用户数据目录时优先使用 `XDG_DATA_HOME`，未设置时回退到 `~/.local/share`。仅在检测到 `APPIMAGE` 环境变量、图标源文件存在、且 `XDG_DATA_DIRS` 中不存在系统级 `zcode.desktop` 普通文件时，才写入：

```text
$XDG_DATA_HOME/icons/hicolor/512x512/apps/zcode.png
$XDG_DATA_HOME/applications/zcode.desktop
```

写入后以 best-effort 方式刷新：

```text
gtk-update-icon-cache -f -t $XDG_DATA_HOME/icons/hicolor
update-desktop-database $XDG_DATA_HOME/applications
xdg-mime default zcode.desktop x-scheme-handler/zcode
```

刷新命令不存在、失败或超时时只记录 `warn`。外部命令必须设置短超时，图标未变化时跳过 `gtk-update-icon-cache`，不得无界阻塞应用启动。

核心 deep link 注册必须先于图标安装执行。图标安装是可选桌面集成，目录创建、文件读取、复制或缓存刷新失败时只能降级记录 `warn`，不得阻断 `.desktop` 写入和 `xdg-mime` 协议关联。

## 边界

该能力不能保证所有 Linux 桌面环境 100% 显示任务栏图标。Wayland/X11、GNOME/KDE/其他 Dock、用户从终端直跑 AppImage、图标缓存策略都会影响匹配结果。需要稳定桌面集成时，deb 安装包仍是优先推荐路径。
