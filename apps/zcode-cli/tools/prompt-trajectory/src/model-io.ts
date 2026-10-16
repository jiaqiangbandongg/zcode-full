import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  createAnthropicRequestBody,
  deriveTrajectoriesFromEntries,
  type DerivedTrajectoryResult,
} from "./derive.js";
import { isAppendOnly, isTrajectoryMessageEqual } from "./message-continuity.js";
import type { JsonObject, OpenAiMessage, TrajectoryJsonlEntry } from "./types.js";

const DEFAULT_QUERY_SOURCE = "main_turn";
const SESSION_TITLE_PROMPT_PREFIX = "Generate a concise title for this coding session.";

export interface ModelIoJsonlEntry extends JsonObject {
  querySource?: string;
  request?: ModelIoRequest;
  response?: ModelIoResponse;
  type?: string;
}

interface ModelIoRequest extends JsonObject {
  body?: JsonObject;
  bodyMessageOffset?: number;
  bodyMessagesKind?: string;
  messageOffset?: number;
  messages?: unknown[];
  messagesKind?: string;
  sdkMessageOffset?: number;
  sdkMessages?: unknown[];
  sdkMessagesKind?: string;
}

interface ModelIoResponse extends JsonObject {
  text?: string;
  toolCalls?: unknown[];
}

interface ModelIoToolCall {
  id?: string;
  input?: unknown;
  name?: string;
}

export interface ModelIoTrajectoryOptions {
  querySource?: string;
}

