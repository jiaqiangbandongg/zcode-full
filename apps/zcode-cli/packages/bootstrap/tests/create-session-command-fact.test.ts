import { describe, expect, it, vi } from "vitest";
import type { SessionId, SessionInputRecord, SessionStorePort } from "@zcode/contracts";
import { lookupGlobalCreateSessionCommand } from "../src/zcode-protocol-v4/create-session-command-fact.js";

const sessionId = "session-created-first" as SessionId;

function record(status: SessionInputRecord["status"]): SessionInputRecord {
  return {
    id: "queue_create-command",
    sessionID: sessionId,
    kind: "sendText",
    delivery: "queue",
    payload: {
      text: "first input",
      sourceCommandType: "createSession",
      conversationInputIntent: { sourceCommandId: "create-command" },
    },
    admittedSequence: 0,
    status,
    time: { created: 1, updated: 1 },
  };
}

describe("global createSession command fact", () => {
  it("promoted firstInput 在 ACK 丢失/重启后返回第一次创建的 session", async () => {
    const store = {
      getSessionInputById: vi.fn().mockResolvedValue(record("promoted")),
    } as unknown as SessionStorePort;

    await expect(lookupGlobalCreateSessionCommand(store, "create-command")).resolves.toEqual({
      commandId: "create-command",
      status: "accepted",
      revisionAtDecision: 0,
      result: { type: "createSession", sessionId },
    });
    expect(store.getSessionInputById).toHaveBeenCalledWith("queue_create-command");
  });

  it("restart 前仅 admitted 的 firstInput 显式 discarded，不创建第二个 session", async () => {
    const settleSessionInput = vi.fn().mockResolvedValue(undefined);
    const store = {
      getSessionInputById: vi.fn().mockResolvedValue(record("admitted")),
      settleSessionInput,
    } as unknown as SessionStorePort;

    await expect(lookupGlobalCreateSessionCommand(store, "create-command")).resolves.toMatchObject({
      commandId: "create-command",
      status: "failed",
      reasonCode: "fault.command.inputDiscardedOnRestart",
    });
    expect(settleSessionInput).toHaveBeenCalledWith({
      id: "queue_create-command",
      sessionID: sessionId,
      status: "discarded",
      reason: "session_resumed",
    });
  });

  it("普通 sendText 的同名 ledger 不能冒充 global createSession fact", async () => {
    const ordinary = record("promoted");
    ordinary.payload.sourceCommandType = "sendText";
    const store = {
      getSessionInputById: vi.fn().mockResolvedValue(ordinary),
    } as unknown as SessionStorePort;
    await expect(lookupGlobalCreateSessionCommand(store, "create-command")).resolves.toBeNull();
  });
});
