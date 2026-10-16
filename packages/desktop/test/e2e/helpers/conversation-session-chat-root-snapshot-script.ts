export interface V4ChatRootBrowserSnapshot {
  activeInputId: string | null;
  bridgeError: string | null;
  canStop: boolean;
  modelSwitchPending: boolean;
  paneSessionId: string | null;
  queueCount: number;
  runtimeStatus: string;
  taskId: string | null;
  workspaceKey: string | null;
}

type BrowserWorkspaceState = {
  draftRuntime?: { status?: string | null };
  modelSwitchPending?: boolean;
  taskRuntimeByTaskId?: Record<
    string,
    { activeInputId?: string | null; status?: string | null }
  >;
};

export function readV4ChatRootSnapshotInBrowser(
  v4PaneTestId: string,
  v4QueueItemPrefix: string,
  v4StopTestId: string,
): V4ChatRootBrowserSnapshot {
  const pane = document.querySelector<HTMLElement>(`[data-testid="${v4PaneTestId}"]`);
  const canStop = Boolean(
    pane?.querySelector(`[data-testid="${v4StopTestId}"]`),
  );
  const paneSessionId = pane?.getAttribute("data-session-id") ?? null;
  const taskId = paneSessionId && paneSessionId !== "draft" ? paneSessionId : null;
  const e2eWindow = window as Window & {
    __zcodeSessionStoreE2E?: {
      getState?: () => { workspaces?: Record<string, BrowserWorkspaceState> };
    };
    __zcodeTabStoreE2E?: {
      getState?: () => {
        activeWorkspaceIdentity?: string | null;
        activeWorkspacePath?: string | null;
      };
    };
  };
  const tabState = e2eWindow.__zcodeTabStoreE2E?.getState?.();
  const workspaceKey =
    tabState?.activeWorkspaceIdentity?.trim() || tabState?.activeWorkspacePath || null;
  const sessionState = e2eWindow.__zcodeSessionStoreE2E?.getState?.();
  const workspace = workspaceKey ? sessionState?.workspaces?.[workspaceKey] : undefined;
  const taskRuntime = taskId ? workspace?.taskRuntimeByTaskId?.[taskId] : undefined;
  const runtimeStatus = taskId
    ? taskRuntime?.status
    : workspace?.draftRuntime?.status;
  const bridgeError = !pane
    ? "v4-pane-missing"
    : !e2eWindow.__zcodeTabStoreE2E?.getState
      ? "tab-store-bridge-missing"
      : !e2eWindow.__zcodeSessionStoreE2E?.getState
        ? "session-store-bridge-missing"
        : !workspaceKey
          ? "active-workspace-key-missing"
          : !workspace
            ? "active-workspace-not-found"
            : null;

  return {
    activeInputId: taskRuntime?.activeInputId ?? null,
    bridgeError,
    canStop,
    modelSwitchPending: workspace?.modelSwitchPending === true,
    paneSessionId,
    queueCount: document.querySelectorAll(
      `li[data-testid^="${v4QueueItemPrefix}-"][data-queue-item-id]`,
    ).length,
    // Bug 根因：V4 session 刚从 completed 切回 running 时，pane 的 control projection
    // 已经显示 Stop，但 E2E store bridge 仍可能保留上一帧 completed。运行态断言应以
    // 用户可操作的 Stop 合同为准，避免把真实 running turn 误判成 idle。
    runtimeStatus: canStop ? "streaming" : (runtimeStatus ?? "idle"),
    taskId,
    workspaceKey,
  };
}
