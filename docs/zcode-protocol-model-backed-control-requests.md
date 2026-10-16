# ZCode Protocol 模型型控制请求异步化

## 背景

App 通过子进程 stdio 与 `apps/zcode-cli` 的 ZCode Protocol 通信。协议客户端把普通 request 当作短通信请求处理，默认 30 秒超时；agent 侧 NDJSON transport 又会串行处理进入的消息。若一个 protocol handler 在同步等待模型请求，后续消息会排队，甚至会挡住 agent -> app 反向 request 的 response。

`session/send` 会快速 ACK，真实模型 turn 在后台运行，并通过 session event / `state.updated` 推送进度。过去 `session/compact` 和 `prompt/enhance` 同步等待模型请求时，会遇到同类问题：

- 模型请求超过普通通信 timeout 后，host 可能把 agent client 判定为 stale 并清理进程。
- 同 workspace 其他 session 的 protocol request 会被串行队列阻塞。
- provider runtime headers、permission、user input 等 agent -> app 反向 request 的 response 可能被长 handler 挡住。

## 目标

- 模型型控制请求的 protocol ACK 不承载模型生命周期。
- agent -> app 的 response / error response 不被任何长 handler 阻塞。
- stop / cancel 类控制消息可以绕过长 handler。
- `session/compact` 保持 session turn 语义，结果继续走 compact timeline 和 snapshot。
- `prompt/enhance` 保持 composer 草稿工具语义，结果走独立 job notification，不写入 session timeline。
- 桌面端继续使用 direct continuous 链路；手机 `/remote` 继续通过 shared-host attachment 和 replayable session/task 边界恢复状态。

## 通信规则

### Transport bypass

Agent 侧 NDJSON transport 必须让以下消息绕过串行 processing queue：

- response
- error response
- `session/stop`
- `prompt/enhance/cancel`

原因：response / error response 是已有反向 request 的完成信号，不能再等待当前 request handler 结束；stop / cancel 是控制信号，必须能打断后台操作。

### `session/compact`

`session/compact` 是 session-scoped model operation。

请求处理只做：

1. 校验 session、revision 和 active turn。
2. 处理重复 compact：若当前 active turn 已是 compact，返回 `already_running`。
3. 创建并登记 `AbortController`。
4. 启动后台 `/compact` turn。
5. 快速返回 ACK snapshot。

完成、失败、中断、跳过等终态继续由现有 compact timeline event 和 snapshot 表达。调用方不能把 `session/compact` 的返回值视为 terminal result。

App 侧调用 `session/compact` 时使用 compact 专用 ACK timeout，而不是普通 request 的 30 秒默认值。原因是 compact 涉及模型维护态、较大的 session snapshot、以及历史/兼容 agent 可能仍有分钟级处理窗口；30 秒会把可恢复的压缩误判为 stale agent。该长 timeout 只保护 ACK 边界，不改变后台 compact 终态仍由 timeline / snapshot 驱动的语义。

建议结果结构保留旧字段，并增加 compact metadata：

```ts
{
  response: "",
  snapshot,
  compact: {
    state: "accepted" | "already_running",
    inputId?: string,
    operationId?: string
  }
}
```

`session/stop` 仍通过 `record.activeAbortController` 中断后台 compact。

### `prompt/enhance`

`prompt/enhance` 是 workspace/session-associated utility model job，不是 session turn。

协议拆成：

- `prompt/enhance/start`
- `prompt/enhance/cancel`
- `prompt/enhance/result`，agent -> app notification

`start` 快速返回：

```ts
{
  requestId: string,
  accepted: true
}
```

后台 job 完成后发送 notification：

```ts
{
  requestId: string,
  status: "completed" | "failed" | "cancelled",
  enhanced?: string,
  errorMessage?: string
}
```

`prompt/enhance/start` 参数必须带 `requestId`，并支持可选 `sessionId`。有 `sessionId` 时使用该 session 的模型配置和 provider runtime headers；没有 session 时才按 workspace 创建临时 app。这样同 workspace 多 session 不会随机复用第一个 active session 的模型状态。

UI 的“取消增强”必须调用 `prompt/enhance/cancel`，不能只让旧结果失效。UI 仍需保留 requestId 防覆盖，避免取消后或用户继续编辑后，旧 result 覆盖新输入。

