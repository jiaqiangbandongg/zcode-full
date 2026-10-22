import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { appSettingsSchema, type ServerRemoteInfo } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import type { ServerReleaseAsset, SourceServerTransportAdapter } from "@zcode/server/source-server";
import { SourceServerConnectionManager } from "@desktop/host/sourceServerConnectionManager.js";
import { SourceServerDirectory } from "@desktop/host/sourceServerDirectory.js";
import { createSourceServerManagementService } from "@desktop/host/sourceServerManagementService.js";

const profileId = "17ef20b3-622d-4a53-98c1-0cdff29f3e6d";
const sourceServerId = "3cd4f9da-cd79-426c-9d70-75f36e9f6a87";
const target = { kind: "docker", container: "update-cancellation" } as const;
const serverInfo: ServerRemoteInfo = {
  serverId: sourceServerId,
  version: "3.8.0",
  protocolVersion: 1,
  authRequired: true,
  workspaces: [],
  compatibility: { schemaVersion: 1, productVersion: "3.8.0", minCompatibleVersion: "3.8.0" },
  identity: { osUser: "dev", hostname: "example" },
  migration: { failedPathCount: 0 },
  capabilities: { desktopContinuous: true, websocketRpc: true },
};
const release: ServerReleaseAsset = {
  localArchivePath: "/tmp/server.tar.gz",
  target: "linux-x64",
  version: "3.8.0",
  sha256: "a".repeat(64),
  sizeBytes: 1024,
  urls: ["https://example.com/server.tar.gz"],
};

async function setup(bound = true) {
  let settings = appSettingsSchema.parse({ sourceServerDirectoryMigrationVersion: 1 });
  let profileSequence = 0;
  const directory = new SourceServerDirectory({
    settingService: {
      get: async () => settings,
      update: async (patch) => {
        settings = appSettingsSchema.parse({ ...settings, ...patch });
      },
    } as never,
    credentialService: { load: async () => null, save: async () => {}, delete: async () => {} },
    createProfileId: () => [
      profileId,
      "4f0f4d21-2798-4608-9d44-889f9f3dc777",
      "78462780-a3bb-4701-a709-a1ecb1dfb39e",
    ][profileSequence++]!,
  });
  const adapter: SourceServerTransportAdapter = {
    kind: "docker",
    probe: vi.fn(async () => ({
      platform: "linux",
      arch: "x64",
      installed: true,
      installedVersion: "3.8.0",
    })),
    installOrUpdate: vi.fn(async () => {}),
    ensureDaemon: vi.fn(async () => ({ port: 43123, ingressToken: "test-token" })),
    openChannel: vi.fn(async () => new PassThrough()),
    exec: vi.fn(async () => ({ exitCode: 0, stdout: "[]", stderr: "" })),
    createFileTransfer: vi.fn(),
    cancel: vi.fn(),
  };
  const closeHandlers: Array<() => void> = [];
  const connectServer = vi.fn(async (options) => {
    closeHandlers.push(() => options.onClose?.({ code: 1006, reason: "test transport closed" }));
    return { serverInfo, services: {} as IServiceAccessor, dispose: vi.fn() };
  });
  const resolveRelease = vi.fn(async () => release);
  const manager = new SourceServerConnectionManager({
    directory,
    createAdapter: () => adapter,
    connectServer,
    compatibilityManifest: serverInfo.compatibility!,
  });
  const management = createSourceServerManagementService({ directory, manager, resolveRelease });
  let profile = await directory.ensureProfile(target);
  if (bound) {
    await manager.connect({ profile, target });
    profile = (await directory.snapshot()).profiles[0]!;
  }
  const reconnected = vi.fn();
  manager.onDidReconnect(reconnected);
  return {
    directory,
    adapter,
    manager,
    management,
    profile,
    connectServer,
    resolveRelease,
    closeHandlers,
    reconnected,
    async addSiblingProfile(container: string) {
      const sibling = await directory.ensureProfile({ kind: "docker", container });
      await directory.recordHandshake(sibling.profileId, {
        sourceServerId,
        version: serverInfo.version,
        workspaces: [],
      });
      return sibling.profileId;
    },
    dispose() {
      management.dispose();
      manager.dispose();
    },
  };
}

function hold() {
  const entered = Promise.withResolvers<void>();
  const settled = Promise.withResolvers<void>();
  return {
    entered: entered.promise,
    finish: settled.resolve,
    fail: settled.reject,
    async wait() {
      entered.resolve();
      await settled.promise;
    },
  };
}

function observe<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ value, error: undefined }),
    (error) => ({ value: undefined, error }),
  );
}

