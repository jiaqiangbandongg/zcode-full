import type { ToolEntry } from "../types.js";
import { normalizeToolExecutionInput } from "../input-normalization.js";
import type { ToolExecutorDeps } from "./types.js";
import { validateInput } from "./validation.js";

/** 审批只读快照；先冻结再下钻，避免可信 Hook 返回循环引用时无限递归。 */
export function snapshotPermissionInput<T>(input: T): T {
  const snapshot = structuredClone(input);
  function freeze(value: unknown): void {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
  freeze(snapshot);
  return snapshot;
}

export function preparePermissionInput(
  input: unknown,
  entry: ToolEntry,
  deps: ToolExecutorDeps,
): unknown {
  const normalized = normalizeToolExecutionInput({
    entry,
    input,
    logger: deps.logger,
    source: "permission",
  });
  // 原因：审批重构曾额外重跑所有工具的语义预检，扩大了旧模式行为变更；改写保留原 schema 校验。
  const error = validateInput(normalized, entry);
  if (error) throw error;
  return normalized;
}
