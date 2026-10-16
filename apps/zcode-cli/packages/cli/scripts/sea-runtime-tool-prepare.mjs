import { join } from "node:path";
import process from "node:process";
import { prepareNativeSearchTools } from "../../../../../scripts/prepare-native-search-tools.mjs";
import { resolveNativeSearchReleasePlan } from "../../../../../scripts/native-search-tools-config.mjs";
import { targetParts } from "./sea-targets.mjs";

export const resolveSeaRuntimeToolPreparationPlan = ({ root, target }) => {
  const { arch, releasePlatform } = targetParts(target);
  const platform = releasePlatform === "win" ? "win32" : releasePlatform;
  const platformKey = `${platform}-${arch}`;
  const outputDir = join(root, "packages/desktop/bundled-tools", platformKey);
  const releasePlan = resolveNativeSearchReleasePlan({ platform, arch });

  return {
    arch,
    enabled: releasePlan.enabled,
    outputDir,
    platform,
    platformKey,
  };
};

export const prepareSeaRuntimeToolAssets = async ({
  root,
  target,
  env = process.env,
  prebuiltPlan,
}) => {
  const plan = resolveSeaRuntimeToolPreparationPlan({ root, target });

  if (plan.enabled) {
    // 与 desktop prepare:native-search 共用同一准备入口：内网依赖源已配置时仍下载，
    // 未配置时解包 root 下的仓库归档，并统一写入工具目录旁的许可声明。
    await prepareNativeSearchTools({
      platform: plan.platform,
      arch: plan.arch,
      outputDir: plan.outputDir,
      dependenciesDir: join(root, "apps/zcode-cli/dependencies/native-search"),
      env,
      prebuiltPlan,
    });
  }
};
