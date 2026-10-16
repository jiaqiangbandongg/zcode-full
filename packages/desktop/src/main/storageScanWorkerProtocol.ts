import type { StorageRootSpec } from "@zcode/services";
import type { StorageScanProgress } from "@zcode/services/node";

export interface StorageScanWorkerData {
  roots: StorageRootSpec[];
  progressIntervalMs: number;
}

export type StorageScanWorkerCommand = { type: "abort" };

export type StorageScanWorkerMessage =
  | { type: "progress"; progress: StorageScanProgress }
  | { type: "done"; progress: StorageScanProgress }
  | { type: "aborted"; message: string; code?: string }
  | { type: "error"; message: string; code?: string };

export function isStorageScanWorkerCommand(value: unknown): value is StorageScanWorkerCommand {
  return (
    typeof value === "object" && value !== null && (value as { type?: unknown }).type === "abort"
  );
}

export function isStorageScanWorkerMessage(value: unknown): value is StorageScanWorkerMessage {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return type === "progress" || type === "done" || type === "aborted" || type === "error";
}
