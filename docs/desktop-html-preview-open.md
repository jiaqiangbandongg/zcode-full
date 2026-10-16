# 本地 HTML 预览外部打开

## 目标

桌面端本地 HTML 预览卡片的“在浏览器中打开”必须直接按文件路径交给操作系统默认应用，打开失败时向用户反馈并写入主进程日志。普通 `http`/`https` 外链继续使用系统浏览器 URL 打开，Web 和远程工作区保持现有行为。内置浏览器工具栏的「在默认浏览器中打开」对本地页面遵循同一约束。

## 行为约束

- 本地桌面 HTML 卡片保留绝对文件路径，菜单动作调用路径打开接口，不再把 `file://` URL 交给 `shell.openExternal`。
- 主进程 `openExternal` IPC 对 `file:` URL 统一分流：`fileURLToPath` 解码（含中文、空格的 percent-encoding，并剥掉 hash/query）后调用 `shell.openPath`；覆盖内置浏览器工具栏等从 `webview.getURL()` 取得 percent-encoded file URL 的入口。转换失败时记主进程日志，不回退 `shell.openExternal`。
- 路径打开结果使用 `{ success, error? }` 返回；`success=false` 时 UI 展示国际化 toast。
- 主进程记录本地文件打开成功或失败、路径和错误信息，便于从导出日志定位 Windows ShellExecute 错误。
- 普通外部 URL 仍通过 `shell.openExternal`，但必须捕获并记录 rejected Promise，避免其他入口继续静默失败。

## 验收

1. Windows 绝对路径、中文和空格路径调用 `shell.openPath`，成功返回空错误并不触发 `shell.openExternal`。
2. `shell.openPath` 返回错误或抛异常时，主进程日志包含错误，HTML 卡片显示失败 toast。
3. `http`/`https` 外链和远程 HTML 卡片不改变原有打开路径。
4. 内置浏览器打开含中文与空格路径的本地 HTML 后，菜单「在默认浏览器中打开」经 `shell.openPath` 用解码后的本地路径打开，不触发 `shell.openExternal`（ZCT-202610-8F404D97）。
