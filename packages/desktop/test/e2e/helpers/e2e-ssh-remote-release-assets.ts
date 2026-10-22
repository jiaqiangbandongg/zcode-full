import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import {
  SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME,
  SOURCE_SERVER_RELEASE_TARGETS,
} from "@zcode/shared";

export interface EnsureSshRemoteReleaseAssetsOptions {
  /**
   * SSH remote runtime 使用的 release 目录（packages/desktop/mock-cdn/releases/<version>）。
   */
  releaseDir: string;
  /**
   * 执行根 package.json 的 `pnpm prepare:remote-assets`（→ @zcode/server-cli stage:remote-assets）
   * 的回调，由 wdio.conf.ts 注入以复用 runPnpmWorkspaceCommand（处理 CI HOME / NODE_OPTION /
   * Windows shell）。
   */
  prepareReleaseAssets: () => void;
  /** 文件存在性检查，默认 node:fs existsSync；测试注入 fake 实现。 */
  exists?: (path: string) => boolean;
  /** 日志输出，默认 console.log；测试注入 spy。 */
  onInfo?: (message: string) => void;
}

// Bug 根因：release 产物已切换为 descriptor + archive 布局（stage:remote-assets →
// remoteAssetRelease.ts collectSourceServerRemoteReleaseArchives），旧的 manifest-<platform>.json
// 不再产出；继续用它做哨兵会让新布局永远判“不完整”，进而调用已删除的
// `pnpm --filter @zcode/desktop prepare:remote-assets` 并让 onPrepare fatal。
// 这里直接复用 @zcode/shared 的 target 与 descriptor 文件名常量，避免再次漂移。
function resolveReleaseAssetPaths(releaseDir: string): string[] {
  return [
    join(releaseDir, SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME),
    ...SOURCE_SERVER_RELEASE_TARGETS.map((target) =>
      join(releaseDir, `zcode-server-${target}.tar.gz`),
    ),
  ];
}

function listMissingReleaseAssets(releaseDir: string, exists: (path: string) => boolean): string[] {
  return resolveReleaseAssetPaths(releaseDir)
    .filter((assetPath) => !exists(assetPath))
    .map((assetPath) => basename(assetPath));
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
 * 幂等判据用 descriptor + 四个 target archive 而不是目录存在性：
 * beginSourceServerRemoteReleaseGeneration 在 generation 开始时先删除 descriptor、四个 archive
 * 全部收齐后才原子写回，因此 descriptor 存在即代表本代际完整；prepare 中途取消/超时留下的
 * 半成品目录会跨 job 持久化（目录按版本命名），旧“目录存在即跳过”判据会让后续同版本运行
 * 永远跳过自愈，e2e 以远端缺 server bundle 等远离根因的症状失败，需人工删目录才能恢复。
 *
 * @returns 是否执行了自动 prepare（false 表示 release 已完整、直接复用）。
 */
export function ensureSshRemoteReleaseAssets(
  options: EnsureSshRemoteReleaseAssetsOptions,
): boolean {
  const { prepareReleaseAssets, releaseDir } = options;
  const exists = options.exists ?? ((path: string) => existsSync(path));
  const onInfo = options.onInfo ?? ((message: string) => console.log(message));

  const missing = listMissingReleaseAssets(releaseDir, exists);
  if (missing.length === 0) {
    return false;
  }

  onInfo(
    `[e2e] SSH remote assets missing or incomplete: ${releaseDir} ` +
      `(missing: ${missing.join(", ")}); auto-running pnpm prepare:remote-assets`,
  );
  prepareReleaseAssets();

  const stillMissing = listMissingReleaseAssets(releaseDir, exists);
  if (stillMissing.length > 0) {
    throw new Error(
      `[e2e] prepare:remote-assets completed but release still incomplete: ${releaseDir} ` +
        `(missing: ${stillMissing.join(", ")})`,
    );
  }

  return true;
}
