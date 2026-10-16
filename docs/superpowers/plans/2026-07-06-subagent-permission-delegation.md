# Subagent Blocking Interaction Delegate 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. 当前缺陷正发生在 subagent blocking interaction 路径上，修复前不要依赖 subagent-driven execution 来实施本计划。Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 subagent blocking interaction delegate 语义：child runtime 产生普通权限请求、AskUserQuestion、ExitPlanMode approval 等阻塞交互时，parent-visible interaction channel 负责展示和回包，payload 里保留 child/subagent 归因信息，避免 subagent 内 Bash/AskUserQuestion/ExitPlanMode 等等待用户输入的路径无弹窗卡死。

**Architecture:** 在 ZCode core 层新增 subagent interaction broker delegate，把 child 侧经 `PermissionBrokerPort` 发出的阻塞交互请求对外 `sessionId` 改写为 parent session id，并附带 `origin.kind="subagent"` 元数据。bootstrap 按 toolName 继续分流到 `interaction/requestPermission` 或 `interaction/requestUserInput`，service/task/UI 继续按 parent task/session 路由 pending permission 和 elicitation；用户回包沿现有 protocol request promise 返回 child tool executor。普通权限请求与 ZCode 已拆出的 elicitation channel 统一走这条代理链路，并以 `origin` 元数据标明请求来自哪个 subagent。

**Tech Stack:** TypeScript, Zod schema, ZCode Protocol, core AgentRuntime, services task projection, React UI permission/elicitation surface, Vitest, WDIO manual-review E2E, pnpm.

## Global Constraints

- 先写/更新文档，再实现代码；本文件是本次改动的实施 plan，正式实现时如产品语义有变化，需要同步更新本文件或新增 spec。
- 本次只做 blocking interaction delegate，不做 teammate/swarm/worktree isolation/TaskOutput/TaskStop/完整 SDK control protocol。
- routing identity 用 parent session/task；child identity 只放在 `origin` 元数据中，不能让 UI 直接订阅 child session。
- child runtime 内部事件、model-io、event store 仍使用 child session id，不能为了 UI 弹窗把 child session 改成 parent session。
- `toolCallId` 默认保留 child tool call id；parent `Agent` tool call id 放到 `origin.parentToolCallId`，避免破坏 child tool result 回填。
- permission policy 仍由 child runtime 自己判断；delegate 只代理 ask/user-input 路由，不把 child 权限判定替换成 parent 权限判定。
- desktop continuous 与 web remote replayable 边界不改变：permission pending 和 elicitation pending 投影到 parent task snapshot/event，mobile `/remote` 仍通过 replayable 恢复 parent task 状态。
- 修改 `packages/shared/src/zcode-protocol/index.ts` 时必须使用严格 schema，保持旧调用可兼容。
- 修改 `packages/ui` 前必须先读取根目录 `DESIGN.md`；UI 日志必须用 `packages/ui/src/logger.ts`，不能直接 `console.log`。
- service/runtime 日志遵守项目日志规则：permission request/resolution 属低频生命周期事件可用 `info`，逐条 stream/tool delta 只能用 `debug`。
- 修复代码里的 bug 原因注释使用中文，说明为什么 child blocking interaction 要代理到 parent session。
- 最终必须执行 `pnpm typecheck`、`pnpm lint`，并在提交前执行 `git diff --check`。

---

## 当前事实快照

- 事故票据：`ZCT-2073779059361222656`，用户反馈 subagent 在“变更前确认”模式下执行 Bash 会卡住。
- 现象：child model 已产生 Bash tool call，permission flow 进入 ask，但 parent task 的 pending permission 数为 0，UI 没有弹窗；用户 stop 后 parent `Agent` tool 以取消失败收口。
- 当前 core 已有类似设计样板：`apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts` 里的 `createSubagentProviderRuntimeHeadersPort()` 把 provider runtime headers 的对外 `sessionId` 改成 parent session id，并保留 child runtime 内部账本。
- 当前 service pending key：`packages/services/src/zcode-agent/zcodeAgentService.ts` 用 `workspace + sessionId + requestId` 分别记录 pending permission 和 pending user input；因此只要 blocking request 出协议前改成 parent session id，现有 respond path 可继续工作。
- 当前 task projection：`packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts` 将 permission request 转成 `ZCodePermissionRequest` stream event，并把 `raw` 保留为原始 request。
- AskUserQuestion 和 ExitPlanMode approval 不是普通 permission popup：`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/interaction-broker.ts` 会把它们 special-case 到 `interaction/requestUserInput`，service 再投影成 `elicitation_request`。它们同样会在 subagent child session 里卡住，必须和普通 permission 一起代理到 parent task。
- provider runtime headers（官方版本的安全校验经此链路）也是阻塞交互，但当前 `createSubagentProviderRuntimeHeadersPort()` 已经做 parent session wrapper。本计划只把它纳入回归验证，不重新设计这条链路。

---

## 目标行为

1. parent task 启动 `Agent`，child runtime 中 Bash/Edit/Write/WebFetch 等工具需要权限时，UI 在 parent task 上展示 permission popup。
2. child runtime 中 `AskUserQuestion` 或 `ExitPlanMode` 需要用户输入/计划确认时，UI 在 parent task 上展示 elicitation dialog，而不是 child session 内部静默等待。
3. permission popup 的 approve/deny/modify 能 resolve 原 child permission promise；elicitation dialog 的 accept/decline/cancel 能 resolve 原 child user-input promise。
4. pending permission 和 pending elicitation 的 snapshot/replay 恢复按 parent task 生效，web remote reconnect 后仍能看到未处理的 subagent 阻塞请求。
5. provider runtime headers（含官方版本安全校验）子请求继续通过现有 parent-routed wrapper 展示，不因为本轮改动退化。
6. child session 的 event store、model-io、artifact 路径不被污染成 parent session。
7. 多个 subagent 或多个 child blocking request 同时 pending 时，按 `requestId` 独立处理，不互相覆盖。
8. parent stop/cancel 时，child pending permission/elicitation 能被 abort，不再无限 await。

## 非目标

- 不新增独立的 stdio 权限控制 wire protocol；继续沿用现有 `interaction/requestPermission` / `interaction/requestUserInput` 协议请求。
- 不新增 child session UI tab、child task row 或 UI 对 child session 的直接订阅。
- 不改变 `AskUserQuestion`、`ExitPlanMode` 的产品交互语义；本轮只改变它们在 subagent 内发生时的 parent routing 和 origin 归因。
- 不改变 permission ruleset、project approval 持久化格式或权限决策算法。
- 不引入 durable permission outbox；当前仍沿用 protocol request promise 和 service pending map。
- 不修 background idle wake、SendMessage、subagent output footer 等相邻 subagent 问题。

