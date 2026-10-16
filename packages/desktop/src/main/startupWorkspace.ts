import { constants } from "node:fs";
import { access, mkdir, readFile, stat } from "node:fs/promises";
import {
  appSettingsSchema,
  formatZodError,
  resolveStartupLocalWorkspaceSessionIndex,
  type WorkspacePurpose,
} from "@zcode/shared";

interface StartupWorkspaceLogger {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
}

async function readStartupSettings(settingsFile: string, logger?: StartupWorkspaceLogger) {
  try {
    const raw = await readFile(settingsFile, "utf-8");
    const parsed = JSON.parse(raw);
    const result = appSettingsSchema.safeParse(parsed);

    if (!result.success) {
      logger?.warn?.(
        "[startup-workspace] invalid settings file, falling back to default workspace:",
        formatZodError(result.error),
      );
      return appSettingsSchema.parse({});
    }

    return result.data;
  } catch {
    return appSettingsSchema.parse({});
  }
}

export interface StartupWorkspaceWarmupTarget {
  workspacePath: string;
  workspaceIdentity?: string;
}

// 修复原因：会话 CLI 没有 idle 回收，启动预热 3 个会让每个窗口常驻 3 份 Agent 进程内存；
// 切到最近项目的冷启动收益抵不上常驻成本，收敛为只预热 active workspace。
// 与 @zcode/protocol 的 init-local `agentWarmupTargets.max(1)` 保持一致。
export const STARTUP_AGENT_WARMUP_LIMIT = 1;

export interface StartupWindowBootstrap {
  restoreSession?: boolean;
  initialWorkspacePath?: string;
  initialWorkspacePurpose?: WorkspacePurpose;
  unavailableWorkspacePath?: string;
  agentWarmupTargets?: StartupWorkspaceWarmupTarget[];
}

async function isAvailableWorkspaceDirectory(workspacePath: string): Promise<boolean> {
  try {
    const workspaceStat = await stat(workspacePath);
    if (!workspaceStat.isDirectory()) {
      return false;
    }
    await access(workspacePath, constants.R_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolvePersistedActiveSession(
  sessions: NonNullable<ReturnType<typeof appSettingsSchema.parse>["lastWorkspaceSession"]>,
  lastActiveTabIndex: number | undefined,
) {
  if (sessions.length === 0) {
    return undefined;
  }
  const activeIndex = Math.min(Math.max(lastActiveTabIndex ?? 0, 0), sessions.length - 1);
  return sessions[activeIndex];
}

export function resolveStartupAgentWarmupTargets(
  settings: Pick<ReturnType<typeof appSettingsSchema.parse>, "recentProjects">,
  activeTarget: StartupWorkspaceWarmupTarget,
): StartupWorkspaceWarmupTarget[] {
  const candidates: StartupWorkspaceWarmupTarget[] = [
    activeTarget,
    ...(settings.recentProjects ?? []).map((workspacePath) => ({
      workspacePath,
    })),
  ];
  const seen = new Set<string>();
  const targets: StartupWorkspaceWarmupTarget[] = [];

  for (const candidate of candidates) {
    const workspaceKey = candidate.workspaceIdentity?.trim() || candidate.workspacePath;
    if (!workspaceKey || seen.has(workspaceKey)) {
      continue;
    }
    seen.add(workspaceKey);
    targets.push(candidate);
    if (targets.length === STARTUP_AGENT_WARMUP_LIMIT) {
      break;
    }
  }

  return targets;
}

export function createOpenWorkspaceStartupBootstrap(workspacePath: string): StartupWindowBootstrap {
  return {
    initialWorkspacePath: workspacePath,
    initialWorkspacePurpose: "project",
    agentWarmupTargets: [{ workspacePath }],
  };
}

export async function resolveStartupWindowBootstrap({
  settingsFile,
  conversationWorkspaceDir,
  logger,
}: {
  settingsFile: string;
  conversationWorkspaceDir: string;
  logger?: StartupWorkspaceLogger;
}): Promise<StartupWindowBootstrap> {
  const settings = await readStartupSettings(settingsFile, logger);
  const sessions = settings.lastWorkspaceSession ?? [];

  if (sessions.length > 0) {
    const persistedActiveSession = resolvePersistedActiveSession(
      sessions,
      settings.lastActiveTabIndex,
    );
    const unavailableWorkspacePath =
      persistedActiveSession?.kind === "local" &&
      !(await isAvailableWorkspaceDirectory(persistedActiveSession.workspacePath))
        ? persistedActiveSession.workspacePath
        : undefined;
    if (unavailableWorkspacePath) {
      // 上次激活 workspace 被移动或删除后，Agent 仍需保留原业务路径读取历史，
      // 但子进程 cwd 必须落在真实存在的目录；conversation backing workspace 只承担 cwd 兜底。
      await mkdir(conversationWorkspaceDir, { recursive: true });
      logger?.warn?.(
        "[startup-workspace] active local workspace unavailable; using read-only restore:",
        unavailableWorkspacePath,
      );
    }
    const localActiveSessionIndex = resolveStartupLocalWorkspaceSessionIndex(
      sessions,
      settings.lastActiveTabIndex,
    );
    const activeSession =
      localActiveSessionIndex == null ? undefined : sessions[localActiveSessionIndex];
    if (activeSession?.kind === "local") {
      // 被动 sessions-index 全量恢复不能启动全部 workspace；Main 在唯一启动边界固定只选
      // active workspace（STARTUP_AGENT_WARMUP_LIMIT），Host 走原 initializeWorkspace 路径；
      // recentProjects 保持 dormant，预热失败也不扫描其它 workspace 补位。
      const agentWarmupTargets = resolveStartupAgentWarmupTargets(settings, {
        workspacePath: activeSession.workspacePath,
      });
      return {
        ...(unavailableWorkspacePath ? { unavailableWorkspacePath } : {}),
        agentWarmupTargets,
      };
    }
    return unavailableWorkspacePath ? { unavailableWorkspacePath } : {};
  }

  // UI 可以没有项目，但 Agent 必须始终有真实 cwd。首次启动统一预热
  // app-managed conversation backing workspace，不能再创建会被误认成项目的 ZCodeProject。
  await mkdir(conversationWorkspaceDir, { recursive: true });
  logger?.info?.("[startup-workspace] using conversation workspace:", conversationWorkspaceDir);
  return {
    initialWorkspacePath: conversationWorkspaceDir,
    initialWorkspacePurpose: "conversation",
    agentWarmupTargets: [{ workspacePath: conversationWorkspaceDir }],
  };
}

export async function resolveStartupWorkspacePath({
  settingsFile,
  conversationWorkspaceDir,
  logger,
}: {
  settingsFile: string;
  conversationWorkspaceDir: string;
  logger?: StartupWorkspaceLogger;
}): Promise<string | undefined> {
  return (
    await resolveStartupWindowBootstrap({
      settingsFile,
      conversationWorkspaceDir,
      logger,
    })
  ).initialWorkspacePath;
}
