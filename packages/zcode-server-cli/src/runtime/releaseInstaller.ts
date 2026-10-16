import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readdir, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { releaseManifestSchema, type ReleaseManifest } from "../contracts.js";
import { serverRuntimeManifestSchema, type ServerTarget } from "./manifest.js";
import { extractArchiveSafely } from "./componentCache.js";
import { promoteImmutableReleaseDirectory } from "./immutableRelease.js";
import type { ServerLayout } from "./paths.js";
import { ReleaseManager } from "./releaseManager.js";
import { writeStableLauncher } from "./stableLauncher.js";

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function flattenArchiveRoot(extractDir: string): Promise<void> {
  const entries = await readdir(extractDir, { withFileTypes: true });
  // macOS tar 可能额外写入 `._*` PAX/resource-fork 条目，不能因为这些旁路文件
  // 让唯一发行根目录识别失败，否则后续会误报 manifest.json 缺失。
  const rootEntries = entries.filter((entry) => entry.isDirectory() && entry.name.startsWith("zcode-server-"));
  if (rootEntries.length > 1) throw new Error("Release archive contains multiple zcode-server roots");
  const rootEntry = rootEntries[0];
  if (!rootEntry) return;
  const nested = join(extractDir, rootEntry.name);
  for (const entry of await readdir(nested)) await rename(join(nested, entry), join(extractDir, entry));
  await rm(nested, { recursive: true, force: true });
  for (const entry of entries) {
    if (entry.name !== rootEntry.name && entry.name.startsWith("._")) await rm(join(extractDir, entry.name), { force: true, recursive: true });
  }
}

export interface InstallArchiveOptions {
  archivePath: string;
  target: ServerTarget;
  version: string;
  archiveSha256?: string;
}

export class ReleaseInstaller {
  public constructor(private readonly layout: ServerLayout) {}

  public async installArchive(options: InstallArchiveOptions): Promise<ReleaseManifest> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(options.version)) {
      throw new Error(`Invalid release version: ${options.version}`);
    }
    const archiveSha256 = await sha256File(options.archivePath);
    if (options.archiveSha256 && archiveSha256.toLowerCase() !== options.archiveSha256.toLowerCase()) {
      throw new Error(`Release archive checksum mismatch: expected ${options.archiveSha256}, received ${archiveSha256}`);
    }
    const releaseManager = new ReleaseManager(this.layout);
    await releaseManager.ensure();
    const incomingRoot = await mkdtemp(join(this.layout.releasesDir, `.incoming-${process.pid}-`));
    try {
      await extractArchiveSafely(resolve(options.archivePath), incomingRoot);
      await flattenArchiveRoot(incomingRoot);
      const runtimeManifest = serverRuntimeManifestSchema.parse(JSON.parse(await readFile(join(incomingRoot, "manifest.json"), "utf8")));
      if (runtimeManifest.target !== options.target) throw new Error(`Release target mismatch: expected ${options.target}, received ${runtimeManifest.target}`);
      if (runtimeManifest.appVersion !== options.version) throw new Error(`Release version mismatch: expected ${options.version}, received ${runtimeManifest.appVersion}`);
      const releaseId = `${options.version}-${options.target}-${archiveSha256.slice(0, 12)}`;
      const releaseDir = join(this.layout.releasesDir, releaseId);
      await promoteImmutableReleaseDirectory({
        incomingDir: incomingRoot,
        targetDir: releaseDir,
        identity: { archiveSha256, target: options.target, version: options.version },
      });
      const manifest = releaseManifestSchema.parse({
        version: options.version,
        releaseDir,
        releaseId,
        appVersion: runtimeManifest.appVersion,
        target: runtimeManifest.target,
        nodeVersion: runtimeManifest.nodeVersion,
        archiveSha256,
        components: runtimeManifest.components,
      });
      await releaseManager.writePending(manifest);
      await writeStableLauncher(this.layout, options.target.startsWith("win32-") ? "win32" : options.target.startsWith("darwin-") ? "darwin" : "linux");
      return manifest;
    } catch (error) {
      await rm(incomingRoot, { recursive: true, force: true });
      throw error;
    }
  }
}
