/** 整批结果先进入 Runtime 历史，再等待既有持久化；沿用原调用方、错误和取消语义。 */
export type ToolResultSettlement =
  typeof import("../methods/tool-result-settlement.js").settleToolResults;
export type { ToolResultPart } from "../methods/tool-result-settlement.js";
