import type { AgentRuntimeInternal } from "../internal.js";

/**
 * 登记会越过当前同步调用栈的 runtime-owned work。
 *
 * session 常驻池过去只观察 active turn 与 task registry；title、MCP startup、
 * ledger write 等 detached Promise 不在两者中，可能在仍读写 runtime 时被当作 idle 关闭。
 * 计数必须在 Promise 启动的同一同步片增加，并只在 finally 释放。
 */
export function trackResidencyBlockingWork<T>(
  this: AgentRuntimeInternal,
  work: Promise<T>,
): Promise<T> {
  this.residencyBlockingWorkCount += 1;
  return work.finally(() => {
    this.residencyBlockingWorkCount = Math.max(0, this.residencyBlockingWorkCount - 1);
  });
}

/** Session 常驻池只消费这一项，新增 sidecar 时不再修改 bootstrap 的猜测列表。 */
export function hasResidencyBlockingWork(this: AgentRuntimeInternal): boolean {
  return (
    this.hasActiveOrQueuedTurnWork() ||
    this.hasRunningBackgroundTasks() ||
    this.residencyBlockingWorkCount > 0 ||
    (this.memoryExtractionScheduler?.hasPendingWork() ?? false) ||
    (this.memoryRecallPrefetch !== undefined && !this.memoryRecallPrefetch.settled)
  );
}
