import { subscribeBashOutputProgress } from "./bash-progress-poller.js";
import { buildBashOutputPreview } from "./bash-output-preview.js";
import { constants } from "node:fs";
import { lstat, mkdir, open, rm, stat, statfs, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { decodeExecutionOutputBuffer } from "./outputEncoding.js";
import type { ExecutionStreamResult, ExecutionOutputPreview } from "@zcode/contracts";

const OUTPUT_WATCH_INTERVAL_MS = 5_000;
const OUTPUT_FILE_MODE = 0o600;
const PROGRESS_TAIL_MAX_BYTES = 4096;

/** Bash 只持有文件身份和观察器；原始输出由子进程写入，不经过 Node collector。 */
export class BashFileOutput {
  private handle?: FileHandle;
  private created = false;
  private prepared = false;
  private watchTimer?: NodeJS.Timeout;
  private unsubscribeProgress?: () => void;
  private progressDelay?: NodeJS.Timeout;

  constructor(
    readonly path: string,
    private readonly platform: NodeJS.Platform,
    private readonly legacyEncoding: string | null,
  ) {}

  get fd(): number | undefined {
    return this.handle?.fd;
  }

  async prepare(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const existing = await lstat(this.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    // Windows 的 append-only 句柄被 MSYS 判为只读；Windows 必须用 w。

    const flags =
      this.platform === "win32"
        ? "w"
        : constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0);
    this.handle = await open(this.path, flags, OUTPUT_FILE_MODE);
    this.created = existing === undefined;
    this.prepared = true;
  }

  async close(): Promise<void> {
    const handle = this.handle;
    this.handle = undefined;
    // fd 清理失败不能覆盖取消/退出结果，也不能阻止 adapter 释放其它生命周期资源。
    await handle?.close().catch(() => undefined);
  }

  async discard(): Promise<void> {
    await this.close();
    if (this.created) {
      // 清理失败不能覆盖取消/spawn 的真实结果，也不能删除原有文件。
      await rm(this.path, { force: true }).catch(() => undefined);
    }
    this.prepared = false;
  }

  watchLimit(maxBytes: number, onLimit: () => void): void {
    this.stopWatching();
    let checking = false;
    const timer = setInterval(() => {
      if (checking) return;
      checking = true;
      void stat(this.path)
        .then(
          (file) => {
            // stat 可以在 exit 或后台移交之后才返回；旧观察器不能终止新状态。
            if (this.watchTimer !== timer || file.size <= maxBytes) return;
            this.stopWatching();
            onLimit();
          },
          () => undefined,
        )
        .finally(() => {
          checking = false;
        });
    }, OUTPUT_WATCH_INTERVAL_MS);
    timer.unref();
    this.watchTimer = timer;
  }

  stopWatching(): void {
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.unsubscribeProgress?.();
    if (this.progressDelay) clearTimeout(this.progressDelay);
    this.watchTimer = undefined;
    this.unsubscribeProgress = undefined;
    this.progressDelay = undefined;
  }

  watchProgress(
    maxBytes: number,
    delayMs: number,
    intervalMs: number,
    onRead: (output: ExecutionStreamResult, preview: ExecutionOutputPreview) => void,
  ): void {
    this.unsubscribeProgress?.();
    this.unsubscribeProgress = undefined;
    if (this.progressDelay) clearTimeout(this.progressDelay);
    this.progressDelay = setTimeout(() => {
      this.progressDelay = undefined;
      let previousLines = 0;
      this.unsubscribeProgress = subscribeBashOutputProgress(intervalMs, async (isActive) => {
        const output = await readBashOutput(
          this.path,
          Math.min(maxBytes, PROGRESS_TAIL_MAX_BYTES),
          true,
          this.legacyEncoding,
        );
        // 共享 interval 仍在服务其他任务；取消/重订阅后必须丢弃本订阅迟到的读取。
        if (!isActive()) return;
        const preview = buildBashOutputPreview(
          output.text,
          output.bytesRead,
          output.bytes,
          previousLines,
        );
        previousLines = preview.totalLines;
        onRead(output, preview);
      });
    }, delayMs);
    this.progressDelay.unref();
  }

  async result(maxBytes: number): Promise<ExecutionStreamResult> {
    if (!this.prepared) return { text: "", bytes: 0, truncated: false };
    try {
      const { bytesRead: _bytesRead, ...result } = await readBashOutput(
        this.path,
        maxBytes,
        false,
        this.legacyEncoding,
      );
      return result;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
      return {
        text: `<bash output unavailable: output file ${this.path} could not be read (${code}).>`,
        bytes: 0,
        truncated: false,
      };
    }
  }
}

export async function readBashOutput(
  path: string,
  maxBytes: number,
  tail: boolean,
  legacyEncoding: string | null,
): Promise<ExecutionStreamResult & { bytesRead: number }> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, Math.max(0, maxBytes));
    const offset = tail ? size - length : 0;
    const buffer = Buffer.allocUnsafe(length);
    let bytesRead = 0;
    while (bytesRead < length) {
      const read = await handle.read(buffer, bytesRead, length - bytesRead, offset + bytesRead);
      if (read.bytesRead === 0) break;
      bytesRead += read.bytesRead;
    }
    return {
      text: decodeExecutionOutputBuffer(buffer.subarray(0, bytesRead), legacyEncoding),
      bytes: size,
      bytesRead,
      truncated: size > bytesRead,
      artifactPath: path,
      artifactBytes: size,
      artifactTruncated: false,
    };
  } finally {
    await handle.close();
  }
}

export async function diagnoseLostBashOutput(outputPath: string): Promise<string | undefined> {
  try {
    const outputDirectory = dirname(outputPath);
    const fileSystem = await statfs(outputDirectory, { bigint: true });
    const availableMegabytes = (fileSystem.bavail * fileSystem.bsize) / (1024n * 1024n);
    const recoveryHint =
      "Free up space on this filesystem.";
    if (availableMegabytes < 0n) return undefined;
    if (availableMegabytes < 10n) {
      return `Command output was lost: the temp filesystem at ${outputDirectory} is full (${availableMegabytes}MB free). The child process's stdout/stderr writes failed with ENOSPC. ${recoveryHint}`;
    }
    if (fileSystem.files > 0n && fileSystem.ffree < 1000n) {
      return `Command output was lost: the temp filesystem at ${outputDirectory} is out of inodes (${fileSystem.ffree} free). The child process's stdout/stderr writes failed with ENOSPC. ${recoveryHint}`;
    }
  } catch {

  }
  return undefined;
}
