interface DeferredWebRemoteControlTaskSnapshotLogOptions {
  archivedLoading: boolean;
  pinnedLoading: boolean;
  timelineLoading: boolean;
}

export function shouldSyncWebRemoteControlTaskSnapshot({
  archivedLoading,
  enabled,
  pinnedLoading,
  timelineLoading,
}: {
  archivedLoading: boolean;
  enabled: boolean;
  pinnedLoading: boolean;
  timelineLoading: boolean;
}): boolean {
  if (!enabled) {
    return false;
  }

  // Bugfix: syncWebRemoteControlTasks 在 main 进程里是整快照替换。
  // useGlobalTaskList 会先发布 partial shard 结果，非空数组也可能只是局部任务。
  // loading 未结束前暂不同步，避免手机端把缺 task 的 partial 当成权威列表。
  if (archivedLoading || pinnedLoading || timelineLoading) {
    return false;
  }

  return true;
}

export function logDeferredWebRemoteControlTaskSnapshot(
  logger: {
    debug: (
      message: string,
      details: DeferredWebRemoteControlTaskSnapshotLogOptions,
    ) => void;
  },
  details: DeferredWebRemoteControlTaskSnapshotLogOptions,
): void {
  // Bugfix: loading 期间暂缓的可能是非空 partial 快照，不是“空任务快照”。
  // 这类日志会随 partial 列表刷新重复出现，降到 debug 避免生产 info 日志刷屏。
  logger.debug("[Root] 暂缓同步 Web 远控任务快照，等待任务列表加载完成", details);
}
