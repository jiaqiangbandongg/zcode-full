import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import { getZCodeCopy } from "@zcode/i18n";
import { LoginRequiredPanel } from "../src/app-components.js";
import { ContentPane, MessageRow } from "../src/app-transcript-components.js";
import { EmptyTranscriptLogo, ZCODE_LOGO_LINES } from "../src/app-empty-transcript.js";
import { SHIMMER_SWEEP_PERIOD_MS, shimmerTextSegments } from "../src/app-motion.js";
import {
  ShikiDiffView,
  buildDiffRows,
  buildSplitDiffRows,
} from "../src/app-shiki-diff-view.js";
import {
  highlightShikiCodeLines,
  inferShikiLanguage,
  resetShikiHighlighterForTest,
} from "../src/app-shiki-highlighter.js";
import { SIDEBAR_CONTENT_WIDTH, Sidebar } from "../src/app-sidebar.js";
import { moveInputCursorToEnd } from "../src/app-input-pane.js";
import { createSelectionCopyHandler, hasCopyableSelectionText } from "../src/app-copy.js";
import { modelNetworkRequestTargetFromPayload } from "../src/app-event-data.js";
import { appendAgentResult } from "../src/app-submit.js";
import type { Message, SidebarState, ToolTranscriptPart } from "../src/app-model.js";
import {
  applyToolTranscriptEvent,
  formatFileDiffDisplay,
  summarizeToolInput,
} from "../src/app-tool-transcript.js";
import { ToolTranscriptPartView } from "../src/app-tool-components.js";
import { visibleSlashCommandWindow } from "../src/app-input.js";
import { createSelectionState } from "../src/app-selection-state.js";
import { describeSessionEvent, normalizePromptInput } from "../src/state.js";
import type { TuiSlashCommandSuggestion } from "../src/types.js";

const EN_COPY = getZCodeCopy("en-US").tui;
const ZH_COPY = getZCodeCopy("zh-CN").tui;

test("normalizes prompt input for the shell", () => {
  assert.deepEqual(normalizePromptInput("hello"), {
    attachmentCount: 0,
    text: "hello",
  });

  assert.deepEqual(
    normalizePromptInput({
      attachments: [
        {
          path: "/tmp/a.png",
          type: "image",
        },
      ],
      text: "with image",
    }),
    {
      attachmentCount: 1,
      text: "with image",
    },
  );
});

test("describes session events without coupling the shell to business logic", () => {
  assert.equal(describeSessionEvent({ type: "turn_started" } as never), "turn started");
});

test("renders a ZCODE logo placeholder for an empty transcript", () => {
  const [child] = reactElementChildren(
    ContentPane({ copy: EN_COPY, focused: false, messages: [] }),
  );
  const lines = collectTextLines(EmptyTranscriptLogo());

  assert.equal(child?.type, EmptyTranscriptLogo);
  assert.deepEqual(lines, [...ZCODE_LOGO_LINES]);
});

test("centers the empty transcript logo within the available viewport", () => {
  const style = reactElementStyle(EmptyTranscriptLogo());

  assert.equal(style.flexGrow, 1);
  assert.equal(style.justifyContent, "center");
  assert.equal(style.minHeight, ZCODE_LOGO_LINES.length);
});

test("projects logo shimmer without changing the source text", () => {
  const sourceText = ZCODE_LOGO_LINES[0];
  const segments = shimmerTextSegments(sourceText, SHIMMER_SWEEP_PERIOD_MS / 2, {
    baseColor: "#000000",
    highlightColor: "#ffffff",
  });

  assert.equal(segments.map((segment) => segment.text).join(""), sourceText);
  const highlightedSegment = segments.find((segment) => segment.highlighted);
  assert.ok(highlightedSegment);
  assert.notEqual(highlightedSegment.color, "#000000");
});

