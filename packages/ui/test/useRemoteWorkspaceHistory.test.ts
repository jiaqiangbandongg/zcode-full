import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { RemoteWorkspaceSessionEntry } from "@zcode/shared";
import { createTabStore, type WindowTabState } from "@/store/tabStore.js";
import {
  loadConnectionProfileCredentials,
  type ReconnectRemoteWorkspaceOptions,
} from "@/root/reconnectRemoteWorkspaceHistoryEntry.js";
import {
  bindRemoteWorkspaceContextAndGetSession,
  cancelPendingRemoteReconnectsForWorkspaceKeys,
  collectStartupRemoteWorkspaceReconnectGroups,
  collectSshReconnectGroup,
  openRemoteWorkspaceFromHistoryEntry,
  openRemoteConversationWorkspace,
  reconnectRemoteWorkspaceByKey,
  reconnectRemoteWorkspaceHistoryEntry,
  reconnectRemoteWorkspaceGroup,
  resolveRemoteWorkspaceClosedFallback,
  resolveSourceRemoteConversationWorkspaceProjection,
  restoreSourceRemoteWorkspaceGroup,
  shouldAttemptStartupReconnectForSourceState,
  shouldAttemptStartupReconnectForTabChange,
  shouldPersistRemoteWorkspaceFailure,
  selectRemoteWorkspaceProjectFromDialog,
  updateStartupRemoteWorkspaceReconnectAttemptsForSourceState,
  updateRemoteWorkspaceRecoveringKeys,
} from "@/root/useRemoteWorkspaceHistory.js";
import {
  clearRemoteWorkspaceConnectionState,
  getRemoteWorkspaceConnectionState,
  registerRemoteWorkspaceSession,
  setRemoteWorkspaceConnectionState,
  unregisterRemoteWorkspaceSession,
} from "@/store/remoteWorkspaceSessionStore.js";
import {
  buildRemoteWorkspaceIdentity,
  buildWorkspaceSessionKey,
} from "@/lib/remoteWorkspaceHistory.js";

function createRemoteWorkspaceSessionEntry(
  overrides: Partial<RemoteWorkspaceSessionEntry> = {},
): RemoteWorkspaceSessionEntry {
  return {
    kind: "remote",
    workspacePath: "/workspace/demo",
    workspaceIdentity: "remote:docker:demo:/workspace/demo",
    target: {
      kind: "docker",
      container: "demo",
    },
    lastOpenedAt: 10,
    lastConnectionStatus: "failed",
    ...overrides,
  };
}

function createWorkspaceTab(
  overrides: {
    id?: string;
    workspacePath?: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
  } = {},
): WindowTabState {
  return {
    id: overrides.id ?? "tab-1",
    kind: "workspace",
    label: "demo",
    workspacePath: overrides.workspacePath ?? "/workspace/demo",
    workspaceIdentity: overrides.workspaceIdentity,
    remoteSessionId: overrides.remoteSessionId,
  };
}

function createBindRemoteWorkspaceScopeMock(
  fallbackWorkspaceIdentity = "remote:docker:demo:/workspace/demo",
) {
  return vi.fn(async (_sessionId: string, workspacePath: string, workspaceIdentity?: string) => ({
    workspacePath,
    workspaceIdentity: workspaceIdentity ?? fallbackWorkspaceIdentity,
  }));
}

describe("bindRemoteWorkspaceContextAndGetSession", () => {
  it("bind 完成后重新读取同一 session 的新 attachment services", async () => {
    const firstServices = { zcodeSessionService: { attachment: "A" } } as never;
    const secondServices = { zcodeSessionService: { attachment: "B" } } as never;
    registerRemoteWorkspaceSession({
      sessionId: "remote-session-1",
      services: firstServices,
    });
    const bindRemoteWorkspaceSessionContext = vi.fn(async () => {
      registerRemoteWorkspaceSession({
        sessionId: "remote-session-1",
        services: secondServices,
      });
      return {
        sourceServerId: "source-1",
        remoteSessionId: "remote-session-1",
        workspacePath: "/workspace/demo",
        workspaceIdentity: "remote:server:source-1:/workspace/demo",
        previousWorkspaceIdentity: "remote:ssh:dev.internal:22:developer:/workspace/demo",
      };
    });

    try {
      const session = await bindRemoteWorkspaceContextAndGetSession({
        platform: { bindRemoteWorkspaceSessionContext } as never,
        sessionId: "remote-session-1",
        workspacePath: "/workspace/demo",
        workspaceIdentity: "remote:ssh:dev.internal:22:developer:/workspace/demo",
      });

      expect(bindRemoteWorkspaceSessionContext).toHaveBeenCalledOnce();
      expect(session.services).toBe(secondServices);
      expect(session.services).not.toBe(firstServices);
      expect(session.previousWorkspaceIdentity).toBe(
        "remote:ssh:dev.internal:22:developer:/workspace/demo",
      );
    } finally {
      unregisterRemoteWorkspaceSession("remote-session-1");
    }
  });
});

function createOpenRemoteWorkspaceContext(options?: {
  sessionEntry?: RemoteWorkspaceSessionEntry;
  tabs?: WindowTabState[];
}) {
  const sessionEntry = options?.sessionEntry ?? createRemoteWorkspaceSessionEntry();
  const workspaceKey = buildWorkspaceSessionKey(sessionEntry);
  let tabs = options?.tabs ?? [];

  const tabStoreApi = {
    getState: () => ({
      tabs,
    }),
  };

  const activateTabByPath = vi.fn(() => false);
  const setReconnectingRemoteWorkspaceKeys = vi.fn((updater: (current: string[]) => string[]) =>
    updater([]),
  );
  const resetLogsForWorkspaceKey = vi.fn();
  const onWorkspaceActivated = vi.fn();
  const reconnectImpl = vi.fn(async () => undefined);
  const inflightReconnectWorkspaceKeys = new Set<string>();

  const params: Parameters<typeof openRemoteWorkspaceFromHistoryEntry>[0] = {
    workspaceKey,
    tabStoreApi,
    getRemoteSessions: () => [sessionEntry],
    inflightReconnectWorkspaceKeys,
    activateTabByPath,
    setReconnectingRemoteWorkspaceKeys,
    loadCredential: vi.fn(async () => null),
    connectRemoteWorkspaceTarget: vi.fn(async () => "session-1"),
    resolveRemoteWorkspaceCanonicalPath: vi.fn(async (_sessionId, workspacePath) => workspacePath),
    bindRemoteWorkspaceScope: createBindRemoteWorkspaceScopeMock(
      sessionEntry.workspaceIdentity ?? workspaceKey,
    ),
    disposeRemoteWorkspaceSession: vi.fn(async () => undefined),
    addTab: vi.fn(),
    commitRemoteWorkspaceSessionMutation: vi.fn(async (mutation) => mutation.entry),
    resetLogsForWorkspaceKey,
    onWorkspaceActivated,
    reconnectImpl,
  };

  return {
    params,
    sessionEntry,
    workspaceKey,
    activateTabByPath,
    resetLogsForWorkspaceKey,
    onWorkspaceActivated,
    reconnectImpl,
    inflightReconnectWorkspaceKeys,
    setTabs(nextTabs: WindowTabState[]) {
      tabs = nextTabs;
    },
  };
}

describe("shouldPersistRemoteWorkspaceFailure", () => {
  it("keeps non-WSL remote failures persisted immediately", () => {
    const sessionEntry = createRemoteWorkspaceSessionEntry();

    expect(
      shouldPersistRemoteWorkspaceFailure({
        pendingReconnectRequestIds: new Map([
          [buildWorkspaceSessionKey(sessionEntry), "request-1"],
        ]),
        sessionEntry,
        workspaceKey: buildWorkspaceSessionKey(sessionEntry),
      }),
    ).toBe(true);
  });

  it("delays WSL failure persistence while reconnect is pending", () => {
    const sessionEntry = createRemoteWorkspaceSessionEntry({
      workspaceIdentity: "remote:wsl:default:/workspace/demo",
      target: { kind: "wsl" },
    });
    const workspaceKey = buildWorkspaceSessionKey(sessionEntry);

    expect(
      shouldPersistRemoteWorkspaceFailure({
        pendingReconnectRequestIds: new Map([[workspaceKey, "request-1"]]),
        sessionEntry,
        workspaceKey,
      }),
    ).toBe(false);
  });
});

describe("updateRemoteWorkspaceRecoveringKeys", () => {
  it("tracks recoverable close and clears the same workspace after replacement", () => {
    const tab = createWorkspaceTab({
      workspaceIdentity: "remote:server:source-1:/workspace/demo",
      remoteSessionId: "remote-session-1",
    });

    const recovering = updateRemoteWorkspaceRecoveringKeys(["other"], [tab], true);
    expect(recovering).toEqual(["other", "remote:server:source-1:/workspace/demo"]);
    expect(updateRemoteWorkspaceRecoveringKeys(recovering, [tab], false)).toEqual(["other"]);
  });
});

describe("resolveRemoteWorkspaceClosedFallback", () => {
  it("uses the localized exhausted-budget message instead of a Host error string", () => {
    expect(
      resolveRemoteWorkspaceClosedFallback({
        event: {
          recoveryBudgetExhausted: true,
          recoveryAttempt: 3,
          recoveryLimit: 3,
          error: "远程连接恢复预算已耗尽",
        },
        formatMessage: ({ id }, values) =>
          `${id}:${String(values?.attempt)}/${String(values?.limit)}`,
      }),
    ).toBe("remote.error.recoveryBudgetExhausted:3/3");
  });
});

