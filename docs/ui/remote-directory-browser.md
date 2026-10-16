# Remote Directory Browser

远程连接成功后的目录选择页复用 `DirectoryBrowser`，通过当前 remote workspace session 的 `systemService` 和 `fileService` 浏览远端文件系统。

## 起始路径

- 初次进入目录选择页时，`DirectoryBrowser` 调用当前服务集合的 `systemService.info()`。
- 起始路径使用返回的 `homedir`。SSH 登录用户为 `root` 时通常是 `/root`；普通用户通常是 `/home/<user>`。
- 路径输入框展示并提交远端绝对路径，不展示本机路径。

## 目录展示

- 目录内容通过 `fileService.readdir({ path })` 按需读取当前路径。
- 目录选择页只展示 `type === "directory"` 的条目；文件不会出现在列表里。
- 目录软链接由服务层跟随目标类型返回；当软链接目标是目录时返回 `type === "directory"`，因此目录选择页必须展示并允许进入。
- 目录软链接只改变列表图标：`isSymbolicLink === true` 时展示软链接目录图标，点击和选择行为仍按目录处理。
- `..` 是 UI 提供的返回上级入口，不是 `readdir` 返回的真实条目。
- 当过滤后没有可展示目录时，显示“无子目录”。

## 隐藏目录

- 默认保持旧行为：不传 `includeHidden`，隐藏 `.ssh`、`.config`、`.cache` 等 dot directory，避免远程 home 目录初始视图噪音过多。
- 目录输入区提供“显示隐藏目录”按钮。
- 用户开启后，当前路径会重新读取为 `fileService.readdir({ path, includeHidden: true })`。
- 开启后只额外展示隐藏目录；隐藏文件即使由服务层返回，也继续被目录选择页过滤掉。
- 用户关闭后，当前路径重新按默认规则读取，隐藏目录再次不可见。

## 范围

- 该功能只改变 `DirectoryBrowser` 的 UI 展示和 `fileService.readdir` 参数。
- 不改变远程连接、remote workspace session、workspace identity、task realtime stream、desktop continuous 或 web remote replayable 的任何语义。
