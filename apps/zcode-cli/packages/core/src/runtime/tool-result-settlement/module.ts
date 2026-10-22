/**
 * tool-result-settlement 模块清单（architecture-governance managed 模块）。
 * 层：app。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const toolResultSettlementModule = {
  id: "tool-result-settlement",
  requires: ["zcode-cli"],
  provides: ["tool-result-settlement"],
  publicEntrypoints: ["../methods/tool-result-settlement.ts", "contract.ts"],
} as const;
