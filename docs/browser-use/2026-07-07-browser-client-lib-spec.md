# browser-client 库 + node_repl 注入规格（T6，P0 验收）

> 状态：已实现。
> 2026-07-13 边界更新：对象图实现继续复用 core，但“session 创建时自动注入”已由
> `2026-07-13-node-repl-mcp-runtime-spec.md` 的 plugin `scripts/browser-client.mjs` 显式 bootstrap 取代；
> 下文注入段落只记录历史 T6 路线。
> 上位：`2026-07-07-browser-use-cdp-node-repl-spec.md`；依赖 T1-T5 全部就位。
> 范围：实现 `agent.browsers.*` 对象图（browser-client 库）+ 在 node_repl 注入它（桥到 T3 的 `BrowserControlPort`）。达成 P0 验收：agent 写 JS → 控制 main WebContentsView → 截图回来。

## 1. 落点

- `apps/zcode-cli/packages/core/src/browser-client/index.ts`（新）：`setupBrowserRuntime` + `agent.browsers` 对象图。
- `apps/zcode-cli/packages/core/src/browser-client/facade.ts`（新）：`BrowsersFacade`/`Browser`/`Tab` 类，把方法调用构造成 `BrowserCommand` → `execute(cmd)`。
- 改 `packages/core/src/tool/handlers/node-repl.ts`：`getSession` 用 `context.browserControlPort` 构造注入 globals。

## 2. 对象图（P0 核心子集）

```ts
// browser-client/index.ts
export function setupBrowserRuntime(opts: {
  globals: Record<string, unknown>;
  execute: (command: BrowserCommand) => Promise<BrowserCommandResult>;
}): void {
  const agent = (opts.globals.agent ??= {}) as { browsers?: BrowsersFacade };
  agent.browsers = new BrowsersFacade(opts.execute);
}
```
```ts
// facade.ts
class BrowsersFacade {
  constructor(private execute: ExecuteFn) {}
  async open(url?: string): Promise<Browser>;   // 若 url，先 navigate
  get default(): Browser;                        // 返回当前（单 tab P0）
}
class Browser {
  async navigate(url): Promise<BrowserCommandResult>;  // {method:"navigate",url}
  async getState(): Promise<BrowserCommandResult>;
  async screenshot(): Promise<BrowserCommandResult>;   // {method:"screenshot"} → {image:{base64}}
  // P0 骨架保留、throw NotImplemented：
  async snapshot(): Promise<never>;   // T8
  async click(): Promise<never>;
  async type(): Promise<never>;
  get playwright(): never;  // getter throw（结构先占位，逃生舱 T10）
  get cua(): never;
  get dom_cua(): never;
}
```
- 每方法：构造 `BrowserCommand` → `await execute(cmd)` → 返回 `BrowserCommandResult`（`ok:false` 时不 throw，让模型读 error；仅未实现的 snapshot/click/... throw NotImplemented，让未支持方法显式抛错）。
- 库纯 TS，外部效果全经注入的 `execute`（I/O 边界收敛）。

## 3. node_repl 注入桥

- `getSession(context)` 构造 session 时：若 `context.browserControlPort` 存在，注入 globals：
  ```ts
  const execute = (command) => context.browserControlPort!.execute({ sessionId: context.sessionId, command });
  const globals = {};
  setupBrowserRuntime({ globals, execute });   // globals.agent.browsers 就位
  new NodeReplSession({ injectedGlobals: { agent: globals.agent, setupBrowserRuntime } });
  ```
  即 REPL 里 `agent.browsers` **开箱可用**（无需模型手动 import）。同时也注入 `setupBrowserRuntime`（供高级用法与 bootstrap 文档中的显式初始化写法）。
- `browserControlPort` 缺省（纯 CLI/远控）：不注入 `agent.browsers`；REPL 里 `agent` 无 browsers，模型调用得到 undefined（或注入一个 stub throw "browser unavailable"）——P0 注入 stub throw 更友好。
- **注意**：port 来自首次调用的 context；同 session 后续调用复用已建 session（port 不变，安全）。

## 4. P0 验收（端到端，真机）

`ZCODE_BROWSER_USE=1`(或临时在 desktop 装配无条件启用 includeNodeRepl + browserControlPort) 起 desktop → agent 会话里模型：
```js
const b = await agent.browsers.open("https://example.com");
nodeRepl.write(JSON.stringify(await b.getState()));
const shot = await b.screenshot();
nodeRepl.write("shot bytes: " + (shot.image ? shot.image.base64.length : "none"));
```
断言：main 日志见 WebContentsView 创建 + CDP attach + Page.captureScreenshot；REPL 返回非空 base64；getState.url === example.com。

## 5. 开关（P0 最小）

- node_repl 工具需 `includeNodeRepl:true`（T2 的 opt-in）。desktop 装配传 true（P0 先无条件，后续接 settings 开关）。
- `browserControlPort` 已在 desktop 路径注入（T3/T4）。
- 纯 CLI：includeNodeRepl 可开（纯 REPL 有用），browserControlPort 不注入 → agent.browsers 报 unavailable。

## 6. 验证点（T6 单测）

- `BrowsersFacade`/`Browser`：假 execute（记录命令）→ `open(url)` 发 navigate、`screenshot()` 发 screenshot、`getState()` 发 getState；命令结构正确。
- 未实现方法（snapshot/click/playwright getter）throw NotImplemented。
- node_repl 注入：给 handler 假 `browserControlPort` 的 context → REPL 里 `return typeof agent.browsers.open`（"function"）；`await agent.browsers.open("https://x")` 触发 port.execute（假 port 返回预设 result）→ REPL 拿到结果。
- 无 port 的 context → REPL 里 agent.browsers 调用报 browser unavailable。