test("renders the transcript as a borderless surface", () => {
  const style = reactElementStyle(ContentPane({ copy: EN_COPY, focused: false, messages: [] }));

  assert.equal(style.border, false);
  assert.equal(style.backgroundColor, "#0f1419");
});

test("hides the empty transcript logo when messages are present", () => {
  const message: Message = { content: "hello", role: "user" };
  const [child] = reactElementChildren(
    ContentPane({ copy: EN_COPY, focused: false, messages: [message] }),
  );
  const lines = collectTextLines(MessageRow({ copy: EN_COPY, index: 0, message }));

  assert.equal(child?.type, MessageRow);
  assert.notEqual(child?.type, EmptyTranscriptLogo);
  assert.equal(lines.includes(ZCODE_LOGO_LINES[0]), false);
  assert.ok(lines.some((line) => line.includes("hello")));
  assert.equal(
    lines.some((line) => line.includes("User:")),
    false,
  );
});

test("renders a prominent non-modal login notice", () => {
  const lines = collectTextLines(LoginRequiredPanel());
  const textNodes = collectTextNodes(LoginRequiredPanel());

  // 登录提示改为“没有可用模型”，引导用 /model 查看模型或 /login 连接账号。
  assert.ok(lines.some((line) => line.includes("No available models")));
  assert.ok(lines.some((line) => line.includes("/model")));
  assert.ok(textNodes.some((node) => node.style.fg === "#fbbf24"));
});

test("renders localized Chinese login notice copy", () => {
  const lines = collectTextLines(LoginRequiredPanel({ copy: ZH_COPY }));

  assert.ok(lines.some((line) => line.includes("没有可用模型")));
  assert.ok(lines.some((line) => line.includes("输入 /model 查看模型")));
});

test("clears the transcript when a session reset has no restored messages", () => {
  const messages = appendAgentResult(
    [
      { content: "old prompt", role: "user" },
      { content: "old answer", role: "agent" },
      { content: "/new", role: "user" },
    ],
    {
      resetSessionProjection: true,
      response: "Started new session sess_new.",
    },
  );

  assert.deepEqual(messages, [
    {
      content: "Started new session sess_new.",
      role: "agent",
    },
  ]);
});

test("uses restored messages when a session reset carries resumed history", () => {
  const messages = appendAgentResult(
    [
      { content: "old prompt", role: "user" },
      { content: "old answer", role: "agent" },
    ],
    {
      resetSessionProjection: true,
      response: "Resumed session sess_prev.",
      restoredMessages: [
        { content: "resumed prompt", role: "user" },
        { content: "resumed answer", role: "agent" },
      ],
    },
  );

  assert.deepEqual(messages, [
    { content: "resumed prompt", role: "user" },
    { content: "resumed answer", role: "agent" },
    { content: "Resumed session sess_prev.", role: "agent" },
  ]);
});

test("restores resumed thought and tool transcript parts", () => {
  const messages = appendAgentResult(
    [],
    {
      resetSessionProjection: true,
      response: "Resumed session sess_prev.",
      restoredMessages: [
        {
          content: "resumed answer",
          parts: [
            {
              text: "private reasoning",
              type: "thought",
            },
            {
              text: "visible answer",
              type: "text",
            },
            {
              input: { file_path: "/workspace/project/src/app.ts" },
              output: "file contents",
              status: "completed",
              toolCallId: "call-1",
              toolName: "Read",
              type: "tool",
            },
          ],
          role: "agent",
        },
      ],
    },
    { workspaceDirectory: "/workspace/project" },
  );

  assert.deepEqual(messages, [
    {
      content: "resumed answer",
      parts: [
        {
          contentCharCount: "private reasoning".length,
          status: "thought",
          text: "private reasoning",
          type: "thought",
        },
        {
          text: "visible answer",
          type: "text",
        },
        {
          detailLines: [],
          output: "file contents",
          status: "completed",
          title: "Read src/app.ts",
          toolCallId: "call-1",
          toolName: "Read",
          type: "tool",
        },
      ],
      role: "agent",
    },
    {
      content: "Resumed session sess_prev.",
      role: "agent",
    },
  ]);
});

