# 外部 Agent MCP 服务器导入

## 背景

设置页已经支持从外部 Agent 导入 skills、commands、plugins。MCP 服务器不是目录型资源，不能复用软链/复制语义；它的导入目标是 ZCode 配置文件中的 `mcp.servers`。

引导流程中的 MCP 迁移只负责旧版通用 MCP 配置迁移。设置页的手动导入需要独立扫描外部 Agent 的 MCP 配置文件，并将用户选择的 server 合并到 ZCode 配置。

## 目标

- 在 MCP 服务器设置页提供“从外部 Agent 导入”入口。
- 弹窗交互复用现有外部导入弹窗：来源范围、刷新、两层来源列表、逐项选择、目标全局/项目导入、导入结果列表。
- MCP 导入不显示“软链/直接复制”选项，因为它只合并配置对象。
- 导入目标：
  - 全局：`~/.zcode/cli/config.json` 的 `mcp.servers`
  - 项目：`<workspace>/.zcode/config.json` 的 `mcp.servers`
- 同名 server 保留现有 ZCode 配置，外部 server 标记为跳过，不覆盖。
- 不扫描 Gemini 相关目录。

## 扫描范围

首批支持外部 MCP 来源：

| Agent | Global | Project | Format |
| --- | --- | --- | --- |
| Claude Code | `~/.claude/settings.json` | `<workspace>/.claude/settings.json`, `<workspace>/.mcp.json` | `mcpServers` JSON |
| Codex CLI | `~/.codex/config.toml` | `<workspace>/.codex/config.toml` | `mcp_servers` / `mcpServers` TOML |
| OpenCode | `~/.config/opencode/opencode.json` | `<workspace>/.opencode/opencode.json` | `mcp` JSON |
| OpenClaw | `~/.openclaw/settings.json` | `<workspace>/settings.json` | `mcpServers` JSON |
| Qwen Code | `~/.qwen/settings.json` | `<workspace>/.qwen/settings.json` | `mcpServers` JSON |
| Qoder | `~/.qoder/settings.json` | `<workspace>/.qoder/settings.json` | `mcpServers` JSON |
| Qoder CN | `~/.qoder-cn/settings.json` | `<workspace>/.qoder/settings.json` | `mcpServers` JSON |
| Trae | `~/.trae/settings.json` | `<workspace>/.trae/settings.json` | `mcpServers` JSON |
| Kiro CLI | `~/.kiro/settings.json` | `<workspace>/.kiro/settings.json` | `mcpServers` JSON |
| Roo Code | `~/.roo/settings.json` | `<workspace>/.roo/settings.json` | `mcpServers` JSON |
| CodeBuddy | `~/.codebuddy/settings.json` | `<workspace>/.codebuddy/settings.json` | `mcpServers` JSON |
| 通用 `.agents` | `~/.agents/mcp.json` | `<workspace>/.agents/mcp.json` | `mcpServers` JSON |

## 兼容性

- JSON 读写使用结构化解析，保留目标文件其他顶层字段。
- TOML 只作为外部来源读取；写入目标始终为 ZCode JSON。
- OpenCode 的 `command: string[]` 会转换为 ZCode/Claude 兼容的 `command + args`。
- Project 目标在没有 workspace 时禁用。
