import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import {
  CompactTimelineStatus,
  CompactTrigger,
  SessionEventType,
  type EventId,
  type MessagePart,
  type MessageWithParts,
  type SessionEvent,
  type SessionId,
  type TraceId,
  type TurnId,
} from "@zcode/contracts";
import { activeSessionMessages } from "@zcode/core";
import { conversationTopicFrameSchema } from "@zcode/shared/zcode-protocol-v4";
import { mergeColdConversationEvents } from "../src/zcode-protocol-v4/cold-event-merge.js";
import { ConversationTopicPublisher } from "../src/zcode-protocol-v4/conversation-topic-publisher.js";

const SESSION_ID = "perf03-compacted-full-history-cold-hydration";
const PRECOMPACT_TURN_COUNT = 4_842;
const PRECOMPACT_REASONING_PART_COUNT = 3_236;
const PERSISTED_MESSAGE_COUNT = 10_623;
const PERSISTED_PART_COUNT = 35_811;
const ACTIVE_MESSAGE_COUNT = 939;
const ACTIVE_PART_COUNT = 3_523;
const ACTIVE_TURN_COUNT = 469;
const ACTIVE_TOOL_PART_COUNT = 1_163;
const ACTIVE_EXTRA_TEXT_PART_COUNT = 14;
const CHECKPOINT_COUNT = 1_805;
const TOOL_NAMES = ["Read", "Grep", "Bash", "Edit"] as const;

describe.skipIf(process.env.ZCODE_PERF_REPRO !== "1")(
  "PERF03-E compacted full-history cold hydration repro",
  () => {
    it("replays the full branch even though runtime history uses the compact tail", () => {
      const messages = ticketMessages();
      const activeMessages = activeSessionMessages(messages);
      const checkpoints = ticketCheckpoints();
      expect(messages).toHaveLength(PERSISTED_MESSAGE_COUNT);
      expect(messages.reduce((total, message) => total + message.parts.length, 0)).toBe(
        PERSISTED_PART_COUNT,
      );
      expect(activeMessages).toHaveLength(ACTIVE_MESSAGE_COUNT);
      expect(activeMessages[0]?.info.id).toBe("perf03-compact-boundary");
      expect(activeMessages.reduce((total, message) => total + message.parts.length, 0)).toBe(
        ACTIVE_PART_COUNT,
      );
      expect(
        activeMessages.flatMap((message) => message.parts).filter((part) => part.type === "tool"),
      ).toHaveLength(ACTIVE_TOOL_PART_COUNT);
      expect(checkpoints).toHaveLength(CHECKPOINT_COUNT);

      const totalStartedAt = performance.now();
      const mergeStartedAt = performance.now();
      const merged = mergeColdConversationEvents({
        memoryEvents: checkpoints,
        messages,
        sessionId: SESSION_ID,
      });
      const mergeMs = performance.now() - mergeStartedAt;

      const checkpointDiagnostic = merged.diagnostics.find(
        (diagnostic) => diagnostic.code === "cold_merge.unclassified_event_preserved",
      );
      expect(checkpointDiagnostic).toMatchObject({
        count: CHECKPOINT_COUNT,
        eventTypes: { [SessionEventType.CheckpointCreated]: CHECKPOINT_COUNT },
      });
      expect(
        merged.events.filter((event) => event.type === SessionEventType.CheckpointCreated),
      ).toHaveLength(CHECKPOINT_COUNT);

      const publisher = new ConversationTopicPublisher(SESSION_ID, "perf03-e", {
        now: () => 0,
      });
      const rehydrateStartedAt = performance.now();
      publisher.rehydrate(merged.events);
      const rehydrateMs = performance.now() - rehydrateStartedAt;

      const subscribeStartedAt = performance.now();
      const subscribed = publisher.subscribe({
        connectionId: "perf03-e-desktop",
        deliveryProfile: "continuous",
      });
      const subscribeMs = performance.now() - subscribeStartedAt;
      const totalMs = performance.now() - totalStartedAt;

      expect(subscribed.frame?.payload.kind).toBe("snapshot");
      expect(() => conversationTopicFrameSchema.parse(subscribed.frame)).not.toThrow();
      const snapshot =
        subscribed.frame?.payload.kind === "snapshot"
          ? subscribed.frame.payload.snapshot
          : undefined;
      expect(snapshot).toBeDefined();
      expect(snapshot?.rows.window.some((row) => row.kind === "subagent")).toBe(false);
      expect(snapshot?.subagents).toMatchObject({
        childSessionIds: [],
        endedTotal: 0,
        running: [],
      });

      const frameJson = JSON.stringify(subscribed.frame);
      process.stdout.write(
        `${JSON.stringify({
          caseId: "PERF03-E",
          checkpointCount: CHECKPOINT_COUNT,
          initialFrameBytes: Buffer.byteLength(frameJson, "utf8"),
          initialFrameHash: createHash("sha256").update(frameJson).digest("hex"),
          activeMessageCount: activeMessages.length,
          activePartCount: activeMessages.reduce(
            (total, message) => total + message.parts.length,
            0,
          ),
          mergeMs: roundMs(mergeMs),
          mergedEventCount: merged.events.length,
          persistedMessageCount: messages.length,
          persistedPartCount: messages.reduce((total, message) => total + message.parts.length, 0),
          rehydrateMs: roundMs(rehydrateMs),
          rowCount: snapshot?.rows.totalCount ?? 0,
          subscribeMs: roundMs(subscribeMs),
          totalMs: roundMs(totalMs),
        })}\n`,
      );
    }, 120_000);
  },
);

