import { createSourceServerManagementService } from "../src/host/sourceServerManagementService.js";
import { SourceServerDirectory } from "../src/host/sourceServerDirectory.js";
import { connectSourceServerTarget } from "../src/host/connectSourceServerTarget.js";
import { appSettingsSchema } from "@zcode/shared";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { ConnectionProfile, RemoteTarget, ServerRemoteInfo } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import type { ServerReleaseAsset, SourceServerTransportAdapter } from "@zcode/server/source-server";
import {
  SourceServerConnectionManager,
  SourceServerIdentityChangePendingError,
  SourceServerInstallRequiredError,
  SourceServerUpgradeRequiredError,
} from "../src/host/sourceServerConnectionManager.js";

const profileId = "17ef20b3-622d-4a53-98c1-0cdff29f3e6d";
const sourceServerId = "3cd4f9da-cd79-426c-9d70-75f36e9f6a87";
const profile: ConnectionProfile = {
  profileId,
  transport: "docker",
  target: { kind: "docker", container: "zcode-dev" },
  createdAt: 1,
};
const target: RemoteTarget = { kind: "docker", container: "zcode-dev" };
const sshProfile: ConnectionProfile = {
  ...profile,
  transport: "ssh",
  target: { kind: "ssh", host: "example.test", username: "alice" },
};
const sshTarget: RemoteTarget = sshProfile.target;
function createRelease(
  version: string,
  localArchivePath = "/tmp/zcode-server-linux-x64.tar.gz",
): ServerReleaseAsset {
  return {
    localArchivePath,
    target: "linux-x64",
    version,
    sha256: "a".repeat(64),
    sizeBytes: 1024,
    urls: ["https://cdn.example.test/zcode-server-linux-x64.tar.gz"],
  };
}
const serverInfo: ServerRemoteInfo = {
  serverId: sourceServerId,
  version: "3.8.0",
  protocolVersion: 1,
  authRequired: true,
  workspaces: [],
  compatibility: {
    schemaVersion: 1,
    productVersion: "3.8.0",
    minCompatibleVersion: "3.8.0",
  },
  identity: { osUser: "alice", hostname: "devbox" },
  migration: { failedPathCount: 0 },
  capabilities: { desktopContinuous: true, websocketRpc: true },
};

function createAdapter(
  installed = true,
  kind: "ssh" | "wsl" | "docker" = "docker",
): SourceServerTransportAdapter & { calls: string[] } {
  const calls: string[] = [];
  return {
    kind,
    calls,
    probe: vi.fn(async () => {
      calls.push("probe");
      return {
        platform: "linux",
        arch: "x64",
        installed,
        ...(installed ? { installedVersion: "3.8.0" } : {}),
      };
    }),
    installOrUpdate: vi.fn(async () => {
      calls.push("install");
    }),
    ensureDaemon: vi.fn(async () => {
      calls.push("daemon");
      return { port: 43123, ingressToken: "token" };
    }),
    openChannel: vi.fn(async () => {
      calls.push("channel");
      return new PassThrough();
    }),
    exec: vi.fn(),
    createFileTransfer: vi.fn(() => ({ exec: vi.fn(), upload: vi.fn(async () => {}) })),
  };
}

