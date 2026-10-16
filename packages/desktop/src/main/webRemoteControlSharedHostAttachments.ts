import { BrowserWindow, MessageChannelMain } from "electron";
import type { MessagePortMain, UtilityProcess as ElectronUtilityProcess } from "electron";
import { HostMessageTypes, type RemoteUsageRemoteKind } from "@zcode/shared";

type WebRemoteControlSharedHostKind = "local" | "remote";

interface WebRemoteControlSharedHostAttachContext {
  kind: WebRemoteControlSharedHostKind;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  initialTaskId?: string;
}

interface WebRemoteControlSharedHostAttachment {
  entryId: string;
  attachmentId: string;
  process: ElectronUtilityProcess;
  port: MessagePortMain;
  remoteKind?: RemoteUsageRemoteKind;
}

interface WebRemoteControlSharedHostError extends Error {
  code:
    | "DESKTOP_HOST_MISSING"
    | "REMOTE_WORKSPACE_IDENTITY_MISSING"
    | "REMOTE_WORKSPACE_IDENTITY_MISMATCH"
    | "REMOTE_SESSION_MISSING"
    | "REMOTE_SESSION_WINDOW_MISMATCH";
}

function createSharedHostError(
  code: WebRemoteControlSharedHostError["code"],
  message: string,
): WebRemoteControlSharedHostError {
  const error = new Error(message) as WebRemoteControlSharedHostError;
  error.code = code;
  return error;
}

export function createWebRemoteControlSharedHostAttachments(dependencies: {
  windowHostProcessMap: Map<number, ElectronUtilityProcess>;
  createMessageChannel?: () => { port1: MessagePortMain; port2: MessagePortMain };
  attachRemoteWorkspaceSessionHost: (params: {
    windowId: number;
    remoteSessionId: string;
    workspacePath: string;
    workspaceIdentity: string;
    workspaceKey: string;
    clientMode: "web-remote-replayable";
  }) => {
    process: ElectronUtilityProcess;
    port: MessagePortMain;
    remoteKind: RemoteUsageRemoteKind;
  };
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}) {
  let nextAttachmentId = 0;
  const attachments = new Map<
    string,
    {
      windowId: number;
      remoteSessionId?: string;
      port: MessagePortMain;
    }
  >();

  function createMessageChannel() {
    return dependencies.createMessageChannel?.() ?? new MessageChannelMain();
  }

  function attachLocalHost(windowId: number): WebRemoteControlSharedHostAttachment {
    const hostProcessWindowId = BrowserWindow.fromId(windowId)?.webContents.id ?? windowId;
    const process = dependencies.windowHostProcessMap.get(hostProcessWindowId);
    if (!process) {
      throw createSharedHostError(
        "DESKTOP_HOST_MISSING",
        `未找到桌面窗口 host process，windowId=${windowId}`,
      );
    }

    const { port1, port2 } = createMessageChannel();
    const attachmentId = `shared-host-attachment-${++nextAttachmentId}`;
    process.postMessage(
      {
        type: HostMessageTypes.AttachServicePort,
        requestId: `shared-host-request-${nextAttachmentId}`,
        attachmentId,
        clientMode: "web-remote-replayable",
        scope: { kind: "local" },
      },
      [port2],
    );
    attachments.set(attachmentId, { windowId, port: port1 });
    return {
      entryId: `desktop-host:${windowId}`,
      attachmentId,
      process,
      port: port1,
    };
  }

  async function attachWorkspaceHost(
    windowId: number,
    context: WebRemoteControlSharedHostAttachContext,
  ): Promise<WebRemoteControlSharedHostAttachment> {
    if (context.kind === "local") {
      return attachLocalHost(windowId);
    }
    if (!context.remoteSessionId) {
      throw createSharedHostError(
        "REMOTE_SESSION_MISSING",
        "远程 workspace bridge 缺少 remoteSessionId。",
      );
    }
    const workspaceIdentity = context.workspaceIdentity?.trim();
    if (!workspaceIdentity) {
      throw createSharedHostError(
        "REMOTE_WORKSPACE_IDENTITY_MISSING",
        "远程 workspace bridge 缺少 workspaceIdentity，不能建立身份隔离。",
      );
    }
    const workspaceKey = workspaceIdentity || context.workspacePath;
    const attached = dependencies.attachRemoteWorkspaceSessionHost({
      windowId,
      remoteSessionId: context.remoteSessionId,
      workspacePath: context.workspacePath,
      workspaceIdentity,
      workspaceKey,
      clientMode: "web-remote-replayable",
    });
    const attachmentId = `shared-host-attachment-${++nextAttachmentId}`;
    attachments.set(attachmentId, {
      windowId,
      remoteSessionId: context.remoteSessionId,
      port: attached.port,
    });
    return {
      entryId: `remote-session-host:${context.remoteSessionId}`,
      attachmentId,
      process: attached.process,
      port: attached.port,
      remoteKind: attached.remoteKind,
    };
  }

  function releaseAttachment(attachmentId: string): void {
    const attachment = attachments.get(attachmentId);
    if (!attachment) {
      return;
    }
    attachments.delete(attachmentId);
    try {
      attachment.port.close();
    } catch (error) {
      dependencies.logger.warn("[web-remote-control] failed to close shared host attachment", {
        attachmentId,
        error,
      });
    }
  }

  function disposeWindow(windowId: number): void {
    for (const [attachmentId, attachment] of Array.from(attachments)) {
      if (attachment.windowId === windowId) {
        releaseAttachment(attachmentId);
      }
    }
  }

  function disposeRemoteSession(remoteSessionId: string): void {
    for (const [attachmentId, attachment] of Array.from(attachments)) {
      if (attachment.remoteSessionId === remoteSessionId) {
        releaseAttachment(attachmentId);
      }
    }
  }

  return {
    attachWorkspaceHost,
    releaseAttachment,
    disposeWindow,
    disposeRemoteSession,
  };
}
