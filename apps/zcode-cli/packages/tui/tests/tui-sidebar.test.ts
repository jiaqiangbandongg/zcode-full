import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { AppShell } from "../src/app-components.js";
import { SIDEBAR_CONTENT_WIDTH, Sidebar } from "../src/app-sidebar.js";
import {
  DEFAULT_SIDEBAR_STATE,
  SIDEBAR_OVERLAY_BACKGROUND,
  SIDEBAR_WIDTH,
  sidebarLayoutForTerminal,
  toggleSidebarSectionState,
  toggleSidebarState,
} from "../src/app-sidebar-layout.js";
import { createSidebarShortcutState, resolveSidebarShortcut } from "../src/app-sidebar-shortcut.js";
import type { SidebarState } from "../src/app-model.js";

test("uses the responsive sidebar width from the v2 layout contract", () => {
  assert.equal(SIDEBAR_WIDTH, 42);
  assert.equal(SIDEBAR_CONTENT_WIDTH, 40);
});

test("renders as a borderless background block", () => {
  const style = reactElementStyle(Sidebar(baseSidebarState));

  assert.equal(style.border, false);
  assert.equal(style.backgroundColor, "#1f2937");
});

test("splits the current provider and model rows in the run section", () => {
  const lines = collectTextLines(
    Sidebar({
      ...baseSidebarState,
      developerMode: true,
      model: "gateway/openai/gpt-5.5",
    }),
  );

  assert.ok(lines.includes("Provider  gateway"));
  assert.ok(lines.includes("Model     openai/gpt-5.5"));
});

test("uses a blank provider placeholder for bare model ids", () => {
  const lines = collectTextLines(
    Sidebar({
      ...baseSidebarState,
      developerMode: true,
      model: "glm-4.6",
    }),
  );

  assert.ok(lines.includes("Provider  -"));
  assert.ok(lines.includes("Model     glm-4.6"));
});