---

## Phase 0: 预检与边界确认

**Files:**
- Read: `docs/superpowers/plans/2026-07-06-subagent-permission-delegation.md`
- Read: 历史差异审计文档（已删除）
- Read: `docs/cli-background-subagent-wake-plan.md`
- Read: `apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts`
- Read: `apps/zcode-cli/packages/core/src/tool/executor/permission-flow.ts`
- Read: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/interaction-broker.ts`
- Read: `packages/services/src/zcode-agent/zcodeAgentService.ts`
- Read: `packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts`
- Read: `packages/shared/src/zcode-protocol/index.ts`

**Checklist:**

- [ ] 确认 worktree 干净或只存在与本任务无关的用户改动：`git status --short`。
- [ ] 重新阅读 `createSubagentProviderRuntimeHeadersPort()`，把它作为 blocking interaction delegate 的注释和路由参考。
- [ ] 确认 `resolveToolPermission()` 中普通 tool permission 走 `deps.permissionBroker.requestPermission(...)`。
- [ ] 确认 `createProtocolInteractionBroker()` 会把 `AskUserQuestion` 分流到 `requestUserInput()`，把 `ExitPlanMode` 分流到 `requestExitPlanModeApproval()`，普通工具走 `requestPermission()`。
- [ ] 确认 `requestPermission()`、`requestUserInput()`、`requestExitPlanModeApproval()` 当前都没有透传 `origin`。
- [ ] 确认 `zcodeAgentService` 的 `pendingPermissions` key 使用 request params 的 `sessionId`。
- [ ] 确认 `zcodeAgentService` 的 `pendingUserInputs` key 同样使用 request params 的 `sessionId`。
- [ ] 确认 `zcodeTaskServiceAdapter.respondPermission()` 和 `respondElicitation()` 传给 agent service 的 `sessionId` 是 parent `taskId`。
- [ ] 不做任何代码修改，直到 Phase 1 的 failing test 计划写清楚。

**验收标准:**

- [ ] 能用一句话说明根因：child blocking request 使用 child session id 出协议，desktop/service/UI pending permission/elicitation 只按 parent task/session 路由，导致用户看不到也无法响应。
- [ ] 能用一句话说明设计：child 内部账本保持 child session，对外阻塞交互请求通过 parent session 路由，并携带 child origin。

---

## Phase 1: 协议与类型扩展

**Goal:** 在 contracts/shared protocol/task stream 类型中增加可选 `origin` 字段，表达 subagent 来源；所有旧 permission/user-input request 不传该字段时行为完全不变。

**Files:**
- Modify: `apps/zcode-cli/packages/contracts/src/interfaces/permission.port.ts`
- Modify: `packages/shared/src/zcode-protocol/index.ts`
- Modify: `packages/shared/src/zcode-task-types.ts`
- Test: schema/type 相关现有测试；必要时新增 shared schema test

**Interfaces:**

- Produces: `InteractionRequestOrigin`
- Produces: `ZCodeInteractionRequestOrigin`
- Produces: `origin?: ...` on protocol permission request params, protocol user-input request params, permission requested event payload, pending permission snapshot, task stream permission request, task stream elicitation request

### Checklist

- [ ] 在 `apps/zcode-cli/packages/contracts/src/interfaces/permission.port.ts` 增加 origin 类型。

建议代码形状：

```ts
export interface SubagentInteractionRequestOrigin {
  kind: "subagent";
  parentSessionId: SessionId;
  childSessionId: SessionId;
  agentId?: string;
  agentType?: string;
  description?: string;
  parentToolCallId?: ToolCallId | string;
  parentTurnId?: TurnId;
  childTurnId?: TurnId;
}

export type InteractionRequestOrigin = SubagentInteractionRequestOrigin;
```

- [ ] 给 `PermissionBrokerRequest` 增加可选字段。

```ts
export interface PermissionBrokerRequest {
  requestId: string;
  sessionId: SessionId;
  turnId?: TurnId;
  traceId: TraceId;
  toolCallId: ToolCallId;
  toolName: string;
  input: unknown;
  mode: CollaborationMode;
  ruleId: string;
  reason: string;
  riskLevel: RiskLevel;
  sideEffectScope?: ModelToolSideEffectScope;
  requestedAt: Date;
  origin?: InteractionRequestOrigin;
}
```

- [ ] 在 `packages/shared/src/zcode-protocol/index.ts` 增加 `zcodeInteractionRequestOriginSchema`。

建议 schema：

```ts
export const zcodeInteractionRequestOriginSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("subagent"),
      parentSessionId: nonEmptyString,
      childSessionId: nonEmptyString,
      agentId: nonEmptyString.optional(),
      agentType: nonEmptyString.optional(),
      description: z.string().optional(),
      parentToolCallId: nonEmptyString.optional(),
      parentTurnId: nonEmptyString.optional(),
      childTurnId: nonEmptyString.optional(),
    })
    .strict(),
]);
export type ZCodeInteractionRequestOrigin = z.infer<
  typeof zcodeInteractionRequestOriginSchema
