#!/usr/bin/env node

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { resolveIntranetDepsBaseUrl } from "./intranetDefaults.mjs";
import {
  LEGACY_REMOTE_RIPGREP_ARCHIVE_SHA256_BY_TARGET,
  LEGACY_REMOTE_RIPGREP_VERSION,
} from "./native-search-tools-config.mjs";
import { downloadAndExtractPrebuiltBinary } from "./prebuilt-binary-download.mjs";

const require = createRequire(import.meta.url);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const RIPGREP_VERSION = process.argv[2] || LEGACY_REMOTE_RIPGREP_VERSION;

function normalizePlatform(raw) {
  switch ((raw ?? "").toLowerCase()) {
    case "mac":
    case "macos":
    case "darwin":
    case "osx":
      return "darwin";
    case "win":
    case "windows":
    case "win32":
      return "win32";
    case "linux":
      return "linux";
    default:
      return raw;
  }
}

function normalizeArch(raw) {
  switch ((raw ?? "").toLowerCase()) {
    case "x86_64":
    case "x64":
    case "amd64":
      return "x64";
    case "aarch64":
    case "arm64":
      return "arm64";
    default:
      return raw;
  }
}

function resolveRipgrepTarget(platform, arch) {
  switch (platform) {
    case "darwin":
      return arch === "arm64" ? "aarch64-apple-darwin.tar.gz" : "x86_64-apple-darwin.tar.gz";
    case "win32":
      return arch === "arm64" ? "aarch64-pc-windows-msvc.zip" : "x86_64-pc-windows-msvc.zip";
    case "linux":
      return arch === "arm64"
        ? "aarch64-unknown-linux-gnu.tar.gz"
        : "x86_64-unknown-linux-musl.tar.gz";
    default:
      throw new Error(`Unsupported ripgrep platform: ${platform}-${arch}`);
  }
}

export function resolveRipgrepDownloadBaseUrl(version, env = process.env) {
  return (
    env.RIPGREP_BINARY_DOWNLOAD_BASE_URL?.trim().replace(/\/+$/, "") ||
    `${resolveIntranetDepsBaseUrl(env)}/ripgrep-${version}`
  );
}

export function resolveRipgrepDownloadPlan({
  version,
  targetPlatform,
  targetArch,
  localPlatform,
  localArch,
  packageVersion,
  forceRemoteOutput = false,
  outputDir,
  env = process.env,
}) {
  const normalizedTargetPlatform = normalizePlatform(targetPlatform);
  const normalizedTargetArch = normalizeArch(targetArch);
  const normalizedLocalPlatform = normalizePlatform(localPlatform);
  const normalizedLocalArch = normalizeArch(localArch);
  const platformKey = `${normalizedTargetPlatform}-${normalizedTargetArch}`;
  const localKey = `${normalizedLocalPlatform}-${normalizedLocalArch}`;
  const target = resolveRipgrepTarget(normalizedTargetPlatform, normalizedTargetArch);
  const binaryName = normalizedTargetPlatform === "win32" ? "rg.exe" : "rg";
  const releaseFileName = `ripgrep-${version}-${target}`;
  const archiveSha256 =
    version === LEGACY_REMOTE_RIPGREP_VERSION
      ? LEGACY_REMOTE_RIPGREP_ARCHIVE_SHA256_BY_TARGET[platformKey]
      : undefined;
  const localOutputDir = join(repoRoot, "packages/desktop/bundled-tools", platformKey, "ripgrep");
  const remoteOutputDir = join(
    repoRoot,
    "packages/desktop/mock-cdn/releases",
    packageVersion,
    "tools",
    platformKey,
    "ripgrep",
  );
  const resolvedOutputDir = outputDir
    ? resolve(outputDir)
    : forceRemoteOutput
      ? remoteOutputDir
      : platformKey === localKey
        ? localOutputDir
        : remoteOutputDir;

  return {
    version,
    platformKey,
    binaryName,
    outputDir: resolvedOutputDir,
    remoteOutputDir,
    releaseFileName,
    downloadUrl: `${resolveRipgrepDownloadBaseUrl(version, env)}/${releaseFileName}`,
    archiveExt: target.endsWith(".zip") ? "zip" : "tar.gz",
    archiveSha256,
  };
}

export async function downloadRipgrepBinary({
  version = LEGACY_REMOTE_RIPGREP_VERSION,
  targetPlatform = process.env.ZCODE_TARGET_OS || process.platform,
  targetArch = process.env.ZCODE_TARGET_ARCH || process.arch,
  localPlatform = process.env.ZCODE_TARGET_OS || process.platform,
  localArch = process.env.ZCODE_TARGET_ARCH || process.arch,
  packageVersion = require(join(repoRoot, "package.json")).version,
  forceRemoteOutput = process.env.ZCODE_FORCE_REMOTE_MOCK_CDN === "1",
  outputDir,
  env = process.env,
} = {}) {
  const plan = resolveRipgrepDownloadPlan({
    version,
    targetPlatform,
    targetArch,
    localPlatform,
    localArch,
    packageVersion,
    forceRemoteOutput,
    outputDir,
    env,
  });
  const binaryPath = join(plan.outputDir, plan.binaryName);

  console.log("==> ripgrep download");
  console.log(`    version:  ${plan.version}`);
  console.log(`    platform: ${plan.platformKey}`);
  console.log(`    target:   ${plan.outputDir}`);

  if (existsSync(binaryPath)) {
    console.log("    [skip] 已存在，跳过");
    return;
  }

  mkdirSync(plan.outputDir, { recursive: true });

  console.log(`    [download] ${plan.downloadUrl}`);
  await downloadAndExtractPrebuiltBinary({
    archiveExt: plan.archiveExt,
    archiveSha256: plan.archiveSha256,
    binaryName: plan.binaryName,
    binaryPath,
    cwd: repoRoot,
    downloadUrl: plan.downloadUrl,
    targetPlatform: normalizePlatform(targetPlatform),
  });

  console.log(`==> Done! ripgrep ${plan.version} (${plan.platformKey}) -> ${plan.outputDir}`);
}

async function main() {
  await downloadRipgrepBinary({
    version: RIPGREP_VERSION,
    targetPlatform: process.argv[3] || process.env.ZCODE_TARGET_OS || process.platform,
    targetArch: process.argv[4] || process.env.ZCODE_TARGET_ARCH || process.arch,
  });
}

const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entryHref === import.meta.url) {
  await main();
}
