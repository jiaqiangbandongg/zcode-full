import { describe, expect, it, vi } from "vitest";
import type {
  MessageWithParts,
  SessionEntryInfo,
  SessionId,
  SessionInputRecord,
  SessionStorePort,
} from "@zcode/contracts";
import {
  loadPersistentCommandFacts,
  savePersistentCommandFact,
  V4_COMMAND_FACT_SESSION_ENTRY,
} from "../src/zcode-protocol-v4/persistent-command-facts.js";

const sessionId = "session-1" as SessionId;

function storeFixture() {
  const savedEntries: SessionEntryInfo[] = [];
  const messages = [
    {
      info: {
        id: "message-1",
        role: "user",
        anchor: { sourceCommandId: "command-transcript" },
      },
      parts: [],
    },
    {
      info: { id: "message-2", role: "assistant" },
      parts: [
        {
          type: "timeline",
          sourceCommandId: "command-timeline-part",
        },
      ],
    },
  ] as unknown as MessageWithParts[];
  const entries = [
    {
      id: "entry-child",
      sessionID: sessionId,
      type: V4_COMMAND_FACT_SESSION_ENTRY,
      time: { created: 1, updated: 1 },
      data: {
        source: "child",
        ack: {
          commandId: "command-child",
          status: "accepted",
          revisionAtDecision: 0,
          result: { type: "forkAssistant", sessionId: "child-1" },
        },
      },
    },
  ] satisfies SessionEntryInfo[];
  const discarded = [
    {
      id: "queue_command-discarded",
      sessionID: sessionId,
      kind: "sendText",
      delivery: "queue",
      payload: {
        text: "lost on restart",
        conversationInputIntent: { sourceCommandId: "command-discarded" },
      },
      admittedSequence: 1,
      status: "discarded",
      statusReason: "session_resumed",
      time: { created: 1, updated: 2 },
    },
    {
      id: "queue_command-admitted-before-restart",
      sessionID: sessionId,
      kind: "sendText",
      delivery: "queue",
      payload: {
        text: "admitted before process death",
        intent: { sourceCommandId: "command-admitted-before-restart" },
      },
      admittedSequence: 2,
      status: "admitted",
      time: { created: 2, updated: 2 },
    },
    {
      id: "queue_command-user-removed",
      sessionID: sessionId,
      kind: "sendText",
      delivery: "queue",
      payload: {
        text: "user removed queue item",
        conversationInputIntent: { sourceCommandId: "command-user-removed" },
      },
      admittedSequence: 3,
      status: "cancelled",
      statusReason: "user_removed",
      time: { created: 3, updated: 4 },
    },
    {
      id: "queue_command-child-start-failed",
      sessionID: sessionId,
      kind: "sendText",
      delivery: "startNow",
      payload: {
        text: "edited child input",
        conversationInputIntent: { sourceCommandId: "command-child-start-failed" },
      },
      admittedSequence: 4,
      status: "failed",
      statusReason: "fault.command.childStartFailed",
      time: { created: 4, updated: 5 },
    },
  ] satisfies SessionInputRecord[];
  const store = {
    messages: vi.fn().mockResolvedValue(messages),
    sessionEntries: vi.fn().mockResolvedValue(entries),
    listSessionInputs: vi.fn().mockResolvedValue(discarded),
    settleSessionInput: vi.fn().mockResolvedValue(undefined),
    saveSessionEntry: vi.fn().mockImplementation(async (entry: SessionEntryInfo) => {
      savedEntries.push(entry);
    }),
  } as unknown as SessionStorePort;
  return { savedEntries, store };
}

describe("persistent command facts", () => {
  it("loads transcript/timeline/child/discarded by exact sourceCommandId", async () => {
    const { store } = storeFixture();
    const facts = await loadPersistentCommandFacts(store, sessionId, {
      discardAdmittedOnLoad: true,
    });

    expect(facts.transcript).toEqual([
      {
        commandId: "command-transcript",
        status: "accepted",
        revisionAtDecision: 0,
      },
    ]);
    expect(facts.timeline).toEqual([
      {
        commandId: "command-timeline-part",
        status: "accepted",
        revisionAtDecision: 0,
      },
    ]);
    expect(facts.child?.[0]).toMatchObject({
      commandId: "command-child",
      result: { sessionId: "child-1" },
    });
    expect(facts.discarded).toEqual([
      {
        commandId: "command-discarded",
        status: "failed",
        reasonCode: "fault.command.inputDiscardedOnRestart",
        message: "Input was discarded when the CLI restarted; confirm before resending.",
        revisionAtDecision: 0,
        result: { type: "inputDisposition", delivery: "queue" },
      },
      {
        commandId: "command-admitted-before-restart",
        status: "failed",
        reasonCode: "fault.command.inputDiscardedOnRestart",
        message: "Input was discarded when the CLI restarted; confirm before resending.",
        revisionAtDecision: 0,
        result: { type: "inputDisposition", delivery: "queue" },
      },
      {
        commandId: "command-user-removed",
        status: "failed",
        reasonCode: "fault.command.inputCancelled",
        message: "Input was cancelled before it entered the transcript.",
        revisionAtDecision: 0,
      },
    ]);
    expect(store.settleSessionInput).toHaveBeenCalledWith({
      id: "queue_command-admitted-before-restart",
      sessionID: sessionId,
      status: "discarded",
      reason: "session_resumed",
    });
    expect(store.settleSessionInput).toHaveBeenCalledTimes(1);
    expect(facts.discarded?.some((fact) => fact.commandId === "command-child-start-failed")).toBe(
      false,
    );
  });

  it("keeps a user-removed input queryable after the in-memory LRU is gone", async () => {
    const { store } = storeFixture();
    const facts = await loadPersistentCommandFacts(store, sessionId);

    expect(facts.discarded).toContainEqual({
      commandId: "command-user-removed",
      status: "failed",
      reasonCode: "fault.command.inputCancelled",
      message: "Input was cancelled before it entered the transcript.",
      revisionAtDecision: 0,
    });
    expect(
      facts.discarded?.some((fact) => fact.commandId === "command-admitted-before-restart"),
    ).toBe(false);
    expect(store.settleSessionInput).not.toHaveBeenCalled();
  });

  it("saves deterministic child/timeline entries for restart lookup", async () => {
    const { savedEntries, store } = storeFixture();
    await savePersistentCommandFact(
      store,
      sessionId,
      "child",
      {
        commandId: "command-fork",
        status: "accepted",
        revisionAtDecision: 0,
        result: { type: "forkAssistant", sessionId: "child-2" },
      },
      {
        parentSessionId: sessionId,
        sourceCommandId: "command-fork",
        forkTarget: {
          productTurnId: "product-1",
          transcriptTurnId: "runtime-1",
          orderedMessageIds: ["user-1", "assistant-1"],
          boundaryMessageId: "assistant-1",
        },
      },
    );

    expect(savedEntries[0]).toMatchObject({
      id: "v4_command_fact:child:command-fork",
      sessionID: sessionId,
      type: V4_COMMAND_FACT_SESSION_ENTRY,
      data: {
        source: "child",
        ack: {
          commandId: "command-fork",
          result: { sessionId: "child-2" },
        },
        metadata: {
          parentSessionId: sessionId,
          sourceCommandId: "command-fork",
          forkTarget: expect.objectContaining({ boundaryMessageId: "assistant-1" }),
        },
      },
    });
  });
});