>;
```

- [ ] 给以下 schema 增加 `origin: zcodeInteractionRequestOriginSchema.optional()`：
  - `zcodePendingPermissionSchema`
  - `zcodePermissionRequestedEventPayloadSchema`
  - `zcodePermissionRequestParamsSchema`
  - `zcodeUserInputRequestParamsSchema`

- [ ] 在 `packages/shared/src/zcode-task-types.ts` 从 `zcode-protocol/index.js` import `ZCodeInteractionRequestOrigin`，并给 `ZCodePermissionRequest` 和 `ZCodeElicitationRequest` 增加：

```ts
origin?: ZCodeInteractionRequestOrigin;
```

- [ ] 检查所有构造 `ZCodePermissionRequest` 的地方，旧路径不需要强制补 origin。
- [ ] 检查所有构造 `ZCodeElicitationRequest` 的地方，旧路径不需要强制补 origin。
- [ ] 运行类型检查的快速子集。

Commands:

```bash
pnpm exec tsc -b packages/shared
pnpm --dir apps/zcode-cli exec tsc -b packages/contracts
```

Expected:

```text
无 TypeScript error
```

**风险点:**

- `z.discriminatedUnion` 只有一个成员也可用；如果当前 zod 版本或 lint 不接受，改为 `z.object(...).strict()` 并命名为单一 subagent origin schema。
- 不要把 `origin` 设成必填，否则会破坏所有普通 permission/user-input request。

---

## Phase 2: Core subagent blocking interaction delegate

**Goal:** child runtime 仍用 child session 做事件和工具执行，但经 `PermissionBrokerPort` 发出的普通 permission、AskUserQuestion、ExitPlanMode approval 都向 parent permission broker 发起 parent-routed blocking request，并带上 child origin。

**Files:**
- Create: `apps/zcode-cli/packages/core/src/runtime/helpers/subagent-interaction-broker.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts`
- Test: `apps/zcode-cli/packages/core/tests/subagent-interaction-broker.test.ts`
- Optional Test: `apps/zcode-cli/packages/core/tests/subagent-explore.test.ts`

**Interfaces:**

- Consumes: `PermissionBrokerPort`, `PermissionBrokerRequest`, `PermissionBrokerRequestOptions`
- Produces: `createSubagentInteractionBroker(parentBroker, context): PermissionBrokerPort`

### Checklist

- [ ] 先新增 failing unit test：`apps/zcode-cli/packages/core/tests/subagent-interaction-broker.test.ts`。

测试应覆盖：

```ts
it("routes child permission requests through the parent session with subagent origin", async () => {
  const parentSessionId = createSessionId("parent");
  const childSessionId = createSessionId("subagent_agent_test");
  const seen: PermissionBrokerRequest[] = [];
  const parentBroker: PermissionBrokerPort = {
    async requestPermission(request) {
      seen.push(request);
      return { decision: "allow", reason: "approved" };
    },
  };

  const broker = createSubagentInteractionBroker(parentBroker, {
    agentId: "agent_test",
    agentType: "general-purpose",
    childSessionId,
    description: "Run command",
    parentSessionId,
    parentToolCallId: "call_parent_agent",
    parentTurnId: createTurnId("parent"),
  });

  const result = await broker.requestPermission({
    input: { command: "date" },
    mode: "build",
    reason: "Bash requires approval",
    requestId: "perm_child",
    requestedAt: new Date("2026-07-06T00:00:00.000Z"),
    riskLevel: "medium",
    ruleId: "mode.build.sideEffect",
    sessionId: childSessionId,
    toolCallId: createToolCallId("child_bash"),
    toolName: "Bash",
    traceId: createTraceId("trace"),
    turnId: createTurnId("child"),
  });

  expect(result).toMatchObject({ decision: "allow" });
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({
    requestId: "perm_child",
    sessionId: parentSessionId,
    toolCallId: "child_bash",
    toolName: "Bash",
    origin: {
      kind: "subagent",
      parentSessionId,
      childSessionId,
      agentId: "agent_test",
      agentType: "general-purpose",
      parentToolCallId: "call_parent_agent",
    },
  });
});
```

实现时按当前 test utils 调整 `createTraceId` 这类 helper；不要为了测试引入生产依赖变更。

- [ ] 增加第二个 failing test：`AskUserQuestion` request 也必须被改写到 parent session，但保留 `toolName: "AskUserQuestion"` 和 child `toolCallId`。
- [ ] 增加第三个 failing test：`ExitPlanMode` request 也必须被改写到 parent session，并且 `origin.childTurnId` 来自 child request `turnId`。
- [ ] 实现 `createSubagentInteractionBroker()`。

建议代码形状：

```ts
import type {
  PermissionBrokerPort,
  PermissionBrokerRequest,
  PermissionBrokerRequestOptions,
  PermissionBrokerResult,
  SessionId,
  ToolCallId,
  TurnId,
} from "../deps.js";

interface SubagentInteractionBrokerContext {
  agentId: string;
  agentType: string;
  childSessionId: SessionId;
  description?: string;
  parentSessionId: SessionId;
  parentToolCallId?: ToolCallId | string;
  parentTurnId?: TurnId;
}

export function createSubagentInteractionBroker(
  parentBroker: PermissionBrokerPort | undefined,
  context: SubagentInteractionBrokerContext,
): PermissionBrokerPort | undefined {
  if (!parentBroker) return undefined;

  return {
    requestPermission(
      request: PermissionBrokerRequest,
      options?: PermissionBrokerRequestOptions,
    ): Promise<PermissionBrokerResult> {
      // 修复原因：subagent 的事件和 model-io 使用 child session，但桌面/远控阻塞交互只订阅
      // parent task。对外 permission / AskUserQuestion / ExitPlanMode 请求必须代理到 parent
      // session，否则用户看不到弹窗，child 会一直 await。
      return parentBroker.requestPermission(
        {
          ...request,
          sessionId: context.parentSessionId,
          origin: {
            kind: "subagent",
            parentSessionId: context.parentSessionId,
            childSessionId: context.childSessionId,
            agentId: context.agentId,
            agentType: context.agentType,
            description: context.description,
            parentToolCallId: context.parentToolCallId,
            parentTurnId: context.parentTurnId,
            childTurnId: request.turnId,
          },
        },
        options,
      );
    },
  };
}
```

- [ ] 在 `subagent.ts` 中 import `createSubagentInteractionBroker`。
- [ ] 将 child `AgentRuntime` deps 里的 permission broker 从：

```ts
permissionBroker:
  childMode === "yolo" ? createDenyPermissionBroker() : this.permissionBroker,
```

改成：

```ts
permissionBroker:
  childMode === "yolo"
    ? createDenyPermissionBroker()
    : createSubagentInteractionBroker(this.permissionBroker, {
        agentId: request.agentId,
        agentType: request.agentType,
        childSessionId: request.sessionId,
        description: request.description,
        parentSessionId: this.sessionId,
        parentToolCallId: traceStringAttribute(request.traceContext, "parentToolCallId"),
        parentTurnId: request.traceContext.turnId,
      }),
