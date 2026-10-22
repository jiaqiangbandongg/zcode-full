import {
  ServiceCollection,
  IFileService,
  IGenUiService,
  IMediaPreviewService,
  IGitService,
  IGitCheckpointService,
  ISystemService,
  ITerminalService,
  ISettingService,
  IOnboardingRecordService,
  ICredentialService,
  IBroadcastService,
  IZCodeTaskService,
  IZCodeAgentService,
  IZCodeSessionService,
  IConversationShareService,
  createUnsupportedConversationShareService,
  IBotsService,
  IFileWatcherService,
  IOAuthService,
  IModelSelectionService,
  IProviderSettingsService,
  ISourceServerWorkspaceService,
  IUsageStatsService,
  ICodingPlanSubscriptionService,
  IClientConfigService,
  IClientScenesService,
  ISkillsService,
  ISkillSyncService,
  IMcpSyncService,
  IPluginSyncService,
  IPluginsService,
  IPluginManagementService,
  ISubagentsService,
  ICommandsService,
  IHooksService,
  IMemoryService,
  IOutputStyleService,
  ISettingsSyncService,
  IProjectService,
  ITaskGroupService,
  IRemoteProjectService,
  IPromptAttachmentTransferService,
  type ServiceDescriptor,
  type IServiceAccessor,
} from "@zcode/services";
import {
  REMOTE_WORKSPACE_RPC_CHANNELS,
  assertRemoteWorkspaceRpcContract,
} from "./remoteWorkspaceRpcContract.js";
import {
  createServiceLogger,
  createLegacySingleRootProjectService,
  createRemoteProjectService,
} from "@zcode/services/node";
import {
  buildServerRemoteWorkspaceIdentity,
  remoteHostIdFromWorkspaceIdentity,
} from "@zcode/shared";
import type { RemoteTarget } from "@zcode/shared";
import {
  createRemoteProviderProvisioningExecutorFromWorkspace,
  registerRemoteProviderProvisioningExecutor,
} from "./remoteProviderProvisioningService.js";

export const REMOTE_WORKSPACE_RPC_REGISTRATIONS = [
  ["fileService", IFileService],
  ["genUiService", IGenUiService],
  ["mediaPreviewService", IMediaPreviewService],
  ["gitService", IGitService],
  ["gitCheckpointService", IGitCheckpointService],
  ["systemService", ISystemService],
  ["terminalService", ITerminalService],
  ["settingService", ISettingService],
  ["onboardingRecordService", IOnboardingRecordService],
  ["credentialService", ICredentialService],
  ["broadcastService", IBroadcastService],
  ["zcodeTaskService", IZCodeTaskService],
  ["zcodeAgentService", IZCodeAgentService],
  ["zcodeSessionService", IZCodeSessionService],
  ["conversationShareService", IConversationShareService],
  ["botsService", IBotsService],
  ["fileWatcherService", IFileWatcherService],
  ["oauthService", IOAuthService],
  ["providerSettingsService", IProviderSettingsService],
  ["modelSelectionService", IModelSelectionService],
  ["sourceServerWorkspaceService", ISourceServerWorkspaceService],
  ["usageStatsService", IUsageStatsService],
  ["codingPlanSubscriptionService", ICodingPlanSubscriptionService],
  ["clientScenesService", IClientScenesService],
  ["skillsService", ISkillsService],
  ["skillSyncService", ISkillSyncService],
  ["mcpSyncService", IMcpSyncService],
  ["pluginSyncService", IPluginSyncService],
  ["pluginsService", IPluginsService],
  ["pluginManagementService", IPluginManagementService],
  ["subagentsService", ISubagentsService],
  ["commandsService", ICommandsService],
  ["hooksService", IHooksService],
  ["memoryService", IMemoryService],
  ["outputStyleService", IOutputStyleService],
  ["settingsSyncService", ISettingsSyncService],
  ["promptAttachmentTransferService", IPromptAttachmentTransferService],
] as const satisfies readonly [keyof IServiceAccessor, ServiceDescriptor<unknown>][];

const conversationShareLog = createServiceLogger("conversation-share");

function createUnsupportedRemoteConversationShareService(): IConversationShareService {
  return createUnsupportedConversationShareService({
    message: "Conversation sharing is not available for this client or remote target",
    onRejected: (action) => {
      conversationShareLog.warn(undefined, "conversation share action rejected", {
        action,
        kind: "feature_disabled",
        reason: "server_remote_unsupported",
      });
    },
  });
}

