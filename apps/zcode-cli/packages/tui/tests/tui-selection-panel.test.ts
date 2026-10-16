import assert from "node:assert/strict";
import test from "node:test";
import type { KeyEvent } from "@mbears/opentui-core";
import { getZCodeCopy } from "@zcode/i18n";
import { filterSelectionItems, handleSelectionKey } from "../src/app-input.js";
import type { SelectionState } from "../src/app-model.js";
import { palette } from "../src/app-model.js";
import { visibleSelectionItemWindow } from "../src/app-selection-keyboard.js";
import { SelectionPanel } from "../src/app-selection-panel.js";

const EN_COPY = getZCodeCopy("en-US").tui;

test("renders non-filterable selections without a filter prompt", () => {
  const panel = SelectionPanel({
    contentWidth: 72,
    copy: EN_COPY,
    selection: {
      ...baseSelection,
      filter: "zai",
      filterable: false,
      selectedIndex: 0,
    },
  });

  const textNodes = collectTextNodes(panel);

  assert.equal(textNodes.some((node) => node.text.includes("filter:")), false);
  assert.ok(textNodes.some((node) => node.text === baseSelection.help));
  assert.ok(textNodes.some((node) => node.text === "Z.AI Coding Plan"));
  const detailNode = textNodes.find((node) => node.text.includes("Open browser login"));
  assert.equal(detailNode?.style.fg, palette.muted);
  assert.equal(detailNode?.style.flexShrink, 0);
});

test("non-filterable selections ignore typed filter keys", () => {
  let selection: SelectionState = {
    ...baseSelection,
    filter: "missing",
    filterable: false,
    selectedIndex: 0,
  };
  const statuses: string[] = [];
  const submitted: string[] = [];

  assert.equal(filterSelectionItems(selection).length, baseSelection.items.length);

  handleSelectionKey(
    key("x"),
    selection,
    (next) => {
      selection = typeof next === "function" ? next(selection) : next ?? selection;
    },
    (status) => statuses.push(status),
    async (value) => {
      submitted.push(value);
    },
  );

  assert.equal(selection.filter, "missing");
  assert.deepEqual(statuses, []);
  assert.deepEqual(submitted, []);
});

test("selection panel follows the active row beyond the first page", () => {
  const items = Array.from({ length: 7 }, (_, index) => ({
    command: `/resume sess_${index + 1}`,
    id: `sess_${index + 1}`,
    primary: `Session ${index + 1}`,
  }));
  const panel = SelectionPanel({
    contentWidth: 72,
    copy: EN_COPY,
    selection: {
      ...baseSelection,
      filter: "",
      items,
      prompt: "Choose a session to resume.",
      selectedIndex: 5,
      title: "Resume Session",
    },
  });

  assert.deepEqual(visibleSelectionItemWindow(items, 5, 5), {
    items: items.slice(1, 6),
    selectedIndex: 4,
    startIndex: 1,
  });

  const texts = collectTextNodes(panel).map((node) => node.text);
  assert.equal(texts.includes("Session 1"), false);
  assert.ok(texts.includes("Session 2"));
  assert.ok(texts.includes("Session 6"));
  assert.equal(texts[texts.indexOf("> ") + 1], "Session 6");
});

test("pending selections replace options and keep escape as cancel", () => {
  const selection: SelectionState = {
    ...baseSelection,
    filter: "",
    pending: {
      cancelStatus: "Login cancelled. Choose a setup method.",
      command: "/login zai-coding-plan",
      help: "Esc cancels and returns to setup choices.",
      itemId: "zai-coding-plan",
      primary: "Waiting for Z.AI authorization",
      secondary: "Complete sign-in in your browser.",
      status: "Waiting for browser authorization...",
    },
    selectedIndex: 0,
  };
  const panel = SelectionPanel({ contentWidth: 72, copy: EN_COPY, selection });
  const textNodes = collectTextNodes(panel);

  assert.ok(textNodes.some((node) => node.text === "Waiting for Z.AI authorization"));
  assert.equal(textNodes.some((node) => node.text === "Z.AI Coding Plan"), false);
});

