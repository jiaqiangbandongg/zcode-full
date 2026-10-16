import { describe, expect, it, vi } from "vitest";
import { IHooksService, type IServiceAccessor } from "@zcode/services";
import { ChannelClient, ChannelServer, ProxyChannel, createQueuePair } from "@zcode/rpc";
import {
  buildRemoteWorkspaceSessionServices,
  buildServerRemoteWorkspaceSessionServices,
} from "../src/renderer/src/remoteWorkspaceSessionServices.js";

function makeServices(id: string): IServiceAccessor {
  return {
    fileService: { id, service: "file" },
    gitService: { id, service: "git" },
    gitCheckpointService: { id, service: "gitCheckpoint" },
    systemService: { id, service: "system" },
    terminalService: { id, service: "terminal" },
    promptAttachmentTransferService: { id, service: "prompt-attachment-transfer" },
    zcodeAgentService: { id, service: "zcode-agent" },
    zcodeTaskService: { id, service: "zcode-task" },
    zcodeSessionService: { id, service: "zcode-session" },
    conversationShareService: { id, service: "conversation-share" },
    fileWatcherService: { id, service: "fileWatcher" },
    skillsService: { id, service: "skills" },
    skillSyncService: { id, service: "skill-sync" },
    mcpSyncService: { id, service: "mcp-sync" },
    pluginSyncService: { id, service: "plugin-sync" },
    pluginsService: { id, service: "plugins" },
    commandsService: { id, service: "commands" },
    hooksService: { id, service: "hooks" },
    clientScenesService: { id, service: "clientScenes" },
    settingService: { id, service: "setting" },
    credentialService: { id, service: "credential" },
    oauthService: { id, service: "oauth" },
    broadcastService: { id, service: "broadcast" },
    modelSelectionService: { id, service: "model-selection" },
    providerSettingsService: { id, service: "provider-settings" },
  } as unknown as IServiceAccessor;
}

