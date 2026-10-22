import { logger } from "@/logger.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

interface DeferredDraftRuntimeChangeParams {
  logScope: string;
  reason: string;
  workspacePath?: string | null;
  workspaceIdentity?: string | null;
}

export async function invalidateDeferredDraftSessionForRuntimeChange(
  params: DeferredDraftRuntimeChangeParams,
): Promise<void> {
  if (!params.workspacePath) {
    return;
  }

  const workspaceIdentity = params.workspaceIdentity?.trim() || undefined;
  const store = useZCodeSessionStore.getState();
  // V4 pane 是预热会话的唯一 owner；设置操作只发失效版本，不直接关闭会话。
  store.invalidateDraftRuntime(params.workspacePath, workspaceIdentity);
  logger.info(`[${params.logScope}] invalidated draft runtime capabilities`, {
    reason: params.reason,
    workspaceIdentity: workspaceIdentity ?? null,
    workspacePath: params.workspacePath,
  });
}

export async function invalidateDeferredDraftSessionForSkillChange(
  params: Omit<DeferredDraftRuntimeChangeParams, "logScope">,
): Promise<void> {
  await invalidateDeferredDraftSessionForRuntimeChange({ ...params, logScope: "skills" });
}
