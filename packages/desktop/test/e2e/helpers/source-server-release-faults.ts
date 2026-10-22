import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import type { SourceServerReleaseArchive, SourceServerReleaseDescriptor } from "@zcode/shared";
import { normalizeRemoteArch, normalizeRemotePlatform } from "@zcode/server/remote/detectEnv.js";

export function selectSourceServerReleaseArchive(
  descriptor: SourceServerReleaseDescriptor,
  environment: { platform: string; arch: string },
): SourceServerReleaseArchive {
  // 根因：旧用例固定破坏 x64 包，ARM64 目标仍正常安装，随后被误判为吞错。
  // 使用每台远端自己的架构和 descriptor 文件名，不能从 Desktop 架构或另一台目标推断。
  const target = `${normalizeRemotePlatform(environment.platform)}-${normalizeRemoteArch(environment.arch)}`;
  const matches = descriptor.archives.filter((archive) => archive.target === target);
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one Source Server archive for ${target}, received ${matches.length}`,
    );
  }
  return matches[0]!;
}

export async function withSourceServerReleaseFileFault<T>(
  path: string,
  replacement: string | Uint8Array | null,
  run: () => Promise<T>,
): Promise<T> {
  const backup = `${path}.${randomUUID()}.fault-backup`;
  // 根因：断言抛错曾跳过文件恢复；直接覆写 staged 硬链接还会污染源包。
  // 保留原 inode，新建故障文件，并在所有退出路径恢复原文件。
  await rename(path, backup);
  try {
    if (replacement !== null) await writeFile(path, replacement);
    return await run();
  } finally {
    await rm(path, { force: true });
    await rename(backup, path);
  }
}