function ticketMessages(): MessageWithParts[] {
  const messages: MessageWithParts[] = [];
  for (let turn = 0; turn < PRECOMPACT_TURN_COUNT; turn += 1) {
    const userId = `perf03-pre-user-${turn}`;
    const turnId = `perf03-pre-turn-${turn}`;
    const createdAt = 1_700_000_000_000 + turn * 1_000;
    messages.push(userMessage(userId, turnId, createdAt));
    const assistantId = `perf03-pre-assistant-${turn}`;
    messages.push(precompactAssistantMessage(assistantId, userId, turnId, createdAt + 100, turn));
  }

  const lastPrecompactTurn = PRECOMPACT_TURN_COUNT - 1;
  const lastPrecompactUserId = `perf03-pre-user-${lastPrecompactTurn}`;
  const lastSummarizedMessageId = `perf03-pre-assistant-${lastPrecompactTurn}`;
  messages.push(compactionBoundaryMessage(lastPrecompactUserId, lastSummarizedMessageId));

  for (let turn = 0; turn < ACTIVE_TURN_COUNT; turn += 1) {
    const userId = `perf03-active-user-${turn}`;
    const turnId = `perf03-active-turn-${turn}`;
    const createdAt = 1_700_010_000_000 + turn * 1_000;
    messages.push(userMessage(userId, turnId, createdAt));
    messages.push(activeAssistantMessage(userId, turnId, createdAt + 100, turn));
  }
  return messages;
}

function precompactAssistantMessage(
  id: string,
  parentId: string,
  turnId: string,
  createdAt: number,
  turn: number,
): MessageWithParts {
  const parts: MessagePart[] = [
    textPart(`${id}-text`, id, `ticket precompact assistant response ${turn}`, createdAt),
  ];
  if (turn < PRECOMPACT_REASONING_PART_COUNT) {
    parts.push({
      id: `${id}-reasoning` as never,
      sessionID: SESSION_ID as never,
      messageID: id as never,
      type: "reasoning",
      text: `ticket precompact reasoning ${turn}`,
      time: { start: createdAt + 1, end: createdAt + 2 },
    });
  }
  parts.push(
    {
      id: `${id}-step-start` as never,
      sessionID: SESSION_ID as never,
      messageID: id as never,
      type: "step-start",
    },
    completedToolPart(id, turn, "Read", 0, createdAt + 10),
    completedToolPart(id, turn, "Grep", 1, createdAt + 11),
    {
      id: `${id}-step-finish` as never,
      sessionID: SESSION_ID as never,
      messageID: id as never,
      type: "step-finish",
      reason: "stop",
      cost: 0,
      tokens: { input: 1, output: 1, reasoning: 1, cache: { read: 0, write: 0 } },
    },
  );
  return assistantMessage(id, parentId, turnId, createdAt, parts);
}

function userMessage(id: string, turnId: string, createdAt: number): MessageWithParts {
  return {
    info: {
      id: id as never,
      sessionID: SESSION_ID as never,
      role: "user",
      time: { created: createdAt },
      agent: "zcode-agent",
      model: { providerID: "perf-provider" as never, modelID: "perf-model" as never },
      anchor: { turnId: turnId as never, origin: "realUser" },
    },
    parts: [textPart(`${id}-text`, id, `ticket-shaped user prompt ${id}`, createdAt)],
  };
}

function assistantMessage(
  id: string,
  parentId: string,
  turnId: string,
  createdAt: number,
  parts: MessagePart[],
): MessageWithParts {
  const completedAt = createdAt + 500;
  return {
    info: {
      id: id as never,
      sessionID: SESSION_ID as never,
      role: "assistant",
      time: { created: createdAt, completed: completedAt },
      parentID: parentId as never,
      modelID: "perf-model" as never,
      providerID: "perf-provider" as never,
      mode: "build",
      agent: "zcode-agent",
      path: { cwd: "/perf03-e", root: "/perf03-e" },
      cost: 0,
      tokens: { input: 1, output: 1, reasoning: 1, cache: { read: 0, write: 0 } },
      anchor: { turnId: turnId as never },
    },
    parts,
  };
}

