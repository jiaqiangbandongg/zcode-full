import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  setMcpStoreDirectoryService,
  setMcpStorePlatform,
  useMcpStore,
} from "@/store/mcpStore.js";
import { DEFAULT_MCP_CONFIG, MCP_CONFIG_KEY } from "@/store/mcpStoreHelpers.js";
import { logger } from "@/logger.js";

function createLocalStorageStub(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
  };
}

describe("mcpStore", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    setMcpStoreDirectoryService(null);
    setMcpStorePlatform(null);
    useMcpStore.setState((state) => ({
      ...state,
      config: { ...DEFAULT_MCP_CONFIG },
      nativeServers: [],
      servers: [],
      statusSnapshots: {},
      currentProjectPath: "",
      currentWorkspaceIdentity: undefined,
      enabledStates: {},
      deletedPreloadMcpServers: new Set(),
      isConfigLoaded: false,
      currentSessionId: null,
    }));
  });

  it("无 window 环境时，ensureLoadedForWorkspace 也不会抛错", async () => {
    const globalLike = globalThis as Record<string, unknown>;
    delete globalLike.window;

    await expect(
      useMcpStore.getState().ensureLoadedForWorkspace("/tmp/mcp-workspace"),
    ).resolves.toBe(false);
  });

  it("目录配置读取失败时保持现有 MCP，并返回未加载", async () => {
    vi.stubGlobal("window", {});
    const existingServer = {
      id: "zcodeagentmcp-global-everything",
      name: "everything",
      config: { type: "stdio" as const, command: "node", args: ["server.mjs"] },
      enabled: true,
      status: "connected" as const,
      source: "zcodeagentmcp" as const,
      scope: "user" as const,
      toolCount: 1,
    };
    setMcpStorePlatform({
      loadMcpFromUserDirectory: vi.fn(async () => {
        throw new SyntaxError("invalid MCP config");
      }),
      migrateLegacyCommonMcp: vi.fn(async () => ({
        importedCount: 0,
        servers: {},
        skippedCount: 0,
        totalCount: 0,
      })),
      saveMcpToUserDirectory: vi.fn(async () => ({ success: true })),
    });
    useMcpStore.setState({
      currentProjectPath: "/local/workspace",
      isConfigLoaded: true,
      servers: [existingServer],
    });

    await expect(
      useMcpStore.getState().ensureLoadedForWorkspace("/local/workspace"),
    ).resolves.toBe(false);
    expect(useMcpStore.getState().servers).toEqual([existingServer]);
  });

  it("传入目录服务时按当前 workspace 服务加载 MCP", async () => {
    vi.stubGlobal("window", {});
    const platformLoad = vi.fn(async () => ({
      servers: [
        {
          source: "zcodeagentmcp" as const,
          scope: "user" as const,
          name: "local-http",
          config: { type: "http" as const, url: "https://local.example.test/mcp" },
        },
      ],
    }));
    setMcpStorePlatform({
      loadMcpFromUserDirectory: platformLoad,
      migrateLegacyCommonMcp: vi.fn(async () => ({
        importedCount: 0,
        servers: {},
        skippedCount: 0,
        totalCount: 0,
      })),
      saveMcpToUserDirectory: vi.fn(async () => ({ success: true })),
    });
    const directoryService = {
      loadMcpFromUserDirectory: vi.fn(async () => ({
        servers: [
          {
            source: "zcodeagentmcp" as const,
            scope: "user" as const,
            name: "remote-http",
            config: { type: "http" as const, url: "https://remote.example.test/mcp" },
          },
        ],
      })),
      saveMcpToUserDirectory: vi.fn(async () => {}),
    };

    await useMcpStore
      .getState()
      .ensureLoadedForWorkspace("/remote/workspace", directoryService, "ssh:host:/remote/workspace");

    expect(directoryService.loadMcpFromUserDirectory).toHaveBeenCalledWith({
      workspacePath: "/remote/workspace",
    });
    expect(platformLoad).not.toHaveBeenCalled();
    expect(useMcpStore.getState().servers.map((server) => server.name)).toEqual([
      "remote-http",
    ]);
  });

  it("切换到远程 workspace 时立即清空本地配置并丢弃晚到的旧加载结果", async () => {
    vi.stubGlobal("window", {});
    let resolveLocalLoad!: (value: {
      servers: Array<{
        config: {
          command: string;
          env: Record<string, string>;
          type: "stdio";
        };
        name: string;
        scope: "user";
        source: "zcodeagentmcp";
      }>;
    }) => void;
    const platformLoad = vi.fn(
      () =>
        new Promise<{
          servers: Array<{
            config: {
              command: string;
              env: Record<string, string>;
              type: "stdio";
            };
            name: string;
            scope: "user";
            source: "zcodeagentmcp";
          }>;
        }>((resolve) => {
          resolveLocalLoad = resolve;
        }),
    );
    setMcpStorePlatform({
      loadMcpFromUserDirectory: platformLoad,
      migrateLegacyCommonMcp: vi.fn(async () => ({
        importedCount: 0,
        servers: {},
        skippedCount: 0,
        totalCount: 0,
      })),
      saveMcpToUserDirectory: vi.fn(async () => ({ success: true })),
    });
    const directoryService = {
      loadMcpFromUserDirectory: vi.fn(async () => ({
        servers: [
          {
            source: "zcodeagentmcp" as const,
            scope: "user" as const,
            name: "remote-b",
            config: {
              type: "http" as const,
              url: "https://workspace-b.example.test/mcp",
              headers: { "X-Workspace": "workspace-b" },
            },
          },
        ],
      })),
      saveMcpToUserDirectory: vi.fn(async () => {}),
    };

    const loadWorkspaceA = useMcpStore
      .getState()
      .ensureLoadedForWorkspace("/local/workspace-a");
    expect(platformLoad).toHaveBeenCalledTimes(1);

    const loadWorkspaceB = useMcpStore
      .getState()
      .ensureLoadedForWorkspace(
        "/remote/workspace-b",
        directoryService,
        "ssh://dev/remote/workspace-b",
      );
    expect(useMcpStore.getState().servers).toEqual([]);

    resolveLocalLoad({
      servers: [
        {
          source: "zcodeagentmcp",
          scope: "user",
          name: "local-a-secret",
          config: {
            type: "stdio",
            command: "local-secret-server",
            env: { API_KEY: "workspace-a-env-secret" },
          },
        },
      ],
    });
    await Promise.all([loadWorkspaceA, loadWorkspaceB]);

    expect(directoryService.loadMcpFromUserDirectory).toHaveBeenCalledWith({
      workspacePath: "/remote/workspace-b",
    });
    expect(useMcpStore.getState().servers.map((server) => server.name)).toEqual([
      "remote-b",
    ]);
    expect(JSON.stringify(useMcpStore.getState().servers)).not.toContain("workspace-a-");
  });

  it("远端 workspace attachment 绑定前不把预期断连记录成 MCP 警告", async () => {
    vi.stubGlobal("window", {});
    const disconnectedError = Object.assign(
      new Error("ZCODE_REMOTE_WORKSPACE_DISCONNECTED"),
      { code: "ZCODE_REMOTE_WORKSPACE_DISCONNECTED" },
    );
    const directoryService = {
      loadMcpFromUserDirectory: vi.fn(async () => {
        throw disconnectedError;
      }),
      saveMcpToUserDirectory: vi.fn(async () => {}),
    };
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    await useMcpStore
      .getState()
      .ensureLoadedForWorkspace(
        "/remote/workspace",
        directoryService,
        "remote:ssh:host:/remote/workspace",
      );

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("MCP 真实目录读取失败仍保留警告", async () => {
    vi.stubGlobal("window", {});
    const directoryService = {
      loadMcpFromUserDirectory: vi.fn(async () => {
        throw new Error("EACCES: permission denied");
      }),
      saveMcpToUserDirectory: vi.fn(async () => {}),
    };
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    await useMcpStore
      .getState()
      .ensureLoadedForWorkspace(
        "/remote/workspace",
        directoryService,
        "remote:ssh:host:/remote/workspace",
      );

    expect(warn).toHaveBeenCalledWith(
      "[mcpStore] loadMcpFromUserDirectory failed",
      "Error: EACCES: permission denied",
    );
    warn.mockRestore();
  });

  it("本地 workspace 即使存在目录服务也保留 platform 迁移 legacy common MCP", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal(
      "localStorage",
      createLocalStorageStub({
        [MCP_CONFIG_KEY]: JSON.stringify({
          mcp: {
            mcpServers: {
              legacyHttp: {
                type: "http",
                url: "https://legacy.example.test/mcp",
              },
            },
          },
        }),
      }),
    );
    const platformLoad = vi
      .fn()
      .mockResolvedValueOnce({ servers: [] })
      .mockResolvedValueOnce({
        servers: [
          {
            source: "zcodeagentmcp" as const,
            scope: "user" as const,
            name: "legacyHttp",
            config: {
              type: "http" as const,
              url: "https://legacy.example.test/mcp",
            },
          },
        ],
      });
    const platformSave = vi.fn(async () => ({ success: true }));
    setMcpStorePlatform({
      loadMcpFromUserDirectory: platformLoad,
      migrateLegacyCommonMcp: vi.fn(async () => ({
        importedCount: 0,
        servers: {},
        skippedCount: 0,
        totalCount: 0,
      })),
      saveMcpToUserDirectory: platformSave,
    });
    const directoryService = {
      loadMcpFromUserDirectory: vi.fn(async () => ({
        servers: [
          {
            source: "zcodeagentmcp" as const,
            scope: "user" as const,
            name: "remote-http",
            config: { type: "http" as const, url: "https://remote.example.test/mcp" },
          },
        ],
      })),
      saveMcpToUserDirectory: vi.fn(async () => {}),
    };
    setMcpStoreDirectoryService(directoryService);

    await useMcpStore
      .getState()
      .ensureLoadedForWorkspace("/local/workspace", directoryService);

    expect(directoryService.loadMcpFromUserDirectory).not.toHaveBeenCalled();
    expect(platformLoad).toHaveBeenCalledWith({ workspacePath: "/local/workspace" });
    expect(platformSave).toHaveBeenCalledWith({
      action: "upsert",
      source: "zcodeagentmcp",
      name: "legacyHttp",
      config: {
        type: "http",
        url: "https://legacy.example.test/mcp",
      },
    });
    expect(useMcpStore.getState().servers.map((server) => server.name)).toEqual([
      "legacyHttp",
    ]);
  });

  it("批量合并只更新 ZCode Agent MCP 行且清理 changed", () => {
    useMcpStore.setState({
      servers: [
        {
          id: "zcodeagentmcp-global-filesystem",
          name: "filesystem",
          config: { type: "stdio", command: "node", args: ["server.js"] },
          enabled: true,
          changed: true,
          status: "unknown",
          source: "zcodeagentmcp",
          scope: "user",
        },
        {
          id: "claudeclimcp-global-filesystem",
          name: "filesystem",
          config: { type: "stdio", command: "node", args: ["server.js"] },
          enabled: true,
          changed: true,
          status: "unknown",
          source: "claudeclimcp",
          scope: "user",
        },
      ],
    });

    const epoch = useMcpStore.getState().beginServerStatusListRefresh();
    useMcpStore.getState().mergeServerStatusSnapshots(
      {
        filesystem: {
          status: "connected",
          transport: "stdio",
          toolCount: 2,
          updatedAt: "2026-06-23T00:00:00.000Z",
        },
      },
      epoch,
    );

    const [zcodeServer, claudeServer] = useMcpStore.getState().servers;
    expect(zcodeServer).toMatchObject({
      status: "connected",
      toolCount: 2,
      changed: false,
    });
    expect(claudeServer).toMatchObject({
      status: "unknown",
      changed: true,
    });
  });

  it("批量状态结果会保留待授权 OAuth URL", () => {
    useMcpStore.setState({
      servers: [
        {
          id: "zcodeagentmcp-global-notion",
          name: "notion",
          config: {
            type: "http",
            url: "https://mcp.notion.example.test/mcp",
            oauth: { type: "authorization_code" },
          },
          enabled: true,
          changed: true,
          status: "unknown",
          source: "zcodeagentmcp",
          scope: "user",
        },
      ],
    });

    const epoch = useMcpStore.getState().beginServerStatusListRefresh();
    useMcpStore.getState().mergeServerStatusSnapshots(
      {
        notion: {
          authorization: {
            authorizationUrl: "https://auth.example.test/authorize?state=state_test",
            startedAt: "2026-06-23T00:00:00.000Z",
            type: "oauth_authorization_code",
          },
          status: "connecting",
          transport: "http",
          toolCount: 0,
          updatedAt: "2026-06-23T00:00:00.000Z",
        },
      },
      epoch,
    );

    expect(useMcpStore.getState().servers[0]).toMatchObject({
      authorization: {
        authorizationUrl: "https://auth.example.test/authorize?state=state_test",
        type: "oauth_authorization_code",
      },
      status: "connecting",
    });
  });

  it("status-only 状态结果会 patch merge 并保留其他 MCP snapshot", () => {
    useMcpStore.setState({
      servers: [
        {
          id: "zcodeagentmcp-global-everything",
          name: "everything",
          config: { type: "stdio", command: "npx", args: ["everything"] },
          enabled: true,
          changed: false,
          status: "connected",
          source: "zcodeagentmcp",
          scope: "user",
          toolCount: 9,
        },
        {
          id: "zcodeagentmcp-global-plugin-canva",
          name: "plugin:canva:canva",
          config: { type: "http", url: "https://mcp.canva.example.test/mcp" },
          enabled: true,
          changed: false,
          status: "connecting",
          source: "zcodeagentmcp",
          scope: "user",
          authorization: {
            authorizationUrl: "https://auth.canva.example.test/authorize",
            startedAt: "2026-07-09T00:00:00.000Z",
            type: "oauth_authorization_code",
          },
        },
      ],
      statusSnapshots: {
        everything: {
          status: "connected",
          transport: "stdio",
          toolCount: 9,
          updatedAt: "2026-07-09T00:00:00.000Z",
        },
        "plugin:canva:canva": {
          authorization: {
            authorizationUrl: "https://auth.canva.example.test/authorize",
            startedAt: "2026-07-09T00:00:00.000Z",
            type: "oauth_authorization_code",
          },
          status: "connecting",
          transport: "http",
          toolCount: 0,
          updatedAt: "2026-07-09T00:00:00.000Z",
        },
      },
    });

    const epoch = useMcpStore.getState().beginServerStatusListRefresh("status");
    useMcpStore.getState().mergeServerStatusSnapshots(
      {
        "plugin:canva:canva": {
          status: "connected",
          transport: "http",
          toolCount: 33,
          updatedAt: "2026-07-09T00:00:01.000Z",
        },
      },
      epoch,
      "status",
    );

    expect(useMcpStore.getState().statusSnapshots).toMatchObject({
      everything: {
        status: "connected",
        toolCount: 9,
      },
      "plugin:canva:canva": {
        status: "connected",
        toolCount: 33,
      },
    });
    expect(useMcpStore.getState().servers).toEqual([
      expect.objectContaining({
        name: "everything",
        status: "connected",
        toolCount: 9,
      }),
      expect.objectContaining({
        authorization: undefined,
        name: "plugin:canva:canva",
        status: "connected",
        toolCount: 33,
      }),
    ]);
  });

  it("connect 状态结果仍按全量 replace 处理缺失的连接中 server", () => {
    useMcpStore.setState({
      servers: [
        {
          id: "zcodeagentmcp-global-canva",
          name: "canva",
          config: { type: "http", url: "https://mcp.canva.example.test/mcp" },
          enabled: true,
          changed: true,
          status: "unknown",
          source: "zcodeagentmcp",
          scope: "user",
        },
      ],
      statusSnapshots: {
        canva: {
          status: "connected",
          transport: "http",
          toolCount: 33,
          updatedAt: "2026-07-09T00:00:00.000Z",
        },
      },
    });

    const epoch = useMcpStore.getState().beginServerStatusListRefresh();
    useMcpStore.getState().mergeServerStatusSnapshots({}, epoch, "connect");

    expect(useMcpStore.getState().statusSnapshots).toEqual({});
    expect(useMcpStore.getState().servers[0]).toMatchObject({
      status: "error",
      error: undefined,
      failureKind: "status_unavailable",
      toolCount: undefined,
    });
  });

  it("迟到的批量状态不会覆盖手动检查结果", () => {
    useMcpStore.setState({
      servers: [
        {
          id: "zcodeagentmcp-global-filesystem",
          name: "filesystem",
          config: { type: "stdio", command: "node", args: ["server.js"] },
          enabled: true,
          changed: true,
          status: "unknown",
          source: "zcodeagentmcp",
          scope: "user",
        },
      ],
    });

    const epoch = useMcpStore.getState().beginServerStatusListRefresh();
    useMcpStore.getState().updateServerStatus("zcodeagentmcp-global-filesystem", "error", "manual");
    useMcpStore.getState().mergeServerStatusSnapshots(
      {
        filesystem: {
          status: "connected",
          transport: "stdio",
          toolCount: 2,
          updatedAt: "2026-06-23T00:00:00.000Z",
        },
      },
      epoch,
    );

    expect(useMcpStore.getState().servers[0]).toMatchObject({
      status: "error",
      error: "manual",
    });
  });

  it("临时展示态更新不会作废当前批量状态结果", () => {
    useMcpStore.setState({
      servers: [
        {
          id: "zcodeagentmcp-global-filesystem",
          name: "filesystem",
          config: { type: "stdio", command: "node", args: ["server.js"] },
          enabled: true,
          changed: true,
          status: "unknown",
          source: "zcodeagentmcp",
          scope: "user",
        },
      ],
    });

    const epoch = useMcpStore.getState().beginServerStatusListRefresh();
    useMcpStore.getState().updateServerStatus(
      "zcodeagentmcp-global-filesystem",
      "connecting",
      undefined,
      { invalidateStatusListRequests: false },
    );
    useMcpStore.getState().mergeServerStatusSnapshots(
      {
        filesystem: {
          status: "failed",
          transport: "stdio",
          error: "spawn missing ENOENT",
          updatedAt: "2026-06-23T00:00:00.000Z",
        },
      },
      epoch,
    );

    expect(useMcpStore.getState().servers[0]).toMatchObject({
      status: "error",
      error: "spawn missing ENOENT",
    });
  });

  it("批量状态刷新开始时会立即标记待检查的 ZCode Agent MCP 为连接中", () => {
    useMcpStore.setState({
      servers: [
        {
          id: "zcodeagentmcp-global-context7",
          name: "context7",
          config: { type: "stdio", command: "npx", args: ["-y", "@upstash/context7-mcp"], timeoutMs: 3 },
          enabled: true,
          changed: true,
          status: "unknown",
          error: "old error",
          toolCount: 2,
          source: "zcodeagentmcp",
          scope: "user",
        },
        {
          id: "zcodeagentmcp-global-exa",
          name: "exa",
          config: { type: "http", url: "https://mcp.exa.ai/mcp" },
          enabled: true,
          changed: false,
          status: "connected",
          toolCount: 2,
          source: "zcodeagentmcp",
          scope: "user",
        },
        {
          id: "claudeclimcp-global-context7",
          name: "context7",
          config: { type: "stdio", command: "npx", args: ["-y", "@upstash/context7-mcp"], timeoutMs: 3 },
          enabled: true,
          changed: true,
          status: "unknown",
          source: "claudeclimcp",
          scope: "user",
        },
      ],
    });

    useMcpStore.getState().beginServerStatusListRefresh();

    expect(useMcpStore.getState().servers[0]).toMatchObject({
      status: "connecting",
      error: undefined,
      toolCount: undefined,
    });
    expect(useMcpStore.getState().servers[1]).toMatchObject({
      status: "connected",
      toolCount: 2,
    });
    expect(useMcpStore.getState().servers[2]).toMatchObject({
      status: "unknown",
      source: "claudeclimcp",
    });
  });

  it("status-only 刷新开始时只推进 epoch，不改写现有展示态", () => {
    const authorization = {
      authorizationUrl: "https://oauth.example.test/authorize",
      startedAt: "2026-07-10T00:00:00.000Z",
    };
    useMcpStore.setState({
      servers: [
        {
          id: "zcodeagentmcp-global-pending",
          name: "pending",
          config: { type: "http", url: "https://mcp.example.test/pending" },
          enabled: true,
          changed: true,
          status: "unknown",
          authorization,
          error: "keep display state",
          toolCount: 3,
          source: "zcodeagentmcp",
          scope: "user",
        },
      ],
    });

    useMcpStore.getState().beginServerStatusListRefresh("status");

    expect(useMcpStore.getState().servers[0]).toMatchObject({
      authorization,
      changed: true,
      error: "keep display state",
      status: "unknown",
      toolCount: 3,
    });
  });

  it("status-only epoch 不会作废同时进行的 connect 结果", () => {
    useMcpStore.setState({
      servers: [
        {
          id: "zcodeagentmcp-global-new-server",
          name: "new-server",
          config: { type: "stdio", command: "new-server" },
          enabled: true,
          changed: true,
          status: "unknown",
          source: "zcodeagentmcp",
          scope: "user",
        },
      ],
    });

    const connectEpoch = useMcpStore.getState().beginServerStatusListRefresh("connect");
    useMcpStore.getState().beginServerStatusListRefresh("status");
    useMcpStore.getState().mergeServerStatusSnapshots(
      {
        "new-server": {
          status: "connected",
          transport: "stdio",
          toolCount: 1,
          updatedAt: "2026-07-10T00:00:00.000Z",
        },
      },
      connectEpoch,
      "connect",
    );

    expect(useMcpStore.getState().servers[0]).toMatchObject({
      changed: false,
      status: "connected",
      toolCount: 1,
    });
  });

  it("批量状态刷新失败时会把当前连接中的 ZCode Agent MCP 收口为错误", () => {
    useMcpStore.setState({
      servers: [
        {
          id: "zcodeagentmcp-global-broken",
          name: "broken",
          config: { type: "stdio", command: "missing-mcp-command" },
          enabled: true,
          changed: true,
          status: "unknown",
          source: "zcodeagentmcp",
          scope: "user",
        },
      ],
    });

    const epoch = useMcpStore.getState().beginServerStatusListRefresh();
    useMcpStore.getState().markServerStatusListRefreshFailed("agent unavailable", epoch);

    expect(useMcpStore.getState().servers[0]).toMatchObject({
      status: "error",
      error: "agent unavailable",
      toolCount: undefined,
    });
  });

  it("status-only 刷新失败时保留 pending snapshot 和现有连接态", () => {
    useMcpStore.setState({
      statusSnapshots: {
        local: {
          status: "connecting",
          transport: "http",
          toolCount: 0,
          updatedAt: "2026-07-10T00:00:00.000Z",
          authorization: {
            authorizationUrl: "https://oauth.example.test/local",
            startedAt: "2026-07-10T00:00:00.000Z",
          },
        },
        "plugin:canva:canva": {
          status: "connecting",
          transport: "http",
          toolCount: 0,
          updatedAt: "2026-07-10T00:00:00.000Z",
          authorization: {
            authorizationUrl: "https://oauth.example.test/plugin",
            startedAt: "2026-07-10T00:00:00.000Z",
          },
        },
      },
      servers: [
        {
          id: "zcodeagentmcp-global-local",
          name: "local",
          config: { type: "http", url: "https://mcp.example.test/local" },
          enabled: true,
          changed: false,
          status: "connecting",
          authorization: {
            authorizationUrl: "https://oauth.example.test/local",
            startedAt: "2026-07-10T00:00:00.000Z",
          },
          source: "zcodeagentmcp",
          scope: "user",
        },
      ],
    });

    const epoch = useMcpStore.getState().beginServerStatusListRefresh("status");
    useMcpStore
      .getState()
      .markServerStatusListRefreshFailed("temporary status failure", epoch, "status");

    expect(useMcpStore.getState().statusSnapshots).toMatchObject({
      local: {
        authorization: {
          authorizationUrl: "https://oauth.example.test/local",
        },
      },
      "plugin:canva:canva": {
        authorization: {
          authorizationUrl: "https://oauth.example.test/plugin",
        },
      },
    });
    expect(useMcpStore.getState().servers[0]).toMatchObject({
      status: "connecting",
      authorization: {
        authorizationUrl: "https://oauth.example.test/local",
      },
    });
    expect(useMcpStore.getState().servers[0]?.error).toBeUndefined();
  });

  it("批量状态结果缺失当前连接中的 server 时不会一直停在连接中", () => {
    useMcpStore.setState({
      servers: [
        {
          id: "zcodeagentmcp-global-broken",
          name: "broken",
          config: { type: "stdio", command: "missing-mcp-command" },
          enabled: true,
          changed: true,
          status: "unknown",
          source: "zcodeagentmcp",
          scope: "user",
        },
      ],
    });

    const epoch = useMcpStore.getState().beginServerStatusListRefresh();
    useMcpStore.getState().mergeServerStatusSnapshots({}, epoch);

    expect(useMcpStore.getState().servers[0]).toMatchObject({
      status: "error",
      error: undefined,
      failureKind: "status_unavailable",
      toolCount: undefined,
    });
  });

  it("迟到的批量状态刷新失败不会覆盖更新的连接状态", () => {
    useMcpStore.setState({
      servers: [
        {
          id: "zcodeagentmcp-global-broken",
          name: "broken",
          config: { type: "stdio", command: "missing-mcp-command" },
          enabled: true,
          changed: true,
          status: "unknown",
          source: "zcodeagentmcp",
          scope: "user",
        },
      ],
    });

    const oldEpoch = useMcpStore.getState().beginServerStatusListRefresh();
    useMcpStore.getState().beginServerStatusListRefresh();
    useMcpStore.getState().markServerStatusListRefreshFailed("old failure", oldEpoch);

    expect(useMcpStore.getState().servers[0]).toMatchObject({
      status: "connecting",
      error: undefined,
    });
  });

  it("更新 MCP 配置后会清理旧健康状态并重新标记 changed", async () => {
    const server = {
      source: "zcodeagentmcp" as const,
      scope: "user" as const,
      name: "context7",
      config: {
        type: "stdio" as const,
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
        timeoutMs: 3,
      },
      enabled: true,
    };

    useMcpStore.setState({
      nativeServers: [server],
      servers: [
        {
          id: "zcodeagentmcp-global-context7",
          name: "context7",
          config: server.config,
          enabled: true,
          changed: false,
          status: "error",
          error: "MCP server context7 connection timed out after 3ms",
          source: "zcodeagentmcp",
          scope: "user",
        },
      ],
    });

    await useMcpStore.getState().updateScopedMcpServer("zcodeagentmcp", "context7", {
      ...server.config,
      timeoutMs: 30000,
    });

    expect(useMcpStore.getState().servers[0]).toMatchObject({
      config: expect.objectContaining({ timeoutMs: 30000 }),
      changed: true,
      status: "unknown",
      error: undefined,
    });
  });

  it("切换启用状态会先落盘再更新本地列表", async () => {
    let resolveSave!: () => void;
    const saveMcpToUserDirectory = vi.fn(
      () =>
        new Promise<{ success: true }>((resolve) => {
          resolveSave = () => resolve({ success: true });
        }),
    );
    setMcpStorePlatform({
      loadMcpFromUserDirectory: vi.fn(async () => ({ servers: [] })),
      migrateLegacyCommonMcp: vi.fn(async () => ({
        importedCount: 0,
        servers: {},
        skippedCount: 0,
        totalCount: 0,
      })),
      saveMcpToUserDirectory,
    });
    useMcpStore.setState({
      servers: [
        {
          id: "zcodeagentmcp-global-broken",
          name: "broken",
          config: { type: "stdio", command: "missing-mcp-command" },
          enabled: false,
          source: "zcodeagentmcp",
          scope: "user",
          status: "unknown",
        },
      ],
    });

    const toggle = useMcpStore.getState().toggleServer("zcodeagentmcp-global-broken", true);
    await Promise.resolve();

    expect(useMcpStore.getState().servers[0]?.enabled).toBe(false);
    expect(saveMcpToUserDirectory).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "set-enabled",
        enabled: true,
        name: "broken",
        source: "zcodeagentmcp",
      }),
    );

    resolveSave();
    await toggle;

    expect(useMcpStore.getState().servers[0]?.enabled).toBe(true);
  });
});
