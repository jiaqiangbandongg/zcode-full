import { ModelRetryBudget } from "@zcode/contracts";
import type { ResolvedAiSdkModelRetryOptions } from "./retry-policy.js";

/**
 * 重试预算档位的判定。
 *
 * 「无上限」**只**放宽瞬态失败的放弃条件：runner 的 attempt 循环、失败后「还能不能再试」两处闸门；
 * 退避曲线（2s→60s、jitter、Retry-After 优先）、`isRetryableFailure` 的分类、
 * `emittedRetryBoundaryEvent` 之后不重试、空补全重试与 compact 路径一律不动。
 *
 * 「单次尝试」只把本次请求的 `maxAttempts` 收敛为 1：runner 两处闸门与 empty completion 重试都读
 * 同一个 `retry.maxAttempts`，因此瞬态失败首次即上抛；鉴权刷新/签名修复的额外尝试不占预算，语义不变。
 */

/** 状态事件里 `maxAttempts` 表示「无上限」的哨兵（Infinity 不可序列化，0 不占用合法计数）。 */
export const UNBOUNDED_RETRY_MAX_ATTEMPTS = 0;
/** `single-attempt` 预算下本次请求允许的总尝试数（含首次）。 */
export const SINGLE_ATTEMPT_MAX_ATTEMPTS = 1;

export function isUnboundedRetryBudget(budget: ModelRetryBudget | undefined): boolean {
  return budget === ModelRetryBudget.Unbounded;
}

export function isSingleAttemptRetryBudget(budget: ModelRetryBudget | undefined): boolean {
  return budget === ModelRetryBudget.SingleAttempt;
}

/**
 * 按预算档位解析本次请求实际生效的 retry 选项。runner 入口统一走这里，避免在 attempt 循环、
 * 失败闸门、empty completion 与状态事件四处分别特判档位。
 */
export function resolveRetryOptionsForBudget(
  retry: ResolvedAiSdkModelRetryOptions,
  budget: ModelRetryBudget | undefined,
): ResolvedAiSdkModelRetryOptions {
  return isSingleAttemptRetryBudget(budget)
    ? { ...retry, maxAttempts: SINGLE_ATTEMPT_MAX_ATTEMPTS }
    : retry;
}

/** 失败之后还允许再试一次吗（等价于既有的 `retryBudgetAttempt < maxAttempts`，unbounded 恒真）。 */
export function retryBudgetAllows(
  budget: ModelRetryBudget | undefined,
  retryBudgetAttempt: number,
  maxAttempts: number,
): boolean {
  return isUnboundedRetryBudget(budget) || retryBudgetAttempt < maxAttempts;
}

/** attempt 循环的继续条件（等价于既有的 `attempt <= loopMaxAttempts`，unbounded 恒真）。 */
export function retryAttemptLoopContinues(
  budget: ModelRetryBudget | undefined,
  attempt: number,
  loopMaxAttempts: number,
): boolean {
  return isUnboundedRetryBudget(budget) || attempt <= loopMaxAttempts;
}

/** 写进状态事件 / 日志的 maxAttempts：unbounded 下是哨兵 0。 */
export function retryBudgetMaxAttempts(
  budget: ModelRetryBudget | undefined,
  maxAttempts: number,
): number {
  return isUnboundedRetryBudget(budget) ? UNBOUNDED_RETRY_MAX_ATTEMPTS : maxAttempts;
}
