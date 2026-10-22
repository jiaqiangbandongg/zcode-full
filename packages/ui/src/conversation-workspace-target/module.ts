/**
 * conversation-workspace-target 模块清单（architecture-governance managed 模块）。
 * 层：app。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const conversationWorkspaceTargetModule = {
  id: "conversation-workspace-target",
  requires: ["shared", "ui"],
  provides: ["conversation-workspace-target"],
  publicEntrypoints: [
    "index.ts",
    "contract.ts",
    "purpose.ts",
    "sourceIdentity.ts",
    "workbenchTarget.ts",
    "usePluginCreator.ts",
    "PluginAddMenu.tsx",
  ],
} as const;
