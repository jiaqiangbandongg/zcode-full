// ============================================================
// Read File State Helpers
// ============================================================

import { platform as currentPlatform } from "node:process";
import { normalizeToolPathForComparison } from "./path-normalization.js";
import type { ReadFileStateEntry, ReadFileStateMap } from "./types.js";

type ReadFileStatePlatform = NodeJS.Platform;

export function createReadFileStatePathKey(
  filePath: string,
  platform: ReadFileStatePlatform = currentPlatform,
): string {
  return normalizeToolPathForComparison(filePath, platform);
}

export function createReadFileStateKey(
  filePath: string,
  offset: number | undefined,
  limit: number | undefined,
  platform: ReadFileStatePlatform = currentPlatform,
): string {
  return [
    createReadFileStatePathKey(filePath, platform),
    String(offset ?? 1),
    limit === undefined ? "" : String(limit),
  ].join("\0");
}

export function findStrictFullReadFileState(
  readFileState: ReadFileStateMap | undefined,
  filePath: string,
  platform: ReadFileStatePlatform = currentPlatform,
): ReadFileStateEntry | undefined {
  if (!readFileState) return undefined;

  return findLatestReadFileStateByPath(readFileState, filePath, platform, (entry) =>
    isStrictFullReadState(entry),
  );
}

export function findEditableReadFileState(
  readFileState: ReadFileStateMap | undefined,
  filePath: string,
  platform: ReadFileStatePlatform = currentPlatform,
): ReadFileStateEntry | undefined {
  return findLatestReadFileState(readFileState, filePath, platform);
}

export function findLatestReadFileState(
  readFileState: ReadFileStateMap | undefined,
  filePath: string,
  platform: ReadFileStatePlatform = currentPlatform,
): ReadFileStateEntry | undefined {
  if (!readFileState) return undefined;

  // 优先返回 full Read 会让 Bash/formatter 改完文件后即使模型按提示重新
  // range Read，Edit/Write 仍拿旧 full Read 做 mtime 校验并持续误报 stale。这里按
  // 单文件最新 read-state 语义选择基准；真正的 partial view 由消费者单独拒绝。
  return findLatestReadFileStateByPath(readFileState, filePath, platform, () => true);
}

export function normalizeReadFileStateMtimeMs(mtimeMs: number | undefined): number | undefined {
  if (mtimeMs === undefined) return undefined;
  return Math.floor(mtimeMs);
}

function findLatestReadFileStateByPath(
  readFileState: ReadFileStateMap,
  filePath: string,
  platform: ReadFileStatePlatform,
  accepts: (entry: ReadFileStateEntry) => boolean,
): ReadFileStateEntry | undefined {
  const pathKey = createReadFileStatePathKey(filePath, platform);
  let latest: ReadFileStateEntry | undefined;
  let latestReadAt = Number.NEGATIVE_INFINITY;
  for (const entry of readFileState.values()) {
    if (createReadFileStatePathKey(entry.path, platform) !== pathKey) continue;
    if (!accepts(entry)) continue;
    const readAt = entry.readAt.getTime();
    if (readAt < latestReadAt) continue;
    latest = entry;
    latestReadAt = readAt;
  }
  return latest;
}

function isStrictFullReadState(entry: ReadFileStateEntry): boolean {
  if (entry.isPartialView) return false;
  return (entry.offset ?? 1) <= 1 && entry.limit === undefined;
}
