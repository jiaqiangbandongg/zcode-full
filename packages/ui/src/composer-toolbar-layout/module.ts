/**
 * composer-toolbar-layout 模块清单（architecture-governance managed 模块）。
 * 层：ui。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const composerToolbarLayoutModule = {
  id: "composer-toolbar-layout",
  requires: [],
  provides: ["composer-toolbar-layout"],
  publicEntrypoints: ["../prompt-editor/useComposerToolbarFit.ts", "contract.ts"],
} as const;
