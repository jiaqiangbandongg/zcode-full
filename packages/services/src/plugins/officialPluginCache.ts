import { readdir } from "node:fs/promises";
import { join } from "node:path";

export const ZCODE_OFFICIAL_PLUGIN_MARKETPLACE = "zcode-plugins-official";

/**
 * 与 apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts 的 defaultEnabled 保持一致。
 * services 侧（skills / commands / subagents）共用这一份，避免再出现 zcode-guide 那样某一处漏掉的分叉。
 */
export const DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS: ReadonlySet<string> = new Set([
  "browser-use@zcode-plugins-official",
  "document-skills@zcode-plugins-official",
  // 宿主不贡献 skill/command/subagent，列在这里只为与 definitions 的 defaultEnabled 逐一对应
  // （见 @zcode/shared 的同名集合注释）；这份没有机械对照单测兜着，漏掉只会静默分叉。
  "node-repl-host@zcode-plugins-official",
  "skill-creator@zcode-plugins-official",
  "zcode-guide@zcode-plugins-official",
]);

export interface OfficialPluginCacheRoot {
  /** 缓存目录名，即官方插件 name。 */
  name: string;
  /** 数字感知降序后的可用版本目录，首项为最新版本。 */
  versionRoots: string[];
}

/**
 * 扫描 `<plugins storage>/cache/zcode-plugins-official/<name>/<version>/`。
 * 内置官方插件由 CLI seed 到这里、没有 installed_plugins.json 记录，services 只读安装记录时会漏掉它们。
 * 版本目录跳过 CLI 的备份 / seed 锁 / 临时目录，并按数字感知降序排序，与 CLI 回退选取一致。
 */
export async function scanOfficialPluginCacheRoots(
  pluginStorageRoot: string,
): Promise<OfficialPluginCacheRoot[]> {
  const cacheRoot = join(pluginStorageRoot, "cache", ZCODE_OFFICIAL_PLUGIN_MARKETPLACE);
  let pluginEntries;
  try {
    pluginEntries = await readdir(cacheRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const roots: OfficialPluginCacheRoot[] = [];
  for (const pluginEntry of pluginEntries) {
    if (!pluginEntry.isDirectory()) continue;
    const pluginDir = join(cacheRoot, pluginEntry.name);
    let versionEntries;
    try {
      versionEntries = await readdir(pluginDir, { withFileTypes: true });
    } catch {
      continue;
    }
    const versionRoots = versionEntries
      .filter((entry) => entry.isDirectory() && !isTransientCacheEntryName(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) =>
        right.localeCompare(left, undefined, { numeric: true, sensitivity: "base" }),
      )
      .map((version) => join(pluginDir, version));
    if (versionRoots.length > 0) {
      roots.push({ name: pluginEntry.name, versionRoots });
    }
  }
  return roots.sort((left, right) => left.name.localeCompare(right.name));
}

function isTransientCacheEntryName(name: string): boolean {
  return name.includes(".backup") || name.includes(".seed-lock") || name.includes(".tmp-");
}
