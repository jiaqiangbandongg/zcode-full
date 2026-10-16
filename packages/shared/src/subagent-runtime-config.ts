import { z } from "zod";
import { modelSelectionSchema } from "./model-selection.js";
import { agentProfileSchema, type AgentProfile } from "./subagent-profile.js";
import { createAgentStateId } from "./subagents-types.js";

export const subagentRuntimeStateSchema = z
  .object({
    disabledAgentIds: z.array(z.string()),
    builtInModelSelectionOverrides: z
      .object({
        Explore: modelSelectionSchema.optional(),
        "general-purpose": modelSelectionSchema.optional(),
      })
      .strict(),
    pluginAgentModelSelectionOverrides: z.record(z.string(), modelSelectionSchema),
  })
  .strict();
export type SubagentRuntimeState = z.infer<typeof subagentRuntimeStateSchema>;

/** snapshot 已经解析；读取失败的回退与 RPC 断连错误不能混为一谈。 */
export const subagentRuntimeConfigSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("ready"),
      profiles: z.array(agentProfileSchema.refine((profile) => profile.source !== "built-in")),
      builtInModelSelectionOverrides:
        subagentRuntimeStateSchema.shape.builtInModelSelectionOverrides,
      pluginAgentModelSelectionOverrides:
        subagentRuntimeStateSchema.shape.pluginAgentModelSelectionOverrides,
    })
    .strict(),
  z.object({ kind: z.literal("built-in-fallback") }).strict(),
]);
export type SubagentRuntimeConfig = z.infer<typeof subagentRuntimeConfigSchema>;

/** 仅从解析缓存组合结果；启停变化不重新读取或解析 Markdown。 */
export function resolveSubagentRuntimeProfiles(
  profiles: readonly AgentProfile[],
  state: SubagentRuntimeState,
) {
  const disabled = new Set(state.disabledAgentIds);
  return {
    profiles: profiles.filter(
      (profile) =>
        profile.source !== "user" ||
        !disabled.has(createAgentStateId({ name: profile.name, scope: "user", source: "user" })),
    ),
    builtInModelSelectionOverrides: state.builtInModelSelectionOverrides,
    pluginAgentModelSelectionOverrides: state.pluginAgentModelSelectionOverrides,
  };
}
