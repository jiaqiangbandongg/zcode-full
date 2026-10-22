import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, copyFile, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME,
  SOURCE_SERVER_RELEASE_TARGETS,
  sourceServerReleaseDescriptorSchema,
  type SourceServerReleaseTarget,
} from "@zcode/shared";

export { SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME };
export const SOURCE_SERVER_REMOTE_RELEASE_TARGETS = SOURCE_SERVER_RELEASE_TARGETS;

export async function beginSourceServerRemoteReleaseGeneration(options: {
  versionReleaseDir: string;
}): Promise<void> {
  await mkdir(options.versionReleaseDir, { recursive: true });
  // Bug 原因：新一代构建在 collect 前失败时，旧 descriptor 仍可让开发连接成功消费上一代 archive。
  // generation 开始先撤销发布凭证；只有本轮所选平台全部完成后才重新原子发布 descriptor。
  await rm(join(options.versionReleaseDir, SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME), {
    force: true,
  });
}

async function copyFileAtomic(source: string, destination: string): Promise<void> {
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await copyFile(source, temporary);
    // descriptor 在 generation 开始时已经失效，因此 Windows 下先移除同名旧 archive
    // 不会暴露半代际；随后仍以单次 rename 发布完整临时文件。
    await rm(destination, { force: true });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function collectSourceServerRemoteReleaseArchives(options: {
  distReleaseDir: string;
  versionReleaseDir: string;
  version: string;
  targets?: readonly SourceServerReleaseTarget[];
}): Promise<string[]> {
  await beginSourceServerRemoteReleaseGeneration({
    versionReleaseDir: options.versionReleaseDir,
  });
  const sources = (options.targets ?? SOURCE_SERVER_REMOTE_RELEASE_TARGETS).map((target) => ({
    target,
    fileName: `zcode-server-${target}.tar.gz`,
    path: join(options.distReleaseDir, `zcode-server-${target}.tar.gz`),
  }));
  for (const source of sources) {
    try {
      await access(source.path);
    } catch {
      throw new Error(
        `Missing Source Server remote release archive for ${source.target}: ${source.path}`,
      );
    }
  }
  const collected: string[] = [];
  const archives = [];
  for (const source of sources) {
    const destination = join(options.versionReleaseDir, source.fileName);
    await copyFileAtomic(source.path, destination);
    collected.push(destination);
    const [sha256, fileStat] = await Promise.all([sha256File(destination), stat(destination)]);
    archives.push({
      target: source.target,
      version: options.version,
      fileName: source.fileName,
      sha256,
      sizeBytes: fileStat.size,
      urls: [source.fileName],
    });
  }
  const descriptor = sourceServerReleaseDescriptorSchema.parse({
    schemaVersion: 1,
    version: options.version,
    archives,
  });
  // Bug 原因：只按 version/fileName 发布 archive 时，同版本多次构建无法区分内容，
  // Desktop cache 与远端直下都可能静默复用旧包。独立 descriptor 固定本轮内容身份。
  const descriptorPath = join(
    options.versionReleaseDir,
    SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME,
  );
  const temporaryDescriptorPath = `${descriptorPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryDescriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`, "utf8");
    await rename(temporaryDescriptorPath, descriptorPath);
  } finally {
    await rm(temporaryDescriptorPath, { force: true }).catch(() => undefined);
  }
  return collected;
}
