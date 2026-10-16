# Subagent Browser Use 会话边界

> 2026-10-09 起 subagent 可以使用 Browser Use，原先「subagent 一律 fail closed，统一报
> `Browser is not available in subagent`」的限制已经移除。本文件沿用原路径，内容按当前实际行为编写。

## 背景

宿主 `node_repl` MCP 是一个通用的 JavaScript 内核进程，主 agent 和 subagent 共用这一个 MCP 进程。
Browser Use 需要拿到桌面窗口或 CLI managed headless runtime 的宿主控制权，所以 tab 归属、workspace
和 clientMode 都必须能追溯到客户端认识的某个会话。

桌面判断 tab 归属、选择在哪个对话里展开浏览器面板，用的都是请求里的 `sessionId`。具体是
`sessionId === 当前对话的 ownerTaskId`，见 `packages/ui/src/lib/workspaceSidePane.ts`
（`applyBrowserUseSidePaneEvent`）。桌面不认识 subagent 的子会话 id。如果用子会话 id 开 tab，
面板不会展开，这个 tab 也不会出现在任何对话里，成了一个看不见的孤儿。所以 core `Agent` 子代理的
浏览器请求要以**当前对话（父会话）**作为 tab 归属。

## 适用范围

- core `Agent` 子代理：`taskType: "subagent_child"`、`runtimeScope: "subagent"`，即本文的主体。
- 动态工作流（dwf）子代理：`taskType: "workflow_child"`，仍使用子会话自己的 tab，run dispose 时
  连 tab 一起关闭。见 `apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md` 的
  「Subagent sessions」，以及 `docs/zcode-protocol-model-backed-control-requests.md` 契约 4。

## 目标语义

- 主 agent 的 Browser Use 行为不变。
- subagent 可以初始化、发现、读取文档、操作 Browser Use，API 与主 agent 相同。
- subagent 与当前对话共用同一组 tab：
  - `tabs.list()`、`user.openTabs()` 能看到当前对话里所有的浏览器 tab，包括主 agent 开的和用户自己开的。
  - subagent 新开或选中的 tab 会在当前对话的浏览器面板里自动展开，与主 agent 开 tab 时一样。
- workspace（`workspaceIdentity` / `workspacePath` / `remoteSessionId`）和 `clientMode` 都取父会话，
  所以桌面 continuous 与手机 replayable 的边界与父会话一致。
- subagent 不主动关闭 tab：
  - 子代理的轮次结束、运行结束（完成、失败或取消）时，都不向桌面发 `turnEnded` / `closeSession`；
  - tab 交给父会话自己的生命周期处理（父会话 turnEnded 时释放控制权，tab 不会关闭）；
  - 子代理运行结束只撤销子会话登记，之后再用这个子会话 id 发 Browser 请求，与从未登记一样会被拒。
- 后续 `SendMessage` 恢复同一个 subagent 时会重新登记，并且能看到对话里还留着的 tab。

## 调用链路

```text
parent runtime                  shared node_repl MCP        bootstrap broker（每 server context 一份状态）     Desktop
  | Agent tool → spawn child          |                             |                                          |
  | forChildSession(child, parent,    |                             |                                          |
  |   tabOwner:"parent") ------------------------------------------>| childSessionParents[child]=parent        |
  |                                   |                             | parentTabOwnerChildren += child          |
child runtime                         |                             |                                          |
  | js(session_id=child,              |                             |                                          |
  |    runtime_scope=subagent) ------>| bridge 只校验 binding 未过期 |                                          |
  |                                   | list/execute(child) ------->| requireSession(parent) → workspace/mode  |
  |                                   |                             | 下发 sessionId=parent（tab 归属）------->| 对话 tab；面板按
  |                                   |                             | 连接记在 parent 名下                     | ownerTaskId=parent 展开
child turn / 运行结束                 |                             |                                          |
  | 子端口 turnEnded / closeSession -------------------------------->| 不发生命周期；closeSession 只撤销登记    |
parent turn 结束                      |                             |                                          |
  | turnEnded(parent) --------------------------------------------->| 发往 parent 用过（含 child 用过）的 browser ->| 释放控制权，tab 保留
```

## 实现约束

- `node_repl` browser bridge 和 bootstrap node_repl broker 不再按 `runtime_scope` 拒绝请求。broker
  仍然先校验私有 socket token，sessionId 的权威校验交给 `BrowserControlPort` 的 `requireSession`。
- 归属模式在 `BrowserControlPort.forChildSession({ childSessionId, parentSessionId, tabOwner })` 的
  `tabOwner` 里声明：`"parent"` 给 core Agent 子代理用，`"child"`（默认）给 dwf 子代理用。子会话能否
  解析，只取决于父 runtime 有没有调过 `forChildSession`，不根据 session id 的形状去猜父会话。
- 在 `tabOwner: "parent"` 模式下，broker 把连接记在父会话名下，这样子代理用过的 browser 也能收到
  父会话的 turnEnded / closeSession。
- 端口没有 `forChildSession` 时（CLI headless CDP），子代理直接用父端口，tab 落在子会话自己的 scope 里，
  子代理结束时关闭这个子会话的 session。headless 没有 UI 面板。
- 收尾失败只记 warn，不阻断子代理结果回到父 agent。
- 后台子代理和父会话可能同时操作同一组 tab，这一点与「共用对话 tab」的语义一致，不额外加锁。
- Computer Use 的 subagent 限制不变（`docs/cua/2026-08-18-subagent-computer-use-unavailable-spec.md`）。

## 验收

- subagent scope 下调用 Browser bridge 不再抛错，初始化入口可用。
- `forChildSession` 用 `tabOwner: "parent"` 登记后，子会话的 list/execute 下发父会话的 sessionId，
  workspace 和 clientMode 都取父会话；子端口的 turnEnded / closeSession 不发任何桌面请求；撤销登记后
  子会话请求被拒；父会话的 turnEnded 能发到子代理用过的 browser。
- 父 runtime 为子代理调用 `forChildSession({ childSessionId, parentSessionId, tabOwner: "parent" })`，
  子代理结束后对子端口调 closeSession（只撤销登记）。
- 桌面 E2E（BAB01 / BU-E2E-012）：
  - child 能列出主 agent 的 Tab，新开的 Tab 在当前对话面板中可见；
  - 回到主 agent 后，原 Tab 的状态仍是 `parent-before`，child 开的 Tab 仍在 `tabs.list()` 里。