## App / Service 责任

- `ZCodeAgentService.enhancePrompt()` 可继续对 UI 暴露 Promise，但内部应封装 start、result notification 和 cancel。
- service 持有 pending prompt enhance job；relay 和 desktop main 只做透传，不持有业务状态。
- `ZCodeSessionService.compactSession()` 和 task facade 的 `compactSession()` 返回 ACK 后不再广播 terminal snapshot；终态由 session event / snapshot 同步驱动。
- 手机 replayable 路径不得绕过 shared host，也不得把 prompt enhance job 状态下沉到 relay/main。

## 验证清单

- `/compact` ACK 使用 compact 专用长 timeout，压缩完成由 timeline 更新。
- `/compact` 期间同 workspace 其他 session 能 read/create/send。
- `/compact` 期间 `session/stop` 能中断压缩。
- compact 模型请求前的 provider runtime headers response 不被队列阻塞。
- prompt enhance 超过 30 秒不触发 stale agent dispose。
- prompt enhance cancel 会真实 abort agent 侧模型请求，旧 result 不覆盖用户后续输入。
- 同 workspace 多 session 下，prompt enhance 使用当前 session 的模型配置。
- 手机 `/remote` 的 compact 状态通过 replayable snapshot/timeline 恢复。

## 反向请求的会话路由与终止保证（2026-09-09 追记）

### 现象

2026-09-09 的用户日志（`zcode-logs-20260909-035718`，构建 3.11.2 / c4d5b5bc）里，两个 dwf run
（`dwfrun-920daa62` 5 个子代理、`dwfrun-5e8d371f` 3 个子代理，provider 都是
`builtin:bigmodel-start-plan`）的全部 8 个子代理各自打出一条 `model.request.started` 之后再无
任何事件，直到 80 分钟后日志导出：没有完成、没有失败、也没有 `model.stream.stalled`（600 秒
stream idle 计时器要等首个 SSE 事件才起跑，请求根本没发出去）。CLI 侧每个子代理的最后一行是
`zcode_protocol.session.require_missing`，桌面侧对应 8 条
`zcode-agent.respondProviderRuntimeHeaders FAIL … Session is not active: sess_dwf-…`；同一天主会话
的 38 次同类交换全部 OK。

### 根因链路

```
2026-09-09T06:35:38Z  dwfrun-920daa62 / actor_1_1..actor_1_5

 actor runtime            CLI protocol server          desktop service        UI
   │ attempt 1 前置刷新          │                            │                │
   ├─ refreshBeforeModelRequest(sessionId = sess_dwf-…-actor_1_1)              │
   │                            ├─ interaction/requestProviderRuntimeHeaders ─►│
   │                            │                            ├─ 安全校验 ─────►│
   │                            │                            │◄─ headers ─────┤
   │                            │◄─ updateRuntimeModelConfig(sess_dwf-…) ──────┤
   │                            ├─ requireSession → sessionUnavailable         │
   │                            │  （throw 发生在 client.respond 之前）         │
   │                            │                            ╳ respond 永不发出 │
   │ ⏳ 永久等待：requestClient 无 timeout，abort 之外没有第二个出口             │
   │ 🎫 且此时准入票据已持有（admitAttempt 在 resolveModelForAttempt 之前）      │
```

两条独立缺陷叠加：

1. **路由身份取错**。子 runtime 有两条身份轴，代码里只有一条：

   ```
   账本身份 sessionId                      路由身份 clientSessionId
   ├─ 事件持久化 / transcript              ├─ interaction/requestPermission
   ├─ trace 归档                           ├─ interaction/requestProviderRuntimeHeaders
   └─ session store                        └─ interaction/requestUserInput
      子 runtime = 自己                       子 runtime = 父（递归到根）
   ```

   `ProviderRuntimeHeadersPort.refreshBeforeModelRequest` 过去在入参里收 `sessionId`，core 的调用点
   填 `runtime.sessionId`。core 内建 subagent 靠一个私有包装
   （`createSubagentProviderRuntimeHeadersPort`）把它换成父会话；dwf actor 与 legacy workflow child
   两处装配直接把 `appOptions.providerRuntimeHeadersPort` 原样塞进 runtime deps，于是发出的是子会话
   身份。同一处漂移也发生在 `permissionBroker`：core 包了
   `createSubagentInteractionBroker`，另两处没有——dwf actor 的 permission / AskUserQuestion 一旦发生，
   会走同一条死路。**私有包装存在本身就是接口设计错了的信号**：只要调用点还能选 sessionId，第 N 个
   child 装配点就会再错一次。