describe("Source update cancellation", () => {
  it.each(["retry", "offline-probe"] as const)(
    "dispose prevents late %s failure from restarting recovery",
    async (phase) => {
      vi.useFakeTimers();
      const f = await setup();
      const gate = hold();
      try {
        if (phase === "offline-probe") {
          vi.mocked(f.adapter.probe)
            .mockRejectedValueOnce(new Error("offline"))
            .mockRejectedValueOnce(new Error("offline"))
            .mockRejectedValueOnce(new Error("offline"));
        }
        vi.mocked(f.adapter.probe).mockImplementationOnce(async () => {
          await gate.wait();
          return { platform: "linux", arch: "x64", installed: true, installedVersion: "3.8.0" };
        });
        f.closeHandlers[0]!();
        await vi.advanceTimersByTimeAsync(phase === "retry" ? 2_000 : 14_000 + 120_000);
        await gate.entered;
        f.manager.dispose();
        gate.finish();
        await vi.advanceTimersByTimeAsync(14_000 + 120_000);
        expect(f.connectServer).toHaveBeenCalledOnce();
        expect(f.manager.getOnlineConnection(sourceServerId)).toBeUndefined();
        expect(f.reconnected).not.toHaveBeenCalled();
        expect(f.manager.getStateByProfile(profileId).state).toBe("offline");
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        gate.finish();
        f.dispose();
        vi.useRealTimers();
      }
    },
  );

  it.each(["probe", "release", "install", "handshake", "running-tasks"] as const)(
    "explicit disconnect wins while %s is pending",
    async (phase) => {
      const f = await setup();
      const gate = hold();
      if (phase === "probe")
        vi.mocked(f.adapter.probe).mockImplementationOnce(async () => {
          await gate.wait();
          return { platform: "linux", arch: "x64", installed: true, installedVersion: "3.8.0" };
        });
      if (phase === "release")
        f.resolveRelease.mockImplementationOnce(async () => {
          await gate.wait();
          return release;
        });
      if (phase === "install")
        vi.mocked(f.adapter.installOrUpdate).mockImplementationOnce(gate.wait);
      if (phase === "handshake") {
        const original = f.directory.recordHandshake.bind(f.directory);
        vi.spyOn(f.directory, "recordHandshake").mockImplementationOnce(async (...args) => {
          await gate.wait();
          return original(...args);
        });
      }
      if (phase === "running-tasks") {
        vi.mocked(f.adapter.installOrUpdate).mockRejectedValueOnce(
          Object.assign(new Error("running tasks"), {
            code: "source-server-update-running-tasks",
            retryable: false,
          }),
        );
        vi.mocked(f.adapter.exec).mockImplementationOnce(async () => {
          await gate.wait();
          return { exitCode: 0, stdout: "[]", stderr: "" };
        });
      }
      try {
        const updating = observe(f.management.updateSource({ profileId }));
        await gate.entered;
        await f.management.disconnectSource(sourceServerId);
        const terminalState = f.manager.getStateByProfile(profileId);
        expect(terminalState.state).toBe("offline");
        gate.finish();
        expect((await updating).error).toMatchObject({ code: "remote-connection-canceled" });
        expect(f.manager.getStateByProfile(profileId)).toEqual(terminalState);
        expect(f.manager.getOnlineConnection(sourceServerId)).toBeUndefined();
        expect(f.reconnected).not.toHaveBeenCalled();
        expect(f.connectServer).toHaveBeenCalledTimes(phase === "handshake" ? 2 : 1);
      } finally {
        gate.finish();
        f.dispose();
      }
    },
  );

  it.each([true, false])(
    "removing a Profile during install stays removed (bound=%s)",
    async (bound) => {
      const f = await setup(bound);
      const gate = hold();
      vi.mocked(f.adapter.installOrUpdate).mockImplementationOnce(gate.wait);
      try {
        const updating = observe(f.management.updateSource({ profileId }));
        await gate.entered;
        await f.management.removeProfile(profileId);
        gate.finish();
        expect((await updating).error).toBeInstanceOf(Error);
        expect(f.manager.getStateByProfile(profileId).state).toBe("absent");
        expect((await f.directory.snapshot()).profiles).toEqual([]);
        expect(f.connectServer).toHaveBeenCalledTimes(bound ? 1 : 0);
        expect(f.manager.getOnlineConnection(sourceServerId)).toBeUndefined();
      } finally {
        gate.finish();
        f.dispose();
      }
    },
  );

  it.each(["success", "failure"] as const)(
    "removing a non-current update Profile restores the original owner before late %s",
    async (outcome) => {
      vi.useFakeTimers();
      const f = await setup();
      const gate = hold();
      try {
        const siblingId = await f.addSiblingProfile("update-route-b");
        vi.mocked(f.adapter.installOrUpdate).mockImplementationOnce(gate.wait);
        const updating = observe(f.management.updateSource({ profileId: siblingId }));
        await gate.entered;
        f.closeHandlers[0]!();
        expect(f.manager.getStateByProfile(profileId).state).toBe("updating");
        await f.management.removeProfile(siblingId);
        expect(f.manager.getStateByProfile(profileId).state).toBe("retrying");
        expect(f.manager.getStateByProfile(siblingId).state).toBe("absent");
        await vi.advanceTimersByTimeAsync(2_000);
        const recovered = f.manager.getOnlineConnection(sourceServerId);
        expect(recovered).toMatchObject({ profileId, sourceServerId });
        expect(vi.mocked(f.adapter.probe).mock.lastCall?.[0]).toBe(target);
        expect(f.reconnected).toHaveBeenCalledOnce();
        if (outcome === "success") gate.finish();
        else gate.fail(new Error("late install failure"));
        expect((await updating).error).toBeInstanceOf(Error);
        expect(f.manager.getOnlineConnection(sourceServerId)).toBe(recovered);
        expect(f.manager.getStateByProfile(profileId).state).toBe("online");
        expect((await f.directory.snapshot()).profiles.map((profile) => profile.profileId)).toEqual([
          profileId,
        ]);
        expect(f.connectServer).toHaveBeenCalledTimes(2);
      } finally {
        gate.finish();
        f.dispose();
        vi.useRealTimers();
      }
    },
  );

  it("does not reconnect a healthy owner when its non-current update Profile is removed", async () => {
    vi.useFakeTimers();
    const f = await setup();
    const gate = hold();
    try {
      const siblingId = await f.addSiblingProfile("update-route-b");
      const original = f.manager.getOnlineConnection(sourceServerId);
      vi.mocked(f.adapter.installOrUpdate).mockImplementationOnce(gate.wait);
      const updating = observe(f.management.updateSource({ profileId: siblingId }));
      await gate.entered;
      await f.management.removeProfile(siblingId);
      gate.finish();
      expect((await updating).error).toBeInstanceOf(Error);
      await vi.advanceTimersByTimeAsync(14_000);
      expect(f.manager.getOnlineConnection(sourceServerId)).toBe(original);
      expect(f.manager.getStateByProfile(profileId).state).toBe("online");
      expect(f.connectServer).toHaveBeenCalledOnce();
      expect(f.reconnected).not.toHaveBeenCalled();
    } finally {
      gate.finish();
      f.dispose();
      vi.useRealTimers();
    }
  });

  it("leaves recovery to another update still in flight", async () => {
    vi.useFakeTimers();
    const f = await setup();
    const removedGate = hold();
    const retainedGate = hold();
    try {
      const siblingId = await f.addSiblingProfile("update-route-b");
      const retainedId = await f.addSiblingProfile("update-route-c");
      vi.mocked(f.adapter.installOrUpdate)
        .mockImplementationOnce(removedGate.wait)
        .mockImplementationOnce(retainedGate.wait);
      const removedUpdate = observe(f.management.updateSource({ profileId: siblingId }));
      await removedGate.entered;
      const retainedUpdate = observe(f.management.updateSource({ profileId: retainedId }));
      await retainedGate.entered;
      f.closeHandlers[0]!();
      await f.management.removeProfile(siblingId);
      removedGate.finish();
      expect((await removedUpdate).error).toBeInstanceOf(Error);
      await vi.advanceTimersByTimeAsync(14_000);
      expect(f.manager.getStateByProfile(profileId).state).toBe("updating");
      expect(f.connectServer).toHaveBeenCalledOnce();
      retainedGate.fail(new Error("retained update failed"));
      expect((await retainedUpdate).error).toBeInstanceOf(Error);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(f.manager.getOnlineConnection(sourceServerId)).toMatchObject({ profileId });
    } finally {
      removedGate.finish();
      retainedGate.finish();
      f.dispose();
      vi.useRealTimers();
    }
  });

  it.each(["disconnect", "remove-owner", "dispose"] as const)(
    "%s cancels recovery handed back by non-current Profile removal",
    async (terminal) => {
      vi.useFakeTimers();
      const f = await setup();
      const gate = hold();
      try {
        const siblingId = await f.addSiblingProfile("update-route-b");
        vi.mocked(f.adapter.installOrUpdate).mockImplementationOnce(gate.wait);
        const updating = observe(f.management.updateSource({ profileId: siblingId }));
        await gate.entered;
        f.closeHandlers[0]!();
        await f.management.removeProfile(siblingId);
        expect(f.manager.getStateByProfile(profileId).state).toBe("retrying");
        if (terminal === "disconnect") await f.management.disconnectSource(sourceServerId);
        else if (terminal === "remove-owner") await f.management.removeProfile(profileId);
        else f.manager.dispose();
        const terminalState = f.manager.getStateByProfile(profileId);
        gate.finish();
        expect((await updating).error).toBeInstanceOf(Error);
        await vi.advanceTimersByTimeAsync(14_000 + 120_000);
        if (terminal === "remove-owner")
          expect(f.manager.listStates().some((state) => state.profileId === profileId)).toBe(false);
        else expect(f.manager.getStateByProfile(profileId)).toEqual(terminalState);
        expect(f.manager.getOnlineConnection(sourceServerId)).toBeUndefined();
        expect(f.connectServer).toHaveBeenCalledOnce();
      } finally {
        gate.finish();
        f.dispose();
        vi.useRealTimers();
      }
    },
  );

  it.each(["install", "handshake"] as const)(
    "dispose cancels an update waiting for %s",
    async (phase) => {
      const f = await setup();
      const gate = hold();
      if (phase === "install")
        vi.mocked(f.adapter.installOrUpdate).mockImplementationOnce(gate.wait);
      else {
        const original = f.directory.recordHandshake.bind(f.directory);
        vi.spyOn(f.directory, "recordHandshake").mockImplementationOnce(async (...args) => {
          await gate.wait();
          return original(...args);
        });
      }
      try {
        const updating = observe(f.management.updateSource({ profileId }));
        await gate.entered;
        f.manager.dispose();
        const afterDispose = f.manager.getStateByProfile(profileId);
        gate.finish();
        expect((await updating).error).toMatchObject({ code: "remote-connection-canceled" });
        expect(f.manager.getStateByProfile(profileId)).toEqual(afterDispose);
        expect(f.manager.getOnlineConnection(sourceServerId)).toBeUndefined();
      } finally {
        gate.finish();
        f.management.dispose();
      }
    },
  );

  it.each(["success", "failure"] as const)(
    "a canceled update's late %s cannot replace a newer connection or suppress recovery",
    async (outcome) => {
      vi.useFakeTimers();
      const f = await setup();
      const gate = hold();
      vi.mocked(f.adapter.installOrUpdate).mockImplementationOnce(gate.wait);
      try {
        const updating = observe(f.manager.updateServer({ profile: f.profile, target, release }));
        await gate.entered;
        f.manager.disconnect(sourceServerId);
        await f.manager.connect({ profile: f.profile, target });
        const newer = f.manager.getOnlineConnection(sourceServerId);
        f.closeHandlers[1]!();
        expect(f.manager.getStateByProfile(profileId).state).toBe("retrying");
        await vi.advanceTimersByTimeAsync(2000);
        const recovered = f.manager.getOnlineConnection(sourceServerId);
        expect(recovered).toBeDefined();
        expect(recovered).not.toBe(newer);
        if (outcome === "success") gate.finish();
        else gate.fail(new Error("late install failure"));
        expect((await updating).error).toMatchObject({ code: "remote-connection-canceled" });
        expect(f.manager.getOnlineConnection(sourceServerId)).toBe(recovered);
        expect(f.connectServer).toHaveBeenCalledTimes(3);
      } finally {
        gate.finish();
        f.dispose();
        vi.useRealTimers();
      }
    },
  );

  it("preserves disconnect issued by an invalidation observer before starting the new handshake", async () => {
    const f = await setup();
    let terminalState;
    f.manager.onDidInvalidateConnection(() => {
      f.manager.disconnect(sourceServerId);
      terminalState = f.manager.getStateByProfile(profileId);
    });
    try {
      const result = await observe(f.manager.updateServer({ profile: f.profile, target, release }));
      expect(result.error).toMatchObject({ code: "remote-connection-canceled" });
      expect(f.manager.getStateByProfile(profileId)).toEqual(terminalState);
      expect(f.connectServer).toHaveBeenCalledOnce();
    } finally {
      f.dispose();
    }
  });

  it("keeps normal update invalidation and reconnect", async () => {
    const f = await setup();
    const caller = new AbortController();
    const invalidated = vi.fn();
    f.manager.onDidInvalidateConnection(invalidated);
    try {
      await f.manager.updateServer({
        profile: f.profile,
        target,
        release,
        context: { signal: caller.signal },
      });
      const signal = vi.mocked(f.adapter.installOrUpdate).mock.calls[0]![2].signal;
      expect(signal).toBeDefined();
      expect(signal?.aborted).toBe(false);
      expect(invalidated).toHaveBeenCalledOnce();
      expect(f.reconnected).toHaveBeenCalledOnce();
      expect(f.manager.getStateByProfile(profileId).state).toBe("online");
    } finally {
      f.dispose();
    }
  });
});
