import { resolveWorkspaceStateKey } from "@/store/zcodeSessionStoreSelectors.js";

interface PendingModeSwitchGuard {
  taskId: string;
  modeId: string;
  expiresAt: number;
}

// Bugfix: 保护窗口只覆盖“本地 setMode 刚发起后的并发回包”，窗口过长会吞掉后续真实 mode 变更。
const PENDING_MODE_SWITCH_GUARD_TTL_MS = 3000;
const pendingModeSwitchGuardByWorkspaceKey = new Map<string, PendingModeSwitchGuard>();

function normalizeModeId(modeId: string | null | undefined): string | null {
  if (typeof modeId !== "string") {
    return null;
  }
  const normalized = modeId.trim();
  return normalized.length > 0 ? normalized : null;
}

function readPendingModeSwitchGuard(
  workspacePath: string,
  workspaceIdentity?: string,
): PendingModeSwitchGuard | null {
  const workspaceKey = resolveWorkspaceStateKey(workspacePath, workspaceIdentity);
  const guard = pendingModeSwitchGuardByWorkspaceKey.get(workspaceKey);
  if (!guard) {
    return null;
  }
  if (guard.expiresAt <= Date.now()) {
    pendingModeSwitchGuardByWorkspaceKey.delete(workspaceKey);
    return null;
  }
  return guard;
}

export function markPendingModeSwitchGuard(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
  modeId: string;
}): void {
  const normalizedModeId = normalizeModeId(params.modeId);
  const normalizedTaskId = params.taskId.trim();
  if (!normalizedModeId || normalizedTaskId.length === 0) {
    return;
  }

  const workspaceKey = resolveWorkspaceStateKey(
    params.workspacePath,
    params.workspaceIdentity,
  );
  pendingModeSwitchGuardByWorkspaceKey.set(workspaceKey, {
    taskId: normalizedTaskId,
    modeId: normalizedModeId,
    expiresAt: Date.now() + PENDING_MODE_SWITCH_GUARD_TTL_MS,
  });
}

export function clearPendingModeSwitchGuard(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  modeId?: string;
}): void {
  const workspaceKey = resolveWorkspaceStateKey(
    params.workspacePath,
    params.workspaceIdentity,
  );
  if (typeof params.modeId !== "string") {
    pendingModeSwitchGuardByWorkspaceKey.delete(workspaceKey);
    return;
  }

  const guard = pendingModeSwitchGuardByWorkspaceKey.get(workspaceKey);
  const normalizedModeId = normalizeModeId(params.modeId);
  if (!guard || !normalizedModeId || guard.modeId !== normalizedModeId) {
    return;
  }
  pendingModeSwitchGuardByWorkspaceKey.delete(workspaceKey);
}

export function ackPendingModeSwitchGuardFromModeUpdate(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  modeId: string | null | undefined;
}): void {
  const guard = readPendingModeSwitchGuard(
    params.workspacePath,
    params.workspaceIdentity,
  );
  const normalizedModeId = normalizeModeId(params.modeId);
  if (!guard || !normalizedModeId || guard.modeId !== normalizedModeId) {
    return;
  }
  clearPendingModeSwitchGuard({
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity,
  });
}

export function shouldPreserveModeAgainstConfigUpdate(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  activeTaskId: string | null;
  currentModeId: string | null;
  incomingModeId: string | null;
}): boolean {
  const guard = readPendingModeSwitchGuard(
    params.workspacePath,
    params.workspaceIdentity,
  );
  if (!guard) {
    return false;
  }

  const normalizedActiveTaskId = params.activeTaskId?.trim() ?? "";
  if (normalizedActiveTaskId.length === 0 || guard.taskId !== normalizedActiveTaskId) {
    return false;
  }

  const normalizedCurrentModeId = normalizeModeId(params.currentModeId);
  const normalizedIncomingModeId = normalizeModeId(params.incomingModeId);

  if (normalizedIncomingModeId === guard.modeId) {
    // Bugfix: 运行态已经回到本次切换目标 mode，说明保护窗口可关闭，避免后续合法回包被继续拦截。
    clearPendingModeSwitchGuard({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      modeId: normalizedIncomingModeId ?? undefined,
    });
    return false;
  }

  if (!normalizedCurrentModeId || normalizedCurrentModeId !== guard.modeId) {
    return false;
  }

  return Boolean(
    normalizedIncomingModeId &&
      normalizedIncomingModeId !== normalizedCurrentModeId,
  );
}

export function resetPendingModeSwitchGuardForTest(): void {
  pendingModeSwitchGuardByWorkspaceKey.clear();
}
