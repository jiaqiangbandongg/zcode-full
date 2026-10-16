#!/usr/bin/env node

import { chmodSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  isNativeSearchBundleCurrent,
  writeNativeSearchBundleMeta,
} from "./native-search-tools-bundle-meta.mjs";
import { downloadNativeSearchTools } from "./download-native-search-tools.mjs";
import {
  resolveNativeSearchArtifactSource,
  resolveNativeSearchPrebuiltPlan,
} from "./native-search-tools-config.mjs";
import { verifyNativeSearchBinaryTarget } from "./native-search-tools-verify.mjs";
import { extractPrebuiltBinary, verifyPrebuiltArchiveSha256 } from "./prebuilt-binary-extract.mjs";
import { stageNativeSearchNotices } from "./third-party-notices.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function ensureCachedBinaryExecutable(binaryPath, targetPlatform) {
  if (process.platform === "win32" || targetPlatform === "win32") return;
  if ((statSync(binaryPath).mode & 0o111) !== 0) return;

  // 缓存元数据只校验内容，不能让意外丢失的 Unix 可执行权限随 skip 流程继续传递。
  chmodSync(binaryPath, 0o755);
}

/**
 * native search 预编译工具的唯一准备入口（desktop prepare:native-search、SEA、server-cli、remote 共用）。
 *
 * 来源由 resolveNativeSearchArtifactSource 判定：内网依赖源已配置时原样走既有
 * downloadNativeSearchTools（同一 release plan、SHA-256 校验与 bundle meta 缓存语义）；
 * 未配置时才解包仓库内置归档。两条路径都在返回前刷新工具目录旁的许可声明。
 */
export async function prepareNativeSearchTools({
  platform = process.env.ZCODE_TARGET_OS || process.platform,
  arch = process.env.ZCODE_TARGET_ARCH || process.arch,
  outputDir,
  dependenciesDir,
  env = process.env,
  source = resolveNativeSearchArtifactSource(env),
  prebuiltPlan,
} = {}) {
  if (source === "intranet") {
    const downloadedPlan = await downloadNativeSearchTools({
      platform,
      arch,
      outputDir,
      env,
      prebuiltPlan,
    });
    await stageNativeSearchNotices(downloadedPlan, repoRoot, { origin: "intranet-mirror" });
    return downloadedPlan;
  }
  if (source !== "repository") {
    throw new Error(`Unsupported native search artifact source: ${String(source)}`);
  }

  const plan =
    prebuiltPlan ?? resolveNativeSearchPrebuiltPlan({ platform, arch, outputDir, dependenciesDir });

  console.log("==> Preparing native search tools from repository archives");
  console.log(`    platform: ${plan.platformKey}`);
  console.log(`    target:   ${plan.outputDir}`);

  // Even a warm binary cache must not hide a missing or modified repository dependency.
  // Check the entire target before replacing any prepared binaries.
  for (const artifact of plan.artifacts) {
    try {
      verifyPrebuiltArchiveSha256(artifact.archivePath, artifact.archiveSha256);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Invalid local native search archive ${artifact.archivePath}: ${reason}. ` +
          "Restore the repository dependency before packaging.",
        { cause: error },
      );
    }
  }

  for (const artifact of plan.artifacts) {
    const validateBinary = (binaryPath) =>
      verifyNativeSearchBinaryTarget(binaryPath, {
        platform: plan.platform,
        arch: plan.arch,
      });
    if (isNativeSearchBundleCurrent(artifact, plan.platformKey)) {
      try {
        validateBinary(artifact.binaryPath);
        ensureCachedBinaryExecutable(artifact.binaryPath, plan.platform);
        console.log(`    [skip] ${artifact.toolId} ${artifact.release} 已存在`);
        continue;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.log(`    [repair] ${artifact.toolId} 目标校验失败: ${reason}`);
      }
    }

    console.log(`    [extract] ${artifact.archivePath}`);
    await extractPrebuiltBinary({
      archiveExt: artifact.archiveExt,
      archivePath: artifact.archivePath,
      archiveSha256: artifact.archiveSha256,
      binaryName: artifact.binaryName,
      binaryPath: artifact.binaryPath,
      cwd: repoRoot,
      targetPlatform: plan.platform,
      validateBinary,
    });
    writeNativeSearchBundleMeta(artifact, plan.platformKey);
  }

  await stageNativeSearchNotices(plan);
  console.log(`==> Done! native search tools (${plan.platformKey}) -> ${plan.outputDir}`);
  return plan;
}

function readOption(name) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  await prepareNativeSearchTools({
    platform: readOption("platform") ?? process.env.ZCODE_TARGET_OS ?? process.platform,
    arch: readOption("arch") ?? process.env.ZCODE_TARGET_ARCH ?? process.arch,
    outputDir: readOption("output-dir"),
  });
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  }
}
