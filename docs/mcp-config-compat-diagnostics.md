# MCP 配置兼容解析与诊断

## 背景

`~/.zcode/cli/config.json` 可能来自旧版本、外部 Agent 导入或用户手写。历史配置里存在两类常见 MCP 字段：

- stdio server 使用 `environment` 表示环境变量。
- HTTP remote server 使用 `type: "remote"`。

当前运行态 schema 只接受 `env` 和 `type: "http" | "sse" | "stdio"`。如果任意一个 MCP server 校验失败，旧实现会让整份用户配置加载失败，进而丢失 `plugins.enabledPlugins` 等无关配置，导致插件管理界面状态异常。

## 目标

- 在配置入口兼容 `environment -> env`。
- 在配置入口兼容 `type: "remote" -> "http"`。
- MCP servers 按 server 粒度容错解析：单个 server 不合法时跳过该 server，并记录 diagnostics。
- 其它非 MCP 配置仍保持原有强校验，不把未知运行态结构静默传入系统。

## 行为约定

- 合法的 legacy MCP server 会被归一化后进入 `RuntimeConfigPatch.mcp.servers`。
- 不合法的单个 MCP server 不会阻断整份 `config.json`。
- 被跳过的 MCP server 会写入配置解析 diagnostics，包含 JSON path 和具体 schema 问题。
- `createConfig()` 会把配置文件加载失败与 MCP server 跳过 diagnostics 写入 warn 日志，便于用户导出日志后定位迁移问题。
- 顶层配置错误仍会让该配置文件 `loaded=false`，以避免非法 provider/model/UI 等配置被部分应用。
- `type: "remote"` 按外部导入约定归一化为 HTTP；若目标端点实际是 SSE，需要显式写成 `type: "sse"`。
- 诊断文档与内置 diagnosing-mcp skill 必须区分两条链路：
  - CLI 直接读取配置时会经过配置入口归一化，兼容 `environment -> env`、`http_headers -> headers`、`enable -> enabled`、`type: "remote" -> "http"`。
  - 桌面端 Settings / app-managed session 下发 MCP 时，先由 UI 读取用户目录，再转换为 ZCode Protocol `mcpServers`。这条链路不应让用户依赖 legacy 字段；排障时优先建议改成 canonical 字段：`env`、`headers`、`enabled`、`type: "http"`。
- JSON 编辑器粘贴外部 MCP 配置时，需要提示 `command` 必须是字符串，OpenCode 配置格式的 `command: ["npx", "-y", "server"]` 需要拆成 `command: "npx"` 与 `args: ["-y", "server"]`，否则设置表单会把 `command` 当字符串处理并触发运行时错误。

## 验证

- 回归测试覆盖 legacy `environment`、legacy `remote` 和单个坏 server 不影响 `plugins.enabledPlugins`。
- diagnosing-mcp skill 覆盖桌面端 app-managed 链路的兼容差异与用户自助修复话术。
- `pnpm typecheck` 与 `pnpm lint` 作为边界检查。
