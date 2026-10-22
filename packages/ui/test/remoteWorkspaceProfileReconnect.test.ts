import { describe, expect, it, vi } from "vitest";
import {
  appSettingsSchema,
  type RemoteWorkspaceSessionEntry,
  type SSHProfileTarget,
} from "@zcode/shared";
import { reconnectRemoteWorkspaceHistoryEntry } from "@/root/reconnectRemoteWorkspaceHistoryEntry.js";

vi.mock("@/store/remotePinnedTaskStore.js", () => ({
  refreshRemotePinnedTasksForSession: vi.fn(async () => undefined),
}));
vi.mock("@/store/remoteTimelineTaskStore.js", () => ({
  refreshRemoteTimelineTasksForSession: vi.fn(async () => undefined),
}));

const profileId = "17ef20b3-622d-4a53-98c1-0cdff29f3e6d";
const sourceServerId = "3cd4f9da-cd79-426c-9d70-75f36e9f6a87";
const oldTarget: SSHProfileTarget = {
  kind: "ssh",
  host: "old.example.com",
  port: 22,
  username: "old-user",
  passwordCredentialKey: "legacy-password",
};
const updatedTarget: SSHProfileTarget = {
  kind: "ssh",
  host: "new.example.com",
  port: 2222,
  username: "dev",
  passwordCredentialKey: "profile-password",
};

function setup(target: SSHProfileTarget = updatedTarget) {
  const sessionEntry: RemoteWorkspaceSessionEntry = {
    kind: "remote",
    workspacePath: "/workspace/project",
    workspaceIdentity: `remote:server:${sourceServerId}:/workspace/project`,
    target: { ...oldTarget },
    lastOpenedAt: 1,
  };
  const settings = appSettingsSchema.parse({
    connectionProfiles: [{ profileId, sourceServerId, transport: "ssh", target, createdAt: 1 }],
    sourceServerWorkspaceHistory: [
      {
        profileId,
        sourceServerId,
        workspacePath: sessionEntry.workspacePath,
        workspaceIdentity: sessionEntry.workspaceIdentity,
        lastOpenedAt: 1,
      },
    ],
  });
  const params: Parameters<typeof reconnectRemoteWorkspaceHistoryEntry>[0] = {
    sessionEntry,
    activateTabByPath: vi.fn(() => false),
    setReconnectingRemoteWorkspaceKeys: vi.fn(),
    getSettings: vi.fn(async () => settings),
    loadCredential: vi.fn(async (key) => `${key}-value`),
    connectRemoteWorkspaceTarget: vi.fn(async () => "new-session"),
    resolveRemoteWorkspaceCanonicalPath: vi.fn(async () => sessionEntry.workspacePath),
    bindRemoteWorkspaceScope: vi.fn(async () => ({
      workspacePath: sessionEntry.workspacePath,
      workspaceIdentity: sessionEntry.workspaceIdentity!,
    })),
    disposeRemoteWorkspaceSession: vi.fn(async () => undefined),
    bindRemoteWorkspacePath: vi.fn(),
    bindRemoteWorkspaceIdentity: vi.fn(),
    upsertWorkspaceTab: vi.fn(),
    commitRemoteWorkspaceSessionMutation: vi.fn(async (mutation) => mutation.entry),
    getRemoteSessions: () => [sessionEntry],
    logger: { warn: vi.fn() },
    toast: vi.fn(),
    options: { requireStoredCredentials: true, throwOnFailure: true, showErrorToast: false },
  };
  return { params, settings, sessionEntry };
}

