import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME,
  sourceServerReleaseDescriptorSchema,
} from "@zcode/shared";

const run = promisify(execFile);

/** 只更改本 run 的 staged archive，制造同版本异 SHA；公共发布产物保持不可变。 */
export async function prepareSourceServerUpdateArchive(
  remoteSha: string,
  marker: string,
  options: { desktopRoot?: string } = {},
) {
  const desktopRoot = options.desktopRoot ?? resolve(import.meta.dirname, "../../..");
  const runId = process.env.ZCODE_E2E_RUN_ID?.trim();
  if (!runId || !/^[a-zA-Z0-9-]+$/u.test(runId)) throw new Error("更新 fixture 缺少安全 runId");
  const { version } = JSON.parse(
    await readFile(resolve(desktopRoot, "../../package.json"), "utf8"),
  );
  const releaseDir = join(desktopRoot, ".e2e-cache", runId, "mock-cdn/releases", version);
  const descriptorPath = join(releaseDir, SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME);
  const descriptor = sourceServerReleaseDescriptorSchema.parse(
    JSON.parse(await readFile(descriptorPath, "utf8")),
  );
  const entry = descriptor.archives.find((item) => item.sha256 === remoteSha);
  if (!entry) throw new Error("更新 fixture 的远端 SHA 不在本轮发布清单中");
  const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR;
  if (!artifactDir) throw new Error("更新 fixture 缺少隔离产物目录");
  await mkdir(artifactDir, { recursive: true });
  const work = await mkdtemp(join(artifactDir, "release-repack-"));
  const archivePath = join(releaseDir, entry.fileName);
  try {
    await run("tar", ["-xzf", archivePath, "-C", work], { timeout: 300_000 });
    const listing = await run("tar", ["-tzf", archivePath], {
      maxBuffer: 1 << 24,
      timeout: 60_000,
    });
    const top = listing.stdout
      .split("\n")
      .find((line) => line.trim())
      ?.split("/")[0];
    if (!top || top === ".." || top === ".")
      throw new Error("更新 fixture 的 archive 顶层目录无效");
    await writeFile(join(work, top, "runtime/E2E_R3_UPGRADE_MARKER.txt"), `${marker} ${runId}\n`);
    const repacked = join(work, entry.fileName);
    await run("tar", ["-czf", repacked, "-C", work, top], { timeout: 300_000 });
    const hash = createHash("sha256");
    for await (const bytes of createReadStream(repacked)) hash.update(bytes);
    const newSha = hash.digest("hex");
    // staged 文件是硬链接，必须先解除链接，不能原地写坏其他 case 的源包。
    await rm(archivePath, { force: true });
    await copyFile(repacked, archivePath);
    entry.sha256 = newSha;
    entry.sizeBytes = (await stat(archivePath)).size;
    await rm(descriptorPath, { force: true });
    await writeFile(descriptorPath, JSON.stringify(descriptor, null, 2));
    return { oldSha: remoteSha, newSha };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