test("restores resumed file diff display payloads", () => {
  const messages = appendAgentResult(
    [],
    {
      resetSessionProjection: true,
      response: "",
      restoredMessages: [
        {
          content: "",
          parts: [
            {
              input: {
                file_path: "/workspace/project/src/app.ts",
                new_string: "new",
                old_string: "old",
              },
              output: "The file has been updated successfully.",
              resultDisplay: {
                additions: 1,
                deletions: 1,
                filePath: "/workspace/project/src/app.ts",
                kind: "file_diff",
                structuredPatch: [
                  {
                    oldStart: 1,
                    oldLines: 1,
                    newStart: 1,
                    newLines: 1,
                    lines: ["-old", "+new"],
                  },
                ],
                truncated: false,
              },
              status: "completed",
              toolCallId: "call-edit",
              toolName: "Edit",
              type: "tool",
            },
          ],
          role: "agent",
        },
      ],
    },
    { workspaceDirectory: "/workspace/project" },
  );

  const toolPart = messages[0]?.parts?.[0] as ToolTranscriptPart | undefined;
  assert.equal(toolPart?.title, "Edit src/app.ts");
  assert.equal(toolPart?.resultDisplay?.filePath, "/workspace/project/src/app.ts");
  assert.ok(toolPart?.resultDisplay?.diff?.includes("@@ -1,1 +1,1 @@"));
  assert.ok(toolPart?.resultDisplay?.lines.some((line) => line.text.includes("   1 -old")));
});

test("renders the product version header and workspace directory footer", () => {
  const workspaceDirectory = `/workspace/${"deep/".repeat(20)}project`;
  const lines = collectTextLines(
    Sidebar({
      ...baseSidebarState,
      copy: EN_COPY,
      workspaceDirectory,
    }),
  );
  const workspaceLine = lines.find((line) => line.startsWith("/workspace/"));

  assert.ok(workspaceLine);
  assert.equal(workspaceLine.length, SIDEBAR_CONTENT_WIDTH);
  assert.match(workspaceLine, /\.\.\.$/);
  assert.ok(lines.includes("ZCode"));
  assert.ok(lines.includes(" 0.0.0"));
});

test("renders localized Chinese TUI copy", () => {
  const lines = collectTextLines(
    Sidebar({
      ...baseSidebarState,
      copy: ZH_COPY,
      status: ZH_COPY.status.ready,
    }),
  );

  assert.ok(lines.includes("状态"));
  assert.ok(lines.some((line) => line.includes("就绪。")));
});

test("moves recalled input history to the buffer end", () => {
  let movedToEnd = false;
  moveInputCursorToEnd({
    gotoBufferEnd: () => {
      movedToEnd = true;
    },
  });

  assert.equal(movedToEnd, true);
});

test("copies selected text exactly and clears OpenTUI selection", async () => {
  let copied = "";
  let clearCount = 0;
  const copySelection = createSelectionCopyHandler({
    clearSelection: () => {
      clearCount += 1;
    },
    getSelectionText: () => "hello\nworld\n",
    writeClipboardText: (text) => {
      copied = text;
    },
  });

  assert.deepEqual(await copySelection(), {
    characterCount: "hello\nworld\n".length,
    kind: "copied",
  });
  assert.equal(copied, "hello\nworld\n");
  assert.equal(clearCount, 1);
});

test("ignores empty selected text and clears the selection", async () => {
  let clearCount = 0;
  const copySelection = createSelectionCopyHandler({
    clearSelection: () => {
      clearCount += 1;
    },
    getSelectionText: () => " \n\t",
    writeClipboardText: () => {
      throw new Error("empty selection should not be copied");
    },
  });

  assert.deepEqual(await copySelection(), { kind: "empty" });
  assert.equal(clearCount, 1);
  assert.equal(hasCopyableSelectionText(" \n\t"), false);
});

