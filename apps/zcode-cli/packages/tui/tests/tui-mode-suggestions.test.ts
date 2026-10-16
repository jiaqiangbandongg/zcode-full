import assert from "node:assert/strict";
import test from "node:test";
import { completeModeCommand } from "../src/app-keyboard.js";
import {
  filterModeOptions,
  modeCommandQuery,
  selectedModeOption,
} from "../src/app-mode-command.js";
import { ModeSuggestionPanel, visibleModeOptionWindow } from "../src/app-mode-suggestion-panel.js";
import { palette } from "../src/app-model.js";
import type { TuiModeOption } from "../src/types.js";
import { TUI_SWITCHABLE_MODES } from "../src/app-mode.js";

const modes: TuiModeOption[] = [
  {
    description: "Inspect the code and present a plan before editing.",
    id: "plan",
    label: "Plan",
  },
  {
    description: "Ask before each file changes.",
    id: "build",
    label: "Build",
  },
  {
    description: "Full access with single-use confirmation for explicit dangerous commands.",
    id: "guarded",
    label: "Guarded",
  },
  {
    description: "Edit and run commands with fewer confirmations.",
    id: "yolo",
    label: "Yolo",
  },
];

test("mode command popup filters mode choices from the composer draft", () => {
  assert.deepEqual(TUI_SWITCHABLE_MODES, ["plan", "build", "guarded", "yolo"]);
  assert.deepEqual(filterModeOptions("/mode").map((mode) => mode.id), TUI_SWITCHABLE_MODES);
  assert.equal(filterModeOptions("/mode edit").some((mode) => mode.id === "edit"), false);
  assert.equal(modeCommandQuery("/mode"), "");
  assert.equal(modeCommandQuery("/mode yo"), "yo");
  assert.equal(modeCommandQuery("/modebuild"), "build");
  assert.equal(modeCommandQuery("/model"), undefined);

  assert.deepEqual(
    filterModeOptions("/mode build").map((mode) => mode.id),
    ["build"],
  );
  assert.deepEqual(
    filterModeOptions("/mode guarded").map((mode) => mode.id),
    ["guarded"],
  );
  assert.deepEqual(
    filterModeOptions("/mode fewer").map((mode) => mode.id),
    ["yolo"],
  );
});

test("mode command popup selection completes and submits explicit mode commands", () => {
  let draft = "";
  assert.equal(
    completeModeCommand(modes, { selectedIndex: 3 }, (value) => {
      draft = value;
    }),
    true,
  );
  assert.equal(draft, "/mode yolo");

  assert.equal(
    completeModeCommand(modes, { selectedIndex: 2 }, (value) => {
      draft = value;
    }),
    true,
  );
  assert.equal(draft, "/mode guarded");

  assert.equal(
    selectedModeOption("/mode", { selectedIndex: 1 }, filterModeOptions("/mode"))?.id,
    "build",
  );
});

test("keeps selected mode option inside the visible window", () => {
  const legacyModes = modes.filter((mode) => mode.id !== "guarded");
  assert.deepEqual(visibleModeOptionWindow(legacyModes, 99, 2), {
    modes: legacyModes.slice(1, 3),
    selectedIndex: 1,
    startIndex: 1,
  });

  assert.deepEqual(visibleModeOptionWindow(modes, 99, 2), {
    modes: modes.slice(2, 4),
    selectedIndex: 1,
    startIndex: 2,
  });
});

test("renders mode suggestions with mode labels and muted descriptions", () => {
  const panel = ModeSuggestionPanel({
    contentWidth: 96,
    currentMode: "build",
    modes,
    selectedIndex: 1,
  });

  assert.ok(panel);
  const lines = collectTextNodes(panel);

  assert.ok(lines.some((line) => line.text === "> "));
  assert.ok(lines.some((line) => line.text === "Build"));
  assert.ok(lines.some((line) => line.text.includes("current")));
  assert.equal(lines.find((line) => line.text === "Build")?.style.fg, palette.accent);
  assert.equal(lines.find((line) => line.text.includes("current"))?.style.fg, palette.muted);
});

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
      lines.push({
        style: element.props?.style ?? {},
        text: collectTextLines(element.props?.children).join(""),
      });
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
      visit((value as { props?: { children?: unknown } }).props?.children);
    }
  };

  visit(node);
  return lines;
}
