import { describe, expect, it } from "vitest";
import type { ConversationSnapshot, SessionSummary } from "@zcode/shared/zcode-protocol-v4";
import {
  collectPendingInteractionNotificationPayloads,
  collectTerminalTaskNotificationPayloads,
} from "../src/lib/taskNotificationOrchestrator.js";

const messages: Record<string, string> = {
  "notification.completed": "Task completed",
  "notification.completedBody": "Task completed",
  "notification.error": "Task error occurred",
  "notification.inputRequired": "Your response is needed",
  "notification.permissionRequired": "Your confirmation is needed",
  "notification.planApprovalBody": "Review the plan to continue.",
  "notification.planApprovalRequired": "Plan awaiting approval",
  "notification.taskWithTitle": "Task: {title}",
};

const formatMessage = (descriptor: { id: string }, values?: Record<string, string>) => {
  let message = messages[descriptor.id] ?? descriptor.id;
  for (const [key, value] of Object.entries(values ?? {})) {
    message = message.replaceAll(`{${key}}`, value);
  }
  return message;
};

function sessionSummary(
  phase: SessionSummary["phase"],
  overrides: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    sessionId: "session-1",
    workspaceId: "workspace-1",
    title: "Build docs",
    phase,
    sessionEnded: phase === "completedSuccess" || phase === "completedInterrupted",
    hasBackgroundWork: false,
    lastActivityAt: 100,
    createdAt: 1,
    ...overrides,
  };
}

function snapshot(overrides: Partial<ConversationSnapshot> = {}): ConversationSnapshot {
  return {
    protocolVersion: 1,
    sessionId: "session-1",
    logEpoch: "epoch-1",
    seq: 1,
    revision: 1,
    control: {
      phase: "running",
      sessionEnded: false,
      canStop: true,
      stopState: "stoppable",
      stopTargetKind: "assistant",
      activeWorks: [],
      lastError: null,
      apiRetry: null,
    },
    availability: {
      fork: { allowed: true },
      compact: { allowed: false, reasonCode: "running" },
      switchModelConfig: { allowed: false, reasonCode: "running" },
      setFollowupMode: { allowed: true },
      queueEdit: { allowed: true },
      sendQueuedNow: { allowed: true },
      pauseGoal: { allowed: false, reasonCode: "noGoal" },
      resumeGoal: { allowed: false, reasonCode: "noGoal" },
    },
    inputRouting: { mode: "enqueue" },
    meta: { title: "Build docs", titleSource: "custom" },
    config: { provider: "", model: "", thought: "", followupMode: "queue", mode: "build" },
    usage: {
      contextWindow: null,
      cumulative: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    },
    queue: { items: [], autoDrain: true },
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    goal: null,
    plan: null,
    rows: { window: [], totalCount: 0, firstRowId: null },
    ...overrides,
  };
}

describe("task notification orchestrator", () => {
  it("emits terminal notification only for observed non-terminal to terminal edges", () => {
    const previousBySessionId = new Map<string, SessionSummary>([
      ["session-1", sessionSummary("running")],
      ["session-2", sessionSummary("completedSuccess", { sessionId: "session-2" })],
    ]);

    expect(
      collectTerminalTaskNotificationPayloads({
        previousBySessionId,
        sessions: [
          sessionSummary("completedSuccess"),
          sessionSummary("error", { sessionId: "session-2", title: "Already done" }),
          sessionSummary("completedSuccess", { sessionId: "new-cold-session" }),
        ],
        formatMessage,
      }),
    ).toEqual([
      {
        taskId: "session-1",
        status: "completed",
        title: "Task completed",
        body: "Task: Build docs",
      },
      {
        taskId: "session-2",
        status: "failed",
        title: "Task error occurred",
        body: "Task: Already done",
      },
    ]);
  });

  it("emits pending interaction notifications only for unseen requests", () => {
    const seenRequestIds = new Set(["seen-permission"]);
    const payloads = collectPendingInteractionNotificationPayloads({
      snapshot: snapshot({
        pendingInteractions: [
          {
            interactionId: "seen-permission",
            kind: "permission",
            anchorRowId: null,
            createdAt: 1,
            payload: {
              kind: "permission",
              toolCallId: "tool-1",
              toolName: "Bash",
              summary: "Allow command?",
              detail: {},
              options: [],
            },
          },
          {
            interactionId: "new-question",
            kind: "userInput",
            anchorRowId: null,
            createdAt: 2,
            payload: {
              kind: "userInput",
              prompt: "Which branch should I use?",
              freeText: true,
            },
          },
          {
            interactionId: "workspace-review",
            kind: "workspaceHookReview",
            anchorRowId: null,
            createdAt: 3,
            payload: {
              kind: "workspaceHookReview",
              reviewFlowId: "flow-1",
              generation: 1,
              interactionId: "workspace-review",
              sessionId: "session-1",
              taskId: "session-1",
              runId: "run-1",
              workspaceIdentity: "/workspace",
              workspaceLabel: "workspace",
              bundleDigest: "a".repeat(64),
              createdAt: 3,
              deadlineAt: 603_000,
              sourceFiles: [],
              summary: { eventCount: 0, hookCount: 0, pendingCount: 0 },
              items: [],
              warningCode: "workspace_hooks_execute_code",
            },
          },
          {
            interactionId: "plan-approval",
            kind: "userInput",
            anchorRowId: null,
            createdAt: 3,
            payload: {
              kind: "userInput",
              prompt: "Review plan",
              freeText: true,
              schema: { interaction: "plan_approval", toolName: "ExitPlanMode" },
            },
          },
        ],
      }),
      seenRequestIds,
      formatMessage,
    });

    expect(payloads).toEqual([
      {
        taskId: "session-1",
        status: "elicitation_request",
        requestId: "new-question",
        title: "Your response is needed",
        body: "Which branch should I use?",
      },
      {
        taskId: "session-1",
        status: "elicitation_request",
        requestId: "plan-approval",
        title: "Plan awaiting approval",
        body: "Review the plan to continue.",
      },
    ]);
  });
});
