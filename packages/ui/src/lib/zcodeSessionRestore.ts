import type { IZCodeSessionService, IZCodeTaskService } from "@zcode/services";
import type {
  ZCodeConfigOption,
  ModelSelection,
  ZCodeSessionStateSnapshot,
  ZCodeTaskSnapshot,
} from "@zcode/shared";
import {
  zcodeSessionSettingsToConfigOptions,
  zcodeSessionSnapshotToZCodeTaskSnapshot,
} from "@/lib/zcodeSessionProjection.js";
import { normalizeZCodeUiError, type ZCodeUiError } from "@/lib/zcodeUiError.js";
import { logger } from "@/logger.js";

export type ZCodeSessionRestoreService = Pick<
  IZCodeSessionService,
  "readSession" | "resumeSession"
>;
export type ZCodeLegacyTaskSnapshotRestoreService = Pick<IZCodeTaskService, "getTaskSnapshot">;

export interface DesktopContinuousSessionRestoreSnapshot {
  snapshot: ZCodeTaskSnapshot;
  restoreWarning?: ZCodeUiError;
  resumedSessionSnapshot?: ZCodeSessionStateSnapshot;
  usedLegacySnapshot?: boolean;
}

function isSessionMissingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /\bSession (not found|is not active):/i.test(message);
}

function isRuntimeModelUnavailableError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ZCODE_RUNTIME_MODEL_UNAVAILABLE"
  );
}

function getRuntimeModelUnavailableDiagnostics(error: unknown): Record<string, unknown> {
  if (typeof error !== "object" || error === null || !("data" in error)) {
    return {};
  }
  const data = (error as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) {
    return {};
  }
  const model = "model" in data ? (data as { model?: unknown }).model : undefined;
  return {
    errorData: data,
    errorModel:
      typeof model === "object" && model !== null
        ? {
            modelId: "modelId" in model ? (model as { modelId?: unknown }).modelId : null,
            providerId:
              "providerId" in model ? (model as { providerId?: unknown }).providerId : null,
          }
        : null,
  };
}

function getSessionSnapshotDiagnostics(snapshot: ZCodeSessionStateSnapshot) {
  return {
    activeTurnId: snapshot.runtime.activeTurnId ?? null,
    eventSeq: snapshot.runtime.eventSeq,
    messageCount: snapshot.messages.length,
    pendingRequestCount: snapshot.runtime.pendingRequestIds.length,
    sessionStatus: snapshot.session.status,
    stateRevision: snapshot.runtime.stateRevision,
  };
}

