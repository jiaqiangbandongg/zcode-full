import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { isAppendOnly } from "./message-continuity.js";
import type {
  DerivedTrajectory,
  DerivedTrajectoryManifest,
  JsonObject,
  OpenAiMessage,
  TrajectoryJsonlEntry,
} from "./types.js";

export type { TrajectoryJsonlEntry } from "./types.js";

const COMPACT_SUMMARY_PREFIXES = [
  "This session is being continued from a previous conversation that ran out of context",
  "This session is being continued from a previous conversation that was compacted",
];

interface RequestSnapshot {
  bodyWithoutMessages: JsonObject;
  messages: OpenAiMessage[];
  requestIndex: number;
  responses: OpenAiMessage[];
}

interface MutableTrajectory {
  bodyWithoutMessages: JsonObject;
  lastRequestIndex: number;
  messages: OpenAiMessage[];
  reason: DerivedTrajectory["reason"];
  requestCount: number;
}

export interface DerivedTrajectoryResult {
  manifest: DerivedTrajectoryManifest;
  trajectories: DerivedTrajectory[];
}

export async function deriveTrajectoriesFromJsonlFile(inputPath: string): Promise<DerivedTrajectoryResult> {
  return deriveTrajectoriesFromEntries(await readTrajectoryJsonl(inputPath));
}

