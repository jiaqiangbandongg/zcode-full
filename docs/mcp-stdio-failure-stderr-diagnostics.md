# MCP STDIO 失败 stderr 诊断

## 背景

用户反馈 `ZCT-2071437415552278528` 中，两个 MySQL MCP server 都以
`MCP error -32000: Connection closed` 失败。该错误只说明 MCP stdio 子进程关闭了
管道，无法判断是 `npx`、server 参数校验、环境变量、网络还是 server 自身崩溃。

现有 adapter 已经监听 stdio stderr，但 stderr 只写 debug 日志。生产日志导出默认不包含
debug，导致工单里没有 MCP 子进程退出前的原始错误。

## 目标

- 保留 stdio MCP 子进程最近的 stderr 尾部内容。
- 当 `mcp.server.failed` 发生时，把最近 stderr 作为 warn 上下文字段输出。
- stderr 必须限长，避免高频 stderr 把生产日志刷爆。
- stderr 必须脱敏，避免把 token、password、authorization 等凭据写入日志。
- 成功连接时不额外输出 warn 级 stderr，保持正常运行日志安静。

## 行为约定

- 每个 stdio MCP server 连接尝试单独维护一个内存 stderr buffer。
- buffer 只保留尾部固定长度，用于定位启动失败前的最后错误。
- debug 级 `mcp.stdio.stderr` 继续输出单次 chunk，但同样使用脱敏后的文本。
- warn 级 `mcp.server.failed` 仅在 buffer 非空时附带 `stderr` 字段。
- 不记录 stdio env values；env 仍只通过子进程启动参数传递。

## 验证

- 单测覆盖 stdio MCP connect 失败时，warn 日志包含最近 stderr。
- 单测覆盖 stderr 中的敏感字段会被 `[Redacted]` 替换。
- `pnpm typecheck` 与 `pnpm lint` 作为边界检查。
