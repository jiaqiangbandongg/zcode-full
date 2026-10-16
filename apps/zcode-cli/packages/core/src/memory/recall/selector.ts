import {
  modelMessageContentToText,
  type Model,
  type ModelInputMessage,
  type ModelRequest,
} from "@zcode/contracts";

import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import { findLatestReadFileState } from "../../tool/read-file-state.js";
import type { ReadFileStateMap } from "../../tool/types.js";
import { formatMemoryManifest } from "./manifest.js";
import type { MemoryManifestEntry, MemoryRecallState, MemorySelectorResult } from "./types.js";
import { auxiliaryModelOptions } from "../../model/auxiliary-model-options.js";

const MEMORY_SELECTOR_SYSTEM_PROMPT = `You are selecting memories that will be useful to the coding agent as it processes a user's query. The first message lists the available memory files with their filenames and descriptions; subsequent messages each contain one user query.

Return a list of filenames for the memories that will clearly be useful to the coding agent as it processes the user's query (up to 5). Only include memories that you are certain will be helpful based on their name and description.
- If you are unsure if a memory will be useful in processing the user's query, then do not include it in your list. Be selective and discerning.
- If there are no memories in the list that would clearly be useful, feel free to return an empty list.
- Be especially conservative with user-profile and project-overview memories ([user], [project]). These describe the user's ongoing focus, not what every question is about. A profile saying "works on DB performance" is NOT relevant to a question that merely contains the word "performance" unless the question is actually about that DB work. Match on what the question IS ABOUT, not on surface keyword overlap with who the user is.
- Do not re-select memories you already returned for an earlier query in this conversation.
`;

const MEMORY_SELECTOR_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    selected_memories: {
      type: "array",
      items: { type: "string" },
    },
    selected_knowledge_ids: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["selected_memories"],
  additionalProperties: false,
} as const;

const EMPTY_SELECTOR_RESULT: MemorySelectorResult = {
  selectedKnowledgeIds: [],
  selectedMemories: [],
};

export function findLatestMemoryRecallQuery(
  entries: readonly RuntimeMessageEntry[],
): string | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.kind === "attachment") continue;
    if (entry.message.role !== "user") continue;
    if (entry.message.toolCallId || entry.message.toolName) continue;
    const text = modelMessageContentToText(entry.message.content);
    // 修复原因：显式 real_user 已经是非 meta 的事实来源，文本前缀只用于兼容缺少 metadata 的旧历史。
    if (entry.metadata) {
      if (entry.metadata.source !== "real_user") continue;
    } else if (text.trimStart().startsWith("<system-reminder>")) {
      continue;
    }
    return text;
  }
  return undefined;
}

export function isMemoryRecallQueryEligible(query: string | undefined): query is string {
  if (!query) return false;
  return /\s/u.test(query.trim());
}

export function buildMemorySelectorRequest(input: {
  query: string;
  state: MemoryRecallState;
}): ModelRequest {
  const conversation = selectorConversation(input.state);
  return {
    messages: [
      {
        role: "system",
        content: MEMORY_SELECTOR_SYSTEM_PROMPT,
        cacheControl: { type: "ephemeral" },
      },
      ...conversation,
      {
        role: "user",
        content: `Select memories relevant to:\n${input.query}`,
        cacheControl: { type: "ephemeral" },
      },
    ],
    responseJsonSchema: MEMORY_SELECTOR_RESPONSE_SCHEMA,
  };
}

export async function runMemorySelector(input: {
  model: Model;
  query: string;
  state: MemoryRecallState;
  abortSignal?: AbortSignal;
}): Promise<MemorySelectorResult> {
  if (!input.state.manifest || input.state.manifest.length === 0) {
    return emptySelectorResult();
  }
  if (input.state.manifest.every((entry) => input.state.recalledPaths.has(entry.filePath))) {
    return emptySelectorResult();
  }

  try {
    const request = buildMemorySelectorRequest(input);
    request.abortSignal = input.abortSignal;
    request.options = { ...request.options, ...auxiliaryModelOptions(input.model) };
    const response = await input.model.generateText(request);
    // 修复原因：provider 可能忽略 abort 并返回迟到结果；已取消的 selector 不能污染 sticky conversation。
    if (input.abortSignal?.aborted) return emptySelectorResult();
    const parsed = parseSelectorResponse(response.text);
    if (!parsed) return emptySelectorResult();

    const conversation = selectorConversation(input.state);
    input.state.selectorMessages = [
      ...conversation,
      { role: "user", content: `Select memories relevant to:\n${input.query}` },
      { role: "assistant", content: response.text },
    ];
    return parsed;
  } catch {
    return emptySelectorResult();
  }
}

export function filterMemorySelections(input: {
  manifest: readonly MemoryManifestEntry[];
  readFileState?: ReadFileStateMap;
  recalledPaths: ReadonlySet<string>;
  selectedFilenames: readonly string[];
}): MemoryManifestEntry[] {
  const byFilename = new Map(input.manifest.map((entry) => [entry.filename, entry]));
  return input.selectedFilenames
    .map((filename) => byFilename.get(filename))
    .filter((entry): entry is MemoryManifestEntry => entry !== undefined)
    .filter((entry) => !findLatestReadFileState(input.readFileState, entry.filePath))
    .filter((entry) => !input.recalledPaths.has(entry.filePath))
    .slice(0, 5);
}

function selectorConversation(state: MemoryRecallState): ModelInputMessage[] {
  if (state.selectorMessages) return state.selectorMessages;
  const manifest = state.manifest ?? [];
  return [
    {
      role: "user",
      content: `Available memories:\n${formatMemoryManifest(manifest)}`,
      cacheControl: { type: "ephemeral" },
    },
  ];
}

function parseSelectorResponse(text: string): MemorySelectorResult | undefined {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) return undefined;
  if (
    Object.keys(parsed).some(
      (key) => key !== "selected_memories" && key !== "selected_knowledge_ids",
    )
  ) {
    return undefined;
  }
  if (!isStringArray(parsed.selected_memories)) return undefined;
  if (
    parsed.selected_knowledge_ids !== undefined &&
    !isStringArray(parsed.selected_knowledge_ids)
  ) {
    return undefined;
  }
  return {
    selectedMemories: [...parsed.selected_memories],
    selectedKnowledgeIds: parsed.selected_knowledge_ids ? [...parsed.selected_knowledge_ids] : [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function emptySelectorResult(): MemorySelectorResult {
  return {
    selectedKnowledgeIds: [...EMPTY_SELECTOR_RESULT.selectedKnowledgeIds],
    selectedMemories: [...EMPTY_SELECTOR_RESULT.selectedMemories],
  };
}
