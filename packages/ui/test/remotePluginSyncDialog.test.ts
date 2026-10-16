import { describe, expect, it } from "vitest";
import type {
  PluginSyncCandidate,
  PluginSyncRemoteStatus,
  ZCodePluginInfo,
  ZCodePluginsOverviewResult,
} from "@zcode/shared";
import {
  buildMarketplaceRemotePluginStatuses,
  buildMarketplaceRemotePluginSyncCandidates,
  buildRemotePluginSyncRows,
  buildRemotePluginSyncRowsForCandidates,
  filterRemotePluginSyncRows,
  resolveDefaultRemotePluginSyncSelection,
  shouldAllowRemotePluginSyncDialogOpenChange,
  shouldFinishRemotePluginSyncRun,
  syncSelectedRemotePlugins,
} from "../src/settings/RemotePluginSyncDialog.js";

type RemotePluginSyncParams = Parameters<typeof syncSelectedRemotePlugins>[0];
type RemotePluginSyncRow = RemotePluginSyncParams["rows"][number];
type RemoteInstallResult = Awaited<
  ReturnType<NonNullable<RemotePluginSyncParams["remoteZCodeAgentService"]>["installPlugin"]>
>;

function makeCandidate(
  overrides: Partial<PluginSyncCandidate>,
): PluginSyncCandidate {
  return {
    id: "remote-tools-id",
    name: "remote-tools",
    pluginId: "remote-tools@inline",
    directoryName: "remote-tools",
    path: "/Users/me/.zcode/plugins/remote-tools",
    sizeBytes: 128,
    enabled: true,
    componentTypes: ["skills"],
    ...overrides,
  };
}

