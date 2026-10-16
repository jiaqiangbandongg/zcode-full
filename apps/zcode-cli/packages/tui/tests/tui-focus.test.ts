import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { testRender } from "@mbears/opentui-react/test-utils";
import { getZCodeCopy } from "@zcode/i18n";
import { completeSlashCommand } from "../src/app-keyboard.js";
import { AppView } from "../src/app-view.js";
import { Sidebar } from "../src/app-sidebar.js";
import type { SidebarState } from "../src/app-model.js";
import type { PromptInputEditor } from "../src/app-input-pane.js";
import type { TuiSlashCommandSuggestion } from "../src/types.js";

test("ordinary tab does not change prompt text or expose transcript focus", () => {
  let nextDraft: string | undefined;

  assert.equal(
    completeSlashCommand([], undefined, (value) => {
      nextDraft = value;
    }),
    false,
  );
  assert.equal(nextDraft, undefined);

  const sidebarLines = collectTextLines(Sidebar(baseSidebarState));
  assert.equal(
    sidebarLines.some((line) => line.includes("Tab focus")),
    false,
  );
  assert.equal(
    sidebarLines.some((line) => line.startsWith("Focus ")),
    false,
  );
});

test("tab still completes an active slash command candidate", () => {
  const commands: TuiSlashCommandSuggestion[] = [
    {
      name: "compact",
      summary: "Compact the session",
      usage: "/compact",
    },
  ];
  let nextDraft = "";

  assert.equal(
    completeSlashCommand(commands, { selectedIndex: 0 }, (value) => {
      nextDraft = value;
    }),
    true,
  );
  assert.equal(nextDraft, "/compact ");
});

test("mouse clicks outside the prompt return focus to the prompt input", async () => {
  const editorRef = { current: null } as React.MutableRefObject<PromptInputEditor | null>;
  let copySelectionCount = 0;
  let view: Awaited<ReturnType<typeof testRender>> | undefined;

  await act(async () => {
    view = await testRender(
      React.createElement(AppView, {
        approvalQueue: [],
        busy: false,
        contextUsage: {},
        copy: getZCodeCopy("en-US").tui,
        copyCurrentSelection: () => {
          copySelectionCount += 1;
          return false;
        },
        draft: "",
        editorRef,
        inputCursorToEndVersion: 0,
        lastEvent: "idle",
        liveModelText: "",
        loginRequired: false,
        messages: [{ content: "clickable transcript line", role: "agent" }],
        mode: "build",
        model: "openai/gpt-test",
        modifiedFiles: [],
        networkRequests: [],
        options: {
          noColor: true,
          stderr: process.stderr,
          stdin: process.stdin,
          stdout: process.stdout,
          submitPrompt: async () => ({ response: "done" }),
        },
        setDraftValue: () => undefined,
        sidebarLayout: {
          overlay: false,
          reservedWidth: 0,
          visible: false,
          wide: false,
        },
        slashCommands: [],
        status: "Ready.",
        statusDetails: [],
        submitValue: () => undefined,
        thoughtLevel: "medium",
        todos: [],
        terminalWidth: 100,
      }),
      {
        height: 24,
        kittyKeyboard: true,
        otherModifiersMode: true,
        width: 100,
      },
    );
    await view.renderOnce();
  });

  try {
    assert.ok(view);
    assert.equal(editorRef.current?.focused, true);

    await act(async () => {
      await view?.mockMouse.click(5, 5);
      await view?.renderOnce();
    });

    assert.equal(copySelectionCount, 1);
    assert.equal(editorRef.current?.focused, true);
  } finally {
    await act(async () => {
      view?.renderer.destroy();
    });
  }
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
