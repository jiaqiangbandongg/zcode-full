import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelClient, ChannelServer, createQueuePair, Emitter, ProxyChannel } from "@zcode/rpc";
import {
  ServiceCollection,
  IFileService,
  IGitService,
  IGitCheckpointService,
  ISystemService,
  ITerminalService,
  ISettingService,
  IOnboardingRecordService,
  ICredentialService,
  IBroadcastService,
  IZCodeAgentService,
  IZCodeSessionService,
  IZCodeTaskService,
  IBotsService,
  IFileWatcherService,
  IOAuthService,
  IModelSelectionService,
  IProviderSettingsService,
  IUsageStatsService,
  ICodingPlanSubscriptionService,
  IClientConfigService,
  ISkillsService,
  ISkillSyncService,
  IMcpSyncService,
  IPluginSyncService,
  IPluginsService,
  ISubagentsService,
  ICommandsService,
  ISettingsSyncService,
  type ZCodeAgentSessionRuntimePreferencesRequest,
} from "@zcode/services";
import {
  BUILTIN_MODEL_PROVIDER_IDS,
  projectAccessTokenFingerprint,
  type ApiClient,
} from "@zcode/shared";
import { createRemoteConnectionServiceCollection } from "../src/host/remoteConnectionServiceCollection.js";
import { createRemotePromptAttachmentTaskService } from "../src/host/remotePromptAttachments.js";
import { setDataBaseDir } from "@zcode/services/node";
import * as nodeServices from "@zcode/services/node";
import {
  createRemoteWorkspaceServiceCollection,
  createServerRemoteWorkspaceServiceCollection,
} from "../src/host/remoteWorkspaceServiceCollection.js";

const originalHome = process.env.HOME;
const clientConfigService = {
  getSnapshot: vi.fn(async () => ({ pluginStoreOrder: null })),
};

function createTempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "zcode-remote-workspace-services-"));
  // Bug 根因：模型供应商存储的默认 data base dir 在模块加载时已经固定；只改 HOME
  // 会继续读取真实 ~/.zcode/v2，并让 getAll 的后台权益请求污染下一个测试。
  setDataBaseDir(home);
  // Bug 根因：设置服务按 process.env.HOME 实时定位 ~/.zcode/v2/setting.json。只改 data base dir
  // 时会读到开发机真实设置；配置了 httpProxy 的机器上 Host API 改走 undici 代理 dispatcher，
  // 绕过 globalThis.fetch mock 直连线上并 401。HOME 由 afterEach 统一还原。
  process.env.HOME = home;
  return home;
}

