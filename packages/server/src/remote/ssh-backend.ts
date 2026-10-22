/* eslint-disable max-lines -- SSH backend 集中维护连接、exec、SFTP 上传和 fallback 进度链路；集中维护以避免拆分引入远端连接回归。 */
import { Client as SSHClient } from "ssh2";
import type { ConnectConfig } from "ssh2";
import { createReadStream } from "node:fs";
import type { Duplex } from "node:stream";
import { posix } from "node:path";
import { Emitter } from "@zcode/rpc";
import { resolveZCodeRuntimeEnv } from "@zcode/shared";
import type {
  IRemoteBackend,
  RemoteDisconnectEvent,
  RemoteDisconnectReason,
  RemoteEnvironment,
  RemoteUploadOptions,
  StdioStream,
} from "@zcode/server/remote/backend.js";
import {
  normalizeRemoteArch,
  normalizeRemotePlatform,
  resolveRemotePlatform,
} from "@zcode/server/remote/detectEnv.js";
import { createCloseEventController } from "@zcode/server/remote/closeEvent.js";
import {
  buildPosixShellExecCommand,
  quotePosixShellArg,
  resolvePosixHomePath,
} from "@zcode/server/remote/posixShell.js";
import {
  buildSSHConnectConfig,
  createKeyboardInteractiveResponder,
  normalizeSSHConnectError,
} from "@zcode/server/remote/sshAuth.js";
import {
  createSSHUploadProgressReporter,
  formatSSHUploadError,
  formatSSHUploadLabel,
  readLocalFileSize,
} from "@zcode/server/remote/sshUploadProgress.js";

export interface SSHBackendOptions {
  host: string;
  port?: number;
  username: string;
  privateKeyPath?: string;
  privateKey?: string | Buffer;
  privateKeyPassphrase?: string;
  password?: string;
  agent?: string;
}

type SSHUploadFailureKind = "sftp-session" | "sftp-write" | "local-read" | "aborted";

type SSHUploadFailure = Error & {
  uploadFailureKind?: SSHUploadFailureKind;
};

function normalizeUnknownError(error: unknown, fallbackMessage: string): Error {
  if (error instanceof Error) {
    return error;
  }

  if (typeof error === "string" && error.length > 0) {
    return new Error(error);
  }

  return new Error(fallbackMessage);
}

function markSSHUploadFailure(
  error: unknown,
  kind: SSHUploadFailureKind,
  fallbackMessage: string,
): SSHUploadFailure {
  const normalizedError = normalizeUnknownError(error, fallbackMessage) as SSHUploadFailure;
  normalizedError.uploadFailureKind = kind;
  return normalizedError;
}

function shouldLogSSHDebugMessage(message: string): boolean {
  return !/\bCHANNEL_(?:DATA|EXTENDED_DATA|WINDOW_ADJUST)\b/u.test(message);
}

function createUploadAbortError(): Error {
  const error = new Error("Remote upload canceled");
  error.name = "AbortError";
  return error;
}

function throwIfUploadAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createUploadAbortError();
}

export class SSHBackend implements IRemoteBackend {
  private client: SSHClient;
  private connected = false;
  private readonly config: ConnectConfig;
  private homeDirPromise: Promise<string> | null = null;
  private execUploadOnly = false;
  private disposed = false;
  private hasEverConnected = false;
  private disconnectReported = false;
  private readonly disconnectEmitter = new Emitter<RemoteDisconnectEvent>();
  readonly onDidDisconnect = this.disconnectEmitter.event;