test("pending selection escape aborts and restores setup choices", () => {
  let cancelled = false;
  let selection: SelectionState = {
    ...baseSelection,
    filter: "",
    pending: {
      cancelStatus: "Login cancelled. Choose a setup method.",
      command: "/login zai-coding-plan",
      help: "Esc cancels and returns to setup choices.",
      itemId: "zai-coding-plan",
      primary: "Waiting for Z.AI authorization",
      status: "Waiting for browser authorization...",
    },
    selectedIndex: 0,
  };
  const statuses: string[] = [];

  handleSelectionKey(
    key("escape"),
    selection,
    (next) => {
      selection = typeof next === "function" ? next(selection) : next ?? selection;
    },
    (status) => statuses.push(status),
    async () => undefined,
    () => {
      cancelled = true;
    },
  );

  assert.equal(cancelled, true);
  assert.equal(selection.pending, undefined);
  assert.deepEqual(statuses, ["Login cancelled. Choose a setup method."]);
});

test("pending row submission preserves the selection panel while it waits", () => {
  let selection: SelectionState = {
    ...baseSelection,
    filter: "",
    selectedIndex: 0,
  };
  const statuses: string[] = [];
  const submissions: Array<{ options: unknown; value: string }> = [];

  handleSelectionKey(
    key("return"),
    selection,
    (next) => {
      selection = typeof next === "function" ? next(selection) : next ?? selection;
    },
    (status) => statuses.push(status),
    async (value, options) => {
      submissions.push({ options, value });
    },
  );

  assert.equal(selection.pending?.itemId, "zai-coding-plan");
  assert.equal(statuses.at(-1), "Waiting for browser authorization...");
  assert.deepEqual(submissions, [
    {
      options: {
        abortStatus: "Login cancelled. Choose a setup method.",
        preserveSelection: true,
      },
      value: "/login zai-coding-plan",
    },
  ]);
});

test("input selections replace options with an inline hidden input", () => {
  const selection: SelectionState = {
    ...baseSelection,
    filter: "",
    input: {
      cancelStatus: "API key entry cancelled. Choose a setup method.",
      clearStatus: "API key input cleared.",
      command: "/login zai-coding-plan-api-key",
      emptyStatus: "API key is required.",
      help: "Enter saves the key. Esc returns to setup choices.",
      itemId: "zai-coding-plan-api-key",
      mask: true,
      placeholder: "Paste API key",
      primary: "Enter Z.AI Coding Plan API Key",
      secondary: "Paste the key here. It is hidden while typing.",
      status: "Enter the API key, then press Enter.",
      submitStatus: "Saving API key...",
      value: "manual-key",
    },
    selectedIndex: 2,
  };

  const panel = SelectionPanel({ contentWidth: 72, copy: EN_COPY, selection });
  const textNodes = collectTextNodes(panel);

  assert.ok(textNodes.some((node) => node.text === "Enter Z.AI Coding Plan API Key"));
  assert.ok(textNodes.some((node) => node.text === "> **********"));
  assert.equal(textNodes.some((node) => node.text === "BigModel Coding Plan"), false);
});