export async function writeDerivedTrajectories(input: {
  ccRequestPath?: string;
  inputPath: string;
  outDir: string;
}): Promise<DerivedTrajectoryResult> {
  const result = await deriveTrajectoriesFromJsonlFile(input.inputPath);
  const trajectoriesDir = join(input.outDir, "trajectories");
  await mkdir(trajectoriesDir, { recursive: true });

  for (const trajectory of result.trajectories) {
    await writeFile(
      join(trajectoriesDir, `${trajectory.id}.openai_request_body.json`),
      `${JSON.stringify(trajectory.requestBody, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(trajectoriesDir, `${trajectory.id}.anthropic_request_body.json`),
      `${JSON.stringify(createAnthropicRequestBody(trajectory), null, 2)}\n`,
      "utf8",
    );
  }

  await writeFile(
    join(input.outDir, "manifest.json"),
    `${JSON.stringify(result.manifest, null, 2)}\n`,
    "utf8",
  );

  if (input.ccRequestPath) {
    const rawDir = join(input.outDir, "raw");
    await mkdir(rawDir, { recursive: true });
    const raw = await readFile(input.ccRequestPath, "utf8");
    await writeFile(join(rawDir, "cc-request-body.raw.json"), raw.endsWith("\n") ? raw : `${raw}\n`);
  }

  return result;
}

export function deriveTrajectoriesFromEntries(
  entries: readonly TrajectoryJsonlEntry[],
): DerivedTrajectoryResult {
  const snapshots = groupRequestSnapshots(entries);
  const mutableTrajectories: MutableTrajectory[] = [];
  let current: MutableTrajectory | undefined;

  for (const snapshot of snapshots) {
    if (!current) {
      current = startTrajectory(snapshot, "initial");
      mutableTrajectories.push(current);
      appendResponses(current, snapshot.responses);
      continue;
    }

    if (isAppendOnly(current.messages, snapshot.messages)) {
      current.messages = cloneMessages(snapshot.messages);
      current.bodyWithoutMessages = cloneJsonObject(snapshot.bodyWithoutMessages);
      current.lastRequestIndex = snapshot.requestIndex;
      current.requestCount += 1;
      appendResponses(current, snapshot.responses);
      continue;
    }

    const reason = containsCompactSummary(snapshot.messages)
      ? "post-compaction"
      : "non-incremental-change";
    current = startTrajectory(snapshot, reason);
    mutableTrajectories.push(current);
    appendResponses(current, snapshot.responses);
  }

  const hasPostCompaction = mutableTrajectories.some(
    (trajectory) => trajectory.reason === "post-compaction",
  );
  const trajectories = mutableTrajectories.map((trajectory, index) =>
    freezeTrajectory(trajectory, index, hasPostCompaction),
  );

  return {
    manifest: {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      trajectories: trajectories.map((trajectory) => ({
        id: trajectory.id,
        lastRequestIndex: trajectory.lastRequestIndex,
        messageCount: trajectory.requestBody.messages.length,
        reason: trajectory.reason,
        requestCount: trajectory.requestCount,
      })),
    },
    trajectories,
  };
}

async function readTrajectoryJsonl(inputPath: string): Promise<TrajectoryJsonlEntry[]> {
  const content = await readFile(inputPath, "utf8");
  return content
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line) as TrajectoryJsonlEntry;
      } catch (error) {
        throw new Error(`Invalid JSONL at ${basename(inputPath)}:${index + 1}`, { cause: error });
      }
    });
}

function groupRequestSnapshots(entries: readonly TrajectoryJsonlEntry[]): RequestSnapshot[] {
  const snapshots = new Map<number, RequestSnapshot>();
  const orderedRequestIndexes: number[] = [];

  for (const entry of entries) {
    if (entry.kind === "request") {
      if (!snapshots.has(entry.requestIndex)) {
        orderedRequestIndexes.push(entry.requestIndex);
      }
      snapshots.set(entry.requestIndex, {
        bodyWithoutMessages: cloneJsonObject(entry.bodyWithoutMessages),
        messages: [],
        requestIndex: entry.requestIndex,
        responses: [],
      });
      continue;
    }

    const snapshot = snapshots.get(entry.requestIndex);
    if (!snapshot) {
      throw new Error(`Message entry references missing requestIndex ${entry.requestIndex}`);
    }

    if (entry.messageIndex === undefined) {
      snapshot.responses.push(cloneMessage(entry.message));
      continue;
    }

    snapshot.messages[entry.messageIndex] = cloneMessage(entry.message);
  }

  return orderedRequestIndexes.map((requestIndex) => {
    const snapshot = snapshots.get(requestIndex);
    if (!snapshot) {
      throw new Error(`Missing request snapshot ${requestIndex}`);
    }
    if (snapshot.messages.some((message) => message === undefined)) {
      throw new Error(`Request ${requestIndex} has sparse message indexes`);
    }
    return snapshot;
  });
}

function startTrajectory(
  snapshot: RequestSnapshot,
  reason: DerivedTrajectory["reason"],
): MutableTrajectory {
  return {
    bodyWithoutMessages: cloneJsonObject(snapshot.bodyWithoutMessages),
    lastRequestIndex: snapshot.requestIndex,
    messages: cloneMessages(snapshot.messages),
    reason,
    requestCount: 1,
  };
}

function appendResponses(trajectory: MutableTrajectory, responses: readonly OpenAiMessage[]): void {
  trajectory.messages.push(...cloneMessages(responses));
}

function freezeTrajectory(
  trajectory: MutableTrajectory,
  index: number,
  hasPostCompaction: boolean,
): DerivedTrajectory {
  const prefix = String(index + 1).padStart(4, "0");
  const suffix =
    trajectory.reason === "initial"
      ? hasPostCompaction && index === 0
        ? "-pre-compaction"
        : ""
      : `-${trajectory.reason}`;

  return {
    id: `${prefix}${suffix}`,
    index: index + 1,
    lastRequestIndex: trajectory.lastRequestIndex,
    reason: trajectory.reason,
    requestBody: createOpenAiRequestBody(trajectory),
    requestCount: trajectory.requestCount,
  };
}

function createOpenAiRequestBody(
  trajectory: MutableTrajectory,
): JsonObject & { messages: OpenAiMessage[] } {
  const bodyWithoutMessages = cloneJsonObject(trajectory.bodyWithoutMessages);
  const {
    model,
    messages: _messages,
    tool_choice: _toolChoice,
    tools,
    ...rest
  } = bodyWithoutMessages;
  const requestBody: JsonObject & { messages: OpenAiMessage[] } = {
    ...(model !== undefined ? { model } : {}),
    messages: cloneMessages(trajectory.messages),
    ...(tools !== undefined ? { tools } : {}),
  };

  for (const [key, value] of Object.entries(rest)) {
    requestBody[key] = value;
  }

  return requestBody;
}

export function createAnthropicRequestBody(
  trajectory: DerivedTrajectory | MutableTrajectory,
): JsonObject & { messages: OpenAiMessage[] } {
  const sourceBody = "requestBody" in trajectory ? trajectory.requestBody : trajectory.bodyWithoutMessages;
  const sourceMessages = "requestBody" in trajectory ? trajectory.requestBody.messages : trajectory.messages;
  const bodyWithoutMessages = cloneJsonObject(sourceBody);
  const {
    model,
    messages: _messages,
    system,
    tools,
    tool_choice: toolChoice,
    ...rest
  } = bodyWithoutMessages;
  const systemBlocks = normalizeAnthropicContentBlocks(system);
  // MCS 下真实 Anthropic body 的 messages 可以保留 role:system，已有顶层 system 时不能再二次提升。
  const messages =
    system !== undefined
      ? sourceMessages.map(toAnthropicProviderMessage)
      : toAnthropicMessages(sourceMessages, systemBlocks);
  const requestBody: JsonObject & { messages: OpenAiMessage[] } = {
    ...(model !== undefined ? { model } : {}),
    ...(systemBlocks.length > 0 ? { system: systemBlocks } : {}),
    messages,
    ...(tools !== undefined ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
  };

  for (const [key, value] of Object.entries(rest)) {
    requestBody[key] = value;
  }

  return requestBody;
}

function toAnthropicProviderMessage(message: OpenAiMessage): OpenAiMessage {
  const clonedMessage = cloneMessage(message);
  if (message.role !== "system") {
    return {
      ...clonedMessage,
      content: normalizeAnthropicContentBlocks(message.content),
    };
  }

  const text = singlePlainTextBlock(message.content);
  // 通用 model-io artifact 必须保留录制 shape；只有生成 Anthropic
  // provider artifact 时，才复现最终 fetch boundary 的 MCS string 投影。
  return text === undefined ? clonedMessage : { ...clonedMessage, content: text };
}

function singlePlainTextBlock(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length !== 1) return undefined;
  const block = value[0];
  if (!block || typeof block !== "object" || Array.isArray(block)) return undefined;
  const record = block as Record<string, unknown>;
  if (record.type !== "text" || typeof record.text !== "string") return undefined;
  if (Object.keys(record).some((key) => key !== "type" && key !== "text")) return undefined;
  return record.text;
}

function toAnthropicMessages(
  messages: readonly OpenAiMessage[],
  systemBlocks: unknown[],
): OpenAiMessage[] {
  const result: OpenAiMessage[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      systemBlocks.push(...normalizeAnthropicContentBlocks(message.content));
      continue;
    }

    const next: OpenAiMessage = {
      ...cloneMessage(message),
      content: normalizeAnthropicContentBlocks(message.content),
    };
    const previous = result.at(-1);
    if (previous?.role === "user" && next.role === "user") {
      previous.content = [
        ...normalizeAnthropicContentBlocks(previous.content),
        ...normalizeAnthropicContentBlocks(next.content),
      ];
      continue;
    }
    result.push(next);
  }

  return result;
}

function normalizeAnthropicContentBlocks(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") return value.length > 0 ? [{ type: "text", text: value }] : [];
  if (Array.isArray(value)) return JSON.parse(JSON.stringify(value)) as unknown[];

  const text = messageText(value);
  return text.length > 0 ? [{ type: "text", text }] : [];
}

function containsCompactSummary(messages: readonly OpenAiMessage[]): boolean {
  return messages.some((message) => {
    const text = messageText(message);
    return COMPACT_SUMMARY_PREFIXES.some((prefix) => text.includes(prefix));
  });
}

function messageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  if (Array.isArray(value)) {
    return value.map(messageText).join("\n");
  }
  const record = value as Record<string, unknown>;
  return [record.text, record.content].map(messageText).join("\n");
}

function cloneMessages(messages: readonly OpenAiMessage[]): OpenAiMessage[] {
  return messages.map(cloneMessage);
}

function cloneMessage(message: OpenAiMessage): OpenAiMessage {
  return JSON.parse(JSON.stringify(message)) as OpenAiMessage;
}

function cloneJsonObject(value: JsonObject): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}
