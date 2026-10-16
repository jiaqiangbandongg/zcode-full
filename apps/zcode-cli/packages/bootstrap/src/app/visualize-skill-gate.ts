import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE, type SkillRoot } from "@zcode/contracts";

const VISUALIZE_PLUGIN_ID = `visualize@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`;

export function filterVisualizeSkillRoots(
  roots: readonly SkillRoot[],
  includeVisualize = false,
): SkillRoot[] {
  // 内置插件默认启用曾让终端会话也发现 visualize，但终端没有内联视图宿主。
  // 只过滤官方插件身份，避免误伤用户/项目自定义的同名技能；协议入口显式保留。
  return roots.filter((root) => includeVisualize || root.pluginId !== VISUALIZE_PLUGIN_ID);
}
