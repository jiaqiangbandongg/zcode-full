import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { isRealComputerUseProducerInstalled } from "../packages/desktop/scripts/computer-use-producer.mjs";
import { stageSharpIntoBundledAgents } from "../packages/desktop/scripts/sharp-package-assets.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");

export function stageDevCuaPluginRuntime({
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  desktopPackageRoot = resolve(repositoryRoot, "packages", "desktop"),
  pluginRoot = resolve(repositoryRoot, "apps", "zcode-cli", "packages", "zcode-cua-plugin"),
} = {}) {
  if (env.ZCODE_CUA_DEV_MODE !== "1") return [];
  // 开源占位包不提供 Computer Use 原生能力，也不随附 Sharp：没有真实 producer 时不暂存。
  if (!isRealComputerUseProducerInstalled({ desktopPackageRoot })) return [];

  const manifestPath = resolve(pluginRoot, ".zcode-plugin", "plugin.json");
  if (!existsSync(manifestPath)) {
    throw new Error(
      `[stage-dev-cua-plugin-runtime] CUA plugin manifest is missing: ${manifestPath}`,
    );
  }

  // 修复原因：sync:cache 过去只把 Sharp 写入最终缓存，桌面重启时 bootstrap
  // 会用源码 plugin 原子替换该缓存并删除 Sharp。先补全 CUA filesystem seed source，
  // 才能让每次重建都得到可独立加载原生依赖的 CUA plugin；Browser Use 只提供
  // shared node_repl host，不再作为 CUA native 依赖的解析根目录。
  return stageSharpIntoBundledAgents({
    desktopPackageRoot,
    glmDir: pluginRoot,
    targetPlatform: {
      os: platform,
      arch,
      key: `${platform}-${arch}`,
    },
  });
}
