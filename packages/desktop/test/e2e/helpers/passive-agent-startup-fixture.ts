import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

export const PASSIVE_AGENT_STARTUP_WORKSPACE_COUNT = 9;

// 虚拟项目重构（spec 3.6 F13 / D42）后启动只预热上次活动的目录，不再从 recentProjects
// 额外挑选预热目标；期望集合因此只剩 active workspace。
export const PASSIVE_AGENT_STARTUP_SCENARIO = {
  workspaceCount: PASSIVE_AGENT_STARTUP_WORKSPACE_COUNT,
  activeWorkspaceIndex: 4,
  expectedWarmupWorkspaceIndexes: [4],
  explicitWorkspaceIndex: 2,
} as const;

export const SMALL_AGENT_WARMUP_SCENARIO = {
  workspaceCount: 2,
  activeWorkspaceIndex: 1,
  expectedWarmupWorkspaceIndexes: [1],
} as const;

export function getPassiveAgentStartupWorkspacePaths(
  e2eHomeDir: string,
  workspaceCount = PASSIVE_AGENT_STARTUP_WORKSPACE_COUNT,
): string[] {
  return Array.from({ length: workspaceCount }, (_, index) =>
    resolve(e2eHomeDir, `PassiveWorkspace-${String(index + 1).padStart(2, "0")}`),
  );
}

export function seedPassiveAgentStartupWorkspaces(
  e2eHomeDir: string,
  workspaceCount = PASSIVE_AGENT_STARTUP_WORKSPACE_COUNT,
): string[] {
  const workspacePaths = getPassiveAgentStartupWorkspacePaths(e2eHomeDir, workspaceCount);
  for (const workspacePath of workspacePaths) {
    mkdirSync(workspacePath, { recursive: true });
  }
  return workspacePaths;
}