export async function readDesktopContinuousSessionRestoreSnapshot(params: {
  zcodeSessionService: ZCodeSessionRestoreService;
  zcodeTaskService?: ZCodeLegacyTaskSnapshotRestoreService;
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string;
  messageLimit?: number;
  model?: ModelSelection;
  thoughtLevel?: string;
}): Promise<DesktopContinuousSessionRestoreSnapshot> {
  // Bugfix: session/read 只能读取 runtime 里的活跃 session。
  // 历史 task 首次打开时必须先 resume 激活，再按 desktop continuous 读取限流快照。
  const startedAt = Date.now();
  let resumedSessionSnapshot: ZCodeSessionStateSnapshot;
  try {
    const resumeStartedAt = Date.now();
    resumedSessionSnapshot = await params.zcodeSessionService.resumeSession({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      sessionId: params.sessionId,
      // Bugfix: 历史 task 首次打开时必须带上 task meta 里的模型。
      // 同时带 task-local thoughtLevel，避免 draft/workspace 默认思考强度污染同模型 active task。
      ...(params.model ? { model: params.model } : {}),
      ...(params.thoughtLevel ? { thoughtLevel: params.thoughtLevel } : {}),
    });
    logger.info("[zcodeSessionRestore] desktop resumeSession 完成", {
      durationMs: Date.now() - resumeStartedAt,
      messageLimit: params.messageLimit ?? null,
      sessionId: params.sessionId,
      snapshot: getSessionSnapshotDiagnostics(resumedSessionSnapshot),
      totalDurationMs: Date.now() - startedAt,
      workspaceIdentity: params.workspaceIdentity ?? null,
      workspacePath: params.workspacePath,
    });
  } catch (error) {
    if (
      !params.zcodeTaskService ||
      (!isSessionMissingError(error) && !isRuntimeModelUnavailableError(error))
    ) {
      throw error;
    }

    const runtimeModelUnavailable = isRuntimeModelUnavailableError(error);
    if (runtimeModelUnavailable) {
      logger.info(
        "[zcodeSessionRestore][diag:model-unavailable] desktop resumeSession 模型不可用",
        {
          messageLimit: params.messageLimit ?? null,
          requestedModelId: params.model?.modelId ?? null,
          requestedProviderId: params.model?.providerId ?? null,
          sessionId: params.sessionId,
          workspaceIdentity: params.workspaceIdentity ?? null,
          workspacePath: params.workspacePath,
          ...getRuntimeModelUnavailableDiagnostics(error),
        },
      );
    }
    // Bugfix: 旧 ACP task 缺少 protocol session，或历史 task 的模型已从当前 registry 删除时，
    // 都不能继续伪造 active session。这里退回 task facade 的 snapshot 读取，只恢复历史显示；
    // 真正续聊必须等用户显式选择当前可用模型。
    const legacyStartedAt = Date.now();
    const legacySnapshot = await params.zcodeTaskService.getTaskSnapshot({
      taskId: params.sessionId,
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      ...(typeof params.messageLimit === "number" ? { messageLimit: params.messageLimit } : {}),
      clientMode: "desktop-continuous",
    });
    if (!legacySnapshot) {
      throw error;
    }
    logger.info("[zcodeSessionRestore] desktop legacy 快照读取完成", {
      durationMs: Date.now() - legacyStartedAt,
      messageCount: legacySnapshot.messages.length,
      messageLimit: params.messageLimit ?? null,
      sessionId: params.sessionId,
      totalDurationMs: Date.now() - startedAt,
      workspaceIdentity: params.workspaceIdentity ?? null,
      workspacePath: params.workspacePath,
    });
    return {
      snapshot: legacySnapshot,
      ...(runtimeModelUnavailable
        ? {
            restoreWarning: normalizeZCodeUiError(error, {
              fallbackCode: "ZCODE_RUNTIME_MODEL_UNAVAILABLE",
              taskId: params.sessionId,
            }),
          }
        : {}),
      usedLegacySnapshot: true,
    };
  }
  const readStartedAt = Date.now();
  const readSessionSnapshot = await params.zcodeSessionService.readSession({
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity,
    sessionId: params.sessionId,
    deliveryKind: "desktop-continuous",
    ...(typeof params.messageLimit === "number" ? { messageLimit: params.messageLimit } : {}),
  });
  const readDurationMs = Date.now() - readStartedAt;
  const projectionStartedAt = Date.now();
  const snapshot = zcodeSessionSnapshotToZCodeTaskSnapshot(readSessionSnapshot);
  logger.info("[zcodeSessionRestore] desktop readSession 快照转换完成", {
    durationMs: Date.now() - startedAt,
    messageLimit: params.messageLimit ?? null,
    projectionDurationMs: Date.now() - projectionStartedAt,
    readDurationMs,
    sessionId: params.sessionId,
    snapshot: {
      history: snapshot.history ?? null,
      messageCount: snapshot.messages.length,
      status: snapshot.meta.status,
    },
    workspaceIdentity: params.workspaceIdentity ?? null,
    workspacePath: params.workspacePath,
  });
  return {
    resumedSessionSnapshot,
    snapshot,
  };
}

export async function readWebRemoteReplayableSessionConfigOptions(params: {
  zcodeSessionService: ZCodeSessionRestoreService;
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string;
  model?: ModelSelection;
  thoughtLevel?: string;
}): Promise<ZCodeConfigOption[] | null> {
  const startedAt = Date.now();
  try {
    if (params.model) {
      const resumeStartedAt = Date.now();
      // Bugfix: 手机 replayable 配置读取会早于后续 resumeTask。
      // 先带历史模型激活 session，避免 readSession 读取到被默认模型污染的 settings/context window。
      const resumed = await params.zcodeSessionService.resumeSession({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        sessionId: params.sessionId,
        model: params.model,
        ...(params.thoughtLevel ? { thoughtLevel: params.thoughtLevel } : {}),
      });
      logger.info("[zcodeSessionRestore] replayable task 配置读取前 resumeSession 完成", {
        durationMs: Date.now() - resumeStartedAt,
        requestedModelId: params.model.modelId,
        requestedProviderId: params.model.providerId,
        sessionId: params.sessionId,
        snapshot: getSessionSnapshotDiagnostics(resumed),
        totalDurationMs: Date.now() - startedAt,
        workspaceIdentity: params.workspaceIdentity ?? null,
        workspacePath: params.workspacePath,
      });
    }
    const snapshot = await params.zcodeSessionService.readSession({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      sessionId: params.sessionId,
      deliveryKind: "web-remote-replayable",
      messageLimit: 1,
    });
    const options = zcodeSessionSettingsToConfigOptions(snapshot.settings);
    logger.info("[zcodeSessionRestore] replayable task 配置读取完成", {
      configOptionCount: options.length,
      durationMs: Date.now() - startedAt,
      sessionId: params.sessionId,
      snapshot: getSessionSnapshotDiagnostics(snapshot),
      workspaceIdentity: params.workspaceIdentity ?? null,
      workspacePath: params.workspacePath,
    });
    return options;
  } catch (error) {
    if (isSessionMissingError(error)) {
      logger.info("[zcodeSessionRestore] replayable task 配置读取跳过，session 不活跃", {
        durationMs: Date.now() - startedAt,
        sessionId: params.sessionId,
        workspaceIdentity: params.workspaceIdentity ?? null,
        workspacePath: params.workspacePath,
      });
      return null;
    }
    throw error;
  }
}
