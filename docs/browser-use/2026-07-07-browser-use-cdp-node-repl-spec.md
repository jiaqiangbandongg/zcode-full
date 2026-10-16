# Browser-Use CDP + node_repl 总规格（重做）

> 状态：已实现（node_repl/协议/交互面均落地；浏览器底座已由 <webview>+CDP-on-guest pivot 取代 WebContentsView）。
> 当前事实入口：`2026-07-13-node-repl-mcp-runtime-spec.md` 与 `browser-use-plugin-runtime-boundary.md`。本文保留为重做阶段的总规格，涉及 `WebContentsView` 的历史表述以当前事实文档为准。
> 分支：`feat/browser-use-cdp`（从 staging 新建）。
> 取代：`feat/in-app-browser-use` 分支的「MCP 单工具 + renderer webview + executeJavaScript」方案（已归档为参考/回滚点）。
> 组件级 spec（每个 task 落地前先写）：`2026-07-07-node-repl-engine-spec.md`、`-node-repl-tools-spec.md`、`-browser-control-protocol-spec.md`、`-browser-cdp-view-spec.md`、`-browser-client-lib-spec.md`。

## 1. 目标形态

三个维度：

1. **工具面 = node_repl（Code-Act）**：模型不调离散工具，而是在一个**持久 Node REPL** 里写 JS 执行；REPL 注入 `agent.browsers.*` 对象图，变量跨调用保持。工具为 `js`/`js_reset`/`js_add_node_module_dir` 三个（当前经 node_repl MCP 以 `mcp__node_repl__js*` 暴露）。
2. **浏览器底座 = renderer `<webview>` guest + main 进程 CDP attach**。早期目标是 main 进程 `WebContentsView`，当前实现已 pivot 到 `<webview>` guest，main 只管理 guest webContents 与 CDP。
3. **控制手段 = CDP**（`webContents.debugger`）：真实输入 `Input.dispatchMouseEvent`/`dispatchKeyEvent`、`Page.captureScreenshot`、页面脚本快照与状态读取。

非目标（P0 不做）：真实浏览器（extension 后端）、多 tab 并发、cua/dom_cua/playwright 完整逃生舱（保留骨架 throw）、UI 可见（先 headless）。

## 2. 为什么这样（关键设计依据）

- **node_repl 是运行时 core 原语，不放在 browser-use plugin 里**。browser-use plugin 只提供 `browser-client.mjs` 库，靠 SKILL 指示模型用已存在的 REPL `import setupBrowserRuntime` 注入 `agent.browsers`。所以先建**通用持久 REPL 工具**，再叠 **browser-client 库层**。二者解耦：node_repl 无 browser 也能用。
- **旧方案的 renderer `capturePage` 触发 V8 `Empty MaybeLocal (ToLocalChecked)` native FATAL**（已实测崩溃）。CDP `Page.captureScreenshot` 在 main 侧执行，从根上规避。这是换 CDP 的直接动因之一。
- **当前 Electron 底座**：renderer `<webview>` 负责显示和生命周期，main 通过 `webContents.fromId(webContentsId)` attach guest，并用 `WebContents.debugger.sendCommand` 执行 CDP 命令。

## 3. 分层架构（4 进程边界）

```
AGENT (zcode-cli 子进程, stdio NDJSON ZCode Protocol)
  node_repl: 每 session 一个持久 vm.Context（sandbox === globalThis，跨调用保持）
             + nodeRepl.write sink + 动态 import() + require
  browser-client 库: setupBrowserRuntime({globals,execute}) → agent.browsers.*
                     每个 async 方法 → 构造 BrowserCommand → BrowserControlPort.execute(cmd)
  BrowserControlPort = ProtocolBrowserControlBroker
                     → context.requestClient("interaction/browserExecute", {command})
        │ stdio JSON-RPC 反向请求（server→client request）
HOST (utilityProcess, 业务 services)
  zcodeAgentService.client.onRequest: case "interaction/browserExecute"
        校验 → BrowserControlMainBridge.execute() → respondResult/respondError
        （纯 RPC 中继：不 emitSessionEvent、不进 UI，区别于 permission 请求）
        │ parentPort（MessagePortMain，按 requestId 关联）
MAIN (Electron 主进程)
  desktopHostProcess child.on("message"): case BrowserExecuteRequest
  BrowserGuestManager: 按 sessionId/tabId 管理 renderer <webview> guest webContents
  browserCommandExecutor: 按 command.method 分派
  CDP: guest.webContents.debugger attach/sendCommand
        navigate→loadURL / screenshot→Page.captureScreenshot / snapshot→页面脚本快照
        click/type/press/scroll/hover/drag→Input.* / 页面脚本辅助定位
        │ renderer dom-ready 上报 webContentsId
RENDERER (UI)
  side-pane browser tab 渲染 <webview>；卸载 tab 即释放 guest
```

**职责纪律**：agent 只表达意图，不碰底座；host 纯 RPC 中继；main 独占 guest attach 与 CDP；renderer 只负责 `<webview>` 显示和上报 guest id。

## 4. 核心链路（P0 headless）

模型在 REPL 里执行：
```js
nodeRepl.write(await agent.browsers.documentation());
const tab = await agent.browsers.open("https://example.com");
const shot = await tab.screenshot();
await nodeRepl.emitImage({ base64: shot.image.base64, mimeType: shot.image.mimeType });
```
链路：`js` 工具 → NodeReplSession.run → `agent.browsers.open` → BrowserCommand{navigate} → BrowserControlPort → requestClient → host router → parentPort → main BrowserGuestManager(loadURL) → 回；再 screenshot 同样一趟到 guest CDP `Page.captureScreenshot`。

## 5. 契约同源（防漂移）

`BrowserCommand`（判别联合）是三处的单一真相：agent browser-client 构造它、协议 params 携带它、main executor 消费它。迁移复用旧分支 `shared/src/browser-use/commands.ts` 的 `browserCommandSchema`（P0 核心子集：navigate/snapshot/click/type/screenshot/getState）。用双向 round-trip 单测 + keep-in-sync 注释防漂移。

## 6. Task 与验证

见 plan（T0–T6 为 P0，T7–T11 为 P1）。每 task 先写组件 spec 再码，单独 Conventional Commit。

- **T1/T2 验证**：`pnpm --filter @zcode/core test` + `@zcode/contracts`；纯 REPL 语义（globalThis 持久/reset 清空/顶层 await/动态 import/write 收集/AbortSignal）单测全绿。
- **P0 端到端**：desktop 起（feature 开关开）→ agent 会话模型写上面那段 js → 断言 main WebContentsView 实际导航、返回非空 PNG base64；抓 main 日志确认 CDP attach + `Page.captureScreenshot`。
- **收尾**：`pnpm typecheck`（含 desktop renderer/main/preload 单独 tsc）+ `pnpm lint`。

## 7. 风险（详见 plan）

vm 非安全沙箱（与 bash 同权，靠权限 gate + try/catch 结构化不崩进程）；跨 4 进程延迟（命令粗粒度 + snapshot 带 ref 批量决策）；CDP attach 与 DevTools 冲突；renderer `<webview>` guest 握手时序（execute 等待 attach，超时返回 `backend_unavailable`）；契约漂移（单一 zod + round-trip 测）；纯 CLI/远控无 main（port/bridge 缺省结构化报 "browser unavailable" 不崩 REPL）。
