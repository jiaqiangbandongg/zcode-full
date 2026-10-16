import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import type React from "react";
import type { Message, ToolResultDisplay, ToolTranscriptPart } from "./app-model.js";
import { formatFileDiffDisplay } from "./app-tool-diff-display.js";
import { formatToolFilePath } from "./app-tool-path-display.js";
import { truncateDisplay } from "./app-terminal-width.js";
import { asRecord, booleanField, stringField } from "./state.js";

const MAX_DETAIL_LINES = 4;
const MAX_DETAIL_WIDTH = 100;
const SENSITIVE_KEY_PATTERN = /token|secret|password|api[_-]?key|authorization|credential|cookie/i;
const LARGE_TEXT_KEYS = new Set(["content", "old_string", "new_string"]);

export { formatFileDiffDisplay } from "./app-tool-diff-display.js";

type ToolTranscriptHandlers = {
  assistantMessageIdsByToolCallId?: Map<string, string>;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  toolNamesById: Map<string, string>;
  workspaceDirectory?: string;
};

type ToolTranscriptInputProjection = {
  detailLines: string[];
  title?: string;
};

export function applyToolTranscriptEvent(
  event: SessionEvent,
  handlers: ToolTranscriptHandlers,
): void {
  const payload = asRecord(event.payload);
  const toolCallId = stringField(payload, "toolCallId");
  if (!toolCallId) return;

  const toolName = toolNameFromPayload(payload, handlers.toolNamesById);
  handlers.toolNamesById.set(toolCallId, toolName);
  const assistantMessageId = handlers.assistantMessageIdsByToolCallId?.get(toolCallId);

  if (event.type === SessionEventType.ToolCallScheduled) {
    const input = "input" in payload ? payload.input : undefined;
    const projection = buildToolTranscriptProjection(toolName, input, handlers.workspaceDirectory);
    const part: ToolTranscriptPart = {
      detailLines: projection.detailLines,
      status: "pending",
      title: projection.title,
      toolCallId,
      toolName,
      type: "tool",
    };
    handlers.setMessages((current) => upsertToolPart(current, part, assistantMessageId));
    return;
  }

  if (
    event.type === SessionEventType.ToolCallStarted ||
    event.type === SessionEventType.ToolCallProgress
  ) {
    handlers.setMessages((current) =>
      updateOrAppendToolPart(
        current,
        toolCallId,
        toolName,
        { status: "running" },
        assistantMessageId,
      ),
    );
    return;
  }

  if (event.type === SessionEventType.ToolCallResult) {
    handlers.setMessages((current) =>
      updateOrAppendToolPart(
        current,
        toolCallId,
        toolName,
        {
          resultDisplay: resultDisplayFromPayload(payload),
          status: "completed",
        },
        assistantMessageId,
      ),
    );
    return;
  }

  if (event.type === SessionEventType.ToolCallError) {
    handlers.setMessages((current) =>
      updateOrAppendToolPart(
        current,
        toolCallId,
        toolName,
        {
          error: eventErrorMessage(payload),
          status: "failed",
        },
        assistantMessageId,
      ),
    );
  }
}

export function summarizeToolInput(toolName: string, input: unknown): string[] {
  return buildToolTranscriptProjection(toolName, input).detailLines;
}

export function buildToolTranscriptProjection(
  toolName: string,
  input: unknown,
  workspaceDirectory?: string,
): ToolTranscriptInputProjection {
  const record = asRecord(input);
  const normalized = toolName.toLowerCase();

  if (normalized === "bash") return { detailLines: bashDetails(record) };
  if (normalized === "read") {
    return readDetails(record, workspaceDirectory);
  }
  if (normalized === "write") {
    return { detailLines: fileMutationDetails(record) };
  }
  if (normalized === "edit") return editDetails(record, workspaceDirectory);
  if (normalized === "grep") return { detailLines: grepDetails(record) };
  if (normalized === "glob")
    return {
      detailLines: compactLines([fieldLine(record, "pattern"), fieldLine(record, "path")]),
    };
  if (normalized === "webfetch") return { detailLines: webFetchDetails(record) };
  if (normalized === "todowrite") return { detailLines: todoWriteDetails(record) };
  if (normalized === "todoread") return { detailLines: ["todos: read current state"] };
  if (normalized === "agent") return { detailLines: agentDetails(record) };
  if (normalized === "skill")
    return {
      detailLines: compactLines([fieldLine(record, "name"), fieldLine(record, "args")]),
    };

  return { detailLines: genericInputDetails(record) };
}

