import {
  parseAgentProfileFromMarkdown,
  type AgentProfile,
  type AgentProfileParseDiagnostic,
  resolveSubagentRuntimeProfiles,
  type SubagentRuntimeState,
  type SubagentRuntimeConfig,
} from "@zcode/shared";

/** 独立 CLI 的磁盘 loader 复用共享纯解析器，保留原文件配置来源。 */
export function parseRuntimeSubagentConfig(configuration: {
  documents: { content: string; path: string; source: "user" | "project" }[];
  state: SubagentRuntimeState;
}) {
  const profiles: AgentProfile[] = [];
  const diagnostics: AgentProfileParseDiagnostic[] = [];
  for (const document of configuration.documents) {
    const result = parseAgentProfileFromMarkdown(document);
    if (result.diagnostic) diagnostics.push(result.diagnostic);
    if (!result.profile) continue;
    profiles.push(result.profile);
  }
  return {
    ...resolveSubagentRuntimeProfiles(profiles, configuration.state),
    diagnostics,
  };
}

/** Host 已完成纯解析；失败回退不能混入旧模板或磁盘覆盖。 */
export function subagentProfilesFromSnapshot(snapshot: SubagentRuntimeConfig) {
  return snapshot.kind === "ready"
    ? snapshot
    : {
        profiles: [],
        builtInModelSelectionOverrides: {},
        pluginAgentModelSelectionOverrides: {},
      };
}