function activeAssistantMessage(
  parentId: string,
  turnId: string,
  createdAt: number,
  turn: number,
): MessageWithParts {
  const id = `perf03-active-assistant-${turn}`;
  const threeToolTurnCount = ACTIVE_TOOL_PART_COUNT - ACTIVE_TURN_COUNT * 2;
  const toolCount = turn < threeToolTurnCount ? 3 : 2;
  const parts: MessagePart[] = [
    textPart(`${id}-text`, id, `ticket active assistant response ${turn}`, createdAt),
    {
      id: `${id}-reasoning` as never,
      sessionID: SESSION_ID as never,
      messageID: id as never,
      type: "reasoning",
      text: `ticket active reasoning ${turn}`,
      time: { start: createdAt + 1, end: createdAt + 2 },
    },
    {
      id: `${id}-step-start` as never,
      sessionID: SESSION_ID as never,
      messageID: id as never,
      type: "step-start",
    },
    ...Array.from({ length: toolCount }, (_, toolIndex) =>
      completedToolPart(
        id,
        turn,
        TOOL_NAMES[toolIndex % TOOL_NAMES.length]!,
        toolIndex,
        createdAt + 10 + toolIndex,
      ),
    ),
    {
      id: `${id}-step-finish` as never,
      sessionID: SESSION_ID as never,
      messageID: id as never,
      type: "step-finish",
      reason: "stop",
      cost: 0,
      tokens: { input: 1, output: 1, reasoning: 1, cache: { read: 0, write: 0 } },
    },
  ];
  if (turn < ACTIVE_EXTRA_TEXT_PART_COUNT) {
    parts.push(
      textPart(
        `${id}-text-extra`,
        id,
        `ticket active assistant continuation ${turn}`,
        createdAt + 20,
      ),
    );
  }
  return assistantMessage(id, parentId, turnId, createdAt, parts);
}

function compactionBoundaryMessage(
  parentId: string,
  lastSummarizedMessageId: string,
): MessageWithParts {
  const id = "perf03-compact-boundary";
  const createdAt = 1_700_009_999_000;
  return assistantMessage(id, parentId, `perf03-pre-turn-${PRECOMPACT_TURN_COUNT - 1}`, createdAt, [
    {
      id: `${id}-part` as never,
      sessionID: SESSION_ID as never,
      messageID: id as never,
      type: "compaction",
      auto: true,
      trigger: CompactTrigger.Auto,
      operationId: "perf03-compact-operation",
      timelineStatus: CompactTimelineStatus.Completed,
      tail_start_id: lastSummarizedMessageId as never,
      compactBoundary: {
        boundaryId: "perf03-compact-boundary",
        trigger: CompactTrigger.Auto,
        preCompactTokenCount: 180_000,
        postCompactTokenCount: 42_000,
        summarizedMessageCount: PRECOMPACT_TURN_COUNT * 2,
        lastSummarizedMessageId: lastSummarizedMessageId as never,
        summaryMessageIds: [],
        traceId: "perf03-trace" as TraceId,
      },
    },
  ]);
}

function textPart(
  id: string,
  messageId: string,
  text: string,
  createdAt: number,
): Extract<MessagePart, { type: "text" }> {
  return {
    id: id as never,
    sessionID: SESSION_ID as never,
    messageID: messageId as never,
    type: "text",
    text,
    time: { start: createdAt, end: createdAt },
  };
}

function completedToolPart(
  messageId: string,
  turn: number,
  toolName: (typeof TOOL_NAMES)[number],
  toolIndex: number,
  startedAt: number,
): Extract<MessagePart, { type: "tool" }> {
  return {
    id: `${messageId}-tool-${toolIndex}` as never,
    sessionID: SESSION_ID as never,
    messageID: messageId as never,
    type: "tool",
    callID: `perf03-call-${messageId}-${turn}-${toolIndex}`,
    tool: toolName,
    state: {
      status: "completed",
      input: { path: `/perf03-e/file-${turn}-${toolIndex}.ts` },
      output: `ticket active ${toolName} output ${turn}/${toolIndex}`,
      title: toolName,
      time: { start: startedAt, end: startedAt + 1 },
      metadata: { fixture: "PERF03-E" },
    },
  };
}

function ticketCheckpoints(): SessionEvent[] {
  return Array.from({ length: CHECKPOINT_COUNT }, (_, index) => {
    const turn = index % (PRECOMPACT_TURN_COUNT + ACTIVE_TURN_COUNT);
    const inPrecompactHistory = turn < PRECOMPACT_TURN_COUNT;
    const localTurn = inPrecompactHistory ? turn : turn - PRECOMPACT_TURN_COUNT;
    const messageId = inPrecompactHistory
      ? `perf03-pre-user-${localTurn}`
      : `perf03-active-user-${localTurn}`;
    const turnId = inPrecompactHistory
      ? `perf03-pre-turn-${localTurn}`
      : `perf03-active-turn-${localTurn}`;
    return {
      id: `perf03-checkpoint-event-${index}` as EventId,
      sessionId: SESSION_ID as SessionId,
      turnId: turnId as TurnId,
      type: SessionEventType.CheckpointCreated,
      timestamp: new Date(1_700_001_000_000 + index),
      traceId: "perf03-trace" as TraceId,
      sequenceNumber: index + 1,
      payload: {
        checkpointId: `perf03-checkpoint-${index}`,
        messageId,
        targetMessageId: messageId,
        scope: "workspace",
        snapshotRef: `zcode-artifact://${SESSION_ID}/perf03-checkpoint-${index}`,
        fileCount: 1,
      },
    };
  });
}

function roundMs(value: number): number {
  return Math.round(value * 10) / 10;
}
