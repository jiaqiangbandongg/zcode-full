import { describe, expect, it, vi } from "vitest";
import { Emitter } from "@zcode/rpc";
import type { ISourceServerManagementService } from "@zcode/services";
import { getSourceServerDisplayNameRegistry } from "@/store/sourceServerDisplayNameRegistry.js";

describe("Source Server display-name registry", () => {
  it("shares one snapshot request and state subscription across consumers", async () => {
    const stateEmitter = new Emitter<never>();
    const getSnapshot = vi.fn(async () => ({
      generation: 1,
      profiles: [],
      servers: [{ sourceServerId: "source-a", displayName: "Server A", installState: "installed" }],
      workspaceHistory: [],
      states: [],
      failedPathCount: 0,
      abandonedPathCount: 0,
      migrationCounts: [],
    }));
    const management = {
      getSnapshot,
      onDidChangeState: stateEmitter.event,
    } as unknown as ISourceServerManagementService;
    const first = getSourceServerDisplayNameRegistry(management);
    const second = getSourceServerDisplayNameRegistry(management);
    const disposeFirst = first.subscribe(vi.fn());
    const disposeSecond = second.subscribe(vi.fn());
    await vi.waitFor(() => expect(getSnapshot).toHaveBeenCalledOnce());

    expect(first).toBe(second);
    expect(first.getSnapshot().get("source-a")).toBe("Server A");
    stateEmitter.fire(undefined as never);
    await vi.waitFor(() => expect(getSnapshot).toHaveBeenCalledTimes(2));
    disposeFirst();
    disposeSecond();
  });

  it("refreshes display names from a directory delta so renames propagate without a state change", async () => {
    // 合同 §8.1.4：设备重命名等 Directory 写入不触发 onDidChangeState，
    // registry 必须双订阅 onDidChangeDirectory 才能同步显示名。
    const stateEmitter = new Emitter<never>();
    const directoryEmitter = new Emitter<{ generation: number }>();
    const snapshotOf = (displayName: string, generation: number) => ({
      generation,
      profiles: [],
      servers: [
        { sourceServerId: "source-a", displayName, installState: "installed" },
      ],
      workspaceHistory: [],
      states: [],
      failedPathCount: 0,
      abandonedPathCount: 0,
      migrationCounts: [],
    });
    const getSnapshot = vi
      .fn()
      .mockResolvedValueOnce(snapshotOf("Old Name", 1))
      .mockResolvedValueOnce(snapshotOf("New Name", 2));
    const management = {
      getSnapshot,
      onDidChangeState: stateEmitter.event,
      onDidChangeDirectory: directoryEmitter.event,
    } as unknown as ISourceServerManagementService;

    const registry = getSourceServerDisplayNameRegistry(management);
    const dispose = registry.subscribe(vi.fn());
    await vi.waitFor(() =>
      expect(registry.getSnapshot().get("source-a")).toBe("Old Name"),
    );

    directoryEmitter.fire({ generation: 2 });
    await vi.waitFor(() =>
      expect(registry.getSnapshot().get("source-a")).toBe("New Name"),
    );
    expect(getSnapshot).toHaveBeenCalledTimes(2);
    dispose();
  });
});
