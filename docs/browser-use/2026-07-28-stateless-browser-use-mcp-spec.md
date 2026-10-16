# 2026-07-28 Browser Use MCP 方案归档

> 状态：已废弃方案（2026-08-06）。本文只保留设计决策轨迹，不作为当前实现依据。

## 被否决的方案

最初的 728 改造曾新增独立的 `browser_use` MCP server，并向模型暴露：

- `browser_context_create`
- `browser_js`
- `browser_context_close`
- opaque `context_handle`

该方案虽然让每次 `browser_js` 使用 fresh kernel，但同时改变了 Browser Use 的模型工具身份、prompt、权限卡、结果展示和生命周期语义，超出了“把现有 node_repl 执行内核改成无状态”的产品边界。

## 当前决策

当前实现以 [mcp-stateless-node-repl.md](../mcp-stateless-node-repl.md) 为唯一事实来源：

- Browser Use 继续使用 `mcp__node_repl__js`；
- 保留 `js_reset` 与 `js_add_node_module_dir`；
- 不暴露 dedicated `browser_use` 工具或 handle；
- `node_repl` MCP frontend 按 workspace 共享，并使用 MCP `2026-07-28`；
- 每个 `js` 调用使用一次性 Worker，global 与 Node module cache 不跨调用；
- 页面、tab 与 browser backend 连续性继续由既有 `BrowserControlPort` / session registry 管理；
- session 路由只接受 host 注入的 namespaced request context，并由私有 broker token 和 authoritative `requireSession` 共同校验。

```text
workspace-scoped node_repl frontend
  ├─ js(session A) -> one-shot Worker -> BrowserControlPort(session A)
  └─ js(session B) -> one-shot Worker -> BrowserControlPort(session B)

Worker state: per call only
Browser/tab state: existing session authority
```

旧 create/js/close 与 handle 生命周期 E2E 已删除，不得作为后续实现模板。
