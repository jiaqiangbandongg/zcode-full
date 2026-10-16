import type { ZCodeTaskRuntimeStatus } from "@zcode/shared";

type ChatPlaceholderMessageKey =
  | "chat.placeholder.newTask"
  | "chat.placeholder.newTaskMobile"
  | "chat.placeholder.followUpAsk"
  | "chat.placeholder.followUpQueue";

export function resolveChatPlaceholderKey(options: {
  hasHistoryMessages: boolean;
  isTaskProcessing: boolean;
  compactNewTask?: boolean;
}): ChatPlaceholderMessageKey {
  const { compactNewTask = false, hasHistoryMessages, isTaskProcessing } = options;

  // 按语义分流：
  // 1) 无历史 -> newTask
  // 2) 有历史且空闲 -> followUpAsk
  // 3) 有历史且处理中 -> followUpQueue
  if (!hasHistoryMessages) {
    return compactNewTask ? "chat.placeholder.newTaskMobile" : "chat.placeholder.newTask";
  }

  return isTaskProcessing
    ? "chat.placeholder.followUpQueue"
    : "chat.placeholder.followUpAsk";
}

export function shouldDeferChatPlaceholder(options: {
  hasBoundTask: boolean;
  taskStatus: ZCodeTaskRuntimeStatus;
}): boolean {
  const { hasBoundTask, taskStatus } = options;

  // Bugfix: 切换历史 task 时会先经历 creating/restoring，再补齐消息和运行态。
  // 这段过渡期如果继续渲染 placeholder，会出现“追问 -> 新任务 -> 追问”的闪变。
  // 这里在任务进入可交互态前先隐藏 placeholder，等 runtime 就绪后再显示。
  return hasBoundTask && (taskStatus === "creating" || taskStatus === "restoring");
}
