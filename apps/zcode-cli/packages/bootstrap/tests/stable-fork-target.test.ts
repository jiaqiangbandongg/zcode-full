import { describe, expect, it, vi } from "vitest";
import type { MessageWithParts, SessionGoal, SessionStorePort } from "@zcode/contracts";
import { resolveStableForkTargetFromTranscript } from "../src/zcode-protocol-v4/stable-fork-target.js";

function message(info: Record<string, unknown>): MessageWithParts {
  return { info: { sessionID: "s1", ...info }, parts: [] } as unknown as MessageWithParts;
}

function store(target: SessionGoal | null = null): SessionStorePort {
  return {
    readTarget: vi.fn().mockResolvedValue(target),
    saveMessage: vi.fn(),
    sessionEntries: vi.fn().mockResolvedValue([]),
  } as unknown as SessionStorePort;
}

const candidate = {
  productTurnId: "product-1",
  transcriptTurnId: "runtime-1",
  startMessageId: "user-1",
  boundaryMessageId: "assistant-2",
};

describe("resolveStableForkTargetFromTranscript", () => {
  it("E10/FX08：fallback 按 user→tool→final assistant raw 顺序固定 logical turn 并补写 anchor", async () => {
    const sessionStore = store();
    const messages = [
      message({ id: "user-1", role: "user", anchor: { turnId: "runtime-1" } }),
      message({ id: "assistant-1", role: "assistant", parentID: "user-1" }),
      message({ id: "tool-1", role: "user", synthetic: true }),
      message({
        id: "assistant-2",
        role: "assistant",
        parentID: "user-1",
        anchor: { turnId: "runtime-1" },
      }),
      message({ id: "user-2", role: "user" }),
    ];

    await expect(
      resolveStableForkTargetFromTranscript({ candidate, messages, store: sessionStore }),
    ).resolves.toEqual({
      ok: true,
      target: {
        productTurnId: "product-1",
        transcriptTurnId: "runtime-1",
        orderedMessageIds: ["user-1", "assistant-1", "tool-1", "assistant-2"],
        boundaryMessageId: "assistant-2",
      },
      goalBoundary: { kind: "none" },
    });
    expect(sessionStore.saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "assistant-2",
        anchor: expect.objectContaining({
          productTurnId: "product-1",
          boundaryMessageId: "assistant-2",
          orderedMessageIds: ["user-1", "assistant-1", "tool-1", "assistant-2"],
          goalBoundary: { kind: "none" },
        }),
      }),
    );
  });

  it("持久 anchor 优先；边界损坏或 fallback 含第二个 real user 时拒绝 ambiguous", async () => {
    const sessionStore = store();
    const persisted = [
      message({ id: "user-1", role: "user" }),
      message({
        id: "assistant-2",
        role: "assistant",
        parentID: "user-1",
        anchor: {
          turnId: "runtime-1",
          productTurnId: "product-1",
          orderedMessageIds: ["user-1", "assistant-2"],
          boundaryMessageId: "assistant-2",
        },
      }),
    ];
    await expect(
      resolveStableForkTargetFromTranscript({
        candidate,
        messages: persisted,
        store: sessionStore,
      }),
    ).resolves.toMatchObject({ ok: true, goalBoundary: { kind: "none" } });
    expect(sessionStore.saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        anchor: expect.objectContaining({ goalBoundary: { kind: "none" } }),
      }),
    );
    vi.mocked(sessionStore.saveMessage).mockClear();

    const ambiguous = [
      message({ id: "user-1", role: "user" }),
      message({ id: "user-x", role: "user" }),
      message({ id: "assistant-2", role: "assistant", parentID: "user-1" }),
    ];
    await expect(
      resolveStableForkTargetFromTranscript({
        candidate,
        messages: ambiguous,
        store: sessionStore,
      }),
    ).resolves.toEqual({ ok: false, reasonCode: "guard.forkTargetAmbiguous" });
  });

  it("新数据可由 candidate 补 productTurnId，并返回持久 goal snapshot", async () => {
    const sessionStore = store();
    const goal: SessionGoal = {
      sessionID: "s1" as never,
      targetID: "target-1",
      objective: "goal at fork",
      summaryTitle: null,
      status: "active",
      tokenBudget: null,
      tokensUsed: 8,
      timeUsedSeconds: 2,
      time: { created: 1, updated: 2 },
    };
    const messages = [
      message({ id: "user-1", role: "user" }),
      message({
        id: "assistant-2",
        role: "assistant",
        parentID: "user-1",
        anchor: {
          turnId: "runtime-1",
          orderedMessageIds: ["user-1", "assistant-2"],
          boundaryMessageId: "assistant-2",
          goalBoundary: {
            kind: "snapshot",
            target: goal,
            verificationEntryIds: ["verify-1"],
          },
        },
      }),
    ];

    await expect(
      resolveStableForkTargetFromTranscript({ candidate, messages, store: sessionStore }),
    ).resolves.toEqual({
      ok: true,
      target: {
        productTurnId: "product-1",
        transcriptTurnId: "runtime-1",
        orderedMessageIds: ["user-1", "assistant-2"],
        boundaryMessageId: "assistant-2",
      },
      goalBoundary: {
        kind: "snapshot",
        target: goal,
        verificationEntryIds: ["verify-1"],
      },
    });
    expect(sessionStore.saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        anchor: expect.objectContaining({ productTurnId: "product-1" }),
      }),
    );
  });

  it("legacy boundary 在 parent 当前仍有 goal 时拒绝冒充 fork 点快照", async () => {
    const currentGoal = {
      sessionID: "s1",
      targetID: "target-current",
      objective: "future goal",
      summaryTitle: null,
      status: "complete",
      tokenBudget: null,
      tokensUsed: 20,
      timeUsedSeconds: 10,
      time: { created: 1, updated: 20 },
    } as SessionGoal;
    const messages = [
      message({ id: "user-1", role: "user" }),
      message({ id: "assistant-2", role: "assistant", parentID: "user-1" }),
    ];

    await expect(
      resolveStableForkTargetFromTranscript({ candidate, messages, store: store(currentGoal) }),
    ).resolves.toEqual({ ok: false, reasonCode: "guard.forkTargetAmbiguous" });
  });
});