describe("reconnectRemoteWorkspaceHistoryEntry", () => {
  it.each([
    [
      "source-server-install-required",
      "Source Server installation requires explicit user confirmation",
    ],
    ["source-server-upgrade-required", "must upgrade"],
  ])("keeps automatic recovery silent and only persists failure for %s", async (code, message) => {
    const sessionEntry = createRemoteWorkspaceSessionEntry({
      workspacePath: "/repo/missing-server",
      workspaceIdentity: "remote:ssh:dev.example.com:22:dev:/repo/missing-server",
      workspacePurpose: "project",
      localWorkspacePath: "/local/repo",
      target: { kind: "ssh", host: "dev.example.com", username: "dev" },
    });
    const toast = vi.fn();
    const commitRemoteWorkspaceSessionMutation = vi.fn(async (mutation) => mutation.entry);
    const connectRemoteWorkspaceTarget = vi.fn(async () => {
      throw Object.assign(new Error(message), { code });
    });

    // 侧栏组头已统一走设备级连接弹窗，安装/升级都在弹窗内处理；
    // 原地重连只剩自动恢复与工作区行级入口，不再交接到弹窗。
    await expect(
      reconnectRemoteWorkspaceHistoryEntry({
        sessionEntry,
        activateTabByPath: vi.fn(() => false),
        setReconnectingRemoteWorkspaceKeys: vi.fn((updater) => updater([])),
        loadCredential: vi.fn(async () => null),
        connectRemoteWorkspaceTarget,
        resolveRemoteWorkspaceCanonicalPath: vi.fn(async () => sessionEntry.workspacePath),
        bindRemoteWorkspaceScope: createBindRemoteWorkspaceScopeMock(
          sessionEntry.workspaceIdentity!,
        ),
        disposeRemoteWorkspaceSession: vi.fn(async () => undefined),
        bindRemoteWorkspacePath: vi.fn(),
        bindRemoteWorkspaceIdentity: vi.fn(),
        upsertWorkspaceTab: vi.fn(),
        commitRemoteWorkspaceSessionMutation,
        getRemoteSessions: () => [sessionEntry],
        logger: { warn: vi.fn() },
        toast,
        options: { recoveryMode: "automatic", showErrorToast: false },
      }),
    ).resolves.toBeUndefined();

    expect(connectRemoteWorkspaceTarget).toHaveBeenCalledOnce();
    expect(commitRemoteWorkspaceSessionMutation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({
          lastConnectionStatus: "failed",
          lastConnectionError: message,
        }),
      }),
    );
    expect(toast).not.toHaveBeenCalled();
  });

  it("loads credentials directly from a saved Source connection profile", async () => {
    const loadCredential = vi.fn(async (key: string) =>
      key.endsWith(":password") ? "profile-password" : "profile-passphrase",
    );
    await expect(
      loadConnectionProfileCredentials({
        profile: {
          profileId: "17ef20b3-622d-4a53-98c1-0cdff29f3e6d",
          transport: "ssh",
          target: {
            kind: "ssh",
            host: "demo.internal",
            username: "root",
            passwordCredentialKey: "connection-profile:p:password",
            privateKeyPassphraseCredentialKey: "connection-profile:p:private-key-passphrase",
          },
          createdAt: 1,
        },
        loadCredential,
      }),
    ).resolves.toEqual({
      password: "profile-password",
      privateKeyPassphrase: "profile-passphrase",
    });
  });

  it("keeps the current conversation mounted until reconnect is ready, then activates the remote draft", async () => {
    const activateTabByPath = vi.fn(() => true);
    const setReconnectingRemoteWorkspaceKeys = vi.fn((updater) => {
      updater([]);
      updater(["remote:docker:demo:/workspace/demo"]);
    });
    const loadCredential = vi.fn(async () => null);
    let resolveConnect!: (sessionId: string) => void;
    const pendingConnect = new Promise<string>((resolve) => {
      resolveConnect = resolve;
    });
    const connectRemoteWorkspaceTarget = vi.fn(() => pendingConnect);
    const resolveRemoteWorkspaceCanonicalPath = vi.fn(async () => "/workspace/demo");
    const bindRemoteWorkspaceScope = createBindRemoteWorkspaceScopeMock();
    const disposeRemoteWorkspaceSession = vi.fn(async () => undefined);
    const bindWorkspacePath = vi.fn();
    const bindWorkspaceIdentity = vi.fn();
    const upsertWorkspaceTab = vi.fn();
    const commitRemoteWorkspaceSessionMutation = vi.fn(async (mutation) => mutation.entry);
    const warn = vi.fn();
    const toast = vi.fn();
    const onWorkspaceActivated = vi.fn();
    const sessionEntry = {
      kind: "remote" as const,
      workspacePath: "/workspace/demo",
      target: {
        kind: "docker" as const,
        container: "demo",
      },
      lastOpenedAt: 10,
      lastConnectionStatus: "failed" as const,
    };

    const reconnect = reconnectRemoteWorkspaceHistoryEntry({
      sessionEntry,
      activateTabByPath,
      setReconnectingRemoteWorkspaceKeys,
      loadCredential,
      connectRemoteWorkspaceTarget,
      resolveRemoteWorkspaceCanonicalPath,
      bindRemoteWorkspaceScope,
      disposeRemoteWorkspaceSession,
      bindRemoteWorkspacePath: bindWorkspacePath,
      bindRemoteWorkspaceIdentity: bindWorkspaceIdentity,
      upsertWorkspaceTab,
      commitRemoteWorkspaceSessionMutation,
      getRemoteSessions: () => [sessionEntry],
      logger: { warn },
      toast,
      onWorkspaceActivated,
    });

    await vi.waitFor(() => expect(connectRemoteWorkspaceTarget).toHaveBeenCalledTimes(1));
    expect(activateTabByPath).not.toHaveBeenCalled();
    expect(upsertWorkspaceTab).not.toHaveBeenCalled();
    expect(onWorkspaceActivated).not.toHaveBeenCalled();

    resolveConnect("session-1");
    await reconnect;

    const expectedWorkspaceIdentity = buildRemoteWorkspaceIdentity("/workspace/demo", {
      kind: "docker",
      container: "demo",
    });

    expect(activateTabByPath).toHaveBeenCalledWith("/workspace/demo", {
      workspaceIdentity: expectedWorkspaceIdentity,
    });
    expect(connectRemoteWorkspaceTarget).toHaveBeenCalledWith(
      {
        kind: "docker",
        container: "demo",
      },
      undefined,
      {
        workspacePath: "/workspace/demo",
        workspaceIdentity: expectedWorkspaceIdentity,
        connectTrigger: "reconnect",
      },
    );
    expect(resolveRemoteWorkspaceCanonicalPath).toHaveBeenCalledWith(
      "session-1",
      "/workspace/demo",
    );
    expect(bindRemoteWorkspaceScope).toHaveBeenCalledWith(
      "session-1",
      "/workspace/demo",
      undefined,
      "project",
    );
    expect(bindWorkspacePath).toHaveBeenCalledWith("/workspace/demo", "session-1");
    expect(bindWorkspaceIdentity).toHaveBeenCalledWith(expectedWorkspaceIdentity, "session-1");
    expect(upsertWorkspaceTab).toHaveBeenCalledWith("/workspace/demo", {
      remoteSessionId: "session-1",
      remoteTarget: {
        kind: "docker",
        container: "demo",
      },
      workspaceIdentity: expectedWorkspaceIdentity,
    });
    expect(onWorkspaceActivated).toHaveBeenCalledWith({
      workspacePath: "/workspace/demo",
      workspaceIdentity: expectedWorkspaceIdentity,
      restoreSelection: true,
    });
    expect(upsertWorkspaceTab.mock.invocationCallOrder[0]).toBeLessThan(
      activateTabByPath.mock.invocationCallOrder[0]!,
    );
    expect(activateTabByPath.mock.invocationCallOrder[0]).toBeLessThan(
      onWorkspaceActivated.mock.invocationCallOrder[0]!,
    );
    expect(commitRemoteWorkspaceSessionMutation).toHaveBeenCalledTimes(1);
    expect(disposeRemoteWorkspaceSession).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it("reuses initiator credentials and reports Host ready before sibling initialization", async () => {
    const activateTabByPath = vi.fn(() => true);
    const setReconnectingRemoteWorkspaceKeys = vi.fn((updater) => updater([]));
    const loadCredential = vi.fn(async () => {
      throw new Error("sibling credential must not be loaded");
    });
    const connectRemoteWorkspaceTarget = vi.fn(async () => "session-1");
    const onSshHostReady = vi.fn();
    const resolveRemoteWorkspaceCanonicalPath = vi.fn(async () => {
      expect(onSshHostReady).toHaveBeenCalledWith({
        password: "initiator-password",
        privateKeyPassphrase: null,
      });
      return "/repo/b";
    });
    const sessionEntry = createRemoteWorkspaceSessionEntry({
      workspacePath: "/repo/b",
      workspaceIdentity: "remote:ssh:root@mac-studio:/repo/b",
      target: {
        kind: "ssh",
        host: "mac-studio",
        username: "root",
        passwordCredentialKey: "credential-b",
      },
    });

    await reconnectRemoteWorkspaceHistoryEntry({
      sessionEntry,
      activateTabByPath,
      setReconnectingRemoteWorkspaceKeys,
      loadCredential,
      connectRemoteWorkspaceTarget,
      resolveRemoteWorkspaceCanonicalPath,
      bindRemoteWorkspaceScope: createBindRemoteWorkspaceScopeMock(sessionEntry.workspaceIdentity!),
      disposeRemoteWorkspaceSession: vi.fn(async () => undefined),
      bindRemoteWorkspacePath: vi.fn(),
      bindRemoteWorkspaceIdentity: vi.fn(),
      upsertWorkspaceTab: vi.fn(),
      commitRemoteWorkspaceSessionMutation: vi.fn(async (mutation) => mutation.entry),
      getRemoteSessions: () => [sessionEntry],
      logger: { warn: vi.fn() },
      toast: vi.fn(),
      options: {
        sshCredentialsOverride: {
          password: "initiator-password",
          privateKeyPassphrase: null,
        },
        onSshHostReady,
      },
    });

    expect(loadCredential).not.toHaveBeenCalled();
    expect(connectRemoteWorkspaceTarget).toHaveBeenCalledWith(
      expect.objectContaining({ password: "initiator-password" }),
      undefined,
      expect.objectContaining({ workspaceIdentity: sessionEntry.workspaceIdentity }),
    );
  });

  it("rejects when mobile reconnect needs an explicit failure result", async () => {
    const activateTabByPath = vi.fn(() => true);
    const setReconnectingRemoteWorkspaceKeys = vi.fn((updater) => {
      updater([]);
      updater(["remote:docker:demo:/workspace/demo"]);
    });
    const loadCredential = vi.fn(async () => null);
    const connectRemoteWorkspaceTarget = vi.fn(async () => {
      throw new Error("ssh closed");
    });
    const resolveRemoteWorkspaceCanonicalPath = vi.fn(async () => "/workspace/demo");
    const bindRemoteWorkspaceScope = createBindRemoteWorkspaceScopeMock();
    const disposeRemoteWorkspaceSession = vi.fn(async () => undefined);
    const bindWorkspacePath = vi.fn();
    const bindWorkspaceIdentity = vi.fn();
    const upsertWorkspaceTab = vi.fn();
    const commitRemoteWorkspaceSessionMutation = vi.fn(async (mutation) => mutation.entry);
    const warn = vi.fn();
    const toast = vi.fn();
    const sessionEntry = createRemoteWorkspaceSessionEntry();

    await expect(
      reconnectRemoteWorkspaceHistoryEntry({
        sessionEntry,
        activateTabByPath,
        setReconnectingRemoteWorkspaceKeys,
        loadCredential,
        connectRemoteWorkspaceTarget,
        resolveRemoteWorkspaceCanonicalPath,
        bindRemoteWorkspaceScope,
        disposeRemoteWorkspaceSession,
        bindRemoteWorkspacePath: bindWorkspacePath,
        bindRemoteWorkspaceIdentity: bindWorkspaceIdentity,
        upsertWorkspaceTab,
        commitRemoteWorkspaceSessionMutation,
        getRemoteSessions: () => [sessionEntry],
        logger: { warn },
        toast,
        options: {
          showErrorToast: false,
          throwOnFailure: true,
        },
      }),
    ).rejects.toThrow("ssh closed");

    expect(commitRemoteWorkspaceSessionMutation).toHaveBeenCalledTimes(1);
    expect(toast).not.toHaveBeenCalled();
  });

  it("passes reconnect request id to the platform connection", async () => {
    const activateTabByPath = vi.fn(() => true);
    const setReconnectingRemoteWorkspaceKeys = vi.fn((updater) => {
      updater([]);
      updater(["remote:docker:demo:/workspace/demo"]);
    });
    const loadCredential = vi.fn(async () => null);
    const connectRemoteWorkspaceTarget = vi.fn(async () => "session-1");
    const resolveRemoteWorkspaceCanonicalPath = vi.fn(async () => "/workspace/demo");
    const bindRemoteWorkspaceScope = createBindRemoteWorkspaceScopeMock();
    const disposeRemoteWorkspaceSession = vi.fn(async () => undefined);
    const bindWorkspacePath = vi.fn();
    const bindWorkspaceIdentity = vi.fn();
    const upsertWorkspaceTab = vi.fn();
    const commitRemoteWorkspaceSessionMutation = vi.fn(async (mutation) => mutation.entry);
    const warn = vi.fn();
    const toast = vi.fn();
    const sessionEntry = createRemoteWorkspaceSessionEntry();

    await reconnectRemoteWorkspaceHistoryEntry({
      sessionEntry,
      activateTabByPath,
      setReconnectingRemoteWorkspaceKeys,
      loadCredential,
      connectRemoteWorkspaceTarget,
      resolveRemoteWorkspaceCanonicalPath,
      bindRemoteWorkspaceScope,
      disposeRemoteWorkspaceSession,
      bindRemoteWorkspacePath: bindWorkspacePath,
      bindRemoteWorkspaceIdentity: bindWorkspaceIdentity,
      upsertWorkspaceTab,
      commitRemoteWorkspaceSessionMutation,
      getRemoteSessions: () => [sessionEntry],
      logger: { warn },
      toast,
      options: {
        requestId: "request-1",
      },
    });

    expect(connectRemoteWorkspaceTarget).toHaveBeenCalledWith(
      {
        kind: "docker",
        container: "demo",
      },
      "request-1",
      {
        workspacePath: "/workspace/demo",
        workspaceIdentity: sessionEntry.workspaceIdentity,
        connectTrigger: "reconnect",
      },
    );
  });

  it("rehydrates SSH private key passphrase from credential store during reconnect", async () => {
    const activateTabByPath = vi.fn(() => true);
    const setReconnectingRemoteWorkspaceKeys = vi.fn((updater) => {
      updater([]);
      updater(["remote:ssh:demo.internal:22:root:/workspace/demo"]);
    });
    const loadCredential = vi.fn(async (key: string) => {
      if (key.endsWith(":password")) {
        return null;
      }
      if (key.endsWith(":private-key-passphrase")) {
        return "key-secret";
      }
      return null;
    });
    const connectRemoteWorkspaceTarget = vi.fn(async () => "session-1");
    const resolveRemoteWorkspaceCanonicalPath = vi.fn(async () => "/workspace/demo");
    const bindRemoteWorkspaceScope = createBindRemoteWorkspaceScopeMock(
      "remote:ssh:demo.internal:22:root:/workspace/demo",
    );
    const disposeRemoteWorkspaceSession = vi.fn(async () => undefined);
    const bindWorkspacePath = vi.fn();
    const bindWorkspaceIdentity = vi.fn();
    const upsertWorkspaceTab = vi.fn();
    const commitRemoteWorkspaceSessionMutation = vi.fn(async (mutation) => mutation.entry);
    const warn = vi.fn();
    const toast = vi.fn();
    const sessionEntry = {
      kind: "remote" as const,
      workspacePath: "/workspace/demo",
      workspaceIdentity: "remote:ssh:demo.internal:22:root:/workspace/demo",
      target: {
        kind: "ssh" as const,
        host: "demo.internal",
        port: 22,
        username: "root",
        privateKeyPath: "~/.ssh/id_ed25519",
        privateKeyPassphraseCredentialKey:
          "remote-workspace:remote:ssh:demo.internal:22:root:/workspace/demo:private-key-passphrase",
      },
      lastOpenedAt: 10,
      lastConnectionStatus: "failed" as const,
    };

    await reconnectRemoteWorkspaceHistoryEntry({
      sessionEntry,
      activateTabByPath,
      setReconnectingRemoteWorkspaceKeys,
      loadCredential,
      connectRemoteWorkspaceTarget,
      resolveRemoteWorkspaceCanonicalPath,
      bindRemoteWorkspaceScope,
      disposeRemoteWorkspaceSession,
      bindRemoteWorkspacePath: bindWorkspacePath,
      bindRemoteWorkspaceIdentity: bindWorkspaceIdentity,
      upsertWorkspaceTab,
      commitRemoteWorkspaceSessionMutation,
      getRemoteSessions: () => [sessionEntry],
      logger: { warn },
      toast,
    });

    expect(connectRemoteWorkspaceTarget).toHaveBeenCalledWith(
      {
        kind: "ssh",
        host: "demo.internal",
        port: 22,
        username: "root",
        privateKeyPath: "~/.ssh/id_ed25519",
        privateKeyPassphrase: "key-secret",
      },
      undefined,
      {
        workspacePath: "/workspace/demo",
        workspaceIdentity: "remote:ssh:demo.internal:22:root:/workspace/demo",
        connectTrigger: "reconnect",
      },
    );
    expect(upsertWorkspaceTab).toHaveBeenCalledWith("/workspace/demo", {
      remoteSessionId: "session-1",
      remoteTarget: {
        kind: "ssh",
        host: "demo.internal",
        port: 22,
        username: "root",
        privateKeyPath: "~/.ssh/id_ed25519",
      },
      workspaceIdentity: "remote:ssh:demo.internal:22:root:/workspace/demo",
    });
  });

  it("rehydrates server token from credential store during reconnect", async () => {
    const activateTabByPath = vi.fn(() => true);
    const setReconnectingRemoteWorkspaceKeys = vi.fn((updater) => {
      updater([]);
      updater(["remote:server:studio:/workspace/demo"]);
    });
    const loadCredential = vi.fn(async (key: string) =>
      key.endsWith(":server-token") ? "server-secret" : null,
    );
    const connectRemoteWorkspaceTarget = vi.fn(async () => "session-1");
    const resolveRemoteWorkspaceCanonicalPath = vi.fn(async () => "/workspace/demo");
    const bindRemoteWorkspaceScope = createBindRemoteWorkspaceScopeMock(
      "remote:server:studio:/workspace/demo",
    );
    const disposeRemoteWorkspaceSession = vi.fn(async () => undefined);
    const bindWorkspacePath = vi.fn();
    const bindWorkspaceIdentity = vi.fn();
    const upsertWorkspaceTab = vi.fn();
    const commitRemoteWorkspaceSessionMutation = vi.fn(async (mutation) => mutation.entry);
    const warn = vi.fn();
    const toast = vi.fn();
    const sessionEntry = {
      kind: "remote" as const,
      workspacePath: "/workspace/demo",
      workspaceIdentity: "remote:server:studio:/workspace/demo",
      target: {
        kind: "server" as const,
        url: "https://studio.example.com",
        serverId: "studio",
        tokenCredentialKey: "remote-workspace:remote:server:studio:/workspace/demo:server-token",
      },
      lastOpenedAt: 10,
      lastConnectionStatus: "failed" as const,
    };

    await reconnectRemoteWorkspaceHistoryEntry({
      sessionEntry,
      activateTabByPath,
      setReconnectingRemoteWorkspaceKeys,
      loadCredential,
      connectRemoteWorkspaceTarget,
      resolveRemoteWorkspaceCanonicalPath,
      bindRemoteWorkspaceScope,
      disposeRemoteWorkspaceSession,
      bindRemoteWorkspacePath: bindWorkspacePath,
      bindRemoteWorkspaceIdentity: bindWorkspaceIdentity,
      upsertWorkspaceTab,
      commitRemoteWorkspaceSessionMutation,
      getRemoteSessions: () => [sessionEntry],
      logger: { warn },
      toast,
    });

    expect(connectRemoteWorkspaceTarget).toHaveBeenCalledWith(
      {
        kind: "server",
        url: "https://studio.example.com",
        serverId: "studio",
        token: "server-secret",
      },
      undefined,
      {
        workspacePath: "/workspace/demo",
        workspaceIdentity: "remote:server:studio:/workspace/demo",
        connectTrigger: "reconnect",
      },
    );
  });

  it("disposes session and skips addTab when workspace was removed during reconnect", async () => {
    const activateTabByPath = vi.fn(() => true);
    const setReconnectingRemoteWorkspaceKeys = vi.fn((updater) => {
      updater([]);
      updater(["remote:docker:demo:/workspace/demo"]);
    });
    const loadCredential = vi.fn(async () => null);
    const connectRemoteWorkspaceTarget = vi.fn(async () => "session-1");
    const resolveRemoteWorkspaceCanonicalPath = vi.fn(async () => "/workspace/demo");
    const bindRemoteWorkspaceScope = createBindRemoteWorkspaceScopeMock();
    const disposeRemoteWorkspaceSession = vi.fn(async () => undefined);
    const bindWorkspacePath = vi.fn();
    const bindWorkspaceIdentity = vi.fn();
    const upsertWorkspaceTab = vi.fn();
    const commitRemoteWorkspaceSessionMutation = vi.fn(async (mutation) => mutation.entry);
    const warn = vi.fn();
    const toast = vi.fn();
    const sessionEntry = {
      kind: "remote" as const,
      workspacePath: "/workspace/demo",
      target: {
        kind: "docker" as const,
        container: "demo",
      },
      lastOpenedAt: 10,
      lastConnectionStatus: "failed" as const,
    };

    await reconnectRemoteWorkspaceHistoryEntry({
      sessionEntry,
      activateTabByPath,
      setReconnectingRemoteWorkspaceKeys,
      loadCredential,
      connectRemoteWorkspaceTarget,
      resolveRemoteWorkspaceCanonicalPath,
      bindRemoteWorkspaceScope,
      disposeRemoteWorkspaceSession,
      bindRemoteWorkspacePath: bindWorkspacePath,
      bindRemoteWorkspaceIdentity: bindWorkspaceIdentity,
      upsertWorkspaceTab,
      commitRemoteWorkspaceSessionMutation,
      getRemoteSessions: () => [sessionEntry],
      logger: { warn },
      toast,
      shouldKeepReconnectedWorkspace: () => false,
    });

    expect(disposeRemoteWorkspaceSession).toHaveBeenCalledWith("session-1");
    expect(upsertWorkspaceTab).not.toHaveBeenCalled();
    expect(bindWorkspacePath).not.toHaveBeenCalled();
    expect(bindWorkspaceIdentity).not.toHaveBeenCalled();
    expect(commitRemoteWorkspaceSessionMutation).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "[Root] 远程 workspace 在重连过程中已被移除，跳过恢复并回收 session",
      expect.objectContaining({
        workspacePath: "/workspace/demo",
      }),
    );
  });

  it("Host bind 先于 tab 回填，tab 与落库只消费 bind 返回的权威 scope", async () => {
    // Bugfix 回归（3.12.0 手机远控连不上远程项目，staging 4659329b6b）：手机桥接按 tab 的 path/identity
    // 三元比对 main 的 logical session descriptor，缺少 Host bind 或 bind 落后于 tab 回填都会被
    // REMOTE_WORKSPACE_IDENTITY_MISMATCH 拒绝。R3 里 bind 统一走 bindRemoteWorkspaceScope，且无条件执行。
    const target = { kind: "docker" as const, container: "demo" };
    const sessionEntry = createRemoteWorkspaceSessionEntry({
      workspacePath: "/dev",
      workspaceIdentity: buildRemoteWorkspaceIdentity("/dev", target),
      target,
    });
    const boundWorkspaceIdentity = buildRemoteWorkspaceIdentity("/home/dev", target);
    const bindRemoteWorkspaceScope = createBindRemoteWorkspaceScopeMock(boundWorkspaceIdentity);
    const upsertWorkspaceTab = vi.fn();
    const disposeRemoteWorkspaceSession = vi.fn(async () => undefined);
    const commitRemoteWorkspaceSessionMutation = vi.fn(async (mutation) => mutation.entry);

    await reconnectRemoteWorkspaceHistoryEntry({
      sessionEntry,
      activateTabByPath: vi.fn(() => true),
      setReconnectingRemoteWorkspaceKeys: vi.fn((updater) => updater([])),
      loadCredential: vi.fn(async () => null),
      connectRemoteWorkspaceTarget: vi.fn(async () => "session-1"),
      resolveRemoteWorkspaceCanonicalPath: vi.fn(async () => "/home/dev"),
      bindRemoteWorkspaceScope,
      disposeRemoteWorkspaceSession,
      bindRemoteWorkspacePath: vi.fn(),
      bindRemoteWorkspaceIdentity: vi.fn(),
      upsertWorkspaceTab,
      commitRemoteWorkspaceSessionMutation,
      getRemoteSessions: () => [sessionEntry],
      logger: { warn: vi.fn() },
      toast: vi.fn(),
    });

    expect(bindRemoteWorkspaceScope).toHaveBeenCalledWith(
      "session-1",
      "/home/dev",
      undefined,
      "project",
    );
    expect(bindRemoteWorkspaceScope.mock.invocationCallOrder[0]).toBeLessThan(
      upsertWorkspaceTab.mock.invocationCallOrder[0]!,
    );
    expect(upsertWorkspaceTab).toHaveBeenCalledWith("/home/dev", {
      remoteSessionId: "session-1",
      remoteTarget: target,
      workspaceIdentity: boundWorkspaceIdentity,
      previousWorkspaceIdentity: sessionEntry.workspaceIdentity,
      localWorkspacePath: undefined,
      workspacePurpose: undefined,
    });
    expect(commitRemoteWorkspaceSessionMutation.mock.calls[0]?.[0]?.entry).toMatchObject({
      workspacePath: "/home/dev",
      workspaceIdentity: boundWorkspaceIdentity,
      lastConnectionStatus: "connected",
    });
    expect(disposeRemoteWorkspaceSession).not.toHaveBeenCalled();
  });

  it("Host bind 失败时不回填 tab，并按失败落库", async () => {
    // bind 失败意味着 descriptor 与 tab 无法对齐（正是手机桥接被拒的根源），必须 fail-closed。
    // session 回收由 hook 侧 bindRemoteWorkspaceScope 在抛错前完成，这里锁定纯函数不产生半连接 workspace。
    const target = { kind: "docker" as const, container: "demo" };
    const sessionEntry = createRemoteWorkspaceSessionEntry({
      workspacePath: "/dev",
      workspaceIdentity: buildRemoteWorkspaceIdentity("/dev", target),
      target,
    });
    const bindRemoteWorkspaceScope = vi.fn(async () => {
      throw new Error("bind failed");
    });
    const bindWorkspacePath = vi.fn();
    const upsertWorkspaceTab = vi.fn();
    const commitRemoteWorkspaceSessionMutation = vi.fn(async (mutation) => mutation.entry);
    const toast = vi.fn();

    await reconnectRemoteWorkspaceHistoryEntry({
      sessionEntry,
      activateTabByPath: vi.fn(() => true),
      setReconnectingRemoteWorkspaceKeys: vi.fn((updater) => updater([])),
      loadCredential: vi.fn(async () => null),
      connectRemoteWorkspaceTarget: vi.fn(async () => "session-1"),
      resolveRemoteWorkspaceCanonicalPath: vi.fn(async () => "/home/dev"),
      bindRemoteWorkspaceScope,
      disposeRemoteWorkspaceSession: vi.fn(async () => undefined),
      bindRemoteWorkspacePath: bindWorkspacePath,
      bindRemoteWorkspaceIdentity: vi.fn(),
      upsertWorkspaceTab,
      commitRemoteWorkspaceSessionMutation,
      getRemoteSessions: () => [sessionEntry],
      logger: { warn: vi.fn() },
      toast,
    });

    expect(upsertWorkspaceTab).not.toHaveBeenCalled();
    expect(bindWorkspacePath).not.toHaveBeenCalled();
    expect(commitRemoteWorkspaceSessionMutation).toHaveBeenCalledTimes(1);
    expect(commitRemoteWorkspaceSessionMutation.mock.calls[0]?.[0]?.entry).toMatchObject({
      lastConnectionStatus: "failed",
      lastConnectionError: "bind failed",
    });
    expect(toast).toHaveBeenCalledWith("bind failed");
  });

  it("用户在 Host bind 等待期间移除 tab 时，不回填 tab 并回收 session", async () => {
    // 回归锁定（staging 8c25a15aa8）：保留校验必须在 bind 之后，且与 upsertWorkspaceTab 之间不能再有 await，
    // 否则校验通过后用户在 bind 等待 ready ACK 期间移除 workspace，仍会被重新加回并落库 connected。
    const target = { kind: "docker" as const, container: "demo" };
    const sessionEntry = createRemoteWorkspaceSessionEntry({
      workspacePath: "/dev",
      workspaceIdentity: buildRemoteWorkspaceIdentity("/dev", target),
      target,
    });
    let workspaceTabPresent = true;
    const shouldKeepReconnectedWorkspace = vi.fn(() => workspaceTabPresent);
    const bindRemoteWorkspaceScope = vi.fn(
      async (_sessionId: string, workspacePath: string, workspaceIdentity?: string) => {
        workspaceTabPresent = false;
        return {
          workspacePath,
          workspaceIdentity:
            workspaceIdentity ?? buildRemoteWorkspaceIdentity(workspacePath, target),
        };
      },
    );
    const upsertWorkspaceTab = vi.fn();
    const disposeRemoteWorkspaceSession = vi.fn(async () => undefined);
    const commitRemoteWorkspaceSessionMutation = vi.fn(async (mutation) => mutation.entry);

    await reconnectRemoteWorkspaceHistoryEntry({
      sessionEntry,
      activateTabByPath: vi.fn(() => true),
      setReconnectingRemoteWorkspaceKeys: vi.fn((updater) => updater([])),
      loadCredential: vi.fn(async () => null),
      connectRemoteWorkspaceTarget: vi.fn(async () => "session-1"),
      resolveRemoteWorkspaceCanonicalPath: vi.fn(async () => "/home/dev"),
      bindRemoteWorkspaceScope,
      disposeRemoteWorkspaceSession,
      bindRemoteWorkspacePath: vi.fn(),
      bindRemoteWorkspaceIdentity: vi.fn(),
      upsertWorkspaceTab,
      commitRemoteWorkspaceSessionMutation,
      getRemoteSessions: () => [sessionEntry],
      logger: { warn: vi.fn() },
      toast: vi.fn(),
      shouldKeepReconnectedWorkspace,
    });

    expect(bindRemoteWorkspaceScope).toHaveBeenCalledTimes(1);
    expect(shouldKeepReconnectedWorkspace.mock.invocationCallOrder[0]).toBeGreaterThan(
      bindRemoteWorkspaceScope.mock.invocationCallOrder[0]!,
    );
    expect(upsertWorkspaceTab).not.toHaveBeenCalled();
    expect(disposeRemoteWorkspaceSession).toHaveBeenCalledWith("session-1");
    expect(commitRemoteWorkspaceSessionMutation).not.toHaveBeenCalled();
  });

  it("skips workspace activation for background reconnect while still updating tab metadata", async () => {
    const activateTabByPath = vi.fn(() => true);
    const setReconnectingRemoteWorkspaceKeys = vi.fn((updater) => {
      updater([]);
      updater(["remote:docker:demo:/workspace/demo"]);
    });
    const loadCredential = vi.fn(async () => null);
    const connectRemoteWorkspaceTarget = vi.fn(async () => "session-1");
    const resolveRemoteWorkspaceCanonicalPath = vi.fn(async () => "/workspace/demo");
    const bindRemoteWorkspaceScope = createBindRemoteWorkspaceScopeMock();
    const disposeRemoteWorkspaceSession = vi.fn(async () => undefined);
    const bindWorkspacePath = vi.fn();
    const bindWorkspaceIdentity = vi.fn();
    const upsertWorkspaceTab = vi.fn();
    const commitRemoteWorkspaceSessionMutation = vi.fn(async (mutation) => mutation.entry);
    const warn = vi.fn();
    const toast = vi.fn();
    const sessionEntry = {
      kind: "remote" as const,
      workspacePath: "/workspace/demo",
      target: {
        kind: "docker" as const,
        container: "demo",
      },
      lastOpenedAt: 10,
      lastConnectionStatus: "failed" as const,
    };

    await reconnectRemoteWorkspaceHistoryEntry({
      sessionEntry,
      activateTabByPath,
      setReconnectingRemoteWorkspaceKeys,
      loadCredential,
      connectRemoteWorkspaceTarget,
      resolveRemoteWorkspaceCanonicalPath,
      bindRemoteWorkspaceScope,
      disposeRemoteWorkspaceSession,
      bindRemoteWorkspacePath: bindWorkspacePath,
      bindRemoteWorkspaceIdentity: bindWorkspaceIdentity,
      upsertWorkspaceTab,
      commitRemoteWorkspaceSessionMutation,
      getRemoteSessions: () => [sessionEntry],
      logger: { warn },
      toast,
      options: {
        activateWorkspaceAfterReconnect: false,
      },
    });

    const expectedWorkspaceIdentity = buildRemoteWorkspaceIdentity("/workspace/demo", {
      kind: "docker",
      container: "demo",
    });

    expect(activateTabByPath).not.toHaveBeenCalled();
    expect(upsertWorkspaceTab).toHaveBeenCalledWith("/workspace/demo", {
      remoteSessionId: "session-1",
      remoteTarget: {
        kind: "docker",
        container: "demo",
      },
      workspaceIdentity: expectedWorkspaceIdentity,
    });
    expect(commitRemoteWorkspaceSessionMutation).toHaveBeenCalledTimes(1);
  });
});