test("compacts UUID-like provider labels in API request rows", () => {
  const providerId = "36965ea6-734a-46a8-8851-3dfec026589e";
  const lines = collectTextLines(
    Sidebar({
      ...baseSidebarState,
      developerMode: true,
      networkRequests: [
        {
          id: providerId,
          method: "POST",
          provider: providerId,
          requestId: providerId,
          source: "model",
          startedAt: "2026-05-19T00:00:00.000Z",
          status: "complete",
          updatedAt: "2026-05-19T00:00:01.000Z",
          url: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
        },
      ],
    }),
  );
  const requestLine = lines.find((line) => line.includes("complete POST"));

  assert.ok(requestLine);
  assert.equal(requestLine.length, SIDEBAR_CONTENT_WIDTH);
  assert.match(requestLine, /^complete POST 36965ea6\.\.\.589e https:\//);
  assert.match(requestLine, /\.\.\.$/);
  assert.equal(requestLine.includes(providerId), false);
});

test("keeps named provider labels readable in API request rows", () => {
  const lines = collectTextLines(
    Sidebar({
      ...baseSidebarState,
      developerMode: true,
      networkRequests: [
        {
          id: "request-1",
          method: "POST",
          provider: "deepseek",
          requestId: "request-1",
          source: "model",
          startedAt: "2026-05-19T00:00:00.000Z",
          status: "pending",
          updatedAt: "2026-05-19T00:00:01.000Z",
          url: "https://api.deepseek.com",
        },
      ],
    }),
  );
  const requestLine = lines.find((line) => line.includes("pending POST"));

  assert.ok(requestLine);
  assert.equal(requestLine.length, SIDEBAR_CONTENT_WIDTH);
  assert.match(requestLine, /^pending POST deepseek https:\/\/api\.dee/);
  assert.match(requestLine, /\.\.\.$/);
});

test("renders current-session modified files with aligned counts", () => {
  const nodes = collectTextNodes(
    Sidebar({
      ...baseSidebarState,
      modifiedFiles: [
        { additions: 3, deletions: 1, filePath: "src/App.jsx" },
        { additions: 30, deletions: 12, filePath: "src/Scene3D.jsx" },
      ],
    }),
  );

  assert.ok(nodes.some((node) => node.text === "▼ Modified Files"));
  assert.equal(nodes.find((node) => node.text === "src/App.jsx")?.style.fg, "#94a3b8");
  assert.equal(nodes.find((node) => node.text.trim() === "+3")?.style.fg, "#7dd3fc");
  assert.equal(nodes.find((node) => node.text.trim() === "-1")?.style.fg, "#fca5a5");
});

test("collapses modified files and API sections independently", () => {
  const lines = collectTextLines(
    Sidebar({
      ...baseSidebarState,
      developerMode: true,
      modifiedFiles: [{ additions: 3, deletions: 1, filePath: "src/App.jsx" }],
      networkRequests: [
        {
          id: "request-1",
          method: "POST",
          requestId: "request-1",
          source: "model",
          startedAt: "2026-05-19T00:00:00.000Z",
          status: "pending",
          updatedAt: "2026-05-19T00:00:01.000Z",
          url: "https://api.deepseek.com",
        },
      ],
      sectionExpansion: {
        apis: false,
        mcp: true,
        modifiedFiles: false,
      },
    }),
  );

  assert.ok(lines.includes("▶ Modified Files"));
  assert.ok(lines.includes("▶ APIs"));
  assert.equal(lines.includes("src/App.jsx"), false);
  assert.equal(
    lines.some((line) => line.includes("pending POST")),
    false,
  );
});

test("production sidebar renders MCP server statuses", () => {
  const lines = collectTextLines(
    Sidebar({
      ...baseSidebarState,
      mcpStatus: {
        loading: false,
        servers: {
          filesystem: {
            status: "connected",
            toolCount: 2,
            transport: "stdio",
            updatedAt: "2026-05-28T00:00:00.000Z",
          },
          remote: {
            error: "Connection timed out",
            status: "failed",
            toolCount: 0,
            transport: "http",
            updatedAt: "2026-05-28T00:00:01.000Z",
          },
        },
      },
    }),
  );

  assert.ok(lines.includes("▼ MCP"));
  assert.ok(lines.includes("Servers   1/2 connected"));
  assert.ok(lines.some((line) => line.includes("connected") && line.includes("filesystem")));
  assert.ok(lines.some((line) => line.includes("failed") && line.includes("remote")));
  assert.ok(lines.includes("Connection timed out"));
});

test("production sidebar shows product header and hides developer diagnostics", () => {
  const node = Sidebar({
    ...baseSidebarState,
    version: "1.2.3",
    workspaceDirectory: "/Users/dev/test/z-m",
    workspaceGitBranch: "main",
  });
  const lines = collectTextLines(node);
  const textNodes = collectTextNodes(node);

  assert.equal(textNodes.find((item) => item.text === "ZCode")?.style.fg, "#7dd3fc");
  assert.equal(textNodes.find((item) => item.text === " 1.2.3")?.style.fg, "#94a3b8");
  assert.equal(lines.includes("OpenTUI shell"), false);
  assert.equal(lines.includes("Run"), false);
  assert.equal(lines.includes("Context"), false);
  assert.equal(lines.includes("APIs"), false);
  assert.ok(lines.includes("Status"));
  assert.ok(lines.includes("▼ MCP"));
  assert.ok(lines.includes("▼ Modified Files"));
  assert.ok(lines.includes("▼ Todos"));
  assert.ok(lines.includes("/Users/dev/test/z-m:main"));
});

test("clicking collapsible section headers toggles only that section", () => {
  const toggledSections: string[] = [];
  const stopped: string[] = [];
  const node = Sidebar({
    ...baseSidebarState,
    developerMode: true,
    onToggleSection: (section) => toggledSections.push(section),
  });

  findTextElement(node, "▼ Modified Files")?.props?.onMouseUp?.({
    stopPropagation: () => stopped.push("modifiedFiles"),
  });
  findTextElement(node, "▼ APIs")?.props?.onMouseUp?.({
    stopPropagation: () => stopped.push("apis"),
  });

  assert.deepEqual(toggledSections, ["modifiedFiles", "apis"]);
  assert.deepEqual(stopped, ["modifiedFiles", "apis"]);
});

test("auto sidebar is docked only above the 120 column breakpoint", () => {
  assert.deepEqual(sidebarLayoutForTerminal(121, DEFAULT_SIDEBAR_STATE), {
    overlay: false,
    reservedWidth: SIDEBAR_WIDTH,
    visible: true,
    wide: true,
  });
  assert.deepEqual(sidebarLayoutForTerminal(120, DEFAULT_SIDEBAR_STATE), {
    overlay: false,
    reservedWidth: 0,
    visible: false,
    wide: false,
  });
});

test("sidebar toggle hides visible panes and opens narrow panes as overlays", () => {
  const hidden = toggleSidebarState(DEFAULT_SIDEBAR_STATE, 140);
  assert.equal(sidebarLayoutForTerminal(140, hidden).visible, false);
  assert.equal(sidebarLayoutForTerminal(80, hidden).visible, false);

  const narrowOpen = toggleSidebarState(hidden, 80);
  assert.deepEqual(sidebarLayoutForTerminal(80, narrowOpen), {
    overlay: true,
    reservedWidth: 0,
    visible: true,
    wide: false,
  });
});

test("sidebar section toggles preserve the other section", () => {
  // 子代理与 Todos 也成为可折叠区块，默认展开，切换其一不影响其他区块。
  assert.deepEqual(toggleSidebarSectionState(DEFAULT_SIDEBAR_STATE.sections, "modifiedFiles"), {
    apis: true,
    mcp: true,
    modifiedFiles: false,
    subagents: true,
    todos: true,
  });
  assert.deepEqual(toggleSidebarSectionState(DEFAULT_SIDEBAR_STATE.sections, "apis"), {
    apis: false,
    mcp: true,
    modifiedFiles: true,
    subagents: true,
    todos: true,
  });
});

test("Ctrl-X leader toggles sidebar sections while unrelated keys clear the leader", () => {
  const state = createSidebarShortcutState();

  assert.equal(resolveSidebarShortcut(state, key("x", { ctrl: true }), 1_000), "arm");
  assert.equal(resolveSidebarShortcut(state, key("b"), 1_500), "toggle");
  assert.equal(resolveSidebarShortcut(state, key("b"), 1_600), "pass");

  assert.equal(resolveSidebarShortcut(state, key("x", { ctrl: true }), 2_000), "arm");
  assert.equal(resolveSidebarShortcut(state, key("m"), 2_100), "toggle-files");
  assert.equal(resolveSidebarShortcut(state, key("b"), 2_200), "pass");

  assert.equal(resolveSidebarShortcut(state, key("x", { ctrl: true }), 3_000), "arm");
  assert.equal(resolveSidebarShortcut(state, key("a"), 3_100), "toggle-apis");
  assert.equal(resolveSidebarShortcut(state, key("b"), 3_200), "pass");

  assert.equal(resolveSidebarShortcut(state, key("x", { ctrl: true }), 4_000), "arm");
  assert.equal(resolveSidebarShortcut(state, key("q"), 4_100), "pass");
  assert.equal(resolveSidebarShortcut(state, key("b"), 4_200), "pass");

  assert.equal(resolveSidebarShortcut(state, key("x", { ctrl: true }), 5_000), "arm");
  assert.equal(resolveSidebarShortcut(state, key("b"), 8_000), "pass");
});

test("app shell hides, docks, and overlays sidebar based on layout", () => {
  const sidebar = React.createElement("box", { id: "sidebar" });
  const hidden = reactElementChildren(
    AppShell({
      children: React.createElement("text", null, "main"),
      sidebar,
      sidebarLayout: {
        overlay: false,
        reservedWidth: 0,
        visible: false,
        wide: false,
      },
    }),
  );
  const hiddenRootStyle = reactElementStyle(
    AppShell({
      children: React.createElement("text", null, "main"),
      sidebar,
      sidebarLayout: {
        overlay: false,
        reservedWidth: 0,
        visible: false,
        wide: false,
      },
    }),
  );
  const hiddenMainStyle = reactElementStyle(hidden[0]);
  const docked = reactElementChildren(
    AppShell({
      children: React.createElement("text", null, "main"),
      sidebar,
      sidebarLayout: {
        overlay: false,
        reservedWidth: SIDEBAR_WIDTH,
        visible: true,
        wide: true,
      },
    }),
  );
  const overlay = reactElementChildren(
    AppShell({
      children: React.createElement("text", null, "main"),
      sidebar,
      sidebarLayout: {
        overlay: true,
        reservedWidth: 0,
        visible: true,
        wide: false,
      },
    }),
  );

  assert.equal(hiddenRootStyle.padding, 0);
  assert.equal(hiddenMainStyle.padding, 1);
  assert.equal(hidden[1], null);
  assert.equal(hidden[2], null);
  assert.equal(docked[1]?.props?.id, "sidebar");
  assert.equal(overlay[1], null);
  const overlayStyle = reactElementStyle(overlay[2]);
  assert.equal(overlayStyle.position, "absolute");
  assert.equal(overlayStyle.backgroundColor, SIDEBAR_OVERLAY_BACKGROUND);
});

const baseSidebarState: SidebarState = {
  busy: false,
  contextUsage: {},
  draft: "",
  lastEvent: "idle",
  messageCount: 0,
  mcpStatus: {
    loading: false,
    servers: {},
  },
  mode: "build",
  model: "glm-4.6",
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

function findTextElement(
  node: unknown,
  text: string,
):
  | {
      props?: { children?: unknown; onMouseUp?: (event: { stopPropagation?: () => void }) => void };
    }
  | undefined {
  let match:
    | {
        props?: {
          children?: unknown;
          onMouseUp?: (event: { stopPropagation?: () => void }) => void;
        };
      }
    | undefined;
  const visit = (value: unknown) => {
    if (match || Array.isArray(value)) {
      if (Array.isArray(value)) {
        for (const child of value) visit(child);
      }
      return;
    }
    if (typeof value !== "object" || value === null || !("props" in value)) return;
    const element = value as {
      props?: {
        children?: unknown;
        onMouseUp?: (event: { stopPropagation?: () => void }) => void;
      };
      type?: unknown;
    };
    if (element.type === "text" && collectTextLines(element.props?.children).join("") === text) {
      match = element;
      return;
    }
    visit(element.props?.children);
  };

  visit(node);
  return match;
}

function reactElementStyle(node: unknown): Record<string, unknown> {
  assert.ok(typeof node === "object" && node !== null && "props" in node);
  const element = node as { props?: { style?: Record<string, unknown> } };
  return element.props?.style ?? {};
}

function reactElementChildren(node: unknown): Array<null | { props?: Record<string, unknown> }> {
  assert.ok(typeof node === "object" && node !== null && "props" in node);
  const element = node as { props?: { children?: unknown } };
  const children = element.props?.children;
  if (children === undefined) return [];
  return (Array.isArray(children) ? children : [children]) as Array<null | {
    props?: Record<string, unknown>;
  }>;
}

function key(
  name: string,
  modifiers: { ctrl?: boolean; meta?: boolean; option?: boolean; shift?: boolean } = {},
): {
  ctrl?: boolean;
  meta?: boolean;
  name: string;
  option?: boolean;
  shift?: boolean;
} {
  return {
    name,
    ...modifiers,
  };
}
