import { loadPluginAgentTemplates, resolvePluginAgentProfiles } from "../../src/subagents.js";

export function loadPluginAgentProfiles(input: Parameters<typeof resolvePluginAgentProfiles>[0]) {
  return resolvePluginAgentProfiles(input, loadPluginAgentTemplates(input));
}
