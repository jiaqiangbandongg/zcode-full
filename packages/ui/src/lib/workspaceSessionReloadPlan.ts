import type { ZCodeProvider, ZCodeError } from "@zcode/shared";
import { buildWorkspacePrepareUiError } from "@/lib/chatPrepareError.js";

export const WORKSPACE_SESSION_RELOAD_DEBOUNCE_MS = 1200;

interface WorkspaceSessionReloadPlan {
  resumeTaskId: string | undefined;
  shouldPrepareWorkspace: boolean;
}

interface WorkspaceSessionReloadDraftErrorContext {
  workspacePath: string;
  provider: ZCodeProvider;
}

export function buildWorkspaceSessionReloadPlan(activeTaskId: string | null): WorkspaceSessionReloadPlan {
  const resumeTaskId = activeTaskId?.trim();

  if (!resumeTaskId) {
    return {
      resumeTaskId: undefined,
      shouldPrepareWorkspace: true,
    };
  }

  return {
    resumeTaskId,
    shouldPrepareWorkspace: false,
  };
}

export function buildWorkspaceSessionReloadDraftError(
  err: unknown,
  context: WorkspaceSessionReloadDraftErrorContext,
): ZCodeError & { detail?: string } {
  return buildWorkspacePrepareUiError(err, {
    workspacePath: context.workspacePath,
    provider: context.provider,
    reason: "reload-session",
    attempt: 1,
    maxAttempts: 1,
  });
}

export function shouldDebounceWorkspaceSessionReload(
  lastTriggeredAt: number | null,
  now: number,
  debounceWindowMs: number = WORKSPACE_SESSION_RELOAD_DEBOUNCE_MS,
): boolean {
  if (lastTriggeredAt === null) {
    return false;
  }

  return now - lastTriggeredAt < debounceWindowMs;
}
