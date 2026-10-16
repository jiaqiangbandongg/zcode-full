import type { ZCodeTaskRuntimeStatus, ZCodeWorkspaceInitStatus } from "@zcode/shared";

type ChatComposerStatus = "idle" | "submitting" | "streaming" | "error";

export function deriveChatComposerStatusFromTaskRuntime(
  taskStatus: ZCodeTaskRuntimeStatus,
): ChatComposerStatus {
  switch (taskStatus) {
    case "creating":
    case "restoring":
      return "submitting";
    case "streaming":
      return "streaming";
    case "failed":
      return "error";
    default:
      return "idle";
  }
}

export function isChatComposerEditingDisabled(status: ChatComposerStatus) {
  // Bugfix: 用户在“准备中”阶段也需要能继续补全下一条草稿。
  // 之前把 submitting 当成编辑锁，导致 task 创建/恢复稍慢时输入框整段时间都不可输入。
  // 这里统一放开编辑能力，只把“是否允许再次提交”交给 submissionBlocked 控制。
  return false;
}

export function isChatComposerSubmissionBlocked(status: ChatComposerStatus) {
  // Bugfix: 现在支持在上一轮 streaming 时先把下一条消息放进内存队列。
  // 如果这里继续把 streaming 也视为提交锁，按钮和回车都会被 UI 层直接拦住，
  // 队列逻辑永远走不到。这里仅在真正“创建/恢复/提交 RPC 中”的 submitting 阶段禁发。
  return status === "submitting";
}

export function shouldShowChatSubmitSpinner(status: ChatComposerStatus) {
  // Bugfix: 任务失败后再次发送，会先经历一段 resumeTask / 重新提交的 submitting 状态。
  // 之前按钮在这段时间仍显示发送箭头，用户会误以为没有进入 loading。
  // 这里单独暴露“提交中应显示 spinner”的判断，让 ChatView 和状态语义保持一致。
  return status === "submitting";
}

export function isChatTaskRunning(taskStatus: ZCodeTaskRuntimeStatus) {
  // ChatView 之前用 displayedStatus 和最后一条消息角色去猜“是否正在思考”，
  // task 明明还处在 creating/restoring/streaming 时，只要消息列表暂时没跟上，shimmer 就会提前消失。
  // 这里直接对齐 task 运行态判断，和顶部 Task StatusBadge 保持同一组“运行中”状态。
  return (
    taskStatus === "creating" || taskStatus === "restoring" || taskStatus === "streaming"
  );
}

export function deriveChatTaskStatusForMainActivity(
  taskStatus: ZCodeTaskRuntimeStatus,
  isMainActive: boolean,
): ZCodeTaskRuntimeStatus {
  if (taskStatus === "streaming" && !isMainActive) {
    return "completed";
  }
  return taskStatus;
}

export function canForkFromTaskRuntimeStatus(taskStatus: ZCodeTaskRuntimeStatus) {
  // 产品语义：failed/error partial 不是稳定历史边界，不能像 interrupted completed 一样分叉。
  // running 状态继续由 isChatTaskRunning 收口，避免重复维护 active turn 判断。
  return taskStatus !== "notReady" && taskStatus !== "failed" && !isChatTaskRunning(taskStatus);
}

export function shouldShowChatThinkingShimmer(taskStatus: ZCodeTaskRuntimeStatus) {
  // Bugfix: restoring 只是会话恢复，不代表模型已经开始思考。
  // 这里把“任务运行中”和“需要显示正在思考 shimmer”拆开，避免恢复历史任务时出现误导性的 thinking 提示。
  return taskStatus === "creating" || taskStatus === "streaming";
}

export function getChatSubmitLabelId(
  status: ChatComposerStatus,
  workspaceInitStatus: ZCodeWorkspaceInitStatus,
  taskStatus: ZCodeTaskRuntimeStatus,
) {
  if (status !== "submitting") {
    return "chat.send";
  }

  // Bugfix: submitting 阶段统一显示"准备中..."。
  // 之前区分了"准备中"和"正在思考"，但 resumeTask 完成后应直接切到 streaming 显示"停止生成"按钮，
  // submitting 阶段不会也不应该出现"正在思考"的状态。
  return "chat.preparing";
}