export function resolveServerProjectService(params: {
  connectionServices: IServiceAccessor;
  serverId: string;
  virtualProjects?: boolean;
  sourceServices?: ServiceCollection;
}): IProjectService {
  if (params.virtualProjects) {
    if (!params.connectionServices.projectService)
      throw new Error("Remote virtual-project RPC registration incomplete");
    return params.connectionServices.projectService;
  }
  const hostId = remoteHostIdFromWorkspaceIdentity(
    buildServerRemoteWorkspaceIdentity({ serverId: params.serverId, workspacePath: "/" }),
  )!;
  return createLegacySingleRootProjectService({
    hostId,
    directories: {
      info: () => params.connectionServices.systemService.info(),
      read: (input) => params.connectionServices.fileService.readdir(input),
    },
    readSettings: () => params.connectionServices.settingService.get(),
    readKnownWorkspaces: async () => {
      const directory = await params.sourceServices
        ?.getOptional(IRemoteProjectService)
        ?.readDirectory();
      return (directory?.entries ?? [])
        .filter((entry) => entry.hostId === hostId)
        .flatMap((entry) =>
          entry.roots.length
            ? entry.roots.map((root) => ({ workspacePath: root.rootPath }))
            : entry.legacyWorkspace
              ? [
                  {
                    workspacePath: entry.legacyWorkspace.workspacePath,
                    workspacePurpose: entry.legacyWorkspace.workspacePurpose,
                  },
                ]
              : [],
        );
    },
    readTasks: ({ workspacePath, kind }) => {
      const tasks = params.connectionServices.zcodeTaskService;
      const scope = { workspacePath };
      return kind === "pinned"
        ? tasks.listPinnedTasks(scope)
        : kind === "archived"
          ? tasks.listArchivedTasks(scope)
          : tasks.listTasks(scope);
    },
    ensureConversation: async () =>
      (await params.connectionServices.fileService.ensureConversationWorkspace()).path,
  });
}

