import type { ModelInputMessage } from "@zcode/contracts";

export const MEMORY_RECALL_TYPES = ["user", "feedback", "project", "reference"] as const;

export type MemoryRecallType = (typeof MEMORY_RECALL_TYPES)[number];

export interface MemoryManifestEntry {
  description?: string;
  filePath: string;
  filename: string;
  mtimeMs: number;
  type?: MemoryRecallType;
}

export interface MemorySelectorResult {
  selectedKnowledgeIds: string[];
  selectedMemories: string[];
}

export interface RecalledMemory {
  content: string;
  filePath: string;
  header: string;
  limit?: number;
  mtimeMs: number;
  revisionId?: string;
  sizeBytes: number;
}

export interface MemoryRecallState {
  manifest?: MemoryManifestEntry[];
  recalledContentCharacters: number;
  recalledPaths: Set<string>;
  selectorMessages?: ModelInputMessage[];
}
