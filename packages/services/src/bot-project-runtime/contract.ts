import type { IZCodeTaskService } from "#src/index.js";
import type { IModelSelectionService } from "#src/model-provider/providerFacadeServices.js";
import type {
  IZCodeAgentService,
  ZCodeAgentAppRuntimePreferences,
} from "#src/zcode-agent/zcodeAgent.js";
import type { IRemoteProjectService } from "#src/remote-projects/contract.js";
export type { IZCodeTaskService, ZCodeAgentAppRuntimePreferences };
export type BotRemoteTarget = { workspacePath: string; workspaceIdentity: string; hostId?: string };
export type BotRuntimeSubscription = { dispose(): void };
export interface BotProjectConnection {
  /** 物理连接的代际标识；router 不拥有或关闭该连接。 */
  owner: object;
  taskService: IZCodeTaskService;
  modelSelectionService: Pick<IModelSelectionService, "getView">;
  agentService: Pick<IZCodeAgentService, "syncAppRuntimePreferences">;
  bindWorkspace(target: BotRemoteTarget): Promise<void>;
}
export interface BotProjectRuntimePort {
  remoteProjectService: Pick<IRemoteProjectService, "readDirectory" | "connectHost">;
  resolveOnline(hostId: string): BotProjectConnection | undefined;
  onConnectionsChanged(listener: () => void): BotRuntimeSubscription;
  readBoundTargets(): Promise<readonly BotRemoteTarget[]>;
  readRuntimePreferences(): Promise<ZCodeAgentAppRuntimePreferences>;
  warn(message: string): void;
}
/** 只路由现有 Source；不创建 workspace/session/Agent，不拥有 accepted queue。 */
export interface BotRemoteRuntimeService {
  isConnected(target: BotRemoteTarget): Promise<boolean>;
  ensureConnected(target: BotRemoteTarget): Promise<{ ok: boolean; message?: string }>;
  getZCodeTaskService(target: BotRemoteTarget): Promise<IZCodeTaskService | null>;
  getModelSelectionService(
    target: BotRemoteTarget,
  ): Promise<Pick<IModelSelectionService, "getView"> | null>;
  syncAppRuntimePreferences(preferences: ZCodeAgentAppRuntimePreferences): Promise<void>;
}
