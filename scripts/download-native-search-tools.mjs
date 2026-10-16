#!/usr/bin/env node

import { chmodSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  isNativeSearchBundleCurrent,
  writeNativeSearchBundleMeta,
} from "./native-search-tools-bundle-meta.mjs";
import { resolveNativeSearchPrebuiltPlan } from "./native-search-tools-config.mjs";
import { verifyNativeSearchBinaryTarget } from "./native-search-tools-verify.mjs";
import { downloadAndExtractPrebuiltBinary } from "./prebuilt-binary-download.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function ensureCachedBinaryExecutable(binaryPath, targetPlatform) {
  if (process.platform === "win32" || targetPlatform === "win32") return;
  if ((statSync(binaryPath).mode & 0o111) !== 0) return;

  // Bugfix：缓存元数据只校验内容，不能让意外丢失的 Unix 可执行权限随 skip 流程继续传递。
  chmodSync(binaryPath, 0o755);
}

export async function downloadNativeSearchTools({
  platform = process.env.ZCODE_TARGET_OS || process.platform,
  arch = process.env.ZCODE_TARGET_ARCH || process.arch,
  outputDir,
  env = process.env,
  prebuiltPlan,
} = {}) {
  const plan = prebuiltPlan ?? resolveNativeSearchPrebuiltPlan({ platform, arch, outputDir, env });

  console.log("==> native search tools download");
  console.log(`    platform: ${plan.platformKey}`);
  console.log(`    target:   ${plan.outputDir}`);

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

    console.log(`    [download] ${artifact.downloadUrl}`);
    await downloadAndExtractPrebuiltBinary({
      archiveExt: artifact.archiveExt,
      archiveSha256: artifact.archiveSha256,
      binaryName: artifact.binaryName,
      binaryPath: artifact.binaryPath,
      cwd: repoRoot,
      downloadUrl: artifact.downloadUrl,
      targetPlatform: plan.platform,
      validateBinary,
    });
    writeNativeSearchBundleMeta(artifact, plan.platformKey);
  }

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
  await downloadNativeSearchTools({
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
