import type { ZCodeTaskRuntimeStatus } from "@zcode/shared";

export function isLiveTaskRuntimeStatus(
  status: ZCodeTaskRuntimeStatus | undefined,
): boolean {
  // Bugfix: restoring 只是历史恢复，不代表 agent 正在执行新一轮生成。
  // 历史列表/手机远控首页只在当前 runtime 明确创建或流式输出时展示 running/loading。
  return status === "creating" || status === "streaming";
}
