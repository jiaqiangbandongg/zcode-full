import { describe, expect, it, vi } from "vitest";
import { appSettingsSchema, type AppSettings } from "@zcode/shared";
import type { ICredentialService, ISettingService } from "@zcode/services";
import { SourceServerDirectory } from "../src/host/sourceServerDirectory.js";

const profileId = "17ef20b3-622d-4a53-98c1-0cdff29f3e6d";
const sourceServerId = "3cd4f9da-cd79-426c-9d70-75f36e9f6a87";
const replacementSourceServerId = "fbc717a0-86d5-464d-b976-8eb55db6f1db";
const replacementProfileId = "8a116c93-1306-48a8-b8bf-4bdc318b8684";

function createSettingService(initial: Partial<AppSettings>): {
  service: ISettingService;
  read: () => AppSettings;
} {
  let settings = appSettingsSchema.parse(initial);
  return {
    read: () => settings,
    service: {
      get: vi.fn(async () => settings),
      update: vi.fn(async (patch) => {
        settings = appSettingsSchema.parse({ ...settings, ...patch });
      }),
      updateDataBaseDir: vi.fn(),
    },
  };
}

function createCredentialService(initial: Record<string, string>): {
  service: ICredentialService;
  read: (key: string) => string | undefined;
} {
  const values = new Map(Object.entries(initial));
  return {
    read: (key) => values.get(key),
    service: {
      load: vi.fn(async (key) => values.get(key) ?? null),
      save: vi.fn(async (key, value) => {
        values.set(key, value);
      }),
      delete: vi.fn(async (key) => {
        values.delete(key);
      }),
    },
  };
}

