import { describe, expect, it, vi } from "vitest";
import type { RemoteWorkspaceSessionEntry } from "@zcode/shared";
import type { WindowTabState } from "@/store/tabStore.js";
import type { ReconnectRemoteWorkspaceOptions } from "@/root/reconnectRemoteWorkspaceHistoryEntry.js";
import {
  bindRemoteWorkspaceContextAndGetSession,
  cancelPendingRemoteReconnectsForWorkspaceKeys,
  collectSshReconnectGroup,
  openRemoteWorkspaceFromHistoryEntry,
  reconnectRemoteWorkspaceByKey,
  reconnectRemoteWorkspaceHistoryEntry,
  reconnectRemoteWorkspaceGroup,
  resolveBotRemoteWorkspaceReconnectedIdentity,
  shouldPersistRemoteWorkspaceFailure,
  selectRemoteWorkspaceProjectFromDialog,
} from "@/root/useRemoteWorkspaceHistory.js";
import {
  registerRemoteWorkspaceSession,
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
    disposeRemoteWorkspaceSession: vi.fn(async () => undefined),
    bindRemoteWorkspaceSessionContext: vi.fn(async () => undefined),
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

describe("reconnectRemoteWorkspaceHistoryEntry", () => {
  describe("resolveBotRemoteWorkspaceReconnectedIdentity", () => {
    it("keeps the bot event workspace identity when canonical path differs", () => {
      const eventWorkspaceIdentity = "remote:docker:demo:/workspace/link";
      const canonicalIdentity = buildRemoteWorkspaceIdentity("/workspace/real", {
        kind: "docker",
        container: "demo",
      });

      const resolvedIdentity = resolveBotRemoteWorkspaceReconnectedIdentity({
        event: {
          workspaceIdentity: eventWorkspaceIdentity,
        },
        resolvedWorkspacePath: "/workspace/real",
        target: {
          kind: "docker",
          container: "demo",
        },
      });

      expect(resolvedIdentity).toBe(eventWorkspaceIdentity);
      expect(resolvedIdentity).not.toBe(canonicalIdentity);
    });

    it("falls back to canonical identity when the bot event identity is blank", () => {
      const target = {
        kind: "docker" as const,
        container: "demo",
      };
      const expectedIdentity = buildRemoteWorkspaceIdentity("/workspace/real", target);

      const resolvedIdentity = resolveBotRemoteWorkspaceReconnectedIdentity({
        event: {
          workspaceIdentity: "  ",
        },
        resolvedWorkspacePath: "/workspace/real",
        target,
      });

      expect(resolvedIdentity).toBe(expectedIdentity);
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
      disposeRemoteWorkspaceSession,
      bindRemoteWorkspaceSessionContext: vi.fn(async () => undefined),
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

  it("canonical path 与历史记录一致时不再重复绑定 main context", async () => {
    // connect 已携带历史记录的 path/identity，descriptor 与 tab 一致，不应再触发一次 attachment 换代。
    const bindRemoteWorkspaceSessionContext = vi.fn(async () => undefined);
    const sessionEntry = createRemoteWorkspaceSessionEntry();

    await reconnectRemoteWorkspaceHistoryEntry({
      sessionEntry,
      activateTabByPath: vi.fn(() => true),
      setReconnectingRemoteWorkspaceKeys: vi.fn((updater) => updater([])),
      loadCredential: vi.fn(async () => null),
      connectRemoteWorkspaceTarget: vi.fn(async () => "session-1"),
      resolveRemoteWorkspaceCanonicalPath: vi.fn(async () => sessionEntry.workspacePath),
      disposeRemoteWorkspaceSession: vi.fn(async () => undefined),
      bindRemoteWorkspaceSessionContext,
      bindRemoteWorkspacePath: vi.fn(),
      bindRemoteWorkspaceIdentity: vi.fn(),
      upsertWorkspaceTab: vi.fn(),
      commitRemoteWorkspaceSessionMutation: vi.fn(async (mutation) => mutation.entry),
      getRemoteSessions: () => [sessionEntry],
      logger: { warn: vi.fn() },
      toast: vi.fn(),
    });

    expect(bindRemoteWorkspaceSessionContext).not.toHaveBeenCalled();
  });

  it("canonical path 与历史记录不一致时，先重新绑定 main context 再回填 tab", async () => {
    // Bugfix 回归：手机桥接用 tab 上的 canonical path/identity 比对 main descriptor，
    // 重连时 descriptor 只有历史记录里的旧路径，realpath 归一化后不同就必须 bind，否则桥接被拒。
    const target = { kind: "docker" as const, container: "demo" };
    const sessionEntry = createRemoteWorkspaceSessionEntry({
      workspacePath: "/dev",
      workspaceIdentity: buildRemoteWorkspaceIdentity("/dev", target),
      target,
    });
    const bindRemoteWorkspaceSessionContext = vi.fn(async () => undefined);
    const upsertWorkspaceTab = vi.fn();
    const disposeRemoteWorkspaceSession = vi.fn(async () => undefined);

    await reconnectRemoteWorkspaceHistoryEntry({
      sessionEntry,
      activateTabByPath: vi.fn(() => true),
      setReconnectingRemoteWorkspaceKeys: vi.fn((updater) => updater([])),
      loadCredential: vi.fn(async () => null),
      connectRemoteWorkspaceTarget: vi.fn(async () => "session-1"),
      resolveRemoteWorkspaceCanonicalPath: vi.fn(async () => "/home/dev"),
      disposeRemoteWorkspaceSession,
      bindRemoteWorkspaceSessionContext,
      bindRemoteWorkspacePath: vi.fn(),
      bindRemoteWorkspaceIdentity: vi.fn(),
      upsertWorkspaceTab,
      commitRemoteWorkspaceSessionMutation: vi.fn(async (mutation) => mutation.entry),
      getRemoteSessions: () => [sessionEntry],
      logger: { warn: vi.fn() },
      toast: vi.fn(),
    });

    const expectedWorkspaceIdentity = buildRemoteWorkspaceIdentity("/home/dev", target);
    expect(bindRemoteWorkspaceSessionContext).toHaveBeenCalledWith({
      sessionId: "session-1",
      workspacePath: "/home/dev",
      workspaceIdentity: expectedWorkspaceIdentity,
    });
    expect(bindRemoteWorkspaceSessionContext.mock.invocationCallOrder[0]).toBeLessThan(
      upsertWorkspaceTab.mock.invocationCallOrder[0]!,
    );
    expect(upsertWorkspaceTab).toHaveBeenCalledWith("/home/dev", {
      remoteSessionId: "session-1",
      remoteTarget: target,
      workspaceIdentity: expectedWorkspaceIdentity,
      localWorkspacePath: undefined,
    });
    expect(disposeRemoteWorkspaceSession).not.toHaveBeenCalled();
  });

  it("重连时 main 绑定失败会回收 session 并按失败落库，不回填 tab", async () => {
    const target = { kind: "docker" as const, container: "demo" };
    const sessionEntry = createRemoteWorkspaceSessionEntry({
      workspacePath: "/dev",
      workspaceIdentity: buildRemoteWorkspaceIdentity("/dev", target),
      target,
    });
    const bindRemoteWorkspaceSessionContext = vi.fn(async () => {
      throw new Error("bind failed");
    });
    const upsertWorkspaceTab = vi.fn();
    const disposeRemoteWorkspaceSession = vi.fn(async () => undefined);
    const commitRemoteWorkspaceSessionMutation = vi.fn(async (mutation) => mutation.entry);
    const toast = vi.fn();

    await reconnectRemoteWorkspaceHistoryEntry({
      sessionEntry,
      activateTabByPath: vi.fn(() => true),
      setReconnectingRemoteWorkspaceKeys: vi.fn((updater) => updater([])),
      loadCredential: vi.fn(async () => null),
      connectRemoteWorkspaceTarget: vi.fn(async () => "session-1"),
      resolveRemoteWorkspaceCanonicalPath: vi.fn(async () => "/home/dev"),
      disposeRemoteWorkspaceSession,
      bindRemoteWorkspaceSessionContext,
      bindRemoteWorkspacePath: vi.fn(),
      bindRemoteWorkspaceIdentity: vi.fn(),
      upsertWorkspaceTab,
      commitRemoteWorkspaceSessionMutation,
      getRemoteSessions: () => [sessionEntry],
      logger: { warn: vi.fn() },
      toast,
    });

    expect(disposeRemoteWorkspaceSession).toHaveBeenCalledWith("session-1");
    expect(upsertWorkspaceTab).not.toHaveBeenCalled();
    expect(commitRemoteWorkspaceSessionMutation).toHaveBeenCalledTimes(1);
    expect(commitRemoteWorkspaceSessionMutation.mock.calls[0]?.[0]?.entry).toMatchObject({
      lastConnectionStatus: "failed",
      lastConnectionError: "bind failed",
    });
    expect(toast).toHaveBeenCalledWith("bind failed");
  });

  it("用户在 bind main context 等待期间移除 tab 时，不回填 tab 并回收 session", async () => {
    // 回归锁定：保留校验与 upsertWorkspaceTab 之间不能再有 await，
    // 否则校验通过后用户在 bind 等待 ready ACK 期间移除 workspace，仍会被重新加回并落库 connected。
    const target = { kind: "docker" as const, container: "demo" };
    const sessionEntry = createRemoteWorkspaceSessionEntry({
      workspacePath: "/dev",
      workspaceIdentity: buildRemoteWorkspaceIdentity("/dev", target),
      target,
    });
    let workspaceTabPresent = true;
    const shouldKeepReconnectedWorkspace = vi.fn(() => workspaceTabPresent);
    const bindRemoteWorkspaceSessionContext = vi.fn(async () => {
      workspaceTabPresent = false;
    });
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
      disposeRemoteWorkspaceSession,
      bindRemoteWorkspaceSessionContext,
      bindRemoteWorkspacePath: vi.fn(),
      bindRemoteWorkspaceIdentity: vi.fn(),
      upsertWorkspaceTab,
      commitRemoteWorkspaceSessionMutation,
      getRemoteSessions: () => [sessionEntry],
      logger: { warn: vi.fn() },
      toast: vi.fn(),
      shouldKeepReconnectedWorkspace,
    });

    expect(bindRemoteWorkspaceSessionContext).toHaveBeenCalledTimes(1);
    expect(shouldKeepReconnectedWorkspace.mock.invocationCallOrder[0]).toBeGreaterThan(
      bindRemoteWorkspaceSessionContext.mock.invocationCallOrder[0]!,
    );
    expect(upsertWorkspaceTab).not.toHaveBeenCalled();
    expect(disposeRemoteWorkspaceSession).toHaveBeenCalledWith("session-1");
    expect(commitRemoteWorkspaceSessionMutation).not.toHaveBeenCalled();
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
      disposeRemoteWorkspaceSession: vi.fn(async () => undefined),
      bindRemoteWorkspaceSessionContext: vi.fn(async () => undefined),
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
        disposeRemoteWorkspaceSession,
        bindRemoteWorkspaceSessionContext: vi.fn(async () => undefined),
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
      disposeRemoteWorkspaceSession,
      bindRemoteWorkspaceSessionContext: vi.fn(async () => undefined),
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
      disposeRemoteWorkspaceSession,
      bindRemoteWorkspaceSessionContext: vi.fn(async () => undefined),
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
      disposeRemoteWorkspaceSession,
      bindRemoteWorkspaceSessionContext: vi.fn(async () => undefined),
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
      disposeRemoteWorkspaceSession,
      bindRemoteWorkspaceSessionContext: vi.fn(async () => undefined),
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

  it("skips workspace activation for background reconnect while still updating tab metadata", async () => {
    const activateTabByPath = vi.fn(() => true);
    const setReconnectingRemoteWorkspaceKeys = vi.fn((updater) => {
      updater([]);
      updater(["remote:docker:demo:/workspace/demo"]);
    });
    const loadCredential = vi.fn(async () => null);
    const connectRemoteWorkspaceTarget = vi.fn(async () => "session-1");
    const resolveRemoteWorkspaceCanonicalPath = vi.fn(async () => "/workspace/demo");
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
      disposeRemoteWorkspaceSession,
      bindRemoteWorkspaceSessionContext: vi.fn(async () => undefined),
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

describe("selectRemoteWorkspaceProjectFromDialog", () => {
  it("commits the remote draft before task-list refresh settles", async () => {
    const target = {
      kind: "docker" as const,
      container: "demo",
    };
    const workspacePath = "/workspace/demo";
    const workspaceIdentity = buildRemoteWorkspaceIdentity(workspacePath, target);
    let resolveRefresh!: () => void;
    const pendingRefresh = new Promise<void>((resolve) => {
      resolveRefresh = resolve;
    });
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
      bindRemoteWorkspaceSessionContext: vi.fn(async () => undefined),
      commitRemoteWorkspaceSessionMutation: vi.fn(async (mutation) => mutation.entry),
      getRemoteSessions: () => [],
      bindRemoteWorkspacePath: vi.fn(),
      bindRemoteWorkspaceIdentity: vi.fn(),
      addTab: vi.fn(),
      onWorkspaceActivated,
      refreshPinnedTasks: vi.fn(() => pendingRefresh),
      refreshTimelineTasks: vi.fn(() => pendingRefresh),
    }).then(() => {
      selectionSettled = true;
    });

    await vi.waitFor(() => {
      expect(onWorkspaceActivated).toHaveBeenCalledWith({
        workspacePath,
        workspaceIdentity,
      });
    });
    expect(selectionSettled).toBe(false);

    resolveRefresh();
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
    const commitRemoteWorkspaceSessionMutation = vi.fn(async (mutation) => mutation.entry);
    const bindWorkspacePath = vi.fn();
    const bindWorkspaceIdentity = vi.fn();
    const addTab = vi.fn();
    const refreshPinnedTasks = vi.fn(async () => undefined);
    const refreshTimelineTasks = vi.fn(async () => undefined);
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
      bindRemoteWorkspaceSessionContext: vi.fn(async () => undefined),
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
      refreshPinnedTasks,
      refreshTimelineTasks,
    } as Parameters<typeof selectRemoteWorkspaceProjectFromDialog>[0] & {
      localWorkspacePath: string;
    });

    expect(activateTabByPath).not.toHaveBeenCalled();
    expect(handleCancelRemoteProject).not.toHaveBeenCalled();
    expect(bindWorkspacePath).toHaveBeenCalledWith(workspacePath, remoteSession.sessionId);
    expect(bindWorkspaceIdentity).toHaveBeenCalledWith(workspaceIdentity, remoteSession.sessionId);
    expect(addTab).toHaveBeenCalledWith(workspacePath, {
      remoteSessionId: remoteSession.sessionId,
      remoteTarget: target,
      workspaceIdentity,
      localWorkspacePath,
    });
    expect(commitRemoteWorkspaceSessionMutation).toHaveBeenCalledTimes(1);
    const committedMutation = commitRemoteWorkspaceSessionMutation.mock.calls[0]?.[0];
    expect(committedMutation).toBeDefined();
    const committedEntry = committedMutation?.entry as { localWorkspacePath?: string } | undefined;
    expect(committedEntry).toBeDefined();
    expect(committedEntry?.localWorkspacePath).toBe(localWorkspacePath);
    expect(refreshPinnedTasks).toHaveBeenCalledWith({
      sessionId: remoteSession.sessionId,
      workspacePath,
      workspaceIdentity,
    });
    expect(refreshTimelineTasks).toHaveBeenCalledWith({
      sessionId: remoteSession.sessionId,
      workspacePath,
      workspaceIdentity,
    });
  });

  it("提交 connected 历史与 addTab 之前，先把 canonical context 绑定到 main 的 logical session", async () => {
    // Bugfix 回归（3.12.0 手机远控连不上 WSL 项目）：新建连接不带 context，main descriptor 停留在 "/"，
    // 且 UI 用未解析的 {kind:"wsl"} 算出的 identity 与 Host 用解析后 target 算出的不同。
    // 选目录后必须把 tab 将要使用的 path/identity 绑定回 main，手机桥接的三元校验才能通过。
    const connectionTarget = { kind: "wsl" as const };
    const workspacePath = "/home/dev";
    const workspaceIdentity = buildRemoteWorkspaceIdentity(workspacePath, connectionTarget);
    const bindRemoteWorkspaceSessionContext = vi.fn(async () => undefined);
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
      bindRemoteWorkspaceSessionContext,
      commitRemoteWorkspaceSessionMutation,
      getRemoteSessions: () => [],
      bindRemoteWorkspacePath: vi.fn(),
      bindRemoteWorkspaceIdentity: vi.fn(),
      addTab,
      refreshPinnedTasks: vi.fn(async () => undefined),
      refreshTimelineTasks: vi.fn(async () => undefined),
    });

    expect(workspaceIdentity).toBe("remote:wsl:default:/home/dev");
    expect(bindRemoteWorkspaceSessionContext).toHaveBeenCalledWith({
      sessionId: "session-1",
      workspacePath,
      workspaceIdentity,
    });
    expect(bindRemoteWorkspaceSessionContext.mock.invocationCallOrder[0]).toBeLessThan(
      commitRemoteWorkspaceSessionMutation.mock.invocationCallOrder[0]!,
    );
    expect(bindRemoteWorkspaceSessionContext.mock.invocationCallOrder[0]).toBeLessThan(
      addTab.mock.invocationCallOrder[0]!,
    );
    expect(addTab).toHaveBeenCalledWith(workspacePath, {
      remoteSessionId: "session-1",
      remoteTarget: connectionTarget,
      workspaceIdentity,
      localWorkspacePath: undefined,
    });
    expect(handleCancelRemoteProject).not.toHaveBeenCalled();
  });

  it("main 绑定 canonical context 失败时回收 session，不落库也不建 tab", async () => {
    // descriptor 与 tab 不一致的 session 正是手机桥接被拒的根源，绑定失败必须 fail-closed。
    const target = { kind: "docker" as const, container: "demo" };
    const workspacePath = "/workspace/demo";
    const bindRemoteWorkspaceSessionContext = vi.fn(async () => {
      throw new Error("bind failed");
    });
    const commitRemoteWorkspaceSessionMutation = vi.fn(async (mutation) => mutation.entry);
    const handleCancelRemoteProject = vi.fn(async () => undefined);
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
        handleCancelRemoteProject,
        bindRemoteWorkspaceSessionContext,
        commitRemoteWorkspaceSessionMutation,
        getRemoteSessions: () => [],
        bindRemoteWorkspacePath: vi.fn(),
        bindRemoteWorkspaceIdentity: vi.fn(),
        addTab,
        refreshPinnedTasks: vi.fn(async () => undefined),
        refreshTimelineTasks: vi.fn(async () => undefined),
      }),
    ).rejects.toThrow("bind failed");

    expect(handleCancelRemoteProject).toHaveBeenCalledWith("session-1");
    expect(commitRemoteWorkspaceSessionMutation).not.toHaveBeenCalled();
    expect(addTab).not.toHaveBeenCalled();
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
    const workspaceIdentity = buildRemoteWorkspaceIdentity(workspacePath, connectionTarget);
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
      bindRemoteWorkspaceSessionContext: vi.fn(async () => undefined),
      commitRemoteWorkspaceSessionMutation,
      getRemoteSessions: () => [],
      bindRemoteWorkspacePath: vi.fn(),
      bindRemoteWorkspaceIdentity: vi.fn(),
      addTab,
      refreshPinnedTasks: vi.fn(async () => undefined),
      refreshTimelineTasks: vi.fn(async () => undefined),
    });

    expect(addTab).toHaveBeenCalledWith(workspacePath, {
      remoteSessionId: "session-1",
      remoteTarget: sanitizedTarget,
      workspaceIdentity,
      localWorkspacePath: undefined,
    });
    const mutation = commitRemoteWorkspaceSessionMutation.mock.calls[0]?.[0];
    expect(mutation?.credentialsToSave).toEqual([
      expect.objectContaining({ value: "password-secret" }),
    ]);
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
