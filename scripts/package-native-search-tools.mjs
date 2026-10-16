#!/usr/bin/env node

import { createWriteStream, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { buildNativeSearchTools } from "./build-native-search-tools.mjs";
import { packSourceAsDeterministicTarGzip } from "./deterministic-tar-archive.mjs";
import { resolveNativeSearchPrebuiltPlan } from "./native-search-tools-config.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(repoRoot, "packages/desktop/package.json"));

export function resolveNativeSearchPackagedArtifactPath({ artifact, artifactsDir }) {
  return join(
    resolve(artifactsDir),
    "native-search-tools",
    `${artifact.toolId}-${artifact.release}`,
    artifact.releaseFileName,
  );
}

async function packWindowsZip(binaryPath, binaryName, archivePath) {
  const { ZipFile } = require("yazl");
  const zip = new ZipFile();
  // Bugfix: yazl 按本地时区编码 DOS 时间；固定本地时间并禁用扩展时间戳才能跨时区复现。
  zip.addFile(binaryPath, binaryName, {
    mtime: new Date(1980, 0, 1, 0, 0, 0, 0),
    mode: 0o100755,
    forceDosTimestamp: true,
  });
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(archivePath));
}

export async function packageNativeSearchTools({
  platform = process.env.ZCODE_TARGET_OS || process.platform,
  arch = process.env.ZCODE_TARGET_ARCH || process.arch,
  artifactsDir = join(repoRoot, "dist/native-search-tools-deps"),
  buildOutputDir,
  jobs,
} = {}) {
  const buildPlan = buildNativeSearchTools({
    platform,
    arch,
    outputDir: buildOutputDir,
    jobs,
  });
  const prebuiltPlan = resolveNativeSearchPrebuiltPlan({
    platform: buildPlan.platform,
    arch: buildPlan.arch,
    outputDir: buildPlan.outputDir,
  });

  await packNativeSearchPrebuiltArtifacts({ prebuiltPlan, artifactsDir });
  return prebuiltPlan;
}

export async function packNativeSearchPrebuiltArtifacts({ prebuiltPlan, artifactsDir }) {
  for (const artifact of prebuiltPlan.artifacts.filter(({ source }) => source === "producer")) {
    const archivePath = resolveNativeSearchPackagedArtifactPath({ artifact, artifactsDir });
    mkdirSync(dirname(archivePath), { recursive: true });

    if (artifact.archiveExt === "zip") {
      await packWindowsZip(artifact.binaryPath, artifact.binaryName, archivePath);
    } else {
      packSourceAsDeterministicTarGzip(artifact.binaryPath, archivePath);
    }
    console.log(`==> Packaged ${artifact.toolId} ${artifact.release} -> ${archivePath}`);
  }
}

function readOption(name) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readJobs() {
  const value = readOption("jobs");
  if (value === undefined) return undefined;
  const jobs = Number.parseInt(value, 10);
  if (!Number.isInteger(jobs) || jobs < 1) throw new Error(`invalid --jobs value: ${value}`);
  return jobs;
}

async function main() {
  await packageNativeSearchTools({
    platform: readOption("platform") ?? process.env.ZCODE_TARGET_OS ?? process.platform,
    arch: readOption("arch") ?? process.env.ZCODE_TARGET_ARCH ?? process.arch,
    artifactsDir: readOption("artifacts-dir"),
    buildOutputDir: readOption("build-output-dir"),
    jobs: readJobs(),
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
