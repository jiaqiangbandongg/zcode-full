import {
  type MessageWithParts,
  type ReadSessionContextInput,
  type ReadSessionContextOutput,
  type ReadSessionContextReference,
  type SessionInfo,
} from "@zcode/contracts";
import { activeSessionMessages } from "../agent/session-history-hydrator.js";
import { dedupeParts, formatPartForContext } from "./parts.js";
import { truncateText } from "./utils.js";
export {
  buildReferencedSessionContextReminderBody,
  extractSessionReferences,
} from "./references.js";

const DEFAULT_OUTPUT_CHAR_BUDGET = 24_000;
const MAX_OUTPUT_CHAR_BUDGET = 48_000;
const MAX_LITE_INPUT_CHARS = 80_000;
const MAX_LITE_CHUNKS = 5;
const MAX_CHUNK_CHARS = 28_000;

export interface SessionContextMaterial {
  allContent: string;
  allContentChars: number;
  chunks: TranscriptChunk[];
  localContent: string;
  messageCount: number;
  readableMessageCount: number;
  references: ReadSessionContextReference[];
  selectedChunks: TranscriptChunk[];
  selectedMessageCount: number;
  truncated: boolean;
}

export interface TranscriptChunk {
  index: number;
  startMessageIndex: number;
  endMessageIndex: number;
  messageCount: number;
  content: string;
  searchText: string;
  score: number;
  references: ReadSessionContextReference[];
}

interface MessageSnippet {
  index: number;
  role: "user" | "assistant";
  content: string;
  searchText: string;
  score: number;
  references: ReadSessionContextReference[];
}

export function buildSessionContextMaterial(input: {
  messages: MessageWithParts[];
  query: string;
  session: SessionInfo;
  strategy: ReadSessionContextInput["strategy"];
  outputCharBudget?: number;
}): SessionContextMaterial {
  const outputCharBudget = clampOutputCharBudget(input.outputCharBudget);
  const activeMessages = activeSessionMessages(input.messages);
  const snippets = activeMessages
    .map((message, index) => formatMessageSnippet(message, index))
    .filter((snippet): snippet is MessageSnippet => snippet !== null);
  const scoredSnippets = scoreSnippets(snippets, input.query);
  const allContent = formatSessionTranscript(input.session, scoredSnippets, {
    budgetChars: Number.POSITIVE_INFINITY,
    heading: "Cleaned transcript",
    query: input.query,
    strategy: input.strategy,
  });
  const chunks = buildTranscriptChunks(scoredSnippets);
  const selectedChunks = selectChunks(chunks, input.strategy);
  const selectedSnippets = selectSnippets(scoredSnippets, input.strategy, outputCharBudget);
  const localContent = formatSessionTranscript(input.session, selectedSnippets, {
    budgetChars: outputCharBudget,
    heading: localHeading(input.strategy),
    query: input.query,
    strategy: input.strategy,
  });

  return {
    allContent,
    allContentChars: allContent.length,
    chunks,
    localContent,
    messageCount: activeMessages.length,
    readableMessageCount: scoredSnippets.length,
    references: selectedSnippets.flatMap((snippet) => snippet.references),
    selectedChunks,
    selectedMessageCount: selectedSnippets.length,
    truncated:
      selectedSnippets.length < scoredSnippets.length ||
      allContent.length > localContent.length ||
      allContent.length > outputCharBudget,
  };
}