function createPresetFetchMock(modelContextBudgetStrategy: "legacy" | "preflight-v1" = "legacy") {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("192.168.100.166") || url.includes("/v1/models")) {
      throw new Error(`Retired preset endpoints must not be requested remotely: ${url}`);
    }
    if (url.includes("/api/v2/releases/latest")) {
      return new Response(
        JSON.stringify({
          version: "0.25.1",
          config_version: "0.0.13",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/api/v1/client/configs")) {
      return new Response(
        JSON.stringify({
          code: 0,
          msg: "",
          data: {
            configs: {
              modelContextBudget: {
                strategy: modelContextBudgetStrategy,
              },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

function makeRemoteServices() {
  const runtimePreferencesEmitter = new Emitter<ZCodeAgentSessionRuntimePreferencesRequest>();

  return {
    fileService: { remote: "file" },
    gitService: { remote: "git" },
    gitCheckpointService: { remote: "git-checkpoint" },
    systemService: { remote: "system" },
    terminalService: { remote: "terminal" },
    zcodeAgentService: {
      onDynamicSessionRuntimePreferencesRequest: vi.fn(() => runtimePreferencesEmitter.event),
      respondSessionRuntimePreferences: vi.fn(async () => undefined),
    },
    runtimePreferencesEmitter,
    zcodeTaskService: { sendPrompt: vi.fn() },
    zcodeSessionService: { remote: "zcode-session" },
    fileWatcherService: { remote: "file-watcher" },
    skillsService: { remote: "skills" },
    skillSyncService: { remote: "skill-sync" },
    mcpSyncService: { remote: "mcp-sync" },
    pluginSyncService: { remote: "plugin-sync" },
    pluginsService: { remote: "plugins" },
    pluginManagementService: { remote: "plugin-management" },
    commandsService: { remote: "commands" },
    hooksService: { remote: "hooks" },
    modelSelectionService: {
      getView: vi.fn(async () => ({ revision: 0, providers: [] })),
    },
    providerSettingsService: { remote: "provider-settings" },
  } as never;
}

function remoteWorkspaceHostOptions(onError = vi.fn()) {
  return {
    localOnboardingRecordService: createOnboardingRecordStub(),
    promptAttachmentTransferService: {} as never,
    runtimePreferencesBridge: {
      onError,
    },
  };
}

function createOnboardingRecordStub(): IOnboardingRecordService {
  return {
    appendRecord: vi.fn(async () => {}),
    dismissOnboarding: vi.fn(async () => {}),
    claimAnonymousRecord: vi.fn(async () => {}),
    shouldOnboard: vi.fn(async () => false),
    getLatestEntry: vi.fn(async () => null),
    syncSettingsFromRecord: vi.fn(async () => null),
    updateRecordPreferences: vi.fn(async () => {}),
    getRecords: vi.fn(async () => null),
    clearRecords: vi.fn(async () => {}),
  };
}

function passthroughService<T extends object>(service: T): T {
  return service;
}

describe("remote workspace host service wiring", () => {
  afterEach(() => {
    process.env.HOME = originalHome;
    setDataBaseDir(null);
    vi.restoreAllMocks();
  });

  it("keeps workspace services remote and exposes local global services for Web remote control", () => {
    const remoteServices = makeRemoteServices();
    const services = createRemoteWorkspaceServiceCollection({
      clientConfigService,
      connectionServices: remoteServices,
      ...remoteWorkspaceHostOptions(),
      parentPort: null,
      createRemotePromptAttachmentTaskService: passthroughService,
      createRemotePromptAttachmentSessionService: passthroughService,
      createReportingRemoteZCodeTaskService: (service) => ({ wrapped: service }) as never,
    });

    expect(services.get(IFileService)).toBe(remoteServices.fileService);
    expect(services.get(IGitService)).toBe(remoteServices.gitService);
    expect(services.get(IGitCheckpointService)).toBe(remoteServices.gitCheckpointService);
    expect(services.get(ISystemService)).toBe(remoteServices.systemService);
    expect(services.get(ITerminalService)).toBe(remoteServices.terminalService);
    expect(services.get(IFileWatcherService)).toBe(remoteServices.fileWatcherService);
    expect(services.get(IZCodeTaskService)).toEqual({
      wrapped: remoteServices.zcodeTaskService,
    });
    expect(services.get(IZCodeAgentService)).toBe(remoteServices.zcodeAgentService);
    expect(services.get(IZCodeSessionService)).toBe(remoteServices.zcodeSessionService);

    expect(services.get(IClientConfigService)).toBe(clientConfigService);
    expect(services.get(ISettingService)).toBeTruthy();
    expect(services.get(ICredentialService)).toBeTruthy();
    expect(services.get(IBroadcastService)).toBeTruthy();
    expect(services.get(IBotsService)).toBeTruthy();
    expect(services.get(IOAuthService)).toBeTruthy();
    expect(services.get(IModelSelectionService)).toBe(remoteServices.modelSelectionService);
    expect(services.get(IProviderSettingsService)).toBe(remoteServices.providerSettingsService);
    expect(services.get(IUsageStatsService)).toBeTruthy();
    expect(services.get(IClientConfigService)).toBe(clientConfigService);
    expect(services.get(ISkillsService)).toBe(remoteServices.skillsService);
    expect(services.get(ISkillSyncService)).toBe(remoteServices.skillSyncService);
    expect(services.get(IMcpSyncService)).toBe(remoteServices.mcpSyncService);
    expect(services.get(IPluginSyncService)).toBe(remoteServices.pluginSyncService);
    expect(services.get(IPluginsService)).toBe(remoteServices.pluginsService);
    expect(services.get(ICommandsService)).toBe(remoteServices.commandsService);
    expect(services.get(ISubagentsService)).toBeTruthy();
    expect(services.get(ISettingsSyncService)).toBeTruthy();
  });

  it.each(["desktop-attached", "server"] as const)(
    "%s 远程 attachment 通过 RPC 访问同源引导记录并保留服务错误",
    async (kind) => {
      const localRecord = createOnboardingRecordStub();
      const serverRecord = createOnboardingRecordStub();
      const owner = kind === "server" ? serverRecord : localRecord;
      const other = kind === "server" ? localRecord : serverRecord;
      const connectionServices = {
        ...makeRemoteServices(),
        onboardingRecordService: serverRecord,
      };
      const sourceServices = new ServiceCollection().register(
        IOnboardingRecordService,
        localRecord,
      );
      const services =
        kind === "server"
          ? createServerRemoteWorkspaceServiceCollection({
              clientConfigService,
              connectionServices,
              sourceServices,
            })
          : createRemoteWorkspaceServiceCollection({
              clientConfigService,
              connectionServices,
              sourceServices,
              ...remoteWorkspaceHostOptions(),
              localOnboardingRecordService: localRecord,
              parentPort: null,
              createRemotePromptAttachmentTaskService: passthroughService,
              createRemotePromptAttachmentSessionService: passthroughService,
              createReportingRemoteZCodeTaskService: passthroughService,
            });
      const [serverProtocol, clientProtocol] = createQueuePair();
      const server = new ChannelServer(serverProtocol, "mobile-onboarding", 50);
      const client = new ChannelClient(clientProtocol);
      services.exposeOnChannelServer(server);
      const record = ProxyChannel.toService<IOnboardingRecordService>(
        client.getChannel(IOnboardingRecordService.channelName),
      );
      try {
        // 远程集合曾漏注册通道；即使 owner 已有记录，手机也只能收到 Unknown channel。
        await record.claimAnonymousRecord();
        await expect(record.shouldOnboard("mobile-device")).resolves.toBe(false);
        await record.dismissOnboarding("mobile-device");
        const entry = {
          occupation: "developer",
          interfaceMode: "coding" as const,
          memoryEnabled: false,
          proactiveSuggestionsEnabled: false,
          completedAt: "2026-10-09T00:00:00.000Z",
        };
        await record.appendRecord("mobile-device", entry);
        expect(services.get(IOnboardingRecordService)).toBe(owner);
        expect(owner.dismissOnboarding).toHaveBeenCalledWith("mobile-device");
        expect(owner.appendRecord).toHaveBeenCalledWith("mobile-device", entry);
        expect(other.claimAnonymousRecord).not.toHaveBeenCalled();
        expect(other.shouldOnboard).not.toHaveBeenCalled();
        expect(other.dismissOnboarding).not.toHaveBeenCalled();
        expect(other.appendRecord).not.toHaveBeenCalled();
        vi.mocked(owner.shouldOnboard).mockRejectedValueOnce(new Error("record read failed"));
        await expect(record.shouldOnboard("mobile-device")).rejects.toThrow("record read failed");
      } finally {
        client.dispose();
        server.dispose();
      }
    },
  );

  it.each([
    { sharedOwner: false, team: false },
    { sharedOwner: true, team: false },
    { sharedOwner: false, team: true },
  ])(
    "远程用量使用 Token，已有 Local Host owner=$sharedOwner，team=$team，不依赖旧 Key",
    async ({ sharedOwner, team }) => {
      const home = createTempHome();
      const owner = {
        resolveAccessCurrent: vi.fn(async () => null),
        resolveCurrent: vi.fn(async () => ({ apiKey: "project-token" })),
        assertCurrent: vi.fn(async () => undefined),
      };
      if (sharedOwner)
        vi.spyOn(nodeServices, "getAccountRequestAuthService").mockReturnValue(owner);
      const urls: string[] = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = String(input);
        urls.push(url);
        let data: unknown;
        if (url.endsWith("/getCustomerInfo"))
          data = {
            organizations: [{ organizationId: "org", projects: [{ projectId: "project" }] }],
          };
        else if (url.includes("/api_keys") && !url.endsWith("/access_tokens"))
          data = [
            {
              name: team ? "zcode-team-api-key" : "zcode-api-key",
              apiKey: "key",
              keyType: 2,
            },
          ];
        else if (url.endsWith("/access_tokens"))
          data = {
            accessToken: "project-token",
            tokenType: "Bearer",
            expiresIn: 600,
            expiresAt: Date.now() / 1000 + 600,
          };
        else if (url.includes("/querySubscribeDetail"))
          data = { hasSubscription: true, status: "EFFECTIVE", memberGrantStatus: "VALID" };
        else if (url.includes("/quota/limit")) {
          expect(new Headers(init?.headers).get("authorization")).toBe("project-token");
          data = { level: "pro", limits: [] };
        } else data = [];
        return new Response(JSON.stringify({ code: 200, data }), {
          headers: { "content-type": "application/json" },
        });
      });
      const services = createRemoteWorkspaceServiceCollection({
        clientConfigService,
        connectionServices: makeRemoteServices(),
        ...(sharedOwner ? { sourceServices: new ServiceCollection() } : {}),
        ...remoteWorkspaceHostOptions(),
        parentPort: null,
        createRemotePromptAttachmentTaskService: passthroughService,
        createRemotePromptAttachmentSessionService: passthroughService,
        createReportingRemoteZCodeTaskService: passthroughService,
      });
      try {
        const credentials = services.get(ICredentialService);
        await credentials.save("oauth:bigmodel:access_token", "login-token");
        await credentials.save(
          "oauth:bigmodel:user_info",
          JSON.stringify({ id: "user", username: "user", displayName: "User" }),
        );
        await expect(
          services.get(IUsageStatsService).getEntitlementSnapshot({
            includeSubscription: false,
            preferredProviderId: team
              ? BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan
              : BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
            accountAccess: {
              type: "zhipu-account",
              family: "bigmodel",
              ...(team
                ? {
                    planKind: "team-coding-plan" as const,
                    organizationId: "org",
                    projectId: "project",
                  }
                : { planKind: "individual-coding-plan" as const }),
            },
            requirePreferredProvider: true,
            allowEnvApiKey: false,
          }),
        ).resolves.toMatchObject({
          authenticated: true,
          quota: { level: "pro" },
        });
        expect(urls.some((url) => url.includes("/copy/"))).toBe(false);
        expect(urls.filter((url) => url.endsWith("/access_tokens"))).toHaveLength(
          sharedOwner ? 0 : 1,
        );
        expect(owner.resolveCurrent).toHaveBeenCalledTimes(sharedOwner ? 1 : 0);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it.each([
    { family: "bigmodel" as const, team: false },
    { family: "bigmodel" as const, team: true },
    { family: "zai" as const, team: false },
    { family: "zai" as const, team: true },
  ])(
    "fallback $family team=$team 的 401 指纹到达 PAT owner 并只刷新一次",
    async ({ family, team }) => {
      const home = createTempHome();
      const authFactory = vi.spyOn(nodeServices, "createAccountRequestAuthService");
      let issued = 0;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = String(input);
        const authorization = new Headers(init?.headers).get("authorization");
        // 桌面存储的是业务 JWT；这里不应再次调用 /api/auth/z/login。
        expect(url).not.toContain("/api/auth/z/login");
        let data: unknown;
        if (url.endsWith("/getCustomerInfo")) {
          expect(authorization).toBe(family === "zai" ? "Bearer business-jwt" : "business-jwt");
          data = {
            organizations: [{ organizationId: "org", projects: [{ projectId: "project" }] }],
          };
        } else if (url.endsWith("/access_tokens")) {
          expect(authorization).toBe("Bearer business-jwt");
          data = {
            accessToken: `pat-${++issued}`,
            tokenType: "Bearer",
            expiresIn: 600,
            expiresAt: Date.now() / 1000 + 600,
          };
        } else if (url.includes("/api_keys")) {
          expect(authorization).toBe(
            !team && family === "zai" ? "Bearer business-jwt" : "business-jwt",
          );
          data = [
            {
              name: team ? "zcode-team-api-key" : "zcode-api-key",
              apiKey: "key",
              keyType: 2,
            },
          ];
        } else throw new Error("Unexpected endpoint");
        return new Response(JSON.stringify({ code: 200, data }), {
          headers: { "content-type": "application/json" },
        });
      });
      const services = createRemoteWorkspaceServiceCollection({
        clientConfigService,
        connectionServices: makeRemoteServices(),
        ...remoteWorkspaceHostOptions(),
        parentPort: null,
        createRemotePromptAttachmentTaskService: passthroughService,
        createRemotePromptAttachmentSessionService: passthroughService,
        createReportingRemoteZCodeTaskService: passthroughService,
      });
      try {
        const credentials = services.get(ICredentialService);
        await credentials.save(`oauth:${family}:access_token`, "business-jwt");
        await credentials.save(
          `oauth:${family}:user_info`,
          JSON.stringify({ id: "user", username: "user", displayName: "User" }),
        );
        const auth = authFactory.mock.results.at(-1)!.value as ReturnType<
          typeof nodeServices.createAccountRequestAuthService
        >;
        const input = {
          providerId: `account:${family}-${team ? "team" : "individual"}-coding-plan`,
          reason: "model-request" as const,
          accountAccess: {
            type: "zhipu-account" as const,
            family,
            ...(team
              ? {
                  planKind: "team-coding-plan" as const,
                  organizationId: "org",
                  projectId: "project",
                }
              : { planKind: "individual-coding-plan" as const }),
          },
        };
        const first = await auth.resolveCurrent(input);
        expect(first.apiKey).toBe("pat-1");
        const retry = {
          ...input,
          expectedAccountScope: first.accountScope,
          rejectedProjectTokenFingerprint: await projectAccessTokenFingerprint(first.apiKey!),
        };
        const recovered = await Promise.all([
          auth.resolveCurrent(retry),
          auth.resolveCurrent(retry),
        ]);
        expect(recovered.map((value) => value.apiKey)).toEqual(["pat-2", "pat-2"]);
        expect((await auth.resolveCurrent(retry)).apiKey).toBe("pat-2");
        expect(issued).toBe(2);
        await credentials.save(`oauth:${family}:access_token`, "other-login");
        await expect(auth.resolveCurrent(retry)).rejects.toThrow("project_token_scope_invalidated");
        expect(issued).toBe(2);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it("bridges app-global runtime preferences without a workspace-scoped subscription", async () => {
    const home = createTempHome();
    vi.spyOn(globalThis, "fetch").mockImplementation(createPresetFetchMock("preflight-v1"));
    const remoteServices = makeRemoteServices();
    const services = createRemoteWorkspaceServiceCollection({
      clientConfigService,
      connectionServices: remoteServices,
      ...remoteWorkspaceHostOptions(),
      parentPort: null,
      createRemotePromptAttachmentTaskService: passthroughService,
      createRemotePromptAttachmentSessionService: passthroughService,
      createReportingRemoteZCodeTaskService: (service) => service,
    });
    const strategyResolver = vi.spyOn(
      services.get(ICodingPlanSubscriptionService),
      "getModelContextBudgetStrategy",
    );

    strategyResolver.mockImplementation(() => new Promise(() => {}));
    try {
      await services.get(ISettingService).update({
        askUserQuestionAutoResolutionEnabled: false,
        nativeSearchEnhancementsEnabled: false,
        integratedTerminalShell: {
          mode: "shell",
          dialect: "git-bash",
          id: "git-bash:C:/Program Files/Git/bin/bash.exe",
          label: "Git Bash",
          path: "C:/Program Files/Git/bin/bash.exe",
        },
      });
      remoteServices.runtimePreferencesEmitter.fire({
        requestId: "request-runtime-preferences",
        sessionId: "session-remote",
        scope: "runtime-materialization",
      });

      await vi.waitFor(() => {
        expect(
          remoteServices.zcodeAgentService.onDynamicSessionRuntimePreferencesRequest,
        ).toHaveBeenCalledWith();
        expect(
          remoteServices.zcodeAgentService.respondSessionRuntimePreferences,
        ).toHaveBeenCalledWith({
          requestId: "request-runtime-preferences",
          resolution: {
            status: "resolved",
            preferences: {
              askUserQuestionAutoResolutionEnabled: false,
              nativeSearchEnhancementsEnabled: false,
              memoryEnabled: false,
              modelContextBudgetStrategy: "preflight-v1",
            },
          },
        });
      });
      expect(strategyResolver).not.toHaveBeenCalled();
      strategyResolver.mockImplementation(() => new Promise(() => {}));
      remoteServices.runtimePreferencesEmitter.fire({
        requestId: "request-user-execution-preferences",
        sessionId: "session-remote",
        scope: "user-execution",
      });

      await vi.waitFor(() => {
        expect(
          remoteServices.zcodeAgentService.respondSessionRuntimePreferences,
        ).toHaveBeenCalledWith({
          requestId: "request-user-execution-preferences",
          resolution: {
            status: "resolved",
            preferences: {
              askUserQuestionAutoResolutionEnabled: false,
              nativeSearchEnhancementsEnabled: false,
              memoryEnabled: false,
              modelContextBudgetStrategy: "preflight-v1",
              integratedTerminalShell: {
                mode: "shell",
                dialect: "git-bash",
                id: "git-bash:C:/Program Files/Git/bin/bash.exe",
                label: "Git Bash",
                path: "C:/Program Files/Git/bin/bash.exe",
              },
            },
          },
        });
      });
      // 第二个 scope 只读取 Shell；即使 strategy 永不返回也不能新增调用或阻塞响应。
      expect(strategyResolver).not.toHaveBeenCalled();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reports a runtime preference response transport failure without retrying", async () => {
    const home = createTempHome();
    vi.spyOn(globalThis, "fetch").mockImplementation(createPresetFetchMock());
    const remoteServices = makeRemoteServices();
    const transportError = new Error("transport closed");
    const onError = vi.fn();
    remoteServices.zcodeAgentService.respondSessionRuntimePreferences.mockRejectedValueOnce(
      transportError,
    );
    const services = createRemoteWorkspaceServiceCollection({
      clientConfigService,
      connectionServices: remoteServices,
      ...remoteWorkspaceHostOptions(onError),
      parentPort: null,
      createRemotePromptAttachmentTaskService: passthroughService,
      createRemotePromptAttachmentSessionService: passthroughService,
      createReportingRemoteZCodeTaskService: (service) => service,
    });

    try {
      await services.get(ISettingService).update({
        askUserQuestionAutoResolutionEnabled: false,
        nativeSearchEnhancementsEnabled: false,
        memoryEnabled: false,
      });
      remoteServices.runtimePreferencesEmitter.fire({
        requestId: "request-closed-transport",
        sessionId: "session-remote",
        scope: "runtime-materialization",
      });

      await vi.waitFor(() => {
        expect(onError).toHaveBeenCalledOnce();
      });
      expect(onError).toHaveBeenCalledWith(transportError);
      expect(
        remoteServices.zcodeAgentService.respondSessionRuntimePreferences,
      ).toHaveBeenCalledOnce();
      expect(
        remoteServices.zcodeAgentService.respondSessionRuntimePreferences,
      ).toHaveBeenCalledWith({
        requestId: "request-closed-transport",
        resolution: {
          status: "resolved",
          preferences: {
            askUserQuestionAutoResolutionEnabled: false,
            nativeSearchEnhancementsEnabled: false,
            memoryEnabled: false,
            modelContextBudgetStrategy: "preflight-v1",
          },
        },
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not warm legacy model provider presets when constructing remote workspace services", async () => {
    const home = createTempHome();
    const fetchImpl = createPresetFetchMock();
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchImpl);
    const remoteServices = makeRemoteServices();
    createRemoteWorkspaceServiceCollection({
      clientConfigService,
      connectionServices: remoteServices,
      ...remoteWorkspaceHostOptions(),
      parentPort: null,
      createRemotePromptAttachmentTaskService: passthroughService,
      createRemotePromptAttachmentSessionService: passthroughService,
      createReportingRemoteZCodeTaskService: (service) => service,
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("exposes remote skill sync service in the remote connection host", () => {
    const remoteServices = makeRemoteServices();
    const credentialService = {
      load: vi.fn(),
      save: vi.fn(),
      delete: vi.fn(),
    };
    const services = createRemoteConnectionServiceCollection({
      clientConfigService,
      connectionServices: remoteServices,
      parentPort: null,
      credentialService,
      apiClient: { request: vi.fn() } as unknown as ApiClient,
      remoteZCodeTaskService: { remote: "wrapped-task" } as never,
      remoteZCodeSessionService: { remote: "wrapped-session" } as never,
    });

    expect(services.get(IClientConfigService)).toBe(clientConfigService);
    expect(services.get(ISkillsService)).toBe(remoteServices.skillsService);
    expect(services.get(ISkillSyncService)).toBe(remoteServices.skillSyncService);
    expect(services.get(IMcpSyncService)).toBe(remoteServices.mcpSyncService);
    expect(services.get(IPluginSyncService)).toBe(remoteServices.pluginSyncService);
    expect(services.get(IPluginsService)).toBe(remoteServices.pluginsService);
    expect(services.get(ICommandsService)).toBe(remoteServices.commandsService);
  });

  it("keeps server remote workspace runtime services server-authoritative", () => {
    const remoteServices = {
      ...makeRemoteServices(),
      settingService: { remote: "setting" },
      onboardingRecordService: createOnboardingRecordStub(),
      credentialService: { remote: "credential" },
      broadcastService: { remote: "broadcast" },
      botsService: { remote: "bots" },
      oauthService: { remote: "oauth" },
      usageStatsService: { remote: "usage-stats" },
      codingPlanSubscriptionService: { remote: "coding-plan" },
      pluginManagementService: { remote: "plugin-management" },
      subagentsService: { remote: "subagents" },
      hooksService: { remote: "hooks" },
      memoryService: { remote: "memory" },
      outputStyleService: { remote: "output-style" },
      settingsSyncService: { remote: "settings-sync" },
    } as never;

    const services = createServerRemoteWorkspaceServiceCollection({
      clientConfigService,
      connectionServices: remoteServices,
    });

    expect(services.get(IClientConfigService)).toBe(clientConfigService);
    expect(services.get(ISettingService)).toBe(remoteServices.settingService);
    expect(services.get(IOnboardingRecordService)).toBe(remoteServices.onboardingRecordService);
    expect(services.get(ICredentialService)).toBe(remoteServices.credentialService);
    expect(services.get(IBroadcastService)).toBe(remoteServices.broadcastService);
    expect(services.get(IBotsService)).toBe(remoteServices.botsService);
    expect(services.get(IOAuthService)).toBe(remoteServices.oauthService);
    expect(services.get(IModelSelectionService)).toBe(remoteServices.modelSelectionService);
    expect(services.get(IProviderSettingsService)).toBe(remoteServices.providerSettingsService);
    expect(services.get(IUsageStatsService)).toBe(remoteServices.usageStatsService);
    expect(services.get(ISubagentsService)).toBe(remoteServices.subagentsService);
    expect(services.get(ISettingsSyncService)).toBe(remoteServices.settingsSyncService);
  });

  it("materializes web remote task prompts before the reporting wrapper observes them", async () => {
    const hostAttachment = {
      kind: "file",
      filename: "pasted.txt",
      localPath: "/tmp/host-paste.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
      sourceKind: "clipboard-text",
    } as const;
    const remoteAttachment = {
      ...hostAttachment,
      localPath: "/home/tester/.zcode/tmp/prompt-attachments/input-1/01-pasted.txt",
    };
    const rawSendPrompt = vi.fn(async () => undefined);
    const observedByReporting: unknown[] = [];
    const remoteServices = {
      ...makeRemoteServices(),
      zcodeTaskService: { sendPrompt: rawSendPrompt },
    } as never;
    const services = createRemoteWorkspaceServiceCollection({
      clientConfigService,
      connectionServices: remoteServices,
      ...remoteWorkspaceHostOptions(),
      parentPort: null,
      createRemotePromptAttachmentTaskService: (service) =>
        createRemotePromptAttachmentTaskService(service, {
          materializePromptAttachments: async (params) => ({
            content: params.content.replace("/tmp/host-paste.txt", remoteAttachment.localPath),
            attachments: [remoteAttachment],
          }),
        }),
      createRemotePromptAttachmentSessionService: passthroughService,
      createReportingRemoteZCodeTaskService: (service) =>
        new Proxy(service, {
          get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver);
            if (property !== "sendPrompt" || typeof value !== "function") {
              return value;
            }
            return async (...args: unknown[]) => {
              observedByReporting.push(args[0]);
              return value.apply(target, args);
            };
          },
        }) as never,
    });

    await services.get(IZCodeTaskService).sendPrompt({
      taskId: "task-1",
      traceId: "input-1",
      content: "read /tmp/host-paste.txt",
      attachments: [hostAttachment],
    });

    const expectedParams = {
      taskId: "task-1",
      traceId: "input-1",
      content: "read /home/tester/.zcode/tmp/prompt-attachments/input-1/01-pasted.txt",
      attachments: [remoteAttachment],
    };
    expect(observedByReporting).toEqual([expectedParams]);
    expect(rawSendPrompt).toHaveBeenCalledWith(expectedParams);
  });
});
