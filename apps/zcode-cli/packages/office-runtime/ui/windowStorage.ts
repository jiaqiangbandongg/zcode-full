import { kindOf, type DocKind } from "#office/contract.ts";
import { PROFILE } from "#office/profile.ts";

type StoragePort = Pick<Storage, "getItem" | "setItem">;
export interface WindowState {
  path?: string;
  recent?: { path: string; kind: DocKind }[];
}
const KEY = `${PROFILE.name}:windows:v1`;
const MAX_WINDOWS = 128;
function readAll(storage: StoragePort): Record<string, WindowState> {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(KEY) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, WindowState>)
      : {};
  } catch {
    return {};
  }
}
export function readWindowState(storage: StoragePort, key: string): WindowState {
  const item = readAll(storage)[key];
  if (!item || typeof item !== "object") return {};
  return {
    ...(typeof item.path === "string" ? { path: item.path } : {}),
    ...(Array.isArray(item.recent)
      ? {
          recent: item.recent.filter(
            (file) => typeof file?.path === "string" && kindOf(file.path) === file.kind,
          ),
        }
      : {}),
  };
}
export function writeWindowState(storage: StoragePort, key: string, patch: WindowState): void {
  try {
    const items = readAll(storage);
    const value = { ...readWindowState(storage, key), ...patch };
    // 按最近使用顺序保留有限窗口，避免关闭标签页后无限累积独立 localStorage 键。
    delete items[key];
    items[key] = value;
    for (const oldest of Object.keys(items).slice(0, -MAX_WINDOWS)) delete items[oldest];
    storage.setItem(KEY, JSON.stringify(items));
  } catch {
    /* 禁用存储或达到配额时不阻断查看器。 */
  }
}
