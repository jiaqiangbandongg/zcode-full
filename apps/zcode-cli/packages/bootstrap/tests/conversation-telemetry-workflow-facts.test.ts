// 动态工作流子代理的埋点事实（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Token telemetry for subagents」）：
// 门 1 放行 workflow_child 的用量；DynamicWorkflowRunProgress 派生 workflow.lifecycle；
// 父会话 tool_internal 嵌套用量仍不外送；turn 载荷的 wf 维度透传。
import { describe, expect, it } from "vitest";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import { ConversationTelemetryFactNormalizer } from "../src/zcode-protocol-v4/conversation-telemetry-facts.js";

function event(
  type: SessionEvent["type"],
  payload: unknown,
  seq: number,
  sessionId = "sess_dwf-run-1-worker_1",
): SessionEvent {
  return {
    id: `event-${seq}`,
    sessionId,
    turnId: "turn",
    traceId: "trace",
    sequenceNumber: seq,
    timestamp: new Date(),
    type,
    payload,
  } as SessionEvent;
}

const usage = {
  inputTokens: 120,
  outputTokens: 30,
  totalTokens: 150,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

describe("workflow_child 用量进埋点", () => {
  it("子会话 ModelComplete(querySource workflow_child) 变 usage.delta", () => {
    const normalizer = new ConversationTelemetryFactNormalizer();
    const fact = normalizer.normalize(
      "sess_dwf-run-1-worker_1",
      event(
        SessionEventType.ModelComplete,
        {
          content: "",
          stopReason: "end_turn",
          usage,
          toolCallCount: 0,
          querySource: "workflow_child",
        },
        1,
      ),
    );
    expect(fact).toMatchObject({ kind: "usage.delta", inputTokens: 120, totalTokens: 150 });
  });

  it("父会话 tool_internal 且无 querySource 的嵌套用量仍不外送（前台子代理回填，不双计）", () => {
    const normalizer = new ConversationTelemetryFactNormalizer();
    const fact = normalizer.normalize(
      "parent",
      event(
        SessionEventType.ModelComplete,
        { content: "", stopReason: "tool_internal", usage, toolCallCount: 0 },
        1,
        "parent",
      ),
    );
    expect(fact).toBeNull();
  });
});

describe("DynamicWorkflowRunProgress → workflow.lifecycle", () => {
  const actorCreated = (launchInputId?: string) =>
    event(
      SessionEventType.DynamicWorkflowRunProgress,
      {
        runId: "dwfrun-1",
        toolCallId: "tool-wf",
        sequence: 3,
        eventType: "actor-created",
        payload: { actor: { siteId: "worker", ordinal: 1 }, name: "worker" },
        actorSessionId: "sess_dwf-run-1-worker_1",
        ...(launchInputId === undefined ? {} : { launchInputId }),
      },
      1,
      "parent",
    );

  it("actor-created 带锚点 → actor-spawned，sourceCommandId 是锚点，agentId 是 siteId@ordinal", () => {
    const normalizer = new ConversationTelemetryFactNormalizer();
    expect(normalizer.normalize("parent", actorCreated("launch-input-1"))).toEqual(
      expect.objectContaining({
        kind: "workflow.lifecycle",
        phase: "actor-spawned",
        sourceCommandId: "launch-input-1",
        runId: "dwfrun-1",
        toolCallId: "tool-wf",
        agentId: "worker@1",
        childSessionId: "sess_dwf-run-1-worker_1",
        sessionId: "parent",
      }),
    );
  });

  it("没有锚点（升级前的 run）不发事实", () => {
    const normalizer = new ConversationTelemetryFactNormalizer();
    expect(normalizer.normalize("parent", actorCreated())).toBeNull();
  });

  it.each([
    ["completed", { status: "completed" }, undefined],
    ["errored", { status: "errored", error: { code: "DriverError", message: "boom" } }, "boom"],
    [
      "stopped by the user",
      { status: "stopped", stopReason: "user" },
      "Workflow run stopped (user)",
    ],
    [
      "stopped by the provider",
      {
        status: "stopped",
        stopReason: "provider",
        error: { code: "ProviderStop", message: "quota exhausted" },
      },
      "quota exhausted",
    ],
  ] as const)("run-settled(%s) → run-settled 事实", (_label, payload, errorMessage) => {
    const normalizer = new ConversationTelemetryFactNormalizer();
    const fact = normalizer.normalize(
      "parent",
      event(
        SessionEventType.DynamicWorkflowRunProgress,
        {
          runId: "dwfrun-1",
          sequence: 9,
          eventType: "run-settled",
          payload,
          launchInputId: "launch-input-1",
        },
        2,
        "parent",
      ),
    );
    expect(fact).toMatchObject({
      kind: "workflow.lifecycle",
      phase: "run-settled",
      runId: "dwfrun-1",
      sourceCommandId: "launch-input-1",
      status: payload.status,
    });
    if (errorMessage === undefined) expect(fact).not.toHaveProperty("errorMessage");
    else expect(fact).toMatchObject({ errorMessage });
    // stopReason 只在 stopped 时搬运（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Terminal states」）。
    if ("stopReason" in payload) expect(fact).toMatchObject({ stopReason: payload.stopReason });
    else expect(fact).not.toHaveProperty("stopReason");
  });

  it("其余引擎事件（node-queued / usage-updated）不进埋点", () => {
    const normalizer = new ConversationTelemetryFactNormalizer();
    for (const eventType of ["node-queued", "usage-updated", "run-started", "run-launched"]) {
      expect(
        normalizer.normalize(
          "parent",
          event(
            SessionEventType.DynamicWorkflowRunProgress,
            { runId: "dwfrun-1", sequence: 1, eventType, payload: {}, launchInputId: "x" },
            1,
            "parent",
          ),
        ),
      ).toBeNull();
    }
  });
});

describe("turn 载荷的 wf 维度", () => {
  it("TurnStarted.backgroundSource workflow 透传；TurnComplete.workflowResultConsumed 透传", () => {
    const normalizer = new ConversationTelemetryFactNormalizer();
    expect(
      normalizer.normalize(
        "parent",
        event(
          SessionEventType.TurnStarted,
          {
            turnNumber: 1,
            input: "notice",
            inputId: "wake-1",
            inputSource: "background_task",
            backgroundSource: "workflow",
            messageId: "msg_1",
          },
          1,
          "parent",
        ),
      ),
    ).toMatchObject({ kind: "turn.started", backgroundSource: "workflow" });
    expect(
      normalizer.normalize(
        "parent",
        event(
          SessionEventType.TurnComplete,
          {
            turnNumber: 1,
            result: { type: "complete" },
            duration: 1,
            workflowResultConsumed: true,
          },
          2,
          "parent",
        ),
      ),
    ).toMatchObject({ kind: "turn.terminal", workflowResultConsumed: true });
  });
});