  private readonly onClientError = (error: unknown): void => {
    if (this.disposed) {
      // ssh2 在 ready timeout 后销毁 socket 时，close/end 阶段可能再次发出 error。
      // dispose 期间保留监听器只为吸收这类迟到事件，不能再向上层重复报告或触发未捕获异常。
      return;
    }
    const normalizedError = normalizeSSHConnectError(error);
    // ready 之后如果底层连接抖动，ssh2 仍会发出 "error" 事件。
    // 若没有常驻监听，Node 会把它当成未捕获异常直接抛出，可能导致 host 进程崩溃。
    // 这里先记录错误详情再上报断连；上层收到断连后会退出 host，反过来会丢掉真实 error 文案。
    console.error("[ssh] client error:", normalizedError);
    this.reportDisconnect("error", normalizedError);
  };

  private readonly onClientClose = (): void => {
    this.reportDisconnect("close");
  };

  private readonly onClientEnd = (): void => {
    this.reportDisconnect("end");
  };

  constructor(options: SSHBackendOptions) {
    this.client = new SSHClient();
    this.client.on("error", this.onClientError);
    this.client.on("close", this.onClientClose);
    this.client.on("end", this.onClientEnd);
    this.config = buildSSHConnectConfig({
      host: options.host,
      port: options.port,
      username: options.username,
      privateKey: options.privateKey,
      passphrase: options.privateKeyPassphrase,
      password: options.password,
      agent: options.agent,
    });
    if (resolveZCodeRuntimeEnv(process.env) === "development") {
      this.config.debug = (message: string) => {
        // SSH ready 超时只暴露 client-timeout 时无法判断卡在 TCP、协商还是认证。
        // 仅开发环境输出 ssh2 握手细节；CHANNEL_DATA / EXTENDED_DATA 是命令 stdout/stderr 数据包，
        // 下载阶段会按 chunk 高频刷屏，过滤掉它们，避免连接窗口和 electron 日志被底层传输事件淹没。
        if (!shouldLogSSHDebugMessage(message)) {
          return;
        }
        console.debug(`[ssh2] ${message}`);
      };
    }
    if (typeof options.password === "string" && options.password.length > 0) {
      // `ssh2` 类型定义遗漏了 keyboard-interactive 事件，但运行时确实支持。
      // 这里局部转成 EventEmitter 接口，避免为了一个事件把整段代码降级到 any。
      (
        this.client as unknown as {
          on(event: string, listener: (...args: unknown[]) => void): void;
        }
      ).on(
        "keyboard-interactive",
        createKeyboardInteractiveResponder(options.password) as unknown as (
          ...args: unknown[]
        ) => void,
      );
    }
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error("SSH backend 已释放，无法重新建立连接");
    }
  }

  private async ensureConnected(): Promise<void> {
    // 连接取消会先释放 backend，但迟到的 deploy/cleanup continuation 仍可能
    // 调用 ensureConnected。ssh2 Client 支持 end 后再次 connect，必须在 backend 边界阻止旧凭据复活。
    this.assertNotDisposed();
    if (this.connected) return;
    return new Promise((resolve, reject) => {
      const handleReady = () => {
        this.client.off("error", handleConnectError);
        if (this.disposed) {
          // dispose 与 ssh2 ready 可能交错；迟到的 ready 若重新标记 connected，
          // 后续 detect 会继续使用已取消连接的旧凭据。再次关闭 socket，并让原调用失败。
          this.client.end();
          reject(new Error("SSH backend 已释放，无法重新建立连接"));
          return;
        }
        this.connected = true;
        this.hasEverConnected = true;
        this.disconnectReported = false;
        resolve();
      };
      const handleConnectError = (error: unknown) => {
        this.client.off("ready", handleReady);
        reject(normalizeSSHConnectError(error));
      };
      this.client.once("ready", handleReady);
      this.client.once("error", handleConnectError);
      this.client.connect(this.config);
    });
  }

  private reportDisconnect(reason: RemoteDisconnectReason, error?: Error): void {
    const shouldReport =
      !this.disposed && !this.disconnectReported && (this.connected || this.hasEverConnected);

    this.connected = false;
    this.homeDirPromise = null;

    if (!shouldReport) {
      return;
    }

    this.disconnectReported = true;
    this.disconnectEmitter.fire(error ? { reason, error } : { reason });
  }

  async detect(): Promise<RemoteEnvironment> {
    await this.ensureConnected();
    // Bug 原因：冷启动曾为 platform、arch、kernel ostype 串行创建三个 SSH exec channel，
    // 仅环境探测就占掉大部分 10 秒恢复预算。保持一个 POSIX channel 可同时避免首次多 channel 竞态。
    const output = await this.execSimple(
      "printf 'platform='; uname -s; printf 'arch='; uname -m; printf 'kernel='; " +
        "if [ -r /proc/sys/kernel/ostype ]; then cat /proc/sys/kernel/ostype; else printf '\\n'; fi",
    );
    const readField = (name: string): string =>
      output
        .split(/\r?\n/u)
        .find((line) => line.startsWith(`${name}=`))
        ?.slice(name.length + 1)
        .trim() ?? "";
    const reportedPlatform = normalizeRemotePlatform(readField("platform"));
    const arch = normalizeRemoteArch(readField("arch"));
    const kernelOstype = readField("kernel");
    const platform = resolveRemotePlatform(reportedPlatform, kernelOstype);

    if (platform !== reportedPlatform) {
      console.warn(
        `[ssh] detect: uname reported ${reportedPlatform}, but kernel ostype is ${kernelOstype}; fallback to ${platform}`,
      );
    }

    return { platform, arch };
  }

  async upload(
    localPath: string,
    remotePath: string,
    options?: RemoteUploadOptions,
  ): Promise<void> {
    throwIfUploadAborted(options?.signal);
    await this.ensureConnected();
    this.assertNotDisposed();
    const resolved = await this.resolveRemotePath(remotePath);
    throwIfUploadAborted(options?.signal);
    this.assertNotDisposed();
    const uploadLabel = formatSSHUploadLabel(resolved);
    console.log(`[ssh] upload: resolved ${uploadLabel} to ${resolved}`);
    const dir = posix.dirname(resolved);
    await this.execSimple(`mkdir -p ${quotePosixShellArg(dir)}`);

    if (this.execUploadOnly) {
      // exec-only 只缓存传输能力，不能丢掉每次上传独立的取消信号与进度回调；
      // 否则首次 SFTP 降级后的后续资源会脱离连接取消流程，并让 UI 停止更新进度。
      await this.uploadViaExec(localPath, resolved, options);
      return;
    }

    try {
      await this.uploadViaSftp(localPath, resolved, options);
    } catch (error) {
      if (!this.shouldFallbackToExecUpload(error)) {
        throw error;
      }

      // 某些网关 / 跳板 SSH 会把 exec 与 SFTP 落到不同的文件系统视图。
      // 这类场景下，前面的 `mkdir -p` 已经证明 shell 视图可写，但 SFTP 往同一路径写文件仍会报 NO_SUCH_FILE。
      // 这里回退到 `cat > file`，强制复用已验证可用的 shell 通道，避免把“网关不支持 SFTP 直写”误判成连接失败。
      // 同一个 backend 后续继续试 SFTP 只会重复失败并刷日志，因此在首次能力失败后记住 exec-only 状态；
      // 新连接会创建新的 backend，自然会重新探测 SFTP 能力。
      this.execUploadOnly = true;
      console.warn(
        `[ssh] upload: switching ${uploadLabel} from sftp to exec pipe after ${this.describeUploadFailure(error)}`,
      );
      await this.uploadViaExec(localPath, resolved, options);
    }
  }

  async exec(command: string): Promise<StdioStream> {
    await this.ensureConnected();
    // ensureConnected 的 await 与真正创建 channel 之间允许取消屏障插入，必须再次校验。
    this.assertNotDisposed();
    return new Promise((resolve, reject) => {
      // SSH exec 会先交给远端用户的默认 shell；fish 会把部署脚本里的 `download=` 等 POSIX 语法当成错误。
      // 在 SSH 边界统一进入 /bin/sh，保证 remote deploy、preflight 和 server 启动脚本都按项目声明的 POSIX shell 语义执行。
      this.client.exec(buildPosixShellExecCommand(command), (err, channel) => {
        if (err) return reject(err);

        const onClose = createCloseEventController();
        let fired = false;
        const fireOnce = (code: number) => {
          if (fired) return;
          fired = true;
          // remote deploy 会执行大量短命令，成功退出的 code=0 日志没有排查价值且会刷屏。
          // 这里只保留失败退出码，正常流程由上层的阶段日志和进度日志表达。
          if (code !== 0) {
            console.warn(`[ssh] exec channel failed: code=${code}`);
          }
          onClose.fire(code ?? 0);
        };

        // ssh2 channels may fire 'exit' before 'close', or sometimes
        // only one of them. Listen to both to be safe.
        channel.on("exit", (code: number | null) => {
          fireOnce(code ?? 0);
        });
        channel.on("close", () => {
          fireOnce(0);
        });

        resolve({
          stdin: channel.stdin,
          stdout: channel,
          stderr: channel.stderr,
          onClose: onClose.event,
        });
      });
    });
  }

  async openDirectTcpChannel(port: number): Promise<Duplex> {
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
      throw new Error(`Invalid remote TCP port: ${port}`);
    }
    await this.ensureConnected();
    return await new Promise<Duplex>((resolve, reject) => {
      this.client.forwardOut("127.0.0.1", 0, "127.0.0.1", port, (error, channel) => {
        if (error) reject(error);
        else resolve(channel);
      });
    });
  }

  async exists(remotePath: string): Promise<boolean> {
    try {
      const resolvedRemotePath = await this.resolveRemotePath(remotePath);
      const result = await this.execSimple(
        `test -f ${quotePosixShellArg(resolvedRemotePath)} && printf OK`,
      );
      return result.trim() === "OK";
    } catch {
      return false;
    }
  }

  async readFile(remotePath: string): Promise<string> {
    const resolvedRemotePath = await this.resolveRemotePath(remotePath);
    return this.execSimple(`cat ${quotePosixShellArg(resolvedRemotePath)}`);
  }

  /** Execute a simple command and return stdout as string */
  private execSimple(command: string): Promise<string> {
    this.assertNotDisposed();
    return new Promise((resolve, reject) => {
      // execSimple 同样会执行 POSIX 片段（例如 `[ -r ... ]`、变量展开）。
      // 这里和 exec 保持同一层 shell 策略，避免 detect/exists/readFile 在 fish 默认 shell 下先于部署失败。
      this.client.exec(buildPosixShellExecCommand(command), (err, channel) => {
        if (err) return reject(err);
        let stdout = "";
        let stderr = "";
        let done = false;
        let exitCode: number | null = null;

        channel.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        channel.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });

        const finish = (code: number) => {
          if (done) return;
          done = true;
          if (code !== 0) {
            reject(new Error(`Command failed (code ${code}): ${stderr || stdout}`));
          } else {
            resolve(stdout);
          }
        };

        // ssh2 在短命令场景下可能先发 exit，再异步派发 stdout data。
        // 不能在 exit 事件直接 finish：会把后续 data 丢掉，导致 platform/arch 偶发识别为空。
        // 这里改为只在 close 统一收尾，并优先使用 exit 记录的真实退出码，避免误判成功。
        channel.on("exit", (code: number | null) => {
          exitCode = code ?? 0;
        });
        channel.on("close", (code: number | null) => {
          const resolvedCode = exitCode ?? code ?? 0;
          finish(resolvedCode);
        });
      });
    });
  }

  private async resolveHomeDir(): Promise<string> {
    if (this.homeDirPromise) {
      return this.homeDirPromise;
    }

    this.homeDirPromise = this.execSimple('printf %s "$HOME"').then((homeDir) => homeDir.trim());
    return this.homeDirPromise;
  }

  private shouldFallbackToExecUpload(error: unknown): boolean {
    const uploadFailureKind = (error as SSHUploadFailure | undefined)?.uploadFailureKind;
    return uploadFailureKind === "sftp-session" || uploadFailureKind === "sftp-write";
  }

  private describeUploadFailure(error: unknown): string {
    const uploadFailureKind = (error as SSHUploadFailure | undefined)?.uploadFailureKind;
    const errorLabel = formatSSHUploadError(error);
    return uploadFailureKind ? `${uploadFailureKind} failure (${errorLabel})` : errorLabel;
  }

  private async uploadViaSftp(
    localPath: string,
    resolvedRemotePath: string,
    options?: RemoteUploadOptions,
  ): Promise<void> {
    throwIfUploadAborted(options?.signal);
    this.assertNotDisposed();
    const uploadLabel = formatSSHUploadLabel(resolvedRemotePath);
    const totalBytes = await readLocalFileSize(localPath);
    const progressReporter = createSSHUploadProgressReporter("sftp", uploadLabel, totalBytes);
    const reportProgress = (uploadedBytes: number, force: boolean) => {
      progressReporter(uploadedBytes, force);
      options?.onProgress?.({ uploadedBytes, totalBytes: totalBytes ?? 0 });
    };

    return new Promise((resolve, reject) => {
      this.client.sftp((err, sftp) => {
        if (err) {
          // session/write 失败会由 upload() 统一降级并记录一次 warn；这里若先记 error，
          // 同一个可恢复事件会同时出现 error + warn，误导为部署失败。
          reject(markSSHUploadFailure(err, "sftp-session", "Failed to open SFTP session"));
          return;
        }
        console.log(
          `[ssh] upload: started via sftp for ${uploadLabel} (${localPath} -> ${resolvedRemotePath})`,
        );

        const readStream = createReadStream(localPath);
        const writeStream = sftp.createWriteStream(resolvedRemotePath);
        let transferredBytes = 0;
        let settled = false;
        let suppressFollowupStreamErrors = false;

        const resolveOnce = () => {
          if (settled) {
            return;
          }
          settled = true;
          options?.signal?.removeEventListener("abort", abortOnce);
          reportProgress(transferredBytes, true);
          console.log(`[ssh] upload: completed via sftp for ${uploadLabel}`);
          sftp.end();
          resolve();
        };

        const rejectOnce = (error: unknown, kind: SSHUploadFailureKind, message: string) => {
          if (settled) {
            return;
          }
          settled = true;
          options?.signal?.removeEventListener("abort", abortOnce);
          suppressFollowupStreamErrors = true;
          // SFTP 失败后如果不立刻停掉本地 read stream，它仍会继续把文件读到 100%，
          // UI 就会在已经切到 exec pipe 之后还刷出一串虚假的 `[sftp] upload progress`。
          // 这里在失败瞬间主动停掉两端 stream，保证第一种上传方式的进度日志立即停止。
          // 注意不要把原始 error 再次喂给 destroy，否则清理路径本身会再冒出一轮重复 error 日志。
          readStream.unpipe(writeStream);
          readStream.destroy();
          const destroyableWriteStream = writeStream as NodeJS.WritableStream & {
            destroy?: (error?: Error) => void;
          };
          if (typeof destroyableWriteStream.destroy === "function") {
            destroyableWriteStream.destroy();
          }
          sftp.end();
          reject(markSSHUploadFailure(error, kind, message));
        };

        const abortOnce = () => {
          rejectOnce(createUploadAbortError(), "aborted", "Remote upload canceled");
        };
        if (options?.signal?.aborted) {
          abortOnce();
          return;
        }
        options?.signal?.addEventListener("abort", abortOnce, { once: true });

        readStream.on("data", (chunk: Buffer) => {
          if (settled) {
            return;
          }
          transferredBytes += chunk.length;
          reportProgress(transferredBytes, false);
        });
        writeStream.on("close", resolveOnce);
        writeStream.on("error", (error: Error) => {
          if (settled || suppressFollowupStreamErrors) {
            return;
          }
          rejectOnce(error, "sftp-write", `Failed to write ${resolvedRemotePath} over SFTP`);
        });
        readStream.on("error", (error: Error) => {
          if (settled || suppressFollowupStreamErrors) {
            return;
          }
          console.error(
            `[ssh] upload: local read failed for ${uploadLabel}: ${formatSSHUploadError(error)}`,
          );
          rejectOnce(error, "local-read", `Failed to read local file ${localPath}`);
        });
        readStream.pipe(writeStream);
      });
    });
  }

  private async uploadViaExec(
    localPath: string,
    resolvedRemotePath: string,
    options?: RemoteUploadOptions,
  ): Promise<void> {
    const uploadLabel = formatSSHUploadLabel(resolvedRemotePath);
    const totalBytes = await readLocalFileSize(localPath);
    const progressReporter = createSSHUploadProgressReporter("exec", uploadLabel, totalBytes);
    const reportProgress = (uploadedBytes: number, force: boolean) => {
      progressReporter(uploadedBytes, force);
      options?.onProgress?.({ uploadedBytes, totalBytes: totalBytes ?? 0 });
    };
    throwIfUploadAborted(options?.signal);
    const parentDir = posix.dirname(resolvedRemotePath);
    const command = `mkdir -p ${quotePosixShellArg(parentDir)} && cat > ${quotePosixShellArg(resolvedRemotePath)}`;
    console.log(
      `[ssh] upload: started via exec pipe for ${uploadLabel} (${localPath} -> ${resolvedRemotePath})`,
    );
    const stream = await this.exec(command);

    await new Promise<void>((resolve, reject) => {
      const readStream = createReadStream(localPath);
      const stdin = stream.stdin;
      let transferredBytes = 0;
      let settled = false;

      const finishWithError = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        options?.signal?.removeEventListener("abort", abortOnce);
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

      const abortOnce = () => finishWithError(createUploadAbortError());
      if (options?.signal?.aborted) {
        abortOnce();
        return;
      }
      options?.signal?.addEventListener("abort", abortOnce, { once: true });

      readStream.on("error", (error) => finishWithError(error));
      readStream.on("data", (chunk: Buffer) => {
        transferredBytes += chunk.length;
        reportProgress(transferredBytes, false);
      });
      stdin.on("error", (error: Error) => finishWithError(error));
      readStream.pipe(stdin);
      stream.onClose((code) => {
        if (settled) {
          return;
        }
        settled = true;
        options?.signal?.removeEventListener("abort", abortOnce);
        reportProgress(transferredBytes, true);
        if (code !== 0) {
          console.error(`[ssh] upload: exec pipe failed for ${uploadLabel}: exit code ${code}`);
          reject(new Error(`SSH exec upload failed with exit code ${code}`));
          return;
        }
        console.log(`[ssh] upload: completed via exec pipe for ${uploadLabel}`);
        resolve();
      });
    });
  }

  private async resolveRemotePath(remotePath: string): Promise<string> {
    const homeDir = await this.resolveHomeDir();
    return resolvePosixHomePath(remotePath, homeDir);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    // 首次握手失败后，ssh2 可能在 socket end/close 之后继续发出 error。
    // dispose 后保留 onClientError 作为 no-op sink，不能按 end/close 事件时序提前移除，
    // 否则迟到事件会逃逸为 uncaughtException，让共享 Window Host 连带退出其它 workspace。
    // client 只由当前 backend 持有，监听器会随 client 一起回收；此处优先保证退役阶段不崩溃。
    this.client.off("close", this.onClientClose);
    this.client.off("end", this.onClientEnd);
    this.client.end();
    this.connected = false;
    this.disconnectEmitter.dispose();
  }
}
