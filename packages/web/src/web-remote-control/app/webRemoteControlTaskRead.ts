export interface WebRemoteControlTaskReadTarget {
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  expectedUnreadAt: number;
}

export interface WebRemoteControlTaskReadService {
  setTaskUnread(params: WebRemoteControlTaskReadTarget & { unread: false }): Promise<unknown>;
}

export interface WebRemoteControlTaskReadBridge {
  kind: "local" | "remote";
  workspacePath: string;
  workspaceIdentity?: string;
  initialTaskId?: string;
}

export type WebRemoteControlTaskReadResult = { ok: true } | { ok: false; error: unknown };

/**
 * 手机任务首页的 unreadAt 来自 desktop 快照，不保证存在于当前 Root 的 query cache。
 * 已读写入因此必须直接使用当前 shared-host bridge 的 task service 和精确 workspace identity。
 */
export async function markWebRemoteControlTaskRead({
  service,
  target,
}: {
  service: WebRemoteControlTaskReadService;
  target: WebRemoteControlTaskReadTarget;
}): Promise<WebRemoteControlTaskReadResult> {
  try {
    await service.setTaskUnread({
      ...target,
      unread: false,
    });
    return { ok: true };
  } catch (error) {
    // 未读写入属于伴随动作；失败时保留权威 unreadAt，不能阻断用户打开任务。
    return { ok: false, error };
  }
}

export async function markWebRemoteControlBridgeTaskRead({
  bridge,
  expectedUnreadAt,
  service,
}: {
  bridge: WebRemoteControlTaskReadBridge;
  expectedUnreadAt?: number;
  service: WebRemoteControlTaskReadService;
}): Promise<WebRemoteControlTaskReadResult> {
  if (typeof expectedUnreadAt !== "number" || !bridge.initialTaskId) {
    return { ok: true };
  }

  return markWebRemoteControlTaskRead({
    service,
    target: {
      taskId: bridge.initialTaskId,
      workspacePath: bridge.workspacePath,
      ...(bridge.kind === "remote" && bridge.workspaceIdentity
        ? { workspaceIdentity: bridge.workspaceIdentity }
        : {}),
      expectedUnreadAt,
    },
  });
}
