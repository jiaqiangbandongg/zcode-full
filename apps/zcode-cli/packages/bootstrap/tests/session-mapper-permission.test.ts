// Legacy v3 边界：新增的 ask 预览字段不能漏进 strict schema。
import { describe, expect, it } from "vitest";
import {
  EventReducer,
  SessionEventType,
  createSessionEvent,
  type EventId,
  type SessionEvent,
  type SessionId,
  type ToolCallId,
  type TraceId,
} from "@zcode/contracts";
import { zcodeSessionEventSchema, zcodeSessionProjectionSchema } from "@zcode/shared";
import {
  mapSessionEvent,
  mapSessionProjection,
  shouldExposeSessionEventToProtocol,
} from "../src/zcode-protocol/session-mapper.js";

function permissionRequestedEvent(payload: Record<string, unknown>): SessionEvent {
  return {
    id: "legacy-permission-event" as EventId,
    sessionId: "legacy-session" as SessionId,
    type: SessionEventType.PermissionRequested,
    timestamp: new Date(1_700_000_000_000),
    traceId: "legacy-trace" as TraceId,
    sequenceNumber: 1,
    payload,
  };
}

describe("legacy permission.requested 映射", () => {
  const basePayload = {
    requestId: "req-1",
    toolCallId: "tc-1" as ToolCallId,
    toolName: "CreateWorkflow",
    riskLevel: "low",
    reason: "createWorkflow.runConfirmation",
    input: { script: "return 1;" },
  };

  it("剥离 ask 预览，映射结果仍能过 strict schema", () => {
    // zcodePermissionRequestedEventPayloadSchema 是 .strict()，而 app 侧用 safeParse 解析
    // 收到的事件：多一个未知字段就会让它丢掉整个事件，确认窗根本到不了旧版 app。
    const mapped = mapSessionEvent(
      permissionRequestedEvent({
        ...basePayload,
        display: { kind: "create_workflow", ok: true, errorCount: 0, diagnostics: [] },
        optionsPolicy: "no-always-allow",
      }),
    );

    const parsed = zcodeSessionEventSchema.safeParse(mapped);
    expect(parsed.success).toBe(true);
    expect(mapped.payload).not.toHaveProperty("display");
    expect(mapped.payload).not.toHaveProperty("optionsPolicy");
  });

  /**
   * 可复用工作流的归一化入参在 legacy v3 上的成立性（spec 的「版本偏斜边界」）。
   *
   * 这条钉的是整个「入参通道」决策：saved run 的脚本走的是 `input`，而 legacy 侧
   * `input` 是 `z.unknown()`（zcode-protocol/index.ts）——所以旧客户端拿到完整脚本
   * **不是兼容处理，是构造上就成立**。相对地，把脚本放进 display 会被上面那条剥离
   * 逻辑整段抹掉，saved run 会在一个不显示任何代码的窗口上被批准。
   */
  it("saved run 的归一化入参整份过 strict schema，脚本不被剥离", () => {
    const normalizedInput = {
      name: "nightly",
      script:
        'interface R { done: boolean }\nconst r = await agent("w").ask<R>("do");\nreturn r.done;',
      saved: {
        name: "nightly",
        args: { depth: 3, target: "packages/core" },
        path: "/repo/.zcode/workflows/nightly.dwf.ts",
        scope: "project",
      },
    };

    const mapped = mapSessionEvent(
      permissionRequestedEvent({
        ...basePayload,
        input: normalizedInput,
        display: { kind: "create_workflow", ok: true, errorCount: 0, diagnostics: [] },
        optionsPolicy: "no-always-allow",
      }),
    );

    expect(zcodeSessionEventSchema.safeParse(mapped).success).toBe(true);
    // display 照旧被剥离（legacy 拿不到图），但入参一个字段都没少——旧桌面的
    // readWorkflowScript(raw.script) / readWorkflowName(raw.name) 因此命中。
    expect(mapped.payload).not.toHaveProperty("display");
    expect((mapped.payload as { input: unknown }).input).toEqual(normalizedInput);
  });

  /**
   * SaveWorkflow 在 legacy v3 上的同一条论证：v1 刻意不加 `save_workflow` display kind，
   * 所以旧客户端得到的是通用权限提示 + **完整的**入参 JSON（落点、覆盖判定、脚本俱全）。
   */
  it("SaveWorkflow 的归一化入参同样整份过 strict schema", () => {
    const normalizedInput = {
      name: "pr-review",
      description: "Review a pull request",
      script: "return 1;",
      path: "/repo/.zcode/workflows/pr-review.dwf.ts",
      overwrite: true,
      scope: "project",
    };

    const mapped = mapSessionEvent(
      permissionRequestedEvent({
        ...basePayload,
        toolName: "SaveWorkflow",
        reason: "saveWorkflow.confirmation",
        input: normalizedInput,
        optionsPolicy: "no-always-allow",
      }),
    );

    expect(zcodeSessionEventSchema.safeParse(mapped).success).toBe(true);
    expect((mapped.payload as { input: unknown }).input).toEqual(normalizedInput);
  });

  it("仍按策略把选项收窄成允许一次 + 拒绝", () => {
    const mapped = mapSessionEvent(
      permissionRequestedEvent({ ...basePayload, optionsPolicy: "no-always-allow" }),
    );

    const options = (mapped.payload as { options: { optionId: string }[] }).options;
    expect(options.map((option) => option.optionId)).toEqual(["allow_once", "deny"]);
    // 绊线（docs/dynamic-workflow/launch.md「Refine」）：Refine 只在 v4 投影合成，
    // legacy 选项列表刻意不含——旧桌面没有 textarea，选它只等于哑拒绝。
    expect(options.some((option) => option.optionId === "workflowRefine")).toBe(false);
  });

  // 第 7 轮：会话免确认只在 v4 投放。旧桌面回传的是 response 原文，认不出会话语义，
  // 投放它只会得到一个名不副实的「一次允许」——legacy 把策略降为 no-always-allow。
  it("session-always-allow 在 legacy 上降为允许一次 + 拒绝，且过 strict schema", () => {
    const mapped = mapSessionEvent(
      permissionRequestedEvent({ ...basePayload, optionsPolicy: "session-always-allow" }),
    );

    expect(zcodeSessionEventSchema.safeParse(mapped).success).toBe(true);
    expect(mapped.payload).not.toHaveProperty("optionsPolicy");
    const options = (mapped.payload as { options: { optionId: string; kind: string }[] })
      .options;
    expect(options.map((option) => option.optionId)).toEqual(["allow_once", "deny"]);
    expect(options.some((option) => option.kind === "allow_session")).toBe(false);
  });

  it("未声明策略的工具保持默认三个选项", () => {
    const mapped = mapSessionEvent(
      permissionRequestedEvent({ ...basePayload, toolName: "Bash", input: { command: "ls" } }),
    );

    const options = (mapped.payload as { options: { optionId: string }[] }).options;
    expect(options.map((option) => option.optionId)).toEqual([
      "allow_once",
      "allow_project",
      "deny",
    ]);
  });

  /**
   * SaveWorkflow 走的是同一条收窄：它的 `askOptions.allowAlways: false`（core 的工具声明）
   * 经 approval-gate 变成 `optionsPolicy: "no-always-allow"` 随事件传播（不变式 3）。
   *
   * 「没有 always allow」在这里不是审美：写进仓库的东西会被提交、被别人看见、以后被再次
   * 运行，一条持久项目规则记不住"这一次的决定"，只会把这道确认永久关掉。
   */
  it("SaveWorkflow 同样收窄成允许一次 + 拒绝，且不含 workflowRefine", () => {
    const mapped = mapSessionEvent(
      permissionRequestedEvent({
        ...basePayload,
        toolName: "SaveWorkflow",
        reason: "saveWorkflow.confirmation",
        input: {
          name: "pr-review",
          description: "Review a pull request",
          script: "return 1;",
          path: "/repo/.zcode/workflows/pr-review.dwf.ts",
          overwrite: true,
          scope: "project",
        },
        optionsPolicy: "no-always-allow",
      }),
    );

    const options = (mapped.payload as { options: { optionId: string }[] }).options;
    expect(options.map((option) => option.optionId)).toEqual(["allow_once", "deny"]);
    // 同一条绊线在保存窗上的对应物：Refine 只在 v4 投影合成，legacy 列表两个工具都不含。
    expect(options.some((option) => option.optionId === "workflowRefine")).toBe(false);
  });

  // 这条是"下一个人往 spread 里加字段"的绊线：带 display 的 permission_requested 走完
  // reducer pick → PendingPermission → mapPendingPermission 之后，产物必须同时过
  // zcodePermissionRequestedEventPayloadSchema 与 zcodePendingPermissionSchema 两个
  // strict schema。任一处漏剥离，这里就会红。
  it("带 display 的请求经两个 legacy mapper 后同时通过两个 strict schema", () => {
    const sessionId = "legacy-session" as SessionId;
    const display = {
      kind: "create_workflow",
      ok: true,
      errorCount: 0,
      diagnostics: [],
      causalityGraph: {
        steps: [
          {
            id: "ask#1",
            kind: "ask",
            label: "a",
            line: 2,
            column: 11,
            lane: "actor#1",
          },
        ],
        lanes: [{ id: "actor#1", name: "a" }],
        // 第二层是子代理导向：每阶段一张参与者卡 + 交接边（docs/dynamic-workflow/presentation.md）。
        participants: [{ id: "unphased:actor#1", phase: "unphased", lane: "actor#1", steps: ["ask#1"] }],
        handoffs: [],
        sink: ["ask#1"],
      },
    };
    const askPayload = { ...basePayload, display, optionsPolicy: "no-always-allow" };

    // 事件通道。
    const mappedEvent = mapSessionEvent(permissionRequestedEvent(askPayload));
    expect(zcodeSessionEventSchema.safeParse(mappedEvent).success).toBe(true);

    // 快照通道：先让 reducer 真的把 display 收进 PendingPermission，再过 legacy 映射。
    const projection = new EventReducer().reduce([
      createSessionEvent(SessionEventType.SessionCreated, sessionId, {
        mode: "build",
        contextWindow: 200_000,
      }),
      createSessionEvent(SessionEventType.PermissionRequested, sessionId, askPayload),
    ]);
    expect(projection.pendingPermissions[0]?.display).toEqual(display);

    const mappedProjection = mapSessionProjection(projection);
    const parsedProjection = zcodeSessionProjectionSchema.safeParse(mappedProjection);
    expect(parsedProjection.success).toBe(true);
    const pending = mappedProjection.pendingPermissions[0]!;
    expect(pending).not.toHaveProperty("display");
    expect(pending).not.toHaveProperty("optionsPolicy");
    // 策略的效果仍然落地：过协议的是已经裁掉 allow_always 的两项列表。
    expect(pending.options.map((option) => option.optionId)).toEqual(["allow_once", "deny"]);
  });

  /**
   * 归一化入参的**快照通道**：上面两条 saved / SaveWorkflow 的断言走的是事件通道
   * （mapSessionEvent），而冷启动的旧客户端是从 projection 里读 pendingPermissions 的。
   * 两条通道各有一个 strict schema，任一处把 input 收窄成结构化形状，脚本就在那一面消失。
   */
  it("两个工具的归一化入参在快照通道上同样整份存活", () => {
    const sessionId = "legacy-session" as SessionId;
    const savedRunInput = {
      name: "release-check",
      script: 'return await agent("检查员").ask<string>("检查一遍");',
      saved: {
        name: "release-check",
        args: { target: "packages/core", depth: 3, skipTests: false },
        path: "/repo/.zcode/workflows/release-check.dwf.ts",
        scope: "project",
      },
    };
    const saveInput = {
      name: "release-check",
      description: "对本仓库做一次发布前检查",
      script: "return 1;",
      path: "/repo/.zcode/workflows/release-check.dwf.ts",
      overwrite: true,
      scope: "project",
    };

    const projection = new EventReducer().reduce([
      createSessionEvent(SessionEventType.SessionCreated, sessionId, {
        mode: "build",
        contextWindow: 200_000,
      }),
      createSessionEvent(SessionEventType.PermissionRequested, sessionId, {
        ...basePayload,
        input: savedRunInput,
        display: { kind: "create_workflow", ok: true, errorCount: 0, diagnostics: [] },
        optionsPolicy: "no-always-allow",
      }),
      createSessionEvent(SessionEventType.PermissionRequested, sessionId, {
        ...basePayload,
        requestId: "req-2",
        toolCallId: "tc-2" as ToolCallId,
        toolName: "SaveWorkflow",
        reason: "saveWorkflow.confirmation",
        input: saveInput,
        optionsPolicy: "no-always-allow",
      }),
    ]);

    const mapped = mapSessionProjection(projection);
    expect(zcodeSessionProjectionSchema.safeParse(mapped).success).toBe(true);
    expect(mapped.pendingPermissions.map((pending) => pending.input)).toEqual([
      savedRunInput,
      saveInput,
    ]);
    for (const pending of mapped.pendingPermissions) {
      expect(pending).not.toHaveProperty("display");
      expect(pending.options.map((option) => option.optionId)).toEqual(["allow_once", "deny"]);
    }
  });
});

