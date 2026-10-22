/**
 * workflow-tool-entrypoints 模块清单（architecture-governance managed 模块）。
 * 层：app。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const workflowToolEntrypointsModule = {
  id: "workflow-tool-entrypoints",
  requires: ["zcode-cli"],
  provides: ["workflow-tool-entrypoints"],
  publicEntrypoints: [
    "../handlers/amend-workflow.ts",
    "../handlers/list-models.ts",
    "../handlers/fill-workflow-hole.ts",
    "contract.ts",
  ],
} as const;