describe("SSH 原项目重连读取最新 Profile", () => {
  it.each(["manual", "automatic"] as const)(
    "%s 恢复使用原绑定线路的新地址和凭据，保留项目身份",
    async (recoveryMode) => {
      const { params, settings, sessionEntry } = setup();
      params.options = { ...params.options, recoveryMode };
      // 同设备另一条默认线路不能替代项目历史绑定的线路。
      const otherProfileId = "8a116c93-1306-48a8-b8bf-4bdc318b8684";
      settings.connectionProfiles!.unshift({
        ...settings.connectionProfiles![0]!,
        profileId: otherProfileId,
        target: { ...updatedTarget, host: "other.example.com" },
      });
      settings.sourceServers = [
        {
          sourceServerId,
          displayName: "Device",
          preferredProfileId: otherProfileId,
          installState: "installed",
        },
      ];
      await reconnectRemoteWorkspaceHistoryEntry(params);
      expect(params.connectRemoteWorkspaceTarget).toHaveBeenCalledWith(
        {
          kind: "ssh",
          host: "new.example.com",
          port: 2222,
          username: "dev",
          password: "profile-password-value",
        },
        undefined,
        {
          workspacePath: sessionEntry.workspacePath,
          workspaceIdentity: sessionEntry.workspaceIdentity,
          connectTrigger: "reconnect",
        },
      );
      expect(params.loadCredential).toHaveBeenCalledExactlyOnceWith("profile-password");
      expect(params.upsertWorkspaceTab).toHaveBeenCalledWith(
        sessionEntry.workspacePath,
        expect.objectContaining({
          workspaceIdentity: sessionEntry.workspaceIdentity,
          remoteTarget: { kind: "ssh", host: "new.example.com", port: 2222, username: "dev" },
        }),
      );
      expect(params.commitRemoteWorkspaceSessionMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          entry: expect.objectContaining({
            workspaceIdentity: sessionEntry.workspaceIdentity,
            target: expect.objectContaining({ host: "new.example.com", port: 2222 }),
          }),
        }),
      );
    },
  );

  it("更换无口令私钥后不继承旧密码和旧私钥口令，也不误报凭据缺失", async () => {
    const { params, sessionEntry } = setup({
      kind: "ssh",
      host: "new.example.com",
      username: "dev",
      privateKeyPath: "/keys/new-key",
    });
    sessionEntry.target = {
      ...oldTarget,
      privateKeyPath: "/keys/old-key",
      privateKeyPassphraseCredentialKey: "legacy-passphrase",
    };
    await reconnectRemoteWorkspaceHistoryEntry(params);
    expect(params.loadCredential).not.toHaveBeenCalled();
    expect(params.connectRemoteWorkspaceTarget).toHaveBeenCalledWith(
      { kind: "ssh", host: "new.example.com", username: "dev", privateKeyPath: "/keys/new-key" },
      undefined,
      expect.anything(),
    );
  });

  it("从密码切换到有口令的私钥后使用新路径和口令", async () => {
    const { params } = setup({
      kind: "ssh",
      host: "new.example.com",
      username: "dev",
      privateKeyPath: "/keys/new-key",
      privateKeyPassphraseCredentialKey: "profile-passphrase",
    });
    await reconnectRemoteWorkspaceHistoryEntry(params);
    expect(params.connectRemoteWorkspaceTarget).toHaveBeenCalledWith(
      {
        kind: "ssh",
        host: "new.example.com",
        username: "dev",
        privateKeyPath: "/keys/new-key",
        privateKeyPassphrase: "profile-passphrase-value",
      },
      undefined,
      expect.anything(),
    );
    expect(params.loadCredential).toHaveBeenCalledExactlyOnceWith("profile-passphrase");
  });

  it("Profile 无新凭据引用时兼容相同认证方式的旧凭据，但仍使用新地址", async () => {
    const { params } = setup({ kind: "ssh", host: "new.example.com", username: "dev", port: 2222 });
    await reconnectRemoteWorkspaceHistoryEntry(params);
    expect(params.connectRemoteWorkspaceTarget).toHaveBeenCalledWith(
      {
        kind: "ssh",
        host: "new.example.com",
        username: "dev",
        port: 2222,
        password: "legacy-password-value",
      },
      undefined,
      expect.anything(),
    );
    expect(params.loadCredential).toHaveBeenCalledExactlyOnceWith("legacy-password");
  });

  it("没有绑定 Profile 的旧历史继续使用原地址和凭据", async () => {
    const { params, settings } = setup();
    settings.sourceServerWorkspaceHistory = [];
    await reconnectRemoteWorkspaceHistoryEntry(params);
    expect(params.connectRemoteWorkspaceTarget).toHaveBeenCalledWith(
      {
        kind: "ssh",
        host: "old.example.com",
        port: 22,
        username: "old-user",
        password: "legacy-password-value",
      },
      undefined,
      expect.anything(),
    );
  });

  it("新 Profile 的密码实际缺失时拒绝连接，不退回旧密码", async () => {
    const { params } = setup();
    params.loadCredential = vi.fn(async (key) => (key === "legacy-password" ? "old-secret" : null));
    await expect(reconnectRemoteWorkspaceHistoryEntry(params)).rejects.toMatchObject({
      code: "credentials-required",
    });
    expect(params.connectRemoteWorkspaceTarget).not.toHaveBeenCalled();
    expect(params.loadCredential).toHaveBeenCalledExactlyOnceWith("profile-password");
  });

  it("sibling 使用最新地址和发起方凭据，不重新读取本项目凭据", async () => {
    const { params } = setup();
    params.loadCredential = vi.fn(async () => {
      throw new Error("unexpected credential read");
    });
    params.options = {
      ...params.options,
      sshCredentialsOverride: { password: "initiator-secret", privateKeyPassphrase: null },
    };
    await reconnectRemoteWorkspaceHistoryEntry(params);
    expect(params.loadCredential).not.toHaveBeenCalled();
    expect(params.connectRemoteWorkspaceTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "new.example.com",
        port: 2222,
        password: "initiator-secret",
      }),
      undefined,
      expect.anything(),
    );
  });
});
