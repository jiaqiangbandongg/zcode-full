import { DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS } from "@zcode/contracts";

export { DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS } from "@zcode/contracts";

export const MODEL_STREAM_IDLE_TIMEOUT_RETRY_INCREMENT_MS = 30_000;

export function resolveModelStreamIdleTimeoutMs(options: {
  baseTimeoutMs?: number;
  retryNumber?: number;
}): number {
  const baseTimeoutMs =
    options.baseTimeoutMs === undefined || !Number.isFinite(options.baseTimeoutMs)
      ? DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS
      : options.baseTimeoutMs;
  if (baseTimeoutMs <= 0) {
    return baseTimeoutMs;
  }

  const retryNumber =
    options.retryNumber === undefined || !Number.isFinite(options.retryNumber)
      ? 0
      : Math.max(0, Math.floor(options.retryNumber));
  return baseTimeoutMs + retryNumber * MODEL_STREAM_IDLE_TIMEOUT_RETRY_INCREMENT_MS;
}

class ModelStreamIdleTimeoutError extends Error {
  readonly code = "MODEL_STREAM_IDLE_TIMEOUT";
  readonly idleMs: number;
  readonly timeoutMs: number;

  constructor(options: { idleMs: number; timeoutMs: number }) {
    super(`Model stream stalled: no event received for ${options.timeoutMs}ms.`);
    this.name = "ModelStreamIdleTimeoutError";
    this.idleMs = options.idleMs;
    this.timeoutMs = options.timeoutMs;
  }
}

export function isModelStreamIdleTimeoutError(
  error: unknown,
): error is ModelStreamIdleTimeoutError {
  if (error instanceof ModelStreamIdleTimeoutError) {
    return true;
  }

  if (error === null || typeof error !== "object") {
    return false;
  }

  const record = error as Record<string, unknown>;
  return (
    record.code === "MODEL_STREAM_IDLE_TIMEOUT" ||
    record.name === "ModelStreamIdleTimeoutError"
  );
}

interface LinkedAbortController {
  controller: AbortController;
  signal: AbortSignal;
  cleanup(): void;
}

export function createLinkedAbortController(parentSignal?: AbortSignal): LinkedAbortController {
  const controller = new AbortController();

  if (!parentSignal) {
    return {
      controller,
      signal: controller.signal,
      cleanup() {},
    };
  }

  if (parentSignal.aborted) {
    controller.abort(parentSignal.reason);
    return {
      controller,
      signal: controller.signal,
      cleanup() {},
    };
  }

  const abortFromParent = () => {
    if (!controller.signal.aborted) {
      controller.abort(parentSignal.reason);
    }
  };
  parentSignal.addEventListener("abort", abortFromParent, { once: true });

  return {
    controller,
    signal: controller.signal,
    cleanup() {
      parentSignal.removeEventListener("abort", abortFromParent);
    },
  };
}

export async function readNextWithStreamIdleTimeout<T>(
  iterator: AsyncIterator<T>,
  options: {
    abortController: AbortController;
    onTimeout?: (error: ModelStreamIdleTimeoutError) => void | Promise<void>;
    timeoutMs: number;
  },
): Promise<IteratorResult<T>> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    return iterator.next();
  }

  const readStartedAt = Date.now();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;
  let timedOut = false;
  let timeoutError: ModelStreamIdleTimeoutError | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      if (options.abortController.signal.aborted) {
        reject(options.abortController.signal.reason ?? new Error("Model stream aborted."));
        return;
      }
      timedOut = true;
      timeoutError = new ModelStreamIdleTimeoutError({
        idleMs: Math.max(0, Date.now() - readStartedAt),
        timeoutMs: options.timeoutMs,
      });
      options.abortController.abort(timeoutError);
      reject(timeoutError);
    }, options.timeoutMs);
  });
  const abortPromise = new Promise<never>((_, reject) => {
    const signal = options.abortController.signal;
    const rejectAbort = () => {
      reject(signal.reason ?? new Error("Model stream aborted."));
    };
    if (signal.aborted) {
      rejectAbort();
      return;
    }
    // Stop 按钮会 abort 当前模型请求；如果底层 provider 没有让 iterator.next()
    // 立刻返回，这里必须主动结束等待，否则 UI 会一直卡到 idle timeout。
    signal.addEventListener("abort", rejectAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", rejectAbort);
  });

  try {
    return await Promise.race([iterator.next(), timeoutPromise, abortPromise]);
  } catch (error) {
    if (!timedOut) {
      throw error;
    }

    const idleError =
      timeoutError ??
      new ModelStreamIdleTimeoutError({
        idleMs: Math.max(0, Date.now() - readStartedAt),
        timeoutMs: options.timeoutMs,
      });
    await options.onTimeout?.(idleError);
    throw idleError;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    removeAbortListener?.();
  }
}