test("input row submission stays in the setup panel before saving the key", () => {
  let selection: SelectionState | undefined = {
    ...baseSelection,
    filter: "",
    selectedIndex: 2,
  };
  const statuses: string[] = [];
  const submissions: string[] = [];

  assert.ok(selection);
  handleSelectionKey(
    key("return"),
    selection,
    (next) => {
      selection = typeof next === "function" ? next(selection) : next;
    },
    (status) => statuses.push(status),
    async (value) => {
      submissions.push(value);
    },
  );

  assert.equal(selection?.input?.itemId, "zai-coding-plan-api-key");
  assert.equal(statuses.at(-1), "Enter the API key, then press Enter.");
  assert.deepEqual(submissions, []);

  assert.ok(selection);
  handleSelectionKey(
    key("", { sequence: "manual-key" }),
    selection,
    (next) => {
      selection = typeof next === "function" ? next(selection) : next;
    },
    (status) => statuses.push(status),
    async (value) => {
      submissions.push(value);
    },
  );

  assert.equal(selection?.input?.value, "manual-key");

  assert.ok(selection);
  handleSelectionKey(
    key("return"),
    selection,
    (next) => {
      selection = typeof next === "function" ? next(selection) : next;
    },
    (status) => statuses.push(status),
    async (value) => {
      submissions.push(value);
    },
  );

  assert.equal(selection, undefined);
  assert.deepEqual(submissions, ["/login zai-coding-plan-api-key manual-key"]);
});

test("input selection escape restores setup choices", () => {
  let selection: SelectionState | undefined = {
    ...baseSelection,
    filter: "",
    input: {
      cancelStatus: "API key entry cancelled. Choose a setup method.",
      clearStatus: "API key input cleared.",
      command: "/login zai-coding-plan-api-key",
      emptyStatus: "API key is required.",
      itemId: "zai-coding-plan-api-key",
      mask: true,
      placeholder: "Paste API key",
      primary: "Enter Z.AI Coding Plan API Key",
      status: "Enter the API key, then press Enter.",
      value: "manual-key",
    },
    selectedIndex: 2,
  };
  const statuses: string[] = [];

  assert.ok(selection);
  handleSelectionKey(
    key("escape"),
    selection,
    (next) => {
      selection = typeof next === "function" ? next(selection) : next;
    },
    (status) => statuses.push(status),
    async () => undefined,
  );

  assert.equal(selection?.input, undefined);
  assert.deepEqual(statuses, ["API key entry cancelled. Choose a setup method."]);
});

const baseSelection: SelectionState = {
  emptyMessage: "No login options are available.",
  filter: "",
  help: "Use Up/Down to choose, Enter to select.",
  items: [
    {
      command: "/login zai-coding-plan",
      id: "zai-coding-plan",
      pending: {
        cancelStatus: "Login cancelled. Choose a setup method.",
        help: "Esc cancels and returns to setup choices.",
        primary: "Waiting for Z.AI authorization",
        secondary: "Complete sign-in in your browser.",
        status: "Waiting for browser authorization...",
      },
      primary: "Z.AI Coding Plan",
      secondary: "Open browser login and create a Coding Plan API key.",
    },
    {
      command: "/login bigmodel-coding-plan",
      id: "bigmodel-coding-plan",
      primary: "BigModel Coding Plan",
      secondary: "Open browser login with a localhost callback.",
    },
    {
      command: "/login zai-coding-plan-api-key",
      id: "zai-coding-plan-api-key",
      input: {
        cancelStatus: "API key entry cancelled. Choose a setup method.",
        clearStatus: "API key input cleared.",
        emptyStatus: "API key is required.",
        help: "Enter saves the key. Esc returns to setup choices.",
        mask: true,
        placeholder: "Paste API key",
        primary: "Enter Z.AI Coding Plan API Key",
        secondary: "Paste the key here. It is hidden while typing.",
        status: "Enter the API key, then press Enter.",
        submitStatus: "Saving API key...",
      },
      primary: "Z.AI Coding Plan API Key",
      secondary: "Paste a Coding Plan API key manually.",
    },
  ],
  prompt: "Choose a login or API key setup method.",
  selectedIndex: 0,
  title: "Set Up Coding Plan",
};

function key(name: string, overrides: Partial<KeyEvent> = {}): KeyEvent {
  return {
    ctrl: false,
    meta: false,
    name,
    sequence: name,
    shift: false,
    ...overrides,
  } as KeyEvent;
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
    if (typeof element.type === "function") {
      visit(element.type(element.props));
      return;
    }
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
