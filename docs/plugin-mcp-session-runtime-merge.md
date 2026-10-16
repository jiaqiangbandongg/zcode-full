# Plugin MCP Session Runtime Merge

## 背景

ZCode Dev 的设置页会通过 `zcode/mcp/list` 展示插件 MCP 和用户 MCP 的合并结果，但桌面端创建或恢复 session 时，UI 传给 protocol 的 `mcpServers` 只来自 `source === "zcodeagentmcp"` 的用户配置。

## 问题

`resolveAppRuntimeConfig` 过去把 `runtimeConfig.mcp.servers` 当作完整覆盖配置。一旦 protocol 传入用户 MCP，插件 MCP 就不会再和 runtime 配置合并，导致模型侧只能看到用户 MCP 中成功连接的服务器；例如本机 `context7`、`exa`、`playwright` 等用户 MCP 保留，但 `plugin:chrome-devtools-mcp:chrome-devtools`、`plugin:ios-simulator:ios-simulator` 等插件 MCP 丢失。

## 修复

session runtime 配置解析时始终先注入插件 MCP，再合并显式用户 MCP：

```ts
{
  ...pluginMcpServers,
  ...(options.runtimeConfig?.mcp?.servers ?? configResult.config.mcp.servers),
}
```

这样保留用户配置覆盖同名 MCP 的优先级，同时保证插件注册的 MCP 进入新 session 的 runtime。
