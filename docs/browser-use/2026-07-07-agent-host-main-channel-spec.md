# agent→host→main browser 执行通道规格（T4）

> 状态：已实现。
> 上位：`2026-07-07-browser-use-cdp-node-repl-spec.md`；依赖 T3 的 `BrowserControlPort` + `interaction/browserExecute` 协议。
> 范围：打通 agent 的 `BrowserControlPort.execute` → ZCode Protocol → host router → parentPort → main 的三腿通道。T4 不含 main 侧 CDP 执行（T5 提供 executor，T4 桥先返回 stub/透传到一个可注入的 main handler）。

## 1. 三腿链路

```
agent: BrowserControlPort.execute(cmd)   [ProtocolBrowserControlBroker]
  → context.requestClient("interaction/browserExecute", {requestId,sessionId,command}, resultSchema)
      │ stdio JSON-RPC 反向请求
host: zcodeAgentService client.onRequest case interactionBrowserExecute
  → 校验 params → browserControlMainBridge.execute({sessionId,command}) → client.respondResult/respondError
  （纯 RPC 中继：不 emitSessionEvent、不 pending sessionEvent，区别于 permission）
      │ parentPort.postMessage(BrowserExecuteRequest{requestId,payload}) + pending map
main: desktopHostProcess child.on("message") case BrowserExecuteRequest
  → browserCommandExecutor.execute(...)  [T5 提供；T4 先接一个可注入 executor]
  → child.postMessage(BrowserExecuteResult{requestId,ok,result|error})
      │ host pending map resolve
```

## 2. Leg A：agent broker

- 文件：`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/browser-control-broker.ts`（新）。
  ```ts
  export function createProtocolBrowserControlBroker(
    context: ZCodeProtocolAgentServerContext,
  ): BrowserControlPort {
    return {
      async execute({ sessionId, command }) {
        return context.requestClient(
          zcodeProtocolMethods.interactionBrowserExecute,
          { requestId: randomUUID(), sessionId, command },
          zcodeBrowserExecuteResultSchema,
        );
      },
    };
  }
  ```
- 注入：`server-operations.ts` 的 `createWorkspaceZCodeApp(context, workspace, { ... })` options 对象里，与 `permissionBroker: createProtocolInteractionBroker(context)` 并列加
  `browserControlPort: createProtocolBrowserControlBroker(context)`。`createWorkspaceZCodeApp` 已 `...options` 透传给 createApp（同 providerRuntimeHeadersPort 模式）。

## 3. Leg B：host router + host↔main bridge

### host router（`packages/services/src/zcode-agent/zcodeAgentService.ts` onRequest）
- 在末尾 `respondError(-32601)` 前加 case `request.method === zcodeProtocolMethods.interactionBrowserExecute`：
  - `zcodeBrowserExecuteParamsSchema.safeParse(request.params)`，失败 `respondError(-32602)`。
  - 调 `browserControlMainBridge.execute({sessionId, command})`（注入的可选依赖）。
  - 成功 `client.respondResult(request.id, result)`；异常 `client.respondError(request.id, {code:-32000,message})`。
  - **不** emitSessionEvent、**不**进 pending sessionEvent map（纯 RPC 中继，与 permission 的 UI 阻塞语义不同）。
  - bridge 缺省（非桌面/远控无 main）→ 返回结构化 `{ok:false, error:{code:"backend_unavailable"}}`（不 throw，模型可读）。
- `browserControlMainBridge` 作为 `createZCodeAgentService` 的可选依赖注入（`ZCodeAgentServiceDeps` 加字段），desktop host 装配时传入。

### host↔main bridge（`packages/desktop/src/host/browserControlMainBridge.ts` 新，或并入 host/index.ts）
- 仿 `createFullFeedbackLogArchiveViaMain`：`pendingBrowserExecute = Map<requestId,{resolve,reject,timer}>`；`execute(payload)` → `parentPort.postMessage({type:HostResponseTypes.BrowserExecuteRequest, requestId, payload})` + 超时（默认 30s，navigate/screenshot 可长）。
- `requestId` 是 pending Promise 的 correlation key。Map 已存在同 ID 时必须立即返回
  `duplicate_request_id`，不得覆盖；该规则不按 session/scope 放宽，因为结果回包只携带裸 requestId。
- timeout、发送异常与结果回传只能 compare-and-delete 自己捕获的 `PendingEntry`，不得无条件删除同 key。
- main 回 `HostMessageTypes.BrowserExecuteResult{requestId, ok, result, error}` → host `parentPort.on("message")` 分派 resolve/reject（并入 host/index.ts 现有 message 分派）。
- `channels.ts`：`HostResponseTypes` 加 `BrowserExecuteRequest:"browser-execute-request"`；`HostMessageTypes` 加 `BrowserExecuteResult:"browser-execute-result"`。

## 4. Leg C：main 接收（T4 占位，T5 实现 executor）

- `packages/desktop/src/main/desktopHostProcess.ts` 的 `child.on("message")` 加 case `BrowserExecuteRequest`：
  - T4：调一个注入的 `browserCommandExecutor?.execute(sessionId, command)`；缺省返回 `{ok:false,error:{code:"backend_unavailable",message:"browser executor not ready"}}`。
  - `child.postMessage({type:HostMessageTypes.BrowserExecuteResult, requestId, ...})`。
  - T5 提供真正的 executor（WebContentsView+CDP）。

## 5. 验证点（T4 单测，逻辑层，不起 Electron）

- agent broker：假 `requestClient`（记录 method+params，返回预设 result）→ `execute(cmd)` 发出 `interaction/browserExecute`，requestId 存在、command 透传、result 原样返回。
- host router：假 client（onRequest 触发）+ 假 bridge → browserExecute 命中 bridge.execute、respondResult 被调；params 非法 → respondError(-32602)；bridge 缺省 → backend_unavailable。
- host↔main bridge：假 parentPort（记录 postMessage + 手动回 result）→ execute resolve；超时 → reject/结构化 timeout；requestId 关联正确（并发两条不串）；同 scope 与跨 scope 的并发重复
  requestId 都立即失败且不影响原 entry。

## 6. 边界
- browser/execute 不改变 desktop-continuous / web-remote-replayable 语义：它是 agent→app 的一次性 RPC，不进 stream/snapshot。远控无 main 时 backend_unavailable。
- 单一真相：params/result 用 T3 的 shared zod schema 校验（host router 侧）。
