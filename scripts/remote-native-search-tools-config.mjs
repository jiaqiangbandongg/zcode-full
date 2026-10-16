import { resolve } from "node:path";
import process from "node:process";
import {
  LEGACY_REMOTE_RIPGREP_ARCHIVE_SHA256_BY_TARGET,
  LEGACY_REMOTE_RIPGREP_VERSION,
  NATIVE_SEARCH_DEPENDENCIES_DIR,
  resolveNativeSearchBuildPlan,
  resolveNativeSearchPrebuiltPlan,
} from "./native-search-tools-config.mjs";

// legacy rg13 的版本与摘要仍由 native-search-tools-config.mjs 唯一持有（内网 download-ripgrep 链路同样读取），
// 这里只转出，避免两份常量漂移。
export { LEGACY_REMOTE_RIPGREP_ARCHIVE_SHA256_BY_TARGET, LEGACY_REMOTE_RIPGREP_VERSION };

export function resolveRemoteNativeSearchPrebuiltPlan({
  platform = process.platform,
  arch = process.arch,
  outputDir,
  dependenciesDir = NATIVE_SEARCH_DEPENDENCIES_DIR,
} = {}) {
  const buildPlan = resolveNativeSearchBuildPlan({ platform, arch, outputDir });
  if (buildPlan.platform === "linux") {
    return resolveNativeSearchPrebuiltPlan({ platform, arch, outputDir, dependenciesDir });
  }
  if (buildPlan.platform !== "darwin") {
    throw new Error(`unsupported remote native search target ${buildPlan.platformKey}`);
  }

  // macOS remote retains rg13; Desktop and SEA use the default rg14 plan.
  const release = LEGACY_REMOTE_RIPGREP_VERSION;
  const archiveTarget = `${buildPlan.arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin.tar.gz`;
  const releaseFileName = `ripgrep-${release}-${archiveTarget}`;
  return {
    platform: buildPlan.platform,
    arch: buildPlan.arch,
    platformKey: buildPlan.platformKey,
    outputDir: buildPlan.outputDir,
    runtimeToolIds: ["ripgrep"],
    producerOutputIds: [],
    binaries: { ripgrep: buildPlan.rgPath },
    rgPath: buildPlan.rgPath,
    artifacts: [
      {
        toolId: "ripgrep",
        version: "13.0.0",
        release,
        releaseFileName,
        archiveExt: "tar.gz",
        archiveSha256: LEGACY_REMOTE_RIPGREP_ARCHIVE_SHA256_BY_TARGET[buildPlan.platformKey],
        binaryName: "rg",
        binaryPath: buildPlan.rgPath,
        archivePath: resolve(dependenciesDir, `ripgrep-${release}`, releaseFileName),
        source: "official",
      },
    ],
  };
}
