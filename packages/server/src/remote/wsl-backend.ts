/* oxlint-disable eslint(max-lines) -- WSL backend 同时承载探测、路径解析、兼容 UNC 与可取消流式上传。 */
import { spawn, execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { access, copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { dirname, posix } from "node:path";
import type { WSLConnectOptions } from "@zcode/shared";
import type {
  IRemoteBackend,
  RemoteEnvironment,
  RemoteUploadOptions,
  StdioStream,
} from "@zcode/server/remote/backend.js";
import { createCloseEventController } from "@zcode/server/remote/closeEvent.js";
import {
  normalizeRemoteArch,
  normalizeRemotePlatform,
  resolveRemotePlatform,
} from "@zcode/server/remote/detectEnv.js";
import { isWSLAvailable, listWSLDistros, type WSLDistro } from "@zcode/server/remote/wsl-detect.js";
import {
  buildWslHostGatewayCommand,
  buildWslProxyPortProbeCommand,
  isLoopbackProxyHostname,
  normalizeWslProxyUrl,
  parseWslHostGatewayOutput,
  parseWslProxyPortProbeOutput,
  replaceProxyHostname,
} from "@zcode/server/remote/wslProxy.js";

interface ResolvedWSLInfo {
  distroName: string | null;
  userName: string | null;
  version: 1 | 2 | null;
  homeDir: string;
}

export interface ResolvedWSLIdentity {
  distro: string;
  user: string;
}

const WSL_COMMAND = "wsl.exe";
const WSL_EXEC_MAX_BUFFER = 8 * 1024 * 1024;

function quotePosixShellArg(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function decodeWslOutput(buffer: Buffer): string {
  if (buffer.length === 0) {
    return "";
  }

  if (buffer.includes(0)) {
    return buffer.toString("utf16le");
  }

  return buffer.toString("utf8");
}

function normalizeWslOutput(raw: string): string {
  return raw
    .replaceAll("\u0000", "")
    .replace(/^\uFEFF/, "")
    .replace(/\r/g, "");
}

export function buildWslArgs(
  commandArgs: string[],
  distroName?: string | null,
  userName?: string | null,
): string[] {
  const args: string[] = [];
  if (distroName) {
    args.push("-d", distroName);
  }
  if (userName) {
    args.push("-u", userName);
  }

  // Bug 原因：wsl.exe 不带 --exec 时会把 `--` 之后的原始命令行整段交给用户默认 shell 以 `-c` 执行，
  // 而 Node 为含空格/引号的参数加的是双引号，外层 shell 会先展开 `"$var"`、`$(...)`，
  // 再把剩余内容交给内层 `bash -lc`。局部变量（如 Source Server tar preflight 的 `$tar_tool`）
  // 因此被提前展开成空串，远端输出 `tar=` 且退出码 0，被误判为「远端缺少 tar」。
  // --exec 让 wsl.exe 按 CommandLineToArgvW 解析 argv 后直接 exec，argv 与 Node 的引号规则互逆，
  // 命令字节原样到达 bash；登录环境仍由这里显式的 `bash -lc` 提供。
  args.push("--exec", ...commandArgs);
  return args;
}

function toWslUncCandidates(linuxPath: string, distroName: string): string[] {
  const normalizedPath = linuxPath.replaceAll("\\", "/");
  const pathSegments = normalizedPath.split("/").filter(Boolean);
  const suffix = pathSegments.length > 0 ? `\\${pathSegments.join("\\")}` : "";
  return [`\\\\wsl.localhost\\${distroName}${suffix}`, `\\\\wsl$\\${distroName}${suffix}`];
}

async function accessAnyPath(paths: string[]): Promise<string | null> {
  for (const path of paths) {
    try {
      await access(path);
      return path;
    } catch {
      // 继续尝试下一个候选路径。
    }
  }

  return null;
}

async function copyFileToAnyPath(sourcePath: string, targetPaths: string[]): Promise<boolean> {
  for (const targetPath of targetPaths) {
    try {
      await mkdir(dirname(targetPath), { recursive: true });
      await copyFile(sourcePath, targetPath);
      return true;
    } catch {
      // WSL 1 / 某些 Windows 版本可能不支持当前 UNC 前缀，继续回退。
    }
  }

  return false;
}

export class WSLBackend implements IRemoteBackend {
  readonly kind = "wsl" as const;

  private readonly options: WSLConnectOptions;
  private resolvedInfoPromise: Promise<ResolvedWSLInfo> | null = null;
  private readonly ownedChildren = new Map<
    ChildProcess,
    { closed: Promise<void>; resolveClosed: () => void }
  >();
  private disposed = false;
  private disposeInFlight: Promise<void> | null = null;

  constructor(options: WSLConnectOptions) {
    this.options = options;
  }

  async resolveIdentity(): Promise<ResolvedWSLIdentity> {
    await this.ensureAvailable();
    const resolvedInfo = await this.resolveInfo();
    if (!resolvedInfo.distroName || !resolvedInfo.userName) {
      throw new Error("无法解析 WSL 实际 distro/user 身份");
    }
    return {
      distro: resolvedInfo.distroName,
      user: resolvedInfo.userName,
    };
  }

  async detect(): Promise<RemoteEnvironment> {
    await this.ensureAvailable();
    const reportedPlatform = normalizeRemotePlatform(
      normalizeWslOutput(await this.execSimple("uname -s")),
    );
    const arch = normalizeRemoteArch(normalizeWslOutput(await this.execSimple("uname -m")));
    const kernelOstype = await this.readKernelOstype();
    const platform = resolveRemotePlatform(reportedPlatform, kernelOstype);

    return {
      platform,
      arch,
    };
  }

  async resolveRuntimeProxy(proxyUrl: string): Promise<string> {
    const normalizedProxyUrl = normalizeWslProxyUrl(proxyUrl);
    if (!normalizedProxyUrl) {
      return proxyUrl;
    }
    const parsedProxyUrl = new URL(normalizedProxyUrl);
    if (!isLoopbackProxyHostname(parsedProxyUrl.hostname)) {
      // 非 loopback 代理本来就是远端可解析地址；保留用户输入，避免无意义的 URL 规范化。
      return proxyUrl;
    }

    await this.ensureAvailable();
    const localProbe = await this.probeProxyPort(normalizedProxyUrl);
    if (localProbe === true) {
      // mirrored networking 或代理已监听 WSL loopback，不能替换成另一个地址。
      return normalizedProxyUrl;
    }

    try {
      const gateway = parseWslHostGatewayOutput(
        await this.execSimple(buildWslHostGatewayCommand()),
      );
      if (!gateway) {
        return normalizedProxyUrl;
      }
      const gatewayProxyUrl = replaceProxyHostname(normalizedProxyUrl, gateway);
      const gatewayProbe = await this.probeProxyPort(gatewayProxyUrl);
      return gatewayProbe === true ? gatewayProxyUrl : normalizedProxyUrl;
    } catch {
      // 代理解析只是运行时增强；失败时保留用户原值，让 Agent 自己返回可诊断的网络错误。
      return normalizedProxyUrl;
    }
  }

  async upload(
    localPath: string,
    remotePath: string,
    options?: RemoteUploadOptions,
  ): Promise<void> {
    await this.ensureAvailable();
    const resolvedInfo = await this.resolveInfo();
    const resolvedRemotePath = await this.resolveLinuxPath(remotePath, resolvedInfo);

    if (options?.onProgress || options?.signal) {
      await this.uploadViaExec(localPath, resolvedRemotePath, options);
      return;
    }

    if (resolvedInfo.distroName) {
      const copied = await copyFileToAnyPath(
        localPath,
        toWslUncCandidates(resolvedRemotePath, resolvedInfo.distroName),
      );
      if (copied) {
        return;
      }
    }

    // WSL 1 或默认 distro 名称解析失败时，UNC 路径可能不可用。
    // 如果这里直接报错，remote deploy 会彻底失效；回退到 `cat > file` 的流式写入，
    // 至少能保证 server/node/pty 仍可上传，只是速度慢一些。
    const parentDir = posix.dirname(resolvedRemotePath);
    const command = `mkdir -p ${quotePosixShellArg(parentDir)} && cat > ${quotePosixShellArg(resolvedRemotePath)}`;
    const stream = await this.exec(command);

    await new Promise<void>((resolve, reject) => {
      const readStream = createReadStream(localPath);
      const stdin = stream.stdin;
      let settled = false;

      const finishWithError = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        readStream.destroy();
        const destroyableStdin = stdin as NodeJS.WritableStream & {
          destroy?: (reason?: Error) => void;
        };
        if (typeof destroyableStdin.destroy === "function") {
          destroyableStdin.destroy(error);
        } else {
          stdin.end();
        }
        reject(error);
      };

      readStream.on("error", (error) => finishWithError(error));
      stdin.on("error", (error: Error) => finishWithError(error));
      readStream.pipe(stdin);
      stream.onClose((code) => {
        if (settled) {
          return;
        }
        settled = true;
        if (code !== 0) {
          reject(new Error(`WSL upload failed with exit code ${code}`));
          return;
        }
        resolve();
      });
    });
  }

  private async uploadViaExec(
    localPath: string,
    resolvedRemotePath: string,
    options: RemoteUploadOptions,
  ): Promise<void> {
    const totalBytes = await stat(localPath).then((value) => value.size);
    if (options.signal?.aborted) {
      const error = new Error("Remote upload canceled");
      error.name = "AbortError";
      throw error;
    }
    const parentDir = posix.dirname(resolvedRemotePath);
    const command = `mkdir -p ${quotePosixShellArg(parentDir)} && cat > ${quotePosixShellArg(resolvedRemotePath)}`;
    const stream = await this.exec(command);
    await new Promise<void>((resolve, reject) => {
      const readStream = createReadStream(localPath);
      const stdin = stream.stdin;
      let uploadedBytes = 0;
      let settled = false;
      const finishError = (error: Error) => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener("abort", abort);
        readStream.destroy();
        const destroyable = stdin as NodeJS.WritableStream & {
          destroy?: (reason?: Error) => void;
        };
        destroyable.destroy?.(error);
        reject(error);
      };
      const abort = () => {
        const error = new Error("Remote upload canceled");
        error.name = "AbortError";
        finishError(error);
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      readStream.on("data", (chunk: Buffer) => {
        uploadedBytes += chunk.length;
        options.onProgress?.({ uploadedBytes, totalBytes });
      });
      readStream.on("error", finishError);
      stdin.on("error", finishError);
      stream.onClose((code) => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener("abort", abort);
        if (code !== 0) {
          reject(new Error(`WSL upload failed with exit code ${code}`));
          return;
        }
        options.onProgress?.({ uploadedBytes: totalBytes, totalBytes });
        resolve();
      });
      readStream.pipe(stdin);
    });
  }

  async exec(command: string): Promise<StdioStream> {
    this.assertNotDisposed();
    await this.ensureAvailable();
    const resolvedInfo = await this.resolveInfo();
    // 入口门禁之后的 discovery/identity await 允许 dispose barrier 插入并完成；
    // resolved info 命中缓存时，旧 continuation 会在 barrier 后继续 spawn。最终创建 child 前必须再校验。
    this.assertNotDisposed();

    return new Promise((resolve, reject) => {
      const child = spawn(
        WSL_COMMAND,
        buildWslArgs(["bash", "-lc", command], resolvedInfo.distroName, resolvedInfo.userName),
        {
          stdio: "pipe",
          windowsHide: true,
        },
      );
      this.trackOwnedChild(child);

      child.once("error", reject);
      child.once("spawn", () => {
        const stdin = child.stdin;
        const stdout = child.stdout;
        const stderr = child.stderr;
        if (!stdin || !stdout || !stderr) {
          reject(new Error("WSL process stdio is not available"));
          return;
        }

        const onClose = createCloseEventController();
        let fired = false;
        const fireOnce = (code: number) => {
          if (fired) {
            return;
          }
          fired = true;
          onClose.fire(code);
        };

        child.on("exit", (code) => {
          fireOnce(code ?? 0);
        });
        child.on("close", (code) => {
          fireOnce(code ?? 0);
        });

        resolve({
          stdin,
          stdout,
          stderr,
          onClose: onClose.event,
        });
      });
    });
  }

  async exists(remotePath: string): Promise<boolean> {
    await this.ensureAvailable();
    const resolvedInfo = await this.resolveInfo();
    const resolvedRemotePath = await this.resolveLinuxPath(remotePath, resolvedInfo);

    if (resolvedInfo.distroName) {
      const accessiblePath = await accessAnyPath(
        toWslUncCandidates(resolvedRemotePath, resolvedInfo.distroName),
      );
      if (accessiblePath) {
        return true;
      }
    }

    try {
      await this.execSimple(`test -f ${quotePosixShellArg(resolvedRemotePath)} && printf OK`);
      return true;
    } catch {
      return false;
    }
  }

  async readFile(remotePath: string): Promise<string> {
    await this.ensureAvailable();
    const resolvedInfo = await this.resolveInfo();
    const resolvedRemotePath = await this.resolveLinuxPath(remotePath, resolvedInfo);

    if (resolvedInfo.distroName) {
      const accessiblePath = await accessAnyPath(
        toWslUncCandidates(resolvedRemotePath, resolvedInfo.distroName),
      );
      if (accessiblePath) {
        return readFile(accessiblePath, "utf8");
      }
    }

    return normalizeWslOutput(
      await this.execSimple(`cat ${quotePosixShellArg(resolvedRemotePath)}`),
    );
  }

  dispose(): void {
    void this.disposeAndWait();
  }

  disposeAndWait(options?: { graceTimeoutMs?: number; killWaitTimeoutMs?: number }): Promise<void> {
    if (this.disposeInFlight) {
      return this.disposeInFlight;
    }
    this.disposed = true;

    const graceTimeoutMs = Math.max(options?.graceTimeoutMs ?? 300, 0);
    const killWaitTimeoutMs = Math.max(options?.killWaitTimeoutMs ?? 250, 0);
    const children = Array.from(this.ownedChildren.entries());
    // WSL 过去不记录自己 spawn 的 wsl.exe，Host 被强杀时只能寄希望于管道 EOF。
    // 先同步关闭本 backend 子进程 stdin；宽限期后也只 kill 这些已证明归属的 child，绝不 terminate distro。
    for (const [child] of children) {
      this.endOwnedChildInput(child);
    }
    this.disposeInFlight = Promise.all(
      children.map(async ([child, state]) => {
        if (await this.waitForOwnedChildClose(state.closed, graceTimeoutMs)) {
          return;
        }
        if (this.ownedChildren.has(child)) {
          child.kill();
        }
        await this.waitForOwnedChildClose(state.closed, killWaitTimeoutMs);
      }),
    ).then(() => undefined);
    return this.disposeInFlight;
  }

  private trackOwnedChild(child: ChildProcess): void {
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const finish = () => {
      const state = this.ownedChildren.get(child);
      if (!state) {
        return;
      }
      this.ownedChildren.delete(child);
      state.resolveClosed();
    };
    this.ownedChildren.set(child, { closed, resolveClosed });
    child.once("error", finish);
    child.once("exit", finish);
    child.once("close", finish);
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error("WSL backend 已释放，无法启动新命令");
    }
  }

  private endOwnedChildInput(child: ChildProcess): void {
    if (!child.stdin || child.stdin.writableEnded) {
      return;
    }
    try {
      child.stdin.end();
    } catch {
      // stdin 已异常关闭时继续进入本 child 的 kill fallback。
    }
  }

  private async waitForOwnedChildClose(closed: Promise<void>, timeoutMs: number): Promise<boolean> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      closed.then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    if (timeout) {
      clearTimeout(timeout);
    }
    return result;
  }

  private async ensureAvailable(): Promise<void> {
    if (process.platform !== "win32") {
      throw new Error("WSL 连接仅支持在 Windows 上使用");
    }

    const available = await isWSLAvailable((args) => this.execWslForBuffer(args));
    if (!available) {
      throw new Error("当前系统未检测到可用的 WSL 环境");
    }
  }

  private async resolveInfo(): Promise<ResolvedWSLInfo> {
    if (this.resolvedInfoPromise) {
      return this.resolvedInfoPromise;
    }

    this.resolvedInfoPromise = (async () => {
      const distros = await this.safeListDistros();
      const selected = this.pickDistro(distros);
      const launchDistroName = selected?.name ?? this.options.distro?.trim() ?? null;
      const requestedUserName = this.options.user?.trim() || null;
      const identityOutput = normalizeWslOutput(
        await this.execDirect(
          ["bash", "-lc", `printf '%s\\n' "$WSL_DISTRO_NAME"; id -un; printf %s "$HOME"`],
          launchDistroName,
          requestedUserName,
        ),
      );
      const [reportedDistroName = "", actualUserName = "", ...homeLines] =
        identityOutput.split("\n");
      const distroName = reportedDistroName.trim() || launchDistroName;
      const userName = actualUserName.trim() || requestedUserName;
      const homeDir = homeLines.join("\n").trim();
      if (!homeDir) {
        throw new Error("无法解析 WSL 用户 HOME");
      }

      return {
        distroName,
        userName,
        version: selected?.version ?? null,
        homeDir,
      };
    })();

    return this.resolvedInfoPromise;
  }

  private async safeListDistros(): Promise<WSLDistro[]> {
    try {
      return await listWSLDistros((args) => this.execWslForBuffer(args));
    } catch {
      return [];
    }
  }

  private pickDistro(distros: WSLDistro[]): WSLDistro | null {
    const requestedDistro = this.options.distro?.trim();
    if (requestedDistro) {
      if (distros.length === 0) {
        return null;
      }

      const matched = distros.find(
        (distro) =>
          distro.name.localeCompare(requestedDistro, undefined, { sensitivity: "base" }) === 0,
      );
      if (!matched) {
        throw new Error(`未找到名为 ${this.options.distro} 的 WSL distro`);
      }

      return matched;
    }

    return distros.find((distro) => distro.isDefault) ?? distros[0] ?? null;
  }

  private async resolveLinuxPath(
    remotePath: string,
    resolvedInfo: ResolvedWSLInfo,
  ): Promise<string> {
    if (remotePath === "~") {
      return resolvedInfo.homeDir;
    }

    if (remotePath.startsWith("~/")) {
      return posix.join(resolvedInfo.homeDir, remotePath.slice(2));
    }

    return remotePath;
  }

  private async execSimple(command: string): Promise<string> {
    const resolvedInfo = await this.resolveInfo();
    return this.execDirect(
      ["bash", "-lc", command],
      resolvedInfo.distroName,
      resolvedInfo.userName,
    );
  }

  private async probeProxyPort(proxyUrl: string): Promise<boolean | undefined> {
    const command = buildWslProxyPortProbeCommand(proxyUrl);
    if (!command) {
      return undefined;
    }
    try {
      return parseWslProxyPortProbeOutput(await this.execSimple(command));
    } catch {
      return undefined;
    }
  }

  private async readKernelOstype(): Promise<string> {
    try {
      return normalizeWslOutput(
        await this.execSimple(
          "if [ -r /proc/sys/kernel/ostype ]; then cat /proc/sys/kernel/ostype; fi",
        ),
      ).trim();
    } catch {
      return "";
    }
  }

  private async execDirect(
    commandArgs: string[],
    distroName?: string | null,
    userName?: string | null,
  ): Promise<string> {
    const stdout = await this.execWslForBuffer(buildWslArgs(commandArgs, distroName, userName));
    return normalizeWslOutput(decodeWslOutput(stdout));
  }

  private async execWslForBuffer(args: string[]): Promise<Buffer> {
    this.assertNotDisposed();
    return new Promise((resolve, reject) => {
      const child = execFile(
        WSL_COMMAND,
        args,
        {
          encoding: "buffer",
          maxBuffer: WSL_EXEC_MAX_BUFFER,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const stdoutBuffer = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? "");
          const stderrBuffer = Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? "");
          const stderrText = normalizeWslOutput(decodeWslOutput(stderrBuffer)).trim();

          if (error) {
            reject(new Error(stderrText || error.message));
            return;
          }

          resolve(stdoutBuffer);
        },
      );
      this.trackOwnedChild(child);
    });
  }
}
