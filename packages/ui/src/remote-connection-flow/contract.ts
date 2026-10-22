import type {
  RemoteConnectionFeedbackOptions,
  RemoteConnectionOpenPreference,
} from "@/app-shell/types.js";
export { requestRemoteProjectConnection } from "@/remote-connection-flow/requestRemoteProjectConnection.js";
import { type RemoteTarget, type RemoteWorkspaceSessionEntry } from "@zcode/shared";

export interface RemoteConnectionFlowOptions {
  /** 新的显式入口；卡片恢复不改变该标识。 */
  openIntentId?: number;
  completion?: RemoteConnectionOpenPreference["completion"];
  /** 设备管理连接成功；导航由发起入口负责，不创建项目。 */
  onDeviceConnected?: (
    sourceServerId: string | undefined,
    canDeliver?: () => boolean,
  ) => void | Promise<void>;
  /** 只有用户明确取消才触发；成功关闭和后台收起不触发。 */
  onCancelled?: (background?: boolean) => void;
  initialFailure?: RemoteConnectionOpenPreference["initialFailure"];
  onConnect: (
    options: RemoteTarget,
    requestId?: string,
    context?: { confirmSourceServerInstall?: boolean },
    feedback?: RemoteConnectionFeedbackOptions,
  ) => Promise<string>;
  /** 项目向导在连接完成后接管目录选择，不准备会话。 */
  onConnectionReady?: (sessionId: string) => Promise<void>;
  onSelectProject: (
    sessionId: string,
    path: string,
    localWorkspacePath?: string,
    workspacePurpose?: "project" | "conversation",
  ) => Promise<void>;
  onCancelSession: (sessionId: string) => Promise<void>;
  localWorkspacePath?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  isWindowsDesktop?: boolean;
  remoteWorkspaceSessions?: RemoteWorkspaceSessionEntry[];
  onFlowActiveChange?: (active: boolean) => void;
  onFlowRequestIdChange?: (requestId: string | null) => void;
  onFlowTargetChange?: (target: RemoteTarget | null) => void;
  preferredKind?: RemoteTarget["kind"];
  preferredWslDistro?: string;
  preferredSourceServerId?: string;
  preferredProfileId?: string;
  preferredDirectoryPath?: string;
  preferredTarget?: RemoteTarget;
  /** 用户改选线路或新建连接后，释放 Root 对原项目的恢复互斥。 */
  onProjectIntentCleared?: () => void;
}

export interface RemoteConnectionCompletionIntent {
  preferredDirectoryPath?: string;
  options?: {
    directToDirectory?: boolean;
    localWorkspacePath?: string;
    announceReusedConnection?: boolean;
  };
}

export function normalizeRemoteConnectionOptions({
  openIntentId,
  completion,
  onDeviceConnected,
  onCancelled,
  onConnect,
  onConnectionReady,
  onSelectProject,
  onCancelSession,
  localWorkspacePath,
  open: controlledOpen,
  onOpenChange,
  isWindowsDesktop = false,
  remoteWorkspaceSessions = [],
  onFlowActiveChange,
  onFlowRequestIdChange,
  onFlowTargetChange,
  preferredKind,
  preferredWslDistro,
  preferredSourceServerId,
  preferredProfileId,
  preferredDirectoryPath,
  preferredTarget,
  onProjectIntentCleared,
  initialFailure,
}: RemoteConnectionFlowOptions) {
  return {
    openIntentId,
    completion,
    onDeviceConnected,
    onCancelled,
    onConnect,
    onConnectionReady,
    onSelectProject,
    onCancelSession,
    localWorkspacePath,
    controlledOpen,
    onOpenChange,
    isWindowsDesktop,
    remoteWorkspaceSessions,
    onFlowActiveChange,
    onFlowRequestIdChange,
    onFlowTargetChange,
    preferredKind,
    preferredWslDistro,
    preferredSourceServerId,
    preferredProfileId,
    preferredDirectoryPath,
    preferredTarget,
    onProjectIntentCleared,
    initialFailure,
  };
}
export type RemoteConnectionOptions = ReturnType<typeof normalizeRemoteConnectionOptions>;

/** 同一 Root flow 的只读 UI 投影；不含凭据，不保存连接事实。 */
export interface RemoteConnectionProgress {
  operationId: string;
  view: import("@/RemoteConnectionWizardChrome.js").RemoteWizardStep;
  cancelled: boolean;
  target: RemoteTarget | null;
  sourceServerId?: string;
  profileId?: string;
  name?: string;
  logs: import("@/hooks/useRemoteConnectionLogs.js").RemoteConnectionLogEntry[];
  error: string;
  reason: string;
  waiting: boolean;
  ready: boolean;
  onResume(): void;
  onCancel(): void;
}
