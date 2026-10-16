import { describe, expect, it } from "vitest";
import {
  SessionEventType,
  STREAM_RECOVERY_DISCARDED_ERROR_NAME,
  STREAM_RECOVERY_DISCARDED_FINISH,
  type MessageWithParts,
  type SessionEvent,
  type SessionInfo,
  type SessionProjection,
  type ToolPart,
} from "@zcode/contracts";
import {
  paginateEndedSubagents,
  projectSessionSubagents,
} from "../src/zcode-protocol/subagent-session-query.js";

function session(id: string, taskType: SessionInfo["taskType"] = "subagent_child"): SessionInfo {
  return {
    id: id as SessionInfo["id"],
    projectID: "project" as SessionInfo["projectID"],
    taskType,
    slug: id,
    directory: "/workspace",
    title: id,
    version: "test",
    time: { created: 1, updated: 100 },
  };
}

function toolMessage(input: {
  childSessionId?: string;
  id: string;
  output?: Record<string, unknown> | string;
  runInBackground?: boolean;
  state?: "completed" | "error" | "running";
  tool?: string;
}): MessageWithParts {
  const state = input.state ?? "completed";
  const common = {
    input: {
      description: `Description ${input.id}`,
      subagent_type: "Explore",
      ...(input.runInBackground ? { run_in_background: true } : {}),
    },
    metadata: input.childSessionId ? { childSessionId: input.childSessionId } : {},
    time: state === "running" ? { start: 10 } : { start: 10, end: 20 },
  };
  const part: ToolPart = {
    id: `part-${input.id}` as ToolPart["id"],
    sessionID: "parent" as ToolPart["sessionID"],
    messageID: input.id as ToolPart["messageID"],
    type: "tool",
    callID: `call-${input.id}`,
    tool: input.tool ?? "Agent",
    state:
      state === "running"
        ? { ...common, status: "running" }
        : state === "error"
          ? { ...common, status: "error", error: "Provider failed" }
          : {
              ...common,
              status: "completed",
              output:
                typeof input.output === "string"
                  ? input.output
                  : JSON.stringify(input.output ?? { result: `Summary ${input.id}` }),
              title: `Description ${input.id}`,
            },
  };
  return {
    info: {
      id: input.id as never,
      sessionID: "parent" as never,
      role: "assistant",
      time: { created: 10, completed: 20 },
      parentID: "user" as never,
      modelID: "model" as never,
      providerID: "provider" as never,
      mode: "build",
      agent: "zcode",
      path: { cwd: "/workspace", root: "/workspace" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [part],
  };
}

function projection(status: SessionProjection["status"]): SessionProjection {
  return {
    id: "child" as never,
    createdAt: new Date(1),
    updatedAt: new Date(2),
    mode: "build",
    status,
    turnCount: 1,
    totalTokenCount: 0,
    contextUsed: 0,
    contextWindow: 1,
    pendingPermissions: [],
    pendingSteerInputs: [],
    activeToolCalls: [],
    streamingToolLedger: [],
    backgroundTasks: [],
    targetCompletionVerifications: [],
    targetCompletionVerificationTimeline: [],
  };
}

function subagentEvent(
  type: typeof SessionEventType.SubagentSpawned | typeof SessionEventType.SubagentStopped,
  payload: Record<string, unknown>,
): SessionEvent {
  return {
    id: "event" as never,
    sessionId: "parent" as never,
    type,
    timestamp: new Date(15),
    traceId: "trace" as never,
    sequenceNumber: 1,
    payload,
  };
}

describe("subagent session query", () => {
  it("projects Agent and legacy Task refs but omits non-persisted children", () => {
    const result = projectSessionSubagents({
      revision: 3,
      parentSession: session("parent", "interactive"),
      messages: [
        toolMessage({ childSessionId: "child-agent", id: "m1" }),
        toolMessage({ childSessionId: "child-task", id: "m2", tool: "Task" }),
        toolMessage({ childSessionId: "missing", id: "m3" }),
      ],
      childSessionsById: new Map([
        ["child-agent", session("child-agent")],
        ["child-task", session("child-task")],
      ]),
      childMessagesById: new Map(),
      childProjectionsById: new Map(),
    });

    expect(result.running).toEqual([]);
    expect(result.ended.map((item) => item.childSessionId)).toEqual(["child-task", "child-agent"]);
    expect(result.ended[0]).toMatchObject({
      status: "success",
      subagentType: "Explore",
      summary: "Summary m2",
    });
  });

  it("uses live child and background state without duplicating the persisted ref", () => {
    const parentProjection = projection("running");
    parentProjection.backgroundTasks = [
      {
        taskId: "agent-1",
        taskKind: "subagent",
        childSessionId: "child-1",
        blocked: true,
        status: "running",
        startedAt: new Date(10),
      },
    ];
    const result = projectSessionSubagents({
      revision: 4,
      parentSession: session("parent", "interactive"),
      messages: [toolMessage({ childSessionId: "child-1", id: "m1", state: "running" })],
      childSessionsById: new Map([["child-1", session("child-1")]]),
      childMessagesById: new Map(),
      childProjectionsById: new Map([["child-1", projection("waiting")]]),
      parentProjection,
    });

    expect(result.ended).toEqual([]);
    expect(result.running).toEqual([
      expect.objectContaining({ childSessionId: "child-1", status: "blocked" }),
    ]);
  });

  it("uses live spawn events for foreground children before the Agent result is persisted", () => {
    const parentProjection = projection("running");
    parentProjection.backgroundTasks = [
      {
        taskId: "agent-live",
        taskKind: "subagent",
        childSessionId: "child-live",
        status: "running",
        startedAt: new Date(10),
      },
    ];
    const result = projectSessionSubagents({
      revision: 5,
      parentSession: session("parent", "interactive"),
      messages: [toolMessage({ id: "m1", state: "running" })],
      childSessionsById: new Map([["child-live", session("child-live")]]),
      childMessagesById: new Map(),
      childProjectionsById: new Map(),
      parentEvents: [
        subagentEvent(SessionEventType.SubagentSpawned, {
          agentId: "agent-live",
          agentType: "Explore",
          childSessionId: "child-live",
          parentToolCallId: "call-m1",
          description: "Live foreground Agent",
        }),
      ],
      parentProjection,
    });

    expect(result.running).toEqual([
      expect.objectContaining({ childSessionId: "child-live", status: "running" }),
    ]);
  });

  it("keeps a launched background child running when a partial projection omits its task", () => {
    const childSessionId = "sess_subagent_agent-keepalive";
    const result = projectSessionSubagents({
      revision: 6,
      parentSession: session("parent", "interactive"),
      messages: [
        toolMessage({
          childSessionId,
          id: "m1",
          output:
            "Async agent launched successfully.\nagentId: agent-keepalive\nThe agent is working in the background.",
          runInBackground: true,
        }),
      ],
      childSessionsById: new Map([[childSessionId, session(childSessionId)]]),
      childMessagesById: new Map([[childSessionId, []]]),
      childProjectionsById: new Map(),
    });

    expect(result.ended).toEqual([]);
    expect(result.running).toEqual([
      expect.objectContaining({ childSessionId, status: "running" }),
    ]);
  });

  it("does not treat a completed child tool-call model step as a terminal child outcome", () => {
    const childSessionId = "sess_subagent_agent-child-tool";
    const childToolStep = toolMessage({
      id: "child-tool-step",
      state: "running",
      tool: "Bash",
    });
    childToolStep.info.time.completed = 30;
    childToolStep.info.finish = "tool-calls";

    const result = projectSessionSubagents({
      revision: 7,
      parentSession: session("parent", "interactive"),
      messages: [
        toolMessage({
          childSessionId,
          id: "m1",
          output:
            "Async agent launched successfully.\nagentId: agent-child-tool\nThe agent is working in the background.",
          runInBackground: true,
        }),
      ],
      childSessionsById: new Map([[childSessionId, session(childSessionId)]]),
      childMessagesById: new Map([[childSessionId, [childToolStep]]]),
      childProjectionsById: new Map(),
      parentEvents: [
        subagentEvent(SessionEventType.SubagentSpawned, {
          agentId: "agent-child-tool",
          childSessionId,
          parentToolCallId: "call-m1",
          description: "Child tool Agent",
        }),
      ],
    });

    expect(result.ended).toEqual([]);
    expect(result.running).toEqual([
      expect.objectContaining({ childSessionId, status: "running" }),
    ]);
  });

  it("does not treat a stream recovery discarded child step as a failed child outcome", () => {
    const childSessionId = "sess_subagent_agent-child-discarded";
    const discardedStep = toolMessage({ id: "child-discarded", state: "running", tool: "Bash" });
    discardedStep.parts = [];
    discardedStep.info.time.completed = 30;
    discardedStep.info.finish = STREAM_RECOVERY_DISCARDED_FINISH;
    discardedStep.info.error = {
      name: STREAM_RECOVERY_DISCARDED_ERROR_NAME,
      data: { message: "Partial assistant output was discarded before a streaming retry." },
    };

    const result = projectSessionSubagents({
      revision: 8,
      parentSession: session("parent", "interactive"),
      messages: [
        toolMessage({
          childSessionId,
          id: "m1",
          output:
            "Async agent launched successfully.\nagentId: agent-child-discarded\nThe agent is working in the background.",
          runInBackground: true,
        }),
      ],
      childSessionsById: new Map([[childSessionId, session(childSessionId)]]),
      childMessagesById: new Map([[childSessionId, [discardedStep]]]),
      childProjectionsById: new Map(),
      parentEvents: [
        subagentEvent(SessionEventType.SubagentSpawned, {
          agentId: "agent-child-discarded",
          childSessionId,
          parentToolCallId: "call-m1",
          description: "Child discarded Agent",
        }),
      ],
    });

    expect(result.ended).toEqual([]);
    expect(result.running).toEqual([
      expect.objectContaining({ childSessionId, status: "running" }),
    ]);
  });

  it("derives the persisted foreground child id from the completed Agent output agentId", () => {
    const result = projectSessionSubagents({
      revision: 6,
      parentSession: session("parent", "interactive"),
      messages: [
        toolMessage({
          id: "m1",
          output: { agentId: "agent-foreground", result: "Finished foreground work" },
        }),
      ],
      childSessionsById: new Map([
        ["sess_subagent_agent-foreground", session("sess_subagent_agent-foreground")],
      ]),
      childMessagesById: new Map(),
      childProjectionsById: new Map(),
    });

    expect(result.ended).toEqual([
      expect.objectContaining({
        childSessionId: "sess_subagent_agent-foreground",
        summary: "Finished foreground work",
        status: "success",
      }),
    ]);
  });

  it("paginates ended children newest-first with an opaque cursor", () => {
    const ended = Array.from({ length: 25 }, (_, index) => ({
      childSessionId: `child-${index}`,
      subagentType: "Explore",
      title: `Child ${index}`,
      status: "success" as const,
      endedAt: 100 - index,
    }));
    const first = paginateEndedSubagents(ended, { limit: 20 });
    const second = paginateEndedSubagents(ended, { cursor: first.nextCursor, limit: 20 });

    expect(first.items).toHaveLength(20);
    expect(first.nextCursor).toBeTruthy();
    expect(second.items.map((item) => item.childSessionId)).toEqual([
      "child-20",
      "child-21",
      "child-22",
      "child-23",
      "child-24",
    ]);
    expect(second.nextCursor).toBeUndefined();
  });
});