describe("openRemoteConversationWorkspace", () => {
  it("未绑定 session 直接绑定 conversation，不按根路径查找 project Profile", async () => {
    const selectRemoteWorkspace = vi.fn(async () => undefined);
    const connectRemoteWorkspaceTarget = vi.fn(async () => "unexpected-session");
    const unboundSession = {
      sessionId: "unbound-session",
      sourceServerId: "source-1",
      workspacePath: "/",
      workspaceIdentity: "remote:server:source-1:/",
      target: { kind: "docker", container: "dev" },
      services: {},
    } as never;

    await openRemoteConversationWorkspace({
      sessionId: "unbound-session",
      sourceServerId: "source-1",
      getRemoteWorkspaceSession: (sessionId) =>
        sessionId === "unbound-session" ? unboundSession : null,
      getSettings: async () => ({
        sourceServerWorkspaceHistory: [],
        connectionProfiles: [],
      }),
      loadCredential: vi.fn(async () => null),
      connectRemoteWorkspaceTarget,
      waitForRemoteWorkspaceSessionReady: vi.fn(async () => undefined),
      ensureConversationWorkspace: vi.fn(async () => ({
        path: "/remote/conversation",
      })),
      selectRemoteWorkspace,
      disposeRemoteWorkspaceSession: vi.fn(async () => undefined),
    });

    expect(connectRemoteWorkspaceTarget).not.toHaveBeenCalled();
    expect(selectRemoteWorkspace).toHaveBeenCalledWith(
      "unbound-session",
      "/remote/conversation",
      "conversation",
    );
  });

  it.each(["project", "conversation"])(
    "从 %s 新建 conversation 时使用独立 logical session",
    async (workspacePurpose) => {
      const selectRemoteWorkspace = vi.fn(async () => undefined);
      const disposeRemoteWorkspaceSession = vi.fn(async () => undefined);
      const connectRemoteWorkspaceTarget = vi.fn(async () => "conversation-session");
      const projectSession = {
        sessionId: "project-session",
        sourceServerId: "source-1",
        workspacePath: "/remote/project",
        workspaceIdentity: "remote:server:source-1:/remote/project",
        workspacePurpose,
        target: { kind: "docker", container: "dev" },
        services: {},
      } as never;
      const conversationSession = {
        sessionId: "conversation-session",
        sourceServerId: "source-1",
        target: { kind: "docker", container: "dev" },
        services: {},
      } as never;

      await openRemoteConversationWorkspace({
        sessionId: "project-session",
        sourceServerId: "source-1",
        getRemoteWorkspaceSession: (sessionId) =>
          sessionId === "project-session"
            ? projectSession
            : sessionId === "conversation-session"
              ? conversationSession
              : null,
        getSettings: async () => ({
          sourceServerWorkspaceHistory: [
            {
              workspacePath: "/remote/project",
              workspaceIdentity: "remote:server:source-1:/remote/project",
              sourceServerId: "source-1",
              profileId: "profile-1",
              lastOpenedAt: 1,
            },
          ],
          connectionProfiles: [
            {
              profileId: "profile-1",
              sourceServerId: "source-1",
              transport: "docker",
              target: { kind: "docker", container: "dev" },
              createdAt: 1,
            },
          ],
        }),
        loadCredential: vi.fn(async () => null),
        connectRemoteWorkspaceTarget,
        waitForRemoteWorkspaceSessionReady: vi.fn(async () => undefined),
        ensureConversationWorkspace: vi.fn(async () => ({
          path: "/remote/conversation",
        })),
        selectRemoteWorkspace,
        disposeRemoteWorkspaceSession,
      });

      expect(connectRemoteWorkspaceTarget).toHaveBeenCalledWith({
        kind: "docker",
        container: "dev",
      });
      expect(selectRemoteWorkspace).toHaveBeenCalledWith(
        "conversation-session",
        "/remote/conversation",
        "conversation",
      );
      expect(selectRemoteWorkspace).not.toHaveBeenCalledWith(
        "project-session",
        expect.any(String),
        "conversation",
      );
      expect(disposeRemoteWorkspaceSession).not.toHaveBeenCalled();
    },
  );

  it("ensure 失败时只释放本次新建的 conversation session", async () => {
    const disposeRemoteWorkspaceSession = vi.fn(async () => undefined);
    const selectRemoteWorkspace = vi.fn(async () => undefined);
    const connectRemoteWorkspaceTarget = vi.fn(async () => "conversation-session");
    const projectSession = {
      sessionId: "project-session",
      sourceServerId: "source-1",
      workspacePath: "/remote/project",
      workspaceIdentity: "remote:server:source-1:/remote/project",
      workspacePurpose: "project",
      target: { kind: "docker", container: "dev" },
      services: {},
    } as never;

    await expect(
      openRemoteConversationWorkspace({
        sessionId: "project-session",
        sourceServerId: "source-1",
        getRemoteWorkspaceSession: (sessionId) =>
          sessionId === "project-session" ? projectSession : null,
        getSettings: async () => ({
          sourceServerWorkspaceHistory: [
            {
              workspacePath: "/remote/project",
              workspaceIdentity: "remote:server:source-1:/remote/project",
              sourceServerId: "source-1",
              profileId: "profile-1",
              lastOpenedAt: 1,
            },
          ],
          connectionProfiles: [
            {
              profileId: "profile-1",
              sourceServerId: "source-1",
              transport: "docker",
              target: { kind: "docker", container: "dev" },
              createdAt: 1,
            },
          ],
        }),
        loadCredential: vi.fn(async () => null),
        connectRemoteWorkspaceTarget,
        waitForRemoteWorkspaceSessionReady: vi.fn(async () => undefined),
        ensureConversationWorkspace: vi.fn(async () => {
          throw new Error("ensure failed");
        }),
        selectRemoteWorkspace,
        disposeRemoteWorkspaceSession,
      }),
    ).rejects.toThrow("ensure failed");

    expect(connectRemoteWorkspaceTarget).toHaveBeenCalledOnce();
    expect(disposeRemoteWorkspaceSession).toHaveBeenCalledWith("conversation-session");
    expect(disposeRemoteWorkspaceSession).not.toHaveBeenCalledWith("project-session");
    expect(selectRemoteWorkspace).not.toHaveBeenCalled();
  });
});

