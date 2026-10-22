import type { SessionResidencyFinalizationOwner } from "./contract.js";
export type { SessionResidencyFinalizationOwner } from "./contract.js";

/**
 * residency lease 只覆盖 Bootstrap detached runner 的收尾窗口，避免 pool 回收仍在使用的
 * record。Prompt admission 的 busy/idle authority 已归 Core；activeAbortController 仅是旧命令
 * 路径的兼容取消句柄，不能再作为 prompt 调度锁。
 */
export function acquireSessionResidencyFinalization(
  record: SessionResidencyFinalizationOwner,
): () => void {
  record.residencyFinalizationCount = (record.residencyFinalizationCount ?? 0) + 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    record.residencyFinalizationCount = Math.max(0, (record.residencyFinalizationCount ?? 1) - 1);
  };
}

/** 同步登记 lease，再启动 detached runner；同步抛错和异步终态都保证释放。 */
export function runWithSessionResidencyFinalization<T>(
  record: SessionResidencyFinalizationOwner,
  run: () => Promise<T>,
): Promise<T> {
  const release = acquireSessionResidencyFinalization(record);
  try {
    return run().finally(release);
  } catch (error) {
    release();
    return Promise.reject(error);
  }
}
