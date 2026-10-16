import type { ZCodeTaskPersistStatus, ZCodeTaskRuntimeStatus } from "@zcode/shared";

interface TaskRestoreTimestampedMessageLike {
  role: "user" | "assistant";
  timestamp: number;
}

interface ResolveTaskRuntimeStatusAfterRestoreOptions {
  persistedStatus?: ZCodeTaskPersistStatus;
  persistedUpdatedAt?: number;
  latestUserMessageTimestamp?: number | null;
  runtimeMainActive?: boolean;
}

interface ShouldShowTaskConfigLoadingOnSwitchParams {
  previousTaskId: string | null;
  nextTaskId: string | null;
}

export function shouldKeepTaskStreamingDuringRestore(
  taskStatus: ZCodeTaskRuntimeStatus,
): boolean {
  // Bugfix: 任务切到后台后再切回来时，如果这条 task 其实还在持续输出，
  // 恢复链路不能把它先打回 restoring/ready。
  // 否则 ChatView 会误以为生成已经结束，"思考中" 动画会在切回来后直接消失。
  return taskStatus === "streaming";
}

export function shouldShowTaskConfigLoadingOnSwitch(
  params: ShouldShowTaskConfigLoadingOnSwitchParams,
): boolean {
  const nextTaskId = params.nextTaskId?.trim() ?? "";
  if (!nextTaskId) {
    return false;
  }

  const previousTaskId = params.previousTaskId?.trim() ?? "";
  // Bugfix: task 切换期间如果继续沿用 workspace 里上一条任务的 configOptions，
  // 工具栏会短暂显示旧模型，直到 resume/config_option_update 回包才纠正。
  // 这里按 taskId 切换判定先进入 loading，占位期不再暴露上一个 task 的模型回显。
  return previousTaskId !== nextTaskId;
}

export function getLatestTaskUserMessageTimestamp(
  messages: readonly TaskRestoreTimestampedMessageLike[],
): number | null {
  let latestTimestamp: number | null = null;
  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }
    latestTimestamp =
      latestTimestamp === null ? message.timestamp : Math.max(latestTimestamp, message.timestamp);
  }
  return latestTimestamp;
}

function toTerminalRuntimeStatus(status: ZCodeTaskPersistStatus): ZCodeTaskRuntimeStatus {
  if (status === "running") {
    return "streaming";
  }
  return status === "error" ? "failed" : "completed";
}

export function resolveTaskRuntimeStatusAfterRestore(
  taskStatus: ZCodeTaskRuntimeStatus,
  hasRestoredSession: boolean,
  options?: ResolveTaskRuntimeStatusAfterRestoreOptions,
): ZCodeTaskRuntimeStatus {
  if (!hasRestoredSession) {
    return "notReady";
  }

  const persistedStatus = options?.persistedStatus;
  const persistedUpdatedAt = options?.persistedUpdatedAt;
  const latestUserMessageTimestamp = options?.latestUserMessageTimestamp ?? null;

  if (
    persistedStatus &&
    persistedStatus !== "running" &&
    typeof persistedUpdatedAt === "number" &&
    (
      latestUserMessageTimestamp === null ||
      persistedUpdatedAt >= latestUserMessageTimestamp
    )
  ) {
    // Bugfix: 历史任务恢复时，store 里可能还残留上一帧的 streaming 运行态。
    // 如果宿主已经把这一轮真正收尾（completed/error）持久化到 meta.status，
    // 继续沿用旧 streaming 就会让 UI 永远显示“生成中”。
    // 这里要求持久化终态至少覆盖到最新一条用户消息，再用它收口运行态，
    // 避免把“上一轮 completed 快照”误套到新一轮仍在运行的 prompt 上。
    return toTerminalRuntimeStatus(persistedStatus);
  }

  if (options?.runtimeMainActive === true) {
    // 修复原因：mainActive snapshot 是 agent/session 当前仍在 main turn 的运行事实。
    // 但它只能先用于恢复 runtime.status；真正的 UI mainActive 标记会在 status=streaming 后再写入。
    return "streaming";
  }

  return shouldKeepTaskStreamingDuringRestore(taskStatus) ? "streaming" : "ready";
}