describe("SourceServerDirectory", () => {
  it("includes saved profiles that have never completed their first handshake", async () => {
    const settings = createSettingService({
      sourceServerDirectoryMigrationVersion: 1,
      connectionProfiles: [
        {
          profileId,
          transport: "docker",
          target: { kind: "docker", container: "new" },
          createdAt: 1,
        },
      ],
    });
    const directory = new SourceServerDirectory({
      settingService: settings.service,
      credentialService: createCredentialService({}).service,
    });
    await expect(directory.listStartupReconnectCandidates()).resolves.toEqual([
      {
        profile: settings.read().connectionProfiles?.[0],
        target: { kind: "docker", container: "new" },
      },
    ]);
  });
  it("最近在线保存最后在线时刻，迟到写入不能倒退或复活已移除设备", async () => {
    const settings = createSettingService({
      sourceServers: [
        { sourceServerId, displayName: "Build", installState: "installed", lastOnlineAt: 1000 },
      ],
    });
    const directory = new SourceServerDirectory({
      settingService: settings.service,
      credentialService: createCredentialService({}).service,
    });
    await directory.recordLastOnline(sourceServerId, 9000);
    await directory.recordLastOnline(sourceServerId, 4000);
    expect((await directory.snapshot()).servers[0]?.lastOnlineAt).toBe(9000);
    await directory.removeSourceServer(sourceServerId);
    await directory.recordLastOnline(sourceServerId, 12000);
    expect((await directory.snapshot()).servers).toEqual([]);
  });

  it("stores a Source-scoped conversation backing path outside strict project history", async () => {
    const conversationPath = "/home/dev/.zcode/workspace/default";
    const realProject = {
      profileId,
      sourceServerId,
      workspacePath: "/home/dev/project",
      workspaceIdentity: `remote:server:${sourceServerId}:/home/dev/project`,
      lastOpenedAt: 10,
    };
    const otherSourceConversationPath = {
      profileId: replacementProfileId,
      sourceServerId: replacementSourceServerId,
      workspacePath: conversationPath,
      workspaceIdentity: `remote:server:${replacementSourceServerId}:${conversationPath}`,
      lastOpenedAt: 11,
    };
    const settings = createSettingService({
      sourceServerWorkspaceHistory: [
        {
          profileId,
          sourceServerId,
          workspacePath: conversationPath,
          workspaceIdentity: `remote:server:${sourceServerId}:${conversationPath}`,
          lastOpenedAt: 9,
        },
        realProject,
        otherSourceConversationPath,
      ],
    });
    const directory = new SourceServerDirectory({
      settingService: settings.service,
      credentialService: createCredentialService({}).service,
      now: () => 42,
    });

    await directory.recordConversationWorkspace(sourceServerId, conversationPath);

    expect(settings.read().remoteConversationWorkspaceBySourceServerId).toEqual({
      [sourceServerId]: {
        workspacePath: conversationPath,
        lastResolvedAt: 42,
      },
    });
    expect(settings.read().sourceServerWorkspaceHistory).toEqual([
      realProject,
      otherSourceConversationPath,
    ]);
  });

  it("allows a failed initialization flight to be retried", async () => {
    const settings = createSettingService({});
    vi.mocked(settings.service.get).mockRejectedValueOnce(new Error("settings temporarily locked"));
    const directory = new SourceServerDirectory({
      settingService: settings.service,
      credentialService: createCredentialService({}).service,
    });

    await expect(directory.initialize()).rejects.toThrow("settings temporarily locked");
    await expect(directory.initialize()).resolves.toBeUndefined();
    expect(settings.read().sourceServerDirectoryMigrationVersion).toBe(1);
  });

  it("rolls back migrated SSH credentials when settings persistence fails before a retry", async () => {
    const legacyPasswordKey = "remote-workspace:legacy:password";
    const firstProfilePasswordKey = `connection-profile:${profileId}:password`;
    const replacementProfilePasswordKey = `connection-profile:${replacementProfileId}:password`;
    const settings = createSettingService({
      lastWorkspaceSession: [
        {
          kind: "remote",
          workspacePath: "/srv/project",
          workspaceIdentity: "remote:ssh:example.com:22:alice:/srv/project",
          target: {
            kind: "ssh",
            host: "example.com",
            username: "alice",
            passwordCredentialKey: legacyPasswordKey,
          },
          lastOpenedAt: 10,
          lastConnectionStatus: "connected",
        },
      ],
    });
    vi.mocked(settings.service.update).mockRejectedValueOnce(new Error("settings write failed"));
    const credentials = createCredentialService({
      [legacyPasswordKey]: "saved-password",
    });
    const createProfileId = vi
      .fn<() => string>()
      .mockReturnValueOnce(profileId)
      .mockReturnValueOnce(replacementProfileId);
    const directory = new SourceServerDirectory({
      settingService: settings.service,
      credentialService: credentials.service,
      createProfileId,
    });

    await expect(directory.initialize()).rejects.toThrow("settings write failed");
    expect(credentials.read(firstProfilePasswordKey)).toBeUndefined();
    expect(credentials.read(legacyPasswordKey)).toBe("saved-password");

    await expect(directory.initialize()).resolves.toBeUndefined();
    expect(credentials.read(firstProfilePasswordKey)).toBeUndefined();
    expect(credentials.read(replacementProfilePasswordKey)).toBe("saved-password");
    expect(settings.read().connectionProfiles?.[0]).toMatchObject({
      profileId: replacementProfileId,
      target: { passwordCredentialKey: replacementProfilePasswordKey },
    });
  });

  it("waits for every migrated SSH credential write before rolling back a partial failure", async () => {
    const legacyPasswordKey = "remote-workspace:legacy:password";
    const legacyPassphraseKey = "remote-workspace:legacy:private-key-passphrase";
    const passwordKey = `connection-profile:${profileId}:password`;
    const passphraseKey = `connection-profile:${profileId}:private-key-passphrase`;
    const settings = createSettingService({
      lastWorkspaceSession: [
        {
          kind: "remote",
          workspacePath: "/srv/project",
          target: {
            kind: "ssh",
            host: "example.com",
            username: "alice",
            passwordCredentialKey: legacyPasswordKey,
            privateKeyPath: "/home/alice/.ssh/id_ed25519",
            privateKeyPassphraseCredentialKey: legacyPassphraseKey,
          },
          lastOpenedAt: 10,
          lastConnectionStatus: "connected",
        },
      ],
    });
    const values = new Map([
      [legacyPasswordKey, "saved-password"],
      [legacyPassphraseKey, "saved-passphrase"],
    ]);
    let resolvePasswordWrite!: () => void;
    const passwordWriteCompleted = new Promise<void>((resolve) => {
      resolvePasswordWrite = resolve;
    });
    const credentialService: ICredentialService = {
      load: vi.fn(async (key) => values.get(key) ?? null),
      save: vi.fn(async (key, value) => {
        if (key === passwordKey) {
          await new Promise<void>((resolve) => setImmediate(resolve));
          values.set(key, value);
          resolvePasswordWrite();
          return;
        }
        if (key === passphraseKey) {
          throw new Error("passphrase write failed");
        }
        values.set(key, value);
      }),
      delete: vi.fn(async (key) => {
        values.delete(key);
      }),
    };
    const directory = new SourceServerDirectory({
      settingService: settings.service,
      credentialService,
      createProfileId: () => profileId,
    });

    await expect(directory.initialize()).rejects.toThrow("passphrase write failed");
    await passwordWriteCompleted;

    expect(values.get(passwordKey)).toBeUndefined();
    expect(values.get(passphraseKey)).toBeUndefined();
    expect(settings.read().sourceServerDirectoryMigrationVersion).toBeUndefined();
  });

  it("does not persist credentials for a generated Profile excluded from the migration commit", async () => {
    const legacyPasswordKey = "remote-workspace:legacy:password";
    const excludedPasswordKey = `connection-profile:${replacementProfileId}:password`;
    const settings = createSettingService({
      connectionProfiles: [
        {
          profileId,
          transport: "wsl",
          target: { kind: "wsl", distro: "Ubuntu" },
          createdAt: 1,
        },
      ],
      lastWorkspaceSession: [
        {
          kind: "remote",
          workspacePath: "/srv/project",
          target: {
            kind: "ssh",
            host: "example.com",
            username: "alice",
            passwordCredentialKey: legacyPasswordKey,
          },
          lastOpenedAt: 10,
          lastConnectionStatus: "connected",
        },
      ],
    });
    const credentials = createCredentialService({
      [legacyPasswordKey]: "saved-password",
    });
    const directory = new SourceServerDirectory({
      settingService: settings.service,
      credentialService: credentials.service,
      createProfileId: () => replacementProfileId,
    });

    await directory.initialize();

    expect(settings.read().connectionProfiles).toEqual([expect.objectContaining({ profileId })]);
    expect(credentials.read(excludedPasswordKey)).toBeUndefined();
    expect(credentials.read(legacyPasswordKey)).toBe("saved-password");
  });

  it("stores new SSH secrets on the Connection Profile and refreshes them on reuse", async () => {
    const settings = createSettingService({});
    const credentials = createCredentialService({});
    const directory = new SourceServerDirectory({
      settingService: settings.service,
      credentialService: credentials.service,
      createProfileId: () => profileId,
      now: () => 10,
    });

    const first = await directory.ensureProfile({
      kind: "ssh",
      host: "EXAMPLE.com",
      username: "alice",
      password: "first-password",
      privateKeyPath: "/home/alice/.ssh/id_ed25519",
      privateKeyPassphrase: "first-passphrase",
    });

    expect(first.target).toMatchObject({
      kind: "ssh",
      host: "example.com",
      port: 22,
      username: "alice",
      passwordCredentialKey: `connection-profile:${profileId}:password`,
      privateKeyPassphraseCredentialKey: `connection-profile:${profileId}:private-key-passphrase`,
    });
    expect(credentials.read(`connection-profile:${profileId}:password`)).toBe("first-password");
    expect(credentials.read(`connection-profile:${profileId}:private-key-passphrase`)).toBe(
      "first-passphrase",
    );

    const reused = await directory.ensureProfile({
      kind: "ssh",
      host: "example.com",
      port: 22,
      username: "alice",
      password: "updated-password",
      privateKeyPath: "/home/alice/.ssh/id_ed25519",
      privateKeyPassphrase: "updated-passphrase",
    });

    expect(reused.profileId).toBe(profileId);
    expect(settings.read().connectionProfiles).toHaveLength(1);
    expect(credentials.read(`connection-profile:${profileId}:password`)).toBe("updated-password");
    expect(credentials.read(`connection-profile:${profileId}:private-key-passphrase`)).toBe(
      "updated-passphrase",
    );
  });

  it("reuses an SSH Profile when only the asset install mode changes", async () => {
    const settings = createSettingService({
      sourceServerDirectoryMigrationVersion: 1,
      connectionProfiles: [
        {
          profileId,
          sourceServerId,
          displayName: "linux-amd64-dev",
          transport: "ssh",
          target: {
            kind: "ssh",
            host: "localhost",
            port: 2222,
            username: "dev",
            assetInstallMode: "remote-download",
          },
          createdAt: 1,
          lifecycleState: "active",
        },
      ],
      sourceServers: [
        {
          sourceServerId,
          displayName: "linux-amd64-dev",
          preferredProfileId: profileId,
          installState: "installed",
          declaredWorkspaces: [],
        },
      ],
    });
    const directory = new SourceServerDirectory({
      settingService: settings.service,
      credentialService: createCredentialService({}).service,
    });

    const reused = await directory.ensureProfile({
      kind: "ssh",
      host: "localhost",
      port: 2222,
      username: "dev",
      assetInstallMode: "local-download-upload",
    });

    expect(reused.profileId).toBe(profileId);
    expect(settings.read().connectionProfiles).toHaveLength(1);
    expect(settings.read().connectionProfiles?.[0]).toMatchObject({
      profileId,
      sourceServerId,
      target: {
        host: "localhost",
        port: 2222,
        username: "dev",
        assetInstallMode: "local-download-upload",
      },
    });
  });

  it("updates an SSH Profile in place without changing its Source or workspace history", async () => {
    const passwordKey = `connection-profile:${profileId}:password`;
    const passphraseKey = `connection-profile:${profileId}:private-key-passphrase`;
    const history = {
      profileId,
      sourceServerId,
      workspacePath: "/srv/project",
      workspaceIdentity: `remote:server:${sourceServerId}:/srv/project`,
      lastOpenedAt: 10,
    };
    const settings = createSettingService({
      sourceServerDirectoryMigrationVersion: 1,
      connectionProfiles: [
        {
          profileId,
          sourceServerId,
          transport: "ssh",
          displayName: "old connection",
          target: {
            kind: "ssh",
            host: "old.example.com",
            port: 22,
            username: "old-user",
            privateKeyPath: "/old/key",
            passwordCredentialKey: passwordKey,
            privateKeyPassphraseCredentialKey: passphraseKey,
          },
          createdAt: 1,
          lifecycleState: "active",
        },
      ],
      sourceServers: [
        {
          sourceServerId,
          displayName: "Old device",
          preferredProfileId: profileId,
          installState: "installed",
          declaredWorkspaces: [],
        },
      ],
      sourceServerWorkspaceHistory: [history],
    });
    const credentials = createCredentialService({
      [passwordKey]: "old-password",
      [passphraseKey]: "old-passphrase",
    });
    const directory = new SourceServerDirectory({
      settingService: settings.service,
      credentialService: credentials.service,
    });

    await directory.updateProfile({
      profileId,
      profileDisplayName: "primary connection",
      sourceDisplayName: "Build server",
      sshAuthMethod: "password",
      target: {
        kind: "ssh",
        host: "NEW.example.com",
        port: 2222,
        username: "dev",
        password: "new-password",
      },
    });

    expect(settings.read().connectionProfiles).toEqual([
      expect.objectContaining({
        profileId,
        sourceServerId,
        displayName: "primary connection",
        target: expect.objectContaining({
          kind: "ssh",
          host: "new.example.com",
          port: 2222,
          username: "dev",
          passwordCredentialKey: passwordKey,
        }),
      }),
    ]);
    expect(settings.read().sourceServers?.[0]).toMatchObject({
      sourceServerId,
      displayName: "Build server",
      preferredProfileId: profileId,
    });
    expect(settings.read().sourceServerWorkspaceHistory).toEqual([history]);
    expect(credentials.read(passwordKey)).toBe("new-password");
    expect(credentials.read(passphraseKey)).toBeUndefined();
  });

  it("rejects changing the transport of an existing Profile", async () => {
    const settings = createSettingService({
      sourceServerDirectoryMigrationVersion: 1,
      connectionProfiles: [
        {
          profileId,
          sourceServerId,
          transport: "ssh",
          displayName: "primary",
          target: { kind: "ssh", host: "example.com", username: "dev" },
          createdAt: 1,
          lifecycleState: "active",
        },
      ],
    });
    const directory = new SourceServerDirectory({
      settingService: settings.service,
      credentialService: createCredentialService({}).service,
    });

    await expect(
      directory.updateProfile({
        profileId,
        profileDisplayName: "primary",
        target: { kind: "docker", container: "dev" },
      }),
    ).rejects.toThrow("transport cannot be changed");
    expect(settings.read().connectionProfiles?.[0]).toMatchObject({
      profileId,
      transport: "ssh",
      target: { kind: "ssh", host: "example.com", username: "dev" },
    });
  });

  it("rejects an invalid target without changing the existing Profile", async () => {
    const settings = createSettingService({
      sourceServerDirectoryMigrationVersion: 1,
      connectionProfiles: [
        {
          profileId,
          sourceServerId,
          transport: "docker",
          displayName: "dev container",
          target: { kind: "docker", container: "zcode-dev" },
          createdAt: 1,
          lifecycleState: "active",
        },
      ],
    });
    const directory = new SourceServerDirectory({
      settingService: settings.service,
      credentialService: createCredentialService({}).service,
    });

    await expect(
      directory.updateProfile({
        profileId,
        profileDisplayName: "dev container",
        target: { kind: "docker", container: "   " },
      }),
    ).rejects.toThrow("Docker container is required");
    expect(settings.read().connectionProfiles?.[0]).toMatchObject({
      profileId,
      target: { kind: "docker", container: "zcode-dev" },
    });
  });

  it("migrates the newest available sibling credential when the latest route entry is dangling", async () => {
    const settings = createSettingService({
      lastWorkspaceSession: [
        {
          kind: "remote",
          workspacePath: "/srv/a",
          workspaceIdentity: "remote:ssh:example.com:22:alice:/srv/a",
          target: {
            kind: "ssh",
            host: "EXAMPLE.com",
            username: "alice",
            passwordCredentialKey: "remote-workspace:a:password",
          },
          lastOpenedAt: 10,
          lastConnectionStatus: "connected",
        },
        {
          kind: "remote",
          workspacePath: "/srv/b",
          workspaceIdentity: "remote:ssh:example.com:22:alice:/srv/b",
          target: {
            kind: "ssh",
            host: "example.COM",
            port: 22,
            username: "alice",
            passwordCredentialKey: "remote-workspace:b:password",
          },
          lastOpenedAt: 20,
          lastConnectionStatus: "connected",
        },
      ],
    });
    const credentials = createCredentialService({
      "remote-workspace:a:password": "older-password",
    });
    const directory = new SourceServerDirectory({
      settingService: settings.service,
      credentialService: credentials.service,
      createProfileId: () => profileId,
    });

    await directory.initialize();
    await directory.initialize();

    expect(settings.read().connectionProfiles).toHaveLength(1);
    expect(settings.read().connectionProfiles?.[0]).toMatchObject({
      profileId,
      transport: "ssh",
      target: {
        kind: "ssh",
        host: "example.com",
        port: 22,
        username: "alice",
        passwordCredentialKey: `connection-profile:${profileId}:password`,
      },
    });
    expect(settings.read().sourceServerWorkspaceHistory).toHaveLength(2);
    expect(
      settings.read().sourceServerWorkspaceHistory?.map((entry) => entry.legacyWorkspaceIdentity),
    ).toEqual(["remote:ssh:example.com:22:alice:/srv/a", "remote:ssh:example.com:22:alice:/srv/b"]);
    expect(credentials.read(`connection-profile:${profileId}:password`)).toBe("older-password");
    expect(credentials.read("remote-workspace:b:password")).toBeUndefined();
  });

  it("repairs a migrated Profile whose canonical password is missing from an exact-route legacy sibling", async () => {
    const canonicalPasswordKey = `connection-profile:${profileId}:password`;
    const settings = createSettingService({
      sourceServerDirectoryMigrationVersion: 1,
      connectionProfiles: [
        {
          profileId,
          transport: "ssh",
          target: {
            kind: "ssh",
            host: "example.com",
            port: 22,
            username: "alice",
            passwordCredentialKey: canonicalPasswordKey,
          },
          createdAt: 1,
          lifecycleState: "active",
        },
      ],
      lastWorkspaceSession: [
        {
          kind: "remote",
          workspacePath: "/srv/latest",
          workspaceIdentity: "remote:ssh:example.com:22:alice:/srv/latest",
          target: {
            kind: "ssh",
            host: "example.com",
            port: 22,
            username: "alice",
            passwordCredentialKey: "remote-workspace:latest:password",
          },
          lastOpenedAt: 20,
          lastConnectionStatus: "connected",
        },
        {
          kind: "remote",
          workspacePath: "/srv/older",
          workspaceIdentity: "remote:ssh:example.com:22:alice:/srv/older",
          target: {
            kind: "ssh",
            host: "example.com",
            port: 22,
            username: "alice",
            passwordCredentialKey: "remote-workspace:older:password",
          },
          lastOpenedAt: 10,
          lastConnectionStatus: "connected",
        },
      ],
    });
    const credentials = createCredentialService({
      "remote-workspace:older:password": "recovered-password",
    });
    const directory = new SourceServerDirectory({
      settingService: settings.service,
      credentialService: credentials.service,
    });

    await directory.initialize();

    expect(credentials.read(canonicalPasswordKey)).toBe("recovered-password");
    expect(settings.read().connectionProfiles?.[0]?.profileId).toBe(profileId);
  });

  it("does not create a Profile password ref when every exact-route legacy value is missing", async () => {
    const settings = createSettingService({
      lastWorkspaceSession: [
        {
          kind: "remote",
          workspacePath: "/srv/project",
          workspaceIdentity: "remote:ssh:example.com:22:alice:/srv/project",
          target: {
            kind: "ssh",
            host: "example.com",
            port: 22,
            username: "alice",
            passwordCredentialKey: "remote-workspace:missing:password",
          },
          lastOpenedAt: 10,
          lastConnectionStatus: "connected",
        },
      ],
    });
    const directory = new SourceServerDirectory({
      settingService: settings.service,
      credentialService: createCredentialService({}).service,
      createProfileId: () => profileId,
    });

    await directory.initialize();

    expect(settings.read().connectionProfiles?.[0]?.target).toEqual({
      kind: "ssh",
      host: "example.com",
      port: 22,
      username: "alice",
    });
  });

  it("does not create a Profile passphrase ref when legacy password auth has no private key", async () => {
    const legacyPasswordKey = "remote-workspace:legacy:password";
    const legacyPassphraseKey = "remote-workspace:legacy:private-key-passphrase";
    const settings = createSettingService({
      lastWorkspaceSession: [
        {
          kind: "remote",
          workspacePath: "/srv/project",
          workspaceIdentity: "remote:ssh:example.com:22:alice:/srv/project",
          target: {
            kind: "ssh",
            host: "example.com",
            username: "alice",
            passwordCredentialKey: legacyPasswordKey,
            privateKeyPassphraseCredentialKey: legacyPassphraseKey,
          },
          lastOpenedAt: 10,
          lastConnectionStatus: "connected",
        },
      ],
    });
    const credentials = createCredentialService({
      [legacyPasswordKey]: "saved-password",
    });
    const directory = new SourceServerDirectory({
      settingService: settings.service,
      credentialService: credentials.service,
      createProfileId: () => profileId,
    });

    await directory.initialize();

    expect(settings.read().connectionProfiles?.[0]?.target).toEqual({
      kind: "ssh",
      host: "example.com",
      port: 22,
      username: "alice",
      passwordCredentialKey: `connection-profile:${profileId}:password`,
    });
    expect(
      credentials.read(`connection-profile:${profileId}:private-key-passphrase`),
    ).toBeUndefined();
  });

  it("binds a successful Profile handshake to one stable Source Server and rekeys its workspace history", async () => {
    const settings = createSettingService({
      connectionProfiles: [
        {
          profileId,
          transport: "docker",
          target: { kind: "docker", container: "zcode-dev" },
          createdAt: 1,
        },
      ],
      sourceServerWorkspaceHistory: [
        {
          workspacePath: "/workspace",
          legacyWorkspaceIdentity: "remote:docker:zcode-dev:/workspace",
          profileId,
          lastOpenedAt: 1,
        },
      ],
      sourceServerDirectoryMigrationVersion: 1,
    });
    const credentials = createCredentialService({});
    const directory = new SourceServerDirectory({
      settingService: settings.service,
      credentialService: credentials.service,
      migrateControllerIdentity: vi.fn(async () => ({
        migrationId: "migration-1",
        status: "completed",
        before: {} as never,
        after: {} as never,
      })),
    });

    await directory.initialize();
    await directory.recordHandshake(profileId, {
      sourceServerId,
      osUser: "alice",
      hostname: "devbox",
      version: "3.8.0",
      connectedAt: 100,
    });

    expect(settings.read().sourceServers).toEqual([
      {
        sourceServerId,
        displayName: "devbox · alice",
        osUser: "alice",
        hostname: "devbox",
        installState: "installed",
        lastSeenVersion: "3.8.0",
        lastOnlineAt: 100,
        preferredProfileId: profileId,
        declaredWorkspaces: [],
      },
    ]);
    expect(settings.read().connectionProfiles?.[0]).toMatchObject({
      sourceServerId,
      lastConnectedAt: 100,
    });
    expect(settings.read().sourceServerWorkspaceHistory?.[0]).toMatchObject({
      sourceServerId,
      workspaceIdentity: `remote:server:${sourceServerId}:/workspace`,
      legacyWorkspaceIdentity: "remote:docker:zcode-dev:/workspace",
    });
  });

  it("uses the SSH config alias as a new device name without overwriting later user renames", async () => {
    const settings = createSettingService({
      connectionProfiles: [
        {
          profileId,
          transport: "ssh",
          target: {
            kind: "ssh",
            host: "10.0.0.4",
            port: 22,
            username: "dev",
            sshConfigAlias: " linux-arm64-dev ",
          },
          createdAt: 1,
        },
      ],
      sourceServerDirectoryMigrationVersion: 1,
    });
    const directory = new SourceServerDirectory({
      settingService: settings.service,
      credentialService: createCredentialService({}).service,
    });

    await directory.recordHandshake(profileId, {
      sourceServerId,
      hostname: "931b148d01e8",
      osUser: "dev",
      version: "3.8.0",
    });

    expect(settings.read().sourceServers?.[0]?.displayName).toBe("linux-arm64-dev");

    await directory.renameSource(sourceServerId, "Team build box");
    await directory.recordHandshake(profileId, {
      sourceServerId,
      hostname: "new-hostname",
      osUser: "dev",
      version: "3.8.1",
    });

    expect(settings.read().sourceServers?.[0]?.displayName).toBe("Team build box");
  });

  it("projects successful remote workspaces onto the device record and preserves them on failure", async () => {
    const settings = createSettingService({
      sourceServerDirectoryMigrationVersion: 1,
      connectionProfiles: [
        {
          profileId,
          transport: "docker",
          target: { kind: "docker", container: "zcode-dev" },
          createdAt: 1,
        },
      ],
    });
    const directory = new SourceServerDirectory({
      settingService: settings.service,
      credentialService: createCredentialService({}).service,
      now: () => 100,
    });

    await directory.recordHandshake(profileId, {
      sourceServerId,
      version: "3.8.0",
      workspaces: [
        { path: "/srv/a", label: "A" },
        { path: "/srv/b", workspaceIdentity: "invalid-identity" },
      ],
    });

    expect(settings.read().sourceServers?.[0]?.declaredWorkspaces).toEqual([
      {
        workspacePath: "/srv/a",
        workspaceIdentity: `remote:server:${sourceServerId}:/srv/a`,
        label: "A",
      },
      {
        workspacePath: "/srv/b",
        workspaceIdentity: `remote:server:${sourceServerId}:/srv/b`,
      },
    ]);

    await expect(
      directory.recordHandshake("missing-profile", {
        sourceServerId,
        version: "3.8.0",
        workspaces: [],
      }),
    ).rejects.toThrow();
    expect(settings.read().sourceServers?.[0]?.declaredWorkspaces).toHaveLength(2);
  });

  it("keeps identity-change pending free of writes, then atomically retires the old route", async () => {
    const passwordKey = `connection-profile:${profileId}:password`;
    const replacementPasswordKey = `connection-profile:${replacementProfileId}:password`;
    const settings = createSettingService({
      sourceServerDirectoryMigrationVersion: 1,
      connectionProfiles: [
        {
          profileId,
          transport: "ssh",
          target: {
            kind: "ssh",
            host: "example.com",
            username: "alice",
            passwordCredentialKey: passwordKey,
          },
          sourceServerId,
          createdAt: 1,
        },
      ],
      sourceServers: [
        {
          sourceServerId,
          displayName: "old install",
          preferredProfileId: profileId,
        },
      ],
      sourceServerWorkspaceHistory: [
        {
          workspacePath: "/workspace",
          workspaceIdentity: `remote:server:${sourceServerId}:/workspace`,
          profileId,
          sourceServerId,
          lastOpenedAt: 1,
        },
      ],
    });
    const credentials = createCredentialService({
      [passwordKey]: "saved-password",
    });
    const directory = new SourceServerDirectory({
      settingService: settings.service,
      credentialService: credentials.service,
      createProfileId: () => replacementProfileId,
      now: () => 100,
    });
    const before = structuredClone(settings.read());

    await expect(
      directory.recordHandshake(profileId, {
        sourceServerId: replacementSourceServerId,
        version: "3.8.0",
      }),
    ).resolves.toMatchObject({
      identityChanged: true,
      effectiveProfileId: profileId,
    });
    expect(settings.read()).toEqual(before);
    expect(credentials.read(replacementPasswordKey)).toBeUndefined();

    await expect(
      directory.recordHandshake(
        profileId,
        {
          sourceServerId: replacementSourceServerId,
          version: "3.8.0",
          connectedAt: 100,
        },
        { confirmIdentityChange: true },
      ),
    ).resolves.toMatchObject({
      identityChanged: true,
      effectiveProfileId: replacementProfileId,
    });

    expect(settings.read().connectionProfiles).toEqual([
      expect.objectContaining({
        profileId,
        lifecycleState: "retired",
        retiredReason: "source-reinstalled",
        retiredAt: 100,
      }),
      expect.objectContaining({
        profileId: replacementProfileId,
        sourceServerId: replacementSourceServerId,
        lifecycleState: "active",
        target: expect.objectContaining({
          passwordCredentialKey: replacementPasswordKey,
        }),
      }),
    ]);
    expect(settings.read().sourceServers).toEqual([
      expect.objectContaining({
        sourceServerId,
        installState: "uninstalled",
        preferredProfileId: undefined,
      }),
      expect.objectContaining({
        sourceServerId: replacementSourceServerId,
        installState: "installed",
        preferredProfileId: replacementProfileId,
      }),
    ]);
    expect(settings.read().sourceServerWorkspaceHistory).toEqual(
      before.sourceServerWorkspaceHistory,
    );
    expect(credentials.read(replacementPasswordKey)).toBe("saved-password");
  });

  it("deduplicates targets against active profiles only", async () => {
    const settings = createSettingService({
      sourceServerDirectoryMigrationVersion: 1,
      connectionProfiles: [
        {
          profileId,
          transport: "docker",
          target: { kind: "docker", container: "demo" },
          lifecycleState: "retired",
          retiredReason: "source-reinstalled",
          retiredAt: 2,
          createdAt: 1,
        },
        {
          profileId: replacementProfileId,
          transport: "docker",
          target: { kind: "docker", container: "demo" },
          lifecycleState: "active",
          createdAt: 2,
        },
      ],
    });
    const directory = new SourceServerDirectory({
      settingService: settings.service,
      credentialService: createCredentialService({}).service,
    });

    await expect(
      directory.ensureProfile({ kind: "docker", container: "demo" }),
    ).resolves.toMatchObject({
      profileId: replacementProfileId,
      lifecycleState: "active",
    });
  });

  it("removes every local record for a device while preserving remote data", async () => {
    const passwordKey = `connection-profile:${profileId}:password`;
    const settings = createSettingService({
      sourceServerDirectoryMigrationVersion: 1,
      sourceServers: [
        {
          sourceServerId,
          displayName: "devbox",
          declaredWorkspaces: [
            {
              workspacePath: "/srv/project",
              workspaceIdentity: `remote:server:${sourceServerId}:/srv/project`,
            },
          ],
        },
      ],
      connectionProfiles: [
        {
          profileId,
          sourceServerId,
          transport: "ssh",
          target: {
            kind: "ssh",
            host: "example.com",
            username: "alice",
            passwordCredentialKey: passwordKey,
          },
          createdAt: 1,
        },
      ],
      sourceServerWorkspaceHistory: [
        {
          workspacePath: "/srv/project",
          workspaceIdentity: `remote:server:${sourceServerId}:/srv/project`,
          sourceServerId,
          profileId,
          lastOpenedAt: 1,
        },
        {
          workspacePath: "/local/other",
          workspaceIdentity: "local:other",
          profileId: replacementProfileId,
          lastOpenedAt: 2,
        },
      ],
    });
    const credentials = createCredentialService({ [passwordKey]: "saved" });
    const directory = new SourceServerDirectory({
      settingService: settings.service,
      credentialService: credentials.service,
    });

    await directory.removeSourceServer(sourceServerId);

    expect(settings.read().sourceServers).toEqual([]);
    expect(settings.read().connectionProfiles).toEqual([]);
    expect(settings.read().sourceServerWorkspaceHistory).toEqual([
      expect.objectContaining({ profileId: replacementProfileId }),
    ]);
    expect(credentials.read(passwordKey)).toBeUndefined();
  });

  it("rolls back replacement credentials when the identity transaction cannot persist", async () => {
    const passwordKey = `connection-profile:${profileId}:password`;
    const replacementPasswordKey = `connection-profile:${replacementProfileId}:password`;
    const settings = createSettingService({
      sourceServerDirectoryMigrationVersion: 1,
      connectionProfiles: [
        {
          profileId,
          transport: "ssh",
          target: {
            kind: "ssh",
            host: "example.com",
            username: "alice",
            passwordCredentialKey: passwordKey,
          },
          sourceServerId,
          createdAt: 1,
        },
      ],
      sourceServers: [{ sourceServerId, displayName: "old", preferredProfileId: profileId }],
    });
    const credentials = createCredentialService({
      [passwordKey]: "saved-password",
    });
    vi.mocked(settings.service.update).mockRejectedValueOnce(new Error("settings write failed"));
    const directory = new SourceServerDirectory({
      settingService: settings.service,
      credentialService: credentials.service,
      createProfileId: () => replacementProfileId,
      now: () => 100,
    });
    const before = structuredClone(settings.read());

    await expect(
      directory.recordHandshake(
        profileId,
        { sourceServerId: replacementSourceServerId, version: "3.8.0" },
        { confirmIdentityChange: true },
      ),
    ).rejects.toThrow("settings write failed");
    expect(settings.read()).toEqual(before);
    expect(credentials.read(replacementPasswordKey)).toBeUndefined();
    expect(credentials.read(passwordKey)).toBe("saved-password");
  });

  it("prefers the preserved legacy workspace identity over the current route fallback", async () => {
    const settings = createSettingService({
      sourceServerDirectoryMigrationVersion: 1,
      sourceServerWorkspaceHistory: [
        {
          workspacePath: "/workspace",
          workspaceIdentity: `remote:server:${sourceServerId}:/workspace`,
          legacyWorkspaceIdentity: "remote:ssh:old.example.com:22:alice:/workspace",
          profileId,
          sourceServerId,
          lastOpenedAt: 1,
        },
      ],
    });
    const directory = new SourceServerDirectory({
      settingService: settings.service,
      credentialService: createCredentialService({}).service,
    });

    await expect(
      directory.resolveLegacyWorkspaceIdentity({
        profileId,
        workspacePath: "/workspace",
        fallback: "remote:ssh:new.example.com:22:alice:/workspace",
      }),
    ).resolves.toBe("remote:ssh:old.example.com:22:alice:/workspace");
    await expect(
      directory.resolveLegacyWorkspaceIdentity({
        profileId,
        workspacePath: "/new-workspace",
        fallback: "remote:ssh:new.example.com:22:alice:/new-workspace",
      }),
    ).resolves.toBe("remote:ssh:new.example.com:22:alice:/new-workspace");
  });

  it("preserves the frozen legacy identity when recording a stable workspace open", async () => {
    const legacyWorkspaceIdentity = "remote:ssh:old.example.com:22:alice:/workspace";
    const stableWorkspaceIdentity = `remote:server:${sourceServerId}:/workspace`;
    const settings = createSettingService({
      sourceServerDirectoryMigrationVersion: 1,
      sourceServerWorkspaceHistory: [
        {
          workspacePath: "/workspace",
          workspaceIdentity: stableWorkspaceIdentity,
          legacyWorkspaceIdentity,
          profileId,
          sourceServerId,
          lastOpenedAt: 1,
        },
      ],
    });
    const directory = new SourceServerDirectory({
      settingService: settings.service,
      credentialService: createCredentialService({}).service,
      now: () => 2,
    });

    await directory.recordWorkspaceOpen({
      profileId,
      sourceServerId,
      workspacePath: "/workspace",
      workspaceIdentity: stableWorkspaceIdentity,
    });

    expect(settings.read().sourceServerWorkspaceHistory).toEqual([
      {
        workspacePath: "/workspace",
        workspaceIdentity: stableWorkspaceIdentity,
        legacyWorkspaceIdentity,
        profileId,
        sourceServerId,
        lastOpenedAt: 2,
      },
    ]);
  });

  it("does not persist workspace history after a bind request is canceled", async () => {
    const settings = createSettingService({
      sourceServerDirectoryMigrationVersion: 1,
    });
    const directory = new SourceServerDirectory({
      settingService: settings.service,
      credentialService: createCredentialService({}).service,
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      directory.recordWorkspaceOpen({
        profileId,
        sourceServerId,
        workspacePath: "/workspace",
        workspaceIdentity: `remote:server:${sourceServerId}:/workspace`,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(settings.read().sourceServerWorkspaceHistory).toEqual([]);
  });

  it("returns saved default Profiles regardless of last online age, while requiring silent credentials", async () => {
    const settings = createSettingService({
      connectionProfiles: [
        {
          profileId,
          transport: "ssh",
          target: {
            kind: "ssh",
            host: "example.com",
            port: 22,
            username: "alice",
            passwordCredentialKey: `connection-profile:${profileId}:password`,
          },
          sourceServerId,
          lastConnectedAt: 90,
          createdAt: 1,
        },
      ],
      sourceServers: [
        {
          sourceServerId,
          displayName: "devbox · alice",
          lastOnlineAt: 90,
          preferredProfileId: profileId,
        },
      ],
      sourceServerDirectoryMigrationVersion: 1,
    });
    const credentials = createCredentialService({
      [`connection-profile:${profileId}:password`]: "saved-password",
    });
    const directory = new SourceServerDirectory({
      settingService: settings.service,
      credentialService: credentials.service,
    });

    await expect(directory.listStartupReconnectCandidates()).resolves.toEqual([
      {
        profile: settings.read().connectionProfiles?.[0],
        target: {
          kind: "ssh",
          host: "example.com",
          port: 22,
          username: "alice",
          password: "saved-password",
        },
      },
    ]);
    await expect(
      new SourceServerDirectory({
        settingService: settings.service,
        credentialService: createCredentialService({}).service,
      }).listStartupReconnectCandidates(),
    ).resolves.toEqual([]);
  });

  it("prioritizes the most recently online Sources for bounded startup reconnect workers", async () => {
    const olderProfileId = "4f0f4d21-2798-4608-9d44-889f9f3dc777";
    const olderSourceServerId = "70d16aa4-4404-41f1-99c4-1fe475e21fea";
    const settings = createSettingService({
      connectionProfiles: [
        {
          profileId: olderProfileId,
          transport: "docker",
          target: { kind: "docker", container: "older-source" },
          sourceServerId: olderSourceServerId,
          lastConnectedAt: 10,
          createdAt: 1,
        },
        {
          profileId,
          transport: "docker",
          target: { kind: "docker", container: "recent-source" },
          sourceServerId,
          lastConnectedAt: 90,
          createdAt: 2,
        },
      ],
      sourceServers: [
        {
          sourceServerId: olderSourceServerId,
          displayName: "older-source · root",
          lastOnlineAt: 10,
          preferredProfileId: olderProfileId,
        },
        {
          sourceServerId,
          displayName: "recent-source · root",
          lastOnlineAt: 90,
          preferredProfileId: profileId,
        },
      ],
      sourceServerDirectoryMigrationVersion: 1,
    });
    const directory = new SourceServerDirectory({
      settingService: settings.service,
      credentialService: createCredentialService({}).service,
    });

    await expect(directory.listStartupReconnectCandidates()).resolves.toEqual([
      {
        profile: settings.read().connectionProfiles?.[1],
        target: { kind: "docker", container: "recent-source" },
      },
      {
        profile: settings.read().connectionProfiles?.[0],
        target: { kind: "docker", container: "older-source" },
      },
    ]);
  });

  it("owns Source rename, preferred Profile, target resolution and Profile removal atomically", async () => {
    const secondProfileId = "4f0f4d21-2798-4608-9d44-889f9f3dc777";
    const passwordKey = `connection-profile:${profileId}:password`;
    const settings = createSettingService({
      sourceServerDirectoryMigrationVersion: 1,
      connectionProfiles: [
        {
          profileId,
          transport: "ssh",
          target: {
            kind: "ssh",
            host: "example.com",
            username: "alice",
            passwordCredentialKey: passwordKey,
          },
          sourceServerId,
          createdAt: 1,
        },
        {
          profileId: secondProfileId,
          transport: "docker",
          target: { kind: "docker", container: "dev" },
          sourceServerId,
          createdAt: 2,
        },
      ],
      sourceServers: [
        {
          sourceServerId,
          displayName: "old name",
          preferredProfileId: profileId,
        },
      ],
      sourceServerWorkspaceHistory: [
        {
          workspacePath: "/workspace",
          profileId,
          sourceServerId,
          lastOpenedAt: 1,
        },
      ],
    });
    const credentials = createCredentialService({
      [passwordKey]: "saved-password",
    });
    const directory = new SourceServerDirectory({
      settingService: settings.service,
      credentialService: credentials.service,
    });

    await directory.renameSource(sourceServerId, "  renamed  ");
    await directory.setPreferredProfile(sourceServerId, secondProfileId);
    await expect(directory.resolveProfileTarget(profileId)).resolves.toMatchObject({
      kind: "ssh",
      host: "example.com",
      username: "alice",
      password: "saved-password",
    });
    await directory.removeProfile(profileId);

    expect(settings.read().sourceServers).toEqual([
      {
        sourceServerId,
        displayName: "renamed",
        installState: "installed",
        preferredProfileId: secondProfileId,
        declaredWorkspaces: [],
      },
    ]);
    expect(settings.read().connectionProfiles?.map((item) => item.profileId)).toEqual([
      secondProfileId,
    ]);
    expect(settings.read().sourceServerWorkspaceHistory).toEqual([]);
    expect(credentials.read(passwordKey)).toBeUndefined();
  });

  it("uses complete stored password auth when a legacy passphrase ref has no private key path", async () => {
    const passwordKey = `connection-profile:${profileId}:password`;
    const stalePassphraseKey = `connection-profile:${profileId}:private-key-passphrase`;
    const settings = createSettingService({
      sourceServerDirectoryMigrationVersion: 1,
      connectionProfiles: [
        {
          profileId,
          transport: "ssh",
          target: {
            kind: "ssh",
            host: "example.com",
            username: "alice",
            passwordCredentialKey: passwordKey,
            privateKeyPassphraseCredentialKey: stalePassphraseKey,
          },
          sourceServerId,
          createdAt: 1,
        },
      ],
    });
    const directory = new SourceServerDirectory({
      settingService: settings.service,
      credentialService: createCredentialService({
        [passwordKey]: "saved-password",
      }).service,
    });

    await expect(directory.resolveProfileTarget(profileId)).resolves.toEqual({
      kind: "ssh",
      host: "example.com",
      username: "alice",
      password: "saved-password",
    });
  });

  it("omits an incomplete encrypted private key when stored password auth is complete", async () => {
    const passwordKey = `connection-profile:${profileId}:password`;
    const missingPassphraseKey = `connection-profile:${profileId}:private-key-passphrase`;
    const settings = createSettingService({
      sourceServerDirectoryMigrationVersion: 1,
      connectionProfiles: [
        {
          profileId,
          transport: "ssh",
          target: {
            kind: "ssh",
            host: "example.com",
            username: "alice",
            privateKeyPath: "/home/alice/.ssh/id_ed25519",
            passwordCredentialKey: passwordKey,
            privateKeyPassphraseCredentialKey: missingPassphraseKey,
          },
          sourceServerId,
          createdAt: 1,
        },
      ],
    });
    const directory = new SourceServerDirectory({
      settingService: settings.service,
      credentialService: createCredentialService({
        [passwordKey]: "saved-password",
      }).service,
    });

    await expect(directory.resolveProfileTarget(profileId)).resolves.toEqual({
      kind: "ssh",
      host: "example.com",
      username: "alice",
      password: "saved-password",
    });
  });

  it("still requires interaction when an encrypted private key is the only auth method and its passphrase is missing", async () => {
    const missingPassphraseKey = `connection-profile:${profileId}:private-key-passphrase`;
    const settings = createSettingService({
      sourceServerDirectoryMigrationVersion: 1,
      connectionProfiles: [
        {
          profileId,
          transport: "ssh",
          target: {
            kind: "ssh",
            host: "example.com",
            username: "alice",
            privateKeyPath: "/home/alice/.ssh/id_ed25519",
            privateKeyPassphraseCredentialKey: missingPassphraseKey,
          },
          sourceServerId,
          createdAt: 1,
        },
      ],
    });
    const directory = new SourceServerDirectory({
      settingService: settings.service,
      credentialService: createCredentialService({}).service,
    });

    await expect(directory.resolveProfileTarget(profileId)).rejects.toThrow(
      "Connection Profile requires interactive credentials",
    );
    await expect(directory.resolveProfileTarget(profileId)).rejects.toMatchObject({
      code: "credentials-required",
    });
  });

  it("uses complete private key auth when a stale password ref has no value", async () => {
    const stalePasswordKey = `connection-profile:${profileId}:password`;
    const settings = createSettingService({
      sourceServerDirectoryMigrationVersion: 1,
      connectionProfiles: [
        {
          profileId,
          transport: "ssh",
          target: {
            kind: "ssh",
            host: "example.com",
            username: "alice",
            privateKeyPath: "/home/alice/.ssh/id_ed25519",
            passwordCredentialKey: stalePasswordKey,
          },
          sourceServerId,
          createdAt: 1,
        },
      ],
    });
    const directory = new SourceServerDirectory({
      settingService: settings.service,
      credentialService: createCredentialService({}).service,
    });

    await expect(directory.resolveProfileTarget(profileId)).resolves.toEqual({
      kind: "ssh",
      host: "example.com",
      username: "alice",
      privateKeyPath: "/home/alice/.ssh/id_ed25519",
    });
  });

  it("keeps valid canonical identities, merges same-path duplicates and truncates at 20 entries", async () => {
    const settings = createSettingService({
      sourceServerDirectoryMigrationVersion: 1,
      connectionProfiles: [
        {
          profileId,
          transport: "docker",
          target: { kind: "docker", container: "zcode-dev" },
          createdAt: 1,
        },
      ],
    });
    const logDebug = vi.fn();
    const directory = new SourceServerDirectory({
      settingService: settings.service,
      credentialService: createCredentialService({}).service,
      logDebug,
    });

    const canonicalA = `remote:server:${sourceServerId}:/srv/a`;
    await directory.recordHandshake(profileId, {
      sourceServerId,
      version: "3.8.0",
      workspaces: [
        // 场景①：远端返回合法设备级 identity，canonical 化后原样保留。
        { path: "/srv/a", workspaceIdentity: canonicalA },
        // 场景④前半：同设备同路径携带线路级 identity，覆盖为 canonical 后与上一条合并。
        {
          path: "/srv/a",
          workspaceIdentity: "remote:ssh:example.com:22:alice:/srv/a",
        },
        // 场景⑧：合并后仍超过 20 条的部分被截断。
        ...Array.from({ length: 21 }, (_, index) => ({
          path: `/srv/bulk-${index}`,
        })),
      ],
    });

    const declared = settings.read().sourceServers?.[0]?.declaredWorkspaces;
    expect(declared).toHaveLength(20);
    expect(declared?.[0]).toEqual({
      workspacePath: "/srv/a",
      workspaceIdentity: canonicalA,
    });
    expect(new Set(declared?.map((entry) => entry.workspaceIdentity)).size).toBe(20);
    // 合同 §8.1.1：identity 被 canonical 覆盖只记 debug 日志、不失败。
    expect(logDebug).toHaveBeenCalledWith(
      expect.stringContaining("remote:ssh:example.com:22:alice:/srv/a"),
    );
  });

  it("keeps same-path workspaces on different devices independent", async () => {
    const settings = createSettingService({
      sourceServerDirectoryMigrationVersion: 1,
      connectionProfiles: [
        {
          profileId,
          sourceServerId,
          transport: "docker",
          target: { kind: "docker", container: "device-a" },
          createdAt: 1,
        },
        {
          profileId: replacementProfileId,
          sourceServerId: replacementSourceServerId,
          transport: "docker",
          target: { kind: "docker", container: "device-b" },
          createdAt: 1,
        },
      ],
    });
    const directory = new SourceServerDirectory({
      settingService: settings.service,
      credentialService: createCredentialService({}).service,
    });

    await directory.recordHandshake(profileId, {
      sourceServerId,
      version: "3.8.0",
      workspaces: [{ path: "/srv/shared" }],
    });
    await directory.recordHandshake(replacementProfileId, {
      sourceServerId: replacementSourceServerId,
      version: "3.8.0",
      workspaces: [{ path: "/srv/shared" }],
    });

    // 场景④后半：workspaceKey 含 serverId，跨设备同路径互不合并、各自独立保存。
    const servers = settings.read().sourceServers ?? [];
    expect(
      servers.find((server) => server.sourceServerId === sourceServerId)?.declaredWorkspaces,
    ).toEqual([
      {
        workspacePath: "/srv/shared",
        workspaceIdentity: `remote:server:${sourceServerId}:/srv/shared`,
      },
    ]);
    expect(
      servers.find((server) => server.sourceServerId === replacementSourceServerId)
        ?.declaredWorkspaces,
    ).toEqual([
      {
        workspacePath: "/srv/shared",
        workspaceIdentity: `remote:server:${replacementSourceServerId}:/srv/shared`,
      },
    ]);
  });

  it("clears declared workspaces on a successful empty handshake", async () => {
    const settings = createSettingService({
      sourceServerDirectoryMigrationVersion: 1,
      connectionProfiles: [
        {
          profileId,
          sourceServerId,
          transport: "docker",
          target: { kind: "docker", container: "zcode-dev" },
          createdAt: 1,
        },
      ],
      sourceServers: [
        {
          sourceServerId,
          displayName: "devbox",
          declaredWorkspaces: [
            {
              workspacePath: "/srv/a",
              workspaceIdentity: `remote:server:${sourceServerId}:/srv/a`,
            },
          ],
        },
      ],
    });
    const directory = new SourceServerDirectory({
      settingService: settings.service,
      credentialService: createCredentialService({}).service,
    });

    // 场景⑤：成功握手返回空数组时整体替换为清空，而非保留旧值。
    await directory.recordHandshake(profileId, {
      sourceServerId,
      version: "3.8.1",
      workspaces: [],
    });
    expect(settings.read().sourceServers?.[0]?.declaredWorkspaces).toEqual([]);
  });

  it("starts the replacement device from empty declared workspaces after an identity change", async () => {
    const legacyWorkspace = {
      workspacePath: "/srv/legacy",
      workspaceIdentity: `remote:server:${sourceServerId}:/srv/legacy`,
    };
    const settings = createSettingService({
      sourceServerDirectoryMigrationVersion: 1,
      connectionProfiles: [
        {
          profileId,
          sourceServerId,
          transport: "docker",
          target: { kind: "docker", container: "zcode-dev" },
          createdAt: 1,
        },
      ],
      sourceServers: [
        {
          sourceServerId,
          displayName: "old-device",
          declaredWorkspaces: [legacyWorkspace],
        },
      ],
    });
    const directory = new SourceServerDirectory({
      settingService: settings.service,
      credentialService: createCredentialService({}).service,
    });

    // 场景⑦：身份换代 = 新设备记录，declaredWorkspaces 从本次握手投影、不继承旧设备。
    await directory.recordHandshake(
      profileId,
      {
        sourceServerId: replacementSourceServerId,
        version: "3.9.0",
        workspaces: [],
      },
      { confirmIdentityChange: true },
    );

    const servers = settings.read().sourceServers ?? [];
    expect(
      servers.find((server) => server.sourceServerId === replacementSourceServerId)
        ?.declaredWorkspaces,
    ).toEqual([]);
    expect(
      servers.find((server) => server.sourceServerId === sourceServerId)?.declaredWorkspaces,
    ).toEqual([legacyWorkspace]);
  });

  it("removes orphan history entries written before identification", async () => {
    const settings = createSettingService({
      sourceServerDirectoryMigrationVersion: 1,
      connectionProfiles: [
        {
          profileId,
          sourceServerId,
          transport: "docker",
          target: { kind: "docker", container: "zcode-dev" },
          createdAt: 1,
        },
        {
          profileId: replacementProfileId,
          transport: "docker",
          target: { kind: "docker", container: "other" },
          createdAt: 1,
        },
      ],
      sourceServerWorkspaceHistory: [
        // Bug 场景：识别前写入的条目没有 sourceServerId，只能通过被删 Profile 关联。
        {
          workspacePath: "/srv/orphan",
          profileId,
          lastOpenedAt: 1,
        },
        {
          workspacePath: "/srv/kept",
          profileId: replacementProfileId,
          lastOpenedAt: 2,
        },
      ],
    });
    const directory = new SourceServerDirectory({
      settingService: settings.service,
      credentialService: createCredentialService({}).service,
    });

    await directory.removeSourceServer(sourceServerId);

    expect(settings.read().sourceServerWorkspaceHistory).toEqual([
      expect.objectContaining({ workspacePath: "/srv/kept" }),
    ]);
  });

  it("keeps device records and restores credentials when removal persistence fails", async () => {
    const passwordKey = `connection-profile:${profileId}:password`;
    const initial = {
      sourceServerDirectoryMigrationVersion: 1 as const,
      sourceServers: [{ sourceServerId, displayName: "devbox" }],
      connectionProfiles: [
        {
          profileId,
          sourceServerId,
          transport: "ssh" as const,
          target: {
            kind: "ssh" as const,
            host: "example.com",
            username: "alice",
            passwordCredentialKey: passwordKey,
          },
          createdAt: 1,
        },
      ],
      sourceServerWorkspaceHistory: [
        {
          workspacePath: "/srv/project",
          profileId,
          sourceServerId,
          lastOpenedAt: 1,
        },
      ],
    };
    const settings = createSettingService(initial);
    const credentials = createCredentialService({ [passwordKey]: "saved" });
    const directory = new SourceServerDirectory({
      settingService: settings.service,
      credentialService: credentials.service,
    });
    vi.mocked(settings.service.update).mockRejectedValueOnce(new Error("disk full"));

    // 合同 §8.1.3：持久化失败进入「设备保留、连接已断开」恢复态，凭据按备份回滚。
    await expect(directory.removeSourceServer(sourceServerId)).rejects.toThrow("disk full");
    expect(settings.read().sourceServers).toHaveLength(1);
    expect(settings.read().connectionProfiles).toHaveLength(1);
    expect(settings.read().sourceServerWorkspaceHistory).toHaveLength(1);
    expect(credentials.read(passwordKey)).toBe("saved");
  });

  it("treats removing an unknown device as a successful no-op without firing change events", async () => {
    const settings = createSettingService({
      sourceServerDirectoryMigrationVersion: 1,
      sourceServers: [{ sourceServerId, displayName: "devbox" }],
    });
    const directory = new SourceServerDirectory({
      settingService: settings.service,
      credentialService: createCredentialService({}).service,
    });
    let changeCount = 0;
    directory.onDidChange(() => {
      changeCount += 1;
    });

    await expect(directory.removeSourceServer(replacementSourceServerId)).resolves.toBeUndefined();
    expect(settings.read().sourceServers).toHaveLength(1);
    // 幂等空操作没有持久化写入，不得驱动消费方权威重读。
    expect(changeCount).toBe(0);
  });

  it("fires onDidChange only after an actual persisted write", async () => {
    const settings = createSettingService({
      sourceServerDirectoryMigrationVersion: 1,
      connectionProfiles: [
        {
          profileId,
          sourceServerId,
          transport: "docker",
          target: { kind: "docker", container: "zcode-dev" },
          createdAt: 1,
        },
      ],
    });
    const directory = new SourceServerDirectory({
      settingService: settings.service,
      credentialService: createCredentialService({}).service,
    });
    let changeCount = 0;
    directory.onDidChange(() => {
      changeCount += 1;
    });

    // 已迁移短路：initialize 无写入，不 fire。
    await directory.initialize();
    expect(changeCount).toBe(0);

    // identity-pending 零写入分支：不 fire。
    await directory.recordHandshake(profileId, {
      sourceServerId: replacementSourceServerId,
      version: "3.9.0",
    });
    expect(changeCount).toBe(0);

    // 目标不存在的 no-op：不 fire。
    await directory.removeProfile(replacementProfileId);
    await directory.markSourceUninstalled(replacementProfileId);
    expect(changeCount).toBe(0);

    // 真实写入：每次持久化成功 fire 一次。
    await directory.recordWorkspaceOpen({
      profileId,
      sourceServerId,
      workspacePath: "/srv/project",
      workspaceIdentity: `remote:server:${sourceServerId}:/srv/project`,
    });
    expect(changeCount).toBe(1);
  });
});
