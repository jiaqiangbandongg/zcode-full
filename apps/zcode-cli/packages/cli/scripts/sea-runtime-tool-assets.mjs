import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  NATIVE_SEARCH_TOOL_VERSIONS,
  resolveNativeSearchReleasePlan,
} from "../../../../../scripts/native-search-tools-config.mjs";
import { targetParts } from "./sea-targets.mjs";
import { readNativeSearchNotices } from "../../../../../scripts/third-party-notices.mjs";

export const seaRuntimeToolAssetPrefix = "zcode-runtime-tools/";
export const seaRuntimeToolManifestAssetKey = `${seaRuntimeToolAssetPrefix}manifest.json`;

const binaryNames = Object.freeze({
  bfs: "bfs",
  ripgrep: "rg",
  ugrep: "ugrep",
});

export const collectSeaRuntimeToolAssets = async ({ root, stagingDirectory, target }) => {
  const { arch, releasePlatform } = targetParts(target);
  const releasePlan = resolveNativeSearchReleasePlan({
    arch,
    platform: releasePlatform,
  });
  const toolIds = [...releasePlan.runtimeToolIds].sort();
  const tools = [];
  const assets = {};

  await rm(stagingDirectory, {
    force: true,
    recursive: true,
  });

  for (const toolId of toolIds) {
    const binaryName = `${binaryNames[toolId]}${releasePlan.platform === "win32" ? ".exe" : ""}`;
    const sourcePath = resolve(
      root,
      "packages",
      "desktop",
      "bundled-tools",
      releasePlan.platformKey,
      toolId,
      binaryName,
    );
    const sourceStat = await readRequiredBinaryStat(sourcePath, target, toolId);
    const bytes = await readFile(sourcePath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const assetKey = `${seaRuntimeToolAssetPrefix}${toolId}/${sha256}/${binaryName}`;
    const version = NATIVE_SEARCH_TOOL_VERSIONS[toolId];

    assets[assetKey] = sourcePath;
    tools.push({
      binaryName,
      id: toolId,
      sha256,
      size: sourceStat.size,
      version,
    });
  }

  const manifest = {
    target,
    tools,
    version: 1,
  };
  const manifestPath = resolve(stagingDirectory, "manifest.json");
  await mkdir(stagingDirectory, {
    recursive: true,
  });
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  assets[seaRuntimeToolManifestAssetKey] = manifestPath;
  // 单文件 SEA 同样分发原生工具，许可声明与来源清单随二进制内嵌，不依赖 dist 旁的伴随文件。
  const legal = await readNativeSearchNotices(root);
  for (const [name, bytes] of [
    ["THIRD-PARTY-NOTICES.txt", legal.bytes],
    ["SOURCES.json", await readFile(resolve(root, "third-party/native-search/sources.json"))],
  ]) {
    const file = resolve(stagingDirectory, name);
    await writeFile(file, bytes);
    assets[`${seaRuntimeToolAssetPrefix}${name}`] = file;
  }

  return {
    assets,
    manifest,
  };
};

async function readRequiredBinaryStat(sourcePath, target, toolId) {
  try {
    const sourceStat = await stat(sourcePath);
    if (sourceStat.isFile()) return sourceStat;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  throw new Error(
    `Missing SEA runtime tool ${toolId} for ${target}: ${sourcePath}. ` +
      "Prepare the target runtime assets before building the SEA binary.",
  );
}
