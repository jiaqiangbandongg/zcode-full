# QSpace Open With Support

日期：2026-07-07

## 背景

ZCode 的“打开方式”菜单不直接枚举 macOS 系统 Open With 列表，而是由 desktop main 进程维护一份跨平台外部 App 候选，再通过 `platform.getInstalledEditors()` 暴露给 UI。macOS 上已安装的 QSpace / QSpace Pro 不在候选列表中，因此不会出现在 workspace header、文件树、消息文件链接和预览打开菜单里。

## 范围

- 在 macOS 外部 App 候选里加入 QSpace 与 QSpace Pro。
- QSpace / QSpace Pro 作为第三方文件管理器类 App，跟 Finder 一样在打开方式排序中靠前展示。
- 打开动作继续复用现有 `platform.openInEditor(editorId, path)` 协议，不新增协议字段。

## 非目标

- 不改 macOS 系统默认文件管理器，也不替换“在 Finder 中打开”的现有文案和默认语义。
- 不在 Web、手机远控或 remote workspace 中新增本机 App 打开能力；远程文件树仍不能把远端路径交给本机 QSpace。
- 不改变 `desktop-continuous` 与 `web-remote-replayable` 的 realtime/session 语义。

## 实现约束

- `QSpace.app` 默认路径为 `/Applications/QSpace.app`，`QSpace Pro.app` 默认路径为 `/Applications/QSpace Pro.app`，打开时走现有 macOS `open -a <appPath> <path>` 降级链路。
- 图标继续复用 `getAppIconDataUrl()`，从 app bundle 的 `Info.plist` 和 `.icns` 资源解析。
- 如果用户没有安装对应 QSpace 版本，`existsSync` 过滤后不会展示该项；两个版本都安装时会展示两个独立入口。