```

- [ ] 确认 Explore `permissionService` 仍为只读配置，general-purpose/custom 仍继承 parent permission service。
- [ ] 确认 `childMode === "yolo"` 仍使用 `createDenyPermissionBroker()`，不弹窗。
- [ ] 确认该 wrapper 对所有 `PermissionBrokerPort.requestPermission()` 调用统一生效；bootstrap 后续会按 `toolName` 决定进入 permission popup 还是 elicitation dialog。
- [ ] 跑 focused core test。

Commands:

```bash
pnpm --filter @zcode/core exec vitest run tests/subagent-interaction-broker.test.ts
pnpm --dir apps/zcode-cli exec vitest run packages/core/tests/subagent-tool-events.test.ts
```

Expected:

```text
PASS packages/core/tests/subagent-interaction-broker.test.ts
PASS packages/core/tests/subagent-tool-events.test.ts
```

**风险点:**

- `request.toolCallId` 不要改成 parent `Agent` tool call id。
- 不要把 child runtime 的 `sessionId` 构造改成 parent session id。
- 如果 `request.agentId` 在类型上不是必填，先追到 `SubagentRuntimeRequest`/runner 生命周期，保证 delegate context 拿到 lifecycle agent id。

---

## Phase 3: Protocol broker 透传 origin

**Goal:** core delegate 生成的 `origin` 能穿过 bootstrap protocol broker 到 service；普通权限走 `interaction/requestPermission`，AskUserQuestion/ExitPlanMode 走 `interaction/requestUserInput`，三条路径都保留 parent-routed session 和 child origin。

**Files:**
- Modify: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/interaction-broker.ts`
- Test: existing bootstrap protocol tests；必要时新增 `apps/zcode-cli/packages/bootstrap/tests/interaction-broker.test.ts`

### Checklist

- [ ] 给 `requestPermission()` 的 `context.requestClient(...)` params 加上 `origin: request.origin`。

目标代码片段：

```ts
const response = await context.requestClient(
  zcodeProtocolMethods.interactionRequestPermission,
  {
    input: request.input,
    origin: request.origin,
    reason: request.reason,
    requestId: request.requestId,
    riskLevel: request.riskLevel,
    sessionId: request.sessionId,
    options: buildProtocolPermissionOptions(request),
    toolCallId: request.toolCallId,
    toolName: request.toolName,
    turnId: request.turnId,
  },
  zcodePermissionResponseSchema,
  withInteractionRequestRecovery(options),
);
```

- [ ] 给 `requestUserInput()` 的 `interactionRequestUserInput` params 加上 `origin: request.origin`。

目标代码片段：

```ts
const response = await context.requestClient(
  zcodeProtocolMethods.interactionRequestUserInput,
  {
    input: request.input,
    origin: request.origin,
    prompt: request.reason,
    questions: parsed.data.questions.map(mapAskUserQuestion),
    requestId: request.requestId,
    schema: { toolName: request.toolName },
    sessionId: request.sessionId,
    toolCallId: request.toolCallId,
    toolName: request.toolName,
    turnId: request.turnId,
  },
  zcodeUserInputResponseSchema,
  withInteractionRequestRecovery(options),
);
```

- [ ] 给 `requestExitPlanModeApproval()` 的 `interactionRequestUserInput` params 加上 `origin: request.origin`。

目标代码片段：

```ts
const response = await context.requestClient(
  zcodeProtocolMethods.interactionRequestUserInput,
  {
    input: request.input,
    origin: request.origin,
    prompt: request.reason,
    questions: [createExitPlanModeApprovalQuestion()],
    requestId: request.requestId,
    schema: { interaction: "plan_approval", toolName: request.toolName },
    sessionId: request.sessionId,
    toolCallId: request.toolCallId,
    toolName: request.toolName,
    turnId: request.turnId,
  },
  zcodeUserInputResponseSchema,
  withInteractionRequestRecovery(options),
);
```

- [ ] 如果 TypeScript 提示 `PermissionBrokerRequest` 没有 origin，回到 Phase 1 修 contracts export。
- [ ] 扩展 `apps/zcode-cli/packages/bootstrap/tests/zcode-protocol.test.ts` 里的 AskUserQuestion bridge 测试：构造带 `origin.kind="subagent"` 的 broker request，断言 outgoing `interaction/requestUserInput.params.origin` 保留。
- [ ] 扩展 ExitPlanMode bridge/reannounce 测试：断言首次 request 和 reannounce request 都保留相同 `origin`。
- [ ] 跑 bootstrap 相关测试。

Commands:

```bash
pnpm --dir apps/zcode-cli exec vitest run packages/bootstrap/tests/subagents.test.ts
```

Expected:

```text
PASS packages/bootstrap/tests/subagents.test.ts
```

**风险点:**

- `origin: undefined` 在 JSON-RPC 序列化后是否出现不重要；schema optional 可接受缺省或 undefined 被丢弃。
- 不要在 bootstrap 里重新构造 origin，避免 agentId/parentToolCallId 与 core 不一致。
- reannounce request 必须沿用同一业务 `origin`，否则 reconnect 后 UI 能恢复弹窗但丢失 subagent 归因。

---

## Phase 4: Service pending 与 task projection

**Goal:** service 继续按 parent session/task 记录 pending permission 和 pending user input，同时把 `origin` 投影到 task stream 和 snapshot，支持 UI 与 remote 恢复。

**Files:**
- Modify: `packages/services/src/zcode-agent/zcodeAgentService.ts`
- Modify: `packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts`
- Test: `packages/services/test/zcodeAgentService.test.ts`
- Test: adapter 相关测试；如果没有现成覆盖，新增 focused test

**Interfaces:**

- Consumes: `ZCodePermissionRequestParams.origin`
- Consumes: `ZCodeUserInputRequestParams.origin`
- Produces: `ZCodePermissionRequest.origin`
- Produces: `ZCodeElicitationRequest.origin`
- Produces: `ZCodeSessionStateSnapshot.projection.pendingPermissions[].origin`
- Produces: task runtime snapshot `pendingElicitations[].origin`

### Checklist

- [ ] 在 `zcodeAgentService` 的 `interaction/requestPermission` 分支确认 parsed params 已带 `origin`。
- [ ] 在 `zcodeAgentService` 的 `interaction/requestUserInput` 分支确认 parsed params 已带 `origin`。
- [ ] pending key 仍使用 parsed `sessionId`，也就是 parent-routed session id。
- [ ] emit event 时保持：

```ts
emitSessionEvent(workspace, parsed.data.sessionId, {
  type: "permission.request",
  request: parsed.data,
});
```

不要改成 `origin.childSessionId`。

- [ ] user input event 也保持 parent session：

```ts
emitSessionEvent(workspace, parsed.data.sessionId, {
  type: "userInput.request",
  request: parsed.data,
});
```

不要改成 `origin.childSessionId`。

