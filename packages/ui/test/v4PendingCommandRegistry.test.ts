import { describe, expect, it, vi } from "vitest";
import type {
  CommandAck,
  CommandEnvelope,
  ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";
import {
  PENDING_COMMAND_TTL_MS,
  PendingCommandRegistry,
} from "../src/v4/pendingCommandRegistry.js";
import {
  isPendingCommandForWorkspace,
  resolvePendingCommandWorkspaceKey,
} from "../src/v4/pendingCommandWorkspace.js";

class MemoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function envelope(overrides: Partial<CommandEnvelope> = {}): CommandEnvelope {
  return {
    commandId: "command-1",
    clientId: "client-1",
    sessionId: "session-1",
    type: "sendText",
    payload: { text: "hello", attachments: [{ ref: "attachment-1", kind: "file" }] },
    issuedAt: 1_000,
    ...overrides,
  } as CommandEnvelope;
}

function ack(commandId: string, status: CommandAck["status"], reasonCode?: string): CommandAck {
  return {
    commandId,
    status,
    ...(reasonCode ? { reasonCode } : {}),
    revisionAtDecision: 1,
  };
}

function snapshot(
  rows: ConversationSnapshot["rows"]["window"],
  queueItems: ConversationSnapshot["queue"]["items"] = [],
): ConversationSnapshot {
  return {
    sessionId: "session-1",
    logEpoch: "epoch-1",
    seq: 1,
    revision: 1,
    meta: { title: "", titleSource: "default" },
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
      pauseGoal: { allowed: false, reasonCode: "running" },
      resumeGoal: { allowed: false, reasonCode: "running" },
    },
    inputRouting: { mode: "enqueue" },
    config: { provider: "p", model: "m", thought: "medium", followupMode: "queue", mode: "build" },
    usage: {
      contextWindow: {
        usedTokens: 0,
        maxTokens: 100,
        autoCompactThresholdTokens: null,
      },
      modelUsage: [],
    },
    goal: null,
    plan: null,
    backgroundWorks: [],
    pendingInteractions: [],
    pendingCommands: [],
    queue: { autoDrain: true, items: queueItems },
    rows: { firstRowId: rows[0]?.rowId ?? null, totalCount: rows.length, window: rows },
  };
}

