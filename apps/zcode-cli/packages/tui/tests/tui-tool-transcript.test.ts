import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import type { Message, ToolTranscriptPart } from "../src/app-model.js";
import {
  applyToolTranscriptEvent,
  buildToolTranscriptProjection,
} from "../src/app-tool-transcript.js";
import { formatToolFilePath } from "../src/app-tool-path-display.js";
import { ToolTranscriptPartView } from "../src/app-tool-components.js";

test("formats Read paths relative to the workspace", () => {
  assert.equal(
    formatToolFilePath("/workspace/project/src/App.jsx", "/workspace/project"),
    "src/App.jsx",
  );
  assert.equal(
    formatToolFilePath("/workspace/other/App.jsx", "/workspace/project"),
    "/workspace/other/App.jsx",
  );
  assert.equal(
    formatToolFilePath("../other/App.jsx", "/workspace/project"),
    "/workspace/other/App.jsx",
  );
  assert.equal(formatToolFilePath("src/App.jsx", "/workspace/project"), "src/App.jsx");
});

test("formats Windows Read paths relative to the workspace", () => {
  assert.equal(formatToolFilePath("C:\\repo\\src\\App.jsx", "C:\\repo"), "src\\App.jsx");
  assert.equal(formatToolFilePath("D:\\other\\App.jsx", "C:\\repo"), "D:\\other\\App.jsx");
});

test("builds a Read title while keeping range details below it", () => {
  const projection = buildToolTranscriptProjection(
    "Read",
    {
      file_path: "/workspace/project/src/App.jsx",
      limit: 40,
      offset: 10,
    },
    "/workspace/project",
  );

  assert.equal(projection.title, "Read src/App.jsx");
  assert.deepEqual(projection.detailLines, ["offset: 10", "limit: 40"]);
});

test("builds an Edit title and omits duplicated file mutation fields", () => {
  const projection = buildToolTranscriptProjection(
    "Edit",
    {
      file_path: "/workspace/project/src/App.jsx",
      old_string: "old",
      new_string: "new",
      replace_all: false,
    },
    "/workspace/project",
  );

  assert.equal(projection.title, "Edit src/App.jsx");
  assert.deepEqual(projection.detailLines, []);
});

test("keeps workspace-external Edit paths absolute", () => {
  const projection = buildToolTranscriptProjection(
    "Edit",
    {
      file_path: "/workspace/other/App.jsx",
      old_string: "old",
      new_string: "new",
    },
    "/workspace/project",
  );

  assert.equal(projection.title, "Edit /workspace/other/App.jsx");
});

test("renders Read errors under the path title with error styling", () => {
  const state = createToolProjectionState("/workspace/project");
  state.apply(
    sessionEvent(SessionEventType.ToolCallScheduled, {
      input: {
        file_path: "/workspace/project/does-not-exist.js",
      },
      toolCallId: "call-1",
      toolName: "Read",
    }),
  );
  state.apply(
    sessionEvent(SessionEventType.ToolCallError, {
      error: {
        message: "File not found: /workspace/project/does-not-exist.js",
        type: "not_found",
      },
      toolCallId: "call-1",
    }),
  );

  const part = onlyToolPart(state.messages);
  assert.equal(part.title, "Read does-not-exist.js");
  assert.equal(part.status, "failed");
  assert.equal(part.error, "File not found: /workspace/project/does-not-exist.js");

  const lines = collectTextNodes(ToolTranscriptPartView({ part }));
  assert.equal(lines[0]?.text, "Read does-not-exist.js");
  assert.equal(lines[0]?.style.fg, "#94a3b8");
  assert.equal(lines[1]?.text, "File not found: /workspace/project/does-not-exist.js");
  assert.equal(lines[1]?.style.fg, "#fca5a5");
});

test("renders tool rows without a global left gutter", () => {
  const part: ToolTranscriptPart = {
    detailLines: ["command: npm test", "cwd: packages/tui"],
    status: "running",
    toolCallId: "call-1",
    toolName: "Bash",
    type: "tool",
  };

  const view = ToolTranscriptPartView({ part });
  const lines = collectTextNodes(view);

  assert.equal((view.props.style as Record<string, unknown>).paddingLeft, undefined);
  assert.equal(lines[0]?.text, "Tool Bash running");
  assert.equal(lines[1]?.text, "  command: npm test");
  assert.equal(lines[2]?.text, "  cwd: packages/tui");
});

function createToolProjectionState(workspaceDirectory: string): {
  apply: (event: SessionEvent) => void;
  messages: Message[];
} {
  const state: { messages: Message[] } = { messages: [] };
  const toolNamesById = new Map<string, string>();
  return {
    apply: (event) => {
      applyToolTranscriptEvent(event, {
        setMessages: (updater) => {
          state.messages = typeof updater === "function" ? updater(state.messages) : updater;
        },
        toolNamesById,
        workspaceDirectory,
      });
    },
    get messages() {
      return state.messages;
    },
  };
}

function onlyToolPart(messages: Message[]): ToolTranscriptPart {
  const part = messages[0]?.parts?.[0];
  assert.equal(part?.type, "tool");
  return part;
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

function collectTextNodes(node: unknown): Array<{ style: Record<string, unknown>; text: string }> {
  const lines: ReturnType<typeof collectTextNodes> = [];
  const visit = (value: unknown) => {
    if (typeof value === "string") {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((child) => visit(child)).join("");
    }
    if (typeof value !== "object" || value === null || !("props" in value)) return "";
    const element = value as {
      props?: {
        children?: unknown;
        style?: Record<string, unknown>;
      };
      type?: unknown;
    };
    const text = visit(element.props?.children);
    if (element.type === "text") {
      lines.push({ style: element.props?.style ?? {}, text });
    }
    return text;
  };

  visit(node);
  return lines;
}
