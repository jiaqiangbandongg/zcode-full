// Session 冻结的 Plugin 身份 catalog 构建。
// 在 App（Session runtime）创建时由 bootstrap 从 resolveStartupPlugins 的结果构建一次，
// 之后不随 workspace 配置热更新。
import type {
  PluginMetadata,
  PluginReferenceCatalog,
  PluginReferenceCatalogEntry,
} from "@zcode/contracts";

function collectDeclaredSkillQualifiedNames(plugin: PluginMetadata): string[] {
  const names = new Set<string>();
  for (const group of plugin.components) {
    if (group.kind !== "skill") continue;
    for (const item of group.items) {
      const skillName = item.name.trim();
      if (!skillName) continue;
      names.add(`${plugin.name}:${skillName}`);
    }
  }
  return [...names].sort();
}

function collectDeclaredSubagentNames(plugin: PluginMetadata): string[] {
  const names = new Set<string>();
  for (const group of plugin.components) {
    if (group.kind !== "agent") continue;
    for (const item of group.items) {
      const subagentName = item.name.trim();
      if (!subagentName) continue;
      names.add(`${plugin.name}:${subagentName}`);
    }
  }
  return [...names].sort();
}

/**
 * 从 plugin loader 的权威 metadata 构建身份 catalog。
 * - 所有已发现 Plugin（含 disabled）都进入 catalog：disabled 条目支撑
 *   `disabled_in_session` 诊断与 Picker 过滤，不可被引用。
 * - 冲突定义：同 manifest.name 的多个 enabled Plugin 互相标记 conflictingPluginIds
 *   （V1 fail closed 的机器可读依据）。disabled 条目不参与冲突——runtime 名字空间里没有它。
 */
export function buildPluginReferenceCatalog(
  plugins: readonly PluginMetadata[],
): PluginReferenceCatalog {
  const enabledIdsByName = new Map<string, string[]>();
  for (const plugin of plugins) {
    if (!plugin.enabled) continue;
    const ids = enabledIdsByName.get(plugin.name) ?? [];
    ids.push(plugin.id);
    enabledIdsByName.set(plugin.name, ids);
  }

  const entries: PluginReferenceCatalogEntry[] = plugins.map((plugin) => {
    const sameNameEnabledIds = plugin.enabled ? (enabledIdsByName.get(plugin.name) ?? []) : [];
    return {
      pluginId: plugin.id,
      name: plugin.name,
      marketplace: plugin.marketplace,
      enabled: plugin.enabled,
      conflictingPluginIds: sameNameEnabledIds.filter((id) => id !== plugin.id).sort(),
      skillQualifiedNames: collectDeclaredSkillQualifiedNames(plugin),
      // mcpServerNames 来自 enabled 分支解析出的 namespaced servers（`plugin:${name}:${server}`）；
      // disabled Plugin 没有 runtime MCP 名字，保持空数组。
      mcpServerNames: [...plugin.mcpServerNames].sort(),
      subagentNames: collectDeclaredSubagentNames(plugin),
      rootPath: plugin.rootPath,
      ...(plugin.uiSurfaces && plugin.uiSurfaces.length > 0
        ? { uiSurfaces: plugin.uiSurfaces }
        : {}),
    };
  });

  return { plugins: entries };
}

export function findPluginReferenceCatalogEntry(
  catalog: PluginReferenceCatalog | undefined,
  pluginId: string,
): PluginReferenceCatalogEntry | undefined {
  return catalog?.plugins.find((entry) => entry.pluginId === pluginId);
}