describe("selectRemoteWorkspaceProjectFromDialog", () => {
  it.each(["entry-removed", "retained"])("绑定返回后等待异步成员校验：%s", async (scenario) => {
    const workspacePath = "/workspace/project";
    const workspaceIdentity = "remote:server:source:/workspace/project";
    const binding = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    let retained = true;
    const persisted = vi.fn(async (mutation) => mutation.entry);
    const addTab = vi.fn();
    const onWorkspaceActivated = vi.fn();
    const selection = selectRemoteWorkspaceProjectFromDialog({
      canUseRemoteWorkspace: true,
      sessionId: "new-session",
      path: workspacePath,
      preparedWorkspaceIdentity: workspaceIdentity,
      loadingMessage: "loading",
      getRemoteWorkspaceSession: () => ({
        sessionId: "new-session",
        target: { kind: "docker", container: "source" },
        services: {} as never,
      }),
      getWorkspaceTabs: () => [],
      resolveRemoteWorkspaceCanonicalPath: vi.fn(async () => workspacePath),
      activateTabByPath: vi.fn(() => false),
      handleCancelRemoteProject: vi.fn(async () => {}),
      bindRemoteWorkspaceScope: async () => {
        entered.resolve();
        await binding.promise;
        return { workspacePath, workspaceIdentity };
      },
      isCurrent: async () => retained,
      commitRemoteWorkspaceSessionMutation: persisted,
      getRemoteSessions: () => [],
      bindRemoteWorkspacePath: vi.fn(),
      bindRemoteWorkspaceIdentity: vi.fn(),
      addTab,
      onWorkspaceActivated,
    });
    await entered.promise;
    retained = scenario === "retained";
    binding.resolve();
    if (retained) {
      await selection;
      expect(persisted).toHaveBeenCalledOnce();
      expect(addTab).toHaveBeenCalledOnce();
    } else {
      await expect(selection).rejects.toThrow("project.navigation-cancelled");
      expect(persisted).not.toHaveBeenCalled();
      expect(addTab).not.toHaveBeenCalled();
      expect(onWorkspaceActivated).not.toHaveBeenCalled();
    }
  });

  it.each(["existing", "temporary"])(
    "only cancels a redundant attachment when reopening through %s",
    async (sessionId) => {
      const workspacePath = "/workspace/project";
      const workspaceIdentity = "remote:server:source:/workspace/project";
      const cancel = vi.fn(async () => {});
      await selectRemoteWorkspaceProjectFromDialog({
        canUseRemoteWorkspace: true,
        sessionId,
        path: workspacePath,
        preparedWorkspaceIdentity: workspaceIdentity,
        loadingMessage: "loading",
        getRemoteWorkspaceSession: () => ({
          sessionId,
          target: { kind: "docker", container: "source" },
          services: {} as never,
        }),
        getWorkspaceTabs: () => [
          createWorkspaceTab({ workspacePath, workspaceIdentity, remoteSessionId: "existing" }),
        ],
        resolveRemoteWorkspaceCanonicalPath: vi.fn(async () => workspacePath),
        activateTabByPath: vi.fn(() => true),
        handleCancelRemoteProject: cancel,
        bindRemoteWorkspaceScope: createBindRemoteWorkspaceScopeMock(workspaceIdentity),
        commitRemoteWorkspaceSessionMutation: vi.fn(async (mutation) => mutation.entry),
        getRemoteSessions: () => [],
        bindRemoteWorkspacePath: vi.fn(),
        bindRemoteWorkspaceIdentity: vi.fn(),
        addTab: vi.fn(),
      });
      if (sessionId === "existing") expect(cancel).not.toHaveBeenCalled();
      else expect(cancel).toHaveBeenCalledWith("temporary");
    },
  );

  it("preserves Host-prepared cwd and identity instead of resolving a path alias again", async () => {
    const workspacePath = "/tmp/project";
    const workspaceIdentity = "remote:server:source:/tmp/project";
    const resolveRemoteWorkspaceCanonicalPath = vi.fn(async () => "/private/tmp/project");
    const bindRemoteWorkspaceScope = createBindRemoteWorkspaceScopeMock(workspaceIdentity);
    const onWorkspaceActivated = vi.fn();
    await selectRemoteWorkspaceProjectFromDialog({
      canUseRemoteWorkspace: true,
      sessionId: "prepared-session",
      path: workspacePath,
      preparedWorkspaceIdentity: workspaceIdentity,
      loadingMessage: "loading",
      getRemoteWorkspaceSession: () => ({
        sessionId: "prepared-session",
        target: { kind: "server", url: "http://127.0.0.1:1234", serverId: "source" },
        services: {} as never,
      }),
      getWorkspaceTabs: () => [],
      resolveRemoteWorkspaceCanonicalPath,
      activateTabByPath: vi.fn(() => false),
      handleCancelRemoteProject: vi.fn(async () => {}),
      bindRemoteWorkspaceScope,
      commitRemoteWorkspaceSessionMutation: vi.fn(async (mutation) => mutation.entry),
      getRemoteSessions: () => [],
      bindRemoteWorkspacePath: vi.fn(),
      bindRemoteWorkspaceIdentity: vi.fn(),
      addTab: vi.fn(),
      onWorkspaceActivated,
    });
    expect(resolveRemoteWorkspaceCanonicalPath).not.toHaveBeenCalled();
    expect(bindRemoteWorkspaceScope).toHaveBeenCalledWith(
      "prepared-session",
      workspacePath,
      workspaceIdentity,
      "project",
    );
    expect(onWorkspaceActivated).toHaveBeenCalledWith({ workspacePath, workspaceIdentity });
  });

  it("commits the remote draft without waiting for retired Renderer task caches", async () => {
    const target = {
      kind: "docker" as const,
      container: "demo",
    };
    const workspacePath = "/workspace/demo";
    const workspaceIdentity = buildRemoteWorkspaceIdentity(workspacePath, target);
    const onWorkspaceActivated = vi.fn();
    let selectionSettled = false;

    const selection = selectRemoteWorkspaceProjectFromDialog({
      canUseRemoteWorkspace: true,
      sessionId: "session-1",
      path: workspacePath,
      loadingMessage: "loading",
      getRemoteWorkspaceSession: () => ({
        sessionId: "session-1",
        target,
        services: {} as never,
      }),
      getWorkspaceTabs: () => [],
      resolveRemoteWorkspaceCanonicalPath: vi.fn(async () => workspacePath),
      activateTabByPath: vi.fn(() => false),
      handleCancelRemoteProject: vi.fn(async () => undefined),
      bindRemoteWorkspaceScope: createBindRemoteWorkspaceScopeMock(workspaceIdentity),
      commitRemoteWorkspaceSessionMutation: vi.fn(async (mutation) => mutation.entry),
      getRemoteSessions: () => [],
      bindRemoteWorkspacePath: vi.fn(),
      bindRemoteWorkspaceIdentity: vi.fn(),
      addTab: vi.fn(),
      onWorkspaceActivated,
    }).then(() => {
      selectionSettled = true;
    });

    await vi.waitFor(() => {
      expect(onWorkspaceActivated).toHaveBeenCalledWith({
        workspacePath,
        workspaceIdentity,
      });
    });
    expect(selectionSettled).toBe(true);

    await selection;
    expect(selectionSettled).toBe(true);
  });

  it("attaches the new session to an existing disconnected workspace tab", async () => {
    const target = {
      kind: "docker" as const,
      container: "demo",
    };
    const workspacePath = "/workspace/demo";
    const workspaceIdentity = buildRemoteWorkspaceIdentity(workspacePath, target);
    const remoteSession = {
      sessionId: "session-1",
      target,
      services: {} as never,
    };
    const existingDisconnectedTab = createWorkspaceTab({
      workspacePath,
      workspaceIdentity,
    });
    const activateTabByPath = vi.fn(() => true);
    const handleCancelRemoteProject = vi.fn(async () => undefined);
    const bindRemoteWorkspaceScope = createBindRemoteWorkspaceScopeMock(workspaceIdentity);
    const commitRemoteWorkspaceSessionMutation = vi.fn(async (mutation) => mutation.entry);
    const bindWorkspacePath = vi.fn();
    const bindWorkspaceIdentity = vi.fn();
    const addTab = vi.fn();
    const localWorkspacePath = "/Users/alice/demo";

    await selectRemoteWorkspaceProjectFromDialog({
      canUseRemoteWorkspace: true,
      sessionId: remoteSession.sessionId,
      path: workspacePath,
      localWorkspacePath,
      loadingMessage: "loading",
      getRemoteWorkspaceSession: () => remoteSession,
      getWorkspaceTabs: () => [existingDisconnectedTab],
      resolveRemoteWorkspaceCanonicalPath: vi.fn(async () => workspacePath),
      activateTabByPath,
      handleCancelRemoteProject,
      bindRemoteWorkspaceScope,
      commitRemoteWorkspaceSessionMutation,
      getRemoteSessions: () => [
        createRemoteWorkspaceSessionEntry({
          workspacePath,
          workspaceIdentity,
          target,
          lastConnectionStatus: "failed",
        }),
      ],
      bindRemoteWorkspacePath: bindWorkspacePath,
      bindRemoteWorkspaceIdentity: bindWorkspaceIdentity,
      addTab,
    } as Parameters<typeof selectRemoteWorkspaceProjectFromDialog>[0] & {
      localWorkspacePath: string;
    });

    expect(activateTabByPath).not.toHaveBeenCalled();
    expect(handleCancelRemoteProject).not.toHaveBeenCalled();
    expect(bindRemoteWorkspaceScope).toHaveBeenCalledWith(
      remoteSession.sessionId,
      workspacePath,
      undefined,
      "project",
    );
    expect(bindWorkspacePath).toHaveBeenCalledWith(workspacePath, remoteSession.sessionId);
    expect(bindWorkspaceIdentity).toHaveBeenCalledWith(workspaceIdentity, remoteSession.sessionId);
    expect(addTab).toHaveBeenCalledWith(workspacePath, {
      remoteSessionId: remoteSession.sessionId,
      remoteTarget: target,
      workspaceIdentity,
      localWorkspacePath,
      workspacePurpose: "project",
    });
    expect(commitRemoteWorkspaceSessionMutation).toHaveBeenCalledTimes(1);
    const committedMutation = commitRemoteWorkspaceSessionMutation.mock.calls[0]?.[0];
    expect(committedMutation).toBeDefined();
    const committedEntry = committedMutation?.entry as { localWorkspacePath?: string } | undefined;
    expect(committedEntry).toBeDefined();
    expect(committedEntry?.localWorkspacePath).toBe(localWorkspacePath);
  });

  it("restores the original selection when the wizard reconnects the manually opened tab", async () => {
    const target = { kind: "docker" as const, container: "demo" };
    const workspacePath = "/workspace/demo";
    const workspaceIdentity = buildRemoteWorkspaceIdentity(workspacePath, target);
    const disconnectedTab = createWorkspaceTab({
      id: "tab-reconnect",
      workspacePath,
      workspaceIdentity,
    });
    const otherTab = createWorkspaceTab({
      id: "tab-other",
      workspacePath: "/workspace/other",
      workspaceIdentity: buildRemoteWorkspaceIdentity("/workspace/other", target),
    });
    const select = async (restoringWorkspaceTabId: string) => {
      const onWorkspaceActivated = vi.fn();
      await selectRemoteWorkspaceProjectFromDialog({
        canUseRemoteWorkspace: true,
        sessionId: "session-1",
        path: workspacePath,
        loadingMessage: "loading",
        getRemoteWorkspaceSession: () => ({
          sessionId: "session-1",
          target,
          services: {} as never,
        }),
        getWorkspaceTabs: () => [disconnectedTab, otherTab],
        restoringWorkspaceTabId,
        resolveRemoteWorkspaceCanonicalPath: vi.fn(async () => workspacePath),
        activateTabByPath: vi.fn(() => true),
        handleCancelRemoteProject: vi.fn(async () => undefined),
        bindRemoteWorkspaceScope: createBindRemoteWorkspaceScopeMock(workspaceIdentity),
        commitRemoteWorkspaceSessionMutation: vi.fn(async (mutation) => mutation.entry),
        getRemoteSessions: () => [],
        bindRemoteWorkspacePath: vi.fn(),
        bindRemoteWorkspaceIdentity: vi.fn(),
        addTab: vi.fn(),
        onWorkspaceActivated,
      });
      return onWorkspaceActivated;
    };

    // 原会话 tab 经向导重连：挂回后保持原选择，不得覆盖成草稿。
    expect(await select(disconnectedTab.id)).toHaveBeenCalledWith({
      workspacePath,
      workspaceIdentity,
      restoreSelection: true,
    });
    // 向导意图属于别的 tab：仍是普通打开项目，进入新任务。
    expect(await select(otherTab.id)).toHaveBeenCalledWith({ workspacePath, workspaceIdentity });
  });

  it("clears the disconnected overlay after the dialog reattaches an existing workspace", async () => {
    const target = {
      kind: "docker" as const,
      container: "demo",
    };
    const workspacePath = "/workspace/demo";
    const workspaceIdentity = buildRemoteWorkspaceIdentity(workspacePath, target);
    setRemoteWorkspaceConnectionState(workspaceIdentity, "disconnected");

    try {
      await selectRemoteWorkspaceProjectFromDialog({
        canUseRemoteWorkspace: true,
        sessionId: "session-1",
        path: workspacePath,
        loadingMessage: "loading",
        getRemoteWorkspaceSession: () => ({
          sessionId: "session-1",
          target,
          services: {} as never,
        }),
        getWorkspaceTabs: () => [createWorkspaceTab({ workspacePath, workspaceIdentity })],
        resolveRemoteWorkspaceCanonicalPath: vi.fn(async () => workspacePath),
        activateTabByPath: vi.fn(() => false),
        handleCancelRemoteProject: vi.fn(async () => undefined),
        bindRemoteWorkspaceScope: createBindRemoteWorkspaceScopeMock(workspaceIdentity),
        commitRemoteWorkspaceSessionMutation: vi.fn(async (mutation) => mutation.entry),
        getRemoteSessions: () => [],
        bindRemoteWorkspacePath: vi.fn(),
        bindRemoteWorkspaceIdentity: vi.fn(),
        addTab: vi.fn(),
      });

      expect(getRemoteWorkspaceConnectionState(workspaceIdentity)).toBeUndefined();
    } finally {
      clearRemoteWorkspaceConnectionState(workspaceIdentity);
    }
  });

  it("rekeys an existing legacy tab when the first open binds a stable Source Server identity", async () => {
    const target = {
      kind: "ssh" as const,
      host: "localhost",
      port: 2223,
      username: "dev",
    };
    const workspacePath = "/home/dev";
    const legacyWorkspaceIdentity = buildRemoteWorkspaceIdentity(workspacePath, target);
    const workspaceIdentity = "remote:server:source-arm64:/home/dev";
    const store = createTabStore();
    store.getState().addTab(workspacePath, {
      workspaceIdentity: legacyWorkspaceIdentity,
      remoteTarget: target,
    });
    const remoteSession = {
      sessionId: "session-1",
      target,
      services: {} as never,
    };

    await selectRemoteWorkspaceProjectFromDialog({
      canUseRemoteWorkspace: true,
      sessionId: remoteSession.sessionId,
      path: workspacePath,
      loadingMessage: "loading",
      getRemoteWorkspaceSession: () => remoteSession,
      getWorkspaceTabs: () => store.getState().tabs,
      resolveRemoteWorkspaceCanonicalPath: vi.fn(async () => workspacePath),
      activateTabByPath: vi.fn(() => false),
      handleCancelRemoteProject: vi.fn(async () => undefined),
      bindRemoteWorkspaceScope: vi.fn(async () => ({
        workspacePath,
        workspaceIdentity,
        previousWorkspaceIdentity: legacyWorkspaceIdentity,
      })),
      commitRemoteWorkspaceSessionMutation: vi.fn(async (mutation) => mutation.entry),
      getRemoteSessions: () => [],
      bindRemoteWorkspacePath: vi.fn(),
      bindRemoteWorkspaceIdentity: vi.fn(),
      addTab: store.getState().addTab,
    });

    const workspaceTabs = store
      .getState()
      .tabs.filter(
        (tab): tab is Extract<WindowTabState, { kind: "workspace" }> => tab.kind === "workspace",
      );
    expect(workspaceTabs).toHaveLength(1);
    expect(workspaceTabs[0]).toMatchObject({
      workspaceIdentity,
      remoteSessionId: remoteSession.sessionId,
    });
  });

  it("uses the temporary SSH target for credential persistence but strips it from the tab", async () => {
    const connectionTarget = {
      kind: "ssh" as const,
      host: "demo.internal",
      username: "root",
      password: "password-secret",
    };
    const sanitizedTarget = {
      kind: "ssh" as const,
      host: "demo.internal",
      username: "root",
    };
    const workspacePath = "/workspace/demo";
    const workspaceIdentity = "remote:server:3cd4f9da-cd79-426c-9d70-75f36e9f6a87:/workspace/demo";
    const commitRemoteWorkspaceSessionMutation = vi.fn(async (mutation) => mutation.entry);
    const addTab = vi.fn();

    await selectRemoteWorkspaceProjectFromDialog({
      canUseRemoteWorkspace: true,
      sessionId: "session-1",
      path: workspacePath,
      loadingMessage: "loading",
      connectionTarget,
      getRemoteWorkspaceSession: () => ({
        sessionId: "session-1",
        target: sanitizedTarget,
        services: {} as never,
      }),
      getWorkspaceTabs: () => [],
      resolveRemoteWorkspaceCanonicalPath: vi.fn(async () => workspacePath),
      activateTabByPath: vi.fn(() => false),
      handleCancelRemoteProject: vi.fn(async () => undefined),
      bindRemoteWorkspaceScope: vi.fn(async () => ({
        workspacePath,
        workspaceIdentity,
      })),
      commitRemoteWorkspaceSessionMutation,
      getRemoteSessions: () => [],
      bindRemoteWorkspacePath: vi.fn(),
      bindRemoteWorkspaceIdentity: vi.fn(),
      addTab,
    });

    expect(addTab).toHaveBeenCalledWith(workspacePath, {
      remoteSessionId: "session-1",
      remoteTarget: sanitizedTarget,
      workspaceIdentity,
      localWorkspacePath: undefined,
      workspacePurpose: "project",
    });
    const mutation = commitRemoteWorkspaceSessionMutation.mock.calls[0]?.[0];
    expect(mutation?.credentialsToSave).toEqual([]);
  });

  it("提交 connected 历史与 addTab 之前先完成 Host bind，tab 只消费 bind 返回的权威 scope", async () => {
    // Bugfix 回归（3.12.0 手机远控连不上 WSL 项目，staging 4659329b6b）：新建连接不带 context，
    // main descriptor 停留在 "/"；手机桥接按 tab 的 path/identity 三元比对 descriptor，
    // 所以选目录后必须先把 canonical scope bind 回 main，再落库 connected 与建 tab。
    const connectionTarget = { kind: "wsl" as const };
    const workspacePath = "/home/dev";
    const workspaceIdentity = "remote:wsl:Ubuntu:/home/dev";
    const bindRemoteWorkspaceScope = vi.fn(async () => ({ workspacePath, workspaceIdentity }));
    const commitRemoteWorkspaceSessionMutation = vi.fn(async (mutation) => mutation.entry);
    const handleCancelRemoteProject = vi.fn(async () => undefined);
    const addTab = vi.fn();

    await selectRemoteWorkspaceProjectFromDialog({
      canUseRemoteWorkspace: true,
      sessionId: "session-1",
      path: "/home/dev/",
      loadingMessage: "loading",
      connectionTarget,
      getRemoteWorkspaceSession: () => ({
        sessionId: "session-1",
        // main 回传给 renderer store 的是解析后的 WSL target
        target: { kind: "wsl", distro: "Ubuntu", user: "dev" },
        services: {} as never,
      }),
      getWorkspaceTabs: () => [],
      resolveRemoteWorkspaceCanonicalPath: vi.fn(async () => workspacePath),
      activateTabByPath: vi.fn(() => false),
      handleCancelRemoteProject,
      bindRemoteWorkspaceScope,
      commitRemoteWorkspaceSessionMutation,
      getRemoteSessions: () => [],
      bindRemoteWorkspacePath: vi.fn(),
      bindRemoteWorkspaceIdentity: vi.fn(),
      addTab,
      refreshPinnedTasks: vi.fn(async () => undefined),
      refreshTimelineTasks: vi.fn(async () => undefined),
    });

    expect(bindRemoteWorkspaceScope).toHaveBeenCalledWith(
      "session-1",
      workspacePath,
      undefined,
      "project",
    );
    expect(bindRemoteWorkspaceScope.mock.invocationCallOrder[0]).toBeLessThan(
      commitRemoteWorkspaceSessionMutation.mock.invocationCallOrder[0]!,
    );
    expect(bindRemoteWorkspaceScope.mock.invocationCallOrder[0]).toBeLessThan(
      addTab.mock.invocationCallOrder[0]!,
    );
    expect(commitRemoteWorkspaceSessionMutation.mock.calls[0]?.[0]?.entry).toMatchObject({
      workspacePath,
      workspaceIdentity,
      lastConnectionStatus: "connected",
    });
    expect(addTab).toHaveBeenCalledWith(workspacePath, {
      remoteSessionId: "session-1",
      remoteTarget: connectionTarget,
      workspaceIdentity,
      localWorkspacePath: undefined,
      workspacePurpose: "project",
    });
    expect(handleCancelRemoteProject).not.toHaveBeenCalled();
  });

  it("Host bind 失败时不落库也不建 tab", async () => {
    // descriptor 与 tab 不一致的 session 正是手机桥接被拒的根源，绑定失败必须 fail-closed；
    // session 回收由 hook 侧 bindRemoteWorkspaceScope 在抛错前完成，这里锁定纯函数不产生半连接状态。
    const target = { kind: "docker" as const, container: "demo" };
    const workspacePath = "/workspace/demo";
    const bindRemoteWorkspaceScope = vi.fn(async () => {
      throw new Error("bind failed");
    });
    const commitRemoteWorkspaceSessionMutation = vi.fn(async (mutation) => mutation.entry);
    const bindRemoteWorkspacePath = vi.fn();
    const addTab = vi.fn();

    await expect(
      selectRemoteWorkspaceProjectFromDialog({
        canUseRemoteWorkspace: true,
        sessionId: "session-1",
        path: workspacePath,
        loadingMessage: "loading",
        getRemoteWorkspaceSession: () => ({
          sessionId: "session-1",
          target,
          services: {} as never,
        }),
        getWorkspaceTabs: () => [],
        resolveRemoteWorkspaceCanonicalPath: vi.fn(async () => workspacePath),
        activateTabByPath: vi.fn(() => false),
        handleCancelRemoteProject: vi.fn(async () => undefined),
        bindRemoteWorkspaceScope,
        commitRemoteWorkspaceSessionMutation,
        getRemoteSessions: () => [],
        bindRemoteWorkspacePath,
        bindRemoteWorkspaceIdentity: vi.fn(),
        addTab,
        refreshPinnedTasks: vi.fn(async () => undefined),
        refreshTimelineTasks: vi.fn(async () => undefined),
      }),
    ).rejects.toThrow("bind failed");

    expect(commitRemoteWorkspaceSessionMutation).not.toHaveBeenCalled();
    expect(bindRemoteWorkspacePath).not.toHaveBeenCalled();
    expect(addTab).not.toHaveBeenCalled();
  });
});