// Legacy v3 边界：dwf run 进度事件在协议边界剥离（与 StreamingToolLedgerUpdated 同一个 seam、
// 同一个理由）。见 docs/dynamic-workflow/presentation.md「The run state the pane draws」。
describe("legacy v3 剥离 dwf run 进度事件", () => {
  function runProgressEvent(): SessionEvent {
    return {
      id: "dwf-progress-event" as EventId,
      sessionId: "legacy-session" as SessionId,
      type: SessionEventType.DynamicWorkflowRunProgress,
      timestamp: new Date(1_700_000_000_000),
      traceId: "legacy-trace" as TraceId,
      sequenceNumber: 3,
      payload: {
        runId: "dwfrun-1",
        toolCallId: "tc-1" as ToolCallId,
        sequence: 5,
        eventType: "node-settled",
        payload: { instance: { siteId: "ask#1", ordinal: 1 }, outcome: "ok" },
      },
    };
  }

  it("不透出到 v3 协议流", () => {
    // 剥离**不是**为了防丢事件：mapSessionEventType 的 default 会落到 session.updated，
    // 而那个信封的 payload 是宽松的 jsonObjectSchema，所以旧桌面本来也收得下。
    // 剥离的理由是带宽与语义干净——v4 面已有权威投影（workflowRuns），v3 mapper 不消费它。
    expect(shouldExposeSessionEventToProtocol(runProgressEvent())).toBe(false);
  });

  it("与 StreamingToolLedgerUpdated 同一个判定，且不影响其它事件", () => {
    expect(
      shouldExposeSessionEventToProtocol({
        ...runProgressEvent(),
        type: SessionEventType.StreamingToolLedgerUpdated,
      }),
    ).toBe(false);
    expect(
      shouldExposeSessionEventToProtocol({
        ...runProgressEvent(),
        type: SessionEventType.BackgroundTaskStarted,
      }),
    ).toBe(true);
  });

  it("万一被透出，映射结果仍过 strict schema（v3 侧没有状态键要剥）", () => {
    // 这条是"下一个人把剥离拆掉"的绊线：即便剥离没了，映射产物也不能让旧桌面丢弃整条事件。
    const mapped = mapSessionEvent(runProgressEvent());
    expect(zcodeSessionEventSchema.safeParse(mapped).success).toBe(true);
    // v3 的 zcodeSessionProjectionSchema 是 .strict() 且根本没有 subagents 这类状态面，
    // 所以不存在"要在 legacy 映射里剥掉 workflowRuns"的对应物。
    expect(
      zcodeSessionProjectionSchema.safeParse(
        mapSessionProjection(
          new EventReducer().reduce([
            createSessionEvent(SessionEventType.SessionCreated, "legacy-session" as SessionId, {
              mode: "build",
              contextWindow: 200_000,
            }),
            runProgressEvent(),
          ]),
        ),
      ).success,
    ).toBe(true);
  });
});
