// ============================================================
// Test imports
// ============================================================
import { beforeEach, describe, expect, it } from "vitest";
import { EventReducer } from "../src/events/event-reducer.js";
import { SessionEventType } from "../src/events/session.events.js";
import type { SessionEvent } from "../src/events/session.events.js";
import { createSessionEvent } from "../src/events/session.events.js";
import { CompactTrigger } from "../src/compact/index.js";
import { RewindScope, RewindStrategy } from "../src/rewind/index.js";
import type {
  MessageId,
  PartId,
  SessionId,
  ToolCallId,
  TraceId,
} from "../src/interfaces/shared.js";
import type { SessionGoal, GoalStatus } from "../src/tools/target.js";

// -----------------------------------------------
// Event Reducer Tests
// -----------------------------------------------

describe("EventReducer", () => {
  const sessionId = "sess_123" as SessionId;
  let reducer: EventReducer;

  beforeEach(() => {
    reducer = new EventReducer();
  });

  describe("reduce", () => {
    it("should return initial state for empty events", () => {
      const projection = reducer.reduce([]);
      expect(projection.id).toBe("unknown");
      expect(projection.turnCount).toBe(0);
      expect(projection.status).toBe("idle");
    });

    it("should apply session_created event", () => {
      const events: SessionEvent[] = [
        createSessionEvent(SessionEventType.SessionCreated, sessionId, {
          mode: "build",
          contextWindow: 200000,
        }),
      ];

      const projection = reducer.reduce(events);
      expect(projection.id).toBe(sessionId);
      expect(projection.mode).toBe("build");
      expect(projection.contextWindow).toBe(200000);
    });

    it("should apply session_mode_changed event", () => {
      const events: SessionEvent[] = [
        createSessionEvent(SessionEventType.SessionCreated, sessionId, {
          mode: "build",
          contextWindow: 200000,
        }),
        createSessionEvent(SessionEventType.SessionModeChanged, sessionId, {
          mode: "plan",
          previousMode: "build",
          source: "tool",
          toolCallId: "tool_1" as ToolCallId,
        }),
      ];

      const projection = reducer.reduce(events);
      expect(projection.mode).toBe("plan");
    });

    it("should increment turn count on turn_started", () => {
      const events: SessionEvent[] = [
        createSessionEvent(SessionEventType.SessionCreated, sessionId, {
          mode: "build",
          contextWindow: 200000,
        }),
        createSessionEvent(
          SessionEventType.TurnStarted,
          sessionId,
          { turnNumber: 1, input: "Hello" },
          { turnId: "turn_1" as any },
        ),
      ];

      const projection = reducer.reduce(events);
      expect(projection.turnCount).toBe(1);
      expect(projection.status).toBe("running");
    });

    it("should set status to idle on turn_complete", () => {
      const events: SessionEvent[] = [
        createSessionEvent(SessionEventType.SessionCreated, sessionId, {
          mode: "build",
          contextWindow: 200000,
        }),
        createSessionEvent(
          SessionEventType.TurnStarted,
          sessionId,
          { turnNumber: 1, input: "Hello" },
          { turnId: "turn_1" as any },
        ),
        createSessionEvent(
          SessionEventType.TurnComplete,
          sessionId,
          {
            response: "Hi",
            tokenCount: 100,
            toolCallCount: 0,
            duration: 1000,
            resultType: "success",
          },
          { turnId: "turn_1" as any },
        ),
      ];

      const projection = reducer.reduce(events);
      expect(projection.status).toBe("idle");
    });

    it("should clear stale lastError when a new turn starts", () => {
      const events: SessionEvent[] = [
        createSessionEvent(SessionEventType.SessionCreated, sessionId, {
          mode: "build",
          contextWindow: 200000,
        }),
        createSessionEvent(
          SessionEventType.TurnStarted,
          sessionId,
          { turnNumber: 1, input: "Use GLM-5.2" },
          { turnId: "turn_1" as any },
        ),
        createSessionEvent(
          SessionEventType.TurnError,
          sessionId,
          {
            error: {
              type: "1220",
              message: "[1220][您无权访问glm-5.2。][trace-a]",
            },
            turnPhase: "model",
          },
          { turnId: "turn_1" as any },
        ),
        createSessionEvent(
          SessionEventType.TurnStarted,
          sessionId,
          { turnNumber: 2, input: "Continue with GLM-5.1" },
          { turnId: "turn_2" as any },
        ),
      ];

      const runningProjection = reducer.reduce(events);
      expect(runningProjection.status).toBe("running");
      expect(runningProjection.lastError).toBeUndefined();

      const completedProjection = reducer.reduce([
        ...events,
        createSessionEvent(
          SessionEventType.TurnComplete,
          sessionId,
          {
            response: "Done.",
            tokenCount: 100,
            toolCallCount: 0,
            duration: 1000,
            resultType: "success",
          },
          { turnId: "turn_2" as any },
        ),
      ]);
      expect(completedProjection.status).toBe("idle");
      expect(completedProjection.lastError).toBeUndefined();

      const nextFailedProjection = reducer.reduce([
        ...events,
        createSessionEvent(
          SessionEventType.TurnError,
          sessionId,
          {
            error: {
              type: "NEW_ERROR",
              message: "new turn failed",
            },
            turnPhase: "model",
          },
          { turnId: "turn_2" as any },
        ),
      ]);
      expect(nextFailedProjection.lastError).toEqual({
        type: "NEW_ERROR",
        message: "new turn failed",
      });
    });

    it("should preserve structured turn error code and detail in lastError", () => {
      const events: SessionEvent[] = [
        createSessionEvent(SessionEventType.SessionCreated, sessionId, {
          mode: "build",
          contextWindow: 200000,
        }),
        createSessionEvent(
          SessionEventType.TurnError,
          sessionId,
          {
            error: {
              type: "MODEL_ERROR",
              code: "provider_not_found",
              message: "Model provider is not configured: stale-provider",
              detail: "stale-provider/gpt-5.5",
            },
            turnPhase: "model",
          },
          { turnId: "turn_1" as any },
        ),
      ];

      const projection = reducer.reduce(events);

      expect(projection.lastError).toEqual({
        type: "MODEL_ERROR",
        code: "provider_not_found",
        message: "Model provider is not configured: stale-provider",
        detail: "stale-provider/gpt-5.5",
      });
    });

    it("should preserve structured turn error attribution in lastError", () => {
      const events: SessionEvent[] = [
        createSessionEvent(
          SessionEventType.TurnError,
          sessionId,
          {
            error: {
              type: "MODEL_ERROR",
              code: "model_request_failed",
              message: "[1301][Sensitive content rejected]",
              attribution: {
                source: "provider",
                reason: "unknown",
                providerId: "account:bigmodel-individual-coding-plan",
                providerErrorCode: "1301",
              },
            },
            turnPhase: "model",
          },
          { turnId: "turn_attribution" as any },
        ),
      ];

      const projection = reducer.reduce(events);

      expect(projection.lastError).toMatchObject({
        attribution: {
          source: "provider",
          reason: "unknown",
          providerId: "account:bigmodel-individual-coding-plan",
          providerErrorCode: "1301",
        },
      });
    });

    it("should track active context from the latest model request usage", () => {
      const events: SessionEvent[] = [
        createSessionEvent(SessionEventType.SessionCreated, sessionId, {
          mode: "build",
          contextWindow: 200000,
        }),
        createSessionEvent(SessionEventType.ModelComplete, sessionId, {
          content: "Need a tool.",
          stopReason: "tool-calls",
          usage: {
            inputTokens: 39951,
            outputTokens: 73,
            totalTokens: 40024,
          },
        }),
        createSessionEvent(SessionEventType.ModelComplete, sessionId, {
          content: "Done.",
          stopReason: "stop",
          usage: {
            inputTokens: 89299,
            outputTokens: 282,
            totalTokens: 89581,
          },
        }),
        createSessionEvent(
          SessionEventType.TurnComplete,
          sessionId,
          {
            response: "Done.",
            tokenCount: 316041,
            toolCallCount: 4,
            duration: 1000,
            resultType: "success",
            usage: {
              cacheReadTokens: 186832,
              cacheWriteTokens: 0,
              inputTokens: 316041,
              modelRequestCount: 5,
              outputTokens: 10687,
              reasoningTokens: 128,
              source: "provider",
              totalTokens: 326728,
            },
          },
          { turnId: "turn_1" as any },
        ),
      ];

      const projection = reducer.reduce(events);
      expect(projection.contextUsed).toBe(89581);
    });

    it("should not let sidecar model usage overwrite main session context", () => {
      const events: SessionEvent[] = [
        createSessionEvent(SessionEventType.SessionCreated, sessionId, {
          mode: "build",
          contextWindow: 1_000_000,
        }),
        createSessionEvent(SessionEventType.ModelComplete, sessionId, {
          content: "你好！我是 zcode-agent。",
          querySource: "main_turn",
          stopReason: "stop",
          usage: {
            inputTokens: 17_737,
            outputTokens: 41,
            totalTokens: 17_778,
          },
        }),
        createSessionEvent(SessionEventType.ModelComplete, sessionId, {
          content: "中文问候",
          querySource: "session_title",
          stopReason: "stop",
          usage: {
            inputTokens: 89,
            outputTokens: 84,
            totalTokens: 173,
          },
        }),
        createSessionEvent(SessionEventType.ModelComplete, sessionId, {
          content: "compact summary",
          querySource: "compact",
          stopReason: "stop",
          usage: {
            inputTokens: 512,
            outputTokens: 128,
            totalTokens: 640,
          },
        }),
        createSessionEvent(SessionEventType.ModelComplete, sessionId, {
          content: "subagent answer",
          querySource: "subagent",
          stopReason: "stop",
          usage: {
            inputTokens: 4_200,
            outputTokens: 300,
            totalTokens: 4_500,
          },
        }),
        createSessionEvent(SessionEventType.ModelComplete, sessionId, {
          content: "",
          stopReason: "tool_internal",
          usage: {
            inputTokens: 9_001,
            outputTokens: 12,
            totalTokens: 9_013,
          },
        }),
      ];

      const projection = reducer.reduce(events);
      expect(projection.contextUsed).toBe(17_778);
    });

    it("should project the current session goal from target_changed events", () => {
      const target = buildTarget(sessionId, "Ship target events", "active");
      const completedTarget = { ...target, status: "complete" as const };
      const events: SessionEvent[] = [
        createSessionEvent(SessionEventType.SessionCreated, sessionId, {
          mode: "build",
          contextWindow: 200000,
        }),
        createSessionEvent(SessionEventType.TargetChanged, sessionId, {
          action: "set",
          source: "command",
          target,
        }),
        createSessionEvent(SessionEventType.TargetChanged, sessionId, {
          action: "status_updated",
          previousTarget: target,
          source: "tool",
          target: completedTarget,
        }),
        createSessionEvent(SessionEventType.TargetChanged, sessionId, {
          action: "cleared",
          previousTarget: completedTarget,
          source: "command",
          target: null,
        }),
      ];

      const projection = reducer.reduce(events);

      expect(projection.target).toBeNull();
      expect(projection.updatedAt).toEqual(events.at(-1)?.timestamp);
    });

    it("should persist target completion verification timeline without duplicating completed summaries", () => {
      const target = buildTarget(sessionId, "实现 goal verify 横条", "active");
      const verification = {
        nextAction: "继续补 UI 回归。",
        passed: false,
        reason: "还缺交互验证。",
      };
      const events: SessionEvent[] = [
        createSessionEvent(SessionEventType.SessionCreated, sessionId, {
          mode: "build",
          contextWindow: 200000,
        }),
        createSessionEvent(SessionEventType.TargetChanged, sessionId, {
          action: "set",
          source: "command",
          target,
        }),
        createSessionEvent(SessionEventType.TargetCompletionVerification, sessionId, {
          status: "started",
          targetId: target.targetID,
          verificationId: "verify_1",
        }),
        createSessionEvent(SessionEventType.ModelComplete, sessionId, {
          content: JSON.stringify(verification),
          querySource: "target_completion_verification",
          stopReason: "stop",
        }),
        createSessionEvent(SessionEventType.TargetCompletionVerification, sessionId, {
          status: "completed",
          targetId: target.targetID,
          verification,
          verificationId: "verify_1",
        }),
      ];

      const projection = reducer.reduce(events);

      expect(projection.targetCompletionVerifications).toEqual([verification]);
      expect(projection.targetCompletionVerificationTimeline).toHaveLength(1);
      expect(projection.targetCompletionVerificationTimeline[0]).toMatchObject({
        targetId: target.targetID,
        status: "completed",
        verificationId: "verify_1",
        verification,
        goalIteration: 1,
        startedAt: events[2].timestamp,
        updatedAt: events[4].timestamp,
      });
    });

    it("should add failed closed target completion verification to the summary ledger", () => {
      const target = buildTarget(sessionId, "处理失败关闭校验", "active");
      const verification = {
        passed: false,
        reason: "Completion verifier request failed: network timeout",
      };
      const events: SessionEvent[] = [
        createSessionEvent(SessionEventType.SessionCreated, sessionId, {
          mode: "build",
          contextWindow: 200000,
        }),
        createSessionEvent(SessionEventType.TargetCompletionVerification, sessionId, {
          status: "started",
          targetId: target.targetID,
          verificationId: "verify_failed",
        }),
        createSessionEvent(SessionEventType.TargetCompletionVerification, sessionId, {
          status: "failed_closed",
          targetId: target.targetID,
          verification,
          verificationId: "verify_failed",
        }),
      ];

      const projection = reducer.reduce(events);

      expect(projection.targetCompletionVerifications).toEqual([verification]);
      expect(projection.targetCompletionVerificationTimeline[0]).toMatchObject({
        status: "failed_closed",
        verification,
        verificationId: "verify_failed",
        goalIteration: 1,
      });
    });

    it("should clear target completion verification timeline when a new target is set", () => {
      const target = buildTarget(sessionId, "旧目标", "active");
      const nextTarget = {
        ...buildTarget(sessionId, "新目标", "active"),
        targetID: "target_2",
      };
      const events: SessionEvent[] = [
        createSessionEvent(SessionEventType.SessionCreated, sessionId, {
          mode: "build",
          contextWindow: 200000,
        }),
        createSessionEvent(SessionEventType.TargetCompletionVerification, sessionId, {
          status: "started",
          targetId: target.targetID,
          verificationId: "verify_1",
        }),
        createSessionEvent(SessionEventType.TargetChanged, sessionId, {
          action: "set",
          previousTarget: target,
          source: "command",
          target: nextTarget,
        }),
      ];

      const projection = reducer.reduce(events);

      expect(projection.targetCompletionVerificationTimeline).toEqual([]);
      expect(projection.targetCompletionVerifications).toEqual([]);
    });

    it("should track pending permissions", () => {
      const events: SessionEvent[] = [
        createSessionEvent(SessionEventType.SessionCreated, sessionId, {
          mode: "build",
          contextWindow: 200000,
        }),
        createSessionEvent(SessionEventType.PermissionRequested, sessionId, {
          toolCallId: "tool_1" as any,
          toolName: "Bash",
          riskLevel: "high",
          reason: "Running shell command",
          input: {},
          suggestedPermissionUpdates: [
            {
              behavior: "allow",
              rules: [{ ruleContent: "pnpm run lint:*", toolName: "Bash" }],
              type: "addRules",
            },
          ],
        }),
      ];

      const projection = reducer.reduce(events);
      expect(projection.pendingPermissions).toHaveLength(1);
      expect(projection.pendingPermissions[0].toolName).toBe("Bash");
      expect(projection.pendingPermissions[0].suggestedPermissionUpdates).toEqual([
        {
          behavior: "allow",
          rules: [{ ruleContent: "pnpm run lint:*", toolName: "Bash" }],
          type: "addRules",
        },
      ]);
    });

    it("should carry the ask preview and option policy onto the pending permission", () => {
      // Both fields are re-picked field by field here, so a missed field silently drops
      // the confirmation preview for any session rebuilt from its event log.
      const display = {
        kind: "create_workflow" as const,
        ok: true,
        errorCount: 0,
        diagnostics: [],
      };
      const events: SessionEvent[] = [
        createSessionEvent(SessionEventType.SessionCreated, sessionId, {
          mode: "build",
          contextWindow: 200000,
        }),
        createSessionEvent(SessionEventType.PermissionRequested, sessionId, {
          toolCallId: "tool_1" as any,
          toolName: "CreateWorkflow",
          riskLevel: "low",
          reason: "createWorkflow.runConfirmation",
          input: { script: "return 1;" },
          display,
          optionsPolicy: "no-always-allow",
        }),
      ];

      const projection = reducer.reduce(events);
      expect(projection.pendingPermissions[0].display).toEqual(display);
      expect(projection.pendingPermissions[0].optionsPolicy).toBe("no-always-allow");
    });

    it("should remove pending permission on resolution", () => {
      const events: SessionEvent[] = [
        createSessionEvent(SessionEventType.SessionCreated, sessionId, {
          mode: "build",
          contextWindow: 200000,
        }),
        createSessionEvent(SessionEventType.PermissionRequested, sessionId, {
          toolCallId: "tool_1" as any,
          toolName: "Bash",
          riskLevel: "high",
          reason: "Running shell command",
          input: {},
        }),
        createSessionEvent(SessionEventType.PermissionResolved, sessionId, {
          toolCallId: "tool_1" as any,
          decision: "allow",
        }),
      ];

      const projection = reducer.reduce(events);
      expect(projection.pendingPermissions).toHaveLength(0);
    });

    it("should track pending steer inputs until drained or discarded", () => {
      const events: SessionEvent[] = [
        createSessionEvent(SessionEventType.SessionCreated, sessionId, {
          mode: "build",
          contextWindow: 200000,
        }),
        createSessionEvent(
          SessionEventType.TurnSteerQueued,
          sessionId,
          {
            pendingInputId: "pending_1",
            input: "queued message",
            inputPreview: "queued message",
            inputSize: 14,
            queueLength: 1,
            targetTurnId: "turn_1" as any,
          },
          { traceId: "trace_1" as TraceId, turnId: "turn_1" as any },
        ),
        createSessionEvent(
          SessionEventType.TurnSteerQueued,
          sessionId,
          {
            pendingInputId: "pending_2",
            input: "discard me",
            inputPreview: "discard me",
            inputSize: 10,
            queueLength: 2,
            targetTurnId: "turn_1" as any,
          },
          { traceId: "trace_1" as TraceId, turnId: "turn_1" as any },
        ),
        createSessionEvent(
          SessionEventType.TurnSteerDrained,
          sessionId,
          {
            injectedMessageIds: ["msg_1" as MessageId],
            pendingInputIds: ["pending_1"],
            targetTurnId: "turn_1" as any,
          },
          { traceId: "trace_1" as TraceId, turnId: "turn_1" as any },
        ),
      ];

      const afterDrain = reducer.reduce(events);
      expect(afterDrain.pendingSteerInputs).toHaveLength(1);
      expect(afterDrain.pendingSteerInputs[0]).toMatchObject({
        input: "discard me",
        pendingInputId: "pending_2",
      });

      const afterDiscard = reducer.reduce([
        ...events,
        createSessionEvent(
          SessionEventType.TurnSteerDiscarded,
          sessionId,
          {
            pendingInputIds: ["pending_2"],
            reason: "turn_cancelled",
            targetTurnId: "turn_1" as any,
          },
          { traceId: "trace_1" as TraceId, turnId: "turn_1" as any },
        ),
      ]);
      expect(afterDiscard.pendingSteerInputs).toHaveLength(0);
    });

    it("keeps queue edit in place and applies authoritative reorder positions", () => {
      const intent = (sourceCommandId: string, queueItemId: string, admissionSeq: number) => ({
        sourceCommandId,
        queueItemId,
        clientId: "mobile-client",
        kind: "sendText" as const,
        admissionSeq,
        admittedAt: admissionSeq,
        requestedDelivery: "queue" as const,
        admittedDelivery: "queue" as const,
        queuePosition: admissionSeq - 1,
      });
      const queued = (pendingInputId: string, input: string, admissionSeq: number) =>
        createSessionEvent(
          SessionEventType.TurnSteerQueued,
          sessionId,
          {
            pendingInputId,
            input,
            inputPreview: input,
            inputSize: input.length,
            queueLength: 2,
            targetTurnId: "turn_1" as any,
            intent: intent(`command-${pendingInputId}`, pendingInputId, admissionSeq),
          },
          { traceId: "trace_1" as TraceId, turnId: "turn_1" as any },
        );
      const first = queued("q1", "第一条", 1);
      const events: SessionEvent[] = [
        createSessionEvent(SessionEventType.SessionCreated, sessionId, {
          mode: "build",
          contextWindow: 200000,
        }),
        first,
        queued("q2", "第二条", 2),
        queued("q1", "第一条改", 1),
        createSessionEvent(
          SessionEventType.TurnSteerReordered,
          sessionId,
          {
            orderedPendingInputIds: ["q2", "q1"],
            targetTurnId: "turn_1" as any,
          },
          { traceId: "trace_1" as TraceId, turnId: "turn_1" as any },
        ),
      ];

      const projection = reducer.reduce(events);
      expect(projection.pendingSteerInputs.map((item) => item.pendingInputId)).toEqual([
        "q2",
        "q1",
      ]);
      expect(projection.pendingSteerInputs[1]).toMatchObject({
        input: "第一条改",
        queuedAt: first.timestamp,
        intent: {
          sourceCommandId: "command-q1",
          queueItemId: "q1",
          clientId: "mobile-client",
          queuePosition: 1,
        },
      });
    });

    it("should track active tool calls", () => {
      const events: SessionEvent[] = [
        createSessionEvent(SessionEventType.SessionCreated, sessionId, {
          mode: "build",
          contextWindow: 200000,
        }),
        createSessionEvent(SessionEventType.ToolCallScheduled, sessionId, {
          toolCallId: "tool_1" as any,
          toolName: "Glob",
          input: {},
          schedule: { parallelGroups: [], executionOrder: [] },
        }),
      ];

      const projection = reducer.reduce(events);
      expect(projection.activeToolCalls).toHaveLength(1);
      expect(projection.activeToolCalls[0].status).toBe("pending");
    });

    it("should update tool status on result", () => {
      const events: SessionEvent[] = [
        createSessionEvent(SessionEventType.SessionCreated, sessionId, {
          mode: "build",
          contextWindow: 200000,
        }),
        createSessionEvent(SessionEventType.ToolCallScheduled, sessionId, {
          toolCallId: "tool_1" as any,
          toolName: "Glob",
          input: {},
          schedule: { parallelGroups: [], executionOrder: [] },
        }),
        createSessionEvent(SessionEventType.ToolCallResult, sessionId, {
          toolCallId: "tool_1" as any,
          result: { success: true, content: "file1.ts\nfile2.ts" },
          duration: 50,
        }),
      ];

      const projection = reducer.reduce(events);
      const tool = projection.activeToolCalls.find((tc) => tc.toolCallId === "tool_1");
      expect(tool?.status).toBe("completed");
    });

    it("should track streaming tool ledger and recovery anchor", () => {
      const assistantMessageId = "msg_assistant" as MessageId;
      const toolCallId = "tool_1" as ToolCallId;
      const resultPartId = "part_1" as PartId;
      const committedAt = new Date("2026-05-11T00:00:00.000Z");
      const events: SessionEvent[] = [
        createSessionEvent(SessionEventType.SessionCreated, sessionId, {
          mode: "build",
          contextWindow: 200000,
        }),
        createSessionEvent(SessionEventType.StreamingToolLedgerUpdated, sessionId, {
          attemptId: "attempt_1",
          assistantMessageId,
          toolCallId,
          toolName: "Read",
          status: "tool_call_closed",
          executionTiming: "end_of_stream",
          input: { filePath: "README.md" },
          readOnly: true,
          sideEffectScope: "none",
        }),
        createSessionEvent(SessionEventType.StreamRecoveryAnchorCreated, sessionId, {
          anchorId: "anchor_1",
          attemptId: "attempt_1",
          kind: "tool_result",
          assistantMessageId,
          toolCallId,
          toolName: "Read",
          resultPartId,
          committedToolCallIds: [toolCallId],
          committedAt,
        }),
        createSessionEvent(SessionEventType.StreamingToolLedgerUpdated, sessionId, {
          attemptId: "attempt_1",
          assistantMessageId,
          toolCallId,
          toolName: "Read",
          status: "tool_result_committed",
          executionTiming: "end_of_stream",
          resultPartId,
          recoveryAnchorId: "anchor_1",
          committedAt,
        }),
      ];

      const projection = reducer.reduce(events);
      expect(projection.streamingToolLedger).toHaveLength(1);
      expect(projection.streamingToolLedger[0]).toMatchObject({
        attemptId: "attempt_1",
        status: "tool_result_committed",
        toolCallId,
        resultPartId,
        recoveryAnchorId: "anchor_1",
      });
      expect(projection.lastStreamRecoveryAnchor).toMatchObject({
        anchorId: "anchor_1",
        kind: "tool_result",
        committedToolCallIds: [toolCallId],
      });
    });

    it("should track background task lifecycle", () => {
      const events: SessionEvent[] = [
        createSessionEvent(SessionEventType.SessionCreated, sessionId, {
          mode: "build",
          contextWindow: 200000,
        }),
        createSessionEvent(SessionEventType.BackgroundTaskStarted, sessionId, {
          cancellable: true,
          taskId: "exec_1",
          toolCallId: "tool_1",
          toolName: "Bash",
          taskKind: "bash",
          command: "npm run dev",
          outputTail: "booting",
          stdoutBytes: 7,
          stdoutTail: "booting",
          terminalId: "exec_1",
          status: "running",
        }),
        createSessionEvent(SessionEventType.BackgroundTaskCompleted, sessionId, {
          taskId: "exec_1",
          status: "completed",
          outputPath: "/tmp/exec_1.log",
          outputBytes: 12,
        }),
      ];

      const projection = reducer.reduce(events);
      expect(projection.backgroundTasks).toHaveLength(1);
      expect(projection.backgroundTasks[0]).toMatchObject({
        cancellable: true,
        command: "npm run dev",
        taskKind: "bash",
        outputBytes: 12,
        outputPath: "/tmp/exec_1.log",
        outputTail: "booting",
        status: "completed",
        stdoutBytes: 7,
        stdoutTail: "booting",
        taskId: "exec_1",
        terminalId: "exec_1",
      });
    });

    it("should preserve background subagent child session identity", () => {
      const events: SessionEvent[] = [
        createSessionEvent(SessionEventType.SessionCreated, sessionId, {
          mode: "build",
          contextWindow: 200000,
        }),
        createSessionEvent(SessionEventType.BackgroundTaskStarted, sessionId, {
          taskId: "agent_1",
          taskKind: "subagent",
          childSessionId: "sess_child_1",
          status: "running",
        }),
        createSessionEvent(SessionEventType.BackgroundTaskCompleted, sessionId, {
          taskId: "agent_1",
          status: "completed",
        }),
      ];

      const projection = reducer.reduce(events);
      expect(projection.backgroundTasks[0]).toMatchObject({
        childSessionId: "sess_child_1",
        status: "completed",
        taskId: "agent_1",
        taskKind: "subagent",
      });
    });

    it("should track compact boundary projection", () => {
      const events: SessionEvent[] = [
        createSessionEvent(SessionEventType.SessionCreated, sessionId, {
          mode: "build",
          contextWindow: 200000,
        }),
        createSessionEvent(SessionEventType.CompactBoundary, sessionId, {
          boundaryId: "compact_1",
          trigger: CompactTrigger.Auto,
          summarySource: "model",
          preCompactTokenCount: 180000,
          truePostCompactTokenCount: 24000,
          autoCompactThreshold: 167000,
          willRetriggerNextTurn: false,
          summarizedMessageCount: 24,
          keptMessageCount: 3,
          lastSummarizedMessageId: "msg_old_tail" as MessageId,
          summaryMessageIds: ["msg_summary" as MessageId],
          traceId: "trace_1" as TraceId,
        }),
      ];

      const projection = reducer.reduce(events);
      expect(projection.contextUsed).toBe(24000);
      expect(projection.lastCompact).toMatchObject({
        boundaryId: "compact_1",
        trigger: "auto",
        preCompactTokenCount: 180000,
        truePostCompactTokenCount: 24000,
        summarizedMessageCount: 24,
        keptMessageCount: 3,
        willRetriggerNextTurn: false,
      });
    });

    it("should track checkpoint and rewind projection", () => {
      const events: SessionEvent[] = [
        createSessionEvent(SessionEventType.SessionCreated, sessionId, {
          mode: "build",
          contextWindow: 200000,
        }),
        createSessionEvent(SessionEventType.CheckpointCreated, sessionId, {
          checkpointId: "checkpoint_1",
          messageId: "msg_1" as MessageId,
          scope: RewindScope.Workspace,
          snapshotRef: "artifact://snapshot_1",
          compactBoundaryId: "compact_1",
          coveredByCompact: true,
          fileCount: 2,
        }),
        createSessionEvent(SessionEventType.RewindTriggered, sessionId, {
          rewindId: "rewind_1",
          scope: RewindScope.Workspace,
          strategy: RewindStrategy.FileOnly,
          targetMessageId: "msg_1" as MessageId,
          targetCheckpointId: "checkpoint_1",
          compactBoundaryId: "compact_1",
          restoredSnapshotRef: "artifact://snapshot_1",
          reason: "target_covered_by_compact_file_only_available",
        }),
      ];

      const projection = reducer.reduce(events);
      expect(projection.lastCheckpoint).toMatchObject({
        checkpointId: "checkpoint_1",
        compactBoundaryId: "compact_1",
        coveredByCompact: true,
        fileCount: 2,
        messageId: "msg_1",
        scope: "workspace",
        snapshotRef: "artifact://snapshot_1",
      });
      expect(projection.lastRewind).toMatchObject({
        compactBoundaryId: "compact_1",
        reason: "target_covered_by_compact_file_only_available",
        rewindId: "rewind_1",
        scope: "workspace",
        strategy: "file_only",
        targetCheckpointId: "checkpoint_1",
        targetMessageId: "msg_1",
      });
    });
  });

  describe("apply", () => {
    it("should apply a single event to projection", () => {
      let projection = reducer.reduce([]);

      const sessionCreatedEvent = createSessionEvent(SessionEventType.SessionCreated, sessionId, {
        mode: "build",
        contextWindow: 200000,
      });

      projection = reducer.apply(projection, sessionCreatedEvent);
      expect(projection.id).toBe(sessionId);
    });
  });
});

function buildTarget(sessionId: SessionId, objective: string, status: GoalStatus): SessionGoal {
  return {
    objective,
    sessionID: sessionId,
    status,
    summaryTitle: null,
    targetID: "target_1",
    time: {
      created: 1,
      updated: 1,
    },
    timeUsedSeconds: 0,
    tokenBudget: null,
    tokensUsed: 0,
  };
}