test("reports unavailable text clipboard writer", async () => {
  let clearCount = 0;
  const copySelection = createSelectionCopyHandler({
    clearSelection: () => {
      clearCount += 1;
    },
    getSelectionText: () => "copy me",
  });

  assert.deepEqual(await copySelection(), { kind: "unavailable" });
  assert.equal(clearCount, 1);
});

test("keeps the selected slash command inside the visible window", () => {
  const commands: TuiSlashCommandSuggestion[] = Array.from({ length: 8 }, (_, index) => ({
    name: `command-${index}`,
    summary: `summary ${index}`,
    usage: `/command-${index}`,
  }));

  assert.deepEqual(visibleSlashCommandWindow(commands, 5, 6), {
    commands: commands.slice(0, 6),
    selectedIndex: 5,
    startIndex: 0,
  });
  assert.deepEqual(visibleSlashCommandWindow(commands, 6, 6), {
    commands: commands.slice(1, 7),
    selectedIndex: 5,
    startIndex: 1,
  });
  assert.deepEqual(visibleSlashCommandWindow(commands, 99, 6), {
    commands: commands.slice(2, 8),
    selectedIndex: 5,
    startIndex: 2,
  });
});

test("initializes local selection state from command selected index", () => {
  const selection = createSelectionState({
    emptyMessage: "No modes.",
    items: [
      { command: "/mode plan", id: "plan", primary: "Plan" },
      { command: "/mode build", id: "build", primary: "Build" },
    ],
    prompt: "Choose a mode.",
    selectedIndex: 1,
    title: "Switch Mode",
  });

  assert.equal(selection?.filter, "");
  assert.equal(selection?.selectedIndex, 1);
});

test("uses provider endpoint as the model network request target", () => {
  assert.deepEqual(
    modelNetworkRequestTargetFromPayload({
      baseURL: "https://api.deepseek.com",
      model: {
        modelId: "deepseek-chat",
        providerId: "deepseek",
      },
    }),
    {
      model: "deepseek-chat",
      provider: "deepseek",
      url: "https://api.deepseek.com",
    },
  );
});

test("falls back to provider and model when endpoint context is absent", () => {
  assert.deepEqual(
    modelNetworkRequestTargetFromPayload({
      model: {
        modelId: "model-a",
        providerId: "test",
      },
      url: "model",
    }),
    {
      model: "model-a",
      provider: "test",
      url: "test/model-a",
    },
  );
});

test("summarizes Bash tool input without leaking environment values", () => {
  assert.deepEqual(
    summarizeToolInput("Bash", {
      command: "npm test",
      cwd: "packages/tui",
      env: {
        set: {
          API_KEY: "secret-value",
        },
        unset: ["DEBUG"],
      },
    }),
    ["command: npm test", "cwd: packages/tui", "env: set API_KEY; unset DEBUG"],
  );
});

test("summarizes Read tool input with file range", () => {
  assert.deepEqual(
    summarizeToolInput("Read", {
      file_path: "packages/tui/src/app.tsx",
      limit: 40,
      offset: 10,
    }),
    ["offset: 10", "limit: 40"],
  );
});

test("redacts unknown tool input and keeps detail blocks bounded", () => {
  const lines = summarizeToolInput("mcp_server_tool", {
    content: "x".repeat(200),
    nested: { value: true },
    pattern: "needle",
    token: "super-secret",
    url: "https://example.com",
  });

  assert.equal(lines.length, 4);
  assert.equal(lines[0], "content: [200 chars]");
  assert.equal(lines[3], "token: [redacted]");
});