function upsertToolPart(
  messages: Message[],
  part: ToolTranscriptPart,
  assistantMessageId?: string,
): Message[] {
  let found = false;
  const updated = messages.map((message) => {
    if (!message.parts) return message;
    const parts = message.parts.map((item) => {
      if (item.type !== "tool" || item.toolCallId !== part.toolCallId) return item;
      found = true;
      return { ...item, ...part };
    });
    return found ? { ...message, parts } : message;
  });

  if (found) return updated;
  if (assistantMessageId) {
    let inserted = false;
    const withAssistantMessage = updated.map((message) => {
      if (message.id !== assistantMessageId) return message;
      inserted = true;
      return {
        ...message,
        parts: [...(message.parts ?? []), part],
        streamProjected: true,
      };
    });
    if (inserted) return withAssistantMessage;
    return [
      ...updated,
      {
        content: "",
        id: assistantMessageId,
        parts: [part],
        role: "agent",
        streamProjected: true,
        streaming: true,
      },
    ];
  }
  const last = updated.at(-1);
  if (last?.role === "agent" && (last.parts || last.content.length === 0)) {
    return [...updated.slice(0, -1), { ...last, parts: [...(last.parts ?? []), part] }];
  }
  return [...updated, { content: "", parts: [part], role: "agent" }];
}

function updateOrAppendToolPart(
  messages: Message[],
  toolCallId: string,
  toolName: string,
  patch: Partial<Omit<ToolTranscriptPart, "toolCallId" | "toolName" | "type">>,
  assistantMessageId?: string,
): Message[] {
  let found = false;
  const updated = messages.map((message) => {
    if (!message.parts) return message;
    const parts = message.parts.map((part) => {
      if (part.type !== "tool" || part.toolCallId !== toolCallId) return part;
      found = true;
      return { ...part, toolName, ...patch };
    });
    return found ? { ...message, parts } : message;
  });

  if (found) return updated;
  return upsertToolPart(
    updated,
    {
      detailLines: [],
      status: patch.status ?? "pending",
      toolCallId,
      toolName,
      type: "tool",
      ...(patch.error ? { error: patch.error } : {}),
      ...(patch.resultDisplay ? { resultDisplay: patch.resultDisplay } : {}),
    },
    assistantMessageId,
  );
}

function resultDisplayFromPayload(payload: Record<string, unknown>): ToolResultDisplay | undefined {
  const result = asRecord(payload.result);
  const display = asRecord(result.display);
  if (stringField(display, "kind") !== "file_diff") return undefined;
  return formatFileDiffDisplay(display);
}

function toolNameFromPayload(
  payload: Record<string, unknown>,
  toolNamesById: Map<string, string>,
): string {
  const toolCallId = stringField(payload, "toolCallId");
  return (
    stringField(payload, "toolName") ??
    (toolCallId ? toolNamesById.get(toolCallId) : undefined) ??
    "tool"
  );
}

function bashDetails(record: Record<string, unknown>): string[] {
  const argv = asRecord(record.argv);
  const argvFile = stringField(argv, "file");
  const argvArgs = stringArrayField(argv, "args");
  return compactLines([
    fieldLine(record, "command"),
    fieldLine(record, "cwd"),
    argvFile ? `argv: ${previewText([argvFile, ...argvArgs].join(" "))}` : undefined,
    fieldLine(record, "timeout"),
    booleanField(record, "run_in_background") ? "background: true" : undefined,
    bashEnvLine(record),
  ]);
}

function readDetails(
  record: Record<string, unknown>,
  workspaceDirectory: string | undefined,
): ToolTranscriptInputProjection {
  const displayPath = formatToolFilePath(stringField(record, "file_path"), workspaceDirectory);
  return {
    detailLines: compactLines([
      fieldLine(record, "offset"),
      fieldLine(record, "limit"),
      fieldLine(record, "pages"),
    ]),
    ...(displayPath ? { title: `Read ${displayPath}` } : {}),
  };
}

function fileMutationDetails(record: Record<string, unknown>): string[] {
  return compactLines([
    fieldLine(record, "file_path"),
    fieldLine(record, "offset"),
    fieldLine(record, "limit"),
    fieldLine(record, "pages"),
    fieldLine(record, "replace_all"),
  ]);
}