2. **反向请求的 response 不是无条件的**。桌面 `respondProviderRuntimeHeaders` 先做副作用
   （把 runtime model config 推给该 session），副作用抛错时 `pending.client.respond(...)` 根本没执行。
   2026-08-16 的 web 远控卡死（headers 请求滞留 `pendingProviderRuntimeHeaders`）是同一类失败的另一个
   触发点。

### 契约

**契约 1：面向客户端的端口在构造期绑定路由身份，调用点不传 sessionId。**

- runtime 侧的 `ProviderRuntimeHeadersPort.refreshBeforeModelRequest` 入参**不再有** `sessionId`。
- workspace 级实现仍然是会话参数化的，单独命名为 `SessionRoutedProviderRuntimeHeadersPort`，
  只出现在 `ZCodeAppOptions` 与协议装配层。
- 两者之间只有一座桥 `bindProviderRuntimeHeadersPort(port, clientSessionId)`，绑定唯一发生在
  create-app 为**主** runtime 装配时。类型上未绑定端口进不了 runtime deps，调用点因此无从选错。

**契约 2：child runtime 的对外端口只能由父 runtime 铸造。**

- `AgentRuntime.createChildClientPorts(context)` 是唯一出口，内部走 `deriveChildClientPorts`；
  `parentSessionId` 由父 runtime 自己填，调用方给不了。
- 三处 child 装配（core subagent、dwf actor `script-workflow-child-runtime.ts`、legacy
  `workflow-facade.ts`）统一经它取 `permissionBroker` 与 `providerRuntimeHeadersPort`，不再各自从
  `appOptions` 取。
- 任意深度自动收敛到根会话，无需额外规则：
  - `providerRuntimeHeadersPort` 已绑定、无会话参数，透传即幂等；
  - `permissionBroker` 每层改写 `request.sessionId`，**外层（离客户端更近的一层）后写**，最终值是根；
    `origin` 反过来保留最内层已有值，子代理归属不被外层覆盖。

**契约 3：反向请求的 response 无条件发出。**

- `respondProviderRuntimeHeaders` 的副作用（runtime model config 推送）失败不得吞掉 response：
  改为副作用异常 → 先 `respond({ headersApplied: false, errorMessage })`，再把原异常上抛给调用方。
- CLI 侧收到 `headersApplied:false` 会按既有路径抛 `ProtocolRequestError(-32031)`，attempt 以真实原因
  失败，而不是永久挂起。
- 这里**不**加 requestClient 超时：官方版本的安全校验交互合法地可以等用户数分钟，超时只会把一种猜测换成另一种；
  请求已随 run 的 abort signal 取消，response 有保证之后不需要第二个出口。

### 验证清单

| 断言 | 覆盖方式 |
|---|---|
| dwf actor 的 headers 刷新走父 runtime 的已绑定端口，且入参不再有 `sessionId` | `bootstrap/tests/script-workflow-child-runtime.test.ts`（真实 adapter attempt 链路） |
| 父铸造的 permission broker 带父会话身份 + 子代理 origin | 同上 |
| 嵌套两层时 `sessionId` 收敛到根、`origin` 保留最内层 | `core/tests/child-client-ports.test.ts` |
| core subagent 路由行为不变（私有包装删除后由统一派生覆盖） | `core/tests/subagent-explore.test.ts`（含「端口入参不得再出现 sessionId」回归守卫） |
| 桌面侧 runtime model config 推送抛错时 CLI 仍收到 response | `packages/services/test/zcodeAgentService.providerRegistry.test.ts` |
| 未绑定的 `SessionRoutedProviderRuntimeHeadersPort` 进不了 runtime deps | `pnpm typecheck`（两个类型不兼容，三处 child 装配都在 src 内） |
| legacy workflow child 与 dwf actor 走同一次派生 | 同一调用点 + 类型；facade 目前没有测试装配，无独立用例 |

