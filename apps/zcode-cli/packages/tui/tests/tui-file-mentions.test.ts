import assert from "node:assert/strict";
import test from "node:test";
import { getZCodeCopy } from "@zcode/i18n";
import { toPromptInput } from "../src/app-input.js";
import { FileMentionPanel } from "../src/app-file-mention-panel.js";
import {
  promptEditorCursorOffset,
  resolveActiveFileMention,
  visibleFileMentionWindow,
  type FileMentionState,
} from "../src/app-file-mentions.js";
import { palette } from "../src/app-model.js";

test("resolves active file mention tokens at the prompt cursor", () => {
  assert.deepEqual(resolveActiveFileMention("@pu"), {
    endOffset: 3,
    token: "pu",
    triggerIndex: 0,
  });
  assert.deepEqual(resolveActiveFileMention("open @public/ap"), {
    endOffset: 15,
    token: "public/ap",
    triggerIndex: 5,
  });
  assert.equal(resolveActiveFileMention("email me@work"), undefined);
  assert.equal(resolveActiveFileMention("open @public/app now"), undefined);
});

test("keeps selected file mention inside the visible window", () => {
  const items = Array.from({ length: 10 }, (_, index) => ({
    kind: "file" as const,
    path: `src/file-${index}.ts`,
  }));

  assert.deepEqual(visibleFileMentionWindow(items, 7, 8), {
    items: items.slice(0, 8),
    selectedIndex: 7,
    startIndex: 0,
  });
  assert.deepEqual(visibleFileMentionWindow(items, 9, 8), {
    items: items.slice(2, 10),
    selectedIndex: 7,
    startIndex: 2,
  });
});

test("falls back to the draft end when the prompt editor is stale", () => {
  const staleEditor = {
    get cursorOffset(): number {
      throw new Error("EditorView is destroyed");
    },
  };

  assert.equal(promptEditorCursorOffset(staleEditor, 12), 12);
});

test("submits only file mention attachments that remain in the draft", () => {
  assert.deepEqual(
    toPromptInput("read @src/app.ts", [
      {
        id: 1,
        path: "src/app.ts",
        placeholder: "@src/app.ts",
        type: "file",
      },
      {
        id: 2,
        path: "src/removed.ts",
        placeholder: "@src/removed.ts",
        type: "file",
      },
    ]),
    {
      attachments: [{ path: "src/app.ts", type: "file" }],
      text: "read @src/app.ts",
    },
  );
});

test("renders file mention suggestions with wrapped rows", () => {
  const panel = FileMentionPanel({
    contentWidth: 28,
    copy: getZCodeCopy("en-US").tui,
    state: {
      endOffset: 3,
      items: [
        { kind: "directory", path: "public/" },
        { kind: "file", path: "public/very-long-file-name-that-wraps.ts" },
      ],
      loading: false,
      selectedIndex: 1,
      token: "pu",
      triggerIndex: 0,
      truncated: false,
    },
  });

  assert.ok(panel);
  const textNodes = collectTextNodes(panel);
  assert.equal(textNodes[0]?.text, "  public/");
  assert.equal(textNodes[1]?.text, "> public/very-long-file-name-that-wraps.ts");
  assert.equal(textNodes[0]?.style.fg, palette.text);
  assert.equal(textNodes[1]?.style.fg, palette.accent);
  assert.equal((textNodes[1]?.style.height as number) > 1, true);
  assert.equal(textNodes[1]?.style.wrapMode, "word");
});

test("renders a loading file mention state", () => {
  const panel = FileMentionPanel({
    copy: getZCodeCopy("en-US").tui,
    state: emptyMentionState({ loading: true }),
  });

  assert.ok(collectTextNodes(panel).some((node) => node.text === "Loading workspace paths..."));
});

function emptyMentionState(input: { loading: boolean }): FileMentionState {
  return {
    endOffset: 1,
    items: [],
    loading: input.loading,
    selectedIndex: 0,
    token: "",
    triggerIndex: 0,
    truncated: false,
  };
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