export function createServerRemoteWorkspaceServiceCollection(params: {
  clientConfigService: IClientConfigService;
  connectionServices: IServiceAccessor;
  virtualProjects?: boolean;
  serverId?: string;
  targetKind: RemoteTarget["kind"];
  /** 本机 Local Host 服务；提供 Provider Provisioning Source，缺失时 Provisioning 按 unsupported 处理。 */
  sourceServices?: ServiceCollection;
}): ServiceCollection {
  assertRemoteWorkspaceRpcContract(params.connectionServices);
  // Server remote 连接的是一个已经运行的完整 ZCode server。
  // Host 只做 RPC 转接，不替 server 决定 workspace/runtime/provider 归属；
  // Provider 配置只经 Host 私有的 Provisioning executor 从本机单向下发到远端。
  const remoteProviderProvisioningExecutor =
    createRemoteProviderProvisioningExecutorFromWorkspace(params);
  const services = new ServiceCollection()
    .register(IFileService, params.connectionServices.fileService)
    // 根因：客户端已有 gen-ui 代理，但 Host 漏转发使远端读取成为 Unknown channel。
    // 复用 Source 的读取与输出目录校验；桌面状态/沙箱仍由 base services 提供。
    .register(IGenUiService, params.connectionServices.genUiService)
    .register(IMediaPreviewService, params.connectionServices.mediaPreviewService)
    .register(IGitService, params.connectionServices.gitService)
    .register(IGitCheckpointService, params.connectionServices.gitCheckpointService)
    .register(ISystemService, params.connectionServices.systemService)
    .register(ITerminalService, params.connectionServices.terminalService)
    .register(ISettingService, params.connectionServices.settingService)
    // Bug 原因：远程集合曾漏注册此通道，手机重建 Root 后调用失败，回退 settings 判定而误弹引导。
    // 引导记录必须与该入口的 settings/OAuth 同源：R3 下四种 transport 都由 Source 持有，不借用本机记录。
    .register(IOnboardingRecordService, params.connectionServices.onboardingRecordService)
    .register(ICredentialService, params.connectionServices.credentialService)
    .register(IBroadcastService, params.connectionServices.broadcastService)
    .register(IZCodeTaskService, params.connectionServices.zcodeTaskService)
    .register(IZCodeAgentService, params.connectionServices.zcodeAgentService)
    .register(IZCodeSessionService, params.connectionServices.zcodeSessionService)
    // R3 的分享属于目标 Environment；不能恢复旧 SSH 的本机 JWT 混装。
    .register(
      IConversationShareService,
      params.targetKind === "server"
        ? createUnsupportedRemoteConversationShareService()
        : params.connectionServices.conversationShareService,
    )
    .register(IBotsService, params.connectionServices.botsService)
    .register(IFileWatcherService, params.connectionServices.fileWatcherService)
    .register(IOAuthService, params.connectionServices.oauthService)
    .register(IProviderSettingsService, params.connectionServices.providerSettingsService)
    .register(IModelSelectionService, params.connectionServices.modelSelectionService)
    .register(ISourceServerWorkspaceService, params.connectionServices.sourceServerWorkspaceService)
    .register(IUsageStatsService, params.connectionServices.usageStatsService)
    .register(
      ICodingPlanSubscriptionService,
      params.connectionServices.codingPlanSubscriptionService,
    )
    .register(IClientConfigService, params.clientConfigService)
    .register(IClientScenesService, params.connectionServices.clientScenesService)
    .register(ISkillsService, params.connectionServices.skillsService)
    .register(ISkillSyncService, params.connectionServices.skillSyncService)
    .register(IMcpSyncService, params.connectionServices.mcpSyncService)
    // Bug 原因：RPC 合同已经要求 plugin-sync，但旧全转发集合漏注册，远端插件同步会在 Host
    // 二次暴露时变成 Unknown channel。全转发集合必须与合同逐项一致。
    .register(IPluginSyncService, params.connectionServices.pluginSyncService)
    .register(IPluginsService, params.connectionServices.pluginsService)
    .register(IPluginManagementService, params.connectionServices.pluginManagementService)
    .register(ISubagentsService, params.connectionServices.subagentsService)
    .register(ICommandsService, params.connectionServices.commandsService)
    .register(IHooksService, params.connectionServices.hooksService)
    .register(IMemoryService, params.connectionServices.memoryService)
    .register(IOutputStyleService, params.connectionServices.outputStyleService)
    .register(ISettingsSyncService, params.connectionServices.settingsSyncService)
    .register(
      IPromptAttachmentTransferService,
      params.connectionServices.promptAttachmentTransferService,
    );
  // 新频道必须以握手能力为准；客户端总能生成 proxy，不能用对象存在性判断旧 Server 支持。
  if (params.virtualProjects) {
    if (
      !params.connectionServices.projectService ||
      !params.connectionServices.remoteProjectService
    )
      throw new Error("Remote virtual-project RPC registration incomplete");
    services.register(IProjectService, params.connectionServices.projectService);
    services.register(IRemoteProjectService, params.connectionServices.remoteProjectService);
  } else if (params.serverId) {
    services.register(
      IProjectService,
      resolveServerProjectService({ ...params, serverId: params.serverId }),
    );
    services.register(
      IRemoteProjectService,
      createRemoteProjectService({
        controller: false,
        database: async () => {
          throw new Error("remote-project.controller-only");
        },
      }),
    );
  }
  const controllerGroups = params.sourceServices?.getOptional(ITaskGroupService);
  const controllerBroadcast = params.sourceServices?.getOptional(IBroadcastService);
  if (controllerGroups) services.register(ITaskGroupService, controllerGroups);
  if (controllerGroups && controllerBroadcast) {
    const remoteBroadcast = params.connectionServices.broadcastService;
    services.register(IBroadcastService, {
      send: (message) =>
        (message.channel === "state:task-groups" ? controllerBroadcast : remoteBroadcast).send(
          message,
        ),
      acquireClaim: (key) => remoteBroadcast.acquireClaim(key),
      commitClaim: (lease) => remoteBroadcast.commitClaim(lease),
      releaseClaim: (lease) => remoteBroadcast.releaseClaim(lease),
      tryClaim: (key) => remoteBroadcast.tryClaim(key),
      onMessage: (listener) => {
        const remote = remoteBroadcast.onMessage((event) => {
          if (event.channel !== "state:task-groups") listener(event);
        });
        const local = controllerBroadcast.onMessage((event) => {
          if (event.channel === "state:task-groups") listener(event);
        });
        return {
          dispose: () => {
            remote.dispose();
            local.dispose();
          },
        };
      },
    });
  }
  const registrationKeys = new Set(REMOTE_WORKSPACE_RPC_REGISTRATIONS.map(([key]) => key));
  const missing = [
    ...REMOTE_WORKSPACE_RPC_CHANNELS.filter((key) => !registrationKeys.has(key)),
    ...REMOTE_WORKSPACE_RPC_REGISTRATIONS.filter(
      ([, descriptor]) =>
        services.getOptional(descriptor as ServiceDescriptor<unknown>) === undefined,
    ).map(([key]) => key),
  ];
  if (missing.length > 0) {
    throw new Error(`Remote workspace RPC registration incomplete: ${missing.join(", ")}`);
  }
  registerRemoteProviderProvisioningExecutor(services, remoteProviderProvisioningExecutor);
  return services;
}
