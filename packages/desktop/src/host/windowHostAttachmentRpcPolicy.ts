import type { IChannelServer } from "@zcode/rpc";
import {
  ServiceCollection,
  IProjectService,
  IRemoteProjectService,
  IBroadcastService,
  IWindowProjectService,
  IWindowRemoteProjectService,
  IWindowProjectChangesService,
  createWindowProjectChangesService,
  type ServiceExposurePolicy,
  type ZCodeAgentV4ClientMode,
} from "@zcode/services";
import { ServiceChannels } from "@zcode/shared";

const WEB_REMOTE_REPLAYABLE_ALLOWED_CHANNELS = new Set<string>([
  ServiceChannels.File,
  ServiceChannels.MediaPreview,
  ServiceChannels.System,
  ServiceChannels.Git,
  ServiceChannels.GitCheckpoint,
  ServiceChannels.Setting,
  // 引导记录与 settings 同属该 attachment 的 owner；漏放行时手机调用超时，回退 settings 判定误弹引导。
  ServiceChannels.OnboardingRecord,
  ServiceChannels.Credential,
  ServiceChannels.CuaPermission,
  ServiceChannels.CuaPipSession,
  ServiceChannels.Broadcast,
  ServiceChannels.ZCodeTask,
  ServiceChannels.WindowController,
  ServiceChannels.ZCodeAgent,
  ServiceChannels.ZCodeSession,
  ServiceChannels.Project,
  ServiceChannels.TaskGroups,
  ServiceChannels.RemoteProjects,
  ServiceChannels.WindowProject,
  ServiceChannels.WindowRemoteProjects,
  ServiceChannels.WindowProjectChanges,
  // ConversationShare 由 scopeConversationShareServiceForAttachment 按 clientMode 包装：手机只保留
  // getCapabilities/getPreview 只读透传，publish/import/continuation 一律 feature_disabled。
  ServiceChannels.ConversationShare,
  ServiceChannels.FileWatcher,
  ServiceChannels.OAuth,
  ServiceChannels.ProviderSettings,
  ServiceChannels.ModelSelection,
  // ProviderProvisioningTarget 携带跨 Environment 凭据写入，只允许受信 Desktop Host 调用，绝不进手机 allowlist。
  ServiceChannels.SourceServerWorkspace,
  ServiceChannels.UsageStats,
  ServiceChannels.CodingPlanSubscription,
  ServiceChannels.ClientScenes,
  ServiceChannels.Skills,
  ServiceChannels.SkillSync,
  ServiceChannels.McpSync,
  ServiceChannels.PluginSync,
  ServiceChannels.Plugins,
  ServiceChannels.PluginManagement,
  ServiceChannels.Subagents,
  ServiceChannels.Commands,
  ServiceChannels.Hooks,
  ServiceChannels.Memory,
  ServiceChannels.OutputStyle,
  ServiceChannels.SettingsSync,
  ServiceChannels.Bots,
  ServiceChannels.Feedback,
  ServiceChannels.PromptAttachmentTransfer,
  ServiceChannels.OffPeakTask,
]);

const WEB_REMOTE_REPLAYABLE_EXPOSURE_POLICY: ServiceExposurePolicy = {
  allowedChannels: WEB_REMOTE_REPLAYABLE_ALLOWED_CHANNELS,
};

export function resolveWindowHostServiceExposurePolicy(
  clientMode: ZCodeAgentV4ClientMode,
): ServiceExposurePolicy | undefined {
  // Bug 根因：Host 以前把完整 ServiceCollection 当成 attachment 授权，并只用 denylist
  // 排除了 Source 管理；新注册的高权限 channel 会自动暴露给手机，Terminal 因此可直接创建 PTY。
  // mobile 必须使用显式 allowlist，让未审阅 channel 默认 fail-closed；桌面继续保持完整服务面。
  return clientMode === "web-remote-replayable" ? WEB_REMOTE_REPLAYABLE_EXPOSURE_POLICY : undefined;
}

export function exposeWindowHostAttachmentServices(params: {
  server: IChannelServer;
  services: ServiceCollection;
  clientMode: ZCodeAgentV4ClientMode;
  overrides?: ReadonlyMap<string, unknown>;
  attachmentScope?: { kind: "local" | "remote" | "source-settings" };
  windowServices?: ServiceCollection;
}): void {
  if (params.clientMode === "web-remote-replayable" && params.attachmentScope?.kind === "remote") {
    if (!params.windowServices) throw new Error("window-project-directory.unavailable");
    // 原 project 属于 Source，替换会破坏工作区内的 mentions 等调用；窗口目录另用完整频道组。
    // 先取得所有必需服务，缺失时不发布部分频道，也不修改共享远端 ServiceCollection。
    const directory = new ServiceCollection()
      .register(IWindowProjectService, params.windowServices.get(IProjectService))
      .register(IWindowRemoteProjectService, params.windowServices.get(IRemoteProjectService))
      .register(
        IWindowProjectChangesService,
        createWindowProjectChangesService(params.windowServices.get(IBroadcastService)),
      );
    directory.exposeOnChannelServer(
      params.server,
      undefined,
      resolveWindowHostServiceExposurePolicy(params.clientMode),
    );
  }
  params.services.exposeOnChannelServer(
    params.server,
    params.overrides,
    resolveWindowHostServiceExposurePolicy(params.clientMode),
  );
}
