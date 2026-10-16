import { describe, expect, it } from "vitest";
import type { EventId, SessionEvent, SessionId, TraceId, TurnId } from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";
import { normalizeConversationEvent } from "../src/zcode-protocol-v4/event-normalizer.js";

function event(
  type: SessionEvent["type"],
  payload: unknown,
  overrides: Partial<SessionEvent> = {},
): SessionEvent {
  return {
    id: "event-1" as EventId,
    sessionId: "session-1" as SessionId,
    turnId: "runtime-turn-1" as TurnId,
    type,
    timestamp: new Date(1_700_000_000_000),
    traceId: "trace-live" as TraceId,
    sequenceNumber: 1,
    payload,
    ...overrides,
  };
}

describe("Conversation Event Normalizer", () => {
  it("live/cold TurnStarted 以持久 messageId 得到相同的用户实体语义", () => {
    const payload = {
      turnNumber: 1,
      input: "hello",
      messageId: "message-user-1",
      inputId: "command-1",
    };
    const live = normalizeConversationEvent(event(SessionEventType.TurnStarted, payload));
    const cold = normalizeConversationEvent(
      event(SessionEventType.TurnStarted, payload, {
        id: "event-cold-1" as EventId,
        turnId: "hydrate-turn-1" as TurnId,
        traceId: "trace-v4-hydration" as TraceId,
      }),
    );

    expect(live.semanticKind).toBe("userIntent");
    expect(cold.semanticKind).toBe("userIntent");
    for (const fact of [live, cold]) {
      expect(fact).toMatchObject({
        entityId: "message-user-1",
        productTurnId: "message-user-1",
        transcriptMessageId: "message-user-1",
        visibility: "visible",
        origin: "realUser",
        placement: { lane: "trigger", relation: "withinProductTurn" },
        diagnostics: [],
      });
    }
    expect(live.runtimeTurnId).toBe("runtime-turn-1");
    expect(cold.runtimeTurnId).toBe("hydrate-turn-1");
  });

  it("旧 TurnStarted 缺少 messageId 时生成确定性 fallback 并留下诊断", () => {
    const normalized = normalizeConversationEvent(
      event(SessionEventType.TurnStarted, { turnNumber: 1, input: "legacy" }),
    );

    expect(normalized).toMatchObject({
      semanticKind: "userIntent",
      entityId: "legacy:user:session-1:runtime-turn-1:event-1",
      productTurnId: "runtime-turn-1",
      transcriptMessageId: null,
      diagnostics: [
        {
          code: "normalizer.user.missingTranscriptMessageId",
          eventId: "event-1",
        },
      ],
    });
  });

  it("subagent_message carrier 保持 mailbox canonical origin", () => {
    const normalized = normalizeConversationEvent(
      event(SessionEventType.TurnStarted, {
        turnNumber: 2,
        input: "<subagent-message>done</subagent-message>",
        inputVisibility: "model-only",
        inputSource: "subagent_message",
        messageId: "message-subagent-carrier",
      }),
    );

    expect(normalized).toMatchObject({
      semanticKind: "userIntent",
      entityId: "message-subagent-carrier",
      productTurnId: "message-subagent-carrier",
      transcriptMessageId: "message-subagent-carrier",
      visibility: "modelOnly",
      origin: "mailbox",
    });
  });

  it("workflow_launch 启动轮：turnHeader 与 userInput 同得 workflowLaunch origin，并带上启动元数据", () => {
    const workflowLaunch = {
      runId: "dwfrun-9",
      toolCallId: "launch-abc",
      name: "deep-research",
      scope: "global" as const,
      path: "/home/u/.zcode/workflows/deep-research.ts",
      args: { topic: "adaptive concurrency" },
      description: "Deep-dive a topic",
    };
    const normalized = normalizeConversationEvent(
      event(SessionEventType.TurnStarted, {
        turnNumber: 1,
        input: 'Started the saved workflow "deep-research" (global) ...',
        messageId: "message-launch-1",
        executionKind: "controlOnly",
        inputSource: "workflow_launch",
        workflowLaunch,
      }),
    );

    expect(normalized).toMatchObject({
      semanticKind: "userIntent",
      entityId: "message-launch-1",
      visibility: "visible",
      origin: "workflowLaunch",
      turnHeaderOrigin: "workflowLaunch",
      executionKind: "controlOnly",
      workflowLaunch,
    });
  });

  it("ModelStreaming 的 assistant 身份只由 normalizer 解释", () => {
    const normalized = normalizeConversationEvent(
      event(SessionEventType.ModelStreaming, {
        kind: "text_start",
        delta: "",
        done: false,
        assistantMessageId: "message-assistant-1",
        partId: "part-1",
      }),
      { productTurnId: "product-turn-1" },
    );

    expect(normalized).toMatchObject({
      semanticKind: "assistantSegment",
      entityId: "message-assistant-1",
      productTurnId: "product-turn-1",
      runtimeTurnId: "runtime-turn-1",
      transcriptMessageId: "message-assistant-1",
      visibility: "visible",
      origin: "assistant",
      placement: { lane: "assistantWork", relation: "withinProductTurn" },
      stream: {
        kind: "text_start",
        transcriptPartId: "part-1",
      },
      diagnostics: [],
    });
  });

  it("同一 text segment 的多次 delta/end 继承 open segment 身份", () => {
    const started = normalizeConversationEvent(
      event(SessionEventType.ModelStreaming, {
        kind: "text_start",
        delta: "",
        done: false,
        assistantMessageId: "message-assistant-1",
        partId: "part-1",
      }),
    );
    expect(started.semanticKind).toBe("assistantSegment");
    if (started.semanticKind !== "assistantSegment") throw new Error("expected assistant segment");
    const openTextSegment = {
      entityId: started.entityId,
      transcriptMessageId: started.transcriptMessageId,
    };
    const chunks = [
      { kind: "text_delta", delta: "one", done: false, partId: "part-1" },
      { kind: "text_delta", delta: "two", done: false, partId: "part-1" },
      { kind: "text_end", delta: "", done: false, partId: "part-1" },
    ].map((payload, index) =>
      normalizeConversationEvent(
        event(SessionEventType.ModelStreaming, payload, {
          id: `event-${index + 2}` as EventId,
          sequenceNumber: index + 2,
        }),
        { openAssistantSegments: { text: openTextSegment } },
      ),
    );

    expect(chunks.map((fact) => fact.entityId)).toEqual([
      "message-assistant-1",
      "message-assistant-1",
      "message-assistant-1",
    ]);
    expect(chunks.map((fact) => fact.transcriptMessageId)).toEqual([
      "message-assistant-1",
      "message-assistant-1",
      "message-assistant-1",
    ]);
    expect(chunks.flatMap((fact) => fact.diagnostics)).toEqual([]);
  });

  it("reasoning part 与 tool call 在各自 lane 内保持稳定实体身份", () => {
    const reasoningStart = normalizeConversationEvent(
      event(SessionEventType.ModelStreaming, {
        kind: "reasoning_start",
        delta: "",
        done: false,
        partId: "reasoning-part-1",
      }),
    );
    const reasoningDelta = normalizeConversationEvent(
      event(SessionEventType.ModelStreaming, {
        kind: "reasoning_delta",
        delta: "think",
        done: false,
      }),
      {
        openAssistantSegments: {
          reasoning: {
            entityId: reasoningStart.entityId,
            transcriptMessageId: reasoningStart.transcriptMessageId,
          },
        },
      },
    );
    const toolStart = normalizeConversationEvent(
      event(SessionEventType.ModelStreaming, {
        kind: "tool_input_start",
        delta: "",
        done: false,
        toolCallId: "tool-call-1",
        toolName: "Bash",
        partId: "tool-part-1",
      }),
    );
    const toolDelta = normalizeConversationEvent(
      event(SessionEventType.ModelStreaming, {
        kind: "tool_input_delta",
        delta: "pwd",
        done: false,
        toolCallId: "tool-call-1",
        partId: "tool-part-1",
      }),
    );

    expect(reasoningStart.entityId).toBe("reasoning-part-1");
    expect(reasoningDelta.entityId).toBe("reasoning-part-1");
    expect(toolStart.entityId).toBe("tool-call-1");
    expect(toolDelta.entityId).toBe("tool-call-1");
  });

  it("compact boundary normalizes operation identity, command provenance and placement", () => {
    const normalized = normalizeConversationEvent(
      event(SessionEventType.CompactStarted, {
        operationId: "compact-operation-1",
        messageId: "compact-host-message",
        sourceCommandId: "command-compact-1",
        status: "started",
        trigger: "manual",
      }),
      { productTurnId: "product-turn-1" },
    );

    expect(normalized).toMatchObject({
      semanticKind: "passthrough",
      entityId: "compact-operation-1",
      productTurnId: "product-turn-1",
      transcriptMessageId: "compact-host-message",
      visibility: "visible",
      placement: { lane: "assistantWork", relation: "withinProductTurn" },
      sourceCommandId: "command-compact-1",
    });
  });
});
