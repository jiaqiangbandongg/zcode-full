/**
 * window-project-directory 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const windowProjectDirectoryModule = {
  id: "window-project-directory",
  requires: ["project", "remote-projects", "rpc", "services", "shared"],
  provides: ["window-project-directory"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
