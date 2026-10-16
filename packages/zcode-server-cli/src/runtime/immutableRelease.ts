import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { serverRuntimeManifestSchema, type ServerTarget } from "./manifest.js";

export interface ReleaseIdentity {
  archiveSha256: string;
  target: ServerTarget;
  version: string;
}

interface ReleaseIntegrity extends ReleaseIdentity {
  contentSha256: string;
}

export const RELEASE_INTEGRITY_FILE = ".release-integrity.json";

async function hashReleaseTree(root: string, relativeRoot = ""): Promise<string> {
  const hash = createHash("sha256");
  const visit = async (relativeDirectory: string): Promise<void> => {
    const entries = await readdir(join(root, relativeDirectory), { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const relativePath = join(relativeDirectory, entry.name);
      if (relativePath === RELEASE_INTEGRITY_FILE) continue;
      const normalizedPath = relativePath.replaceAll("\\", "/");
      if (entry.isDirectory()) {
        hash.update(`directory\0${normalizedPath}\0`);
        await visit(relativePath);
        continue;
      }
      if (!entry.isFile()) throw new Error(`Unsupported release entry: ${normalizedPath}`);
      const fileStat = await stat(join(root, relativePath));
      hash.update(`file\0${normalizedPath}\0${fileStat.mode & 0o777}\0`);
      for await (const chunk of createReadStream(join(root, relativePath))) hash.update(chunk);
    }
  };
  await visit(relativeRoot);
  return hash.digest("hex");
}

async function assertExistingReleaseMatches(
  releaseDir: string,
  expected: ReleaseIntegrity,
): Promise<void> {
  try {
    const integrity = JSON.parse(
      await readFile(join(releaseDir, RELEASE_INTEGRITY_FILE), "utf8"),
    ) as Partial<ReleaseIntegrity>;
    const runtimeManifest = serverRuntimeManifestSchema.parse(
      JSON.parse(await readFile(join(releaseDir, "manifest.json"), "utf8")),
    );
    const actualContentSha256 = await hashReleaseTree(releaseDir);
    if (
      integrity.archiveSha256 !== expected.archiveSha256 ||
      integrity.contentSha256 !== expected.contentSha256 ||
      integrity.contentSha256 !== actualContentSha256 ||
      integrity.target !== expected.target ||
      integrity.version !== expected.version ||
      runtimeManifest.target !== expected.target ||
      runtimeManifest.appVersion !== expected.version
    ) {
      throw new Error("identity mismatch");
    }
  } catch (error) {
    throw new Error(
      `Existing immutable release conflict at ${releaseDir}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function existingPathKind(path: string): Promise<"directory" | "other" | null> {
  try {
    return (await stat(path)).isDirectory() ? "directory" : "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function promoteImmutableReleaseDirectory(options: {
  incomingDir: string;
  targetDir: string;
  identity: ReleaseIdentity;
}): Promise<void> {
  if (!/^[a-f0-9]{64}$/iu.test(options.identity.archiveSha256)) {
    throw new Error(`Invalid release archive SHA-256: ${options.identity.archiveSha256}`);
  }
  const integrity: ReleaseIntegrity = {
    ...options.identity,
    archiveSha256: options.identity.archiveSha256.toLowerCase(),
    contentSha256: await hashReleaseTree(options.incomingDir),
  };
  await writeFile(
    join(options.incomingDir, RELEASE_INTEGRITY_FILE),
    `${JSON.stringify(integrity, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  let promoted = false;
  try {
    const existingKind = await existingPathKind(options.targetDir);
    if (existingKind !== null) {
      if (existingKind !== "directory") {
        throw new Error(`Existing immutable release conflict at ${options.targetDir}: target is not a directory`);
      }
      await assertExistingReleaseMatches(options.targetDir, integrity);
      return;
    }
    try {
      await rename(options.incomingDir, options.targetDir);
      promoted = true;
    } catch (error) {
      // 并发发布可能都先看到目标不存在。rename 失败后仅当目标确实已由
      // 另一发布者创建时才进入校验复用；Windows 的普通 EPERM 不能伪装成命中。
      const racedKind = await existingPathKind(options.targetDir);
      if (racedKind !== "directory") throw error;
      await assertExistingReleaseMatches(options.targetDir, integrity);
    }
  } finally {
    // 复用和失败都不会消费 incoming，必须统一清理，避免每次重试留下完整 release。
    if (!promoted) await rm(options.incomingDir, { recursive: true, force: true });
  }
}
