import type { RemoteWorkspaceProjection } from "./remoteWorkspaceProjection.js";

export type RemoteWorkspaceReconnectOptions = {
  activateWorkspaceAfterReconnect?: boolean;
  showErrorToast?: boolean;
  throwOnFailure?: boolean;
};

export type RemoteWorkspaceIntent =
  | { type: "connect-device"; profileId: string; effect: "select-project" | "device-management" }
  | { type: "disconnect-device"; sourceServerId: string }
  | {
      type: "open-conversation";
      sourceServerId: string;
      remoteSessionId?: string;
      profileId?: string;
    }
  | {
      type: "open-project";
      draftProjectId?: string | null;
      preparedWorkspaceIdentity?: string;
      isCurrent?: () => boolean | Promise<boolean>;
      sourceServerId: string;
      path: string;
      profileId?: string;
      localWorkspacePath?: string;
      remoteSessionId?: string;
    }
  | {
      type: "reconnect-workspace";
      workspaceKey: string;
      options?: RemoteWorkspaceReconnectOptions;
    }
  | { type: "close-workspace"; workspaceKey: string; origin: "user-close" };

export interface RemoteWorkspaceControllerHandlers {
  connectDevice: (
    profileId: string,
    effect: "select-project" | "device-management",
  ) => Promise<void>;
  disconnectDevice: (sourceServerId: string) => Promise<void>;
  openConversation: (input: {
    sourceServerId: string;
    remoteSessionId?: string;
    profileId?: string;
  }) => Promise<void>;
  openProject: (input: {
    draftProjectId?: string | null;
    preparedWorkspaceIdentity?: string;
    isCurrent?: () => boolean | Promise<boolean>;
    sourceServerId: string;
    path: string;
    profileId?: string;
    localWorkspacePath?: string;
    remoteSessionId?: string;
  }) => Promise<void>;
  reconnectWorkspace: (
    workspaceKey: string,
    options?: RemoteWorkspaceReconnectOptions,
  ) => Promise<void>;
  closeWorkspace: (workspaceKey: string) => Promise<void>;
}

export interface RemoteWorkspaceController {
  readonly projection?: RemoteWorkspaceProjection;
  dispatch(intent: RemoteWorkspaceIntent): Promise<void>;
}

export function createRemoteWorkspaceController(
  handlers: RemoteWorkspaceControllerHandlers,
  projection?: RemoteWorkspaceProjection,
): RemoteWorkspaceController {
  return {
    projection,
    async dispatch(intent) {
      switch (intent.type) {
        case "connect-device":
          await handlers.connectDevice(intent.profileId, intent.effect);
          return;
        case "disconnect-device":
          await handlers.disconnectDevice(intent.sourceServerId);
          return;
        case "open-conversation":
          // 旧回调也不能绕过项目创建，拒绝前不产生连接或目录副作用。
          throw new Error("project.remote-project-required");
        case "open-project":
          await handlers.openProject(intent);
          return;
        case "reconnect-workspace":
          if (intent.options) {
            await handlers.reconnectWorkspace(intent.workspaceKey, intent.options);
          } else {
            await handlers.reconnectWorkspace(intent.workspaceKey);
          }
          return;
        case "close-workspace":
          if (intent.origin !== "user-close")
            throw new Error("workspace close requires user-close origin");
          await handlers.closeWorkspace(intent.workspaceKey);
          return;
      }
    },
  };
}
