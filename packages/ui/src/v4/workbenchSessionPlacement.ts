import { logger } from "@/logger.js";
import {
  V4_PRIMARY_PANE_ID,
  effectiveFocusedPaneId,
  findPaneIdForSession,
  paneBindingMatchesSession,
  paneWorkspaceKey,
  usePaneLayoutStore,
  type PaneWorkspaceScope,
} from "@/v4/paneLayoutStore.js";
import {
  buildWorkbenchSessionKey,
  useWorkbenchGroupStore,
  type WorkbenchSessionBinding,
} from "@/v4/workbenchGroupStore.js";

export interface WorkbenchSessionTarget extends PaneWorkspaceScope {
  readonly sessionId: string;
}

function targetBinding(target: WorkbenchSessionTarget): WorkbenchSessionBinding {
  const { sessionId, ...workspaceScope } = target;
  return { workspaceScope, sessionId };
}

function draftPrimaryOwnsLayout(shellBinding: WorkbenchSessionBinding | null): boolean {
  const layout = usePaneLayoutStore.getState();
  if (Object.keys(layout.panes).length === 0) {
    return false;
  }
  return (
    !shellBinding ||
    Object.values(layout.panes).some((binding) =>
      paneBindingMatchesSession(binding, shellBinding.workspaceScope, shellBinding.sessionId),
    )
  );
}

export function selectWorkbenchSession(
  shellBinding: WorkbenchSessionBinding | null,
  target: WorkbenchSessionTarget,
): void {
  const groups = useWorkbenchGroupStore.getState();
  const layout = usePaneLayoutStore.getState();
  const binding = targetBinding(target);
  if (
    !groups.activeGroupId &&
    !groups.sessionIndex[buildWorkbenchSessionKey(target, target.sessionId)] &&
    draftPrimaryOwnsLayout(shellBinding)
  ) {
    const existingPaneId = findPaneIdForSession(layout, target, target.sessionId);
    const paneId = existingPaneId ?? effectiveFocusedPaneId(layout);
    if (existingPaneId) {
      layout.focusPane(existingPaneId);
    } else if (paneId !== V4_PRIMARY_PANE_ID && layout.panes[paneId]) {
      const previousSessionId = layout.panes[paneId]?.sessionId ?? null;
      // shell activeTaskId 先切换会把新 session 灌进 primary draft；
      // 必须先原子替换 focused secondary 的完整 binding。
      layout.replacePaneBinding(paneId, {
        workspaceScope: binding.workspaceScope,
        sessionId: binding.sessionId,
      });
      logger.debug("[v4-workbench] draft split focused pane replaced", {
        paneId,
        previousSessionId,
        sessionId: binding.sessionId,
        workspaceKey: paneWorkspaceKey(binding.workspaceScope),
      });
    }
  }
  groups.openSessionFromSidebar(binding);
}
