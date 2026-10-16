import { describe, expect, it, vi } from "vitest";
import {
  ZCODE_AGENT_MCP_STATUS_MODE_UNSUPPORTED_ERROR_CODE,
  type IMcpSyncService,
} from "@zcode/services";
import {
  buildMcpOAuthAuthorizationStatusRefreshOptions,
  buildPluginMcpServerStatusListKey,
  buildMcpOAuthAuthorizationStatusRefreshServers,
  buildPendingMcpOAuthAuthorizationRefreshKey,
  buildMcpServerStatusListKey,
  createMcpOAuthAuthorizationStatusRefreshDeadline,
  createMcpStatusListRefreshQueue,
  isMcpOAuthAuthorizationStatusRefreshExpired,
  resolveMcpStatusListRefreshSkipReason,
  shouldShowPluginMcpServersInMcpSettings,
  refreshMcpServerStatusList,
  transitionMcpAutoStatusListRefreshKey,
  transitionMcpOAuthAuthorizationPendingRefresh,
} from "../src/settings/McpSettingsSection.js";

describe("McpSettingsSection status list", () => {
  it("re-arms automatic refresh after the status key becomes empty", () => {
    const workspaceAKey = "workspace-a\neverything:enabled";
    const first = transitionMcpAutoStatusListRefreshKey("", workspaceAKey);
    expect(first).toEqual({
      lastRefreshKey: workspaceAKey,
      shouldRefresh: true,
    });

    const emptyWorkspace = transitionMcpAutoStatusListRefreshKey(
      first.lastRefreshKey,
      "",
    );
    expect(emptyWorkspace).toEqual({
      lastRefreshKey: "",
      shouldRefresh: false,
    });

    expect(
      transitionMcpAutoStatusListRefreshKey(
        emptyWorkspace.lastRefreshKey,
        workspaceAKey,
      ),
    ).toEqual({
      lastRefreshKey: workspaceAKey,
      shouldRefresh: true,
    });
  });

  it("loads statuses through mcp/list instead of automatic per-server probe", async () => {
    const beginServerStatusListRefresh = vi.fn(() => 7);
    const markServerStatusListRefreshFailed = vi.fn();
    const mergeServerStatusSnapshots = vi.fn();
    const listWorkspaceMcpServerStatuses = vi.fn(async () => ({
      statuses: {
        filesystem: {
          status: "connected",
          transport: "stdio",
          toolCount: 2,
          updatedAt: "2026-06-23T00:00:00.000Z",
        },
      },
    }));
    const mcpSyncService = {
      listWorkspaceMcpServerStatuses,
    } as unknown as Pick<IMcpSyncService, "listWorkspaceMcpServerStatuses">;

    await refreshMcpServerStatusList({
      beginServerStatusListRefresh,
      getCurrentWorkspaceKey: () => "ssh://dev/workspace",
      markServerStatusListRefreshFailed,
      mergeServerStatusSnapshots,
      mcpServers: [
        {
          name: "filesystem",
          command: "node",
          args: ["server.mjs"],
          env: [],
        },
      ],
      requestedWorkspaceKey: "ssh://dev/workspace",
      workspaceIdentity: "ssh://dev/workspace",
      workspacePath: "/workspace/app",
      mcpSyncService,
    });

    expect(beginServerStatusListRefresh).toHaveBeenCalledTimes(1);
    expect(beginServerStatusListRefresh).toHaveBeenCalledWith("connect");
    expect(listWorkspaceMcpServerStatuses).toHaveBeenCalledWith({
      workspacePath: "/workspace/app",
      workspaceIdentity: "ssh://dev/workspace",
      mcpServers: [
        {
          name: "filesystem",
          command: "node",
          args: ["server.mjs"],
          env: [],
        },
      ],
    });
    expect(markServerStatusListRefreshFailed).not.toHaveBeenCalled();
    expect(mergeServerStatusSnapshots).toHaveBeenCalledWith(
      {
        filesystem: {
          status: "connected",
          transport: "stdio",
          toolCount: 2,
          updatedAt: "2026-06-23T00:00:00.000Z",
        },
      },
      7,
      "connect",
    );
  });

  it("marks the current refresh failed when mcp/list rejects", async () => {
    const beginServerStatusListRefresh = vi.fn(() => 9);
    const markServerStatusListRefreshFailed = vi.fn();
    const mergeServerStatusSnapshots = vi.fn();
    const listWorkspaceMcpServerStatuses = vi.fn(async () => {
      throw new Error("agent unavailable");
    });
    const mcpSyncService = {
      listWorkspaceMcpServerStatuses,
    } as unknown as Pick<IMcpSyncService, "listWorkspaceMcpServerStatuses">;

    await expect(
      refreshMcpServerStatusList({
        beginServerStatusListRefresh,
        getCurrentWorkspaceKey: () => "/workspace/app",
        markServerStatusListRefreshFailed,
        mergeServerStatusSnapshots,
        requestedWorkspaceKey: "/workspace/app",
        workspacePath: "/workspace/app",
        mcpSyncService,
      }),
    ).rejects.toThrow("agent unavailable");

    expect(markServerStatusListRefreshFailed).toHaveBeenCalledWith(
      "agent unavailable",
      9,
      "connect",
    );
    expect(mergeServerStatusSnapshots).not.toHaveBeenCalled();
  });

  it("passes an explicit empty MCP server list to mcp/list", async () => {
    const beginServerStatusListRefresh = vi.fn(() => 11);
    const mergeServerStatusSnapshots = vi.fn();
    const listWorkspaceMcpServerStatuses = vi.fn(async () => ({ statuses: {} }));
    const mcpSyncService = {
      listWorkspaceMcpServerStatuses,
    } as unknown as Pick<IMcpSyncService, "listWorkspaceMcpServerStatuses">;

    await refreshMcpServerStatusList({
      beginServerStatusListRefresh,
      getCurrentWorkspaceKey: () => "/workspace/app",
      mergeServerStatusSnapshots,
      mcpServers: [],
      requestedWorkspaceKey: "/workspace/app",
      workspacePath: "/workspace/app",
      mcpSyncService,
    });

    expect(listWorkspaceMcpServerStatuses).toHaveBeenCalledWith({
      workspacePath: "/workspace/app",
      mcpServers: [],
    });
    expect(mergeServerStatusSnapshots).toHaveBeenCalledWith({}, 11, "connect");
  });

  it("passes status mode through status-only refreshes", async () => {
    const beginServerStatusListRefresh = vi.fn(() => 12);
    const mergeServerStatusSnapshots = vi.fn();
    const listWorkspaceMcpServerStatuses = vi.fn(async () => ({ statuses: {} }));
    const mcpSyncService = {
      listWorkspaceMcpServerStatuses,
    } as unknown as Pick<IMcpSyncService, "listWorkspaceMcpServerStatuses">;

    await refreshMcpServerStatusList({
      beginServerStatusListRefresh,
      getCurrentWorkspaceKey: () => "/workspace/app",
      mergeServerStatusSnapshots,
      mode: "status",
      mcpServers: [],
      requestedWorkspaceKey: "/workspace/app",
      workspacePath: "/workspace/app",
      mcpSyncService,
    });

    expect(listWorkspaceMcpServerStatuses).toHaveBeenCalledWith({
      workspacePath: "/workspace/app",
      mode: "status",
      mcpServers: [],
    });
    expect(beginServerStatusListRefresh).toHaveBeenCalledWith("status");
    expect(mergeServerStatusSnapshots).toHaveBeenCalledWith({}, 12, "status");
  });

  it("keeps status-only failures isolated from full refresh failure handling", async () => {
    const beginServerStatusListRefresh = vi.fn(() => 13);
    const markServerStatusListRefreshFailed = vi.fn();
    const mergeServerStatusSnapshots = vi.fn();
    const listWorkspaceMcpServerStatuses = vi.fn(async () => {
      throw new Error("temporary status failure");
    });
    const mcpSyncService = {
      listWorkspaceMcpServerStatuses,
    } as unknown as Pick<IMcpSyncService, "listWorkspaceMcpServerStatuses">;

    await expect(
      refreshMcpServerStatusList({
        beginServerStatusListRefresh,
        getCurrentWorkspaceKey: () => "/workspace/app",
        markServerStatusListRefreshFailed,
        mergeServerStatusSnapshots,
        mode: "status",
        mcpServers: [],
        requestedWorkspaceKey: "/workspace/app",
        workspacePath: "/workspace/app",
        mcpSyncService,
      }),
    ).rejects.toThrow("temporary status failure");

    expect(markServerStatusListRefreshFailed).toHaveBeenCalledWith(
      "temporary status failure",
      13,
      "status",
    );
    expect(mergeServerStatusSnapshots).not.toHaveBeenCalled();
  });

  it("recognizes unsupported status-only capability without recording a refresh failure", async () => {
    const beginServerStatusListRefresh = vi.fn(() => 14);
    const markServerStatusListRefreshFailed = vi.fn();
    const mergeServerStatusSnapshots = vi.fn();
    const listWorkspaceMcpServerStatuses = vi.fn(async () => {
      throw Object.assign(new Error("status-only unsupported"), {
        code: ZCODE_AGENT_MCP_STATUS_MODE_UNSUPPORTED_ERROR_CODE,
      });
    });
    const mcpSyncService = {
      listWorkspaceMcpServerStatuses,
    } as unknown as Pick<IMcpSyncService, "listWorkspaceMcpServerStatuses">;

    await expect(
      refreshMcpServerStatusList({
        beginServerStatusListRefresh,
        getCurrentWorkspaceKey: () => "/workspace/app",
        markServerStatusListRefreshFailed,
        mergeServerStatusSnapshots,
        mode: "status",
        mcpServers: [],
        requestedWorkspaceKey: "/workspace/app",
        workspacePath: "/workspace/app",
        mcpSyncService,
      }),
    ).resolves.toBe("status-mode-unsupported");

    expect(markServerStatusListRefreshFailed).not.toHaveBeenCalled();
    expect(mergeServerStatusSnapshots).not.toHaveBeenCalled();
  });

  it("does not send workspace A credentials through the workspace B service", async () => {
    const listWorkspaceMcpServerStatuses = vi.fn(async () => ({ statuses: {} }));
    const workspaceBService = {
      listWorkspaceMcpServerStatuses,
    } as unknown as Pick<IMcpSyncService, "listWorkspaceMcpServerStatuses">;

    await expect(
      refreshMcpServerStatusList({
        beginServerStatusListRefresh: vi.fn(() => 15),
        getCurrentWorkspaceKey: () => "ssh://dev/remote/workspace-b",
        mergeServerStatusSnapshots: vi.fn(),
        mode: "status",
        mcpServers: [
          {
            headers: [
              { name: "Authorization", value: "Bearer workspace-a-header-secret" },
            ],
            name: "http-a",
            oauth: {
              clientId: "workspace-a-client",
              clientSecret: "workspace-a-oauth-secret",
              type: "authorization_code",
            },
            type: "http",
            url: "https://workspace-a.example.test/mcp",
          },
        ],
        requestedWorkspaceKey: "/local/workspace-a",
        workspacePath: "/local/workspace-a",
        mcpSyncService: workspaceBService,
      }),
    ).resolves.toBe("stale-workspace");

    expect(listWorkspaceMcpServerStatuses).not.toHaveBeenCalled();
  });

  it("discards a legacy-agent error that arrives after switching workspaces", async () => {
    let currentWorkspaceKey = "/local/workspace-a";
    let rejectWorkspaceA!: (error: Error) => void;
    const markServerStatusListRefreshFailed = vi.fn();
    const mergeServerStatusSnapshots = vi.fn();
    const listWorkspaceMcpServerStatuses = vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectWorkspaceA = reject;
        }),
    );
    const mcpSyncService = {
      listWorkspaceMcpServerStatuses,
    } as unknown as Pick<IMcpSyncService, "listWorkspaceMcpServerStatuses">;

    const refresh = refreshMcpServerStatusList({
      beginServerStatusListRefresh: vi.fn(() => 15),
      getCurrentWorkspaceKey: () => currentWorkspaceKey,
      markServerStatusListRefreshFailed,
      mergeServerStatusSnapshots,
      mode: "status",
      mcpServers: [],
      requestedWorkspaceKey: "/local/workspace-a",
      workspacePath: "/local/workspace-a",
      mcpSyncService,
    });
    currentWorkspaceKey = "ssh://dev/remote/workspace-b";
    rejectWorkspaceA(
      Object.assign(new Error("status-only unsupported"), {
        code: ZCODE_AGENT_MCP_STATUS_MODE_UNSUPPORTED_ERROR_CODE,
      }),
    );

    await expect(refresh).resolves.toBe("stale-workspace");
    expect(markServerStatusListRefreshFailed).not.toHaveBeenCalled();
    expect(mergeServerStatusSnapshots).not.toHaveBeenCalled();
  });

  it("dedupes overlapping status refreshes and reruns once with latest input", async () => {
    const queue = createMcpStatusListRefreshQueue();
    let resolveFirst!: () => void;
    const runLatest = vi.fn(async () => {
      if (runLatest.mock.calls.length === 1) {
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
    });

    const first = queue.request(runLatest);
    const second = queue.request(runLatest);
    const third = queue.request(runLatest);

    await Promise.resolve();
    expect(runLatest).toHaveBeenCalledTimes(1);

    resolveFirst();
    await Promise.all([first, second, third]);

    expect(runLatest).toHaveBeenCalledTimes(2);
  });

  it("reruns overlapping status refresh with the latest runner", async () => {
    const queue = createMcpStatusListRefreshQueue();
    let resolveFirst!: () => void;
    const calls: string[] = [];
    const firstRunner = vi.fn(async () => {
      calls.push("first");
      await new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });
    });
    const secondRunner = vi.fn(async () => {
      calls.push("second");
    });

    const first = queue.request(firstRunner);
    const second = queue.request(secondRunner);

    await Promise.resolve();
    expect(calls).toEqual(["first"]);

    resolveFirst();
    await Promise.all([first, second]);

    expect(calls).toEqual(["first", "second"]);
    expect(firstRunner).toHaveBeenCalledTimes(1);
    expect(secondRunner).toHaveBeenCalledTimes(1);
  });

  it("drops queued and in-flight workspace A refreshes before workspace B can receive secrets", async () => {
    const queue = createMcpStatusListRefreshQueue();
    const workspaceAKey = "/local/workspace-a";
    const workspaceBKey = "ssh://dev/remote/workspace-b";
    let currentWorkspaceKey = workspaceAKey;
    let resolveWorkspaceA!: (value: { statuses: Record<string, never> }) => void;
    const workspaceAService = {
      listWorkspaceMcpServerStatuses: vi.fn(
        () =>
          new Promise<{ statuses: Record<string, never> }>((resolve) => {
            resolveWorkspaceA = resolve;
          }),
      ),
    } as unknown as Pick<IMcpSyncService, "listWorkspaceMcpServerStatuses">;
    const workspaceBService = {
      listWorkspaceMcpServerStatuses: vi.fn(async () => ({
        statuses: {
          "remote-b": {
            status: "connecting" as const,
            toolCount: 0,
            transport: "http" as const,
            updatedAt: "2026-07-10T00:00:00.000Z",
          },
        },
      })),
    } as unknown as Pick<IMcpSyncService, "listWorkspaceMcpServerStatuses">;
    const mergeServerStatusSnapshots = vi.fn();
    const workspaceAServers = [
      {
        args: [],
        command: "local-secret-server",
        env: [{ name: "API_KEY", value: "workspace-a-env-secret" }],
        name: "local-a",
      },
      {
        headers: [{ name: "Authorization", value: "Bearer workspace-a-header-secret" }],
        name: "http-a",
        oauth: {
          clientId: "workspace-a-client",
          clientSecret: "workspace-a-oauth-secret",
          type: "authorization_code" as const,
        },
        type: "http" as const,
        url: "https://workspace-a.example.test/mcp",
      },
    ];
    const workspaceBServers = [
      {
        headers: [{ name: "X-Workspace", value: "workspace-b" }],
        name: "remote-b",
        type: "http" as const,
        url: "https://workspace-b.example.test/mcp",
      },
    ];

    const first = queue.request(async () => {
      await refreshMcpServerStatusList({
        beginServerStatusListRefresh: vi.fn(() => 20),
        getCurrentWorkspaceKey: () => currentWorkspaceKey,
        mergeServerStatusSnapshots,
        mode: "status",
        mcpServers: workspaceAServers,
        requestedWorkspaceKey: workspaceAKey,
        workspacePath: "/local/workspace-a",
        mcpSyncService: workspaceAService,
      });
    });
    expect(workspaceAService.listWorkspaceMcpServerStatuses).toHaveBeenCalledTimes(1);

    currentWorkspaceKey = workspaceBKey;
    const second = queue.request(async () => {
      await refreshMcpServerStatusList({
        beginServerStatusListRefresh: vi.fn(() => 21),
        getCurrentWorkspaceKey: () => currentWorkspaceKey,
        mergeServerStatusSnapshots,
        mode: "status",
        mcpServers: workspaceBServers,
        requestedWorkspaceKey: workspaceBKey,
        workspaceIdentity: workspaceBKey,
        workspacePath: "/remote/workspace-b",
        mcpSyncService: workspaceBService,
      });
    });
    resolveWorkspaceA({ statuses: {} });
    await Promise.all([first, second]);

    expect(workspaceBService.listWorkspaceMcpServerStatuses).toHaveBeenCalledWith({
      mcpServers: workspaceBServers,
      mode: "status",
      workspaceIdentity: workspaceBKey,
      workspacePath: "/remote/workspace-b",
    });
    expect(JSON.stringify(workspaceBService.listWorkspaceMcpServerStatuses.mock.calls)).not.toContain(
      "workspace-a-",
    );
    expect(mergeServerStatusSnapshots).toHaveBeenCalledTimes(1);
    expect(mergeServerStatusSnapshots).toHaveBeenCalledWith(
      {
        "remote-b": {
          status: "connecting",
          toolCount: 0,
          transport: "http",
          updatedAt: "2026-07-10T00:00:00.000Z",
        },
      },
      21,
      "status",
    );
  });

  it("does not turn workspace A pending state into a workspace B follow-up", () => {
    const workspaceAServer = {
      headers: [{ name: "Authorization", value: "Bearer workspace-a-secret" }],
      name: "http-a",
      type: "http" as const,
      url: "https://workspace-a.example.test/mcp",
    };
    const workspaceBServer = {
      headers: [{ name: "X-Workspace", value: "workspace-b" }],
      name: "http-b",
      type: "http" as const,
      url: "https://workspace-b.example.test/mcp",
    };
    const workspaceAPending = transitionMcpOAuthAuthorizationPendingRefresh({
      activeWorkspaceKey: "/local/workspace-a",
      mcpServers: [workspaceAServer],
      pendingKey: "http-a:started-a",
      previous: null,
    });

    const workspaceBWithoutPending = transitionMcpOAuthAuthorizationPendingRefresh({
      activeWorkspaceKey: "ssh://dev/remote/workspace-b",
      mcpServers: [],
      pendingKey: "",
      previous: workspaceAPending.pending,
    });
    expect(workspaceBWithoutPending).toEqual({ followup: null, pending: null });

    const workspaceBPending = transitionMcpOAuthAuthorizationPendingRefresh({
      activeWorkspaceKey: "ssh://dev/remote/workspace-b",
      mcpServers: [workspaceBServer],
      pendingKey: "http-b:started-b",
      previous: null,
    });
    const workspaceBFollowup = transitionMcpOAuthAuthorizationPendingRefresh({
      activeWorkspaceKey: "ssh://dev/remote/workspace-b",
      mcpServers: [],
      now: () => 123,
      pendingKey: "",
      previous: workspaceBPending.pending,
    });
    expect(workspaceBFollowup.followup).toEqual({
      mcpServers: [workspaceBServer],
      refreshKey: "ssh://dev/remote/workspace-b:http-b:started-b:123",
      workspaceKey: "ssh://dev/remote/workspace-b",
    });
    const workspaceBStatusMerge = transitionMcpOAuthAuthorizationPendingRefresh({
      activeWorkspaceKey: "ssh://dev/remote/workspace-b",
      existingFollowup: workspaceBFollowup.followup,
      mcpServers: [],
      pendingKey: "",
      previous: null,
    });
    expect(workspaceBStatusMerge.followup).toBe(workspaceBFollowup.followup);
    expect(JSON.stringify(workspaceBFollowup)).not.toContain("workspace-a-");
  });

  it("expires pending OAuth status refreshes by wall-clock deadline", () => {
    const startedAt = 1_000;
    const deadline = createMcpOAuthAuthorizationStatusRefreshDeadline(() => startedAt);

    expect(deadline).toBe(startedAt + 5 * 60_000);

    expect(
      isMcpOAuthAuthorizationStatusRefreshExpired(deadline, () => deadline - 1),
    ).toBe(false);
    expect(
      isMcpOAuthAuthorizationStatusRefreshExpired(deadline, () => deadline),
    ).toBe(true);
    expect(
      isMcpOAuthAuthorizationStatusRefreshExpired(deadline, () => deadline + 30_000),
    ).toBe(true);
  });

  it("status list key changes for enable toggles but ignores display status", () => {
    const baseServer = {
      id: "zcodeagentmcp-global-broken",
      name: "broken",
      config: { type: "stdio" as const, command: "missing-mcp-command" },
      enabled: true,
      status: "unknown" as const,
      source: "zcodeagentmcp" as const,
      scope: "user" as const,
    };

    const enabledKey = buildMcpServerStatusListKey([baseServer]);
    const connectingKey = buildMcpServerStatusListKey([
      { ...baseServer, status: "connecting" as const },
    ]);
    const disabledKey = buildMcpServerStatusListKey([
      { ...baseServer, enabled: false },
    ]);

    expect(connectingKey).toBe(enabledKey);
    expect(disabledKey).not.toBe(enabledKey);
  });

  it("tracks pending OAuth authorization as a refresh trigger", () => {
    const pendingServer = {
      id: "zcodeagentmcp-global-figma",
      name: "figma",
      config: { type: "http" as const, url: "https://mcp.example.test/mcp" },
      enabled: true,
      status: "connecting" as const,
      source: "zcodeagentmcp" as const,
      scope: "user" as const,
      authorization: {
        authorizationUrl: "https://auth.example.test/authorize?state=state_test",
        startedAt: "2026-07-08T00:00:00.000Z",
        type: "oauth_authorization_code" as const,
      },
    };

    expect(buildPendingMcpOAuthAuthorizationRefreshKey([pendingServer])).toBe(
      "zcodeagentmcp-global-figma:2026-07-08T00:00:00.000Z",
    );
    expect(
      buildPendingMcpOAuthAuthorizationRefreshKey([
        { ...pendingServer, authorization: undefined },
      ]),
    ).toBe("");
    expect(
      buildPendingMcpOAuthAuthorizationRefreshKey([
        { ...pendingServer, enabled: false },
      ]),
    ).toBe("");
    expect(
      buildPendingMcpOAuthAuthorizationRefreshKey([
        { ...pendingServer, source: "claudeclimcp" as const },
      ]),
    ).toBe("");
    expect(
      buildPendingMcpOAuthAuthorizationRefreshKey([], {
        "plugin:canva:canva": {
          authorization: {
            authorizationUrl: "https://auth.example.test/authorize?state=plugin",
            startedAt: "2026-07-09T00:00:00.000Z",
            type: "oauth_authorization_code",
          },
          status: "connecting",
          toolCount: 0,
          transport: "http",
          updatedAt: "2026-07-09T00:00:00.000Z",
        },
      }),
    ).toBe("plugin:canva:canva:2026-07-09T00:00:00.000Z");
    expect(
      buildPendingMcpOAuthAuthorizationRefreshKey([], {
        canva: {
          authorization: {
            authorizationUrl: "https://auth.example.test/authorize?state=bare",
            startedAt: "2026-07-09T00:00:01.000Z",
            type: "oauth_authorization_code",
          },
          status: "connecting",
          toolCount: 0,
          transport: "http",
          updatedAt: "2026-07-09T00:00:01.000Z",
        },
      }),
    ).toBe("canva:2026-07-09T00:00:01.000Z");
  });

  it("limits OAuth status refresh to local MCP servers that need authorization", () => {
    expect(
      buildMcpOAuthAuthorizationStatusRefreshServers(
        [
          {
            id: "zcodeagentmcp-global-figma",
            name: "figma",
            config: { type: "http" as const, url: "https://mcp.example.test/mcp" },
            enabled: true,
            status: "connecting" as const,
            source: "zcodeagentmcp" as const,
            scope: "user" as const,
          },
          {
            id: "zcodeagentmcp-global-everything",
            name: "everything",
            config: {
              type: "stdio" as const,
              command: "npx",
              args: ["@modelcontextprotocol/server-everything"],
            },
            enabled: true,
            status: "connected" as const,
            source: "zcodeagentmcp" as const,
            scope: "user" as const,
          },
        ],
        {
          figma: {
            authorization: {
              authorizationUrl: "https://auth.example.test/authorize?state=local",
              startedAt: "2026-07-09T00:00:00.000Z",
              type: "oauth_authorization_code",
            },
            status: "connecting",
            toolCount: 0,
            transport: "http",
            updatedAt: "2026-07-09T00:00:00.000Z",
          },
          "plugin:canva:canva": {
            authorization: {
              authorizationUrl: "https://auth.example.test/authorize?state=plugin",
              startedAt: "2026-07-09T00:00:01.000Z",
              type: "oauth_authorization_code",
            },
            status: "connecting",
            toolCount: 0,
            transport: "http",
            updatedAt: "2026-07-09T00:00:01.000Z",
          },
        },
      ),
    ).toEqual([
      {
        headers: [],
        name: "figma",
        type: "http",
        url: "https://mcp.example.test/mcp",
      },
    ]);
  });

  it("uses an explicit empty local MCP list for plugin-only OAuth refresh", () => {
    expect(
      buildMcpOAuthAuthorizationStatusRefreshServers([], {
        "plugin:canva:canva": {
          authorization: {
            authorizationUrl: "https://auth.example.test/authorize?state=plugin",
            startedAt: "2026-07-09T00:00:01.000Z",
            type: "oauth_authorization_code",
          },
          status: "connecting",
          toolCount: 0,
          transport: "http",
          updatedAt: "2026-07-09T00:00:01.000Z",
        },
      }),
    ).toEqual([]);
  });

  it("builds status-only options for OAuth pending, follow-up and focus refreshes", () => {
    const mcpServers = [
      {
        headers: [],
        name: "canva",
        type: "http" as const,
        url: "https://mcp.canva.example.test/mcp",
      },
    ];

    expect(buildMcpOAuthAuthorizationStatusRefreshOptions(mcpServers)).toEqual({
      mode: "status",
      mcpServers,
    });
  });

  it("includes enabled plugin MCP declarations in the status refresh key", () => {
    expect(
      buildPluginMcpServerStatusListKey([
        {
          commandRootCount: 0,
          declaredMcpServerNames: ["canva"],
          enabled: true,
          id: "canva@zcode-plugins-official",
          marketplace: "zcode-plugins-official",
          mcpServerNames: ["plugin:canva:canva"],
          name: "canva",
          rootPath: "/plugins/canva",
          skillRootCount: 0,
          source: "official",
        },
      ]),
    ).toBe("canva@zcode-plugins-official:enabled:canva:plugin:canva:canva");
    expect(
      buildPluginMcpServerStatusListKey([
        {
          commandRootCount: 0,
          declaredMcpServerNames: ["canva"],
          enabled: false,
          id: "canva@zcode-plugins-official",
          marketplace: "zcode-plugins-official",
          mcpServerNames: ["plugin:canva:canva"],
          name: "canva",
          rootPath: "/plugins/canva",
          skillRootCount: 0,
          source: "official",
        },
      ]),
    ).toBe("");
  });

  it("hides local plugin MCP servers in SSH remote workspace settings", () => {
    expect(shouldShowPluginMcpServersInMcpSettings(true)).toBe(false);
    expect(shouldShowPluginMcpServersInMcpSettings(false)).toBe(true);
  });

  // Bugfix 回归：刷新按钮点了没反应时，必须能区分"没发请求"和"发了但状态没变"。
  // 空 serverStatusListKey 只允许拦住自动刷新，用户手动点击必须真的发出请求。
  describe("refresh skip reasons", () => {
    const readyInput = {
      activeWorkspaceKey: "/workspace",
      activeWorkspacePath: "/workspace",
      configReadyWorkspaceKey: "/workspace",
      isConfigLoaded: true,
      serverStatusListKey: "filesystem:enabled:{}",
      storeWorkspaceKey: "/workspace",
    };

    it("allows a fully aligned refresh from both triggers", () => {
      for (const trigger of ["auto", "manual"] as const) {
        expect(
          resolveMcpStatusListRefreshSkipReason({
            input: readyInput,
            requestedWorkspaceKey: "/workspace",
            trigger,
          }),
        ).toBeUndefined();
      }
    });

    it("only blocks an empty status list key for automatic refreshes", () => {
      const input = { ...readyInput, serverStatusListKey: "" };
      expect(
        resolveMcpStatusListRefreshSkipReason({
          input,
          requestedWorkspaceKey: "/workspace",
          trigger: "auto",
        }),
      ).toBe("empty-status-list-key");
      expect(
        resolveMcpStatusListRefreshSkipReason({
          input,
          requestedWorkspaceKey: "/workspace",
          trigger: "manual",
        }),
      ).toBeUndefined();
    });

    it("keeps workspace alignment guards for manual refreshes", () => {
      expect(
        resolveMcpStatusListRefreshSkipReason({
          input: readyInput,
          requestedWorkspaceKey: "",
          trigger: "manual",
        }),
      ).toBe("no-active-workspace");
      expect(
        resolveMcpStatusListRefreshSkipReason({
          input: { ...readyInput, storeWorkspaceKey: "/other" },
          requestedWorkspaceKey: "/workspace",
          trigger: "manual",
        }),
      ).toBe("mcp-store-not-aligned");
      expect(
        resolveMcpStatusListRefreshSkipReason({
          input: { ...readyInput, configReadyWorkspaceKey: "" },
          requestedWorkspaceKey: "/workspace",
          trigger: "manual",
        }),
      ).toBe("config-not-ready");
      expect(
        resolveMcpStatusListRefreshSkipReason({
          input: { ...readyInput, isConfigLoaded: false },
          requestedWorkspaceKey: "/workspace",
          trigger: "manual",
        }),
      ).toBe("config-not-loaded");
    });
  });
});
