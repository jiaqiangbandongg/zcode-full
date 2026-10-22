/**
 * bot-project-runtime 模块清单（architecture-governance managed 模块）。
 * 层：app。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const botProjectRuntimeModule = {
  id: "bot-project-runtime",
  requires: ["services", "shared", "remote-projects"],
  provides: ["bot-project-runtime"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