- [ ] 若 service 有 snapshot projection 的 pending permission 构造逻辑，确保 origin 从 event payload 或 pending request 保留下来。
- [ ] 在 `PendingPermissionRequest` 或独立 pending user-input 结构里保存 `request`，让 `pendingUserInputs` 可以在 task snapshot 中恢复成 `pendingElicitations`。
- [ ] 在 `zcodeTaskServiceAdapter.ts` 的 `permissionRequestToStreamEvent()` 中加：

```ts
origin: request.origin,
```

- [ ] 在 `pendingPermissionToStreamEvent()` 中加：

```ts
origin: permission.origin,
```

- [ ] 在 `userInputRequestToElicitationStreamEvent()` 中加：

```ts
origin: request.origin,
```

- [ ] 在 `pendingAskUserQuestionToElicitationEvent()` 和 `pendingExitPlanModeToElicitationEvent()` 中加：

```ts
origin: permission.origin,
```

- [ ] 如果采用 task-adapter 本地 map 记录 live pending user inputs，命名建议：

```ts
const pendingElicitationsByTaskKey = new Map<string, Map<string, ZCodeElicitationRequest>>();
```

并在收到 `userInput.request` 时 upsert，在 `userInput.response`、task terminal、session close 时删除。

- [ ] `snapshotToTask()` 生成 runtime snapshot 时，把 agent projection 里由 pending permission 映射出的 elicitation 与 `pendingElicitationsByTaskKey` 合并，按 `requestId` 去重；live map 里的 parent-routed user input 应优先，因为它保留真实 protocol request 的 origin 和 schema。
- [ ] `raw` 继续保留完整 request/pending permission，便于 UI preview 和日志排查。
- [ ] `respondPermission()` 路径保持 `sessionId: params.taskId`，不新增 child session response 分支。
- [ ] `respondElicitation()` 路径保持 `sessionId: params.taskId`，不新增 child session response 分支。
- [ ] 新增 service test：fake agent 发 `interaction/requestPermission`，params.sessionId 是 parent，origin.childSessionId 是 child；断言 service event/session event 的 sessionId 是 parent 且 request.origin 保留。
- [ ] 新增 service test：fake agent 发 `interaction/requestUserInput`，params.sessionId 是 parent，origin.childSessionId 是 child；断言 `userInput.request` 的 sessionId 是 parent 且 request.origin 保留；`respondUserInput(parentSessionId, requestId)` 能响应原 protocol request。
- [ ] 新增或扩展 adapter test：permission stream event 的 `taskId` 是 parent task，`origin.kind === "subagent"`。
- [ ] 新增或扩展 adapter test：elicitation stream event 的 `taskId` 是 parent task，`origin.kind === "subagent"`；snapshot 恢复时 `runtime.pendingElicitations` 也保留 origin。

建议 fake request 片段：

```js
send({
  id: "permission-request-1",
  method: "interaction/requestPermission",
  params: {
    sessionId: "sess-parent",
    requestId: "perm-child-bash",
    toolCallId: "call_child_bash",
    toolName: "Bash",
    reason: "Bash requires approval",
    riskLevel: "medium",
    input: { command: "date" },
    options: [
      {
        optionId: "approve",
        label: "Approve",
        response: { decision: "allow" },
      },
      {
        optionId: "deny",
        label: "Deny",
        response: { decision: "deny", reason: "Rejected" },
      },
    ],
    origin: {
      kind: "subagent",
      parentSessionId: "sess-parent",
      childSessionId: "sess_subagent_agent_test",
      agentId: "agent_test",
      agentType: "general-purpose",
      parentToolCallId: "call_parent_agent",
    },
  },
});
```

- [ ] 跑 focused service test。

Commands:

```bash
pnpm vitest run packages/services/test/zcodeAgentService.test.ts
```

Expected:

```text
PASS packages/services/test/zcodeAgentService.test.ts
```

**风险点:**

- 不要新增 `pendingPermissions` key 的 child fallback，否则 approve 时可能找不到 original protocol request id。
- 不要新增 `pendingUserInputs` key 的 child fallback，否则 AskUserQuestion/ExitPlanMode 回答时可能找不到 original protocol request id。
- 不要在 service 里根据 `origin.childSessionId` emit child session event；UI 不订阅 child session，这会回到原 bug。
- reannounce 逻辑仍按同一业务 `requestId + parent sessionId` 登记，不能因为 origin 变化重复弹窗。
- AskUserQuestion/ExitPlanMode 的 `permission.requested` runtime event 仍会由 child session 内部产生；parent snapshot 恢复不能只依赖 parent session projection，必须把 live `pendingUserInputs` / `userInput.request` 路径也纳入 task runtime snapshot。

---

## Phase 5: UI 最小兼容与可选来源展示

**Goal:** 现有 permission dialog 和 elicitation dialog 都能处理带 `origin` 的 request；不需要 UI 订阅 child session。可选显示 subagent 来源，但第一阶段以不破坏现有弹窗/问答体验为主。

**Files:**
- Read before UI edit: `DESIGN.md`
- Modify if needed: `packages/ui/src/...`
- Test: `packages/ui/test/permissionRequest.test.ts`
- Test: `packages/ui/test/permissionDialog.test.ts`
- Test: elicitation 相关 UI tests；如无现成覆盖，新增 focused test

### Checklist

- [ ] 先读根目录 `DESIGN.md`。
- [ ] 搜索 UI permission/elicitation request 消费点。

Commands:

```bash
rg -n "permission_request|PermissionRequest|permissionRequest|pendingPermissions|respondPermission|elicitation_request|Elicitation|elicitationRequest|pendingElicitations|respondElicitation" packages/ui/src packages/ui/test
```

- [ ] 确认 UI 对未知 `raw.origin` 不会崩溃。
- [ ] 确认 UI 对 `ZCodeElicitationRequest.origin` 不会崩溃。
- [ ] 如果 `ZCodePermissionRequest` 或 `ZCodeElicitationRequest` 是 exhaustively destructured，需要补 `origin` 可选字段。
- [ ] 可选展示：在 dialog 的辅助文案里只展示短来源，例如 `来自 subagent: general-purpose`。不要显示 child session id、agent internal id，除非 debug UI 已有类似入口。
- [ ] 如果添加 UI copy，确认中英文 i18n；不要硬编码单语言可见文案。
- [ ] 如果添加日志，使用 `packages/ui/src/logger.ts`。
- [ ] 补 UI test：带 `origin.kind="subagent"` 的 `ZCodePermissionRequest` 能打开 dialog，点击 approve 后调用 parent `taskId/requestId`。
- [ ] 补 UI test：带 `origin.kind="subagent"` 的 `ZCodeElicitationRequest` 能打开 elicitation dialog，点击 accept/submit 后调用 parent `taskId/requestId`。
- [ ] 跑 UI focused tests。

