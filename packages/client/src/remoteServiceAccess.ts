import { IGenUiService } from "@zcode/services";
import { ProxyChannel, type IChannelClient } from "@zcode/rpc";
import {
  IFileService,
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
  IProjectService,
  ITaskGroupService,
  IRemoteProjectService,
  ICuaPermissionService,
  IConversationShareService,
  IBotsService,
  IFileWatcherService,
  IOAuthService,
  IModelSelectionService,
  IProviderSettingsService,
  IProviderProvisioningTargetService,
  ISourceServerWorkspaceService,
  ISourceServerManagementService,
  IUsageStatsService,
  ICodingPlanSubscriptionService,
  IClientConfigService,
  IClientScenesService,
  ICloudContentService,
  IMarketingTouchService,
  IOffPeakTaskService,
  IHighspeedCardService,
  ISkillsService,
  ISkillSyncService,
  IMcpSyncService,
  IPluginUiAppToolsService,
  IPluginUiSamplingService,
  IPluginUiBridgeService,
  IPluginSyncService,
  IPluginsService,
  IPluginManagementService,
  ISubagentsService,
  ICommandsService,
  IHooksService,
  IMemoryService,
  IOutputStyleService,
  ISettingsSyncService,
  IFeedbackService,
  IPromptAttachmentTransferService,
  IWindowControllerService,
  IWindowProjectService,
  IWindowRemoteProjectService,
  IWindowProjectChangesService,
  type WindowProjectDirectoryServices,
  type IServiceAccessor,
} from "@zcode/services";

/**
 * RemoteServiceAccess — 通过 ChannelClient 自动创建类型安全的服务代理
 *
 * 新增服务只需在此添加一个 getter。
 */
export class RemoteServiceAccess implements IServiceAccessor {
  readonly windowProjectDirectory?: WindowProjectDirectoryServices;
  readonly fileService: IFileService;
  readonly mediaPreviewService: IMediaPreviewService;
  readonly gitService: IGitService;
  readonly gitCheckpointService: IGitCheckpointService;
  readonly systemService: ISystemService;
  readonly terminalService: ITerminalService;
  readonly settingService: ISettingService;
  readonly onboardingRecordService: IOnboardingRecordService;
  readonly credentialService: ICredentialService;
  readonly broadcastService: IBroadcastService;
  readonly zcodeTaskService: IZCodeTaskService;
  readonly windowControllerService: IWindowControllerService;
  readonly zcodeAgentService: IZCodeAgentService;
  readonly zcodeSessionService: IZCodeSessionService;
  readonly taskGroupService: ITaskGroupService;
  readonly projectService: IProjectService;
  readonly remoteProjectService: IRemoteProjectService;
  // cuaPermissionService 在 IServiceAccessor 上是可选（远端/bots host 不提供），但桌面 renderer
  // 经 RPC 一定能拿到（main host 始终注册此 descriptor；非 macOS / 未启用时方法返回 available:false）。
  readonly cuaPermissionService: ICuaPermissionService;
  readonly conversationShareService: IConversationShareService;
  readonly botsService: IBotsService;
  readonly fileWatcherService: IFileWatcherService;
  readonly oauthService: IOAuthService;
  readonly providerSettingsService: IProviderSettingsService;
  readonly modelSelectionService: IModelSelectionService;
  /** Host-only target proxy；不属于 IServiceAccessor，避免向 Renderer 暴露 Secret 写入接口。 */
  readonly providerProvisioningTargetService!: IProviderProvisioningTargetService;
  readonly sourceServerWorkspaceService: ISourceServerWorkspaceService;
  /** 仅 desktop base attachment 注册；其他 scope 必须按可选能力消费。 */
  readonly sourceServerManagementService?: ISourceServerManagementService;
  readonly usageStatsService: IUsageStatsService;
  readonly codingPlanSubscriptionService: ICodingPlanSubscriptionService;
  readonly clientConfigService: IClientConfigService;
  readonly clientScenesService: IClientScenesService;
  readonly cloudContentService: ICloudContentService;
  readonly marketingTouchService: IMarketingTouchService;
  readonly offPeakTaskService: IOffPeakTaskService;
  readonly highspeedCardService: IHighspeedCardService;
  readonly skillsService: ISkillsService;
  readonly skillSyncService: ISkillSyncService;
  readonly mcpSyncService: IMcpSyncService;
  readonly genUiService: IGenUiService;
  readonly pluginUiBridgeService: IPluginUiBridgeService;
  readonly pluginUiSamplingService: IPluginUiSamplingService;
  readonly pluginUiAppToolsService: IPluginUiAppToolsService;
  readonly pluginSyncService: IPluginSyncService;
  readonly pluginsService: IPluginsService;
  readonly pluginManagementService: IPluginManagementService;
  readonly subagentsService: ISubagentsService;
  readonly commandsService: ICommandsService;
  readonly hooksService: IHooksService;
  readonly memoryService: IMemoryService;
  readonly outputStyleService: IOutputStyleService;
  readonly settingsSyncService: ISettingsSyncService;
  readonly feedbackService: IFeedbackService;
  readonly promptAttachmentTransferService: IPromptAttachmentTransferService;

