import { spawn } from "node:child_process";

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const MAX_COMMAND_TIMEOUT_MS = 5 * 60_000;

export interface RunElectronRecordingCommandOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export function runElectronRecordingCommand(
  command: string,
  args: string[],
  options: RunElectronRecordingCommandOptions = {},
): Promise<void> {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timeout) {
        clearTimeout(timeout);
      }
      options.signal?.removeEventListener("abort", handleAbort);
    };
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (error) {
        reject(error);
      } else {
        resolveCommand();
      }
    };
    const terminate = (error: Error) => {
      // 修复原因：ffmpeg 卡死时只 reject promise 会留下子进程；必须先强制终止，
      // close/error 后续回调再通过 settled 统一去重和清理 timer。
      if (!child.killed) {
        child.kill("SIGKILL");
      }
      finish(error);
    };
    const handleAbort = () => {
      terminate(asError(options.signal?.reason, `${command} aborted`));
    };

    child.stderr?.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-2000);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code === 0) {
        finish();
        return;
      }
      finish(new Error(`${command} exited with ${code}: ${stderr}`));
    });

    if (options.signal?.aborted) {
      handleAbort();
      return;
    }
    options.signal?.addEventListener("abort", handleAbort, { once: true });

    const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
    timeout = setTimeout(() => {
      terminate(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timeout.unref?.();
  });
}

export async function runWithTimeout<T>(
  run: () => Promise<T>,
  timeoutMs: number,
  label: string,
  onTimeout?: (error: Error) => void,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = new Error(`${label} timed out after ${timeoutMs}ms`);
      onTimeout?.(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(), timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function normalizeTimeoutMs(value: number | undefined): number {
  if (!Number.isFinite(value) || !value) {
    return DEFAULT_COMMAND_TIMEOUT_MS;
  }
  return Math.max(1, Math.min(MAX_COMMAND_TIMEOUT_MS, Math.round(value)));
}

function asError(value: unknown, fallback: string): Error {
  if (value instanceof Error) {
    return value;
  }
  return new Error(value ? String(value) : fallback);
}