Commands:

```bash
pnpm vitest run packages/ui/test/permissionRequest.test.ts packages/ui/test/permissionDialog.test.ts
```

Expected:

```text
PASS packages/ui/test/permissionRequest.test.ts
PASS packages/ui/test/permissionDialog.test.ts
```

**风险点:**

- UI 不要拿 `origin.childSessionId` 调 `respondPermission()`。
- UI 不要拿 `origin.childSessionId` 调 `respondElicitation()`。
- UI 不要把 subagent permission/elicitation 变成新的 task row。
- 如果暂无 UI 改动也能通过测试，本 phase 可以只补类型/test，不强行改视觉。

---

## Phase 6: Conversation E2E catalog/matrix 与手动验收用例

**Goal:** 按项目规则，conversation 相关交互 bug 先补 catalog/matrix，再写具体 E2E pending case。

**Files:**
- Modify: `docs/conversation-session-case-catalog.md`
- Modify: `docs/testing/conversation-session-e2e-coverage-matrix.md`
- Create: `packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-subagent-blocking-interaction-delegate.test.ts`

### Checklist

- [ ] 在 `docs/conversation-session-case-catalog.md` 增加 accepted cases，建议 ID 放在 subagent/permission 相邻区域；如果现有 catalog 没有 subagent 小节，新增小节 `L. Subagent blocking interaction delegate`。

建议 case：

| ID | 前置状态 | 用户/系统事件 | 规则命中 | 期望结果 | Review |
| --- | --- | --- | --- | --- | --- |
| L01 | `build/变更前确认`，parent task 调用 `Agent`，child 需要执行 Bash | child 发起 Bash permission request | subagentPermissionDelegatesToParent | parent task 出现权限确认；approve 后 child Bash 执行并回填 Agent 结果；deny 后 child 收到 permission denied；stop 清理 pending | accepted |
| L02 | parent task 调用 `Agent`，child 调用 `AskUserQuestion` | child 发起 user input request | subagentAskUserQuestionDelegatesToParent | parent task 出现 elicitation dialog；accept 后答案回填 child tool input，child 继续；cancel/decline 后 child 得到拒绝；stop 清理 pending | accepted |
| L03 | parent task 调用 `Agent`，child 在 plan mode 中调用 `ExitPlanMode` | child 发起 plan approval request | subagentExitPlanModeDelegatesToParent | parent task 出现 plan approval elicitation；approve 后 child 退出计划模式；反馈/拒绝后以 `plan_approval_feedback` 返回 child；stop 清理 pending | accepted |
| L04 | child model request 触发 provider runtime headers（含官方版本安全校验） | child 发起 provider runtime headers request | subagentProviderHeadersAlreadyDelegateToParent | 继续复用现有 parent-routed provider runtime headers wrapper；不出现 child session 独立 UI 订阅；回包只影响本次 child model request，不误切 parent model | accepted |

- [ ] 在 `docs/testing/conversation-session-e2e-coverage-matrix.md` 的测试缩写表增加 `SBI`。

建议行：

```md
| `SBI` | `packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-subagent-blocking-interaction-delegate.test.ts` |
```

- [ ] 在矩阵统计/覆盖表中将新增 case 标为 `missing` 或 `partial`，直到 E2E 文件落地。
- [ ] 新增 manual-review pending WDIO case，覆盖四个分支：
  - approve：parent permission dialog 出现，点击 approve，child Bash 有输出，parent Agent 不卡死。
  - deny：点击 deny，child tool 返回 permission denied，parent Agent 正常收口。
  - ask-user-question：parent elicitation dialog 出现，提交答案后 child AskUserQuestion tool result 含用户答案。
  - exit-plan-mode：parent plan approval elicitation 出现，approve/feedback 后 child 得到正确 allow 或 `plan_approval_feedback`。
  - provider runtime headers：复核 child provider runtime headers request 仍走 parent session，且不会被本轮改动破坏。
  - stop：pending permission / elicitation 时 stop parent task，dialog 清理，child 不再 pending。
  - replayable snapshot：如果现有 helper 支持 remote/reconnect，断言 pending permission 和 pending elicitation 在 snapshot 中按 parent task 恢复；如果暂不支持，在 spec 中标记为 manual 待补。
- [ ] 该 E2E 放在 `manual-review/pending`，不要直接进入默认门禁，直到 replay/fixture 稳定。
- [ ] 跑 coverage audit 或至少跑相关文档检查脚本；如果本仓库没有单独脚本，跑 `pnpm lint` 时覆盖 markdown formatting。

**风险点:**

- 不要把这个 case 混入 background subagent wake 或 provider registry cold-start。
- 不要为了造 case 改产品默认 permission mode；测试 fixture 应明确设成 build/ask 模式。

---

## Phase 7: 集成回归与事故票验证

**Goal:** 用 focused tests 和真实事故形态证明卡死消失。

**Files/Artifacts:**
- Existing ticket artifacts under `/tmp/ZCT-2073779059361222656/`
- Core/service/UI tests from previous phases
- Optional local runtime repro script or manual desktop run

### Checklist

- [ ] 运行所有新增/修改的 focused tests。

Commands:

```bash
pnpm --filter @zcode/core exec vitest run tests/subagent-interaction-broker.test.ts
pnpm vitest run packages/services/test/zcodeAgentService.test.ts
pnpm vitest run packages/ui/test/permissionRequest.test.ts packages/ui/test/permissionDialog.test.ts
```

Expected:

```text
全部 PASS
```

- [ ] 运行完整 repo gates。

Commands:

```bash
pnpm typecheck
pnpm lint
git diff --check
```

Expected:

```text
pnpm typecheck 无 error
pnpm lint 无 error
git diff --check 无 whitespace error
```

- [ ] 手动或 E2E 验证事故核心路径：
  - 新建 task，设置“变更前确认”或等价 ask mode。
  - 请求 parent `Agent` 让 subagent 执行一个 Bash，例如 `python3 -c "from datetime import datetime; print(datetime.now())"`。
  - 观察 parent task 出现 permission dialog。
  - approve 后 Bash 执行，Agent 返回结果。
  - deny 后 Agent 返回权限拒绝，不无限 pending。