describe("V4 pending command registry", () => {
  it("createSession 重发会保留原始 grouped draft identity 与 placement", () => {
    const storage = new MemoryStorage();
    const registry = new PendingCommandRegistry({ storage, now: () => 1_000 });
    const groupedDraftTask = {
      draftId: "grouped-draft-a",
      workspacePath: "/repo",
      placement: { type: "group" as const, groupId: "group-a" },
      createdAt: 900,
    };
    registry.record(
      envelope({
        commandId: "create-session-1",
        sessionId: null,
        type: "createSession",
        payload: { workspaceId: "/repo", firstInput: { text: "hello" } },
      }),
      { workspace: { workspacePath: "/repo" }, groupedDraftTask },
    );

    const reloaded = new PendingCommandRegistry({ storage, now: () => 1_001 });
    expect(
      reloaded.consumeReplay({ sessionId: null, commandId: "create-session-1" })?.clientContext,
    ).toEqual({ workspace: { workspacePath: "/repo" }, groupedDraftTask });
  });

  it("createSession workspace key 优先使用 identity 并兼容旧 payload", () => {
    const registry = new PendingCommandRegistry({ storage: new MemoryStorage() });
    registry.record(
      envelope({
        commandId: "create-with-identity",
        sessionId: null,
        type: "createSession",
        payload: { workspaceId: "ssh://old/repo", firstInput: { text: "hello" } },
      }),
      {
        workspace: {
          workspacePath: "/repo",
          workspaceIdentity: "ssh://host/repo",
        },
      },
    );
    registry.record(
      envelope({
        commandId: "legacy-create",
        sessionId: null,
        type: "createSession",
        payload: { workspaceId: "ssh://legacy/repo", firstInput: { text: "hello" } },
      }),
    );

    expect(resolvePendingCommandWorkspaceKey(registry.list(null)[0]!)).toBe("ssh://host/repo");
    expect(resolvePendingCommandWorkspaceKey(registry.list(null)[1]!)).toBe("ssh://legacy/repo");
    expect(isPendingCommandForWorkspace(registry.list(null)[0]!, "/repo", "ssh://host/repo")).toBe(
      true,
    );
    expect(isPendingCommandForWorkspace(registry.list(null)[0]!, "/repo", "ssh://other/repo")).toBe(
      false,
    );
  });

  it("普通输入在首次上行前持久化 24h，reload 不延长 TTL", () => {
    const storage = new MemoryStorage();
    let now = 1_000;
    const registry = new PendingCommandRegistry({ storage, now: () => now });

    registry.record(envelope());
    expect(registry.list("session-1")).toMatchObject([
      {
        commandId: "command-1",
        expiresAt: 1_000 + PENDING_COMMAND_TTL_MS,
        replay: { kind: "input", type: "sendText", payload: { text: "hello" } },
      },
    ]);

    now += 60_000;
    const reloaded = new PendingCommandRegistry({ storage, now: () => now });
    expect(reloaded.list("session-1")[0]?.expiresAt).toBe(1_000 + PENDING_COMMAND_TTL_MS);
    now = 1_000 + PENDING_COMMAND_TTL_MS + 1;
    expect(reloaded.list("session-1")).toEqual([]);
  });

  it("升级前已落盘的 unknown 恢复项不会再进入 UI", () => {
    const storage = new MemoryStorage();
    const registry = new PendingCommandRegistry({ storage, now: () => 1_000 });
    registry.record(envelope({ commandId: "legacy-unknown" }));

    const [storageKey, raw] = [...storage.values.entries()][0] ?? [];
    expect(storageKey).toBeTruthy();
    const persisted = JSON.parse(raw ?? "[]") as Array<Record<string, unknown>>;
    persisted[0] = { ...persisted[0], recovery: "unknown" };
    storage.setItem(storageKey ?? "", JSON.stringify(persisted));

    const reloaded = new PendingCommandRegistry({ storage, now: () => 1_001 });
    expect(reloaded.listRecoverable("session-1")).toEqual([]);
  });

  it("敏感 interaction 只落 digest，不落答案原文", () => {
    const storage = new MemoryStorage();
    const registry = new PendingCommandRegistry({ storage, now: () => 1_000 });
    registry.record(
      envelope({
        commandId: "interaction-1",
        type: "resolveInteraction",
        payload: {
          interactionId: "permission-1",
          answer: { freeText: "secret-answer", content: { token: "secret-token" } },
        },
      }),
    );

    const raw = [...storage.values.values()].join("\n");
    expect(raw).not.toContain("secret-answer");
    expect(raw).not.toContain("secret-token");
    expect(registry.list("session-1")[0]?.replay).toMatchObject({
      kind: "sensitiveDigest",
    });
  });

  it("Workspace Hook 安全决定只落 digest，ACK 不明时仅供 query 对账", () => {
    const storage = new MemoryStorage();
    const registry = new PendingCommandRegistry({ storage, now: () => 1_000 });
    registry.record(
      envelope({
        commandId: "workspace-review-1",
        type: "respondWorkspaceHookReview",
        payload: {
          sessionId: "session-1",
          taskId: "task-1",
          runId: "run-1",
          workspaceIdentity: "local:/workspace",
          bundleDigest: "a".repeat(64),
          reviewFlowId: "flow-1",
          generation: 1,
          interactionId: "interaction-1",
          decision: { action: "trust_selected", reviewItemIds: ["private-item"] },
        },
      }),
    );

    const raw = [...storage.values.values()].join("\n");
    expect(raw).not.toContain("private-item");
    expect(raw).not.toContain("trust_selected");
    expect(registry.list("session-1")[0]?.replay).toMatchObject({
      kind: "sensitiveDigest",
      type: "respondWorkspaceHookReview",
    });
  });

  it("QueueItem 是权威投递证据，立即清除 renderer 持久恢复账本", () => {
    const storage = new MemoryStorage();
    const registry = new PendingCommandRegistry({
      storage,
      now: () => 1_000,
    });
    const command = envelope();
    registry.record(command);
    registry.applyAck(command, ack("command-1", "accepted"));
    registry.reconcileSnapshot(
      snapshot(
        [],
        [
          {
            sourceCommandId: "command-1",
            queueItemId: "queue-1",
            clientId: "client-1",
            kind: "sendText",
            text: "hello",
            attachments: [],
            delivery: "queued",
            admittedAt: 1,
            admissionSeq: 1,
            dispatch: { state: "queued" },
          },
        ],
      ),
    );
    expect(registry.list("session-1")).toEqual([]);
    expect(new PendingCommandRegistry({ storage, now: () => 2_000 }).list("session-1")).toEqual([]);
  });

  it("compact accepted 后保留恢复线索，直到 timeline marker 证明已开始执行", () => {
    const registry = new PendingCommandRegistry({
      storage: new MemoryStorage(),
      now: () => 1_000,
    });
    const command = envelope({ type: "compact", payload: {} });
    registry.record(command);
    registry.applyAck(command, ack("command-1", "accepted"));
    expect(registry.list("session-1")).toMatchObject([
      { replay: { kind: "input", type: "compact", payload: {} } },
    ]);

    registry.reconcileSnapshot(
      snapshot([
        {
          rowId: 1,
          turnId: "turn-1",
          createdAt: 1,
          createdAtSeq: 1,
          kind: "timelineMarker",
          sourceCommandId: "command-1",
          marker: { type: "compact", origin: "manual", status: "running" },
        },
      ]),
    );
    expect(registry.list("session-1")).toEqual([]);
  });

  it("携 firstInput 的 createSession accepted 后把账本迁到真实 session", () => {
    const registry = new PendingCommandRegistry({
      storage: new MemoryStorage(),
      now: () => 1_000,
    });
    const command = envelope({
      commandId: "create-1",
      sessionId: null,
      type: "createSession",
      payload: { workspaceId: "/repo", firstInput: { text: "hello" } },
    });
    registry.record(command);
    registry.applyAck(command, {
      ...ack("create-1", "accepted"),
      result: { type: "createSession", sessionId: "created-session" },
    });

    expect(registry.list(null)).toEqual([]);
    expect(registry.list("created-session")).toMatchObject([
      { commandId: "create-1", sessionId: "created-session" },
    ]);
  });

  it("unknown 静默清账，restart discarded 按 delivery 只保留 startNow 确认", () => {
    const registry = new PendingCommandRegistry({
      storage: new MemoryStorage(),
      now: () => 1_000,
    });
    for (const commandId of [
      "unknown",
      "discarded-start",
      "discarded-queue",
      "discarded-guide",
      "unavailable",
    ]) {
      registry.record(envelope({ commandId }));
    }
    registry.applyQuery({
      results: [
        { key: { sessionId: "session-1", commandId: "unknown" }, result: "unknown" },
        {
          key: { sessionId: "session-1", commandId: "discarded-start" },
          result: {
            ...ack("discarded-start", "failed", "fault.command.inputDiscardedOnRestart"),
            result: { type: "inputDisposition", delivery: "startNow" },
          },
        },
        {
          key: { sessionId: "session-1", commandId: "discarded-queue" },
          result: {
            ...ack("discarded-queue", "failed", "fault.command.inputDiscardedOnRestart"),
            result: { type: "inputDisposition", delivery: "queue" },
          },
        },
        {
          key: { sessionId: "session-1", commandId: "discarded-guide" },
          result: {
            ...ack("discarded-guide", "failed", "fault.command.inputDiscardedOnRestart"),
            result: { type: "inputDisposition", delivery: "guide" },
          },
        },
        {
          key: { sessionId: "session-1", commandId: "unavailable" },
          result: ack("unavailable", "failed", "fault.command.queryUnavailable"),
        },
      ],
    });

    expect(registry.listRecoverable("session-1").map((entry) => entry.recovery)).toEqual([
      "discarded",
    ]);
    expect(registry.list("session-1").map((entry) => entry.commandId)).not.toContain("unknown");
    expect(registry.list("session-1").map((entry) => entry.commandId)).not.toContain(
      "discarded-queue",
    );
    expect(registry.list("session-1").map((entry) => entry.commandId)).not.toContain(
      "discarded-guide",
    );
    expect(registry.list("session-1").map((entry) => entry.commandId)).toContain("unavailable");
  });

  it("reconnect query 按 64 分批且同 session 单飞，确认重发消费旧记录", async () => {
    const registry = new PendingCommandRegistry({
      storage: new MemoryStorage(),
      now: () => 1_000,
    });
    for (let index = 0; index < 65; index += 1) {
      registry.record(envelope({ commandId: `command-${index}` }));
    }
    const query = vi.fn(
      async (params: { commands: Array<{ sessionId: string | null; commandId: string }> }) => ({
        results: params.commands.map((key) => ({
          key,
          result: {
            ...ack(key.commandId, "failed", "fault.command.inputDiscardedOnRestart"),
            result: { type: "inputDisposition" as const, delivery: "startNow" as const },
          },
        })),
      }),
    );

    await Promise.all([
      registry.reconcileSession("session-1", query),
      registry.reconcileSession("session-1", query),
    ]);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls.map(([params]) => params.commands.length)).toEqual([64, 1]);

    const replay = registry.consumeReplay({ sessionId: "session-1", commandId: "command-0" });
    expect(replay).toMatchObject({ type: "sendText", payload: { text: "hello" } });
    expect(registry.list("session-1").some((entry) => entry.commandId === "command-0")).toBe(false);
  });
});