test("projects tool lifecycle events into one transcript part", () => {
  const state = createToolProjectionState();

  state.apply(
    sessionEvent(SessionEventType.ToolCallScheduled, {
      input: {
        command: "npm test",
        cwd: "packages/tui",
      },
      toolCallId: "call-1",
      toolName: "Bash",
    }),
  );
  state.apply(
    sessionEvent(SessionEventType.ToolCallStarted, {
      toolCallId: "call-1",
    }),
  );
  state.apply(
    sessionEvent(SessionEventType.ToolCallResult, {
      duration: 12,
      result: {
        content: "ok",
        success: true,
      },
      toolCallId: "call-1",
    }),
  );

  assert.equal(state.messages.length, 1);
  const part = onlyToolPart(state.messages);
  assert.equal(part.status, "completed");
  assert.equal(part.toolName, "Bash");
  assert.deepEqual(part.detailLines, ["command: npm test", "cwd: packages/tui"]);
});

test("renders file diff with the Shiki diff renderer", () => {
  const resultDisplay = formatFileDiffDisplay({
    additions: 1,
    deletions: 1,
    filePath: "packages/tui/src/app.tsx",
    kind: "file_diff",
    structuredPatch: [
      {
        lines: ["-old", "+new", " context"],
        newLines: 2,
        newStart: 4,
        oldLines: 2,
        oldStart: 4,
      },
    ],
  });

  const view = ToolTranscriptPartView({
    part: {
      detailLines: [],
      resultDisplay,
      status: "completed",
      title: "Edit packages/tui/src/app.tsx",
      toolCallId: "call-1",
      toolName: "Edit",
      type: "tool",
    },
  });
  const lines = collectTextNodes(view);
  const [diffElement] = collectElementsByType(view, ShikiDiffView);

  assert.equal(lines[0]?.text, "Edit packages/tui/src/app.tsx");
  assert.equal(
    lines.some((line) => line.text.startsWith("ok Tool")),
    false,
  );
  assert.equal(
    lines.some((line) => line.text.includes("diff:")),
    false,
  );
  assert.equal(
    lines.some((line) => line.text.includes("@@")),
    false,
  );
  assert.equal(
    lines.some((line) => line.text.includes("file_path:")),
    false,
  );
  assert.equal(diffElement?.props.view, "unified");
  assert.equal(diffElement?.props.filePath, "packages/tui/src/app.tsx");
  assert.deepEqual(diffElement?.props.structuredPatch, resultDisplay.structuredPatch);
  assert.equal(diffElement?.props.truncated, false);
  assert.ok(String(resultDisplay.diff).includes("@@ -4,2 +4,2 @@"));
  assert.ok(resultDisplay.lines.some((line) => line.text.includes("   4 -old")));
  assert.ok(resultDisplay.lines.some((line) => line.text.includes("   4 +new")));
});

test("infers Shiki languages from file diff paths", () => {
  assert.equal(inferShikiLanguage("src/Scene3D.jsx"), "jsx");
  assert.equal(inferShikiLanguage("src/App.tsx"), "tsx");
  assert.equal(inferShikiLanguage("TodoList/TodoItem.swift"), "swift");
  assert.equal(inferShikiLanguage("Dockerfile"), "dockerfile");
  assert.equal(inferShikiLanguage("file.unknown-ext"), undefined);
});

test("highlights Swift file diff content through Shiki", async () => {
  resetShikiHighlighterForTest();

  const highlighted = await highlightShikiCodeLines({
    filePath: "TodoList/TodoItem.swift",
    lines: ["struct TodoItem {", "  var title: String"],
    mode: "dark",
  });

  assert.ok(highlighted);
  assert.equal(highlighted.length, 2);
  assert.ok(highlighted[0]?.some((segment) => segment.text === "struct" && segment.color));
});

test("falls back when Shiki cannot infer a language", async () => {
  const highlighted = await highlightShikiCodeLines({
    filePath: "notes.unknown-ext",
    lines: ["plain text"],
    mode: "dark",
  });

  assert.equal(highlighted, undefined);
});

