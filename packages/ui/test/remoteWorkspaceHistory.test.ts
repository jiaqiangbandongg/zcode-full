import { describe, expect, it } from "vitest";
import type { RemoteTarget } from "@zcode/shared";
import {
  buildRemoteWorkspaceIdentity,
  buildRemoteWorkspaceSessionMutation,
  buildPersistedWorkspaceSessionEntries,
  buildRemoteWorkspaceSessionEntryMap,
  createRemoteTargetFromSnapshot,
  createRemoteTargetSnapshot,
  findMatchingRemoteWorkspaceSessionEntry,
  formatRemoteWorkspaceDisplayLabel,
  formatRemoteWorkspaceHeaderHostLabel,
  formatRemoteWorkspaceTargetSubtitle,
  hasRemoteWorkspaceIdentity,
  readPersistedWorkspaceSessionEntries,
  removeRemoteWorkspaceSessionEntries,
  upsertRemoteWorkspaceSessionEntries,
} from "@/lib/remoteWorkspaceHistory.js";

describe("remoteWorkspaceHistory helpers", () => {
  it("reads combined session snapshots directly", () => {
    expect(
      readPersistedWorkspaceSessionEntries({
        lastWorkspaceSession: [
          {
            kind: "local",
            workspacePath: "/tmp/local-a",
          },
          {
            kind: "remote",
            workspacePath: "/workspace/demo",
            target: {
              kind: "docker",
              container: "demo",
            },
            lastOpenedAt: 1,
            lastConnectionStatus: "failed",
          },
        ],
      }),
    ).toHaveLength(2);
  });

  it("serializes local and remote tabs into a combined session snapshot", () => {
    const remoteEntryMap = buildRemoteWorkspaceSessionEntryMap([
      {
        kind: "remote",
        workspacePath: "/workspace/demo",
        workspaceIdentity: "remote:docker:demo:/workspace/demo",
        target: {
          kind: "docker",
          container: "demo",
        },
        lastOpenedAt: 1,
        lastConnectionStatus: "failed",
      },
    ]);

    expect(
      buildPersistedWorkspaceSessionEntries(
        [
          {
            id: "local-1",
            kind: "workspace",
            workspacePath: "/tmp/local-a",
            label: "local-a",
            workspacePurpose: "conversation",
          },
          {
            id: "remote-1",
            kind: "workspace",
            workspacePath: "/workspace/demo",
            label: "demo",
            remoteTarget: {
              kind: "docker",
              container: "demo",
            },
            workspaceIdentity: "remote:docker:demo:/workspace/demo",
          },
        ],
        remoteEntryMap,
      ),
    ).toEqual([
      {
        kind: "local",
        workspacePath: "/tmp/local-a",
        workspacePurpose: "conversation",
      },
      {
        kind: "remote",
        workspacePath: "/workspace/demo",
        workspaceIdentity: "remote:docker:demo:/workspace/demo",
        target: {
          kind: "docker",
          container: "demo",
        },
        lastOpenedAt: 1,
        lastConnectionStatus: "failed",
      },
    ]);
  });

  it("reuses the existing SSH password credential key when updating a remote session", () => {
    const snapshot = createRemoteTargetSnapshot(
      "remote:ssh:demo.internal:22:root:/workspace/demo",
      {
        kind: "ssh",
        host: "demo.internal",
        username: "root",
        password: "secret",
      },
      {
        kind: "ssh",
        host: "demo.internal",
        username: "root",
        passwordCredentialKey:
          "remote-workspace:remote:ssh:demo.internal:22:root:/workspace/demo:password",
      },
    );

    expect(snapshot).toMatchObject({
      kind: "ssh",
      passwordCredentialKey:
        "remote-workspace:remote:ssh:demo.internal:22:root:/workspace/demo:password",
    });
  });

  it("hydrates an SSH target from a persisted snapshot", () => {
    const target = createRemoteTargetFromSnapshot(
      {
        kind: "ssh",
        host: "demo.internal",
        port: 2222,
        username: "root",
        privateKeyPath: "~/.ssh/id_ed25519",
        passwordCredentialKey:
          "remote-workspace:remote:ssh:demo.internal:22:root:/workspace/demo:password",
        privateKeyPassphraseCredentialKey:
          "remote-workspace:remote:ssh:demo.internal:22:root:/workspace/demo:private-key-passphrase",
      },
      {
        password: "secret",
        privateKeyPassphrase: "key-secret",
      },
    );

    expect(target).toEqual({
      kind: "ssh",
      host: "demo.internal",
      port: 2222,
      username: "root",
      privateKeyPath: "~/.ssh/id_ed25519",
      password: "secret",
      privateKeyPassphrase: "key-secret",
    });
  });

  it("persists SSH asset install mode and drops historical resource packages", () => {
    const snapshot = createRemoteTargetSnapshot(
      "remote:ssh:demo.internal:22:root:/workspace/demo",
      {
        kind: "ssh",
        host: "demo.internal",
        username: "root",
        assetInstallMode: "remote-download",
        resourcePackages: {
          selectedPackageIds: ["server-bundle", "node-runtime", "glm"],
        },
      },
    );

    expect(snapshot).toMatchObject({
      kind: "ssh",
      assetInstallMode: "remote-download",
    });
    expect(snapshot).not.toHaveProperty("resourcePackages");

    expect(
      createRemoteTargetFromSnapshot(snapshot, {
        password: null,
        privateKeyPassphrase: null,
      }),
    ).toMatchObject({
      kind: "ssh",
      assetInstallMode: "remote-download",
    });
    expect(
      createRemoteTargetFromSnapshot(snapshot, {
        password: null,
        privateKeyPassphrase: null,
      }),
    ).not.toHaveProperty("resourcePackages");
  });

  it("persists and hydrates SSH config alias metadata", () => {
    const snapshot = createRemoteTargetSnapshot(
      "remote:ssh:localhost:2223:root:/root",
      {
        kind: "ssh",
        host: "localhost",
        port: 2223,
        username: "root",
        password: "secret",
        sshConfigAlias: "linux-arm64",
      },
    );

    expect(snapshot).toMatchObject({
      kind: "ssh",
      sshConfigAlias: "linux-arm64",
    });

    expect(
      createRemoteTargetFromSnapshot(snapshot, {
        password: "secret",
        privateKeyPassphrase: null,
      }),
    ).toMatchObject({
      kind: "ssh",
      sshConfigAlias: "linux-arm64",
    });
  });

  it("stores a separate credential key for SSH private key passphrase", () => {
    const snapshot = createRemoteTargetSnapshot(
      "remote:ssh:demo.internal:22:root:/workspace/demo",
      {
        kind: "ssh",
        host: "demo.internal",
        username: "root",
        privateKeyPath: "~/.ssh/id_ed25519",
        privateKeyPassphrase: "key-secret",
      },
      {
        kind: "ssh",
        host: "demo.internal",
        username: "root",
        privateKeyPath: "~/.ssh/id_ed25519",
        privateKeyPassphraseCredentialKey:
          "remote-workspace:remote:ssh:demo.internal:22:root:/workspace/demo:private-key-passphrase",
      },
    );

    expect(snapshot).toMatchObject({
      kind: "ssh",
      privateKeyPassphraseCredentialKey:
        "remote-workspace:remote:ssh:demo.internal:22:root:/workspace/demo:private-key-passphrase",
    });
  });

  it("matches an existing remote session by workspace path and target identity", () => {
    const target: RemoteTarget = {
      kind: "docker",
      container: "demo-container",
    };
    const sessions = [
      {
        kind: "remote" as const,
        workspacePath: "/workspace/demo",
        target: {
          kind: "docker" as const,
          container: "demo-container",
        },
        lastOpenedAt: 10,
        lastConnectionStatus: "connected" as const,
      },
    ];

    expect(
      findMatchingRemoteWorkspaceSessionEntry(
        sessions,
        "/workspace/demo",
        target,
      )?.workspacePath,
    ).toBe("/workspace/demo");
  });

  it("keeps the newest remote session at the top when upserting", () => {
    const updated = upsertRemoteWorkspaceSessionEntries(
      [
        {
          kind: "remote",
          workspacePath: "/workspace/older",
          target: {
            kind: "wsl",
            distro: "Ubuntu",
          },
          lastOpenedAt: 1,
          lastConnectionStatus: "connected",
        },
      ],
      {
        kind: "remote",
        workspacePath: "/workspace/newer",
        target: {
          kind: "docker",
          container: "demo",
        },
        lastOpenedAt: 2,
        lastConnectionStatus: "failed",
        lastConnectionError: "refused",
      },
    );

    expect(updated.map((entry) => entry.workspacePath)).toEqual([
      "/workspace/newer",
      "/workspace/older",
    ]);
  });

  it("formats a readable remote target subtitle", () => {
    expect(
      formatRemoteWorkspaceTargetSubtitle({
        kind: "wsl",
        distro: "Ubuntu-24.04",
      }),
    ).toBe("WSL · Ubuntu-24.04");

    expect(
      formatRemoteWorkspaceTargetSubtitle({
        kind: "wsl",
        distro: "Ubuntu-24.04",
        user: "root",
      }),
    ).toBe("WSL · Ubuntu-24.04 · root");
  });

  it("uses explicit WSL user in workspace identity and snapshot roundtrip", () => {
    const target: RemoteTarget = {
      kind: "wsl",
      distro: "Ubuntu-24.04",
      user: " root ",
    };
    const snapshot = createRemoteTargetSnapshot(
      "remote:wsl:Ubuntu-24.04:root:/workspace/demo",
      target,
    );

    expect(buildRemoteWorkspaceIdentity("/workspace/demo", target)).toBe(
      "remote:wsl:Ubuntu-24.04:root:/workspace/demo",
    );
    expect(snapshot).toEqual({
      kind: "wsl",
      distro: "Ubuntu-24.04",
      user: "root",
    });
    expect(
      createRemoteTargetFromSnapshot(snapshot, {
        password: null,
        privateKeyPassphrase: null,
      }),
    ).toEqual({
      kind: "wsl",
      distro: "Ubuntu-24.04",
      user: "root",
    });
    expect(formatRemoteWorkspaceHeaderHostLabel(snapshot)).toBe(
      "wsl:Ubuntu-24.04:root",
    );
  });

  it("persists and hydrates server remote target credentials", () => {
    const workspaceKey = "remote:server:studio-server-01:/srv/project";
    const target: RemoteTarget = {
      kind: "server",
      url: "https://studio.example.com/zcode/",
      name: "Studio Server",
      serverId: "Studio Server 01",
      workspacePath: "/srv/project",
      token: "server-secret",
    };
    const snapshot = createRemoteTargetSnapshot(workspaceKey, target);

    expect(buildRemoteWorkspaceIdentity("\\srv\\project\\", target)).toBe(workspaceKey);
    expect(snapshot).toEqual({
      kind: "server",
      url: "https://studio.example.com/zcode/",
      name: "Studio Server",
      serverId: "Studio Server 01",
      workspacePath: "/srv/project",
      tokenCredentialKey:
        "remote-workspace:remote:server:studio-server-01:/srv/project:server-token",
    });
    expect(
      createRemoteTargetFromSnapshot(snapshot, {
        password: null,
        privateKeyPassphrase: null,
        token: "server-secret",
      }),
    ).toEqual(target);
    expect(formatRemoteWorkspaceTargetSubtitle(snapshot)).toBe(
      "Server · Studio Server",
    );
    expect(formatRemoteWorkspaceHeaderHostLabel(snapshot)).toBe(
      "studio.example.com",
    );
  });

  it("keeps the legacy WSL identity when no user is specified", () => {
    expect(
      buildRemoteWorkspaceIdentity("/workspace/demo", {
        kind: "wsl",
        distro: "Ubuntu-24.04",
      }),
    ).toBe("remote:wsl:Ubuntu-24.04:/workspace/demo");
  });
  it("keeps omitted WSL user compatible with legacy history while separating root", () => {
    const sessions = [
      {
        kind: "remote" as const,
        workspacePath: "/workspace/demo",
        workspaceIdentity: "remote:wsl:Ubuntu-24.04:/workspace/demo",
        target: {
          kind: "wsl" as const,
          distro: "Ubuntu-24.04",
        },
        lastOpenedAt: 10,
        lastConnectionStatus: "connected" as const,
      },
    ];

    expect(
      findMatchingRemoteWorkspaceSessionEntry(sessions, "/workspace/demo", {
        kind: "wsl",
        distro: "Ubuntu-24.04",
        user: " ",
      })?.workspaceIdentity,
    ).toBe("remote:wsl:Ubuntu-24.04:/workspace/demo");
    expect(
      findMatchingRemoteWorkspaceSessionEntry(sessions, "/workspace/demo", {
        kind: "wsl",
        distro: "Ubuntu-24.04",
        user: "root",
      }),
    ).toBeNull();
  });

  it("formats a compact remote host label for workspace header", () => {
    expect(
      formatRemoteWorkspaceHeaderHostLabel({
        kind: "ssh",
        host: "10.0.0.8",
        port: 22,
        username: "dev",
      }),
    ).toBe("10.0.0.8");

    expect(
      formatRemoteWorkspaceHeaderHostLabel({
        kind: "ssh",
        host: "dev.internal",
        port: 2222,
        username: "dev",
      }),
    ).toBe("dev.internal:2222");
  });

  it("formats SSH alias as a workspace display suffix", () => {
    expect(
      formatRemoteWorkspaceDisplayLabel("root", {
        kind: "ssh",
        host: "localhost",
        port: 2223,
        username: "root",
        sshConfigAlias: " linux-arm64 ",
      }),
    ).toBe("root [SSH: linux-arm64]");

    expect(
      formatRemoteWorkspaceDisplayLabel("root", {
        kind: "ssh",
        host: "localhost",
        port: 2223,
        username: "root",
      }),
    ).toBe("root");
  });

  it("treats disconnected remote tabs as remote identities", () => {
    expect(
      hasRemoteWorkspaceIdentity({
        workspaceIdentity: "remote:docker:demo:/workspace/demo",
      }),
    ).toBe(true);
    expect(
      hasRemoteWorkspaceIdentity({
        workspacePath: "/tmp/demo",
      } as never),
    ).toBe(false);
  });

  it("keeps the previous SSH credential key when a reconnect failure is recorded", () => {
    const mutation = buildRemoteWorkspaceSessionMutation({
      remoteSessions: [
        {
          kind: "remote",
          workspacePath: "/workspace/demo",
          target: {
            kind: "ssh",
            host: "demo.internal",
            username: "root",
            passwordCredentialKey:
              "remote-workspace:remote:ssh:demo.internal:22:root:/workspace/demo:password",
          },
          lastOpenedAt: 10,
          lastConnectionStatus: "connected",
        },
      ],
      workspacePath: "/workspace/demo",
      target: {
        kind: "ssh",
        host: "demo.internal",
        username: "root",
      },
      lastConnectionStatus: "failed",
      lastConnectionError: "connection refused",
      touchOpenedAt: false,
    });

    expect(mutation.entry.target).toMatchObject({
      kind: "ssh",
      passwordCredentialKey:
        "remote-workspace:remote:ssh:demo.internal:22:root:/workspace/demo:password",
    });
    expect(mutation.credentialKeysToDelete).toEqual([]);
  });

  it("stores the local workspace path used for remote MCP path rewriting", () => {
    const mutation = buildRemoteWorkspaceSessionMutation({
      remoteSessions: [],
      workspacePath: "/srv/project",
      workspaceIdentity: "remote:ssh:dev.example.com:22:alice:/srv/project",
      target: {
        kind: "ssh",
        host: "dev.example.com",
        username: "alice",
      },
      lastConnectionStatus: "connected",
      touchOpenedAt: true,
      localWorkspacePath: "/Users/alice/project",
    } as Parameters<typeof buildRemoteWorkspaceSessionMutation>[0] & {
      localWorkspacePath: string;
    });

    expect(
      (mutation.entry as { localWorkspacePath?: string }).localWorkspacePath,
    ).toBe("/Users/alice/project");
  });

  it("removes remote workspace history entries and returns their SSH credential keys", () => {
    const result = removeRemoteWorkspaceSessionEntries(
      [
        {
          kind: "remote",
          workspacePath: "/workspace/demo",
          workspaceIdentity: "remote:ssh:demo.internal:22:root:/workspace/demo",
          target: {
            kind: "ssh",
            host: "demo.internal",
            username: "root",
            passwordCredentialKey:
              "remote-workspace:remote:ssh:demo.internal:22:root:/workspace/demo:password",
            privateKeyPassphraseCredentialKey:
              "remote-workspace:remote:ssh:demo.internal:22:root:/workspace/demo:private-key-passphrase",
          },
          lastOpenedAt: 10,
          lastConnectionStatus: "connected",
        },
        {
          kind: "remote",
          workspacePath: "/workspace/other",
          workspaceIdentity: "remote:docker:demo:/workspace/other",
          target: {
            kind: "docker",
            container: "demo",
          },
          lastOpenedAt: 9,
          lastConnectionStatus: "failed",
        },
      ],
      ["remote:ssh:demo.internal:22:root:/workspace/demo"],
    );

    expect(result.nextRemoteSessions).toEqual([
      {
        kind: "remote",
        workspacePath: "/workspace/other",
        workspaceIdentity: "remote:docker:demo:/workspace/other",
        target: {
          kind: "docker",
          container: "demo",
        },
        lastOpenedAt: 9,
        lastConnectionStatus: "failed",
      },
    ]);
    expect(result.credentialKeysToDelete).toEqual([
      "remote-workspace:remote:ssh:demo.internal:22:root:/workspace/demo:password",
      "remote-workspace:remote:ssh:demo.internal:22:root:/workspace/demo:private-key-passphrase",
    ]);
  });
});