- [ ] 手动或 E2E 验证 AskUserQuestion 路径：
  - 请求 parent `Agent` 让 subagent 先调用 `AskUserQuestion` 澄清一个二选一问题。
  - 观察 parent task 出现 elicitation dialog。
  - accept 后 child tool result 中包含用户答案，Agent 继续执行。
  - cancel/decline 后 child 不无限 pending。
- [ ] 手动或 E2E 验证 ExitPlanMode 路径：
  - 让 child 进入 plan mode 后调用 `ExitPlanMode`。
  - 观察 parent task 出现 plan approval elicitation。
  - approve 后 child 退出 plan mode；反馈文本后 child 收到 `plan_approval_feedback`。
- [ ] 回归 provider runtime headers（含官方版本安全校验）路径：child model request 触发 headers refresh 时仍按 parent session 弹出/同步，且不误切 parent session 当前模型。
- [ ] 验证日志中能看到 parent session 的 permission/user-input request/resolved，且 origin 里有 child session/agent id。
- [ ] 验证 child model-io 仍写到 `model-io-sess_subagent_agent_*.jsonl`，没有写入 parent session artifact。
- [ ] 验证 parent task snapshot 的 `pendingPermissions` / `pendingElicitations` 在对应 dialog 出现时长度为 1，response 后清零。
- [ ] 如果无法完整验证 mobile `/remote`，在提交说明中明确列出待补验证：web remote replayable snapshot/reconnect pending permission 和 pending elicitation。

---

## Phase 8: 最终整理与提交

**Goal:** 保持 diff 小而清楚，提交信息符合 Conventional Commits/MR 规范。

**Checklist:**

- [ ] `git status --short` 检查只包含本任务相关文件。
- [ ] `git diff --stat` 确认改动范围符合本计划。
- [ ] 检查新增中文注释是否只解释 bug 原因，不重复代码含义。
- [ ] 检查没有把 child session id 用作 UI response target。
- [ ] 检查没有新增直接跨层导入或循环依赖。
- [ ] 检查没有把 `origin` 设成必填。
- [ ] 运行最终 gates：

```bash
pnpm typecheck
pnpm lint
git diff --check
```

- [ ] 提交。

建议 commit message：

```bash
git add docs/superpowers/plans/2026-07-06-subagent-permission-delegation.md \
  apps/zcode-cli/packages/contracts/src/interfaces/permission.port.ts \
  apps/zcode-cli/packages/core/src/runtime/helpers/subagent-interaction-broker.ts \
  apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts \
  apps/zcode-cli/packages/core/tests/subagent-interaction-broker.test.ts \
  apps/zcode-cli/packages/bootstrap/src/zcode-protocol/interaction-broker.ts \
  packages/shared/src/zcode-protocol/index.ts \
  packages/shared/src/zcode-task-types.ts \
  packages/services/src/zcode-agent/zcodeAgentService.ts \
  packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts \
  packages/services/test/zcodeAgentService.test.ts \
  docs/conversation-session-case-catalog.md \
  docs/testing/conversation-session-e2e-coverage-matrix.md \
  packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-subagent-blocking-interaction-delegate.test.ts

git commit -m "fix: delegate subagent blocking interactions to parent task"
```

如果 UI phase 无需修改，不要把 UI 文件加入 `git add`。

---

## Rollback Plan

- 如果 Phase 1 schema 引起大面积类型波动：先保留 contracts `origin`，只撤回 shared/task stream 投影，确认 core delegate 能编译后再重新推进。
- 如果 Phase 2 core delegate 导致 child permission policy 或 elicitation routing 异常：回滚 `permissionBroker` 注入到原逻辑，并保留 failing test 作为待修问题。
- 如果 service response 找不到 pending：检查 parent-routed `sessionId` 是否在 bootstrap 出协议前已经改写；不要在 service 里补 child fallback。
- 如果 UI 不显示但 service 已有 pending：普通 permission 检查 task stream event 是否从 `permissionRequestToStreamEvent(parentTaskId, request)` 发出；elicitation 检查 `userInputRequestToElicitationStreamEvent(parentTaskId, request)` 和 runtime `pendingElicitations`。
- 如果 mobile remote 恢复异常：先确认 desktop continuous 主路径不回退，再单独审 `clientMode` / `deliveryKind` snapshot 恢复路径。

---

## Self-Review Checklist

- [ ] 每个 phase 都有明确修改文件和验证命令。
- [ ] plan 没有要求 UI 订阅 child session。
- [ ] plan 没有把 child tool call id 替换成 parent tool call id。
- [ ] plan 明确了 child permission policy 不变，只代理 ask/user-input 路由。
- [ ] plan 覆盖了普通 permission、AskUserQuestion、ExitPlanMode 和 provider runtime headers（含官方版本安全校验）。
- [ ] plan 覆盖了 approve、deny、accept、decline、stop、snapshot/replayable 六类验收。
- [ ] plan 覆盖了 docs catalog/matrix 的项目要求。
- [ ] plan 没有把 teammate/swarm/worktree isolation 混入本轮范围。
- [ ] plan 最终 gates 包含 `pnpm typecheck`、`pnpm lint` 和 `git diff --check`。

---

## 2026-07-24 V4 权威投影回归修订

### 运行时证据与根因

2026-07-24 的本机日志复现了 T01：

- main session `sess_fe2e609e-...` 中普通 `AskUserQuestion` 在
  `2026-07-24T05:23:21.849Z` 进入 `decision=ask`，随后在
  `2026-07-24T05:23:25.171Z` 正常 `permission resolved`。
- 同一 main session 启动的 child session `sess_subagent_agent_a12c56f2-...`
  在 `2026-07-24T05:24:03.041Z` 对 `AskUserQuestion` 进入 `decision=ask`，
  但没有对应的 `permission resolved`；用户停止前一直等待。
- child 的 `permission_requested` 只按 child session 写入事件链；parent 只收到
  `user_input_auto_resolution_updated`，没有收到能创建
  `ProductProjection.pendingInteractions` 的 `permission_requested`。

原修复保证了 `PermissionBrokerPort` 的反向 RPC 使用 parent session，并携带
`origin.kind=subagent`。V4 成为对话 UI 权威源后，弹窗不再能只依赖反向 RPC/task-local
pending map；`ProductProjection` 必须先在 parent conversation topic 中看到
`PermissionRequested`。当前 `mirrorSubagentToolEvent()` 只镜像普通 tool lifecycle，
遗漏 `PermissionRequested`、`PermissionResolved` 和 `PermissionDenied`，因此 broker
promise 已在等待，但 main task 没有可渲染、可提交的 pending interaction。

### 修订后的权威链路

