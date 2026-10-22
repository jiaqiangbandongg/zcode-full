# capture_app 超时诊断契约

## 背景

macOS `capture_app` 会在 Helper 的异步 worker 中遍历目标窗口的 Accessibility 树。目标应用
短暂无响应、AX 树过大或 worker 排队时，调用会被 8 秒 wall-clock fence 截断。过去错误只有
“exceeded the 8 second wall-clock deadline”，无法判断卡在窗口解析、首次 AX warm、窗口树、菜单树，
还是某个具体 AX 属性读取。

## 目标

- 超时时在 MCP 错误中携带最近一份结构化诊断，确保 model I/O trace 可以直接取证。
- Helper 同时把同一条诊断写入受控 `--exit-log`，覆盖 LaunchServices 丢弃标准错误的产品启动方式。
- native 诊断只记录阶段、最后一次 AX 操作、节点数、耗时、PID 和 window id；不得记录控件文本、
  剪贴板、token、socket、窗口标题或其他用户内容。
- 正常快速 capture 不写日志；只在超时时写一行，避免按消息流量刷盘。

## 诊断字段

`captureAppDiagnostic(pid, windowId?)` 是 additive native ABI，返回最近一次匹配采集的：

- `phase`：当前/最终阶段，例如 `capture_lock`、`window_resolve`、`tree_traversal`、
  `menu_traversal`、`native_complete`。
- `last_ax_operation`：进入当前可能阻塞的 AX API 前记录的操作名。
- `nodes_visited`：已开始读取的 AX 节点数。
- `elapsed_ms`：从 N-API admission 起的单调时钟耗时，包含 libuv 排队。
- `deadline_exceeded`：读取诊断时是否已越过 native 绝对 deadline。
- `pid` / `window_id`：只用于把诊断绑定到本次请求，不包含授权材料。

诊断 ABI 缺失、返回非法形状或读取抛错时，原有超时错误仍须正常返回，不能让诊断路径改变
`capture_app` 的失败语义。

## 日志位置

ZCode 产品和 standalone 启动 Helper 时都传 `--exit-log <socket>.exit.log`。Helper 对超时追加一行
`[capture-app-timeout] ...`；同时原错误文本附加同一组字段摘要，因此即使日志文件被系统清理，模型
trace 仍保留诊断。
