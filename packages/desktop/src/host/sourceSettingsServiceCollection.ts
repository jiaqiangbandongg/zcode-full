import {
  ServiceCollection,
  ICredentialService,
  IOAuthService,
  ICodingPlanSubscriptionService,
  ISettingService,
  ISystemService,
  ISourceServerWorkspaceService,
  ISkillsService,
  ISkillSyncService,
  IMcpSyncService,
  IPluginSyncService,
  IPluginsService,
  IPluginManagementService,
  ICommandsService,
  IHooksService,
  ISubagentsService,
  IMemoryService,
  IOutputStyleService,
  ISettingsSyncService,
  type IServiceAccessor,
  type ServiceDescriptor,
} from "@zcode/services";
import type { SourceServerConnectionState } from "@zcode/shared";

export function shouldDetachSourceSettingsAttachment(state: SourceServerConnectionState): boolean {
  // 只有 online generation 可继续服务设置，updating 也可能已经 dispose 旧连接。
  return state !== "online";
}

/**
 * Source settings attachment 只暴露 skills/MCP/plugins/hooks/settings-sync 等远端配置面。
 * 模型 Provider 设置永远绑定本地 Environment，远端 Provider 事实只经 Provisioning 单向下发，
 * 因此这里不注册 provider-settings / model-selection。
 */
export function createSourceSettingsServiceCollection(
  services: IServiceAccessor | ServiceCollection,
): ServiceCollection {
  const read = <T>(descriptor: ServiceDescriptor<T>, get: (accessor: IServiceAccessor) => T): T =>
    services instanceof ServiceCollection ? services.get(descriptor) : get(services);
  return new ServiceCollection()
    .register(
      ICredentialService,
      read(ICredentialService, (accessor) => accessor.credentialService),
    )
    .register(
      IOAuthService,
      read(IOAuthService, (accessor) => accessor.oauthService),
    )
    .register(
      ICodingPlanSubscriptionService,
      read(ICodingPlanSubscriptionService, (accessor) => accessor.codingPlanSubscriptionService),
    )
    .register(
      ISettingService,
      read(ISettingService, (accessor) => accessor.settingService),
    )
    .register(
      ISystemService,
      read(ISystemService, (accessor) => accessor.systemService),
    )
    .register(
      ISourceServerWorkspaceService,
      read(ISourceServerWorkspaceService, (accessor) => accessor.sourceServerWorkspaceService),
    )
    .register(
      ISkillsService,
      read(ISkillsService, (accessor) => accessor.skillsService),
    )
    .register(
      ISkillSyncService,
      read(ISkillSyncService, (accessor) => accessor.skillSyncService),
    )
    .register(
      IMcpSyncService,
      read(IMcpSyncService, (accessor) => accessor.mcpSyncService),
    )
    .register(
      IPluginSyncService,
      read(IPluginSyncService, (accessor) => accessor.pluginSyncService),
    )
    .register(
      IPluginsService,
      read(IPluginsService, (accessor) => accessor.pluginsService),
    )
    .register(
      IPluginManagementService,
      read(IPluginManagementService, (accessor) => accessor.pluginManagementService),
    )
    .register(
      ICommandsService,
      read(ICommandsService, (accessor) => accessor.commandsService),
    )
    .register(
      IHooksService,
      read(IHooksService, (accessor) => accessor.hooksService),
    )
    .register(
      ISubagentsService,
      read(ISubagentsService, (accessor) => accessor.subagentsService),
    )
    .register(
      IMemoryService,
      read(IMemoryService, (accessor) => accessor.memoryService),
    )
    .register(
      IOutputStyleService,
      read(IOutputStyleService, (accessor) => accessor.outputStyleService),
    )
    .register(
      ISettingsSyncService,
      read(ISettingsSyncService, (accessor) => accessor.settingsSyncService),
    );
}
