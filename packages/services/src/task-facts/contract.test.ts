import { describe, expect, it, vi } from "vitest";
import type { TaskFactSource, TaskFactStore, TaskFactsContract } from "#src/task-facts/contract.js";
import { createTaskFacts } from "#src/task-facts/index.js";
const target = { workspacePath: "/repo", taskId: "session" };
const meta = {
  ...target,
  title: "old",
  createdAt: 1,
  updatedAt: 2,
  traceId: "trace",
  mode: "default" as const,
};
function fixture() {
  const store: TaskFactStore = {
    applyCliFacts: vi.fn(async (facts) => facts.meta),
    applyCliDeletion: vi.fn(async () => {}),
    markCliOrphan: vi.fn(async () => {}),
    listReconciliationRows: vi.fn(async () => [{ meta, handoffPending: 8 }]),
    getTaskMeta: vi.fn(async () => meta),
  };
  const source: TaskFactSource = {
    reconcile: vi.fn(async () => ({ sessions: [] })),
    execute: vi.fn(async () => {}),
  };
  const changed = vi.fn();
  const port: TaskFactsContract = createTaskFacts({ store, source, changed });
  return { store, source, changed, port };
}
describe("task-facts contract", () => {
  it("discards a refresh response overtaken by a newer streamed fact", async () => {
    const { port, source, store } = fixture();
    let release!: () => void;
    vi.mocked(source.reconcile).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        sessions: [
          {
            sessionId: "session",
            exists: true,
            deleted: false,
            title: "old reply",
            titleSource: "generated",
            createdAt: 1,
            updatedAt: 2,
            lastOutcome: "completed",
          },
        ],
      };
    });
    const refresh = port.refresh(target);
    await port.ingest(target, {
      sessionId: "session",
      workspaceId: "/repo",
      title: "new fact",
      createdAt: 1,
      lastActivityAt: 3,
      lastOutcome: "error",
      phase: "error",
      sessionEnded: true,
      hasBackgroundWork: false,
    });
    release();
    await refresh;
    expect(store.applyCliFacts).toHaveBeenCalledTimes(1);
    expect(store.applyCliFacts).toHaveBeenCalledWith(
      expect.objectContaining({ meta: expect.objectContaining({ title: "new fact" }) }),
    );
  });
  it("does not change persistence or publish when CLI rejects a mutation", async () => {
    const { port, source, store, changed } = fixture();
    vi.mocked(source.execute).mockRejectedValue(new Error("offline"));
    await expect(port.mutate(target, { type: "rename", title: "new" })).rejects.toThrow("offline");
    expect(store.applyCliFacts).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
  });
  it("keeps missing rows and discards a stale reconciliation result", async () => {
    const { port, source, store } = fixture();
    vi.mocked(source.reconcile).mockResolvedValue({
      sessions: [{ sessionId: target.taskId, exists: false, deleted: false }],
    });
    await port.reconcile(target, new Set(), () => true);
    expect(store.markCliOrphan).toHaveBeenCalledWith(target);
    expect(store.applyCliDeletion).not.toHaveBeenCalled();
    vi.mocked(store.markCliOrphan).mockClear();
    let current = true;
    vi.mocked(source.reconcile).mockImplementation(async () => {
      current = false;
      return { sessions: [{ sessionId: target.taskId, exists: false, deleted: false }] };
    });
    await port.reconcile(target, new Set(), () => current);
    expect(store.markCliOrphan).not.toHaveBeenCalled();
  });
  it("mirrors CLI timestamps and outcomes without changing organization", async () => {
    const { port, store } = fixture();
    await port.ingest(target, {
      sessionId: target.taskId,
      workspaceId: "/repo",
      title: "CLI",
      titleSource: "custom",
      createdAt: 1,
      lastActivityAt: 2,
      lastOutcome: "interrupted",
      phase: "completedInterrupted",
      sessionEnded: true,
      hasBackgroundWork: false,
    });
    expect(store.applyCliFacts).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({ title: "CLI", updatedAt: 2 }),
        lastOutcome: "interrupted",
      }),
    );
    expect(vi.mocked(store.applyCliFacts).mock.calls[0]![0].meta).not.toHaveProperty("pinned");
  });
  it("does not manufacture a durable outcome when a live phase lacks lastOutcome", async () => {
    const { port, store } = fixture();
    await port.ingest(target, {
      sessionId: "session",
      workspaceId: "/repo",
      title: "CLI",
      createdAt: 1,
      lastActivityAt: 2,
      phase: "error",
      sessionEnded: true,
      hasBackgroundWork: false,
    });
    expect(vi.mocked(store.applyCliFacts).mock.calls[0]![0].lastOutcome).toBeUndefined();
    expect(vi.mocked(store.applyCliFacts).mock.calls[0]![0].meta.status).toBeUndefined();
  });
});
