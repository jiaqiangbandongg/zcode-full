import { ESTIMATED_TOKEN_CHAR_DIVISOR } from "@zcode/shared";
import type { ReadFileStateEntry, ReadFileStateMap } from "../deps.js";
import {
  systemReminderAttachmentEntry,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";

export function buildPostCompactReadStateReminderEntries(input: {
  maxFileApproxTokens?: number;
  maxFiles?: number;
  maxTotalApproxTokens?: number;
  preservedEntries?: readonly RuntimeMessageEntry[];
  readFileState?: ReadFileStateMap;
}): RuntimeMessageEntry[] {
  const readFileState = input.readFileState;
  if (!readFileState || readFileState.size === 0) {
    return [];
  }

  const maxFiles = input.maxFiles ?? 5;
  const maxFileApproxTokens = input.maxFileApproxTokens ?? 5_000;
  const maxTotalApproxTokens = input.maxTotalApproxTokens ?? 50_000;
  const selected: RuntimeMessageEntry[] = [];
  let totalApproxTokens = 0;
  const preservedReadFilePaths = collectPreservedReadFilePaths(input.preservedEntries ?? []);

  const candidates = Array.from(readFileState.values())
    .filter(isPostCompactReadReminderCandidate)
    .filter((entry) => !shouldSkipPostCompactReadStatePath(entry.path))
    .filter((entry) => !preservedReadFilePaths.has(normalizePostCompactReadStatePath(entry.path)))
    .sort((left, right) => right.readAt.getTime() - left.readAt.getTime());

  for (const entry of candidates) {
    if (selected.length >= maxFiles) break;

    const approxTokens = Math.ceil(entry.content.length / ESTIMATED_TOKEN_CHAR_DIVISOR);
    if (approxTokens > maxFileApproxTokens) {
      selected.push(buildPostCompactReadStateEntry(formatCompactFileReference(entry)));
      continue;
    }
    if (totalApproxTokens + approxTokens > maxTotalApproxTokens) {
      selected.push(buildPostCompactReadStateEntry(formatCompactFileReference(entry)));
      continue;
    }

    totalApproxTokens += approxTokens;
    selected.push(buildPostCompactReadStateEntry(formatReadStateProjection(entry)));
  }

  return selected;
}

function buildPostCompactReadStateEntry(content: string): RuntimeMessageEntry {
  return systemReminderAttachmentEntry("resume_referenced_session_context", content);
}

function formatCompactFileReference(entry: ReadFileStateEntry): string {
  return `Note: ${entry.path} was read before the last conversation was summarized, but the contents are too large to include. Use Read tool if you need to access it.`;
}

function formatReadStateProjection(entry: ReadFileStateEntry): string {
  const content = addReadLineNumbers(entry.content, readStateStartLine(entry.offset));
  return [
    `Called the Read tool with the following input: ${formatFileStateInput(entry)}`,
    "Result of calling the Read tool:",
    content,
  ].join("\n");
}

function isPostCompactReadReminderCandidate(entry: ReadFileStateEntry): boolean {
  return entry.sourceTool === undefined || entry.sourceTool === "Read";
}

function collectPreservedReadFilePaths(entries: readonly RuntimeMessageEntry[]): Set<string> {
  const paths = new Set<string>();
  for (const entry of entries) {
    if (!("message" in entry)) continue;
    if (entry.message.role !== "assistant" || !entry.message.toolCalls) continue;
    for (const toolCall of entry.message.toolCalls) {
      if (toolCall.name !== "Read") continue;
      const filePath = readToolCallFilePath(toolCall.input);
      if (filePath) paths.add(normalizePostCompactReadStatePath(filePath));
    }
  }
  return paths;
}

function readToolCallFilePath(input: unknown): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const filePath = (input as { file_path?: unknown }).file_path;
  return typeof filePath === "string" && filePath.length > 0 ? filePath : undefined;
}

function formatFileStateInput(entry: ReadFileStateEntry): string {
  return JSON.stringify({
    file_path: entry.path,
    ...(entry.offset === undefined ? {} : { offset: entry.offset }),
    ...(entry.limit === undefined ? {} : { limit: entry.limit }),
  });
}

function readStateStartLine(offset: number | undefined): number {
  if (offset === 0) return 0;
  if (offset !== undefined && offset > 1) return Math.trunc(offset);
  return 1;
}

function addReadLineNumbers(content: string, startLine: number): string {
  return content
    .split(/\r?\n/)
    .map((line, index) => `${index + startLine}\t${line}`)
    .join("\n");
}

function shouldSkipPostCompactReadStatePath(filePath: string): boolean {
  const normalized = normalizePostCompactReadStatePath(filePath);
  return (
    normalized.includes("/.codex/memories/") ||
    normalized.includes("/docs/superpowers/plans/") ||
    normalized.includes("/.git/")
  );
}

function normalizePostCompactReadStatePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}