function editDetails(
  record: Record<string, unknown>,
  workspaceDirectory: string | undefined,
): ToolTranscriptInputProjection {
  const displayPath = formatToolFilePath(stringField(record, "file_path"), workspaceDirectory);
  // 旧展示重复输出 file_path、replace_all 和 diff 元信息，窄终端会挤占真正变更内容；路径收进标题，详情留给 diff 行。
  return {
    detailLines: compactLines([
      fieldLine(record, "offset"),
      fieldLine(record, "limit"),
      fieldLine(record, "pages"),
    ]),
    ...(displayPath ? { title: `Edit ${displayPath}` } : {}),
  };
}

function grepDetails(record: Record<string, unknown>): string[] {
  return compactLines([
    fieldLine(record, "pattern"),
    fieldLine(record, "path"),
    fieldLine(record, "glob"),
    combinedLine(record, "mode", ["output_mode", "type", "head_limit", "offset"]),
  ]);
}

function webFetchDetails(record: Record<string, unknown>): string[] {
  return compactLines([fieldLine(record, "url"), previewLine(record, "prompt")]);
}

function todoWriteDetails(record: Record<string, unknown>): string[] {
  const todos = arrayField(record, "todos").map(asRecord);
  const inProgress = todos.find((todo) => stringField(todo, "status") === "in_progress");
  return compactLines([
    `todos: ${todos.length}`,
    inProgress
      ? `in_progress: ${previewText(stringField(inProgress, "content") ?? "")}`
      : undefined,
  ]);
}

function agentDetails(record: Record<string, unknown>): string[] {
  return compactLines([
    fieldLine(record, "description"),
    fieldLine(record, "subagent_type"),
    booleanField(record, "run_in_background") ? "background: true" : undefined,
    previewLine(record, "prompt"),
  ]);
}

function genericInputDetails(record: Record<string, unknown>): string[] {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (lines.length >= MAX_DETAIL_LINES) break;
    lines.push(`${key}: ${previewValue(key, value)}`);
  }
  return lines;
}

function bashEnvLine(record: Record<string, unknown>): string | undefined {
  const env = asRecord(record.env);
  if (Object.keys(env).length === 0) return undefined;
  const setNames = Object.keys(asRecord(env.set));
  const unsetNames = stringArrayField(env, "unset");
  const changes = compactLines([
    setNames.length > 0 ? `set ${setNames.join(",")}` : undefined,
    unsetNames.length > 0 ? `unset ${unsetNames.join(",")}` : undefined,
  ]).join("; ");
  return changes ? `env: ${changes}` : undefined;
}

function fieldLine(record: Record<string, unknown>, key: string): string | undefined {
  if (!(key in record)) return undefined;
  return `${key}: ${previewValue(key, record[key])}`;
}

function previewLine(record: Record<string, unknown>, key: string): string | undefined {
  const value = stringField(record, key);
  return value ? `${key}: ${previewText(value)}` : undefined;
}

function combinedLine(
  record: Record<string, unknown>,
  label: string,
  keys: readonly string[],
): string | undefined {
  const fields = keys.flatMap((key) => {
    if (!(key in record)) return [];
    return `${key}=${previewValue(key, record[key])}`;
  });
  return fields.length > 0 ? `${label}: ${fields.join(", ")}` : undefined;
}

function compactLines(lines: Array<string | undefined>): string[] {
  return lines
    .filter((line): line is string => Boolean(line))
    .map((line) => truncateDisplay(line, MAX_DETAIL_WIDTH))
    .slice(0, MAX_DETAIL_LINES);
}

function previewValue(key: string, value: unknown): string {
  if (SENSITIVE_KEY_PATTERN.test(key)) return "[redacted]";
  if (typeof value === "string") {
    if (LARGE_TEXT_KEYS.has(key)) return `[${value.length} chars]`;
    return previewText(value);
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.length} items]`;
  if (value && typeof value === "object") return `{${Object.keys(value).length} keys}`;
  return String(value);
}

function previewText(value: string): string {
  return truncateDisplay(value.replace(/\s+/g, " ").trim(), MAX_DETAIL_WIDTH);
}

function eventErrorMessage(payload: Record<string, unknown>): string {
  const error = asRecord(payload.error);
  return stringField(error, "message") ?? stringField(payload, "reason") ?? "Tool failed";
}

function arrayField(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

function stringArrayField(record: Record<string, unknown>, key: string): string[] {
  return arrayField(record, key).filter((item): item is string => typeof item === "string");
}
