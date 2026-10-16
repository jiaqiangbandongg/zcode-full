# Browser Use Phase 1 Spec

> 状态：历史阶段规格。运行时启停边界以 `browser-use-plugin-runtime-boundary.md` 为准，Node REPL
> 载体以 `2026-07-13-node-repl-mcp-runtime-spec.md` 为准；下文保留 Phase 1 范围，但示例按当前
> `globalThis.browser + list → match → get` guidance 更新，避免被误当作现行操作说明。

## 背景

Phase 1 当时把 browser use 视为由官方 `browser` plugin 整体控制的能力。当前实现已经把宿主
`node_repl` 注册与 `agent.browsers` bridge 解耦：禁用插件只关闭 skill/browser runtime feature，包仍被发现时
宿主 REPL 继续存在。第一阶段目标是在不修改 plugin manifest schema 的前提下，把 API 自描述、REPL
元数据、Browser facade 语义和 backend/tab 对象模型收敛为统一的 SDK 形态。

## 范围

1. 文档 manifest 化：官方 `browser` plugin 提供 `docs/api.json`、`docs/documents.json` 和配套 markdown。core 不再维护大段硬编码 API 文档，而是从启用的官方 plugin asset 生成 `agent.browsers.documentation()`。
2. REPL 元数据补齐：`js` 输入接受 `timeout_ms` 与 `title`；REPL 内暴露 `nodeRepl.requestMeta`、`nodeRepl.setResponseMeta(meta)`，并把 `responseMeta` 回传给工具输出。
3. Direct-return facade wrapper：底层继续使用 `BrowserCommandResult` 和 `BrowserCommand`，外层 SDK 成功时直接返回 payload，失败时抛 `BrowserCommandError`；`tab.raw.*` 保留原始结果通道。
4. 显式 backend 与 tabs 模型：`agent.browsers.get("iab")`、`getDefault()`、`getForUrl(url)` 返回 `Browser`；`Browser.tabs` 提供 `list()`、`selected()`、`get(id)`、`new()` 基础能力。第一阶段只支持 `iab`，不引入 Chrome backend。

## 非目标

- 不修改 `.zcode-plugin/plugin.json` schema。
- 不新增 Chrome / external browser 支持。
- 不改 desktop browser command 协议的核心 `BrowserCommandResult` 结构。
- 不在第一阶段完成 UI 对 `responseMeta` 的展示消费，只提供元数据链路。

## 设计

### Plugin 文档资产

官方 browser-use plugin 新增：

- `docs/api.json`：声明 backend、对象、方法、返回语义和错误语义。
- `docs/documents.json`：声明 documentation 需要拼接的 markdown 文档。
- `docs/*.md`：工作流、安全规则、截图/图片回传说明。

bootstrap 在解析官方 `browser-use@zcode-plugins-official` 插件时，把 `rootPath/docs` 作为内部 runtime feature 透传给 core。该字段属于 ZCode 内部 runtime config，不属于 plugin schema。

### REPL 元数据

`js` 输入：

- `code: string`
- `timeout_ms?: number`：调用超时字段；executor 同时兼容旧 `timeout`。
- `title?: string`：本次调用的短标题，进入 `nodeRepl.requestMeta.title`。

REPL 全局：

- `nodeRepl.requestMeta`：包含 `toolCallId`、`traceId`、`turnId`、`sessionId`、`workingDirectory`、`workspaceRoot`、`title`。
- `nodeRepl.setResponseMeta(meta)`：浅合并 JSON-like 对象，工具输出为 `responseMeta`。
- `nodeRepl.cwd/homeDir/tmpDir`：补齐 REPL 常用环境元数据。

### SDK 语义

`Tab` 对外方法采用 direct return：

- action 类：`goto/navigate/back/forward/reload/click/type/press/scroll/hover/select/check/drag/close/handleDialog` 成功返回 `void`。
- observation 类：`snapshot()` 返回 `BrowserSnapshot`，`getState()` 返回 `BrowserPageState`，`screenshot()` 返回 `Uint8Array`，`evaluate()` 返回 `unknown`，`elementInfo()` 返回元素或 `undefined`，`getDialog()` 返回 dialog 或 `null`。
- 失败时抛 `BrowserCommandError`，错误对象带 `code`、`command`、`result`。

`tab.raw.*` 保留旧的 `BrowserCommandResult` 返回值，供排障和低层集成使用。

### Backend / Tabs 模型

第一阶段对象模型：

```ts
globalThis.browser = await agent.browsers.getDefault();
globalThis.controlledTabs = await browser.tabs.list();
controlledTabs;
```

模型检查完整列表后，在下一 cell 用已验证的稳定 id 绑定目标：

```ts
const matching = controlledTabs.filter((info) => info.url === "https://example.com/");
if (matching.length !== 1) throw new Error("Expected exactly one matching tab");
globalThis.tab = await browser.tabs.get(matching[0].id);
await tab.playwright.domSnapshot();
```

兼容入口：

- `agent.browsers.open(url?)` 保留为便捷入口。
- `agent.browsers.current()` 保留为当前可见 tab 便捷入口。
- `agent.browsers.tab(tabId)` 保留为绑定 tab 便捷入口。
- `agent.browsers.list()` 调整为 backend 列表；tab 列表使用 `browser.tabs.list()` 或 `agent.browsers.listTabs()`。

## 验证

- 单测覆盖：
  - runtime feature 带出 `browserDocumentationRoot`。
  - documentation 从 plugin docs manifest 生成，缺失时返回内置最小 fallback。
  - facade direct return / throw / raw result。
  - `Browser.tabs` 基础模型。
  - `nodeRepl.requestMeta`、`setResponseMeta`、`timeout_ms` schema。
- 必跑 `pnpm typecheck` 与 `pnpm lint`。