describe("reconnectRemoteWorkspaceByKey", () => {
  it("reconnects a matching workspace with caller-provided mobile options", async () => {
    const sessionEntry = createRemoteWorkspaceSessionEntry();
    const runReconnectRemoteWorkspace = vi.fn(async () => undefined);

    await expect(
      reconnectRemoteWorkspaceByKey({
        workspaceKey: buildWorkspaceSessionKey(sessionEntry),
        canUseRemoteWorkspace: true,
        getRemoteSessions: () => [sessionEntry],
        runReconnectRemoteWorkspace,
        options: {
          activateWorkspaceAfterReconnect: false,
          showErrorToast: false,
        },
      }),
    ).resolves.toBe(true);

    expect(runReconnectRemoteWorkspace).toHaveBeenCalledWith(sessionEntry, {
      activateWorkspaceAfterReconnect: false,
      showErrorToast: false,
    });
  });

  it("rejects when the workspace is not available for reconnect", async () => {
    const runReconnectRemoteWorkspace = vi.fn(async () => undefined);

    await expect(
      reconnectRemoteWorkspaceByKey({
        workspaceKey: "missing",
        canUseRemoteWorkspace: true,
        getRemoteSessions: () => [createRemoteWorkspaceSessionEntry()],
        runReconnectRemoteWorkspace,
      }),
    ).rejects.toThrow("远程 workspace 不在当前窗口中，无法重连: missing");

    expect(runReconnectRemoteWorkspace).not.toHaveBeenCalled();
  });
});

