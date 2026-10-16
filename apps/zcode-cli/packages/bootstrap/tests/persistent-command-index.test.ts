import { describe, expect, it, vi } from "vitest";
import { PersistentCommandIndex } from "../src/zcode-protocol-v4/persistent-command-index.js";

const ack = (commandId: string, revisionAtDecision = 0) => ({
  commandId,
  status: "accepted" as const,
  revisionAtDecision,
});

describe("PersistentCommandIndex", () => {
  it("同 session 惰性加载一次，四个来源复用同一索引", async () => {
    const loadSession = vi.fn(async () => ({
      workspacePath: "/repo",
      facts: {
        transcript: [ack("transcript")],
        timeline: [ack("timeline")],
      },
    }));
    const index = new PersistentCommandIndex({ loadSession });

    expect(
      await index.lookup("transcript", { sessionId: "session-1", commandId: "transcript" }),
    ).toEqual(ack("transcript"));
    expect(
      await index.lookup("timeline", { sessionId: "session-1", commandId: "timeline" }),
    ).toEqual(ack("timeline"));
    expect(loadSession).toHaveBeenCalledTimes(1);
  });

  it("workspaceIdentity 优先于 workspacePath；foreign incremental record 明确拒绝", async () => {
    const index = new PersistentCommandIndex({
      loadSession: async () => ({
        workspacePath: "/same/path",
        workspaceIdentity: "remote:ssh:host-a:/same/path",
      }),
    });
    await expect(
      index.record(
        { workspacePath: "/same/path", workspaceIdentity: "remote:ssh:host-b:/same/path" },
        "session-1",
        "child",
        ack("fork"),
      ),
    ).rejects.toThrow("fault.command.queryForeignWorkspace");
  });

  it("incremental record 不触发第二次全量 load", async () => {
    const loadSession = vi.fn(async () => ({ workspacePath: "/repo" }));
    const index = new PersistentCommandIndex({ loadSession });
    await index.record({ workspacePath: "/repo" }, "session-1", "discarded", {
      commandId: "discarded",
      status: "failed",
      reasonCode: "fault.command.inputDiscardedOnRestart",
      revisionAtDecision: 0,
    });
    expect(
      await index.lookup("discarded", { sessionId: "session-1", commandId: "discarded" }),
    ).toMatchObject({ status: "failed" });
    expect(loadSession).toHaveBeenCalledTimes(1);
  });

  it("读取失败不缓存，恢复后可重试", async () => {
    let attempts = 0;
    const index = new PersistentCommandIndex({
      loadSession: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("sqlite busy");
        return { workspacePath: "/repo", facts: { transcript: [ack("recovered")] } };
      },
    });
    await expect(
      index.lookup("transcript", { sessionId: "session-1", commandId: "recovered" }),
    ).rejects.toThrow("sqlite busy");
    await expect(
      index.lookup("transcript", { sessionId: "session-1", commandId: "recovered" }),
    ).resolves.toEqual(ack("recovered"));
  });

  it("session unknown 不缓存，后续持久化出现后可见", async () => {
    let available = false;
    const loadSession = vi.fn(async () =>
      available ? { workspacePath: "/repo", facts: { transcript: [ack("appeared")] } } : null,
    );
    const index = new PersistentCommandIndex({ loadSession });
    const key = { sessionId: "session-later", commandId: "appeared" };
    await expect(index.lookup("transcript", key)).resolves.toBeNull();
    available = true;
    await expect(index.lookup("transcript", key)).resolves.toEqual(ack("appeared"));
    expect(loadSession).toHaveBeenCalledTimes(2);
  });
});
