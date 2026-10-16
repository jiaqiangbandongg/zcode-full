import { existsSync } from "node:fs";
import { basename, join } from "node:path";

export interface EnsureSshRemoteReleaseAssetsOptions {
  /**
   * SSH remote runtime 使用的 release 目录（packages/desktop/mock-cdn/releases/<version>）。
   */
  releaseDir: string;
  /**
   * 执行 `pnpm --filter @zcode/desktop prepare:remote-assets` 的回调，由 wdio.conf.ts
   * 注入以复用 runPnpmWorkspaceCommand（处理 CI HOME / NODE_OPTION / Windows shell）。
   */
  prepareReleaseAssets: () => void;
  /** 文件存在性检查，默认 node:fs existsSync；测试注入 fake 实现。 */
  exists?: (path: string) => boolean;
  /** 日志输出，默认 console.log；测试注入 spy。 */
  onInfo?: (message: string) => void;
}

// 与 scripts/prepare-prebuilds.mjs 的 remotePlatforms 保持一致：manifest-<platform>.json 是
// prepare 流程的最后一步产出，四份齐全即代表该版本 release 完整（平台清单变更需同步这里）。
const REMOTE_RELEASE_PLATFORMS = [
  "linux-arm64",
  "linux-x64",
  "darwin-arm64",
  "darwin-x64",
] as const;

function resolveReleaseManifestPaths(releaseDir: string): string[] {
  return REMOTE_RELEASE_PLATFORMS.map((platform) => join(releaseDir, `manifest-${platform}.json`));
}

function isRemoteReleaseComplete(releaseDir: string, exists: (path: string) => boolean): boolean {
  return resolveReleaseManifestPaths(releaseDir).every((manifestPath) => exists(manifestPath));
}

function listMissingManifests(releaseDir: string, exists: (path: string) => boolean): string[] {
  return resolveReleaseManifestPaths(releaseDir)
    .filter((manifestPath) => !exists(manifestPath))
    .map((manifestPath) => basename(manifestPath));
}

/**
 * Bug 根因：CI 只有 build:remote:assets job 会产出 mock-cdn/releases/<version>，且跑在
 * 通用 macos runner 的工作槽位；conversation e2e 跑在专用 e2e runner，mock-cdn 工作区
 * 持久化目录互不相通，且目录按版本号命名——每次版本 bump 后专用 runner 必然缺新版本
 * release，onPrepare 直接 fatal（2026-09-11 MR 2606 的 3.12.0 缺目录即此问题）。
 *
 * 改为：SSH 环境就绪但产物不完整时先自动执行 prepare:remote-assets（同版本 release 完整
 * 则跳过，幂等复用持久化产物）；prepare 后仍不完整才 fail-closed 抛错。
 *
 * 幂等判据用四平台 manifest 哨兵而不是目录存在性：prepare-prebuilds 的 main() 第一步就
 * mkdirSync releaseDir、manifest 最后才写，job 在 prepare 中途取消/超时留下的半成品目录会
 * 跨 job 持久化（目录按版本命名），旧判据会让后续同版本运行永远命中「目录存在即跳过」，
 * e2e 以远端缺 server bundle / node 二进制等远离根因的症状失败，需人工删目录才能恢复。
 * manifest 不全时重跑 prepare 即可在半成品目录上继续补齐（其内部各步骤自带存在性跳过）。
 *
 * @returns 是否执行了自动 prepare（false 表示 release 已完整、直接复用）。
 */
export function ensureSshRemoteReleaseAssets(
  options: EnsureSshRemoteReleaseAssetsOptions,
): boolean {
  const { prepareReleaseAssets, releaseDir } = options;
  const exists = options.exists ?? ((path: string) => existsSync(path));
  const onInfo = options.onInfo ?? ((message: string) => console.log(message));

  if (isRemoteReleaseComplete(releaseDir, exists)) {
    return false;
  }

  onInfo(
    `[e2e] SSH remote assets missing or incomplete: ${releaseDir} ` +
      `(missing: ${listMissingManifests(releaseDir, exists).join(", ")}); ` +
      "auto-running pnpm --filter @zcode/desktop prepare:remote-assets",
  );
  prepareReleaseAssets();

  const stillMissing = listMissingManifests(releaseDir, exists);
  if (stillMissing.length > 0) {
    throw new Error(
      `[e2e] prepare:remote-assets completed but release still incomplete: ${releaseDir} ` +
        `(missing: ${stillMissing.join(", ")})`,
    );
  }

  return true;
}
