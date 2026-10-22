import type { AgentRuntimeInternal } from "../internal.js";
import type { RegularTurnLoopState } from "../methods/turn-loop-state.js";
import { createTurnModel } from "../methods/turn-model.js";
import { getOffPeakModelBinding } from "./model-binding.js";
import { getOffPeakExecution } from "./runtime.js";

/** 用户接纳只改变归属；主轮在完整请求边界应用新选择，子轮不调用本钩子。 */
export function refreshOffPeakTurnAfterTakeover(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
): boolean {
  if (!state.offPeakExecutionId) return false;
  const execution = getOffPeakExecution(runtime);
  if (!execution?.lifecycle.ownedByUser || execution.executionId !== state.offPeakExecutionId)
    return false;
  const model = createTurnModel(runtime);
  getOffPeakModelBinding(state.subagentModelOverride?.requestDependencies)?.release();
  state.model = model;
  state.modelSelectionScope = undefined;
  state.subagentModelOverride = undefined;
  state.offPeakTaskId = undefined;
  state.offPeakExecutionId = undefined;
  return true;
}

export function isOffPeakUserTakeover(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "off_peak_user_takeover"
  );
}
