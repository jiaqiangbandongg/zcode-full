import type { RecalledMemory, MemoryRecallState } from "./types.js";

export { formatMemoryManifest, getMemoryRecallManifest, scanMemoryManifest } from "./manifest.js";
export {
  buildMemorySelectorRequest,
  filterMemorySelections,
  findLatestMemoryRecallQuery,
  isMemoryRecallQueryEligible,
  runMemorySelector,
} from "./selector.js";
export { formatRelevantMemoryAttachment, readRecalledMemories } from "./content.js";
export type {
  MemoryManifestEntry,
  MemoryRecallState,
  MemoryRecallType,
  MemorySelectorResult,
  RecalledMemory,
} from "./types.js";

export const MEMORY_RECALL_SESSION_CHARACTER_LIMIT = 61_440;

export function createMemoryRecallState(): MemoryRecallState {
  return {
    recalledContentCharacters: 0,
    recalledPaths: new Set(),
  };
}

export function canStartMemoryRecall(state: MemoryRecallState): boolean {
  return state.recalledContentCharacters < MEMORY_RECALL_SESSION_CHARACTER_LIMIT;
}

export function recordRecalledMemories(
  state: MemoryRecallState,
  memories: readonly RecalledMemory[],
): void {
  for (const memory of memories) {
    state.recalledPaths.add(memory.filePath);
    state.recalledContentCharacters += memory.content.length;
  }
}
