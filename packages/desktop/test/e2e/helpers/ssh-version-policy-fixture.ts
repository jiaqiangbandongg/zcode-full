import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { Client } from "ssh2";
import { sourceServerReleaseDescriptorSchema } from "@zcode/shared";
import type { SSHConnectionConfig } from "#e2e/helpers/ssh-remote-p0";

const run = promisify(execFile);

/** 完整真实 runtime 的版本元数据变体；只测试兼容策略，不冒充旧版本业务实现。 */
export async function prepareVersionPolicyArchive(options: {
  installedSha: string;
  version: string;
  minimum: string;
}) {
  const runId = process.env.ZCODE_E2E_RUN_ID;
  const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR;
  if (!runId || !artifactDir) throw new Error("版本 fixture 缺少隔离 run 身份");
  const desktopRoot = resolve(import.meta.dirname, "../../..");
  const { version } = JSON.parse(
    await readFile(resolve(desktopRoot, "../../package.json"), "utf8"),
  );
  const releaseRoot = join(desktopRoot, ".e2e-cache", runId, "mock-cdn/releases", version);
  const descriptor = sourceServerReleaseDescriptorSchema.parse(
    JSON.parse(await readFile(join(releaseRoot, "source-server-release.json"), "utf8")),
  );
  const entry = descriptor.archives.find((entry) => entry.sha256 === options.installedSha);
  if (!entry) throw new Error("实际安装的 archive 不属于本轮构建");
  await mkdir(artifactDir, { recursive: true });
  const work = await mkdtemp(join(artifactDir, "version-policy-"));
  const original = join(releaseRoot, entry.fileName);
  const list = await run("tar", ["-tzf", original], { maxBuffer: 1 << 24 });
  const top = list.stdout.split("\n")[0]?.split("/")[0];
  if (!top || top === "." || top === "..") throw new Error("版本 archive 顶层路径非法");
  await run("tar", ["-xzf", original, "-C", work], { timeout: 300_000 });
  const manifestPath = join(work, top, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.appVersion = options.version;
  // 元数据变体必须重新走完整包安装，不能复用原 server-runtime 组件摘要。
  delete manifest.components;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  for (const file of ["server-core.js", "server-cli.js"]) {
    const path = join(work, top, "runtime", file);
    let source = await readFile(path, "utf8");
    let versionCount = 0;
    // 编译入口可能先声明变量、再在模块初始化器中赋值；不能只匹配内联 var 声明。
    source = source.replace(/(ZCODE_VERSION\d* = true \? )"[^"]+"/gu, (_match, prefix) => {
      versionCount += 1;
      return prefix + JSON.stringify(options.version);
    });
    if (!versionCount) throw new Error(`版本 fixture 未找到 ${file} 的编译版本常量`);
    source = source.replace(
      /(ZCODE_MIN_COMPATIBLE_VERSION\d* = true \? )"[^"]+"/gu,
      (_match, prefix) => prefix + JSON.stringify(options.minimum),
    );
    await writeFile(path, source);
  }
  const archive = join(work, `version-${options.version}.tar.gz`);
  await run("tar", ["-czf", archive, "-C", work, top], { timeout: 300_000 });
  return archive;
}

export async function uploadSSHFixtureFile(
  config: SSHConnectionConfig,
  localPath: string,
  remotePath: string,
) {
  const client = new Client();
  try {
    await new Promise<void>((resolve, reject) => {
      client.once("error", reject);
      client.once("ready", resolve);
      client.connect({
        host: config.host,
        port: config.port,
        username: config.username,
        password: config.password,
        readyTimeout: 30_000,
      });
    });
    const sftp = await new Promise<import("ssh2").SFTPWrapper>((resolve, reject) =>
      client.sftp((error, sftp) => (error ? reject(error) : resolve(sftp))),
    );
    await pipeline(createReadStream(localPath), sftp.createWriteStream(remotePath));
  } finally {
    client.end();
  }
}

/** 旧主链没有 Server runtime；SQLite 故障 fixture 使用已验真构建内的 Node，独立于业务进程。 */
export async function prepareSSHHistoryFixtureNode(
  config: SSHConnectionConfig,
  remoteRoot: string,
): Promise<string> {
  const desktopRoot = resolve(import.meta.dirname, "../../..");
  const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR;
  if (!artifactDir) throw new Error("历史 Node fixture 缺少隔离 artifact 目录");
  const { version } = JSON.parse(
    await readFile(resolve(desktopRoot, "../../package.json"), "utf8"),
  );
  const releases = join(desktopRoot, "mock-cdn/releases", version);
  const descriptor = sourceServerReleaseDescriptorSchema.parse(
    JSON.parse(await readFile(join(releases, "source-server-release.json"), "utf8")),
  );
  const { runSSHCommand } = await import("#e2e/helpers/ssh-remote-p0");
  const architecture = await runSSHCommand(config, "uname -m");
  const target =
    architecture.stdout.trim() === "x86_64"
      ? "linux-x64"
      : architecture.stdout.trim() === "aarch64"
        ? "linux-arm64"
        : null;
  const entry = descriptor.archives.find((item) => item.target === target);
  if (architecture.code !== 0 || !entry) throw new Error("历史 Node fixture 不支持该 SSH 架构");
  const work = await mkdtemp(join(artifactDir, "history-node-"));
  const archive = join(releases, entry.fileName);
  const listing = await run("tar", ["-tzf", archive], { maxBuffer: 1 << 24 });
  const nodeEntry = listing.stdout.split("\n").find((item) => /^[^/]+\/runtime\/node$/u.test(item));
  if (!nodeEntry) throw new Error("历史 Node fixture 构建包缺少 Node");
  await run("tar", ["-xzf", archive, "-C", work, nodeEntry], { timeout: 120_000 });
  const remoteNode = `${remoteRoot}/fixture-node`;
  await uploadSSHFixtureFile(config, join(work, nodeEntry), remoteNode);
  if ((await runSSHCommand(config, `chmod 700 '${remoteNode}'`)).code !== 0)
    throw new Error("历史 Node fixture 无法设执行权限");
  return remoteNode;
}
