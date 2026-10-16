import type { FileSystemPort } from "@zcode/contracts";

import type { MemoryManifestEntry, RecalledMemory } from "./types.js";

const MEMORY_CONTENT_LINE_LIMIT = 200;
const MEMORY_CONTENT_BYTE_LIMIT = 4096;
const STALE_DAY_MS = 86_400_000;

export async function readRecalledMemories(input: {
  entries: readonly MemoryManifestEntry[];
  fileSystem: FileSystemPort;
  nowMs: number;
  signal?: AbortSignal;
}): Promise<RecalledMemory[]> {
  const settled = await Promise.allSettled(
    input.entries.map((entry) =>
      readRecalledMemory(input.fileSystem, entry, input.nowMs, input.signal),
    ),
  );
  return settled
    .filter(
      (result): result is PromiseFulfilledResult<RecalledMemory> => result.status === "fulfilled",
    )
    .map((result) => result.value);
}

export function formatRelevantMemoryAttachment(memories: readonly RecalledMemory[]): string {
  return memories
    .map(
      (memory, index) =>
        `${
          index === 0
            ? "Retrieved for possible relevance — use only if it actually applies to what the user asked.\n\n"
            : ""
        }${memory.header}\n\n${memory.content}`,
    )
    .join("\n\n");
}

async function readRecalledMemory(
  fileSystem: FileSystemPort,
  entry: MemoryManifestEntry,
  nowMs: number,
  signal?: AbortSignal,
): Promise<RecalledMemory> {
  const result = await fileSystem.readTextFileRange(
    { path: entry.filePath, offsetLine: 0, limitLines: MEMORY_CONTENT_LINE_LIMIT },
    { signal },
  );
  const normalized = result.content.replace(/^\uFEFF/u, "").replace(/\r\n/gu, "\n");
  const byteLimited = limitCompleteLinesByBytes(normalized);
  const lineTruncated = result.totalLines > MEMORY_CONTENT_LINE_LIMIT;
  const truncated = byteLimited.truncated || lineTruncated;
  const content = truncated
    ? `${byteLimited.content}\n\n> This memory file was truncated (${
        byteLimited.truncated
          ? `${MEMORY_CONTENT_BYTE_LIMIT} byte limit`
          : `first ${MEMORY_CONTENT_LINE_LIMIT} lines`
      }). Use the Read tool to view the complete file at: ${entry.filePath}`
    : byteLimited.content;

  return {
    content,
    filePath: entry.filePath,
    header: memoryHeader(entry.filePath, entry.mtimeMs, nowMs),
    limit: truncated ? byteLimited.lineCount : undefined,
    mtimeMs: entry.mtimeMs,
    revisionId: result.revision?.id,
    sizeBytes: result.sizeBytes,
  };
}

function limitCompleteLinesByBytes(content: string): {
  content: string;
  lineCount: number;
  truncated: boolean;
} {
  const lines = content === "" ? [""] : content.split("\n");
  const selected: string[] = [];
  let selectedBytes = 0;

  for (const line of lines) {
    const separatorBytes = selected.length > 0 ? 1 : 0;
    const nextBytes = selectedBytes + separatorBytes + Buffer.byteLength(line, "utf8");
    if (nextBytes > MEMORY_CONTENT_BYTE_LIMIT) {
      return { content: selected.join("\n"), lineCount: selected.length, truncated: true };
    }
    selected.push(line);
    selectedBytes = nextBytes;
  }

  return { content: selected.join("\n"), lineCount: selected.length, truncated: false };
}

function memoryHeader(filePath: string, mtimeMs: number, nowMs: number): string {
  const daysOld = Math.max(0, Math.floor((nowMs - mtimeMs) / STALE_DAY_MS));
  if (daysOld <= 1) return `Memory: ${filePath}:`;
  return `This memory is ${daysOld} days old. Memories are point-in-time observations, not live state — claims about code behavior or file:line citations may be outdated. Verify against current code before asserting as fact.\n\nMemory: ${filePath}:`;
}
