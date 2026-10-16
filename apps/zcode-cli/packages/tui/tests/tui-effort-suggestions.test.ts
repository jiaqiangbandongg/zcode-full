import assert from "node:assert/strict";
import test from "node:test";
import { completeEffortCommand } from "../src/app-keyboard.js";
import { EffortSuggestionPanel } from "../src/app-effort-suggestion-panel.js";
import {
  effortCommandQuery,
  filterEffortOptions,
  selectedEffortOption,
  visibleEffortOptionWindow,
} from "../src/app-input.js";
import { palette } from "../src/app-model.js";
import type { TuiEffortOption } from "../src/types.js";

const efforts: TuiEffortOption[] = [
  { description: "Quick checks", id: "low", label: "low" },
  { description: "Balanced reasoning", id: "medium", label: "medium" },
  { description: "Deep reasoning", id: "high", label: "high" },
];

test("effort command popup filters effort choices from the composer draft", () => {
  assert.equal(effortCommandQuery("/effort"), "");
  assert.equal(effortCommandQuery("/effort hi"), "hi");
  assert.equal(effortCommandQuery("/efforthigh"), "high");
  assert.equal(effortCommandQuery("/variantmedium"), "medium");
  assert.equal(effortCommandQuery("/model"), undefined);

  assert.deepEqual(
    filterEffortOptions("/effort high", efforts).map((effort) => effort.id),
    ["high"],
  );
  assert.deepEqual(
    filterEffortOptions("/variant balanced", efforts).map((effort) => effort.id),
    ["medium"],
  );
});

test("effort command popup selection completes and submits explicit effort commands", () => {
  let draft = "";
  assert.equal(
    completeEffortCommand(efforts, { selectedIndex: 2 }, (value) => {
      draft = value;
    }),
    true,
  );
  assert.equal(draft, "/effort high");

  assert.equal(
    selectedEffortOption("/variant", { selectedIndex: 1 }, filterEffortOptions("/variant", efforts))
      ?.id,
    "medium",
  );
});

test("keeps selected effort option inside the visible window", () => {
  const manyEfforts: TuiEffortOption[] = Array.from({ length: 10 }, (_, index) => ({
    id: `level-${index}`,
    label: `level-${index}`,
  }));

  assert.deepEqual(visibleEffortOptionWindow(manyEfforts, 9, 6), {
    efforts: manyEfforts.slice(4, 10),
    selectedIndex: 5,
    startIndex: 4,
  });
});

test("renders effort suggestions with effort labels and muted descriptions", () => {
  const panel = EffortSuggestionPanel({
    contentWidth: 80,
    currentEffort: "medium",
    efforts,
    selectedIndex: 2,
  });

  assert.ok(panel);
  const lines = collectTextNodes(panel);

  assert.ok(lines.some((line) => line.text === "> "));
  assert.ok(lines.some((line) => line.text === "high"));
  assert.ok(lines.some((line) => line.text.includes("Deep reasoning")));
  assert.ok(lines.some((line) => line.text.includes("current")));
  assert.equal(lines.find((line) => line.text === "high")?.style.fg, palette.accent);
  assert.equal(lines.find((line) => line.text.includes("Deep reasoning"))?.style.fg, palette.muted);
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
