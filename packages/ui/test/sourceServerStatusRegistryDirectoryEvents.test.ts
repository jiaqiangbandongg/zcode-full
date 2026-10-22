import { describe, expect, it, vi } from "vitest";
import { Emitter } from "@zcode/rpc";
import type { ISourceServerManagementService } from "@zcode/services";
import { getSourceServerStatusRegistry } from "@/store/sourceServerStatusRegistry.js";

/**
 * 合同 §8.1.4 消费方双订阅：removeSourceServer 只产生 Directory 写入（onDidChangeDirectory），
 * status registry 必须据此权威重读并清掉已删设备的状态，否则陈旧 online 态会残留。
 */
describe("Source Server status registry directory events", () => {
  it("drops the removed device state after a directory delta without any state change", async () => {
    const stateEmitter = new Emitter<never>();
    const directoryEmitter = new Emitter<{ generation: number }>();
    const withDevice = {
      generation: 1,
      profiles: [
        {
          profileId: "p-1",
          transport: "docker",
          target: { kind: "docker", container: "dev" },
          sourceServerId: "source-a",
          createdAt: 1,
        },
      ],
      servers: [
        {
          sourceServerId: "source-a",
          displayName: "Server A",
          installState: "installed",
        },
      ],
      workspaceHistory: [],
      states: [
        {
          profileId: "p-1",
          sourceServerId: "source-a",
          state: "online",
          updateAvailability: "none",
          updatedAt: 1,
        },
      ],
      failedPathCount: 0,
      abandonedPathCount: 0,
      migrationCounts: [],
    };
    const removed = {
      ...withDevice,
      generation: 2,
      profiles: [],
      servers: [],
      states: [],
    };
    const getSnapshot = vi
      .fn()
      .mockResolvedValueOnce(withDevice)
      .mockResolvedValueOnce(removed);
    const management = {
      getSnapshot,
      onDidChangeState: stateEmitter.event,
      onDidChangeDirectory: directoryEmitter.event,
    } as unknown as ISourceServerManagementService;

    const registry = getSourceServerStatusRegistry(management);
    const dispose = registry.subscribe(vi.fn());
    await vi.waitFor(() =>
      expect(registry.getSnapshot().get("source-a")).toBe("online"),
    );

    directoryEmitter.fire({ generation: 2 });
    await vi.waitFor(() =>
      expect(registry.getSnapshot().has("source-a")).toBe(false),
    );
    expect(getSnapshot).toHaveBeenCalledTimes(2);
    dispose();
  });
});
