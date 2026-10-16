import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationSnapshot, ConversationTopicFrame } from "@zcode/shared/zcode-protocol-v4";
import {
  readBotGroupRuntimeSnapshot,
  waitBotGroupExecutionEnd,
} from "../src/zcode-agent/groupRuntimeSnapshot.js";

afterEach(() => vi.useRealTimers());
describe("group CLI snapshot read", () => {
  it("bounds a hanging subscribe and releases a late subscription", async () => {
    vi.useFakeTimers();
    const dispose = vi.fn();
    let acknowledge!: (result: { ack: { subscriptionId: string } }) => void;
    const agent = {
      onDynamicConversationFrame: () => () => ({ dispose }),
      subscribeConversationV4: () =>
        new Promise((resolve) => {
          acknowledge = resolve;
        }),
      unsubscribeConversationV4: vi.fn(async () => undefined),
    };
    const result = readBotGroupRuntimeSnapshot(agent as never, {
      workspacePath: "/work",
      sessionId: "task",
    }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(15000);
    expect(await result).toBeInstanceOf(Error);
    expect(dispose).toHaveBeenCalledOnce();
    acknowledge({ ack: { subscriptionId: "late" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(agent.unsubscribeConversationV4).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptionId: "late" }),
    );
  }, 1000);

  it("registers before subscribe, matches its subscription and always releases it", async () => {
    let listener: (value: unknown) => void = () => {};
    const dispose = vi.fn();
    const frame = makeSnapshotFrame("test");
    const snapshot = frame.payload.kind === "snapshot" ? frame.payload.snapshot : undefined;
    const agent = {
      onDynamicConversationFrame: vi.fn(() => (handler: typeof listener) => {
        listener = handler;
        return { dispose };
      }),
      subscribeConversationV4: vi.fn(async () => {
        listener({
          wireVersion: 1,
          kind: "complete",
          deliveryKind: "initial",
          logicalFrameId: "initial",
          logicalFrameOrdinal: 1,
          topic: "conversation/task",
          subscriptionId: "other",
          frame: { ...frame, subscriptionId: "other" },
        });
        listener({
          wireVersion: 1,
          kind: "complete",
          deliveryKind: "initial",
          logicalFrameId: "initial",
          logicalFrameOrdinal: 1,
          topic: "conversation/task",
          subscriptionId: "mine",
          frame,
        });
        return { ack: { subscriptionId: "mine" } };
      }),
      unsubscribeConversationV4: vi.fn(async () => undefined),
    };
    expect(
      await readBotGroupRuntimeSnapshot(agent as never, {
        workspacePath: "/work",
        workspaceIdentity: "ssh://host/work",
        sessionId: "task",
      }),
    ).toEqual(snapshot);
    expect(agent.unsubscribeConversationV4).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptionId: "mine", workspaceIdentity: "ssh://host/work" }),
    );
    expect(dispose).toHaveBeenCalledOnce();
  });
});