export function formatReadSessionContextModelContent(output: ReadSessionContextOutput): string {
  if (output.status === "not_found") {
    return `Session ${output.sessionId} was not found.`;
  }
  if (output.status === "failed") {
    return [
      `ReadSessionContext failed for ${output.sessionId}.`,
      output.error ? `Error: ${output.error}` : undefined,
      output.content,
    ]
      .filter(Boolean)
      .join("\n");
  }

  return [
    `ReadSessionContext returned ${output.source} context for ${output.sessionId}.`,
    output.title ? `Title: ${output.title}` : undefined,
    output.truncated ? "The returned context is truncated." : undefined,
    output.nextCursor !== undefined
      ? `More matches: call again with cursor=${output.nextCursor}.`
      : undefined,
    "",
    output.content,
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatLocalSessionNotFound(input: {
  query: string;
  sessionId: string;
  strategy: ReadSessionContextInput["strategy"];
}): ReadSessionContextOutput {
  return {
    status: "not_found",
    sessionId: input.sessionId,
    strategy: input.strategy,
    query: input.query,
    source: "none",
    content: `No persisted session was found for ${input.sessionId}.`,
    messageCount: 0,
    selectedMessageCount: 0,
    truncated: false,
  };
}

export function outputCharBudgetFromMaxTokens(maxTokens: number | undefined): number {
  if (maxTokens === undefined) return DEFAULT_OUTPUT_CHAR_BUDGET;
  return clampOutputCharBudget(maxTokens * 4);
}

export function liteInputCharBudget(): number {
  return MAX_LITE_INPUT_CHARS;
}

export function maxLiteChunks(): number {
  return MAX_LITE_CHUNKS;
}

function formatMessageSnippet(message: MessageWithParts, index: number): MessageSnippet | null {
  if (message.info.role === "user" && message.info.visibility === "model-only") {
    return null;
  }

  const partTexts = dedupeParts(message.parts)
    .map((part) => formatPartForContext(part))
    .filter((text): text is string => Boolean(text?.trim()));
  if (partTexts.length === 0) return null;

  const role = message.info.role;
  const body = partTexts.join("\n\n");
  const content = [
    `[${index + 1}] ${role} ${message.info.id}`,
    `created: ${new Date(message.info.time.created).toISOString()}`,
    body,
  ].join("\n");

  return {
    index,
    role,
    content,
    searchText: `${role}\n${body}`.toLowerCase(),
    score: 0,
    references: [
      {
        messageId: message.info.id,
        index,
        role,
      },
    ],
  };
}

function scoreSnippets(snippets: MessageSnippet[], query: string): MessageSnippet[] {
  const terms = tokenizeQuery(query);
  const normalizedQuery = query.trim().toLowerCase();
  return snippets.map((snippet) => ({
    ...snippet,
    score: scoreSearchText(snippet.searchText, normalizedQuery, terms) + snippet.index / 10000,
  }));
}

function tokenizeQuery(query: string): string[] {
  const normalized = query.toLowerCase();
  const matches = normalized.match(/[a-z0-9_./-]+|[\p{Script=Han}]+/gu) ?? [];
  const terms = new Set<string>();
  for (const match of matches) {
    if (match.length < 2) continue;
    terms.add(match);
    if (/^[\p{Script=Han}]+$/u.test(match) && match.length > 2) {
      for (let index = 0; index < match.length - 1; index++) {
        terms.add(match.slice(index, index + 2));
      }
    }
  }
  return [...terms];
}

function scoreSearchText(searchText: string, normalizedQuery: string, terms: string[]): number {
  let score = 0;
  if (normalizedQuery.length > 0 && searchText.includes(normalizedQuery)) {
    score += 20;
  }
  for (const term of terms) {
    if (!searchText.includes(term)) continue;
    score += 3 + Math.min(countOccurrences(searchText, term), 5);
  }
  return score;
}

function countOccurrences(text: string, term: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const found = text.indexOf(term, offset);
    if (found < 0) return count;
    count++;
    offset = found + term.length;
  }
}

function selectSnippets(
  snippets: MessageSnippet[],
  strategy: ReadSessionContextInput["strategy"],
  budgetChars: number,
): MessageSnippet[] {
  if (snippets.length === 0) return [];
  if (strategy === "handoff") {
    return selectTailWithinBudget(snippets, budgetChars);
  }

  const positives = snippets.filter((snippet) => snippet.score >= 3);
  const ranked = positives.length > 0 ? positives : snippets.slice(-12);
  const selected: MessageSnippet[] = [];
  let usedChars = 0;
  for (const snippet of [...ranked].sort((a, b) => b.score - a.score || b.index - a.index)) {
    if (usedChars > budgetChars) break;
    selected.push(snippet);
    usedChars += snippet.content.length;
  }

  return selected.sort((a, b) => a.index - b.index);
}

function selectTailWithinBudget(snippets: MessageSnippet[], budgetChars: number): MessageSnippet[] {
  const selected: MessageSnippet[] = [];
  let usedChars = 0;
  for (let index = snippets.length - 1; index >= 0; index--) {
    const snippet = snippets[index]!;
    if (selected.length > 0 && usedChars + snippet.content.length > budgetChars) break;
    selected.push(snippet);
    usedChars += snippet.content.length;
  }
  return selected.reverse();
}

function buildTranscriptChunks(snippets: MessageSnippet[]): TranscriptChunk[] {
  const chunks: TranscriptChunk[] = [];
  let current: MessageSnippet[] = [];
  let currentChars = 0;

  for (const snippet of snippets) {
    if (current.length > 0 && currentChars + snippet.content.length > MAX_CHUNK_CHARS) {
      chunks.push(createChunk(chunks.length, current));
      current = [];
      currentChars = 0;
    }
    current.push(snippet);
    currentChars += snippet.content.length;
  }

  if (current.length > 0) {
    chunks.push(createChunk(chunks.length, current));
  }

  return chunks;
}

function createChunk(index: number, snippets: MessageSnippet[]): TranscriptChunk {
  const content = snippets.map((snippet) => snippet.content).join("\n\n---\n\n");
  return {
    index,
    startMessageIndex: snippets[0]!.index,
    endMessageIndex: snippets[snippets.length - 1]!.index,
    messageCount: snippets.length,
    content,
    searchText: snippets.map((snippet) => snippet.searchText).join("\n"),
    score: snippets.reduce((sum, snippet) => sum + snippet.score, 0),
    references: snippets.flatMap((snippet) => snippet.references),
  };
}

function selectChunks(
  chunks: TranscriptChunk[],
  strategy: ReadSessionContextInput["strategy"],
): TranscriptChunk[] {
  if (chunks.length <= MAX_LITE_CHUNKS) return chunks;
  if (strategy === "handoff") return chunks.slice(-MAX_LITE_CHUNKS);

  const byScore = [...chunks].sort((a, b) => b.score - a.score || b.index - a.index);
  const selected = new Map<number, TranscriptChunk>();
  for (const chunk of byScore.slice(0, MAX_LITE_CHUNKS - 1)) {
    selected.set(chunk.index, chunk);
  }
  selected.set(chunks[chunks.length - 1]!.index, chunks[chunks.length - 1]!);
  return [...selected.values()].sort((a, b) => a.index - b.index);
}

function formatSessionTranscript(
  session: SessionInfo,
  snippets: MessageSnippet[],
  options: {
    budgetChars: number;
    heading: string;
    query: string;
    strategy: ReadSessionContextInput["strategy"];
  },
): string {
  const header = [
    `# ${options.heading}`,
    `Session: ${session.title} (${session.id})`,
    `Directory: ${session.directory}`,
    session.path ? `Path: ${session.path}` : undefined,
    `Strategy: ${options.strategy}`,
    `Query: ${options.query}`,
    "",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");

  if (snippets.length === 0) {
    return `${header}No readable transcript content was found in the target session.`;
  }

  let remaining = Number.isFinite(options.budgetChars)
    ? Math.max(0, options.budgetChars - header.length)
    : Number.POSITIVE_INFINITY;
  const body: string[] = [];
  for (const snippet of snippets) {
    const separator = body.length > 0 ? "\n\n---\n\n" : "";
    const next = separator + snippet.content;
    if (Number.isFinite(remaining) && next.length > remaining) {
      if (remaining > 200) {
        body.push(truncateText(next, remaining));
      }
      break;
    }
    body.push(next);
    remaining -= next.length;
  }

  return `${header}${body.join("")}`;
}

function localHeading(strategy: ReadSessionContextInput["strategy"]): string {
  return strategy === "handoff" ? "Recent session handoff context" : "Relevant session context";
}

function clampOutputCharBudget(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_OUTPUT_CHAR_BUDGET;
  return Math.max(4000, Math.min(MAX_OUTPUT_CHAR_BUDGET, Math.floor(value)));
}