describe("collectSshReconnectGroup", () => {
  it("collects open disconnected workspaces that share the same SSH Host identity", () => {
    const first = createRemoteWorkspaceSessionEntry({
      workspacePath: "/repo/a",
      workspaceIdentity: "remote:ssh:root@mac-studio:/repo/a",
      target: {
        kind: "ssh",
        host: "Mac-Studio",
        username: "root",
        passwordCredentialKey: "credential-a",
      },
    });
    const second = createRemoteWorkspaceSessionEntry({
      workspacePath: "/repo/b",
      workspaceIdentity: "remote:ssh:root@mac-studio:/repo/b",
      target: {
        kind: "ssh",
        host: "mac-studio",
        port: 22,
        username: "root",
        passwordCredentialKey: "credential-b",
      },
    });
    const differentAuth = createRemoteWorkspaceSessionEntry({
      workspacePath: "/repo/c",
      workspaceIdentity: "remote:ssh:root@mac-studio:/repo/c",
      target: {
        kind: "ssh",
        host: "mac-studio",
        username: "root",
        privateKeyPath: "/keys/id_ed25519",
      },
    });

    expect(
      collectSshReconnectGroup({
        selected: first,
        // 回归：持久化顺序可能和用户实际点击的 workspace 不同，initiator 仍必须排在首位。
        sessions: [second, first, differentAuth],
        tabs: [
          createWorkspaceTab({
            id: "tab-a",
            workspacePath: first.workspacePath,
            workspaceIdentity: first.workspaceIdentity,
          }),
          createWorkspaceTab({
            id: "tab-b",
            workspacePath: second.workspacePath,
            workspaceIdentity: second.workspaceIdentity,
          }),
          createWorkspaceTab({
            id: "tab-c",
            workspacePath: differentAuth.workspacePath,
            workspaceIdentity: differentAuth.workspaceIdentity,
          }),
        ],
      }),
    ).toEqual([first, second]);
  });

  it("does not reconnect an already connected sibling workspace", () => {
    const first = createRemoteWorkspaceSessionEntry({
      workspacePath: "/repo/a",
      workspaceIdentity: "remote:ssh:root@mac-studio:/repo/a",
      target: { kind: "ssh", host: "mac-studio", username: "root" },
    });
    const connected = createRemoteWorkspaceSessionEntry({
      workspacePath: "/repo/b",
      workspaceIdentity: "remote:ssh:root@mac-studio:/repo/b",
      target: { kind: "ssh", host: "mac-studio", username: "root" },
    });

    expect(
      collectSshReconnectGroup({
        selected: first,
        sessions: [first, connected],
        tabs: [
          createWorkspaceTab({
            id: "tab-a",
            workspacePath: first.workspacePath,
            workspaceIdentity: first.workspaceIdentity,
          }),
          createWorkspaceTab({
            id: "tab-b",
            workspacePath: connected.workspacePath,
            workspaceIdentity: connected.workspaceIdentity,
            remoteSessionId: "session-b",
          }),
        ],
      }),
    ).toEqual([first]);
  });
});

describe("startup reconnect event gates", () => {
  it("only treats an online Source state as a startup recovery signal", () => {
    expect(shouldAttemptStartupReconnectForSourceState("online")).toBe(true);
    expect(shouldAttemptStartupReconnectForSourceState("retrying")).toBe(false);
    expect(shouldAttemptStartupReconnectForSourceState("offline")).toBe(false);
    expect(shouldAttemptStartupReconnectForSourceState("failed")).toBe(false);
  });

  it("ignores clearing the session on an existing tab but detects a new deferred tab", () => {
    const previousTabs = [
      createWorkspaceTab({
        workspacePath: "/repo/a",
        workspaceIdentity: "remote:server:source-a:/repo/a",
        remoteSessionId: "session-a",
      }),
    ];
    const disconnectedExistingTab = [
      createWorkspaceTab({
        workspacePath: "/repo/a",
        workspaceIdentity: "remote:server:source-a:/repo/a",
      }),
    ];
    expect(shouldAttemptStartupReconnectForTabChange(disconnectedExistingTab, previousTabs)).toBe(
      false,
    );

    const withDeferredTab = [
      ...disconnectedExistingTab,
      createWorkspaceTab({
        id: "tab-b",
        workspacePath: "/repo/b",
        workspaceIdentity: "remote:server:source-a:/repo/b",
      }),
    ];
    expect(
      shouldAttemptStartupReconnectForTabChange(withDeferredTab, disconnectedExistingTab),
    ).toBe(true);

    expect(
      shouldAttemptStartupReconnectForTabChange(
        [
          ...disconnectedExistingTab,
          createWorkspaceTab({
            id: "local-tab",
            workspacePath: "/repo/local",
          }),
        ],
        disconnectedExistingTab,
      ),
    ).toBe(false);
  });
});