describe("SourceServerConnectionManager", () => {
  it("does not recreate profile state when membership admission rejects after removal", async () => {
    let rejectAdmission!: (error: Error) => void;
    const admission = new Promise<never>((_resolve, reject) => {
      rejectAdmission = reject;
    });
    const admitConnection = vi.fn(() => admission);
    const manager = new SourceServerConnectionManager({
      directory: { recordHandshake: vi.fn() },
      admitConnection,
      createAdapter: () => createAdapter(),
      compatibilityManifest: serverInfo.compatibility!,
    });
    try {
      const flight = manager.connect({ profile, target });
      const assertion = expect(flight).rejects.toThrow();
      await vi.waitFor(() => expect(admitConnection).toHaveBeenCalledOnce());
      manager.removeProfile(profileId);
      rejectAdmission(new Error("membership no longer exists"));
      await assertion;
      expect(manager.getStateByProfile(profileId).state).toBe("absent");
    } finally {
      manager.dispose();
    }
  });
  it("does not return a reused connection disconnected while membership commit is pending", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const commit = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => pending);
    const dispose = vi.fn();
    const manager = new SourceServerConnectionManager({
      directory: { recordHandshake: vi.fn().mockResolvedValue({ identityChanged: false }) },
      admitConnection: async () => commit,
      createAdapter: () => createAdapter(),
      connectServer: vi.fn(async () => ({ serverInfo, services: {} as IServiceAccessor, dispose })),
      compatibilityManifest: serverInfo.compatibility!,
    });
    try {
      await manager.connect({ profile, target });
      const flight = manager.connect({ profile: { ...profile, sourceServerId }, target });
      const assertion = expect(flight).rejects.toThrow();
      await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(2));
      manager.disconnect(sourceServerId);
      release();
      await assertion;
      expect(manager.getOnlineConnection(sourceServerId)).toBeUndefined();
      expect(manager.getStateByProfile(profileId).state).toBe("offline");
    } finally {
      manager.dispose();
    }
  });
  it("releases the unowned socket when saving the handshake fails", async () => {
    const dispose = vi.fn();
    const manager = new SourceServerConnectionManager({
      directory: { recordHandshake: vi.fn().mockRejectedValue(new Error("directory unavailable")) },
      createAdapter: () => createAdapter(),
      connectServer: vi.fn(async () => ({ serverInfo, services: {} as IServiceAccessor, dispose })),
      compatibilityManifest: serverInfo.compatibility!,
    });
    try {
      await expect(manager.connect({ profile, target })).rejects.toThrow("directory unavailable");
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(manager.getOnlineConnection(sourceServerId)).toBeUndefined();
    } finally {
      manager.dispose();
    }
  });
  it("rejects a socket closed before its handshake is published", async () => {
    const dispose = vi.fn();
    let close!: () => void;
    const manager = new SourceServerConnectionManager({
      directory: {
        recordHandshake: vi.fn(async () => {
          close();
          return { identityChanged: false };
        }),
      },
      createAdapter: () => createAdapter(),
      connectServer: vi.fn(async (options) => {
        close = () => options.onClose?.({ reason: "transport lost" });
        return { serverInfo, services: {} as IServiceAccessor, dispose };
      }),
      compatibilityManifest: serverInfo.compatibility!,
    });
    try {
      await expect(manager.connect({ profile, target })).rejects.toThrow();
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(manager.getOnlineConnection(sourceServerId)).toBeUndefined();
    } finally {
      manager.dispose();
    }
  });
  it("admits membership before transport and commits it before publishing an online connection", async () => {
    const adapter = createAdapter();
    const order: string[] = [];
    const commit = vi.fn(async () => {
      order.push("commit");
      expect(manager.getOnlineConnection(sourceServerId)).toBeUndefined();
    });
    const admitConnection = vi.fn(async () => {
      expect(adapter.calls).toEqual([]);
      order.push("admit");
      return commit;
    });
    const manager = new SourceServerConnectionManager({
      directory: {
        recordHandshake: vi.fn(async () => {
          order.push("handshake");
          return { identityChanged: false };
        }),
      },
      admitConnection,
      createAdapter: () => adapter,
      connectServer: vi.fn(async () => ({
        serverInfo,
        services: {} as IServiceAccessor,
        dispose: vi.fn(),
      })),
      compatibilityManifest: serverInfo.compatibility!,
    });
    await manager.connect({ profile, target });
    expect(admitConnection).toHaveBeenCalledWith({
      profile,
      intent: "add",
      confirmIdentityChange: false,
    });
    expect(commit).toHaveBeenCalledWith(sourceServerId);
    expect(order).toEqual(["admit", "handshake", "commit"]);
    expect(manager.getOnlineConnection(sourceServerId)).toBeDefined();
    manager.dispose();
  });

  it.each(["directory", "membership"] as const)(
    "does not publish or double-dispose a connection closed during %s admission",
    async (phase) => {
      let closeConnection: (() => void) | undefined;
      const dispose = vi.fn();
      const commit = vi.fn(async () => {
        if (phase === "membership") closeConnection?.();
      });
      const manager = new SourceServerConnectionManager({
        directory: {
          recordHandshake: async () => {
            if (phase === "directory") closeConnection?.();
            return { identityChanged: false };
          },
        },
        admitConnection: async () => commit,
        createAdapter: () => createAdapter(),
        connectServer: async (options) => {
          closeConnection = () => options.onClose?.({ code: 1006, reason: "admission close" });
          return { serverInfo, services: {} as IServiceAccessor, dispose };
        },
        compatibilityManifest: serverInfo.compatibility!,
      });
      try {
        await expect(manager.connect({ profile, target })).rejects.toThrow(
          /closed during handshake/,
        );
        expect(dispose).toHaveBeenCalledOnce();
        expect(commit).toHaveBeenCalledTimes(phase === "directory" ? 0 : 1);
        expect(manager.getOnlineConnection(sourceServerId)).toBeUndefined();
      } finally {
        manager.dispose();
      }
    },
  );

  it("disposes a completed handshake when the membership was removed during connection", async () => {
    const dispose = vi.fn();
    const manager = new SourceServerConnectionManager({
      directory: { recordHandshake: vi.fn().mockResolvedValue({ identityChanged: false }) },
      admitConnection: async () => async () => {
        throw new Error("remote-project.host-removed");
      },
      createAdapter: () => createAdapter(),
      connectServer: vi.fn(async () => ({ serverInfo, services: {} as IServiceAccessor, dispose })),
      compatibilityManifest: serverInfo.compatibility!,
    });
    await expect(manager.connect({ profile, target })).rejects.toThrow(
      "remote-project.host-removed",
    );
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(manager.getOnlineConnection(sourceServerId)).toBeUndefined();
    manager.dispose();
  });

  it("does not save a membership during automatic startup reconnect", async () => {
    const adapter = createAdapter();
    const admitConnection = vi.fn(async () => {
      throw new Error("remote-project.host-removed");
    });
    const manager = new SourceServerConnectionManager({
      directory: { recordHandshake: vi.fn() },
      admitConnection,
      createAdapter: () => adapter,
      compatibilityManifest: serverInfo.compatibility!,
    });
    const result = await manager.reconnectOnStartup([{ profile, target }]);
    expect(admitConnection).toHaveBeenCalledWith({
      profile,
      intent: "retain",
      confirmIdentityChange: false,
    });
    expect(result[0]?.status).toBe("failed");
    expect(adapter.calls).toEqual([]);
    manager.dispose();
  });

  it("Manager 在线但窗口没有 wrapper 时，复用真实目标且不覆盖已保存密码", async () => {
    let settings = appSettingsSchema.parse({ sourceServerDirectoryMigrationVersion: 1 });
    const credentials = new Map<string, string>();
    const directory = new SourceServerDirectory({
      settingService: {
        get: async () => settings,
        update: async (patch) => {
          settings = appSettingsSchema.parse({ ...settings, ...patch });
        },
      } as never,
      credentialService: {
        load: async (key) => credentials.get(key) ?? null,
        save: async (key, value) => {
          credentials.set(key, value);
        },
        delete: async (key) => {
          credentials.delete(key);
        },
      },
      createProfileId: () => profileId,
    });
    const adapter = createAdapter(true, "ssh");
    const manager = new SourceServerConnectionManager({
      directory,
      createAdapter: () => adapter,
      compatibilityManifest: serverInfo.compatibility!,
      connectServer: async () => ({ serverInfo, services: {} as IServiceAccessor, dispose() {} }),
    });
    try {
      await connectSourceServerTarget(directory, manager, {
        target: { ...sshTarget, password: "accepted-password" },
      });
      const reused = await connectSourceServerTarget(directory, manager, {
        target: { ...sshTarget, password: "unused-password" },
      });
      expect(await directory.resolveProfileTarget(profileId)).toMatchObject({
        password: "accepted-password",
      });
      expect(reused.connection.reusedConnectionTarget).toEqual(sshTarget);
      expect(adapter.probe).toHaveBeenCalledTimes(1);
    } finally {
      manager.dispose();
    }
  });

  it("真实 SSH 认证后的需升级等待点保留本次凭据，管理服务可以继续更新", async () => {
    let settings = appSettingsSchema.parse({ sourceServerDirectoryMigrationVersion: 1 });
    const credentials = new Map<string, string>();
    const directory = new SourceServerDirectory({
      settingService: {
        get: async () => settings,
        update: async (patch) => {
          settings = appSettingsSchema.parse({ ...settings, ...patch });
        },
      } as never,
      credentialService: {
        load: async (key) => credentials.get(key) ?? null,
        save: async (key, value) => {
          credentials.set(key, value);
        },
        delete: async (key) => {
          credentials.delete(key);
        },
      },
      createProfileId: () => profileId,
    });
    const adapter = createAdapter(true, "ssh");
    const oldServer = {
      ...serverInfo,
      compatibility: {
        ...serverInfo.compatibility!,
        productVersion: "3.7.0",
        minCompatibleVersion: "3.7.0",
      },
    };
    const connectServer = vi
      .fn()
      .mockResolvedValueOnce({ serverInfo: oldServer, services: {}, dispose() {} })
      .mockResolvedValue({ serverInfo, services: {}, dispose() {} });
    const manager = new SourceServerConnectionManager({
      directory,
      createAdapter: () => adapter,
      connectServer,
      compatibilityManifest: serverInfo.compatibility!,
    });
    const management = createSourceServerManagementService({
      directory,
      manager,
      resolveRelease: async () => createRelease("3.8.0"),
    });
    try {
      await expect(
        connectSourceServerTarget(directory, manager, {
          target: { ...sshTarget, password: "authenticated-password" },
        }),
      ).rejects.toBeInstanceOf(SourceServerUpgradeRequiredError);
      await management.updateSource({ profileId, force: false });
      expect(adapter.installOrUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ password: "authenticated-password" }),
        expect.any(Object),
        expect.any(Object),
        { force: false },
      );
      expect(manager.getOnlineConnection(sourceServerId)).toBeDefined();
    } finally {
      management.dispose();
      manager.dispose();
    }
  });

  it("加入后台认证 flight 的不同密码不会因共享升级错误而获准保存", async () => {
    let settings = appSettingsSchema.parse({ sourceServerDirectoryMigrationVersion: 1 });
    const credentials = new Map<string, string>();
    const directory = new SourceServerDirectory({
      settingService: {
        get: async () => settings,
        update: async (patch) => {
          settings = appSettingsSchema.parse({ ...settings, ...patch });
        },
      } as never,
      credentialService: {
        load: async (key) => credentials.get(key) ?? null,
        save: async (key, value) => {
          credentials.set(key, value);
        },
        delete: async (key) => {
          credentials.delete(key);
        },
      },
      createProfileId: () => profileId,
    });
    const saved = await directory.ensureProfile({ ...sshTarget, password: "background-password" });
    const adapter = createAdapter(true, "ssh");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const connectServer = vi.fn(async () => {
      await gate;
      return {
        serverInfo: {
          ...serverInfo,
          compatibility: {
            ...serverInfo.compatibility!,
            productVersion: "3.7.0",
            minCompatibleVersion: "3.7.0",
          },
        },
        services: {} as IServiceAccessor,
        dispose() {},
      };
    });
    const manager = new SourceServerConnectionManager({
      directory,
      createAdapter: () => adapter,
      connectServer,
      compatibilityManifest: serverInfo.compatibility!,
    });
    try {
      const background = manager.connect({
        profile: saved,
        target: { ...sshTarget, password: "background-password" },
      });
      const backgroundFailure = expect(background).rejects.toBeInstanceOf(
        SourceServerUpgradeRequiredError,
      );
      await vi.waitFor(() => expect(connectServer).toHaveBeenCalled());
      const joining = connectSourceServerTarget(directory, manager, {
        target: { ...sshTarget, password: "unverified-join-password" },
      });
      const joiningFailure = expect(joining).rejects.toBeInstanceOf(
        SourceServerUpgradeRequiredError,
      );
      // ensureProfile 排队完成后，join 才能进入正在等待握手的 Manager flight。
      await new Promise((resolve) => setTimeout(resolve, 0));
      release();
      await Promise.all([backgroundFailure, joiningFailure]);
      expect(await directory.resolveProfileTarget(profileId)).toMatchObject({
        password: "background-password",
      });
      expect(adapter.probe).toHaveBeenCalledTimes(1);
    } finally {
      manager.dispose();
    }
  });

  it("同设备最新操作覆盖旧线路迟到日志，其他设备互不影响", async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const adapter = createAdapter();
    vi.mocked(adapter.probe).mockImplementation(async (_target, context) => {
      calls += 1;
      if (calls === 1) {
        await gate;
        context.onLog?.({ phase: "probe", message: "stale first operation" });
      } else context.onLog?.({ phase: "probe", message: `operation ${calls}` });
      throw new Error("probe failed");
    });
    const manager = new SourceServerConnectionManager({
      directory: { recordHandshake: vi.fn() },
      createAdapter: () => adapter,
    });
    const firstProfile = { ...profile, sourceServerId };
    const secondProfile = { ...firstProfile, profileId: "8a116c93-1306-48a8-b8bf-4bdc318b8684" };
    const otherProfile = {
      ...profile,
      profileId: "64fefae8-0a80-4b33-b150-2958c464f26f",
      sourceServerId: "64fefae8-0a80-4b33-b150-2958c464f26f",
    };
    const first = expect(manager.connect({ profile: firstProfile, target })).rejects.toThrow(
      "probe failed",
    );
    await expect(manager.connect({ profile: secondProfile, target })).rejects.toThrow(
      "probe failed",
    );
    const latest = manager.getRecentOperationLogs(secondProfile);
    releaseFirst();
    await first;
    expect(manager.getRecentOperationLogs(firstProfile)).toEqual(latest);
    expect(JSON.stringify(latest)).not.toContain("stale");
    await expect(manager.connect({ profile: otherProfile, target })).rejects.toThrow(
      "probe failed",
    );
    expect(manager.getRecentOperationLogs(firstProfile)).toEqual(latest);
    expect(JSON.stringify(manager.getRecentOperationLogs(otherProfile))).toContain("operation 3");
    manager.dispose();
    expect(manager.getRecentOperationLogs(firstProfile)).toEqual([]);
  });

  it("失败日志按设备保留且有界，新操作替换旧操作，安装确认是 info", async () => {
    const adapter = createAdapter(false);
    const manager = new SourceServerConnectionManager({
      directory: { recordHandshake: vi.fn() },
      createAdapter: () => adapter,
    });
    await expect(manager.connect({ profile, target })).rejects.toThrow(
      SourceServerInstallRequiredError,
    );
    expect(manager.getRecentOperationLogs(profile).at(-1)).toMatchObject({
      level: "info",
      operation: "connect",
    });
    vi.mocked(adapter.probe).mockImplementation(async (_target, context) => {
      for (let i = 0; i < 110; i++)
        context.onLog?.({
          phase: "probe",
          message: `check ${i} /Users/alice/secret token=private`,
        });
      throw Object.assign(new Error(""), { code: "ECONNREFUSED" });
    });
    await expect(manager.connect({ profile, target })).rejects.toMatchObject({
      code: "remote-host-unreachable",
    });
    const logs = manager.getRecentOperationLogs(profile);
    expect(logs).toHaveLength(100);
    expect(logs.at(-1)).toMatchObject({ level: "error" });
    expect(JSON.stringify(logs)).not.toContain("private");
    expect(JSON.stringify(logs)).not.toContain("/Users/");
    expect(manager.getRecentOperationLogs({ ...profile, profileId: "other" })).toEqual([]);
    manager.dispose();
  });
  it("cancels the target transport when a startup reconnect times out", async () => {
    vi.useFakeTimers();
    try {
      const adapter = createAdapter();
      let rejectProbe: ((error: Error) => void) | undefined;
      adapter.probe = vi.fn(
        async () =>
          await new Promise<never>((_resolve, reject) => {
            rejectProbe = reject;
          }),
      );
      const cancel = vi.fn(() => rejectProbe?.(new Error("transport canceled")));
      Object.assign(adapter, { cancel });
      const manager = new SourceServerConnectionManager({
        directory: { recordHandshake: vi.fn().mockResolvedValue({ identityChanged: false }) },
        createAdapter: () => adapter,
        connectServer: vi.fn(),
        compatibilityManifest: serverInfo.compatibility!,
      });

      const resultPromise = manager.reconnectOnStartup([{ profile, target }], { timeoutMs: 100 });
      await vi.advanceTimersByTimeAsync(100);

      await expect(resultPromise).resolves.toEqual([
        {
          profileId,
          status: "failed",
          error: "Source Server startup reconnect timed out after 100ms",
        },
      ]);
      expect(cancel).toHaveBeenCalledWith(target);
      expect(manager.getOnlineConnection(sourceServerId)).toBeUndefined();
      manager.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("protects the first recent Source, then serializes Docker within the global worker budget", async () => {
    const manager = new SourceServerConnectionManager({
      directory: {
        recordHandshake: vi.fn().mockResolvedValue({ identityChanged: false }),
      },
      createAdapter: () => createAdapter(),
      connectServer: vi.fn(),
      compatibilityManifest: serverInfo.compatibility!,
    });
    let active = 0;
    let activeDocker = 0;
    let maxActive = 0;
    let maxActiveDocker = 0;
    let firstCandidateActive = false;
    let overlappedFirstCandidate = false;
    vi.spyOn(manager, "connect").mockImplementation(async (options) => {
      if (options.profile.profileId === profileId) {
        if (active > 0) overlappedFirstCandidate = true;
        firstCandidateActive = true;
      } else if (firstCandidateActive) overlappedFirstCandidate = true;
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (options.target.kind === "docker") {
        activeDocker += 1;
        maxActiveDocker = Math.max(maxActiveDocker, activeDocker);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (options.target.kind === "docker") activeDocker -= 1;
      active -= 1;
      if (options.profile.profileId === profileId) firstCandidateActive = false;
      return {} as never;
    });

    const results = await manager.reconnectOnStartup(
      [
        { profile, target },
        {
          profile: {
            ...profile,
            profileId: "08484abc-244e-43cb-a54e-599941885224",
          },
          target: { kind: "docker", container: "zcode-dev-2" },
        },
        {
          profile: {
            ...profile,
            profileId: "ad187998-9185-42bc-bd9b-5750441a1aec",
          },
          target: { kind: "docker", container: "zcode-dev-3" },
        },
        {
          profile: {
            ...sshProfile,
            profileId: "1be954bc-c9e3-4650-aa36-aa794ef5ad28",
          },
          target: sshTarget,
        },
      ],
      { maxConcurrency: 3, timeoutMs: 1_000 },
    );

    expect(results).toHaveLength(4);
    expect(overlappedFirstCandidate).toBe(false);
    expect(maxActive).toBeLessThanOrEqual(3);
    expect(maxActiveDocker).toBe(1);
    manager.dispose();
  });

  it("terminally disconnects a Source when its current Profile is removed", async () => {
    vi.useFakeTimers();
    try {
      const adapter = createAdapter();
      const dispose = vi.fn();
      const connectServer = vi.fn(async () => ({
        serverInfo,
        services: {} as IServiceAccessor,
        dispose,
      }));
      const manager = new SourceServerConnectionManager({
        directory: {
          recordHandshake: vi.fn().mockResolvedValue({ identityChanged: false }),
        },
        createAdapter: () => adapter,
        connectServer,
        compatibilityManifest: serverInfo.compatibility!,
      });
      const currentProfile = { ...profile, sourceServerId };
      const otherProfile: ConnectionProfile = {
        ...currentProfile,
        profileId: "4f0f4d21-2798-4608-9d44-889f9f3dc777",
      };
      const reconnected = vi.fn();
      const invalidated = vi.fn();
      let onlineDuringInvalidation: boolean | undefined;
      manager.onDidReconnect(reconnected);
      manager.onDidInvalidateConnection((event) => {
        invalidated(event);
        onlineDuringInvalidation = Boolean(manager.getOnlineConnection(sourceServerId));
      });
      await manager.connect({ profile: currentProfile, target });
      await manager.connect({ profile: otherProfile, target });

      manager.removeProfile(profileId);

      expect(dispose).toHaveBeenCalledOnce();
      expect(manager.getOnlineConnection(sourceServerId)).toBeUndefined();
      expect(manager.getStateByProfile(profileId)).toMatchObject({
        state: "absent",
      });
      expect(manager.getStateByProfile(otherProfile.profileId)).toMatchObject({
        state: "offline",
        sourceServerId,
      });
      expect(invalidated).toHaveBeenCalledOnce();
      expect(invalidated).toHaveBeenCalledWith({
        sourceServerId,
        reason: "profile-removed",
        recoverable: false,
      });
      expect(onlineDuringInvalidation).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000 + 4_000 + 8_000 + 2 * 60_000);
      expect(connectServer).toHaveBeenCalledOnce();
      expect(reconnected).not.toHaveBeenCalled();
      manager.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the current Source online when a non-current Profile is removed", async () => {
    const adapter = createAdapter();
    const dispose = vi.fn();
    const manager = new SourceServerConnectionManager({
      directory: {
        recordHandshake: vi.fn().mockResolvedValue({ identityChanged: false }),
      },
      createAdapter: () => adapter,
      connectServer: vi.fn(async () => ({
        serverInfo,
        services: {} as IServiceAccessor,
        dispose,
      })),
      compatibilityManifest: serverInfo.compatibility!,
    });
    const currentProfile = { ...profile, sourceServerId };
    const otherProfile: ConnectionProfile = {
      ...currentProfile,
      profileId: "4f0f4d21-2798-4608-9d44-889f9f3dc777",
    };
    const invalidated = vi.fn();
    manager.onDidInvalidateConnection(invalidated);
    await manager.connect({ profile: currentProfile, target });
    await manager.connect({ profile: otherProfile, target });

    manager.removeProfile(otherProfile.profileId);

    expect(manager.getOnlineConnection(sourceServerId)).toMatchObject({
      sourceServerId,
      profileId,
    });
    expect(manager.getStateByProfile(profileId)).toMatchObject({
      state: "online",
      sourceServerId,
    });
    expect(manager.getStateByProfile(otherProfile.profileId)).toMatchObject({
      state: "absent",
    });
    expect(dispose).not.toHaveBeenCalled();
    expect(invalidated).not.toHaveBeenCalled();
    manager.dispose();
  });

  it("stops retrying when the current recovery Profile is removed", async () => {
    vi.useFakeTimers();
    try {
      const adapter = createAdapter();
      const closeHandlers: Array<(event: { code: number; reason: string }) => void> = [];
      const connectServer = vi.fn(
        async (options: { onClose?: (event: { code: number; reason: string }) => void }) => {
          closeHandlers.push(options.onClose ?? (() => undefined));
          return {
            serverInfo,
            services: {} as IServiceAccessor,
            dispose: vi.fn(),
          };
        },
      );
      const manager = new SourceServerConnectionManager({
        directory: {
          recordHandshake: vi.fn().mockResolvedValue({ identityChanged: false }),
        },
        createAdapter: () => adapter,
        connectServer,
        compatibilityManifest: serverInfo.compatibility!,
      });
      const currentProfile = { ...profile, sourceServerId };
      const otherProfile: ConnectionProfile = {
        ...currentProfile,
        profileId: "4f0f4d21-2798-4608-9d44-889f9f3dc777",
      };
      await manager.connect({ profile: currentProfile, target });
      await manager.connect({ profile: otherProfile, target });
      closeHandlers[0]?.({ code: 1006, reason: "network lost" });

      manager.removeProfile(profileId);

      expect(manager.getStateByProfile(profileId)).toMatchObject({
        state: "absent",
      });
      expect(manager.getStateByProfile(otherProfile.profileId)).toMatchObject({
        state: "offline",
        sourceServerId,
      });
      await vi.advanceTimersByTimeAsync(2_000 + 4_000 + 8_000 + 2 * 60_000);
      expect(connectServer).toHaveBeenCalledOnce();
      expect(manager.getOnlineConnection(sourceServerId)).toBeUndefined();
      manager.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels an unidentified Profile connect flight when the Profile is removed", async () => {
    const adapter = createAdapter();
    let finishProbe!: () => void;
    adapter.probe = vi.fn(
      async () =>
        await new Promise<{
          platform: "linux";
          arch: "x64";
          installed: true;
          installedVersion: string;
        }>((resolve) => {
          finishProbe = () =>
            resolve({
              platform: "linux",
              arch: "x64",
              installed: true,
              installedVersion: "3.8.0",
            });
        }),
    );
    const manager = new SourceServerConnectionManager({
      directory: {
        recordHandshake: vi.fn().mockResolvedValue({ identityChanged: false }),
      },
      createAdapter: () => adapter,
      connectServer: vi.fn(async () => ({
        serverInfo,
        services: {} as IServiceAccessor,
        dispose: vi.fn(),
      })),
      compatibilityManifest: serverInfo.compatibility!,
    });
    const connecting = manager.connect({ profile, target });
    await vi.waitFor(() => expect(adapter.probe).toHaveBeenCalledOnce());

    manager.removeProfile(profileId);
    finishProbe();

    await expect(connecting).rejects.toThrow("Connection Profile removed");
    expect(manager.getStateByProfile(profileId)).toMatchObject({
      state: "absent",
    });
    expect(manager.getOnlineConnection(sourceServerId)).toBeUndefined();
    manager.dispose();
  });

  it("terminally invalidates an identified Source when its connecting Profile is removed", async () => {
    const adapter = createAdapter();
    let finishProbe!: () => void;
    adapter.probe = vi.fn(
      async () =>
        await new Promise<{
          platform: "linux";
          arch: "x64";
          installed: true;
          installedVersion: string;
        }>((resolve) => {
          finishProbe = () =>
            resolve({
              platform: "linux",
              arch: "x64",
              installed: true,
              installedVersion: "3.8.0",
            });
        }),
    );
    const manager = new SourceServerConnectionManager({
      directory: {
        recordHandshake: vi.fn().mockResolvedValue({ identityChanged: false }),
      },
      createAdapter: () => adapter,
      connectServer: vi.fn(async () => ({
        serverInfo,
        services: {} as IServiceAccessor,
        dispose: vi.fn(),
      })),
      compatibilityManifest: serverInfo.compatibility!,
    });
    const invalidated = vi.fn();
    manager.onDidInvalidateConnection(invalidated);
    const connecting = manager.connect({
      profile: { ...profile, sourceServerId },
      target,
    });
    await vi.waitFor(() => expect(adapter.probe).toHaveBeenCalledOnce());

    manager.removeProfile(profileId);
    finishProbe();

    await expect(connecting).rejects.toThrow("Connection Profile removed");
    expect(invalidated).toHaveBeenCalledWith({
      sourceServerId,
      reason: "profile-removed",
      recoverable: false,
    });
    expect(manager.getStateByProfile(profileId)).toMatchObject({
      state: "absent",
    });
    expect(manager.getOnlineConnection(sourceServerId)).toBeUndefined();
    manager.dispose();
  });
  it("bootstraps one Source connection, records stable identity and disconnects attachment only", async () => {
    const adapter = createAdapter();
    const recordHandshake = vi.fn().mockResolvedValue({ identityChanged: false });
    const dispose = vi.fn();
    const recordLastOnline = vi.fn(async () => undefined);
    let now = 1000;
    const connectServer = vi.fn(async (options: { createConnection: () => Promise<unknown> }) => {
      await options.createConnection();
      return { serverInfo, services: {} as IServiceAccessor, dispose };
    });
    const manager = new SourceServerConnectionManager({
      directory: { recordHandshake, recordLastOnline },
      now: () => now,
      createAdapter: () => adapter,
      connectServer,
      compatibilityManifest: serverInfo.compatibility!,
    });

    const connection = await manager.connect({ profile, target });

    expect(connection.sourceServerId).toBe(sourceServerId);
    expect(adapter.calls).toEqual(["probe", "daemon", "channel"]);
    expect(recordHandshake).toHaveBeenCalledWith(profileId, {
      sourceServerId,
      osUser: "alice",
      hostname: "devbox",
      version: "3.8.0",
      connectedAt: expect.any(Number),
      workspaces: [],
    });
    expect(manager.getStateByProfile(profileId)).toMatchObject({ state: "online", sourceServerId });

    now = 9000;
    manager.disconnect(sourceServerId);
    expect(recordLastOnline).toHaveBeenCalledWith(sourceServerId, 9000);
    now = 12000;
    manager.disconnect(sourceServerId);
    expect(recordLastOnline).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(manager.getStateByProfile(profileId)).toMatchObject({
      state: "offline",
      sourceServerId,
    });
  });

  it("publishes a Host-authoritative non-blocking update snapshot", async () => {
    const adapter = createAdapter();
    const manager = new SourceServerConnectionManager({
      directory: { recordHandshake: vi.fn().mockResolvedValue({ identityChanged: false }) },
      createAdapter: () => adapter,
      connectServer: vi.fn(async () => ({
        serverInfo,
        services: {} as IServiceAccessor,
        dispose: vi.fn(),
      })),
      compatibilityManifest: {
        schemaVersion: 1,
        productVersion: "3.9.0",
        minCompatibleVersion: "3.8.0",
      },
    });

    await manager.connect({ profile, target });

    expect(manager.getStateByProfile(profileId)).toMatchObject({
      state: "online",
      sourceServerId,
      updateAvailability: "available",
      currentVersion: "3.8.0",
      availableVersion: "3.9.0",
      minimumVersion: "3.8.0",
      upgradeTarget: "server",
    });
  });

  it("hands a same-version development SHA mismatch to the shared needs-upgrade update contract", async () => {
    // R3A-B-06：开发态只负责“按 archive SHA 判定需要更新”；更新本身必须与生产态一样
    // 走 needs-upgrade → updateServer，连接流程内不得直接执行 installOrUpdate。
    const adapter = createAdapter(true, "ssh");
    vi.mocked(adapter.probe).mockResolvedValue({
      platform: "linux",
      arch: "x64",
      installed: true,
      installedVersion: "3.8.0",
      installedArchiveSha256: "b".repeat(64),
    });
    const release = createRelease("3.8.0");
    const manager = new SourceServerConnectionManager({
      directory: { recordHandshake: vi.fn().mockResolvedValue({ identityChanged: false }) },
      createAdapter: () => adapter,
      connectServer: vi.fn(),
      compatibilityManifest: serverInfo.compatibility!,
      sourceServerArtifactPolicy: "development-content-addressed",
      resolveRelease: vi.fn(async () => release),
    });

    await expect(
      manager.connect({ profile: sshProfile, target: sshTarget }),
    ).rejects.toBeInstanceOf(SourceServerUpgradeRequiredError);
    expect(adapter.probe).toHaveBeenCalledOnce();
    expect(adapter.installOrUpdate).not.toHaveBeenCalled();
    expect(adapter.ensureDaemon).not.toHaveBeenCalled();
    expect(manager.getStateByProfile(profileId)).toMatchObject({
      state: "needs-upgrade",
      updateAvailability: "required",
      currentVersion: "3.8.0",
      availableVersion: "3.8.0",
      minimumVersion: "3.8.0",
      upgradeTarget: "server",
      errorCode: "source-server-upgrade-required",
      retryable: false,
    });
  });

  it("reuses a same-version SSH release when the development archive SHA already matches", async () => {
    const adapter = createAdapter(true, "ssh");
    vi.mocked(adapter.probe).mockResolvedValue({
      platform: "linux",
      arch: "x64",
      installed: true,
      installedVersion: "3.8.0",
      installedArchiveSha256: "a".repeat(64),
    });
    const manager = new SourceServerConnectionManager({
      directory: { recordHandshake: vi.fn().mockResolvedValue({ identityChanged: false }) },
      createAdapter: () => adapter,
      connectServer: vi.fn(async () => ({
        serverInfo,
        services: {} as IServiceAccessor,
        dispose: vi.fn(),
      })),
      compatibilityManifest: serverInfo.compatibility!,
      sourceServerArtifactPolicy: "development-content-addressed",
      resolveRelease: vi.fn(async () => createRelease("3.8.0")),
    });

    await manager.connect({ profile: sshProfile, target: sshTarget });

    expect(adapter.installOrUpdate).not.toHaveBeenCalled();
    expect(adapter.ensureDaemon).toHaveBeenCalledOnce();
  });

  it("does not compare or refresh a same-version SSH archive in production policy", async () => {
    const adapter = createAdapter(true, "ssh");
    vi.mocked(adapter.probe).mockResolvedValue({
      platform: "linux",
      arch: "x64",
      installed: true,
      installedVersion: "3.8.0",
      installedArchiveSha256: "b".repeat(64),
    });
    const resolveRelease = vi.fn(async () => createRelease("3.8.0"));
    const manager = new SourceServerConnectionManager({
      directory: { recordHandshake: vi.fn().mockResolvedValue({ identityChanged: false }) },
      createAdapter: () => adapter,
      connectServer: vi.fn(async () => ({
        serverInfo,
        services: {} as IServiceAccessor,
        dispose: vi.fn(),
      })),
      compatibilityManifest: serverInfo.compatibility!,
      sourceServerArtifactPolicy: "release-versioned",
      resolveRelease,
    });

    await manager.connect({ profile: sshProfile, target: sshTarget });

    expect(resolveRelease).not.toHaveBeenCalled();
    expect(adapter.installOrUpdate).not.toHaveBeenCalled();
  });

  it("applies a development refresh through updateServer with the shared running-task guard and force", async () => {
    // 与生产态相同的更新逻辑：force:false 先受 guard 拒绝并保留更新入口，用户确认后 force:true 应用，
    // 随后 connect 重新按 SHA 判定已一致，直接进入 daemon/握手。
    const adapter = createAdapter(true, "ssh");
    let installedArchiveSha256 = "b".repeat(64);
    vi.mocked(adapter.probe).mockImplementation(async () => {
      adapter.calls.push("probe");
      return {
        platform: "linux",
        arch: "x64",
        installed: true,
        installedVersion: "3.8.0",
        installedArchiveSha256,
      };
    });
    const guard = Object.assign(new Error("Running tasks require --force for update"), {
      code: "source-server-update-running-tasks" as const,
      retryable: false,
    });
    vi.mocked(adapter.installOrUpdate).mockImplementation(
      async (_target, _release, _context, options) => {
        adapter.calls.push(`install:${options?.force ? "force" : "guarded"}`);
        if (!options?.force) throw guard;
        installedArchiveSha256 = "a".repeat(64);
      },
    );
    const runningTasks = [
      { sessionId: "running-task", workspacePath: "/repo", workspaceIdentity: "source-a:/repo" },
    ];
    vi.mocked(adapter.exec).mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify(runningTasks),
      stderr: "",
    });
    const release = createRelease("3.8.0");
    const manager = new SourceServerConnectionManager({
      directory: { recordHandshake: vi.fn().mockResolvedValue({ identityChanged: false }) },
      createAdapter: () => adapter,
      connectServer: vi.fn(async () => ({
        serverInfo,
        services: {} as IServiceAccessor,
        dispose: vi.fn(),
      })),
      compatibilityManifest: serverInfo.compatibility!,
      sourceServerArtifactPolicy: "development-content-addressed",
      resolveRelease: vi.fn(async () => release),
    });

    await expect(
      manager.connect({ profile: sshProfile, target: sshTarget }),
    ).rejects.toBeInstanceOf(SourceServerUpgradeRequiredError);
    await expect(
      manager.updateServer({
        profile: sshProfile,
        target: sshTarget as Exclude<RemoteTarget, { kind: "server" }>,
        force: false,
      }),
    ).rejects.toBe(guard);
    expect(manager.getStateByProfile(profileId)).toMatchObject({
      updateAvailability: "required",
      upgradeTarget: "server",
      errorCode: "source-server-update-running-tasks",
      retryable: false,
      runningTasks,
    });

    await expect(
      manager.updateServer({
        profile: sshProfile,
        target: sshTarget as Exclude<RemoteTarget, { kind: "server" }>,
        force: true,
      }),
    ).resolves.toMatchObject({ sourceServerId });
    expect(adapter.installOrUpdate).toHaveBeenLastCalledWith(
      sshTarget,
      release,
      expect.objectContaining({ onLog: expect.any(Function) }),
      { force: true },
    );
    expect(adapter.calls).toEqual([
      "probe",
      "probe",
      "install:guarded",
      "probe",
      "install:force",
      "probe",
      "daemon",
    ]);
    expect(manager.getStateByProfile(profileId)).toMatchObject({ state: "online", sourceServerId });
  });

  it("publishes real installation preview without installing before confirmation", async () => {
    const adapter = createAdapter(false);
    vi.mocked(adapter.probe).mockResolvedValue({
      platform: "linux",
      arch: "x64",
      installed: false,
      installPath: "/srv/custom-home/.zcode/server",
    });
    const resolveRelease = vi.fn(async () => createRelease("3.8.0"));
    const manager = new SourceServerConnectionManager({
      directory: { recordHandshake: vi.fn() },
      createAdapter: () => adapter,
      resolveRelease,
    });
    await expect(manager.connect({ profile, target })).rejects.toBeInstanceOf(
      SourceServerInstallRequiredError,
    );
    expect(manager.getStateByProfile(profileId)).toMatchObject({
      state: "needs-install",
      installPreview: {
        version: "3.8.0",
        installPath: "/srv/custom-home/.zcode/server",
        sizeBytes: 1024,
      },
    });
    expect(resolveRelease).toHaveBeenCalledWith(expect.any(Object), target, { metadataOnly: true });
    expect(adapter.installOrUpdate).not.toHaveBeenCalled();
  });

  it("安装预览获取失败仍等待用户确认，不能把可选元数据失败当成建连失败", async () => {
    const adapter = createAdapter(false);
    const resolveRelease = vi.fn(async () => {
      throw new Error("CDN descriptor unavailable");
    });
    const manager = new SourceServerConnectionManager({
      directory: { recordHandshake: vi.fn() },
      createAdapter: () => adapter,
      resolveRelease,
    });
    try {
      await expect(manager.connect({ profile, target })).rejects.toBeInstanceOf(
        SourceServerInstallRequiredError,
      );
      expect(manager.getStateByProfile(profileId)).toMatchObject({ state: "needs-install" });
      expect(resolveRelease).toHaveBeenCalledWith(expect.any(Object), target, {
        metadataOnly: true,
      });
      expect(adapter.installOrUpdate).not.toHaveBeenCalled();
      await expect(manager.connect({ profile, target, allowInstall: true })).rejects.toThrow(
        "CDN descriptor unavailable",
      );
      expect(manager.getStateByProfile(profileId)).toMatchObject({ state: "failed" });
    } finally {
      manager.dispose();
    }
  });

  it("requires an explicit release after probe reports a missing installation", async () => {
    const adapter = createAdapter(false);
    const manager = new SourceServerConnectionManager({
      directory: { recordHandshake: vi.fn() },
      createAdapter: () => adapter,
      connectServer: vi.fn(),
      compatibilityManifest: serverInfo.compatibility!,
    });

    await expect(manager.connect({ profile, target })).rejects.toBeInstanceOf(
      SourceServerInstallRequiredError,
    );
    expect(adapter.calls).toEqual(["probe"]);
    expect(manager.getStateByProfile(profileId)).toMatchObject({ state: "needs-install" });

    const release = createRelease("3.8.0", "/tmp/server.tar.gz");
    await expect(manager.connect({ profile, target, release })).rejects.not.toBeInstanceOf(
      SourceServerInstallRequiredError,
    );
    expect(adapter.calls).toContain("install");
  });

  it("marks only a successfully probed missing bound installation as uninstalled", async () => {
    const adapter = createAdapter(false);
    const markSourceUninstalled = vi.fn(async () => undefined);
    const manager = new SourceServerConnectionManager({
      directory: { recordHandshake: vi.fn(), markSourceUninstalled },
      createAdapter: () => adapter,
      connectServer: vi.fn(),
      compatibilityManifest: serverInfo.compatibility!,
    });

    await expect(
      manager.connect({ profile: { ...profile, sourceServerId }, target }),
    ).rejects.toBeInstanceOf(SourceServerInstallRequiredError);
    expect(markSourceUninstalled).toHaveBeenCalledWith(profileId);
  });

  it("keeps a changed reinstall identity provisional until explicit confirmation", async () => {
    const adapter = createAdapter();
    const oldSourceServerId = "64fefae8-0a80-4b33-b150-2958c464f26f";
    const replacementProfileId = "8a116c93-1306-48a8-b8bf-4bdc318b8684";
    const boundProfile: ConnectionProfile = {
      ...profile,
      sourceServerId: oldSourceServerId,
    };
    const replacementProfile: ConnectionProfile = {
      ...profile,
      profileId: replacementProfileId,
      sourceServerId,
    };
    const recordHandshake = vi
      .fn()
      .mockResolvedValueOnce({ identityChanged: true })
      .mockResolvedValueOnce({ identityChanged: true, effectiveProfile: replacementProfile });
    const disposers: Array<ReturnType<typeof vi.fn>> = [];
    const manager = new SourceServerConnectionManager({
      directory: { recordHandshake },
      createAdapter: () => adapter,
      connectServer: vi.fn(async () => {
        const dispose = vi.fn();
        disposers.push(dispose);
        return { serverInfo, services: {} as IServiceAccessor, dispose };
      }),
      compatibilityManifest: serverInfo.compatibility!,
    });

    await expect(manager.connect({ profile: boundProfile, target })).rejects.toBeInstanceOf(
      SourceServerIdentityChangePendingError,
    );
    expect(disposers[0]).toHaveBeenCalledOnce();
    expect(manager.getStateByProfile(profileId)).toMatchObject({
      state: "identity-change-pending",
      sourceServerId: oldSourceServerId,
      pendingSourceServerId: sourceServerId,
    });

    const oldLogs = manager.getRecentOperationLogs(boundProfile);
    await expect(
      manager.connect({ profile: boundProfile, target, confirmIdentityChange: true }),
    ).resolves.toMatchObject({ profileId: replacementProfileId, sourceServerId });
    expect(manager.getStateByProfile(replacementProfileId)).toMatchObject({
      state: "online",
      sourceServerId,
    });
    expect(manager.getRecentOperationLogs(boundProfile)).toEqual(oldLogs);
    expect(manager.getRecentOperationLogs(replacementProfile).at(-1)).toMatchObject({
      profileId: replacementProfileId,
      phase: "ready",
    });
    expect(manager.getRecentOperationLogs(boundProfile)).not.toEqual(
      manager.getRecentOperationLogs(replacementProfile),
    );
  });

  it("classifies an installed pre-R3 Server before invoking the ingress-token daemon contract", async () => {
    const adapter = createAdapter();
    adapter.probe = vi.fn(async () => {
      adapter.calls.push("probe");
      return {
        platform: "linux",
        arch: "x64",
        installed: true,
        installedVersion: "3.7.0",
      };
    });
    const manager = new SourceServerConnectionManager({
      directory: { recordHandshake: vi.fn() },
      createAdapter: () => adapter,
      connectServer: vi.fn(),
      compatibilityManifest: serverInfo.compatibility!,
    });

    await expect(manager.connect({ profile, target })).rejects.toMatchObject({
      name: SourceServerUpgradeRequiredError.name,
      profileId,
      upgradeTarget: "server",
      currentVersion: "3.7.0",
      minimumVersion: "3.8.0",
    });
    expect(adapter.calls).toEqual(["probe"]);
    expect(manager.getStateByProfile(profileId)).toMatchObject({
      state: "needs-upgrade",
      updateAvailability: "required",
      currentVersion: "3.7.0",
      availableVersion: "3.8.0",
      minimumVersion: "3.8.0",
      upgradeTarget: "server",
      errorCode: "source-server-upgrade-required",
      retryable: false,
    });
  });

  it("updates a pre-R3 Profile from the release archive before sourceServerId exists", async () => {
    const adapter = createAdapter();
    let probeCount = 0;
    adapter.probe = vi.fn(async () => ({
      platform: "linux",
      arch: "x64",
      installed: true,
      installedVersion: ++probeCount === 1 ? "3.7.0" : "3.8.0",
    }));
    const release = createRelease("3.8.0");
    const manager = new SourceServerConnectionManager({
      directory: { recordHandshake: vi.fn().mockResolvedValue({ identityChanged: false }) },
      createAdapter: () => adapter,
      connectServer: vi.fn(async () => ({
        serverInfo,
        services: {} as IServiceAccessor,
        dispose: vi.fn(),
      })),
      compatibilityManifest: serverInfo.compatibility!,
    });

    await expect(
      manager.updateServer({
        profile,
        target: target as Exclude<RemoteTarget, { kind: "server" }>,
        resolveRelease: vi.fn(async () => release),
      }),
    ).resolves.toMatchObject({ sourceServerId });

    expect(adapter.installOrUpdate).toHaveBeenCalledWith(
      target,
      release,
      expect.objectContaining({ onLog: expect.any(Function) }),
      { force: false },
    );
    expect(adapter.exec).not.toHaveBeenCalled();
  });

  it("updates an identified Source through the same Desktop archive path with force", async () => {
    const adapter = createAdapter();
    const release = createRelease("3.9.0");
    const identifiedProfile = { ...profile, sourceServerId };
    const manager = new SourceServerConnectionManager({
      directory: { recordHandshake: vi.fn().mockResolvedValue({ identityChanged: false }) },
      createAdapter: () => adapter,
      connectServer: vi.fn(async () => ({
        serverInfo,
        services: {} as IServiceAccessor,
        dispose: vi.fn(),
      })),
      compatibilityManifest: serverInfo.compatibility!,
    });

    await expect(
      manager.updateServer({
        profile: identifiedProfile,
        target: target as Exclude<RemoteTarget, { kind: "server" }>,
        force: true,
        resolveRelease: vi.fn(async () => release),
      }),
    ).resolves.toMatchObject({ sourceServerId });

    expect(adapter.installOrUpdate).toHaveBeenCalledWith(
      target,
      release,
      expect.objectContaining({ onLog: expect.any(Function) }),
      { force: true },
    );
    expect(adapter.exec).not.toHaveBeenCalled();
  });

  it("publishes a typed running-task guard for explicit force confirmation", async () => {
    const adapter = createAdapter();
    const guard = Object.assign(new Error("Running tasks require --force for update"), {
      code: "source-server-update-running-tasks" as const,
      retryable: false,
    });
    vi.mocked(adapter.installOrUpdate).mockRejectedValueOnce(guard);
    const release = createRelease("3.9.0");
    const manager = new SourceServerConnectionManager({
      directory: { recordHandshake: vi.fn().mockResolvedValue({ identityChanged: false }) },
      createAdapter: () => adapter,
      connectServer: vi.fn(async () => ({
        serverInfo,
        services: {} as IServiceAccessor,
        dispose: vi.fn(),
      })),
      compatibilityManifest: serverInfo.compatibility!,
    });
    const identifiedProfile = { ...profile, sourceServerId };
    const originalConnection = await manager.connect({
      profile: identifiedProfile,
      target,
    });
    const invalidated = vi.fn();
    const reconnected = vi.fn();
    manager.onDidInvalidateConnection(invalidated);
    manager.onDidReconnect(reconnected);

    await expect(
      manager.updateServer({
        profile: identifiedProfile,
        target: target as Exclude<RemoteTarget, { kind: "server" }>,
        release,
      }),
    ).rejects.toBe(guard);
    expect(manager.getStateByProfile(profileId)).toMatchObject({
      state: "online",
      sourceServerId,
      updateAvailability: "none",
      currentVersion: "3.8.0",
      availableVersion: "3.8.0",
      minimumVersion: "3.8.0",
      errorCode: "source-server-update-running-tasks",
      retryable: false,
    });
    expect(manager.getOnlineConnection(sourceServerId)).toBe(originalConnection);
    expect(invalidated).not.toHaveBeenCalled();
    expect(reconnected).not.toHaveBeenCalled();
  });

  it("keeps the Source online through guard then force-updates and re-handshakes", async () => {
    const adapter = createAdapter();
    const guard = Object.assign(new Error("Running tasks require --force for update"), {
      code: "source-server-update-running-tasks" as const,
      retryable: false,
    });
    vi.mocked(adapter.installOrUpdate)
      .mockRejectedValueOnce(guard)
      .mockResolvedValueOnce(undefined);
    const recordHandshake = vi.fn().mockResolvedValue({ identityChanged: false });
    const disposers: Array<ReturnType<typeof vi.fn>> = [];
    const connectServer = vi.fn(async () => {
      const dispose = vi.fn();
      disposers.push(dispose);
      return { serverInfo, services: {} as IServiceAccessor, dispose };
    });
    const manager = new SourceServerConnectionManager({
      directory: { recordHandshake },
      createAdapter: () => adapter,
      connectServer,
      compatibilityManifest: serverInfo.compatibility!,
    });
    const identifiedProfile = { ...profile, sourceServerId };
    const release = createRelease("3.9.0");
    await manager.connect({ profile: identifiedProfile, target });

    await expect(
      manager.updateServer({ profile: identifiedProfile, target, release }),
    ).rejects.toBe(guard);
    expect(manager.getStateByProfile(profileId)).toMatchObject({
      state: "online",
      errorCode: "source-server-update-running-tasks",
    });

    await expect(
      manager.updateServer({ profile: identifiedProfile, target, release, force: true }),
    ).resolves.toMatchObject({ sourceServerId });
    expect(adapter.installOrUpdate).toHaveBeenLastCalledWith(
      target,
      release,
      expect.objectContaining({ onLog: expect.any(Function) }),
      { force: true },
    );
    expect(disposers[0]).toHaveBeenCalledOnce();
    expect(connectServer).toHaveBeenCalledTimes(2);
    expect(recordHandshake).toHaveBeenCalledTimes(2);
    expect(manager.getStateByProfile(profileId)).toMatchObject({ state: "online", sourceServerId });
  });

  it("invalidates an identified Source before publishing its updated connection", async () => {
    const adapter = createAdapter();
    const firstServices = {} as IServiceAccessor;
    const updatedServices = {} as IServiceAccessor;
    const lifecycle: string[] = [];
    const firstDispose = vi.fn(() => lifecycle.push("disposed:previous"));
    const updatedDispose = vi.fn();
    const connectServer = vi
      .fn()
      .mockResolvedValueOnce({
        serverInfo,
        services: firstServices,
        dispose: firstDispose,
      })
      .mockResolvedValueOnce({
        serverInfo,
        services: updatedServices,
        dispose: updatedDispose,
      });
    const manager = new SourceServerConnectionManager({
      directory: {
        recordHandshake: vi.fn().mockResolvedValue({ identityChanged: false }),
      },
      createAdapter: () => adapter,
      connectServer,
      compatibilityManifest: serverInfo.compatibility!,
    });
    const identifiedProfile = { ...profile, sourceServerId };
    manager.onDidInvalidateConnection(({ sourceServerId: invalidatedId }) => {
      lifecycle.push(`invalidated:${invalidatedId}`);
    });
    manager.onDidReconnect((connection) => {
      expect(connection.services).toBe(updatedServices);
      lifecycle.push(`reconnected:${connection.sourceServerId}`);
    });
    await manager.connect({ profile: identifiedProfile, target });

    const updated = await manager.updateServer({
      profile: identifiedProfile,
      target,
      release: createRelease("3.9.0"),
    });

    expect(lifecycle).toEqual([
      `invalidated:${sourceServerId}`,
      "disposed:previous",
      `reconnected:${sourceServerId}`,
    ]);
    expect(updated.services).toBe(updatedServices);
    expect(firstDispose).toHaveBeenCalledOnce();
    expect(updatedDispose).not.toHaveBeenCalled();
    manager.dispose();
  });

  it("does not restore online when transport closes during a failed update", async () => {
    const adapter = createAdapter();
    const closeHandlers: Array<(event: { code: number; reason: string }) => void> = [];
    let rejectInstall!: (error: Error) => void;
    adapter.installOrUpdate = vi.fn(
      async () =>
        await new Promise<void>((_resolve, reject) => {
          rejectInstall = reject;
        }),
    );
    const manager = new SourceServerConnectionManager({
      directory: { recordHandshake: vi.fn().mockResolvedValue({ identityChanged: false }) },
      createAdapter: () => adapter,
      connectServer: vi.fn(
        async (options: { onClose?: (event: { code: number; reason: string }) => void }) => {
          closeHandlers.push(options.onClose ?? (() => undefined));
          return { serverInfo, services: {} as IServiceAccessor, dispose: vi.fn() };
        },
      ),
      compatibilityManifest: serverInfo.compatibility!,
    });
    const identifiedProfile = { ...profile, sourceServerId };
    await manager.connect({ profile: identifiedProfile, target });
    const invalidated = vi.fn();
    manager.onDidInvalidateConnection(invalidated);
    const updating = manager.updateServer({
      profile: identifiedProfile,
      target,
      release: createRelease("3.9.0", "/tmp/server.tar.gz"),
    });
    await vi.waitFor(() => expect(adapter.installOrUpdate).toHaveBeenCalledOnce());
    closeHandlers[0]?.({ code: 1006, reason: "closed" });
    expect(invalidated).toHaveBeenCalledOnce();
    expect(invalidated).toHaveBeenCalledWith({
      sourceServerId,
      reason: "update",
    });
    rejectInstall(new Error("update failed"));
    await expect(updating).rejects.toThrow("update failed");
    expect(manager.getOnlineConnection(sourceServerId)).toBeUndefined();
    expect(manager.getStateByProfile(profileId)).toMatchObject({ state: "retrying" });
    manager.dispose();
  });

  it("does not schedule recovery when a disconnected update fails with retryable false", async () => {
    vi.useFakeTimers();
    try {
      const adapter = createAdapter();
      const closeHandlers: Array<(event: { code: number; reason: string }) => void> = [];
      let rejectInstall!: (error: Error) => void;
      adapter.installOrUpdate = vi.fn(
        async () =>
          await new Promise<void>((_resolve, reject) => {
            rejectInstall = reject;
          }),
      );
      const connectServer = vi.fn(
        async (options: { onClose?: (event: { code: number; reason: string }) => void }) => {
          closeHandlers.push(options.onClose ?? (() => undefined));
          return { serverInfo, services: {} as IServiceAccessor, dispose: vi.fn() };
        },
      );
      const manager = new SourceServerConnectionManager({
        directory: {
          recordHandshake: vi.fn().mockResolvedValue({ identityChanged: false }),
        },
        createAdapter: () => adapter,
        connectServer,
        compatibilityManifest: serverInfo.compatibility!,
      });
      const identifiedProfile = { ...profile, sourceServerId };
      await manager.connect({ profile: identifiedProfile, target });
      const updating = manager.updateServer({
        profile: identifiedProfile,
        target,
        release: createRelease("3.9.0", "/tmp/server.tar.gz"),
      });
      await vi.waitFor(() => expect(adapter.installOrUpdate).toHaveBeenCalledOnce());
      closeHandlers[0]?.({ code: 1006, reason: "closed" });
      rejectInstall(
        Object.assign(new Error("update requires user action"), {
          code: "source-server-update-running-tasks" as const,
          retryable: false,
        }),
      );

      await expect(updating).rejects.toThrow("update requires user action");
      expect(manager.getStateByProfile(profileId)).toMatchObject({
        state: "failed",
        errorCode: "source-server-update-running-tasks",
        retryable: false,
      });
      await vi.advanceTimersByTimeAsync(2_000 + 4_000 + 8_000 + 2 * 60_000);
      expect(connectServer).toHaveBeenCalledOnce();
      manager.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes one invalidation and re-handshakes when daemon handoff closes the transport", async () => {
    const adapter = createAdapter();
    const closeHandlers: Array<(event: { code: number; reason: string }) => void> = [];
    let finishInstall!: () => void;
    adapter.installOrUpdate = vi.fn(
      async () =>
        await new Promise<void>((resolve) => {
          finishInstall = resolve;
        }),
    );
    const connectServer = vi.fn(
      async (options: { onClose?: (event: { code: number; reason: string }) => void }) => {
        closeHandlers.push(options.onClose ?? (() => undefined));
        return { serverInfo, services: {} as IServiceAccessor, dispose: vi.fn() };
      },
    );
    const manager = new SourceServerConnectionManager({
      directory: { recordHandshake: vi.fn().mockResolvedValue({ identityChanged: false }) },
      createAdapter: () => adapter,
      connectServer,
      compatibilityManifest: serverInfo.compatibility!,
    });
    const identifiedProfile = { ...profile, sourceServerId };
    await manager.connect({ profile: identifiedProfile, target });
    const invalidated = vi.fn();
    const reconnected = vi.fn();
    manager.onDidInvalidateConnection(invalidated);
    manager.onDidReconnect(reconnected);

    const updating = manager.updateServer({
      profile: identifiedProfile,
      target,
      release: createRelease("3.9.0", "/tmp/server.tar.gz"),
    });
    await vi.waitFor(() => expect(adapter.installOrUpdate).toHaveBeenCalledOnce());
    closeHandlers[0]?.({ code: 1006, reason: "daemon handoff" });
    finishInstall();

    await expect(updating).resolves.toMatchObject({ sourceServerId });
    expect(invalidated).toHaveBeenCalledOnce();
    expect(reconnected).toHaveBeenCalledOnce();
    expect(connectServer).toHaveBeenCalledTimes(2);
    expect(manager.getStateByProfile(profileId)).toMatchObject({
      state: "online",
      sourceServerId,
    });
    manager.dispose();
  });

  it("retries an online disconnect at 2/4/8 seconds and restores the same Source", async () => {
    vi.useFakeTimers();
    try {
      const adapter = createAdapter();
      const closeHandlers: Array<(event: { code: number; reason: string }) => void> = [];
      const connectionDisposers: Array<ReturnType<typeof vi.fn>> = [];
      let connectionAttempt = 0;
      const connectServer = vi.fn(
        async (options: {
          createConnection: () => Promise<unknown>;
          onClose?: (event: { code: number; reason: string }) => void;
        }) => {
          connectionAttempt += 1;
          closeHandlers.push(options.onClose ?? (() => undefined));
          if (connectionAttempt === 2 || connectionAttempt === 3) {
            throw new Error(`retry-${connectionAttempt}-failed`);
          }
          await options.createConnection();
          const dispose = vi.fn();
          connectionDisposers.push(dispose);
          return {
            serverInfo,
            services: {} as IServiceAccessor,
            dispose,
          };
        },
      );
      const logWarn = vi.fn();
      const manager = new SourceServerConnectionManager({
        directory: { recordHandshake: vi.fn().mockResolvedValue({ identityChanged: false }) },
        createAdapter: () => adapter,
        connectServer,
        logWarn,
        compatibilityManifest: serverInfo.compatibility!,
      });
      const reconnected = vi.fn();
      const reconnectSubscription = manager.onDidReconnect(reconnected);
      await manager.connect({ profile, target });

      closeHandlers[0]?.({ code: 1006, reason: "network lost" });
      expect(connectionDisposers[0]).toHaveBeenCalledOnce();
      expect(manager.getStateByProfile(profileId)).toMatchObject({
        state: "retrying",
        recoveryAttempt: 1,
        recoveryLimit: 3,
        currentVersion: "3.8.0",
        availableVersion: "3.8.0",
      });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(connectServer).toHaveBeenCalledTimes(2);
      expect(manager.getStateByProfile(profileId)).toMatchObject({
        state: "retrying",
        recoveryAttempt: 2,
        recoveryLimit: 3,
      });
      await vi.advanceTimersByTimeAsync(4_000);
      expect(connectServer).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(8_000);
      expect(connectServer).toHaveBeenCalledTimes(4);
      expect(manager.getStateByProfile(profileId)).toMatchObject({
        state: "online",
        sourceServerId,
      });
      expect(reconnected).toHaveBeenCalledOnce();
      expect(reconnected).toHaveBeenCalledWith(
        expect.objectContaining({ sourceServerId, profileId }),
      );
      reconnectSubscription.dispose();
      manager.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops automatic recovery when reconnect requires installation confirmation", async () => {
    vi.useFakeTimers();
    try {
      const adapter = createAdapter();
      let probeCount = 0;
      adapter.probe = vi.fn(async () => {
        probeCount += 1;
        return {
          platform: "linux",
          arch: "x64",
          installed: probeCount === 1,
          ...(probeCount === 1 ? { installedVersion: "3.8.0" } : {}),
        };
      });
      const closeHandlers: Array<(event: { code: number; reason: string }) => void> = [];
      const manager = new SourceServerConnectionManager({
        directory: {
          recordHandshake: vi.fn().mockResolvedValue({ identityChanged: false }),
        },
        createAdapter: () => adapter,
        connectServer: vi.fn(
          async (options: { onClose?: (event: { code: number; reason: string }) => void }) => {
            closeHandlers.push(options.onClose ?? (() => undefined));
            return { serverInfo, services: {} as IServiceAccessor, dispose: vi.fn() };
          },
        ),
        compatibilityManifest: serverInfo.compatibility!,
      });
      await manager.connect({ profile, target });

      closeHandlers[0]?.({ code: 1006, reason: "network lost" });
      await vi.advanceTimersByTimeAsync(2_000);

      expect(manager.getStateByProfile(profileId)).toMatchObject({
        state: "needs-install",
        errorCode: "source-server-install-required",
        retryable: false,
      });
      await vi.advanceTimersByTimeAsync(4_000 + 8_000 + 2 * 60_000);
      expect(adapter.probe).toHaveBeenCalledTimes(2);
      await expect(
        manager.connect({
          profile,
          target,
          release: createRelease("3.8.0", "/tmp/server.tar.gz"),
        }),
      ).resolves.toMatchObject({ sourceServerId });
      expect(manager.getStateByProfile(profileId)).toMatchObject({
        state: "online",
        sourceServerId,
      });
      manager.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the existing upgrade-required terminal behavior during automatic recovery", async () => {
    vi.useFakeTimers();
    try {
      const adapter = createAdapter();
      let probeCount = 0;
      adapter.probe = vi.fn(async () => ({
        platform: "linux",
        arch: "x64",
        installed: true,
        installedVersion: ++probeCount === 1 ? "3.8.0" : "3.7.0",
      }));
      const closeHandlers: Array<(event: { code: number; reason: string }) => void> = [];
      const manager = new SourceServerConnectionManager({
        directory: {
          recordHandshake: vi.fn().mockResolvedValue({ identityChanged: false }),
        },
        createAdapter: () => adapter,
        connectServer: vi.fn(
          async (options: { onClose?: (event: { code: number; reason: string }) => void }) => {
            closeHandlers.push(options.onClose ?? (() => undefined));
            return { serverInfo, services: {} as IServiceAccessor, dispose: vi.fn() };
          },
        ),
        compatibilityManifest: serverInfo.compatibility!,
      });
      await manager.connect({ profile, target });

      closeHandlers[0]?.({ code: 1006, reason: "network lost" });
      await vi.advanceTimersByTimeAsync(2_000);

      expect(manager.getStateByProfile(profileId)).toMatchObject({
        state: "needs-upgrade",
        errorCode: "source-server-upgrade-required",
        retryable: false,
      });
      await vi.advanceTimersByTimeAsync(4_000 + 8_000 + 2 * 60_000);
      expect(adapter.probe).toHaveBeenCalledTimes(2);
      manager.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops automatic recovery when reconnect requires identity confirmation", async () => {
    vi.useFakeTimers();
    try {
      const adapter = createAdapter();
      const oldSourceServerId = "64fefae8-0a80-4b33-b150-2958c464f26f";
      const boundProfile: ConnectionProfile = {
        ...profile,
        sourceServerId: oldSourceServerId,
      };
      const siblingProfile: ConnectionProfile = {
        ...boundProfile,
        profileId: "3d317149-48a0-4f50-81bd-021273d0aa48",
      };
      let handshakeCount = 0;
      let connectionCount = 0;
      const closeHandlers: Array<(event: { code: number; reason: string }) => void> = [];
      const manager = new SourceServerConnectionManager({
        directory: {
          recordHandshake: vi.fn(async () => ({
            identityChanged: ++handshakeCount > 1,
          })),
        },
        createAdapter: () => adapter,
        connectServer: vi.fn(
          async (options: { onClose?: (event: { code: number; reason: string }) => void }) => {
            closeHandlers.push(options.onClose ?? (() => undefined));
            connectionCount += 1;
            return {
              serverInfo:
                connectionCount === 1 ? { ...serverInfo, serverId: oldSourceServerId } : serverInfo,
              services: {} as IServiceAccessor,
              dispose: vi.fn(),
            };
          },
        ),
        compatibilityManifest: serverInfo.compatibility!,
      });
      await manager.connect({ profile: boundProfile, target });
      await manager.connect({ profile: siblingProfile, target });

      closeHandlers[0]?.({ code: 1006, reason: "network lost" });
      await vi.advanceTimersByTimeAsync(2_000);

      expect(manager.getStateByProfile(profileId)).toMatchObject({
        state: "identity-change-pending",
        sourceServerId: oldSourceServerId,
        pendingSourceServerId: sourceServerId,
        errorCode: "source-server-identity-change-pending",
        retryable: false,
      });
      expect(manager.getStateByProfile(siblingProfile.profileId)).toMatchObject({
        state: "offline",
        sourceServerId: oldSourceServerId,
        errorCode: "source-server-identity-change-pending",
        retryable: false,
      });
      await vi.advanceTimersByTimeAsync(4_000 + 8_000 + 2 * 60_000);
      expect(adapter.probe).toHaveBeenCalledTimes(2);
      manager.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops automatic recovery when reconnect returns retryable false", async () => {
    vi.useFakeTimers();
    try {
      const adapter = createAdapter();
      let probeCount = 0;
      const terminalError = Object.assign(new Error("user action required"), {
        code: "source-server-update-running-tasks" as const,
        retryable: false,
      });
      adapter.probe = vi.fn(async () => {
        probeCount += 1;
        if (probeCount > 1) throw terminalError;
        return {
          platform: "linux",
          arch: "x64",
          installed: true,
          installedVersion: "3.8.0",
        };
      });
      const closeHandlers: Array<(event: { code: number; reason: string }) => void> = [];
      const manager = new SourceServerConnectionManager({
        directory: {
          recordHandshake: vi.fn().mockResolvedValue({ identityChanged: false }),
        },
        createAdapter: () => adapter,
        connectServer: vi.fn(
          async (options: { onClose?: (event: { code: number; reason: string }) => void }) => {
            closeHandlers.push(options.onClose ?? (() => undefined));
            return { serverInfo, services: {} as IServiceAccessor, dispose: vi.fn() };
          },
        ),
        compatibilityManifest: serverInfo.compatibility!,
      });
      await manager.connect({ profile, target });

      closeHandlers[0]?.({ code: 1006, reason: "network lost" });
      await vi.advanceTimersByTimeAsync(2_000);

      expect(manager.getStateByProfile(profileId)).toMatchObject({
        state: "failed",
        error: "user action required",
        errorCode: "source-server-update-running-tasks",
        retryable: false,
      });
      await vi.advanceTimersByTimeAsync(4_000 + 8_000 + 2 * 60_000);
      expect(adapter.probe).toHaveBeenCalledTimes(2);
      manager.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops offline probes when a probe returns retryable false", async () => {
    vi.useFakeTimers();
    try {
      const adapter = createAdapter();
      let probeCount = 0;
      adapter.probe = vi.fn(async () => {
        probeCount += 1;
        if (probeCount >= 2 && probeCount <= 4) {
          throw new Error(`transient-${probeCount}`);
        }
        if (probeCount > 4) {
          throw Object.assign(new Error("credentials require user action"), {
            code: "source-server-update-running-tasks" as const,
            retryable: false,
          });
        }
        return {
          platform: "linux",
          arch: "x64",
          installed: true,
          installedVersion: "3.8.0",
        };
      });
      const closeHandlers: Array<(event: { code: number; reason: string }) => void> = [];
      const manager = new SourceServerConnectionManager({
        directory: {
          recordHandshake: vi.fn().mockResolvedValue({ identityChanged: false }),
        },
        createAdapter: () => adapter,
        connectServer: vi.fn(
          async (options: { onClose?: (event: { code: number; reason: string }) => void }) => {
            closeHandlers.push(options.onClose ?? (() => undefined));
            return { serverInfo, services: {} as IServiceAccessor, dispose: vi.fn() };
          },
        ),
        compatibilityManifest: serverInfo.compatibility!,
      });
      await manager.connect({ profile, target });

      closeHandlers[0]?.({ code: 1006, reason: "network lost" });
      await vi.advanceTimersByTimeAsync(2_000 + 4_000 + 8_000);
      expect(manager.getStateByProfile(profileId)).toMatchObject({
        state: "offline",
        recoveryBudgetExhausted: true,
      });

      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(manager.getStateByProfile(profileId)).toMatchObject({
        state: "failed",
        error: "credentials require user action",
        retryable: false,
      });
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(adapter.probe).toHaveBeenCalledTimes(5);
      manager.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("terminalizes every Profile on a retrying Source when explicitly disconnected", async () => {
    vi.useFakeTimers();
    try {
      const adapter = createAdapter();
      const closeHandlers: Array<(event: { code: number; reason: string }) => void> = [];
      const connectServer = vi.fn(
        async (options: { onClose?: (event: { code: number; reason: string }) => void }) => {
          closeHandlers.push(options.onClose ?? (() => undefined));
          return { serverInfo, services: {} as IServiceAccessor, dispose: vi.fn() };
        },
      );
      const manager = new SourceServerConnectionManager({
        directory: {
          recordHandshake: vi.fn().mockResolvedValue({ identityChanged: false }),
        },
        createAdapter: () => adapter,
        connectServer,
        compatibilityManifest: serverInfo.compatibility!,
      });
      const reconnected = vi.fn();
      manager.onDidReconnect(reconnected);
      await manager.connect({ profile, target });
      const secondProfile: ConnectionProfile = {
        ...profile,
        profileId: "3d317149-48a0-4f50-81bd-021273d0aa48",
        sourceServerId,
      };
      await manager.connect({ profile: secondProfile, target });

      closeHandlers[0]?.({ code: 1006, reason: "network lost" });
      expect(manager.getStateByProfile(profileId)).toMatchObject({
        state: "retrying",
        recoveryAttempt: 1,
      });
      expect(manager.getStateByProfile(secondProfile.profileId)).toMatchObject({
        state: "retrying",
        recoveryAttempt: 1,
      });

      manager.disconnect(sourceServerId);

      const terminalState = manager.getStateByProfile(profileId);
      expect(terminalState).toMatchObject({ state: "offline", sourceServerId });
      expect(terminalState).not.toHaveProperty("recoveryAttempt");
      expect(manager.getStateByProfile(secondProfile.profileId)).toMatchObject({
        state: "offline",
        sourceServerId,
      });
      await vi.advanceTimersByTimeAsync(2_000 + 4_000 + 8_000 + 2 * 60_000);
      expect(connectServer).toHaveBeenCalledOnce();
      expect(reconnected).not.toHaveBeenCalled();
      expect(manager.getOnlineConnection(sourceServerId)).toBeUndefined();
      manager.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a late recovery success after explicit disconnect", async () => {
    vi.useFakeTimers();
    try {
      const adapter = createAdapter();
      const closeHandlers: Array<(event: { code: number; reason: string }) => void> = [];
      const recoveryDispose = vi.fn();
      let resolveRecovery: (() => void) | undefined;
      let connectionAttempt = 0;
      const connectServer = vi.fn(
        async (options: { onClose?: (event: { code: number; reason: string }) => void }) => {
          connectionAttempt += 1;
          closeHandlers.push(options.onClose ?? (() => undefined));
          if (connectionAttempt === 1) {
            return { serverInfo, services: {} as IServiceAccessor, dispose: vi.fn() };
          }
          return await new Promise<{
            serverInfo: ServerRemoteInfo;
            services: IServiceAccessor;
            dispose: () => void;
          }>((resolve) => {
            resolveRecovery = () =>
              resolve({
                serverInfo,
                services: {} as IServiceAccessor,
                dispose: recoveryDispose,
              });
          });
        },
      );
      const manager = new SourceServerConnectionManager({
        directory: {
          recordHandshake: vi.fn().mockResolvedValue({ identityChanged: false }),
        },
        createAdapter: () => adapter,
        connectServer,
        compatibilityManifest: serverInfo.compatibility!,
      });
      const reconnected = vi.fn();
      const publishedStates: string[] = [];
      manager.onDidReconnect(reconnected);
      manager.onDidChangeState((state) => publishedStates.push(state.state));
      await manager.connect({ profile, target });

      closeHandlers[0]?.({ code: 1006, reason: "network lost" });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(manager.getStateByProfile(profileId)).toMatchObject({
        state: "bootstrapping",
      });

      const publishedStateCountBeforeDisconnect = publishedStates.length;
      manager.disconnect(sourceServerId);
      resolveRecovery?.();
      await vi.advanceTimersByTimeAsync(0);

      expect(manager.getStateByProfile(profileId)).toMatchObject({
        state: "offline",
        sourceServerId,
      });
      expect(manager.getOnlineConnection(sourceServerId)).toBeUndefined();
      expect(reconnected).not.toHaveBeenCalled();
      expect(recoveryDispose).toHaveBeenCalledOnce();
      expect(publishedStates.slice(publishedStateCountBeforeDisconnect)).toEqual(["offline"]);
      manager.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the replacement owner online when the old connection closes again", async () => {
    vi.useFakeTimers();
    let manager: SourceServerConnectionManager | undefined;
    try {
      const closes: Array<(event: { code: number; reason: string }) => void> = [];
      const firstDispose = vi.fn();
      const replacementDispose = vi.fn();
      const connectServer = vi.fn(
        async (options: { onClose?: (event: { code: number; reason: string }) => void }) => {
          closes.push(options.onClose!);
          return {
            serverInfo,
            services: {} as IServiceAccessor,
            dispose: closes.length === 1 ? firstDispose : replacementDispose,
          };
        },
      );
      manager = new SourceServerConnectionManager({
        directory: { recordHandshake: vi.fn().mockResolvedValue({ identityChanged: false }) },
        createAdapter: () => createAdapter(),
        connectServer,
        compatibilityManifest: serverInfo.compatibility!,
      });
      await manager.connect({ profile, target });
      closes[0]!({ code: 1006, reason: "old transport lost" });
      await vi.advanceTimersByTimeAsync(2_000);
      const replacement = manager.getOnlineConnection(sourceServerId);
      expect(replacement).toBeDefined();
      expect(manager.getStateByProfile(profileId).state).toBe("online");

      // 模拟已经摘除的 I/O listener 迟到回调，必须命中生产 owner 校验。
      closes[0]!({ code: 1006, reason: "late old close" });
      await vi.advanceTimersByTimeAsync(14_000);
      expect(manager.getOnlineConnection(sourceServerId)).toBe(replacement);
      expect(manager.getStateByProfile(profileId).state).toBe("online");
      expect(connectServer).toHaveBeenCalledTimes(2);
      expect(firstDispose).toHaveBeenCalledOnce();
      expect(replacementDispose).not.toHaveBeenCalled();
    } finally {
      manager?.dispose();
      vi.useRealTimers();
    }
  });

  it("disposes a late recovery result without replacing a newer manual connection", async () => {
    vi.useFakeTimers();
    let manager: SourceServerConnectionManager | undefined;
    try {
      const closes: Array<(event: { code: number; reason: string }) => void> = [];
      const staleDispose = vi.fn();
      const replacementDispose = vi.fn();
      let finishOldRecovery: (() => void) | undefined;
      const connectServer = vi.fn(
        async (options: { onClose?: (event: { code: number; reason: string }) => void }) => {
          closes.push(options.onClose!);
          if (closes.length === 2) {
            return await new Promise<{
              serverInfo: ServerRemoteInfo;
              services: IServiceAccessor;
              dispose: () => void;
            }>((resolve) => {
              finishOldRecovery = () =>
                resolve({ serverInfo, services: {} as IServiceAccessor, dispose: staleDispose });
            });
          }
          return {
            serverInfo,
            services: {} as IServiceAccessor,
            dispose: closes.length === 1 ? vi.fn() : replacementDispose,
          };
        },
      );
      manager = new SourceServerConnectionManager({
        directory: { recordHandshake: vi.fn().mockResolvedValue({ identityChanged: false }) },
        createAdapter: () => createAdapter(),
        connectServer,
        compatibilityManifest: serverInfo.compatibility!,
      });
      await manager.connect({ profile, target });
      closes[0]!({ code: 1006, reason: "old transport lost" });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(finishOldRecovery).toBeDefined();
      manager.disconnect(sourceServerId);
      const replacementPromise = manager.connect({
        profile: { ...profile, sourceServerId },
        target,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(connectServer).toHaveBeenCalledTimes(3);
      const replacement = await replacementPromise;

      finishOldRecovery!();
      await vi.advanceTimersByTimeAsync(0);
      closes[1]!({ code: 1006, reason: "late stale recovery close" });
      await vi.advanceTimersByTimeAsync(14_000);
      expect(manager.getOnlineConnection(sourceServerId)).toBe(replacement);
      expect(manager.getStateByProfile(profileId).state).toBe("online");
      expect(staleDispose).toHaveBeenCalledOnce();
      expect(replacementDispose).not.toHaveBeenCalled();
      expect(connectServer).toHaveBeenCalledTimes(3);
    } finally {
      manager?.dispose();
      vi.useRealTimers();
    }
  });

  it("keeps every profile on the Source in the same retry attempt and publishes budget exhaustion", async () => {
    vi.useFakeTimers();
    try {
      const adapter = createAdapter();
      const closeHandlers: Array<(event: { code: number; reason: string }) => void> = [];
      let connectionAttempt = 0;
      const connectServer = vi.fn(
        async (options: {
          createConnection: () => Promise<unknown>;
          onClose?: (event: { code: number; reason: string }) => void;
        }) => {
          connectionAttempt += 1;
          closeHandlers.push(options.onClose ?? (() => undefined));
          if (connectionAttempt >= 3) throw new Error("network still unavailable");
          await options.createConnection();
          return { serverInfo, services: {} as IServiceAccessor, dispose: vi.fn() };
        },
      );
      const logWarn = vi.fn();
      const manager = new SourceServerConnectionManager({
        directory: { recordHandshake: vi.fn().mockResolvedValue({ identityChanged: false }) },
        createAdapter: () => adapter,
        connectServer,
        logWarn,
        compatibilityManifest: serverInfo.compatibility!,
      });
      const secondProfile: ConnectionProfile = {
        ...profile,
        profileId: "3d317149-48a0-4f50-81bd-021273d0aa48",
        target: { kind: "docker", container: "zcode-dev-alias" },
      };
      await manager.connect({ profile, target });
      await manager.connect({ profile: secondProfile, target: secondProfile.target });

      closeHandlers[0]?.({ code: 1006, reason: "network lost" });
      expect(manager.getStateByProfile(secondProfile.profileId)).toMatchObject({
        state: "retrying",
        recoveryAttempt: 1,
        recoveryLimit: 3,
      });

      await vi.advanceTimersByTimeAsync(2_000 + 4_000 + 8_000);
      expect(manager.getStateByProfile(profileId)).toMatchObject({
        state: "offline",
        recoveryAttempt: 3,
        recoveryLimit: 3,
        recoveryBudgetExhausted: true,
        errorCode: "remote-recovery-budget-exhausted",
        retryable: true,
        currentVersion: "3.8.0",
        availableVersion: "3.8.0",
      });
      expect(manager.getStateByProfile(secondProfile.profileId)).toMatchObject({
        state: "offline",
        recoveryAttempt: 3,
        recoveryLimit: 3,
        recoveryBudgetExhausted: true,
      });
      expect(logWarn).toHaveBeenCalledWith(
        expect.stringContaining("recovery budget exhausted"),
        expect.any(Error),
      );
      manager.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases a rejected handshake once without closing the next published connection", async () => {
    const adapter = createAdapter();
    const closeHandlers: Array<(event: { code: number; reason: string }) => void> = [];
    const disposers: Array<ReturnType<typeof vi.fn>> = [];
    const connectServer = vi.fn(
      async (options: { onClose?: (event: { code: number; reason: string }) => void }) => {
        const onClose = options.onClose ?? (() => undefined);
        closeHandlers.push(onClose);
        const dispose = vi.fn(() => onClose({ code: 1000, reason: "disposed" }));
        disposers.push(dispose);
        return { serverInfo, services: {} as IServiceAccessor, dispose };
      },
    );
    const recordHandshake = vi
      .fn()
      .mockRejectedValueOnce(new Error("ENOSPC: handshake write failed"))
      .mockResolvedValue({ identityChanged: false });
    const manager = new SourceServerConnectionManager({
      directory: { recordHandshake },
      createAdapter: () => adapter,
      connectServer,
      compatibilityManifest: serverInfo.compatibility!,
    });
    try {
      await expect(manager.connect({ profile, target })).rejects.toThrow("ENOSPC");
      expect(disposers[0]).toHaveBeenCalledOnce();
      expect(manager.getOnlineConnection(sourceServerId)).toBeUndefined();
      expect(manager.getStateByProfile(profileId)).toMatchObject({ state: "failed" });

      const connected = await manager.connect({ profile, target });
      closeHandlers[0]?.({ code: 1006, reason: "old connection closed late" });
      expect(manager.getOnlineConnection(sourceServerId)?.services).toBe(connected.services);
      expect(manager.getStateByProfile(profileId)).toMatchObject({ state: "online" });
      expect(disposers[0]).toHaveBeenCalledOnce();
      expect(disposers[1]).not.toHaveBeenCalled();
    } finally {
      manager.dispose();
    }
    expect(disposers[0]).toHaveBeenCalledOnce();
    expect(disposers[1]).toHaveBeenCalledOnce();
  });

  it("releases an unpublished connection once when its compatibility version is invalid", async () => {
    const adapter = createAdapter();
    const dispose = vi.fn();
    const recordHandshake = vi.fn().mockResolvedValue({ identityChanged: false });
    const manager = new SourceServerConnectionManager({
      directory: { recordHandshake },
      createAdapter: () => adapter,
      connectServer: async () => ({
        serverInfo: {
          ...serverInfo,
          compatibility: { ...serverInfo.compatibility!, productVersion: "dev-build" },
        },
        services: {} as IServiceAccessor,
        dispose,
      }),
      compatibilityManifest: serverInfo.compatibility!,
    });
    try {
      await expect(manager.connect({ profile, target })).rejects.toThrow(
        "Invalid compatibility version: dev-build",
      );
      expect(dispose).toHaveBeenCalledOnce();
      expect(recordHandshake).not.toHaveBeenCalled();
      expect(manager.getOnlineConnection(sourceServerId)).toBeUndefined();
    } finally {
      manager.dispose();
    }
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("releases each rejected handshake during recovery retries and offline probes", async () => {
    vi.useFakeTimers();
    const adapter = createAdapter();
    const disposers: Array<ReturnType<typeof vi.fn>> = [];
    const closeHandlers: Array<(event: { code: number; reason: string }) => void> = [];
    const connectServer = vi.fn(
      async (options: { onClose?: (event: { code: number; reason: string }) => void }) => {
        const onClose = options.onClose ?? (() => undefined);
        closeHandlers.push(onClose);
        const dispose = vi.fn(() => onClose({ code: 1000, reason: "disposed" }));
        disposers.push(dispose);
        return { serverInfo, services: {} as IServiceAccessor, dispose };
      },
    );
    const recordHandshake = vi
      .fn()
      .mockResolvedValueOnce({ identityChanged: false })
      .mockRejectedValue(new Error("ENOSPC: handshake write failed"));
    const manager = new SourceServerConnectionManager({
      directory: { recordHandshake },
      createAdapter: () => adapter,
      connectServer,
      compatibilityManifest: serverInfo.compatibility!,
    });
    try {
      await manager.connect({ profile, target });
      closeHandlers[0]?.({ code: 1006, reason: "network lost" });
      for (const [index, delay] of [2_000, 4_000, 8_000, 2 * 60_000].entries()) {
        await vi.advanceTimersByTimeAsync(delay);
        expect(connectServer).toHaveBeenCalledTimes(index + 2);
        for (const dispose of disposers) expect(dispose).toHaveBeenCalledOnce();
        expect(manager.getOnlineConnection(sourceServerId)).toBeUndefined();
      }
      expect(manager.getStateByProfile(profileId)).toMatchObject({ state: "offline" });
    } finally {
      manager.dispose();
      vi.useRealTimers();
    }
    for (const dispose of disposers) expect(dispose).toHaveBeenCalledOnce();
  });

  it("treats a transport close during recordHandshake as a retryable connect failure", async () => {
    vi.useFakeTimers();
    try {
      const adapter = createAdapter();
      const closeHandlers: Array<(event: { code: number; reason: string }) => void> = [];
      const dispose = vi.fn();
      const connectServer = vi.fn(
        async (options: { onClose?: (event: { code: number; reason: string }) => void }) => {
          closeHandlers.push(options.onClose ?? (() => undefined));
          return { serverInfo, services: {} as IServiceAccessor, dispose };
        },
      );
      let finishHandshake!: () => void;
      const recordHandshake = vi.fn(async () => {
        await new Promise<void>((resolve) => {
          finishHandshake = resolve;
        });
        return { identityChanged: false };
      });
      const manager = new SourceServerConnectionManager({
        directory: { recordHandshake },
        createAdapter: () => adapter,
        connectServer,
        compatibilityManifest: serverInfo.compatibility!,
      });

      const connecting = manager.connect({ profile, target });
      await vi.waitFor(() => expect(recordHandshake).toHaveBeenCalledOnce());
      // 握手落盘期间物理连接关闭：不能发布为 online，必须按连接失败收口
      closeHandlers[0]?.({ code: 1006, reason: "network lost during handshake" });
      finishHandshake();

      await expect(connecting).rejects.toThrow("closed during handshake");
      expect(dispose).toHaveBeenCalledOnce();
      expect(manager.getOnlineConnection(sourceServerId)).toBeUndefined();
      expect(manager.getStateByProfile(profileId)).toMatchObject({
        state: "failed",
        retryable: true,
      });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(connectServer).toHaveBeenCalledOnce();
      manager.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a sibling Profile handshake close and joins the online owner", async () => {
    const adapter = createAdapter();
    const closeHandlers: Array<(event: { code: number; reason: string }) => void> = [];
    const disposers: Array<ReturnType<typeof vi.fn>> = [];
    const connectServer = vi.fn(
      async (options: { onClose?: (event: { code: number; reason: string }) => void }) => {
        closeHandlers.push(options.onClose ?? (() => undefined));
        const dispose = vi.fn();
        disposers.push(dispose);
        return { serverInfo, services: {} as IServiceAccessor, dispose };
      },
    );
    let handshakeCount = 0;
    let finishSiblingHandshake: (() => void) | undefined;
    const recordHandshake = vi.fn(async () => {
      handshakeCount += 1;
      if (handshakeCount === 2) {
        await new Promise<void>((resolve) => {
          finishSiblingHandshake = resolve;
        });
      }
      return { identityChanged: false };
    });
    const manager = new SourceServerConnectionManager({
      directory: { recordHandshake },
      createAdapter: () => adapter,
      connectServer,
      compatibilityManifest: serverInfo.compatibility!,
    });
    const owner = await manager.connect({ profile: { ...profile, sourceServerId }, target });
    const siblingProfile: ConnectionProfile = {
      ...profile,
      profileId: "3d317149-48a0-4f50-81bd-021273d0aa48",
      target: { kind: "docker", container: "zcode-dev-alias" },
    };

    const joining = manager.connect({ profile: siblingProfile, target: siblingProfile.target });
    await vi.waitFor(() => expect(recordHandshake).toHaveBeenCalledTimes(2));
    // sibling 的物理连接在握手期间关闭：不得拆掉同一 Source 上健康的 owner 连接
    closeHandlers[1]?.({ code: 1006, reason: "sibling closed during handshake" });
    expect(manager.getStateByProfile(profileId)).toMatchObject({ state: "online", sourceServerId });
    expect(disposers[0]).not.toHaveBeenCalled();
    finishSiblingHandshake?.();

    const joined = await joining;
    expect(joined.services).toBe(owner.services);
    expect(disposers[1]).toHaveBeenCalledOnce();
    expect(manager.getOnlineConnection(sourceServerId)?.services).toBe(owner.services);
    expect(manager.getStateByProfile(profileId)).toMatchObject({ state: "online", sourceServerId });
    expect(manager.getStateByProfile(siblingProfile.profileId)).toMatchObject({
      state: "online",
      sourceServerId,
    });
    manager.dispose();
  });

  it("continues the recovery ladder when a retry attempt closes during handshake", async () => {
    vi.useFakeTimers();
    try {
      const adapter = createAdapter();
      const closeHandlers: Array<(event: { code: number; reason: string }) => void> = [];
      let attempt = 0;
      const connectServer = vi.fn(
        async (options: { onClose?: (event: { code: number; reason: string }) => void }) => {
          attempt += 1;
          closeHandlers.push(options.onClose ?? (() => undefined));
          return { serverInfo, services: {} as IServiceAccessor, dispose: vi.fn() };
        },
      );
      const recordHandshake = vi.fn(async () => {
        if (attempt === 2) {
          // 第二次连接（首次重试）在握手期间被关闭
          closeHandlers[1]?.({ code: 1006, reason: "closed during retry handshake" });
          await Promise.resolve();
        }
        return { identityChanged: false };
      });
      const manager = new SourceServerConnectionManager({
        directory: { recordHandshake },
        createAdapter: () => adapter,
        connectServer,
        compatibilityManifest: serverInfo.compatibility!,
      });
      const reconnected = vi.fn();
      manager.onDidReconnect(reconnected);
      await manager.connect({ profile, target });

      closeHandlers[0]?.({ code: 1006, reason: "network lost" });
      expect(manager.getStateByProfile(profileId)).toMatchObject({
        state: "retrying",
        recoveryAttempt: 1,
      });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(connectServer).toHaveBeenCalledTimes(2);
      expect(manager.getOnlineConnection(sourceServerId)).toBeUndefined();
      expect(reconnected).not.toHaveBeenCalled();
      expect(manager.getStateByProfile(profileId)).toMatchObject({
        state: "retrying",
        recoveryAttempt: 2,
      });
      await vi.advanceTimersByTimeAsync(4_000);
      expect(connectServer).toHaveBeenCalledTimes(3);
      expect(manager.getStateByProfile(profileId)).toMatchObject({
        state: "online",
        sourceServerId,
      });
      expect(reconnected).toHaveBeenCalledOnce();
      manager.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SourceServerConnectionManager manual connect during recovery", () => {
  it("fires onDidReconnect once when a manual connect brings a retrying Source back online", async () => {
    vi.useFakeTimers();
    try {
      const adapter = createAdapter();
      const closeHandlers: Array<(event: { code: number; reason: string }) => void> = [];
      const connectServer = vi.fn(
        async (options: {
          createConnection: () => Promise<unknown>;
          onClose?: (event: { code: number; reason: string }) => void;
        }) => {
          closeHandlers.push(options.onClose ?? (() => undefined));
          await options.createConnection();
          return { serverInfo, services: {} as IServiceAccessor, dispose: vi.fn() };
        },
      );
      const manager = new SourceServerConnectionManager({
        directory: { recordHandshake: vi.fn().mockResolvedValue({ identityChanged: false }) },
        createAdapter: () => adapter,
        connectServer,
        compatibilityManifest: serverInfo.compatibility!,
      });
      const reconnected = vi.fn();
      manager.onDidReconnect(reconnected);
      await manager.connect({ profile, target });
      expect(reconnected).not.toHaveBeenCalled();

      closeHandlers[0]?.({ code: 1006, reason: "network lost" });
      expect(manager.getStateByProfile(profileId)).toMatchObject({
        state: "retrying",
        recoveryAttempt: 1,
      });

      // 首个 2s retry 尚未触发时用户手动连接成功
      const manual = await manager.connect({ profile, target });
      expect(connectServer).toHaveBeenCalledTimes(2);
      expect(manager.getStateByProfile(profileId)).toMatchObject({
        state: "online",
        sourceServerId,
      });
      expect(reconnected).toHaveBeenCalledOnce();
      expect(reconnected).toHaveBeenCalledWith(manual);

      // 待触发的 retry timer 已被发布点清掉，不会再产生第三次 connect 或重复 reconnect
      await vi.advanceTimersByTimeAsync(2_000 + 4_000 + 8_000 + 2 * 60_000);
      expect(connectServer).toHaveBeenCalledTimes(2);
      expect(reconnected).toHaveBeenCalledOnce();
      manager.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fires onDidReconnect once when a manual connect brings an offline Source back online", async () => {
    vi.useFakeTimers();
    try {
      const adapter = createAdapter();
      const closeHandlers: Array<(event: { code: number; reason: string }) => void> = [];
      let connectionAttempt = 0;
      const connectServer = vi.fn(
        async (options: {
          createConnection: () => Promise<unknown>;
          onClose?: (event: { code: number; reason: string }) => void;
        }) => {
          connectionAttempt += 1;
          closeHandlers.push(options.onClose ?? (() => undefined));
          if (connectionAttempt >= 2 && connectionAttempt <= 4) {
            throw new Error(`retry-${connectionAttempt}-failed`);
          }
          await options.createConnection();
          return { serverInfo, services: {} as IServiceAccessor, dispose: vi.fn() };
        },
      );
      const manager = new SourceServerConnectionManager({
        directory: { recordHandshake: vi.fn().mockResolvedValue({ identityChanged: false }) },
        createAdapter: () => adapter,
        connectServer,
        logWarn: vi.fn(),
        compatibilityManifest: serverInfo.compatibility!,
      });
      const reconnected = vi.fn();
      manager.onDidReconnect(reconnected);
      await manager.connect({ profile, target });
      closeHandlers[0]?.({ code: 1006, reason: "network lost" });
      await vi.advanceTimersByTimeAsync(2_000 + 4_000 + 8_000);
      expect(connectServer).toHaveBeenCalledTimes(4);
      expect(manager.getStateByProfile(profileId)).toMatchObject({
        state: "offline",
        recoveryBudgetExhausted: true,
      });

      const manual = await manager.connect({ profile, target });
      expect(connectServer).toHaveBeenCalledTimes(5);
      expect(manager.getStateByProfile(profileId)).toMatchObject({
        state: "online",
        sourceServerId,
      });
      expect(reconnected).toHaveBeenCalledOnce();
      expect(reconnected).toHaveBeenCalledWith(manual);

      await vi.advanceTimersByTimeAsync(2 * 60_000 * 2);
      expect(connectServer).toHaveBeenCalledTimes(5);
      expect(reconnected).toHaveBeenCalledOnce();
      manager.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

it("远端项目通知跟随物理连接 owner，断开后的迟到通知失效", async () => {
  let listener!: (event: { channel: string; payload: unknown }) => void;
  const subscriptionDispose = vi.fn();
  const onProjectChange = vi.fn();
  const manager = new SourceServerConnectionManager({
    directory: { recordHandshake: vi.fn(async () => ({ identityChanged: false })) },
    createAdapter: () => createAdapter(),
    compatibilityManifest: serverInfo.compatibility!,
    onProjectChange,
    connectServer: async () => ({
      serverInfo,
      dispose: vi.fn(),
      services: {
        broadcastService: {
          onMessage: (callback: typeof listener) => {
            listener = callback;
            return { dispose: subscriptionDispose };
          },
        },
      } as unknown as IServiceAccessor,
    }),
  });
  try {
    await manager.connect({ profile, target });
    listener({ channel: "state:settings", payload: {} });
    expect(onProjectChange).not.toHaveBeenCalled();
    listener({ channel: "state:projects", payload: {} });
    expect(onProjectChange).toHaveBeenCalledExactlyOnceWith(sourceServerId);
    manager.disconnect(sourceServerId);
    expect(subscriptionDispose).toHaveBeenCalledOnce();
    listener({ channel: "state:projects", payload: {} });
    expect(onProjectChange).toHaveBeenCalledOnce();
  } finally {
    manager.dispose();
  }
});

it("文件传输能力固定当前 Source generation；断开后旧能力不能新建 transport", async () => {
  const adapter = createAdapter();
  const transfer = { exec: vi.fn(), upload: vi.fn(async () => {}) };
  adapter.createFileTransfer = vi.fn(() => transfer);
  const manager = new SourceServerConnectionManager({
    directory: { recordHandshake: vi.fn(async () => ({ identityChanged: false })) },
    createAdapter: () => adapter,
    connectServer: async () => ({ serverInfo, services: {} as IServiceAccessor, dispose: vi.fn() }),
    compatibilityManifest: serverInfo.compatibility!,
  });
  try {
    await manager.connect({ profile, target });
    const first = manager.getFileTransfer(sourceServerId);
    await first.upload("/local/file", "/remote/file");
    manager.disconnect(sourceServerId);
    await expect(first.upload("/local/file", "/remote/file")).rejects.toThrow("Source Server");
    await manager.connect({ profile, target });
    await expect(first.upload("/local/file", "/remote/file")).rejects.toThrow("Source Server");
    await manager.getFileTransfer(sourceServerId).upload("/local/file", "/remote/file");
    expect(transfer.upload).toHaveBeenCalledTimes(2);
    expect(adapter.createFileTransfer).toHaveBeenCalledWith(target);
  } finally {
    manager.dispose();
  }
});

describe("升级目标身份竞态", () => {
  const targets = [
    [
      {
        kind: "ssh",
        host: "a.example.com",
        username: "dev",
        port: 22,
        privateKeyPath: "/tmp/probe-key",
      },
      {
        kind: "ssh",
        host: "b.example.com",
        username: "dev",
        port: 22,
        privateKeyPath: "/tmp/probe-key",
      },
    ],
    [
      { kind: "wsl", distro: "Ubuntu", user: "dev" },
      { kind: "wsl", distro: "Ubuntu", user: "other" },
    ],
    [
      { kind: "docker", container: "a" },
      { kind: "docker", container: "b" },
    ],
  ] as const;
  for (const [target, edited] of targets) {
    it(`${target.kind}: Host 接纳后编辑 Profile 不得改变固定安装目标`, async () => {
      let settings = appSettingsSchema.parse({
        sourceServerDirectoryMigrationVersion: 1,
        connectionProfiles: [{ profileId, transport: target.kind, target, createdAt: 1 }],
      });
      const directory = new SourceServerDirectory({
        settingService: {
          get: async () => settings,
          update: async (patch: Record<string, unknown>) => {
            settings = appSettingsSchema.parse({ ...settings, ...patch });
          },
        } as never,
        credentialService: {
          load: async () => null,
          save: async () => {},
          delete: async () => {},
        } as never,
      });
      const adapter = createAdapter(true, target.kind);
      vi.mocked(adapter.installOrUpdate).mockRejectedValue(
        new Error("fixture stopped before remote IO"),
      );
      const manager = new SourceServerConnectionManager({
        directory,
        createAdapter: () => adapter,
      });
      const service = createSourceServerManagementService({
        directory,
        manager,
        resolveRelease: async () => createRelease("3.15.0"),
      });
      const resolveTarget = directory.resolveProfileTarget.bind(directory);
      vi.spyOn(directory, "resolveProfileTarget").mockImplementationOnce(async (profileOrId) => {
        await service.updateProfile({
          profileId,
          profileDisplayName: "edited",
          target: edited,
          ...(target.kind === "ssh" ? { sshAuthMethod: "privateKey" as const } : {}),
        });
        return resolveTarget(profileOrId);
      });
      const expectedTarget =
        target.kind === "ssh"
          ? { kind: target.kind, host: target.host, username: target.username, port: target.port }
          : target;
      try {
        await expect(
          service.updateSource({ profileId, expectedTarget, force: false }),
        ).rejects.toThrow("fixture stopped before remote IO");
        expect(adapter.installOrUpdate).toHaveBeenCalledWith(
          expect.objectContaining(target),
          expect.anything(),
          expect.anything(),
          { force: false },
        );
        expect((await directory.snapshot()).profiles[0]?.target).toMatchObject(edited);
      } finally {
        service.dispose();
        manager.dispose();
      }
    });

    it.each([false, true])(
      `${target.kind}: 快照校验后改址，force=%s 不得进入远端安装`,
      async (force) => {
        let settings = appSettingsSchema.parse({
          sourceServerDirectoryMigrationVersion: 1,
          connectionProfiles: [{ profileId, transport: target.kind, target, createdAt: 1 }],
        });
        const directory = new SourceServerDirectory({
          settingService: {
            get: async () => settings,
            update: async (patch: Record<string, unknown>) => {
              settings = appSettingsSchema.parse({ ...settings, ...patch });
            },
          } as never,
          credentialService: {
            load: async () => null,
            save: async () => {},
            delete: async () => {},
          } as never,
        });
        const adapter = createAdapter(true, target.kind);
        const manager = new SourceServerConnectionManager({
          directory,
          createAdapter: () => adapter,
          compatibilityManifest: {
            schemaVersion: 1,
            productVersion: "3.15.0",
            minCompatibleVersion: "3.15.0",
          },
        });
        const service = createSourceServerManagementService({
          directory,
          manager,
          resolveRelease: async () => createRelease("3.15.0"),
        });
        try {
          await expect(
            manager.connect({ profile: (await directory.snapshot()).profiles[0]!, target }),
          ).rejects.toMatchObject({ code: "source-server-upgrade-required" });
          const snapshot = await service.getSnapshot();
          expect(snapshot.states[0]?.state).toBe("needs-upgrade");
          const expectedTarget =
            target.kind === "ssh"
              ? {
                  kind: target.kind,
                  host: target.host,
                  username: target.username,
                  port: target.port,
                }
              : target;
          await service.updateProfile({
            profileId,
            profileDisplayName: "edited",
            target: edited,
            ...(target.kind === "ssh" ? { sshAuthMethod: "privateKey" as const } : {}),
          });
          vi.mocked(adapter.probe).mockClear();
          await expect(
            service.updateSource({ profileId, expectedTarget, force }),
          ).rejects.toMatchObject({ code: "remote-target-changed" });
          expect(adapter.probe).not.toHaveBeenCalled();
          expect(adapter.installOrUpdate).not.toHaveBeenCalled();
        } finally {
          service.dispose();
          manager.dispose();
        }
      },
    );
  }
});
