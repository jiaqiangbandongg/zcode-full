# Browser 官方插件运行时边界

## 背景

`browser-use@zcode-plugins-official` 是 ZCode 官方插件。它的 manifest 仍只声明 `skills`，不扩展 plugin schema。

目标是让 browser-use 插件的启停状态控制模型可见的浏览器 guidance/bridge，同时说清楚无状态
`node_repl` MCP frontend、browser client 与插件物理资产载体的关系：

browser-use package 是这些 runtime asset 的物理发布载体；`enabled === false` 只关闭 skill/bridge，
不把宿主 node_repl identity 转交给第三方插件。

- 启用 `browser-use@zcode-plugins-official`：会话通过宿主无状态 `node_repl` 的 `js` 工具使用 Browser Use。
- 关闭或卸载该插件：宿主 `node_repl` identity 仍可被运行时保留，但 browser-use skill 不进入 skill roots，
  且没有 Browser bridge/runtime feature。

## 设计

不允许任意插件通过 manifest 自声明高权限 runtime capability。ZCode core 只识别官方插件 id：

```text
browser-use@zcode-plugins-official
```

bootstrap 在插件解析完成后读取 `PluginLoadOutcome.plugins`，只有当该官方插件 `enabled === true` 时，才向 `AgentRuntimeConfig.runtimeFeatures` 写入：

```ts
{
  browserUse: true,
  browserDocumentationRoot: "<browser-use plugin>/docs"
}
```

`node_repl` 由宿主 built-in MCP 配置注册，不再由 `browserControlPort` 隐式开启；Browser
bridge 同时要求 `runtimeFeatures.browserUse` 和宿主注入的 `browserControlPort`。MCP frontend 不保存
conversation 或 JavaScript kernel 状态；浏览器连续性继续由现有 session-scoped BrowserControl/tab
owner 维持。这样 desktop browser view / CDP / 协议桥可以继续留在核心并保持 dormant。

## 保留在核心的部分

- `interaction/browserExecute` 协议和 shared browser-use command/result schema。
- Desktop main / host / renderer 的 browser view、CDP、IPC 与 tab 显示逻辑。
- `NodeReplSession` 一次性 worker 内的单次调用执行引擎、权限、超时、图片结果格式化。
- `browser-client` 对象图实现。

这些部分要么是跨进程基础设施，要么是高权限执行面，不由普通 plugin manifest 动态声明。

## REPL 发布依赖边界

`@zcode/core/repl` 是 `NodeReplSession` 及其类型的独立公共入口，直接复用现有执行引擎；
MCP server 的 core 依赖只能进入 `core/repl`，不能通过 `@zcode/core` 总入口带入 Agent、
工具注册表、Subagent 或工作流编译器。core 总入口保留原有导出，兼容已有调用方。
独立的 `browser-client.mjs` 继续通过 `@zcode/core/browser-client` 提供浏览器对象图。

App 的 Electron Node 模式、普通 Node CLI 和 SEA 内置 Node 共用 CLI 入口的轻量 plugin-host 分支：

```text
main → 环境清理 / SEA 工具准备 → plugin-host 鉴权 → MCP server → 一次性 Worker
                              └ 普通 CLI 命令 → Provider 准备 → run / Agent Runtime
```

`__zcode-plugin-host` 必须在导入通用 `run.ts` 和 Provider 初始化模块之前分流。REPL 子进程
不求值 Agent Runtime、工具注册表或工作流模块；这些模块继续由对话所属的父 Agent 使用。
复用原有 plugin-host 的凭据校验、argv 透传和退出 owner：鉴权失败在 import 前拒绝，成功 MCP
继续依靠 stdio 存活，初始化失败仍由现有 watchdog 收口。插件参数不触发 Provider 初始化。
回归测试须在业务入口求值时主动抛错，并证明普通与压缩 CLI 的 plugin-host 仍可正常加载插件。
启动层通过 `@zcode/shared/runtime-env`、`@zcode/shared/mcp`、
`@zcode/shared/runtime-tool-runtime` 和已有的 `@zcode/contracts/plugins` 读取环境处理、
身份常量与 SEA 工具描述，避免总入口的无关 schema 初始化。所有入口指向原文件，
broker 凭据 capture 仍是同一模块持有的唯一状态，不复制校验或环境实现。

MCP server 通过 `@zcode/contracts/tools/node-repl` 读取 JS 工具 schema，通过
`@zcode/contracts/mcp` 读取 MCP 结果元数据常量；browser bridge 通过
`@zcode/shared/node-repl-browser-broker` 读取现有 broker 协议。禁止为了这些少量定义
求值 contracts/shared 总入口，避免每个 MCP 进程及一次性 Worker 初始化无关业务 schema。
这些公共子入口直接指向原文件，保留校验、工具描述和返回格式的唯一事实源。

本边界不改变 MCP 工具、一次性 Worker、模块目录隔离、超时/取消、
浏览器 broker、结果格式、权限或 desktop continuous / mobile replayable 交付合同。
验收复用真实 bundle 的 MCP 握手及 Worker 隔离测试，并检查构建依赖图不包含上述业务模块。

## 宿主与插件职责

ZCode 在 MCP `2026-07-28` 后仍使用宿主 `node_repl` 工具 identity；官方 browser-use 插件携带
frontend bundle、browser-client/docs/skills assets。协议桥和 desktop CDP 执行链路仍保留在宿主；
禁用插件后没有 Browser Use skill/bridge，不创建另一套 `browser_use` 工具。

## 验收

- 默认启用官方 browser-use 插件时，桌面会话能看到 `mcp__node_repl__js` 和 `control-browser`
  skill；不出现 `mcp__browser_use__*`，也不出现已删除的 `js_reset` / `js_add_node_module_dir`。
- 显式禁用 `browser-use@zcode-plugins-official` 后，新会话不再提供 `control-browser` skill 或
  `agent.browsers`；宿主可保留 `js` 这一个 node_repl tool identity 用于配置兼容，但模型文案仍限于
  Browser Use 与 Computer Use 两个官方能力，不得把它改造成通用 JavaScript 工具。
- 即使 host 仍注入 `browserControlPort`，没有 browser-use runtime feature 时也不会注入 Browser bridge；
  node_repl identity 不因此被第三方配置接管。
- 纯 CLI 未显式传 `--browser-use=headless` 时没有 browser host，不注入 `agent.browsers`。
- 纯 CLI 显式启用 headless 时，由 CLI adapter 注入真实 managed `cdp` BrowserControlPort；完成 Chromium
  handshake 后才可发现 backend。该路径继续使用官方 plugin 的 skill/client 和宿主 node_repl MCP，
  不能绕过成 `agent-browser` 或另一套模型工具。
- ZCode app-server 不消费 CLI managed headless 参数；Desktop/Web Remote 继续使用 shared-host 注入的
  BrowserControlPort，不能为手机或协议 session 另起 browser runtime。