function makeOverview(
  installed: ZCodePluginsOverviewResult["installedPlugins"],
  source: ZCodePluginsOverviewResult["marketplaces"][number]["source"] = {
    source: "github",
    repo: "example/team-plugins",
    ref: "main",
  },
): ZCodePluginsOverviewResult {
  return {
    marketplaces: [
      {
        id: "team-market",
        name: "team-market",
        source,
        pluginCount: 1,
      },
    ],
    availablePlugins: [],
    installedPlugins: installed,
    restorableBuiltins: [],
    diagnostics: [],
    capability: { supported: true },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function makeMarketplaceRow(name: string): RemotePluginSyncRow {
  return {
    candidate: {
      id: `marketplace:${name}@team-market`,
      kind: "marketplace",
      name,
      pluginId: `${name}@team-market`,
      marketplace: "team-market",
      enabled: true,
      componentTypes: ["command"],
      marketplacePlugin: {
        marketplaceSourceInput: "example/team-plugins",
        pluginName: name,
      },
    },
    exists: false,
    remoteMarketplaceExists: true,
  };
}

function makePluginInfo(
  overrides: Partial<ZCodePluginInfo>,
): ZCodePluginInfo {
  return {
    id: "formatter@team-market",
    name: "formatter",
    enabled: true,
    source: "cache",
    marketplace: "team-market",
    skillRootCount: 0,
    commandRootCount: 0,
    mcpServerNames: [],
    rootPath: "/cache/formatter",
    ...overrides,
  };
}

function delay(ms: number): Promise<"timeout"> {
  return new Promise((resolve) => {
    setTimeout(() => resolve("timeout"), ms);
  });
}

describe("RemotePluginSyncDialog helpers", () => {
  it("only finishes the currently active remote plugin sync run", () => {
    const currentRun = new AbortController();
    const staleRun = new AbortController();

    expect(shouldFinishRemotePluginSyncRun(currentRun, currentRun)).toBe(true);
    expect(shouldFinishRemotePluginSyncRun(currentRun, staleRun)).toBe(false);
  });

  it("joins local plugin candidates with remote status by plugin id and directory", () => {
    const rows = buildRemotePluginSyncRows(
      [
        makeCandidate({ id: "missing-id", pluginId: "missing@inline", directoryName: "missing" }),
        makeCandidate({ id: "existing-id", pluginId: "existing@inline", directoryName: "existing" }),
      ],
      [
        {
          pluginId: "existing@inline",
          directoryName: "existing",
          exists: true,
          reason: "samePluginId",
        },
      ] satisfies PluginSyncRemoteStatus[],
    );

    expect(rows).toMatchObject([
      { candidate: { id: "inline:missing-id" }, exists: false },
      { candidate: { id: "inline:existing-id" }, exists: true },
    ]);
  });

  it("selects only missing remote plugins by default", () => {
    const rows = buildRemotePluginSyncRows(
      [
        makeCandidate({ id: "missing-id", pluginId: "missing@inline", directoryName: "missing" }),
        makeCandidate({ id: "existing-id", pluginId: "existing@inline", directoryName: "existing" }),
      ],
      [
        {
          pluginId: "existing@inline",
          directoryName: "existing",
          exists: true,
        },
      ],
    );

    expect(Array.from(resolveDefaultRemotePluginSyncSelection(rows))).toEqual([
      "inline:missing-id",
    ]);
  });

  it("filters existing remote plugins unless requested", () => {
    const rows = buildRemotePluginSyncRows(
      [
        makeCandidate({ id: "missing-id", pluginId: "missing@inline", directoryName: "missing" }),
        makeCandidate({ id: "existing-id", pluginId: "existing@inline", directoryName: "existing" }),
      ],
      [
        {
          pluginId: "existing@inline",
          directoryName: "existing",
          exists: true,
        },
      ],
    );

    expect(filterRemotePluginSyncRows(rows, false).map((row) => row.candidate.id)).toEqual([
      "inline:missing-id",
    ]);
    expect(filterRemotePluginSyncRows(rows, true).map((row) => row.candidate.id)).toEqual([
      "inline:missing-id",
      "inline:existing-id",
    ]);
  });

  it("blocks dialog close requests while plugin sync is running", () => {
    expect(shouldAllowRemotePluginSyncDialogOpenChange("preflighting", false)).toBe(false);
    expect(shouldAllowRemotePluginSyncDialogOpenChange("preflighting", true)).toBe(true);
    expect(shouldAllowRemotePluginSyncDialogOpenChange("syncing", false)).toBe(false);
    expect(shouldAllowRemotePluginSyncDialogOpenChange("syncing", true)).toBe(true);
    expect(shouldAllowRemotePluginSyncDialogOpenChange("selection", false)).toBe(true);
    expect(shouldAllowRemotePluginSyncDialogOpenChange("complete", false)).toBe(true);
  });

  it("does not carry legacy install scope into marketplace candidates", () => {
    const candidates = buildMarketplaceRemotePluginSyncCandidates(
      makeOverview([
        {
          id: "formatter@team-market",
          name: "formatter",
          marketplace: "team-market",
          enabled: false,
          scope: "workspace",
          version: "2.0.0",
          installPath: "/Users/me/.zcode/cli/plugins/cache/team-market/formatter/2.0.0",
          componentTypes: ["command", "skill"],
        },
      ]),
      [],
    );

    expect(candidates).toMatchObject([
      {
        id: "marketplace:formatter@team-market",
        kind: "marketplace",
        name: "formatter",
        pluginId: "formatter@team-market",
        marketplace: "team-market",
        enabled: false,
        componentTypes: ["command", "skill"],
        marketplacePlugin: {
          marketplaceSourceInput: "example/team-plugins#main",
          pluginName: "formatter",
        },
      },
    ]);
  });

  it("keeps local configured plugin options on marketplace sync candidates", () => {
    const candidates = buildMarketplaceRemotePluginSyncCandidates(
      makeOverview([
        {
          id: "formatter@team-market",
          name: "formatter",
          marketplace: "team-market",
          enabled: true,
          scope: "user",
        },
      ]),
      [
        makePluginInfo({
          userConfig: {
            region: { type: "string" },
            token: { type: "string", sensitive: true },
          },
          configuredOptions: {
            region: "cn",
            token: "local-secret",
          },
        }),
      ],
    );

    expect(candidates[0]?.pluginOptions).toEqual({
      configuredOptions: {
        region: "cn",
        token: "local-secret",
      },
      userConfig: {
        region: { type: "string" },
        token: { type: "string", sensitive: true },
      },
    });
  });

  it("builds marketplace candidates with source archive metadata for local directory sources", () => {
    const candidates = buildMarketplaceRemotePluginSyncCandidates(
      makeOverview(
        [
          {
            id: "formatter@team-market",
            name: "formatter",
            marketplace: "team-market",
            enabled: true,
            scope: "user",
          },
        ],
        { source: "directory", path: "/Users/me/plugins/team-market" },
      ),
      [],
    );

    expect(candidates).toMatchObject([
      {
        id: "marketplace:formatter@team-market",
        marketplacePlugin: {
          pluginName: "formatter",
          marketplaceSourceArchive: {
            marketplaceId: "team-market",
            source: { source: "directory", path: "/Users/me/plugins/team-market" },
          },
        },
      },
    ]);
    expect(candidates[0]?.marketplacePlugin).not.toHaveProperty("marketplaceSourceInput");
  });

  it("selects missing marketplace plugins and filters existing ones", () => {
    const candidates = buildMarketplaceRemotePluginSyncCandidates(
      makeOverview([
        {
          id: "formatter@team-market",
          name: "formatter",
          marketplace: "team-market",
          enabled: true,
          scope: "user",
        },
        {
          id: "runner@team-market",
          name: "runner",
          marketplace: "team-market",
          enabled: true,
          scope: "workspace",
        },
      ]),
      [],
    );
    const statuses = buildMarketplaceRemotePluginStatuses(
      candidates,
      makeOverview([
        {
          id: "runner@team-market",
          name: "runner",
          marketplace: "team-market",
          enabled: true,
          scope: "workspace",
          installPath: "/remote/cache/runner",
        },
      ]),
    );
    const rows = buildRemotePluginSyncRowsForCandidates(candidates, statuses);

    expect(Array.from(resolveDefaultRemotePluginSyncSelection(rows))).toEqual([
      "marketplace:formatter@team-market",
    ]);
    expect(filterRemotePluginSyncRows(rows, false).map((row) => row.candidate.id)).toEqual([
      "marketplace:formatter@team-market",
    ]);
  });

  it("mirrors a local marketplace source before adding and installing on the remote", async () => {
    const calls: string[] = [];
    const archive = new Uint8Array([1, 2, 3]);
    const result = await syncSelectedRemotePlugins({
      localPluginSyncService: {
        exportMarketplaceSourceArchive: async (params) => {
          calls.push(`export:${params.marketplaceId}:${params.pluginNames.join(",")}`);
          expect(params.source).toEqual({
            source: "directory",
            path: "/Users/me/plugins/team-market",
          });
          return {
            archive,
            archiveBytes: archive.byteLength,
            marketplaceId: "team-market",
            pluginNames: params.pluginNames,
          };
        },
      } as never,
      remotePluginSyncService: {
        importMarketplaceSourceArchive: async (params) => {
          calls.push("import");
          expect(params.archive).toBe(archive);
          return {
            marketplaceId: "team-market",
            path: "/remote/.zcode/plugins/marketplace-sources/team-market-hash",
            status: "synced",
          };
        },
      } as never,
      remoteWorkspacePath: "/remote/workspace",
      remoteZCodeAgentService: {
        addPluginMarketplace: async (params) => {
          calls.push(`add:${params.source}`);
          return { diagnostics: [] };
        },
        installPlugin: async (params) => {
          calls.push(`install:${params.pluginName}@${params.marketplace}`);
          return {
            dependencyClosure: [],
            diagnostics: [],
            installedPlugins: [
              {
                id: "formatter@team-market",
                name: "formatter",
                marketplace: "team-market",
                enabled: true,
                scope: "user",
                installPath: "/remote/cache/formatter",
              },
            ],
          };
        },
        setPluginEnabled: async (params) => {
          calls.push(`enabled:${params.pluginId}:${params.enabled}`);
          return {
            enabled: params.enabled,
            plugin: {
              id: params.pluginId,
              name: "formatter",
              enabled: params.enabled,
              source: "cache",
              marketplace: "team-market",
              skillRootCount: 0,
              commandRootCount: 0,
              mcpServerNames: [],
              rootPath: "/remote/cache/formatter",
            },
          };
        },
      } as never,
      rows: [
        {
          candidate: {
            id: "marketplace:formatter@team-market",
            kind: "marketplace",
            name: "formatter",
            pluginId: "formatter@team-market",
            marketplace: "team-market",
            enabled: true,
            componentTypes: ["skill"],
            marketplacePlugin: {
              marketplaceSourceArchive: {
                marketplaceId: "team-market",
                source: { source: "directory", path: "/Users/me/plugins/team-market" },
              },
              pluginName: "formatter",
            },
          },
          exists: false,
          remoteMarketplaceExists: false,
        },
      ],
    });

    expect(result.results).toMatchObject([
      {
        pluginId: "formatter@team-market",
        status: "synced",
      },
    ]);
    expect(calls).toEqual([
      "export:team-market:formatter",
      "import",
      "add:/remote/.zcode/plugins/marketplace-sources/team-market-hash",
      "install:formatter@team-market",
      "enabled:formatter@team-market:true",
    ]);
  });

  it("syncs only portable configured plugin options and preserves remote options", async () => {
    const configureCalls: Array<Record<string, unknown>> = [];
    const progress: string[] = [];
    const result = await syncSelectedRemotePlugins({
      localPluginSyncService: {} as never,
      remotePluginSyncService: {} as never,
      remoteWorkspacePath: "/remote/workspace",
      remoteZCodeAgentService: {
        installPlugin: async () => ({
          dependencyClosure: [],
          diagnostics: [],
          installedPlugins: [
            {
              id: "formatter@team-market",
              name: "formatter",
              marketplace: "team-market",
              enabled: true,
              scope: "user",
              installPath: "/remote/cache/formatter",
            },
          ],
        }),
        setPluginEnabled: async (params) => ({
          enabled: params.enabled,
          plugin: makePluginInfo({
            id: params.pluginId,
            rootPath: "/remote/cache/formatter",
          }),
        }),
        listPlugins: async () => ({
          diagnostics: [],
          plugins: [
            makePluginInfo({
              id: "formatter@team-market",
              rootPath: "/remote/cache/formatter",
              userConfig: {
                region: { type: "string" },
                retries: { type: "number" },
                token: { type: "string", sensitive: true },
                workspaceDir: { type: "directory" },
              },
              configuredOptions: {
                remoteOnly: true,
              },
            }),
          ],
        }),
        configurePlugin: async (params) => {
          configureCalls.push(params.options);
          return { diagnostics: [], pluginId: params.pluginId };
        },
      } as never,
      rows: [
        {
          candidate: {
            id: "marketplace:formatter@team-market",
            kind: "marketplace",
            name: "formatter",
            pluginId: "formatter@team-market",
            marketplace: "team-market",
            enabled: true,
            componentTypes: ["command"],
            pluginOptions: {
              userConfig: {
                region: { type: "string" },
                retries: { type: "number" },
                token: { type: "string", sensitive: true },
                workspaceDir: { type: "directory" },
                stale: { type: "string" },
              },
              configuredOptions: {
                region: "cn",
                retries: 2,
                token: "local-secret",
                workspaceDir: "/Users/me/project",
                stale: "old",
              },
            },
            marketplacePlugin: {
              marketplaceSourceInput: "example/team-plugins",
              pluginName: "formatter",
            },
          },
          exists: false,
          remoteMarketplaceExists: true,
        },
      ],
      onItemProgress: (event) => {
        progress.push(event.log);
      },
    });

    expect(result.results).toMatchObject([
      {
        pluginId: "formatter@team-market",
        status: "synced",
      },
    ]);
    expect(configureCalls).toEqual([
      {
        remoteOnly: true,
        region: "cn",
        retries: 2,
      },
    ]);
    expect(progress.join("\n")).toContain("RPC plugins/configure 2 portable option(s)");
    expect(progress.join("\n")).toContain("skipped 3 non-portable plugin option(s)");
  });

  it("uses User config scope for all marketplace sync operations", async () => {
    const calls: Array<{ operation: string; scope: string | undefined }> = [];
    const result = await syncSelectedRemotePlugins({
      localPluginSyncService: {} as never,
      remotePluginSyncService: {} as never,
      remoteWorkspacePath: "/remote/workspace",
      remoteZCodeAgentService: {
        installPlugin: async (params) => {
          calls.push({ operation: "install", scope: params.scope });
          return {
            dependencyClosure: [],
            diagnostics: [],
            installedPlugins: [
              {
                id: "formatter@team-market",
                name: "formatter",
                marketplace: "team-market",
                enabled: true,
                scope: "user",
                installPath: "/remote/cache/formatter",
              },
            ],
          };
        },
        setPluginEnabled: async (params) => {
          calls.push({ operation: "setEnabled", scope: params.scope });
          return {
            enabled: params.enabled,
            plugin: makePluginInfo({ id: params.pluginId, rootPath: "/remote/cache/formatter" }),
          };
        },
        listPlugins: async () => ({
          diagnostics: [],
          plugins: [
            makePluginInfo({
              configuredOptions: {},
              id: "formatter@team-market",
              userConfig: { region: { type: "string" } },
            }),
          ],
        }),
        configurePlugin: async (params) => {
          calls.push({ operation: "configure", scope: params.scope });
          return { diagnostics: [], pluginId: params.pluginId };
        },
      } as never,
      rows: [
        {
          candidate: {
            id: "marketplace:formatter@team-market",
            kind: "marketplace",
            name: "formatter",
            pluginId: "formatter@team-market",
            marketplace: "team-market",
            enabled: true,
            componentTypes: ["skill"],
            pluginOptions: {
              userConfig: { region: { type: "string" } },
              configuredOptions: { region: "cn" },
            },
            marketplacePlugin: {
              marketplaceSourceInput: "example/team-plugins",
              pluginName: "formatter",
            },
          },
          exists: false,
          remoteMarketplaceExists: true,
        },
      ],
    });

    expect(result.results).toMatchObject([
      { pluginId: "formatter@team-market", status: "synced" },
    ]);
    expect(calls).toEqual([
      { operation: "install", scope: "user" },
      { operation: "setEnabled", scope: "user" },
      { operation: "configure", scope: "user" },
    ]);
  });

  it("stops waiting for one marketplace plugin and continues syncing the next plugin", async () => {
    const slowInstall = deferred<RemoteInstallResult>();
    const slowStarted = deferred<void>();
    const fastStarted = deferred<void>();
    const stoppedIds = new Set<string>();
    const stopWaiters = new Map<string, () => void>();
    const progress: Array<{ candidateId: string; log: string; status: string }> = [];
    const cancelCalls: string[] = [];
    const installOperationIds: string[] = [];

    const stopPlugin = (candidateId: string) => {
      stoppedIds.add(candidateId);
      stopWaiters.get(candidateId)?.();
    };

    const resultPromise = syncSelectedRemotePlugins({
      localPluginSyncService: {} as never,
      remotePluginSyncService: {} as never,
      remoteWorkspacePath: "/remote/workspace",
      remoteZCodeAgentService: {
        installPlugin: async (params) => {
          installOperationIds.push(params.operationId ?? "");
          if (params.pluginName === "slow") {
            slowStarted.resolve();
            return await slowInstall.promise;
          }
          fastStarted.resolve();
          return {
            dependencyClosure: [],
            diagnostics: [],
            installedPlugins: [
              {
                id: "fast@team-market",
                name: "fast",
                marketplace: "team-market",
                enabled: true,
                scope: "user",
                installPath: "/remote/cache/fast",
              },
            ],
          };
        },
        setPluginEnabled: async (params) => ({
          enabled: params.enabled,
          plugin: {
            id: params.pluginId,
            name: params.pluginId.split("@")[0] ?? params.pluginId,
            enabled: params.enabled,
            source: "cache",
            marketplace: "team-market",
            skillRootCount: 0,
            commandRootCount: 0,
            mcpServerNames: [],
            rootPath: `/remote/cache/${params.pluginId}`,
          },
        }),
        cancelPluginOperation: async (params) => {
          cancelCalls.push(params.operationId);
          return { cancelled: true, operationId: params.operationId };
        },
      } as never,
      rows: [makeMarketplaceRow("slow"), makeMarketplaceRow("fast")],
      onItemProgress: (event) => {
        progress.push({
          candidateId: event.candidateId,
          log: event.log,
          status: event.status,
        });
      },
      stopControl: {
        isStopped: (candidateId) => stoppedIds.has(candidateId),
        waitForStop: (candidateId) =>
          new Promise<void>((resolve) => {
            stopWaiters.set(candidateId, resolve);
          }),
        cancelOperation: async (operationId) => {
          await (
            {
              cancelPluginOperation: async (params: { operationId: string }) => {
                cancelCalls.push(params.operationId);
                return { cancelled: true, operationId: params.operationId };
              },
            }
          ).cancelPluginOperation({ operationId });
        },
      },
    });

    await slowStarted.promise;
    stopPlugin("marketplace:slow@team-market");

    await expect(
      Promise.race([fastStarted.promise.then(() => "fast-started" as const), delay(25)]),
    ).resolves.toBe("fast-started");
    expect(installOperationIds[0]).toMatch(/^remote-plugin-sync-/);
    expect(cancelCalls).toEqual([installOperationIds[0]]);

    slowInstall.resolve({
      dependencyClosure: [],
      diagnostics: [],
      installedPlugins: [
        {
          id: "slow@team-market",
          name: "slow",
          marketplace: "team-market",
          enabled: true,
          scope: "user",
          installPath: "/remote/cache/slow",
        },
      ],
    });

    await expect(resultPromise).resolves.toMatchObject({
      results: [
        {
          pluginId: "slow@team-market",
          status: "stopped",
        },
        {
          pluginId: "fast@team-market",
          status: "synced",
        },
      ],
    });
    expect(progress).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          candidateId: "marketplace:slow@team-market",
          status: "syncing",
          log: expect.stringContaining("install"),
        }),
        expect.objectContaining({
          candidateId: "marketplace:slow@team-market",
          status: "stopped",
          log: expect.stringContaining("stop"),
        }),
        expect.objectContaining({
          candidateId: "marketplace:fast@team-market",
          status: "synced",
        }),
      ]),
    );
  });

  it("aborts an active remote plugin operation when its target becomes invalid", async () => {
    const controller = new AbortController();
    const slowInstall = deferred<RemoteInstallResult>();
    const slowStarted = deferred<void>();
    const cancelCalls: string[] = [];
    const installOperationIds: string[] = [];

    const resultPromise = syncSelectedRemotePlugins({
      localPluginSyncService: {} as never,
      remotePluginSyncService: {} as never,
      remoteWorkspacePath: "/remote/workspace",
      remoteZCodeAgentService: {
        installPlugin: async (params) => {
          installOperationIds.push(params.operationId ?? "");
          slowStarted.resolve();
          return await slowInstall.promise;
        },
      } as never,
      rows: [makeMarketplaceRow("slow")],
      signal: controller.signal,
      stopControl: {
        isStopped: () => false,
        cancelOperation: async (operationId) => {
          cancelCalls.push(operationId);
        },
      },
    });

    await slowStarted.promise;
    controller.abort();

    const outcome = await Promise.race([resultPromise, delay(25)]);
    expect(outcome).not.toBe("timeout");
    expect(outcome).toMatchObject({
      results: [
        {
          pluginId: "slow@team-market",
          status: "stopped",
        },
      ],
    });
    expect(cancelCalls).toEqual([installOperationIds[0]]);

    slowInstall.resolve({
      dependencyClosure: [],
      diagnostics: [],
      installedPlugins: [],
    });
  });

  it("does not start a remote install when a plugin was already stopped", async () => {
    const installCalls: string[] = [];
    const result = await syncSelectedRemotePlugins({
      localPluginSyncService: {} as never,
      remotePluginSyncService: {} as never,
      remoteWorkspacePath: "/remote/workspace",
      remoteZCodeAgentService: {
        installPlugin: async (params) => {
          installCalls.push(params.pluginName);
          return {
            dependencyClosure: [],
            diagnostics: [],
            installedPlugins: [],
          };
        },
      } as never,
      rows: [makeMarketplaceRow("stopped")],
      stopControl: {
        isStopped: (candidateId) => candidateId === "marketplace:stopped@team-market",
      },
    });

    expect(installCalls).toEqual([]);
    expect(result.results).toMatchObject([
      {
        pluginId: "stopped@team-market",
        status: "stopped",
      },
    ]);
  });
});