describe("collectStartupRemoteWorkspaceReconnectGroups", () => {
  it("re-evaluates candidates after active-first restores deferred workspace tabs", async () => {
    const source = await readFile(
      new URL("../src/root/useRemoteWorkspaceHistory.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain("tabStoreApi.subscribe");
    expect(source).toContain("shouldAttemptStartupReconnectForTabChange");
  });

  it("groups recent connected stable histories by Source Server", () => {
    const now = 10 * 24 * 60 * 60_000;
    const first = createRemoteWorkspaceSessionEntry({
      workspacePath: "/repo/a",
      workspaceIdentity: "remote:server:source-a:/repo/a",
      target: { kind: "ssh", host: "example.test", username: "dev" },
      lastOpenedAt: now - 60_000,
      lastConnectionStatus: "connected",
    });
    const second = createRemoteWorkspaceSessionEntry({
      workspacePath: "/repo/b",
      workspaceIdentity: "remote:server:source-a:/repo/b",
      target: { kind: "ssh", host: "example.test", username: "dev" },
      lastOpenedAt: now - 120_000,
      lastConnectionStatus: "connected",
    });

    expect(
      collectStartupRemoteWorkspaceReconnectGroups({
        sessions: [first, second],
        tabs: [
          createWorkspaceTab({
            workspacePath: first.workspacePath,
            workspaceIdentity: first.workspaceIdentity,
          }),
          createWorkspaceTab({
            id: "tab-b",
            workspacePath: second.workspacePath,
            workspaceIdentity: second.workspaceIdentity,
          }),
        ],
        attemptedWorkspaceKeys: new Set(),
        onlineSourceServerIds: new Set(["source-a"]),
      }),
    ).toEqual([{ sourceServerId: "source-a", entries: [first, second] }]);
  });

  it("uses a connected entry to admit the Source flight and includes failed open siblings", () => {
    const now = 10 * 24 * 60 * 60_000;
    const connected = createRemoteWorkspaceSessionEntry({
      workspacePath: "/repo/connected",
      workspaceIdentity: "remote:server:source-a:/repo/connected",
      target: { kind: "ssh", host: "example.test", username: "dev" },
      lastOpenedAt: now - 60_000,
      lastConnectionStatus: "connected",
    });
    const failedSibling = createRemoteWorkspaceSessionEntry({
      workspacePath: "/repo/failed",
      workspaceIdentity: "remote:server:source-a:/repo/failed",
      target: { kind: "ssh", host: "example.test", username: "dev" },
      lastOpenedAt: now - 120_000,
      lastConnectionStatus: "failed",
      lastConnectionError: "upgrade required",
    });

    expect(
      collectStartupRemoteWorkspaceReconnectGroups({
        sessions: [connected, failedSibling],
        tabs: [
          createWorkspaceTab({
            workspacePath: connected.workspacePath,
            workspaceIdentity: connected.workspaceIdentity,
          }),
          createWorkspaceTab({
            id: "tab-failed",
            workspacePath: failedSibling.workspacePath,
            workspaceIdentity: failedSibling.workspaceIdentity,
          }),
        ],
        attemptedWorkspaceKeys: new Set(),
        onlineSourceServerIds: new Set(["source-a"]),
      }),
    ).toEqual([
      {
        sourceServerId: "source-a",
        entries: [connected, failedSibling],
      },
    ]);
  });

  it("picks up a deferred sibling after another workspace from the same Source was attempted", () => {
    const now = 10 * 24 * 60 * 60_000;
    const first = createRemoteWorkspaceSessionEntry({
      workspacePath: "/repo/a",
      workspaceIdentity: "remote:server:source-a:/repo/a",
      target: { kind: "ssh", host: "example.test", username: "dev" },
      lastOpenedAt: now - 60_000,
      lastConnectionStatus: "connected",
    });
    const second = createRemoteWorkspaceSessionEntry({
      workspacePath: "/repo/b",
      workspaceIdentity: "remote:server:source-a:/repo/b",
      target: { kind: "ssh", host: "example.test", username: "dev" },
      lastOpenedAt: now - 60_000,
      lastConnectionStatus: "connected",
    });

    expect(
      collectStartupRemoteWorkspaceReconnectGroups({
        sessions: [first, second],
        tabs: [
          createWorkspaceTab({
            workspacePath: first.workspacePath,
            workspaceIdentity: first.workspaceIdentity,
          }),
          createWorkspaceTab({
            id: "tab-b",
            workspacePath: second.workspacePath,
            workspaceIdentity: second.workspaceIdentity,
          }),
        ],
        attemptedWorkspaceKeys: new Set([buildWorkspaceSessionKey(first)]),
        onlineSourceServerIds: new Set(["source-a"]),
      }),
    ).toEqual([{ sourceServerId: "source-a", entries: [second] }]);
  });

  it("restores previously attempted open workspaces after their Source reconnects", () => {
    const now = 10 * 24 * 60 * 60_000;
    const disconnected = createRemoteWorkspaceSessionEntry({
      workspacePath: "/repo/a",
      workspaceIdentity: "remote:server:source-a:/repo/a",
      target: { kind: "ssh", host: "example.test", username: "dev" },
      lastOpenedAt: now - 60_000,
      lastConnectionStatus: "connected",
    });
    const unrelated = createRemoteWorkspaceSessionEntry({
      workspacePath: "/repo/b",
      workspaceIdentity: "remote:server:source-b:/repo/b",
      target: { kind: "ssh", host: "other.test", username: "dev" },
      lastOpenedAt: now - 60_000,
      lastConnectionStatus: "connected",
    });
    const attemptedWorkspaceKeys = new Set([
      buildWorkspaceSessionKey(disconnected),
      buildWorkspaceSessionKey(unrelated),
    ]);

    updateStartupRemoteWorkspaceReconnectAttemptsForSourceState({
      state: { state: "offline", sourceServerId: "source-a" },
      onlineSourceServerIds: new Set(),
      sessions: [disconnected, unrelated],
      attemptedWorkspaceKeys,
    });

    expect(
      collectStartupRemoteWorkspaceReconnectGroups({
        sessions: [disconnected, unrelated],
        tabs: [
          createWorkspaceTab({
            workspacePath: disconnected.workspacePath,
            workspaceIdentity: disconnected.workspaceIdentity,
          }),
          createWorkspaceTab({
            id: "tab-b",
            workspacePath: unrelated.workspacePath,
            workspaceIdentity: unrelated.workspaceIdentity,
          }),
        ],
        attemptedWorkspaceKeys,
        onlineSourceServerIds: new Set(["source-a", "source-b"]),
      }),
    ).toEqual([{ sourceServerId: "source-a", entries: [disconnected] }]);
    expect(attemptedWorkspaceKeys).toContain(buildWorkspaceSessionKey(unrelated));
  });

  it("restores all failed open entries after the Source disconnected in this Renderer", () => {
    const now = 10 * 24 * 60 * 60_000;
    const first = createRemoteWorkspaceSessionEntry({
      workspacePath: "/repo/a",
      workspaceIdentity: "remote:server:source-a:/repo/a",
      target: { kind: "ssh", host: "example.test", username: "dev" },
      lastOpenedAt: now - 60_000,
      lastConnectionStatus: "failed",
      lastConnectionError: "remote connection closed",
    });
    const second = createRemoteWorkspaceSessionEntry({
      workspacePath: "/repo/b",
      workspaceIdentity: "remote:server:source-a:/repo/b",
      target: { kind: "ssh", host: "example.test", username: "dev" },
      lastOpenedAt: now - 120_000,
      lastConnectionStatus: "failed",
      lastConnectionError: "remote connection closed",
    });

    expect(
      collectStartupRemoteWorkspaceReconnectGroups({
        sessions: [first, second],
        tabs: [
          createWorkspaceTab({
            workspacePath: first.workspacePath,
            workspaceIdentity: first.workspaceIdentity,
          }),
          createWorkspaceTab({
            id: "tab-b",
            workspacePath: second.workspacePath,
            workspaceIdentity: second.workspaceIdentity,
          }),
        ],
        attemptedWorkspaceKeys: new Set([
          buildWorkspaceSessionKey(first),
          buildWorkspaceSessionKey(second),
        ]),
        onlineSourceServerIds: new Set(["source-a"]),
        currentRendererDisconnectedSourceServerIds: new Set(["source-a"]),
      }),
    ).toEqual([{ sourceServerId: "source-a", entries: [first, second] }]);
  });

  it("restores all failed retained workspaces on cold startup, excluding closed and pending-disconnect sources", () => {
    const now = Date.now();
    const make = (workspacePath: string) =>
      createRemoteWorkspaceSessionEntry({
        workspacePath,
        workspaceIdentity: `remote:server:source-a:${workspacePath}`,
        target: { kind: "ssh", host: "example.test", username: "dev" },
        lastOpenedAt: now - 60_000,
        lastConnectionStatus: "failed",
      });
    const project = make("/repo/a");
    const conversation = {
      ...make("/repo/conversation"),
      workspacePurpose: "conversation" as const,
    };
    const closed = make("/repo/closed");
    const input = {
      sessions: [project, conversation, closed],
      tabs: [project, conversation].map((entry, index) =>
        createWorkspaceTab({
          id: `tab-${index}`,
          workspacePath: entry.workspacePath,
          workspaceIdentity: entry.workspaceIdentity,
        }),
      ),
      attemptedWorkspaceKeys: new Set<string>(),
      onlineSourceServerIds: new Set(["source-a"]),
    };
    expect(collectStartupRemoteWorkspaceReconnectGroups(input)).toEqual([
      { sourceServerId: "source-a", entries: [project] },
    ]);
    expect(
      collectStartupRemoteWorkspaceReconnectGroups({
        ...input,
        pendingTerminallyDisconnectedSourceServerIds: new Set(["source-a"]),
      }),
    ).toEqual([]);
    expect(
      collectStartupRemoteWorkspaceReconnectGroups({
        ...input,
        attemptedWorkspaceKeys: new Set([
          project.workspaceIdentity!,
          conversation.workspaceIdentity!,
        ]),
      }),
    ).toEqual([]);
  });

  it("RPN-04 does not attach the project owned by the dialog while restoring its sibling", () => {
    const a = createRemoteWorkspaceSessionEntry({
      workspacePath: "/repo/a",
      workspaceIdentity: "remote:server:source-a:/repo/a",
      target: { kind: "ssh", host: "example.test", username: "dev" },
      lastOpenedAt: 1,
      lastConnectionStatus: "failed",
    });
    const b = {
      ...a,
      workspacePath: "/repo/b",
      workspaceIdentity: "remote:server:source-a:/repo/b",
    };
    const input = {
      sessions: [a, b],
      tabs: [
        createWorkspaceTab({
          id: "manual-tab",
          workspacePath: a.workspacePath,
          workspaceIdentity: a.workspaceIdentity,
        }),
        createWorkspaceTab({
          id: "sibling-tab",
          workspacePath: b.workspacePath,
          workspaceIdentity: b.workspaceIdentity,
        }),
      ],
      attemptedWorkspaceKeys: new Set<string>(),
      onlineSourceServerIds: new Set(["source-a"]),
      manuallyOpeningWorkspaceTabId: "manual-tab",
    };
    expect(collectStartupRemoteWorkspaceReconnectGroups(input)).toEqual([
      { sourceServerId: "source-a", entries: [b] },
    ]);
    expect(
      collectStartupRemoteWorkspaceReconnectGroups({
        ...input,
        manuallyOpeningWorkspaceTabId: undefined,
      }),
    ).toEqual([{ sourceServerId: "source-a", entries: [a, b] }]);
  });

  it("keeps reconnect dedupe while another line still holds the Source online", () => {
    const workspace = createRemoteWorkspaceSessionEntry({
      workspacePath: "/repo/a",
      workspaceIdentity: "remote:server:source-a:/repo/a",
      lastConnectionStatus: "connected",
    });
    const workspaceKey = buildWorkspaceSessionKey(workspace);
    const attemptedWorkspaceKeys = new Set([workspaceKey]);

    updateStartupRemoteWorkspaceReconnectAttemptsForSourceState({
      state: { state: "offline", sourceServerId: "source-a" },
      onlineSourceServerIds: new Set(["source-a"]),
      sessions: [workspace],
      attemptedWorkspaceKeys,
    });

    expect(attemptedWorkspaceKeys).toContain(workspaceKey);
  });

  it("prunes legacy, live, offline Source and already-attempted histories but restores failed and stale history", () => {
    const now = 10 * 24 * 60 * 60_000;
    const make = (sourceServerId: string, overrides: Partial<RemoteWorkspaceSessionEntry> = {}) =>
      createRemoteWorkspaceSessionEntry({
        workspacePath: `/repo/${sourceServerId}`,
        workspaceIdentity: `remote:server:${sourceServerId}:/repo/${sourceServerId}`,
        target: {
          kind: "ssh",
          host: `${sourceServerId}.test`,
          username: "dev",
        },
        lastOpenedAt: now - 60_000,
        lastConnectionStatus: "connected",
        ...overrides,
      });
    const live = make("live");
    const eligible = make("eligible");
    const sessions = [
      eligible,
      live,
      make("offline"),
      make("stale", { lastOpenedAt: now - 8 * 24 * 60 * 60_000 }),
      make("failed", { lastConnectionStatus: "failed" }),
      make("attempted"),
      createRemoteWorkspaceSessionEntry({
        workspacePath: "/repo/legacy",
        workspaceIdentity: "remote:ssh:legacy.test:22:dev:/repo/legacy",
        target: { kind: "ssh", host: "legacy.test", username: "dev" },
        lastOpenedAt: now - 60_000,
        lastConnectionStatus: "connected",
      }),
    ];

    expect(
      collectStartupRemoteWorkspaceReconnectGroups({
        sessions,
        tabs: sessions.map((entry, index) =>
          createWorkspaceTab({
            id: `tab-${index}`,
            workspacePath: entry.workspacePath,
            workspaceIdentity: entry.workspaceIdentity,
            ...(entry === live ? { remoteSessionId: "live-session" } : {}),
          }),
        ),
        attemptedWorkspaceKeys: new Set([buildWorkspaceSessionKey(sessions[5]!)]),
        onlineSourceServerIds: new Set(["eligible", "live", "stale", "failed", "attempted"]),
      }),
    ).toEqual([
      { sourceServerId: "eligible", entries: [eligible] },
      { sourceServerId: "stale", entries: [sessions[3]] },
      { sourceServerId: "failed", entries: [sessions[4]] },
    ]);
  });

  it("restores an open workspace whose lastOpenedAt is older than 7 days once its Source is online", () => {
    // RDUX-14：设备级 7 天门禁由 Host 启动重连持有；Renderer 挂回不再按工作区年龄过滤，
    // 否则同一设备下会出现部分 tab 上线、部分停留在未连接的割裂状态。
    const now = 30 * 24 * 60 * 60_000;
    const recent = createRemoteWorkspaceSessionEntry({
      workspacePath: "/repo/recent",
      workspaceIdentity: "remote:server:source-a:/repo/recent",
      target: { kind: "ssh", host: "example.test", username: "dev" },
      lastOpenedAt: now - 60_000,
      lastConnectionStatus: "connected",
    });
    const old = createRemoteWorkspaceSessionEntry({
      workspacePath: "/repo/old",
      workspaceIdentity: "remote:server:source-a:/repo/old",
      target: { kind: "ssh", host: "example.test", username: "dev" },
      lastOpenedAt: now - 20 * 24 * 60 * 60_000,
      lastConnectionStatus: "failed",
    });

    expect(
      collectStartupRemoteWorkspaceReconnectGroups({
        sessions: [recent, old],
        tabs: [
          createWorkspaceTab({
            workspacePath: recent.workspacePath,
            workspaceIdentity: recent.workspaceIdentity,
          }),
          createWorkspaceTab({
            id: "tab-old",
            workspacePath: old.workspacePath,
            workspaceIdentity: old.workspaceIdentity,
          }),
        ],
        attemptedWorkspaceKeys: new Set(),
        onlineSourceServerIds: new Set(["source-a"]),
      }),
    ).toEqual([{ sourceServerId: "source-a", entries: [recent, old] }]);
  });
});

describe("reconnectRemoteWorkspaceGroup", () => {
  it("starts sibling workspaces as soon as the initiator Host is ready", async () => {
    const initiator = createRemoteWorkspaceSessionEntry({
      workspacePath: "/repo/a",
      workspaceIdentity: "remote:ssh:root@mac-studio:/repo/a",
      target: {
        kind: "ssh",
        host: "mac-studio",
        username: "root",
        passwordCredentialKey: "credential-a",
      },
    });
    const sibling = createRemoteWorkspaceSessionEntry({
      workspacePath: "/repo/b",
      workspaceIdentity: "remote:ssh:root@mac-studio:/repo/b",
      target: {
        kind: "ssh",
        host: "mac-studio",
        username: "root",
        passwordCredentialKey: "credential-b",
      },
    });
    let releaseInitiator!: () => void;
    const initiatorReady = new Promise<void>((resolve) => {
      releaseInitiator = resolve;
    });
    const reconnectEntry = vi.fn(
      async (entry: RemoteWorkspaceSessionEntry, options?: ReconnectRemoteWorkspaceOptions) => {
        if (entry === initiator) {
          options?.onSshHostReady?.({
            password: "initiator-password",
            privateKeyPassphrase: null,
          });
          await initiatorReady;
        }
        return true;
      },
    );

    const reconnectPromise = reconnectRemoteWorkspaceGroup({
      selected: initiator,
      reconnectGroup: [initiator, sibling],
      reconnectEntry,
      options: { throwOnFailure: false },
    });

    await vi.waitFor(() => expect(reconnectEntry).toHaveBeenCalledTimes(2));
    expect(reconnectEntry).toHaveBeenNthCalledWith(
      1,
      initiator,
      expect.objectContaining({
        throwOnFailure: true,
        onSshHostReady: expect.any(Function),
      }),
    );
    expect(reconnectEntry).toHaveBeenNthCalledWith(
      2,
      sibling,
      expect.objectContaining({
        activateWorkspaceAfterReconnect: false,
        sshCredentialsOverride: {
          password: "initiator-password",
          privateKeyPassphrase: null,
        },
      }),
    );

    releaseInitiator();
    await reconnectPromise;
  });

  it("does not let a sibling retry with its credential after the initiator fails", async () => {
    const initiator = createRemoteWorkspaceSessionEntry({
      workspacePath: "/repo/a",
      workspaceIdentity: "remote:ssh:root@mac-studio:/repo/a",
      target: { kind: "ssh", host: "mac-studio", username: "root" },
    });
    const sibling = createRemoteWorkspaceSessionEntry({
      workspacePath: "/repo/b",
      workspaceIdentity: "remote:ssh:root@mac-studio:/repo/b",
      target: { kind: "ssh", host: "mac-studio", username: "root" },
    });
    const reconnectEntry = vi.fn(async () => {
      throw new Error("initiator credential rejected");
    });

    await expect(
      reconnectRemoteWorkspaceGroup({
        selected: initiator,
        reconnectGroup: [initiator, sibling],
        reconnectEntry,
        options: { throwOnFailure: false },
      }),
    ).resolves.toBeUndefined();

    expect(reconnectEntry).toHaveBeenCalledTimes(1);
    expect(reconnectEntry).toHaveBeenCalledWith(
      initiator,
      expect.objectContaining({ throwOnFailure: true }),
    );
  });

  it("does not reconnect siblings when the initiator request was skipped", async () => {
    const initiator = createRemoteWorkspaceSessionEntry({
      workspacePath: "/repo/a",
      workspaceIdentity: "remote:ssh:root@mac-studio:/repo/a",
      target: { kind: "ssh", host: "mac-studio", username: "root" },
    });
    const sibling = createRemoteWorkspaceSessionEntry({
      workspacePath: "/repo/b",
      workspaceIdentity: "remote:ssh:root@mac-studio:/repo/b",
      target: { kind: "ssh", host: "mac-studio", username: "root" },
    });
    const reconnectEntry = vi.fn(async () => false);

    await reconnectRemoteWorkspaceGroup({
      selected: initiator,
      reconnectGroup: [initiator, sibling],
      reconnectEntry,
    });

    expect(reconnectEntry).toHaveBeenCalledTimes(1);
  });

  it("keeps sibling initialization independent after the initiator Host is ready", async () => {
    const initiator = createRemoteWorkspaceSessionEntry({
      workspacePath: "/repo/a",
      workspaceIdentity: "remote:ssh:root@mac-studio:/repo/a",
      target: { kind: "ssh", host: "mac-studio", username: "root" },
    });
    const sibling = createRemoteWorkspaceSessionEntry({
      workspacePath: "/repo/b",
      workspaceIdentity: "remote:ssh:root@mac-studio:/repo/b",
      target: { kind: "ssh", host: "mac-studio", username: "root" },
    });
    const reconnectEntry = vi.fn(
      async (entry: RemoteWorkspaceSessionEntry, options?: ReconnectRemoteWorkspaceOptions) => {
        if (entry === initiator) {
          options?.onSshHostReady?.({
            password: "initiator-password",
            privateKeyPassphrase: null,
          });
          throw new Error("initiator provider sync failed");
        }
        return true;
      },
    );

    await expect(
      reconnectRemoteWorkspaceGroup({
        selected: initiator,
        reconnectGroup: [initiator, sibling],
        reconnectEntry,
        options: { throwOnFailure: false },
      }),
    ).resolves.toBeUndefined();

    expect(reconnectEntry).toHaveBeenCalledTimes(2);
  });
});

describe("restoreSourceRemoteWorkspaceGroup", () => {
  it("continues restoring siblings when an earlier member is already live", async () => {
    const live = createRemoteWorkspaceSessionEntry({
      workspacePath: "/repo/live",
      workspaceIdentity: "remote:server:source-a:/repo/live",
      lastConnectionStatus: "connected",
    });
    const disconnected = createRemoteWorkspaceSessionEntry({
      workspacePath: "/repo/disconnected",
      workspaceIdentity: "remote:server:source-a:/repo/disconnected",
      lastConnectionStatus: "failed",
    });
    const reconnectEntry = vi.fn(
      async (entry: RemoteWorkspaceSessionEntry) => entry === disconnected,
    );

    await restoreSourceRemoteWorkspaceGroup({
      entries: [live, disconnected],
      reconnectEntry,
      options: {
        activateWorkspaceAfterReconnect: false,
        showErrorToast: false,
        recoveryMode: "automatic",
      },
    });

    expect(reconnectEntry).toHaveBeenCalledTimes(2);
    expect(reconnectEntry).toHaveBeenNthCalledWith(1, live, {
      activateWorkspaceAfterReconnect: false,
      showErrorToast: false,
      recoveryMode: "automatic",
    });
    expect(reconnectEntry).toHaveBeenNthCalledWith(2, disconnected, {
      activateWorkspaceAfterReconnect: false,
      showErrorToast: false,
      recoveryMode: "automatic",
    });
  });
});

describe("resolveSourceRemoteConversationWorkspaceProjection", () => {
  it("ensures a missing Source conversation path and self-heals an exact open entry", async () => {
    const sourceServerId = "11111111-1111-4111-8111-111111111111";
    const conversationPath = "/home/dev/.zcode/workspace/default";
    const conversation = createRemoteWorkspaceSessionEntry({
      workspacePath: conversationPath,
      workspaceIdentity: `remote:server:${sourceServerId}:${conversationPath}`,
      workspacePurpose: "project",
    });
    const project = createRemoteWorkspaceSessionEntry({
      workspacePath: "/home/dev",
      workspaceIdentity: `remote:server:${sourceServerId}:/home/dev`,
      workspacePurpose: "project",
    });
    const ensureConversationWorkspace = vi.fn(async () => ({
      path: conversationPath,
      created: false,
      workspacePurpose: "conversation" as const,
    }));

    await expect(
      resolveSourceRemoteConversationWorkspaceProjection({
        sourceServerId,
        remoteSessions: [conversation, project],
        conversationWorkspaceMap: undefined,
        ensureConversationWorkspace,
      }),
    ).resolves.toEqual({
      conversationWorkspaceMap: {
        [sourceServerId]: {
          workspacePath: conversationPath,
          lastResolvedAt: expect.any(Number),
        },
      },
      remoteSessions: [{ ...conversation, workspacePurpose: "conversation" }, project],
      updatedEntries: [
        {
          workspacePath: conversationPath,
          workspaceIdentity: conversation.workspaceIdentity,
        },
      ],
    });
    expect(ensureConversationWorkspace).toHaveBeenCalledOnce();
  });
});

describe("cancelPendingRemoteReconnectsForWorkspaceKeys", () => {
  it("cancels and clears pending reconnect request ids for removed workspace keys", async () => {
    const pendingRequestIds = new Map([
      ["remote:docker:demo:/workspace/demo", "request-1"],
      ["remote:docker:keep:/workspace/keep", "request-2"],
    ]);
    const cancelPendingRemoteConnection = vi.fn(async () => undefined);
    const warn = vi.fn();

    await cancelPendingRemoteReconnectsForWorkspaceKeys({
      workspaceKeys: ["remote:docker:demo:/workspace/demo"],
      pendingRequestIds,
      cancelPendingRemoteConnection,
      logger: { warn },
    });

    expect(cancelPendingRemoteConnection).toHaveBeenCalledWith("request-1");
    expect(pendingRequestIds.has("remote:docker:demo:/workspace/demo")).toBe(false);
    expect(pendingRequestIds.get("remote:docker:keep:/workspace/keep")).toBe("request-2");
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("openRemoteWorkspaceFromHistoryEntry", () => {
  it("启动恢复阶段不会自动触发重连，只有用户主动打开远程历史才会重连", async () => {
    const sessionEntry = createRemoteWorkspaceSessionEntry();
    const context = createOpenRemoteWorkspaceContext({
      sessionEntry,
      tabs: [
        createWorkspaceTab({
          workspacePath: sessionEntry.workspacePath,
          workspaceIdentity: sessionEntry.workspaceIdentity,
        }),
      ],
    });

    // Bugfix: 这个场景验证“重连只由用户入口触发”，避免把源码实现细节固化为测试契约。
    expect(context.reconnectImpl).not.toHaveBeenCalled();
    expect(context.resetLogsForWorkspaceKey).not.toHaveBeenCalled();

    await openRemoteWorkspaceFromHistoryEntry(context.params);

    expect(context.resetLogsForWorkspaceKey).toHaveBeenCalledWith(context.workspaceKey);
    expect(context.reconnectImpl).toHaveBeenCalledTimes(1);
  });

  it("activates existing connected workspace tab instead of reconnecting", async () => {
    const sessionEntry = createRemoteWorkspaceSessionEntry();
    const context = createOpenRemoteWorkspaceContext({
      sessionEntry,
      tabs: [
        createWorkspaceTab({
          workspacePath: sessionEntry.workspacePath,
          workspaceIdentity: sessionEntry.workspaceIdentity,
          remoteSessionId: "session-live",
        }),
      ],
    });

    await openRemoteWorkspaceFromHistoryEntry(context.params);

    expect(context.activateTabByPath).toHaveBeenCalledWith("/workspace/demo", {
      workspaceIdentity: "remote:docker:demo:/workspace/demo",
    });
    expect(context.reconnectImpl).not.toHaveBeenCalled();
    expect(context.resetLogsForWorkspaceKey).not.toHaveBeenCalled();
  });

  it("reconnects disconnected remote history entry with selector options", async () => {
    const sessionEntry = createRemoteWorkspaceSessionEntry();
    const context = createOpenRemoteWorkspaceContext({
      sessionEntry,
      tabs: [
        createWorkspaceTab({
          workspacePath: sessionEntry.workspacePath,
          workspaceIdentity: sessionEntry.workspaceIdentity,
        }),
      ],
    });

    await openRemoteWorkspaceFromHistoryEntry(context.params);

    expect(context.inflightReconnectWorkspaceKeys.size).toBe(0);

    const reconnectArgs = context.reconnectImpl.mock.calls[0]?.[0];
    expect(reconnectArgs.options).toEqual({
      activateWorkspaceAfterReconnect: true,
      showErrorToast: true,
      requestId: undefined,
    });
    expect(reconnectArgs.onWorkspaceActivated).toEqual(expect.any(Function));
    expect(reconnectArgs.shouldKeepReconnectedWorkspace).toEqual(expect.any(Function));
  });

  it("commits a disconnected history tab, activation, and draft in order", async () => {
    const sessionEntry = createRemoteWorkspaceSessionEntry();
    const context = createOpenRemoteWorkspaceContext({
      sessionEntry,
      tabs: [
        createWorkspaceTab({
          workspacePath: sessionEntry.workspacePath,
          workspaceIdentity: sessionEntry.workspaceIdentity,
        }),
      ],
    });
    const addTab = vi.fn();
    const activateTabByPath = vi.fn(() => true);
    const onWorkspaceActivated = vi.fn();
    context.params.addTab = addTab;
    context.params.activateTabByPath = activateTabByPath;
    context.params.onWorkspaceActivated = onWorkspaceActivated;
    context.params.reconnectImpl = reconnectRemoteWorkspaceHistoryEntry;

    await openRemoteWorkspaceFromHistoryEntry(context.params);

    expect(addTab).toHaveBeenCalledWith(sessionEntry.workspacePath, {
      remoteSessionId: "session-1",
      remoteTarget: sessionEntry.target,
      workspaceIdentity: sessionEntry.workspaceIdentity,
      localWorkspacePath: undefined,
    });
    expect(activateTabByPath).toHaveBeenCalledWith(sessionEntry.workspacePath, {
      workspaceIdentity: sessionEntry.workspaceIdentity,
    });
    expect(onWorkspaceActivated).toHaveBeenCalledWith({
      workspacePath: sessionEntry.workspacePath,
      workspaceIdentity: sessionEntry.workspaceIdentity,
      restoreSelection: true,
    });
    expect(addTab.mock.invocationCallOrder[0]).toBeLessThan(
      activateTabByPath.mock.invocationCallOrder[0]!,
    );
    expect(activateTabByPath.mock.invocationCallOrder[0]).toBeLessThan(
      onWorkspaceActivated.mock.invocationCallOrder[0]!,
    );
  });

  it("skips duplicate reconnect requests while workspace is inflight", async () => {
    const context = createOpenRemoteWorkspaceContext();
    context.inflightReconnectWorkspaceKeys.add(context.workspaceKey);

    await openRemoteWorkspaceFromHistoryEntry(context.params);

    expect(context.reconnectImpl).not.toHaveBeenCalled();
    expect(context.resetLogsForWorkspaceKey).not.toHaveBeenCalled();
  });

  it("passes keep-check callback that reflects runtime tab removal", async () => {
    const sessionEntry = createRemoteWorkspaceSessionEntry({
      workspaceIdentity: "remote:docker:demo:/workspace/demo",
    });
    const context = createOpenRemoteWorkspaceContext({
      sessionEntry,
      tabs: [
        createWorkspaceTab({
          workspacePath: sessionEntry.workspacePath,
          workspaceIdentity: ` ${sessionEntry.workspaceIdentity} `,
        }),
      ],
    });

    context.params.reconnectImpl = vi.fn(async (reconnectParams) => {
      const shouldKeepReconnectedWorkspace = reconnectParams.shouldKeepReconnectedWorkspace;
      expect(shouldKeepReconnectedWorkspace).toEqual(expect.any(Function));
      expect(
        shouldKeepReconnectedWorkspace?.({
          workspacePath: sessionEntry.workspacePath,
          workspaceIdentity: sessionEntry.workspaceIdentity,
        }),
      ).toBe(true);

      context.setTabs([]);
      expect(
        shouldKeepReconnectedWorkspace?.({
          workspacePath: sessionEntry.workspacePath,
          workspaceIdentity: sessionEntry.workspaceIdentity,
        }),
      ).toBe(false);
    });

    await openRemoteWorkspaceFromHistoryEntry(context.params);

    expect(context.params.reconnectImpl).toHaveBeenCalledTimes(1);
  });
});

describe("source management directory subscription", () => {
  // 合同 §8.1.4 事件回调适配：目录写入（重命名/删线路/记录打开项目）不是重连信号。
  // 订阅逻辑在 hook 的 useEffect 闭包内、无法注入单测，沿用本文件既有的源码结构断言先例。
  it("refreshes without reconnecting on directory deltas while only online state deltas can reconnect", async () => {
    const source = await readFile(
      new URL("../src/root/useRemoteWorkspaceHistory.ts", import.meta.url),
      "utf8",
    );

    const directoryCallback =
      /sourceManagement\.onDidChangeDirectory\?\.\(\s*\(\) => \{([\s\S]*?)\}/u.exec(source)?.[1];
    expect(directoryCallback, "directory subscription must exist").toBeTruthy();
    // directory 事件：只走统一刷新队列（refreshSnapshot(false)），不得触发自动重连。
    expect(directoryCallback).toContain("refreshSnapshot(false)");
    expect(directoryCallback).not.toContain("attemptReconnect");
    expect(directoryCallback).not.toContain("runReconnectRemoteWorkspace");

    const stateCallback =
      /sourceManagement\.onDidChangeState\(\s*\(delta\) => \{([\s\S]*?)\}/u.exec(source)?.[1];
    expect(stateCallback, "state subscription must exist").toBeTruthy();
    // state 事件：保留增量 patch，但只有 online 才是启动恢复信号。
    expect(stateCallback).toContain("delta.state.profileId");
    expect(stateCallback).toContain("shouldAttemptStartupReconnectForSourceState");
    expect(stateCallback).toContain("attemptReconnect()");

    // 两路回调共享同一个 generation 判序变量，refresh 结果按低版本丢弃。
    expect(stateCallback).toContain("observedManagementGeneration");
    expect(source).toMatch(
      /refreshInFlight = sourceManagement\s*\.getSnapshot\(\)[\s\S]{0,400}?snapshot\.generation < observedManagementGeneration/u,
    );
  });
});

it("手动原地重连在密码缺失时交回凭据等待，不发起网络请求", async () => {
  const entry = createRemoteWorkspaceSessionEntry({
    target: { kind: "ssh", host: "dev", username: "dev", passwordCredentialKey: "missing" },
  });
  const connect = vi.fn(async () => "session");
  await expect(
    reconnectRemoteWorkspaceHistoryEntry({
      sessionEntry: entry,
      activateTabByPath: vi.fn(() => false),
      setReconnectingRemoteWorkspaceKeys: vi.fn(),
      loadCredential: vi.fn(async () => null),
      connectRemoteWorkspaceTarget: connect,
      resolveRemoteWorkspaceCanonicalPath: vi.fn(async () => entry.workspacePath),
      bindRemoteWorkspaceScope: createBindRemoteWorkspaceScopeMock(),
      disposeRemoteWorkspaceSession: vi.fn(async () => undefined),
      bindRemoteWorkspacePath: vi.fn(),
      bindRemoteWorkspaceIdentity: vi.fn(),
      upsertWorkspaceTab: vi.fn(),
      commitRemoteWorkspaceSessionMutation: vi.fn(async (mutation) => mutation.entry),
      getRemoteSessions: () => [entry],
      logger: { warn: vi.fn() },
      toast: vi.fn(),
      options: { requireStoredCredentials: true, throwOnFailure: true, showErrorToast: false },
    }),
  ).rejects.toMatchObject({ code: "credentials-required" });
  expect(connect).not.toHaveBeenCalled();
});

it("主动断开没有失败事实，不把正常关闭持久化成连接失败原因", async () => {
  const { isRemoteWorkspaceCloseFailure } = await import("@/root/useRemoteWorkspaceHistory.js");
  expect(isRemoteWorkspaceCloseFailure({ exitCode: null, signal: null })).toBe(false);
  expect(
    isRemoteWorkspaceCloseFailure({ exitCode: null, signal: null, error: "connection lost" }),
  ).toBe(true);
  expect(
    isRemoteWorkspaceCloseFailure({
      exitCode: null,
      signal: null,
      reasonCode: "remote-recovery-budget-exhausted",
    }),
  ).toBe(true);
});
