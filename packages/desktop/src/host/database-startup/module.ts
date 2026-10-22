/**
 * host-database-startup 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const hostDatabaseStartupModule = {
  id: "host-database-startup",
  requires: ["project-storage", "shared", "desktop"],
  provides: ["host-database-startup"],
  publicEntrypoints: [
    "contract.ts",
    "tasksStorageWorker.ts",
    "hostDatabaseStartup.ts",
    "storagePreparationProcesses.ts",
  ],
} as const;
