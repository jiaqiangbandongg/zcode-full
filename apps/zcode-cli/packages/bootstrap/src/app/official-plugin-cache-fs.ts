import { renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const DEFAULT_RETRY_DURATION_MS = 1_500;
const RETRY_DELAYS_MS = [25, 50, 100] as const;
const RETRY_ATTEMPTS_FIELD = "zcodeOfficialPluginCacheAttempts";
const TRANSIENT_ERROR_CODES = new Set(["EACCES", "EBUSY", "EEXIST", "ENOTEMPTY", "EPERM"]);

export interface OfficialPluginCacheRetryBudget {
  deadlineAt: number;
  now: () => number;
  sleep: (delayMs: number) => void;
}

export function createOfficialPluginCacheRetryBudget(input?: {
  durationMs?: number;
  now?: () => number;
  sleep?: (delayMs: number) => void;
}): OfficialPluginCacheRetryBudget {
  const now = input?.now ?? Date.now;
  return {
    deadlineAt: now() + (input?.durationMs ?? DEFAULT_RETRY_DURATION_MS),
    now,
    sleep: input?.sleep ?? sleepSync,
  };
}

export function isTransientOfficialPluginCacheFsError(
  error: unknown,
): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    TRANSIENT_ERROR_CODES.has(String((error as NodeJS.ErrnoException).code))
  );
}

export function getOfficialPluginCacheRetryAttempts(error: unknown): number {
  if (typeof error !== "object" || error === null) return 1;
  const attempts = (error as Record<string, unknown>)[RETRY_ATTEMPTS_FIELD];
  return typeof attempts === "number" && Number.isFinite(attempts) ? attempts : 1;
}

export function retryOfficialPluginCacheFs<T>(
  operation: () => T,
  options?: {
    budget?: OfficialPluginCacheRetryBudget;
  },
): T {
  const budget = options?.budget ?? createOfficialPluginCacheRetryBudget();
  let attempts = 0;
  while (true) {
    attempts += 1;
    try {
      return operation();
    } catch (error) {
      setRetryAttempts(error, attempts);
      const delayMs = RETRY_DELAYS_MS[attempts - 1];
      if (
        !isTransientOfficialPluginCacheFsError(error) ||
        delayMs === undefined ||
        budget.now() + delayMs > budget.deadlineAt
      ) {
        throw error;
      }
      budget.sleep(delayMs);
    }
  }
}

export function removeOfficialPluginCacheDirectory(
  path: string,
  budget = createOfficialPluginCacheRetryBudget(),
): void {
  retryOfficialPluginCacheFs(
    () => {
      rmSync(path, {
        force: true,
        maxRetries: 3,
        recursive: true,
        retryDelay: 25,
      });
    },
    { budget },
  );
}

export function renameOfficialPluginCachePath(
  fromPath: string,
  toPath: string,
  budget: OfficialPluginCacheRetryBudget,
): void {
  retryOfficialPluginCacheFs(() => renameSync(fromPath, toPath), { budget });
}

export function writeTextFileAtomicallyWithRetry(
  filePath: string,
  contents: string,
  budget: OfficialPluginCacheRetryBudget,
): void {
  const temporaryPath = join(
    dirname(filePath),
    `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  try {
    retryOfficialPluginCacheFs(() => writeFileSync(temporaryPath, contents), { budget });
    renameOfficialPluginCachePath(temporaryPath, filePath, budget);
  } catch (error) {
    try {
      rmSync(temporaryPath, { force: true });
    } catch {
      // 清理临时文件失败不能覆盖真正的写入错误；下次启动会使用新的唯一临时文件。
    }
    throw error;
  }
}

function setRetryAttempts(error: unknown, attempts: number): void {
  if (typeof error !== "object" || error === null) return;
  try {
    Object.defineProperty(error, RETRY_ATTEMPTS_FIELD, {
      configurable: true,
      value: attempts,
      writable: true,
    });
  } catch {
    // 某些第三方错误对象可能被冻结；此时日志退回 attempts=1，不改变原始异常。
  }
}

function sleepSync(delayMs: number): void {
  // 官方插件发现链路当前是同步 API。Windows 杀毒/索引器可能短暂占用缓存，
  // 用总预算受限的短等待吸收瞬时 EPERM，避免为热修扩大成整条启动链路异步化。
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
}