```text
child AgentRuntime
  |
  | child PermissionRequested(toolCallId=childTool)
  +-----------------------------> child event store / child projection
  |
  `-- parent live mirror
        sessionId = parentSession
        toolCallId = mirroredParentTool
        origin = { kind: subagent, childSessionId, parentSessionId, ... }
             |
             v
        parent ProductProjection.pendingInteractions
             |
             v
        V4InteractionDialogs (main task)
             |
             | resolveInteraction(requestId)
             v
        parent-routed interaction registry / broker promise
             |
             v
        child PermissionResolved
             |
             +-------------------> child event store / child projection
             `-- parent live mirror --> clear parent pending interaction
```

### Impact Brief

| Field | Value |
| --- | --- |
| Developer intent | 恢复 subagent 内权限和 `AskUserQuestion` 在 main task 展示、响应并继续 child |
| Capability | Subagents + conversation blocking interactions |
| Change layer | validation + recovery |
| Operating mode | planning |
| Primary seeds | `createSubagentInteractionBroker`、`mirrorSubagentToolEvent`、`ProductProjection.onPermissionRequested`、`V4InteractionDialogs` |
| Out of scope | 不新增 child task/UI 订阅；不改变权限判定；不把 replayable 恢复语义扩散到 desktop continuous |

#### UI Surface Matrix

| User scenario | UI entry | Shared implementation | Display owner | Validation/gating | Commit action | Authority | Mode boundary | Isolation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| child `AskUserQuestion` | main task elicitation dialog | `V4InteractionDialogs` → `ElicitationDialog` | parent `ProductProjection.pendingInteractions` | child permission service 判定为 `ask` | `resolveInteraction(requestId)` | parent conversation projection + child broker promise | desktop continuous；mobile 仅沿既有 replayable snapshot/gap | child event store/model-io 保持 child session |
| child 普通 permission | main task permission dialog | `V4InteractionDialogs` → `PermissionDialog` | parent `ProductProjection.pendingInteractions` | child permission ruleset | `resolveInteraction(requestId)` | 同上 | 同上 | 同上 |
| child `ExitPlanMode` | main task plan approval dialog | 与 user-input interaction 共用 | parent projection | plan mode + child tool policy | `resolveInteraction(requestId)` | 同上 | 本轮只做同一投影链路回归，不新增独立 E2E 组合 | 同上 |

#### Shared And Divergent Behavior

| Concern | Shared | Deliberately different | Why |
| --- | --- | --- | --- |
| Request identity | `requestId` 在 child、parent mirror 和 interaction registry 间保持不变 | parent projection 使用镜像后的 tool row id；child executor 保留 child tool call id | UI 能锚定 parent tool row，同时 response 仍释放原 child promise |
| Persistence | raw child interaction events 继续写 child session | parent interaction event 只走 live mirror，不重复写 parent event store | 防止污染 parent transcript，同时让 V4 live projection 可见 |
| Delivery | parent projection 同时服务 desktop 与 replayable snapshot | desktop 不拼接 mobile 恢复消息 | 保持现有 clientMode/deliveryKind 边界 |

#### Ranked Relationships

| Rank | From | Edge | To | Evidence |
| --- | --- | --- | --- | --- |
| must-inspect | child runtime event sink | live mirror | parent `ProductProjection` | `runtime/methods/subagent.ts`、`subagent/tool-event-mirror.ts` |
| must-inspect | parent `PermissionRequested` | creates | `pendingInteractions` | `zcode-protocol-v4/product-projection.ts` |
| must-inspect | `pendingInteractions` | renders | `V4InteractionDialogs` | `packages/ui/src/v4/V4InteractionDialogs.tsx` |
| should-inspect | parent `PermissionResolved/Denied` | settles | pending interaction/tool row | `ProductProjection.settlePermission()` |
| invariant-only | raw child event | persists to | child session only | runtime event store + detached child topic |
| conditional | parent conversation projection | recovers via | web remote replayable | 既有 conversation topic snapshot/gap；本轮不改 main/relay/owner |

#### Must-Preserve Invariants

- `requestId` 不改写；child broker response 仍按原 request promise 收口。
- child tool call id 不写入 parent tool row；parent mirror 使用稳定镜像 id，并在
  `childToolCallId`/`origin` 保留归因。
- parent mirror 只进入 live sink，不重复落 parent event store。
- legacy reverse RPC 与 V4 `resolveInteraction` 继续竞速且幂等；不得新增第二套 response 路由。
- desktop `desktop-continuous` 与手机 `web-remote-replayable` 仍消费同一个 parent
  canonical projection，但恢复节奏保持隔离。

#### Codegraph Evidence

当前仓库没有 `.codegraph/` 索引；按 skill 约束回退到 `rg` 和逐文件静态阅读。展开深度为 2：

```text
createDefaultSubagentPort
  -> child AgentRuntime.eventSink
  -> mirrorSubagentToolEvent
  -> bootstrap onSessionEvent
  -> conversation topic ProductProjection
  -> V4InteractionDialogs
```

#### Graph Drift And Confirmed Delta

现有功能语义图只记录 Subagent 配置表单/Markdown 持久化，没有记录运行时阻塞交互。
本次把 parent blocking-interaction surface、child runtime owner 和 interaction broker
写回 `.agents/skills/feature-boundary-planner/references/zcode-feature-graph.yaml`。

### 用例剪枝与实现交接

| Candidate | Status | Reason |
| --- | --- | --- |
| T01 child `AskUserQuestion` parent projection | bug-candidate → accepted | 已有产品语义与真实失败日志；必须修 |
| T02 child Bash permission parent projection | accepted | 与 T01 共用同一 permission event mirror，只保留代表单测 |
| child `ExitPlanMode` | accepted, representative-only | 共用 `PermissionRequested`/user-input broker；不新增状态排列 |
| concurrent/background child | pruned | event mirror 按 agent/tool/request identity 工作；并发与后台不改变本次根因 |
| mobile reconnect | ignored for implementation E2E | 不修改 replay/snapshot schema；保留现有 parent canonical projection 不变量 |
| workspace/remote identity | pruned by invariant | 本次不改 workspace key、remoteSessionId 或 attachment |

本轮不新建 conversation E2E case：T01/T02 和 `SD` 已存在。先补 core 的 parent interaction
event mirror 回归测试，并把 coverage matrix 从错误的 `covered` 修正为 `partial`；`SD` 仍在
`manual-review/pending`，待单独完成人工 review/promotion 后才能恢复 `covered`。
