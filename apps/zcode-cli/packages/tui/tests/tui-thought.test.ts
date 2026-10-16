import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import { getZCodeCopy } from "@zcode/i18n";
import { applySessionEventToState } from "../src/app-events.js";
import type { Message, ThoughtTranscriptPart } from "../src/app-model.js";
import {
  ThoughtTranscriptPartFrame,
  thoughtPlaceholderLabel,
} from "../src/app-thought-components.js";

const EN_COPY = getZCodeCopy("en-US").tui;

test("projects streamed reasoning as an expandable thought placeholder", () => {
  const state = createSessionEventState();

  state.apply(
    sessionEvent(SessionEventType.ModelStreaming, {
      assistantMessageId: "assistant-1",
      delta: "private thinking",
      kind: "reasoning_delta",
    }),
  );

  const part = onlyThoughtPart(state.messages);
  assert.equal(part.status, "thinking");
  assert.equal(part.text, "private thinking");
  assert.equal(part.contentCharCount, "private thinking".length);
  assert.equal(state.messages[0]?.content.includes("private thinking"), false);

  state.apply(
    sessionEvent(SessionEventType.ModelStreaming, {
      assistantMessageId: "assistant-1",
      delta: "",
      kind: "reasoning_end",
    }),
  );

  assert.equal(onlyThoughtPart(state.messages).status, "thought");
});

test("does not create a thought placeholder for an empty reasoning start", () => {
  const state = createSessionEventState();

  state.apply(
    sessionEvent(SessionEventType.ModelStreaming, {
      assistantMessageId: "assistant-1",
      delta: "",
      kind: "reasoning_start",
    }),
  );

  assert.deepEqual(state.messages, []);
});

test("marks an active thought complete when the stream finishes", () => {
  const state = createSessionEventState();

  state.apply(
    sessionEvent(SessionEventType.ModelStreaming, {
      assistantMessageId: "assistant-1",
      delta: "hidden",
      kind: "reasoning_delta",
    }),
  );
  state.apply(
    sessionEvent(SessionEventType.ModelStreaming, {
      assistantMessageId: "assistant-1",
      delta: "",
      done: true,
      kind: "finish",
    }),
  );

  assert.equal(onlyThoughtPart(state.messages).status, "thought");
  assert.equal(state.messages[0]?.streaming, false);
});

test("keeps thought text and tool parts in stream order", () => {
  const state = createSessionEventState();

  state.apply(
    sessionEvent(SessionEventType.ModelStreaming, {
      assistantMessageId: "assistant-1",
      delta: "hidden",
      kind: "reasoning_delta",
    }),
  );
  state.apply(
    sessionEvent(SessionEventType.ModelStreaming, {
      assistantMessageId: "assistant-1",
      delta: "",
      kind: "reasoning_end",
    }),
  );
  state.apply(
    sessionEvent(SessionEventType.ModelStreaming, {
      assistantMessageId: "assistant-1",
      delta: "Visible answer.",
      kind: "text_delta",
    }),
  );
  state.apply(
    sessionEvent(SessionEventType.ModelStreaming, {
      assistantMessageId: "assistant-1",
      delta: "",
      kind: "tool_call",
      toolCallId: "call-1",
      toolName: "Read",
    }),
  );
  state.apply(
    sessionEvent(SessionEventType.ToolCallScheduled, {
      input: { file_path: "package.json" },
      toolCallId: "call-1",
      toolName: "Read",
    }),
  );

  assert.deepEqual(
    state.messages[0]?.parts?.map((part) => part.type),
    ["thought", "text", "tool"],
  );
});

test("renders expanded thought content with plus and minus markers", () => {
  const part: ThoughtTranscriptPart = {
    contentCharCount: 14,
    status: "thought",
    text: "private thinking",
    type: "thought",
  };
  const frame = ThoughtTranscriptPartFrame({
    copy: EN_COPY,
    expanded: true,
    onToggle: () => {},
    part,
  });
  const lines = collectTextLines(frame);

  assert.equal(thoughtPlaceholderLabel(part, EN_COPY), "Thought");
  assert.ok(lines.some((line) => line.includes("- Thought")));
  assert.ok(lines.some((line) => line.includes("private thinking")));
  assert.equal(lines.some((line) => line.includes("hidden")), false);
  assert.equal(collectRootStyle(frame).marginBottom, 1);
});

function createSessionEventState(): {
  apply: (event: SessionEvent) => void;
  messages: Message[];
} {
  const state: { messages: Message[] } = { messages: [] };
  const assistantMessageIdsByToolCallId = new Map<string, string>();
  const toolNamesById = new Map<string, string>();

  return {
    apply: (event) => {
      applySessionEventToState(event, {
        assistantMessageIdsByToolCallId,
        setActiveTurnId: () => {},
        setCacheStats: () => {},
        setContextUsage: () => {},
        setLastError: () => {},
        setLiveModelText: () => {},
        setMessages: (updater) => {
          state.messages = typeof updater === "function" ? updater(state.messages) : updater;
        },
        setModel: () => {},
        setNetworkRequests: () => {},
        setStatus: () => {},
        setTodos: () => {},
        setUsage: () => {},
        toolNamesById,
      });
    },
    get messages() {
      return state.messages;
    },
  };
}

function onlyThoughtPart(messages: Message[]): ThoughtTranscriptPart {
  const part = messages[0]?.parts?.[0];
  assert.equal(part?.type, "thought");
  return part;
}

function collectTextLines(node: unknown): string[] {
  const lines: string[] = [];
  const visit = (value: unknown) => {
    if (typeof value === "string") {
      lines.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (typeof value === "object" && value !== null && "props" in value) {
      const element = value as { props?: { children?: unknown } };
      visit(element.props?.children);
    }
  };

  visit(node);
  return lines;
}

function collectRootStyle(node: unknown): Record<string, unknown> {
  assert.equal(typeof node, "object");
  assert.notEqual(node, null);
  assert.ok("props" in node);
  const element = node as { props?: { style?: Record<string, unknown> } };
  return element.props?.style ?? {};
}

function sessionEvent(type: SessionEventType, payload: unknown): SessionEvent {
  return {
    id: "event-1",
    payload,
    sequenceNumber: 1,
    sessionId: "session-1",
    timestamp: new Date(0),
    traceId: "trace-1",
    type,
  } as SessionEvent;
}