  constructor(
    channelClient: IChannelClient,
    options: { sourceServerManagementService?: boolean; windowProjectDirectory?: boolean } = {},
  ) {
    // 远端工作区的 project 必须保留 Source 语义；只有显式能力才创建完整窗口目录组。
    if (options.windowProjectDirectory) {
      this.windowProjectDirectory = {
        projectService: ProxyChannel.toService(
          channelClient.getChannel(IWindowProjectService.channelName),
        ),
        remoteProjectService: ProxyChannel.toService(
          channelClient.getChannel(IWindowRemoteProjectService.channelName),
        ),
        changesService: ProxyChannel.toService(
          channelClient.getChannel(IWindowProjectChangesService.channelName),
        ),
      };
    }
    this.fileService = ProxyChannel.toService<IFileService>(
      channelClient.getChannel(IFileService.channelName),
    );
    // Host 已注册 media-preview channel，但遗漏 renderer proxy 时，PreviewPane
    // 会静默回退到 8 MiB 的 file.readMediaPreview，导致大 MP4 无法打开。
    this.mediaPreviewService = ProxyChannel.toService<IMediaPreviewService>(
      channelClient.getChannel(IMediaPreviewService.channelName),
    );
    this.gitService = ProxyChannel.toService<IGitService>(
      channelClient.getChannel(IGitService.channelName),
    );
    this.gitCheckpointService = ProxyChannel.toService<IGitCheckpointService>(
      channelClient.getChannel(IGitCheckpointService.channelName),
    );
    this.systemService = ProxyChannel.toService<ISystemService>(
      channelClient.getChannel(ISystemService.channelName),
    );
    this.terminalService = ProxyChannel.toService<ITerminalService>(
      channelClient.getChannel(ITerminalService.channelName),
    );
    this.settingService = ProxyChannel.toService<ISettingService>(
      channelClient.getChannel(ISettingService.channelName),
    );
    this.onboardingRecordService = ProxyChannel.toService<IOnboardingRecordService>(
      channelClient.getChannel(IOnboardingRecordService.channelName),
    );
    this.credentialService = ProxyChannel.toService<ICredentialService>(
      channelClient.getChannel(ICredentialService.channelName),
    );
    this.broadcastService = ProxyChannel.toService<IBroadcastService>(
      channelClient.getChannel(IBroadcastService.channelName),
    );
    this.zcodeTaskService = ProxyChannel.toService<IZCodeTaskService>(
      channelClient.getChannel(IZCodeTaskService.channelName),
    );
    this.windowControllerService = ProxyChannel.toService<IWindowControllerService>(
      channelClient.getChannel(IWindowControllerService.channelName),
    );
    this.zcodeAgentService = ProxyChannel.toService<IZCodeAgentService>(
      channelClient.getChannel(IZCodeAgentService.channelName),
    );
    this.remoteProjectService = ProxyChannel.toService<IRemoteProjectService>(
      channelClient.getChannel(IRemoteProjectService.channelName),
    );
    this.taskGroupService = ProxyChannel.toService<ITaskGroupService>(
      channelClient.getChannel(ITaskGroupService.channelName),
    );
    this.projectService = ProxyChannel.toService<IProjectService>(
      channelClient.getChannel(IProjectService.channelName),
    );
    this.zcodeSessionService = ProxyChannel.toService<IZCodeSessionService>(
      channelClient.getChannel(IZCodeSessionService.channelName),
    );
    this.cuaPermissionService = ProxyChannel.toService<ICuaPermissionService>(
      channelClient.getChannel(ICuaPermissionService.channelName),
    );
    this.conversationShareService = ProxyChannel.toService<IConversationShareService>(
      channelClient.getChannel(IConversationShareService.channelName),
    );
    this.botsService = ProxyChannel.toService<IBotsService>(
      channelClient.getChannel(IBotsService.channelName),
    );
    this.fileWatcherService = ProxyChannel.toService<IFileWatcherService>(
      channelClient.getChannel(IFileWatcherService.channelName),
    );
    this.oauthService = ProxyChannel.toService<IOAuthService>(
      channelClient.getChannel(IOAuthService.channelName),
    );
    this.providerSettingsService = ProxyChannel.toService<IProviderSettingsService>(
      channelClient.getChannel(IProviderSettingsService.channelName),
    );
    this.modelSelectionService = ProxyChannel.toService<IModelSelectionService>(
      channelClient.getChannel(IModelSelectionService.channelName),
    );
    Object.defineProperty(this, "providerProvisioningTargetService", {
      value: ProxyChannel.toService<IProviderProvisioningTargetService>(
        channelClient.getChannel(IProviderProvisioningTargetService.channelName),
      ),
      enumerable: false,
    });
    this.sourceServerWorkspaceService = ProxyChannel.toService<ISourceServerWorkspaceService>(
      channelClient.getChannel(ISourceServerWorkspaceService.channelName),
    );
    // Bug 原因：ProxyChannel 是惰性的，无论服务端是否注册 channel 都能构造出“看似存在”
    // 的对象，optional 合同因此在首次调用时才失败。scope 创建时必须显式声明能力。
    this.sourceServerManagementService = options.sourceServerManagementService
      ? ProxyChannel.toService<ISourceServerManagementService>(
          channelClient.getChannel(ISourceServerManagementService.channelName),
        )
      : undefined;
    this.usageStatsService = ProxyChannel.toService<IUsageStatsService>(
      channelClient.getChannel(IUsageStatsService.channelName),
    );
    this.codingPlanSubscriptionService = ProxyChannel.toService<ICodingPlanSubscriptionService>(
      channelClient.getChannel(ICodingPlanSubscriptionService.channelName),
    );
    this.clientConfigService = ProxyChannel.toService<IClientConfigService>(
      channelClient.getChannel(IClientConfigService.channelName),
    );
    this.clientScenesService = ProxyChannel.toService<IClientScenesService>(
      channelClient.getChannel(IClientScenesService.channelName),
    );
    this.cloudContentService = ProxyChannel.toService<ICloudContentService>(
      channelClient.getChannel(ICloudContentService.channelName),
    );
    this.marketingTouchService = ProxyChannel.toService<IMarketingTouchService>(
      channelClient.getChannel(IMarketingTouchService.channelName),
    );
    this.offPeakTaskService = ProxyChannel.toService<IOffPeakTaskService>(
      channelClient.getChannel(IOffPeakTaskService.channelName),
    );
    this.highspeedCardService = ProxyChannel.toService<IHighspeedCardService>(
      channelClient.getChannel(IHighspeedCardService.channelName),
    );
    this.skillsService = ProxyChannel.toService<ISkillsService>(
      channelClient.getChannel(ISkillsService.channelName),
    );
    this.skillSyncService = ProxyChannel.toService<ISkillSyncService>(
      channelClient.getChannel(ISkillSyncService.channelName),
    );
    this.mcpSyncService = ProxyChannel.toService<IMcpSyncService>(
      channelClient.getChannel(IMcpSyncService.channelName),
    );
    this.genUiService = ProxyChannel.toService<IGenUiService>(
      channelClient.getChannel(IGenUiService.channelName),
    );
    this.pluginUiBridgeService = ProxyChannel.toService<IPluginUiBridgeService>(
      channelClient.getChannel(IPluginUiBridgeService.channelName),
    );
    this.pluginUiSamplingService = ProxyChannel.toService<IPluginUiSamplingService>(
      channelClient.getChannel(IPluginUiSamplingService.channelName),
    );
    this.pluginUiAppToolsService = ProxyChannel.toService<IPluginUiAppToolsService>(
      channelClient.getChannel(IPluginUiAppToolsService.channelName),
    );
    this.pluginSyncService = ProxyChannel.toService<IPluginSyncService>(
      channelClient.getChannel(IPluginSyncService.channelName),
    );
    this.pluginsService = ProxyChannel.toService<IPluginsService>(
      channelClient.getChannel(IPluginsService.channelName),
    );
    this.pluginManagementService = ProxyChannel.toService<IPluginManagementService>(
      channelClient.getChannel(IPluginManagementService.channelName),
    );
    this.subagentsService = ProxyChannel.toService<ISubagentsService>(
      channelClient.getChannel(ISubagentsService.channelName),
    );
    this.commandsService = ProxyChannel.toService<ICommandsService>(
      channelClient.getChannel(ICommandsService.channelName),
    );
    this.hooksService = ProxyChannel.toService<IHooksService>(
      channelClient.getChannel(IHooksService.channelName),
    );
    this.memoryService = ProxyChannel.toService<IMemoryService>(
      channelClient.getChannel(IMemoryService.channelName),
    );
    this.outputStyleService = ProxyChannel.toService<IOutputStyleService>(
      channelClient.getChannel(IOutputStyleService.channelName),
    );
    this.settingsSyncService = ProxyChannel.toService<ISettingsSyncService>(
      channelClient.getChannel(ISettingsSyncService.channelName),
    );
    this.feedbackService = ProxyChannel.toService<IFeedbackService>(
      channelClient.getChannel(IFeedbackService.channelName),
    );
    this.promptAttachmentTransferService = ProxyChannel.toService<IPromptAttachmentTransferService>(
      channelClient.getChannel(IPromptAttachmentTransferService.channelName),
    );
  }
}