export async function writeModelIoAnthropicTrajectory(input: {
  inputPath: string;
  outDir: string;
  querySource?: string;
}): Promise<DerivedTrajectoryResult> {
  const result = deriveTrajectoriesFromModelIoEntries(await readModelIoJsonl(input.inputPath), {
    querySource: input.querySource,
  });
  if (result.trajectories.length === 0) {
    throw new Error(`No model-io records matched querySource ${input.querySource ?? DEFAULT_QUERY_SOURCE}`);
  }

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
    join(input.outDir, "anthropic_trajectory.json"),
    `${JSON.stringify(createAnthropicRequestBody(result.trajectories[0]!), null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(input.outDir, "manifest.json"),
    `${JSON.stringify(result.manifest, null, 2)}\n`,
    "utf8",
  );

  return result;
}

export function deriveTrajectoriesFromModelIoEntries(
  entries: readonly ModelIoJsonlEntry[],
  options: ModelIoTrajectoryOptions = {},
): DerivedTrajectoryResult {
  const querySource = options.querySource ?? DEFAULT_QUERY_SOURCE;
  const expandedRecords = expandModelIoRecords(
    entries.filter((entry) => entry.type === undefined || entry.type === "model_io"),
  );
  const trajectoryEntries = modelIoRecordsToTrajectoryEntries(
    expandedRecords.filter((record) => modelIoQuerySource(record) === querySource),
  );
  return deriveTrajectoriesFromEntries(trajectoryEntries);
}

async function readModelIoJsonl(inputPath: string): Promise<ModelIoJsonlEntry[]> {
  const content = await readFile(inputPath, "utf8");
  return content
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line) as ModelIoJsonlEntry;
      } catch (error) {
        throw new Error(`Invalid model-io JSONL at ${basename(inputPath)}:${index + 1}`, {
          cause: error,
        });
      }
    });
}

function expandModelIoRecords(entries: readonly ModelIoJsonlEntry[]): ModelIoJsonlEntry[] {
  const expanded: ModelIoJsonlEntry[] = [];
  let previous: ModelIoJsonlEntry | undefined;

  for (const entry of entries) {
    const next = expandModelIoRecord(entry, previous);
    expanded.push(next);
    previous = next;
  }

  return expanded;
}

function expandModelIoRecord(
  entry: ModelIoJsonlEntry,
  previousEntry?: ModelIoJsonlEntry,
): ModelIoJsonlEntry {
  const request = asRecord(entry.request);
  if (!request) {
    return cloneJsonObject(entry) as ModelIoJsonlEntry;
  }

  return {
    ...cloneJsonObject(entry),
    request: expandModelIoRequest(request, asRecord(previousEntry?.request)),
  };
}

function expandModelIoRequest(
  request: Record<string, unknown>,
  previousRequest?: Record<string, unknown>,
): ModelIoRequest {
  const next = { ...cloneJsonObject(request) } as ModelIoRequest;
  expandMessageCollection(next, previousRequest, {
    collectionKey: "messages",
    kindKey: "messagesKind",
    offsetKey: "messageOffset",
  });
  expandMessageCollection(next, previousRequest, {
    collectionKey: "sdkMessages",
    kindKey: "sdkMessagesKind",
    offsetKey: "sdkMessageOffset",
  });

  const body = asRecord(next.body);
  if (body) {
    const nextBody = { ...cloneJsonObject(body) } as JsonObject;
    expandMessageCollection(
      nextBody,
      asRecord(asRecord(previousRequest?.body)),
      {
        collectionKey: "messages",
        kindKey: "bodyMessagesKind",
        offsetKey: "bodyMessageOffset",
      },
      next,
    );
    next.body = nextBody;
  }

  return next;
}

function expandMessageCollection(
  target: JsonObject,
  previous: Record<string, unknown> | undefined,
  keys: {
    collectionKey: string;
    kindKey: string;
    offsetKey: string;
  },
  metadataSource: JsonObject = target,
): void {
  if (metadataSource[keys.kindKey] !== "delta") {
    return;
  }
  const deltaMessages = target[keys.collectionKey];
  const previousMessages = previous?.[keys.collectionKey];
  const offset = asNonNegativeInteger(metadataSource[keys.offsetKey]);
  if (!Array.isArray(deltaMessages) || !Array.isArray(previousMessages) || offset === undefined) {
    return;
  }

  target[keys.collectionKey] = [
    ...cloneArray(previousMessages.slice(0, offset)),
    ...cloneArray(deltaMessages),
  ];
}

function modelIoRecordsToTrajectoryEntries(
  records: readonly ModelIoJsonlEntry[],
): TrajectoryJsonlEntry[] {
  const entries: TrajectoryJsonlEntry[] = [];
  let requestIndex = 0;
  const requests = records.flatMap((record) => {
    const body = asRecord(record.request?.body);
    return body ? [{ body, response: record.response }] : [];
  });

  for (const [recordIndex, { body, response }] of requests.entries()) {
    const messages = body.messages;
    if (!Array.isArray(messages)) {
      throw new Error("model-io request.body must contain a messages array.");
    }

    requestIndex += 1;
    const { messages: _messages, ...bodyWithoutMessages } = cloneJsonObject(body);
    entries.push({
      bodyWithoutMessages,
      kind: "request",
      requestIndex,
    });

    for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
      const message = messages[messageIndex];
      if (!isOpenAiMessage(message)) {
        throw new Error(`model-io request message ${messageIndex} is missing role.`);
      }
      entries.push({
        kind: "message",
        message: cloneJsonObject(message) as OpenAiMessage,
        messageIndex,
        requestIndex,
      });
    }

    const assistantMessage = assistantMessageFromModelIoResponse(response);
    if (assistantMessage) {
      entries.push({
        kind: "message",
        message: completeAssistantMessage(
          assistantMessage,
          messages as OpenAiMessage[],
          requests[recordIndex + 1]?.body.messages,
        ),
        requestIndex,
      });
    }
  }

  return entries;
}

function completeAssistantMessage(
  summary: OpenAiMessage,
  previous: readonly OpenAiMessage[],
  next: unknown,
): OpenAiMessage {
  if (!Array.isArray(next) || !next.every(isOpenAiMessage) || !isAppendOnly(previous, next)) {
    return summary;
  }
  const recorded = next[previous.length];
  if (recorded?.role !== "assistant" || !Array.isArray(recorded.content)) return summary;
  // response 摘要没有完整 thinking/签名，直接比较会误分段。
  // 只从前缀连续且正文/工具完全匹配的下一请求补全；已有历史的 thinking 仍严格比较。
  const comparable = {
    ...recorded,
    content: recorded.content.filter((block: unknown) => {
      const type = asRecord(block)?.type;
      return type !== "thinking" && type !== "redacted_thinking";
    }),
  };
  return isTrajectoryMessageEqual(summary, comparable)
    ? (cloneJsonObject(recorded) as OpenAiMessage)
    : summary;
}

function assistantMessageFromModelIoResponse(
  response: ModelIoResponse | undefined,
): OpenAiMessage | undefined {
  if (!response) {
    return undefined;
  }

  const content: unknown[] = [];
  if (typeof response.text === "string" && response.text.length > 0) {
    content.push({ type: "text", text: response.text });
  }

  for (const toolCall of normalizedToolCalls(response.toolCalls)) {
    content.push({
      type: "tool_use",
      id: toolCall.id,
      name: toolCall.name,
      input: cloneJsonValue(toolCall.input ?? {}),
    });
  }

  return content.length > 0 ? { role: "assistant", content } : undefined;
}

function normalizedToolCalls(value: unknown[] | undefined): ModelIoToolCall[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((raw) => {
    const toolCall = asRecord(raw);
    if (!toolCall) {
      return [];
    }
    const id = typeof toolCall?.id === "string" ? toolCall.id : undefined;
    const name = typeof toolCall?.name === "string" ? toolCall.name : undefined;
    if (!id || !name) {
      return [];
    }
    return [{ id, input: toolCall.input, name }];
  });
}

function modelIoQuerySource(record: ModelIoJsonlEntry): string {
  if (typeof record.querySource === "string") {
    return record.querySource;
  }

  const messages = asRecord(record.request?.body)?.messages;
  const firstMessage = Array.isArray(messages) ? asRecord(messages[0]) : undefined;
  if (firstMessage?.role === "system" || firstMessage?.role === "user") {
    const text = messageText(firstMessage.content);
    if (text.startsWith(SESSION_TITLE_PROMPT_PREFIX)) {
      return "session_title";
    }
  }

  return DEFAULT_QUERY_SOURCE;
}

function messageText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!value || typeof value !== "object") {
    return "";
  }
  if (Array.isArray(value)) {
    return value.map(messageText).join("\n");
  }
  const record = value as Record<string, unknown>;
  return [record.text, record.content].map(messageText).join("\n");
}

function isOpenAiMessage(value: unknown): value is OpenAiMessage {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { role?: unknown }).role === "string",
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function cloneArray(value: readonly unknown[]): unknown[] {
  return JSON.parse(JSON.stringify(value)) as unknown[];
}

function cloneJsonObject(value: Record<string, unknown>): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function cloneJsonValue(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}