> **追记 2026-09-11（与 staging 同步：契约 1 的实现形态改变，契约 2 不变）**
>
> staging 的 provider 重构（`docs/working-memory/provider-refactor/`）让 core 的
> `ProviderRuntimeHeadersPort.refreshBeforeModelRequest` 入参**重新带 `sessionId`**（官方版本
> 安全校验的重试也经它），主 runtime 填 `runtime.sessionId`。于是「构造期绑定、入参无 sessionId」
> 这一形态不再成立，`bindProviderRuntimeHeadersPort` 与 `SessionRoutedProviderRuntimeHeadersPort`
> 随之删除。契约 1 的**意图**——调用点选不错路由身份——改由契约 2 的派生层兑现：
> `deriveChildClientPorts` 对 `providerRuntimeHeadersPort` 也包一层，把入参的 `sessionId` 改写成
> 父会话；多层嵌套外层后写，最终值必然是根会话（与 `permissionBroker` 同一条规则）。三处 child 装配
> （core subagent、dwf actor、legacy workflow child）仍只经 `AgentRuntime.createChildClientPorts`。
> 验证清单里「入参不再有 sessionId」的两行改为断言 `routedSessionId === 父会话`
> （`script-workflow-child-runtime.test.ts`、`subagent-explore.test.ts`）。「桌面侧 runtime model
> config 推送抛错时 CLI 仍收到 response」一行：staging 重写了 `respondProviderRuntimeHeaders`
> （账号鉴权材料解析失败 → `headersApplied: false` + 原因，仍无条件回包），我们那条针对旧
> `updateRuntimeModelConfig` 副作用的用例随旧路径删除，契约 3 由新实现保持。

**契约 4：Browser Use 是唯一「账本身份上线」的反向请求。**

`interaction/browserList` / `interaction/browserExecute` 的 `sessionId` 不是路由身份，而是桌面
browser backend 的 **tab 归属**（`docs/browser-use/2026-07-14-browser-tab-conversation-isolation-spec.md`，
scope key 含 `sessionId`）。桌面 service 对这两个方法是纯中继，不按 `sessionId` 找 task；需要从会话
解析的只有 CLI 侧 `buildBrowserRequestContext` 填的 workspace（`workspaceKey` / `workspacePath` /
`workspaceIdentity` / `remoteSessionId`）与 `clientMode`。所以 dwf actor 的浏览器请求：

```
actor runtime (sess_dwf-…-actor_2_1)
  │ mcp__node_repl__js  _meta.session_id = actor
  ▼
node_repl broker socket ──► ProtocolBrowserControlBroker（每个 server context 一份状态）
                              │ sessions.get(actor) 缺席
                              │ childSessionParents.get(actor) = 父会话  ← forChildSession 登记
                              │ requireSession(父会话) → workspace / clientMode
                              ▼
                  interaction/browserExecute { sessionId: actor, workspace…: 父会话的 }
                              ▼
                  desktop main：scope = (…, workspaceKey, sessionId=actor, clientMode)
```

- 登记只能由父 runtime 的端口派生：`BrowserControlPort.forChildSession({childSessionId, parentSessionId})`
  返回的子端口在 `closeSession` 发出 `{ method: "closeSession", closeTabs: true }` 之后撤销登记。
  没有登记的非客户端会话一律 `Session is not active`，不按 id 形状猜父会话。
- dwf actor 与 core `Agent` subagent 拿子端口：dwf actor（`tabOwner: "child"`）的 runtime 在 run dispose 时
  `closeBrowserSession`，连 tab 关闭；core subagent 用 `tabOwner: "parent"`，下发的 `sessionId` 换成父会话
  （与当前对话共用 tab，面板据此展开），子端口的 turnEnded / closeSession 不发往桌面，closeSession 只撤销登记
  （`docs/browser-use/2026-07-16-subagent-browser-unavailable-spec.md`）。legacy `Workflow` child 没有关闭链路，
  不给。细节见 `apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md`「Subagent sessions」。
- 同一 server context 里 `createProtocolBrowserControlBroker` 被调用两次（进程级 node_repl broker 与每个
  app 的 runtime 端口）。连接记忆（`turnEnded` / `closeSession` 要发往哪些 browser）与子会话登记都必须
  按 context 共享：node_repl 流量走进程级实例，生命周期走 app 实例；分开存时 app 实例从未见过连接，
  `turnEnded` / `closeSession` 从不到达桌面。