test("builds split diff rows by pairing adjacent deletions and additions", () => {
  const rows = buildDiffRows([
    {
      lines: [" context", "-old a", "-old b", "+new a", " next"],
      newLines: 3,
      newStart: 10,
      oldLines: 4,
      oldStart: 10,
    },
  ]);

  const splitRows = buildSplitDiffRows(rows);

  assert.equal(splitRows.length, 4);
  assert.equal(splitRows[0]?.left?.content, "context");
  assert.equal(splitRows[1]?.left?.content, "old a");
  assert.equal(splitRows[1]?.right?.content, "new a");
  assert.equal(splitRows[2]?.left?.content, "old b");
  assert.equal(splitRows[2]?.right, undefined);
});

test("renders wide file diff with split view and no text separator", () => {
  const resultDisplay = formatFileDiffDisplay({
    additions: 1,
    deletions: 1,
    filePath: "packages/tui/src/app.tsx",
    kind: "file_diff",
    structuredPatch: [
      {
        lines: ["-old", "+new"],
        newLines: 1,
        newStart: 4,
        oldLines: 1,
        oldStart: 4,
      },
    ],
  });

  const view = ToolTranscriptPartView({
    part: {
      detailLines: [],
      resultDisplay,
      status: "completed",
      title: "Edit packages/tui/src/app.tsx",
      toolCallId: "call-1",
      toolName: "Edit",
      type: "tool",
    },
    terminalWidth: 140,
  });
  const lines = collectTextNodes(view);
  const [diffElement] = collectElementsByType(view, ShikiDiffView);

  assert.equal(diffElement?.props.view, "split");
  assert.equal(
    lines.some((line) => line.text.includes("|")),
    false,
  );
});

const baseSidebarState: SidebarState = {
  busy: false,
  contextUsage: {},
  draft: "",
  lastEvent: "idle",
  messageCount: 1,
  mcpStatus: {
    loading: false,
    servers: {},
  },
  mode: "build",
  model: "openai/gpt-test",
  modifiedFiles: [],
  networkRequests: [],
  status: "Ready.",
  statusDetails: [],
  thoughtLevel: "medium",
  todos: [],
};

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

function collectTextNodes(node: unknown): Array<{ style: Record<string, unknown>; text: string }> {
  const lines: ReturnType<typeof collectTextNodes> = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (typeof value !== "object" || value === null || !("props" in value)) return;
    const element = value as {
      props?: {
        children?: unknown;
        style?: Record<string, unknown>;
      };
      type?: unknown;
    };
    if (element.type === "text") {
      const text = collectTextLines(element.props?.children).join("");
      lines.push({ style: element.props?.style ?? {}, text });
    }
    visit(element.props?.children);
  };

  visit(node);
  return lines;
}

function collectElementsByType(
  node: unknown,
  type: unknown,
): Array<{ props: Record<string, unknown>; type?: unknown }> {
  const elements: ReturnType<typeof collectElementsByType> = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (typeof value !== "object" || value === null || !("props" in value)) return;
    const element = value as {
      props?: {
        children?: unknown;
      } & Record<string, unknown>;
      type?: unknown;
    };
    if (element.type === type) {
      elements.push({ props: element.props ?? {}, type: element.type });
    }
    visit(element.props?.children);
  };

  visit(node);
  return elements;
}

function reactElementChildren(node: unknown): Array<{ type?: unknown }> {
  if (typeof node !== "object" || node === null || !("props" in node)) return [];
  const element = node as { props?: { children?: unknown } };
  const children = element.props?.children;
  if (children === undefined) return [];
  return (Array.isArray(children) ? children : [children]).filter(
    (child): child is { type?: unknown } => typeof child === "object" && child !== null,
  );
}

function reactElementStyle(node: unknown): Record<string, unknown> {
  assert.ok(typeof node === "object" && node !== null && "props" in node);
  const element = node as { props?: { style?: Record<string, unknown> } };
  return element.props?.style ?? {};
}

function createToolProjectionState(): {
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
