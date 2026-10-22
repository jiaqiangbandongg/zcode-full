import type { ToolResultSettlement } from "./contract.js";

/** 把原 Runtime 与整批结果交回同一结算方法，不复制历史或再执行工具。 */
export function exampleToolResultSettlement(
  settle: ToolResultSettlement,
  runtime: ThisParameterType<ToolResultSettlement>,
  ...args: Parameters<ToolResultSettlement>
): Promise<void> {
  return settle.call(runtime, ...args);
}