describe("buildRemoteWorkspaceSessionServices", () => {
  it("uses remote filesystem/runtime services and keeps local global services", () => {
    const baseServices = makeServices("base");
    const remoteServices = makeServices("remote");

    const merged = buildRemoteWorkspaceSessionServices(baseServices, remoteServices);

    expect(merged.fileService).toBe(remoteServices.fileService);
    expect(merged.gitService).toBe(remoteServices.gitService);
    expect(merged.gitCheckpointService).toBe(remoteServices.gitCheckpointService);
    expect(merged.systemService).toBe(remoteServices.systemService);
    expect(merged.terminalService).toBe(remoteServices.terminalService);
    expect(merged.promptAttachmentTransferService).toBe(
      remoteServices.promptAttachmentTransferService,
    );
    expect(merged.zcodeAgentService).toBe(remoteServices.zcodeAgentService);
    expect(merged.zcodeTaskService).toBe(remoteServices.zcodeTaskService);
    expect(merged.zcodeSessionService).toBe(remoteServices.zcodeSessionService);
    expect(merged.conversationShareService).toBe(remoteServices.conversationShareService);
    expect(merged.fileWatcherService).toBe(remoteServices.fileWatcherService);
    // Provider/Model View 属于目标 Remote Environment；不能随 ...baseServices 回落到本地。
    expect(merged.modelSelectionService).toBe(remoteServices.modelSelectionService);
    expect(merged.providerSettingsService).toBe(remoteServices.providerSettingsService);
    expect(merged.skillsService).toBe(remoteServices.skillsService);
    expect(merged.skillSyncService).toBe(remoteServices.skillSyncService);
    expect(merged.mcpSyncService).toBe(remoteServices.mcpSyncService);
    expect(merged.pluginSyncService).toBe(remoteServices.pluginSyncService);
    expect(merged.pluginsService).toBe(remoteServices.pluginsService);
    expect(merged.commandsService).toBe(remoteServices.commandsService);
    // Bug 回归（2026-08-28 用户反馈「点去审核后没有任何待审 Hook」）：SSH 远程工作区的
    // hooksService 曾被 ...baseServices 展开静默回落到本机 host，远程机器上的
    // workspace hooks（含待审项）永远加载不出来。hooks 读写与 trust 授权必须打到远端。
    expect(merged.hooksService).toBe(remoteServices.hooksService);

    expect(merged.clientScenesService).toBe(baseServices.clientScenesService);
    expect(merged.settingService).toBe(baseServices.settingService);
    expect(merged.credentialService).toBe(baseServices.credentialService);
    expect(merged.oauthService).toBe(baseServices.oauthService);
    expect(merged.broadcastService).toBe(baseServices.broadcastService);
  });

  it("uses server-authoritative services for server remote workspaces", () => {
    const baseServices = makeServices("base");
    const remoteServices = makeServices("remote");

    const merged = buildServerRemoteWorkspaceSessionServices(baseServices, remoteServices);

    expect(merged.fileService).toBe(remoteServices.fileService);
    expect(merged.zcodeTaskService).toBe(remoteServices.zcodeTaskService);
    expect(merged.promptAttachmentTransferService).toBe(
      remoteServices.promptAttachmentTransferService,
    );
    expect(merged.settingService).toBe(remoteServices.settingService);
    expect(merged.credentialService).toBe(remoteServices.credentialService);
    expect(merged.oauthService).toBe(remoteServices.oauthService);
    expect(merged.clientScenesService).toBe(remoteServices.clientScenesService);
    expect(merged.broadcastService).toBe(remoteServices.broadcastService);
  });

  // SG-01：引用级断言只能证明白名单字段存在，证明不了运行时链路。这里走真实 RPC
  // 闭环——远端按 IHooksService.channelName 注册 channel（与 host 进程注册名一致），
  // renderer 侧用与 RemoteServiceAccess 相同的 ProxyChannel.toService 接线，
  // 再经 buildRemoteWorkspaceSessionServices 合并后发起调用：
  // loadHooks / saveHooks / grantWorkspaceHookTrust 必须携带原始 workspacePath /
  // workspaceIdentity 到达远端实现，本机 base 侧零调用，返回值完成 RPC 往返。
  it("routes hook load/save/trust RPC through the remote channel with original workspace params", async () => {
    const remoteLoadHooks = vi.fn(async () => ({ hooks: [], hooksEnabled: false }));
    const remoteSaveHooks = vi.fn(async () => undefined);
    const remoteGrant = vi.fn(async () => ({ accepted: true }));
    const remoteHost = {
      loadHooks: remoteLoadHooks,
      saveHooks: remoteSaveHooks,
      grantWorkspaceHookTrust: remoteGrant,
    } satisfies IHooksService;
    const baseLoadHooks = vi.fn(async () => ({ hooks: [], hooksEnabled: false }));
    const baseSaveHooks = vi.fn(async () => undefined);
    const baseGrant = vi.fn(async () => ({ accepted: false }));

    const [serverProtocol, clientProtocol] = createQueuePair();
    const server = new ChannelServer(serverProtocol, "remote-host-test");
    server.registerChannel(IHooksService.channelName, ProxyChannel.fromService(remoteHost));
    const client = new ChannelClient(clientProtocol);
    const remoteHooksProxy = ProxyChannel.toService<IHooksService>(
      client.getChannel(IHooksService.channelName),
    );

    const baseServices: IServiceAccessor = {
      ...makeServices("base"),
      hooksService: {
        loadHooks: baseLoadHooks,
        saveHooks: baseSaveHooks,
        grantWorkspaceHookTrust: baseGrant,
      } satisfies IHooksService,
    };
    const remoteServices: IServiceAccessor = {
      ...makeServices("remote"),
      hooksService: remoteHooksProxy,
    };
    const merged = buildRemoteWorkspaceSessionServices(baseServices, remoteServices);

    const target = {
      workspacePath: "/data/xuzicang/MultiJoin",
      workspaceIdentity: "remote:ssh:222.29.156.145:22:xuzicang:/data/xuzicang/MultiJoin",
    };

    try {
      await expect(merged.hooksService.loadHooks(target)).resolves.toEqual({
        hooks: [],
        hooksEnabled: false,
      });
      await merged.hooksService.saveHooks({ ...target, hooks: [] });
      await expect(
        merged.hooksService.grantWorkspaceHookTrust?.({
          ...target,
          bundleDigest: "bundle-digest",
          hookDeclarationDigest: "hook-digest",
        }),
      ).resolves.toEqual({ accepted: true });

      expect(remoteLoadHooks).toHaveBeenCalledWith(target);
      expect(remoteSaveHooks).toHaveBeenCalledWith({ ...target, hooks: [] });
      expect(remoteGrant).toHaveBeenCalledWith({
        ...target,
        bundleDigest: "bundle-digest",
        hookDeclarationDigest: "hook-digest",
      });
      expect(baseLoadHooks).not.toHaveBeenCalled();
      expect(baseSaveHooks).not.toHaveBeenCalled();
      expect(baseGrant).not.toHaveBeenCalled();
    } finally {
      client.dispose();
      server.dispose();
    }
  });
});
