import type { IBotsService, ServiceCollection } from "@zcode/services";
import type { DynamicWorkflowMode, WindowHostAttachmentScope } from "@zcode/shared";
import {
  connectServerRemoteOverDuplex,
  type ServerRemoteConnection,
  type ServerRemoteDuplexConnectionOptions,
} from "./serverRemoteConnection.js";
import { createWindowTopicResourceRelay } from "./windowTopicResourceRelay.js";

/** Desktop 私有回查与设置初始化跟随物理 Source 连接，每次重连重新建立。 */
export async function connectDesktopSourceServer(
  options: ServerRemoteDuplexConnectionOptions,
  deps: {
    connectServer?: typeof connectServerRemoteOverDuplex;
    resolveServices(scope: WindowHostAttachmentScope): ServiceCollection;
    getBots(): IBotsService | undefined;
    readDynamicWorkflowMode(): Promise<DynamicWorkflowMode | undefined>;
    onModeSyncError(error: unknown): void;
  },
): Promise<ServerRemoteConnection> {
  let connection: ServerRemoteConnection | undefined;
  const relay = createWindowTopicResourceRelay({
    getPeerAgentService: () => connection?.services.zcodeAgentService,
    resolveServices: deps.resolveServices,
    getBots: deps.getBots,
  });
  try {
    connection = await (deps.connectServer ?? connectServerRemoteOverDuplex)({
      ...options,
      topicResourceChannel: relay.channel,
      onClose(event) {
        relay.dispose();
        options.onClose?.(event);
      },
    });
    // 旧链路在 logical handle 初建时推送；迁移后必须在每代物理连接发布前同步，
    // 否则 manager 自动重连直接换 services，会丢失 Desktop 的当前用户选择。
    try {
      const mode = await deps.readDynamicWorkflowMode().catch(() => undefined);
      await connection.services.zcodeAgentService.syncDynamicWorkflowUserMode(mode ? { mode } : {});
    } catch (error) {
      // 旧版 Source 不认识此方法时保持可连接，与既有 workflow 同步兼容策略一致。
      deps.onModeSyncError(error);
    }
    const connected = connection;
    return {
      serverInfo: connected.serverInfo,
      services: connected.services,
      dispose() {
        relay.dispose();
        connected.dispose();
      },
    };
  } catch (error) {
    relay.dispose();
    connection?.dispose();
    throw error;
  }
}