describe("topic authoritative stop barrier", () => {
  function setup() {
    let listener: (value: unknown) => void = () => {};
    const frame = makeSnapshotFrame("topic");
    if (frame.payload.kind !== "snapshot") throw new Error("fixture");
    frame.payload.snapshot.control.activeWorks[0]!.foregroundExecutionId = "old";
    let ordinal = 0;
    const emit = (value: ConversationTopicFrame) =>
      listener({
        wireVersion: 1,
        kind: "complete",
        deliveryKind: ordinal ? "online" : "initial",
        logicalFrameId: `frame-${++ordinal}`,
        logicalFrameOrdinal: ordinal,
        topic: "conversation/task",
        subscriptionId: "mine",
        frame: value,
      });
    const agent = {
      onDynamicConversationFrame: () => (handler: typeof listener) => {
        listener = handler;
        return { dispose: vi.fn() };
      },
      subscribeConversationV4: vi.fn(async () => {
        emit(frame);
        return { ack: { subscriptionId: "mine" } };
      }),
      unsubscribeConversationV4: vi.fn(async () => undefined),
    };
    const terminal = (fromSeq = 11): ConversationTopicFrame => ({
      ...frame,
      fromSeq,
      toSeq: fromSeq + 1,
      payload: {
        kind: "deltas",
        deltas: [
          {
            op: "state.updated",
            patch: {
              control: {
                ...(frame.payload as { kind: "snapshot"; snapshot: ConversationSnapshot }).snapshot
                  .control,
                phase: "completedInterrupted",
                sessionEnded: true,
                canStop: false,
                stopState: "idle",
                activeWorks: [],
              },
            },
          },
        ],
      },
    });
    return { agent, emit, terminal };
  }

  it("waits for terminal control instead of resolving on the initial running snapshot", async () => {
    const f = setup();
    let done = false;
    const waiting = waitBotGroupExecutionEnd(
      f.agent as never,
      { workspacePath: "/work", sessionId: "task" },
      "old",
    ).then(() => {
      done = true;
    });
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(done).toBe(false);
    f.emit(f.terminal());
    await waiting;
    expect(done).toBe(true);
    expect(f.agent.unsubscribeConversationV4).toHaveBeenCalledOnce();
  });

  it("releases its subscription when the stop command fails or is cancelled", async () => {
    const f = setup();
    const abort = new AbortController();
    const waiting = waitBotGroupExecutionEnd(
      f.agent as never,
      { workspacePath: "/work", sessionId: "task" },
      "old",
      abort.signal,
    );
    for (let i = 0; i < 8; i++) await Promise.resolve();
    const rejected = expect(waiting).rejects.toThrow();
    abort.abort();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(f.agent.unsubscribeConversationV4).toHaveBeenCalledOnce();
    await rejected;
    expect(f.agent.unsubscribeConversationV4).toHaveBeenCalledOnce();
  });

  it("rejects a missing control interval instead of assuming stop completed", async () => {
    const f = setup();
    const waiting = waitBotGroupExecutionEnd(
      f.agent as never,
      { workspacePath: "/work", sessionId: "task" },
      "old",
    );
    for (let i = 0; i < 8; i++) await Promise.resolve();
    f.emit(f.terminal(50));
    await expect(waiting).rejects.toThrow(/gap/i);
  });
});

function makeSnapshotFrame(title: string): ConversationTopicFrame {
  const snapshot: ConversationSnapshot = {
    protocolVersion: 1,
    sessionId: "task",
    logEpoch: "epoch-wire",
    seq: 11,
    revision: 1,
    control: {
      phase: "running",
      sessionEnded: false,
      canStop: true,
      stopState: "stoppable",
      stopTargetKind: "assistant",
      activeWorks: [{ kind: "primaryTurn", startedAt: 1_000 }],
      lastError: null,
      apiRetry: null,
    },
    availability: {
      fork: { allowed: true },
      compact: { allowed: true },
      switchModelConfig: { allowed: true },
      setFollowupMode: { allowed: true },
      queueEdit: { allowed: true },
      sendQueuedNow: { allowed: true },
      pauseGoal: { allowed: false, reasonCode: "guard.noGoal" },
      resumeGoal: { allowed: false, reasonCode: "guard.noGoal" },
    },
    inputRouting: { mode: "enqueue" },
    meta: { title, titleSource: "custom" },
    config: {
      provider: "glm",
      model: "glm-5",
      thought: "medium",
      thoughtLevels: [],
      followupMode: "queue",
      mode: "build",
    },
    modelTransition: null,
    usage: {
      contextWindow: {
        usedTokens: 0,
        maxTokens: 200_000,
        autoCompactThresholdTokens: null,
      },
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
    // 软门禁 additive 字段:归一化形态(带 default(null))
    workspaceHookAdmission: null,
    goal: null,
    plan: null,
    rows: { window: [], totalCount: 0, firstRowId: null },
  };
  return {
    topic: "conversation/task",
    subscriptionId: "mine",
    fromSeq: 0,
    toSeq: snapshot.seq,
    sentAt: 1_700_000_000_000,
    payload: { kind: "snapshot", snapshot },
  };
}
