import assert from "node:assert/strict";
import test from "node:test";
import { completeModelCommand } from "../src/app-keyboard.js";
import { palette } from "../src/app-model.js";
import { modelOptionValue } from "../src/app-model-ref.js";
import { ModelSuggestionPanel } from "../src/app-model-suggestion-panel.js";
import {
  filterModelOptions,
  modelCommandQuery,
  selectedModelOption,
  visibleModelOptionWindow,
} from "../src/app-input.js";
import type { TuiModelOption } from "../src/types.js";

// 模型选项改为协议 Model Option（ref + label），别名（main/lite）已移除；
// 行尾元信息改由 disabledReason 与 current 组成。
function modelOption(
  providerId: string,
  modelId: string,
  label: string,
  disabledReason?: string,
): TuiModelOption {
  return {
    ref: { providerId, modelId },
    label,
    properties: {
      inputFormat: {
        supportsText: true,
        supportsImage: false,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: false,
      },
      outputFormat: { supportsText: true },
    },
    ...(disabledReason ? { disabledReason } : {}),
  };
}

const models: TuiModelOption[] = [
  modelOption("openai", "gpt-main", "gpt-main"),
  modelOption("openai", "gpt-lite", "gpt-lite", "no plan"),
  modelOption("anthropic", "claude-sonnet-4", "Sonnet"),
];

test("model command popup filters model choices from the composer draft", () => {
  assert.equal(modelCommandQuery("/model"), "");
  assert.equal(modelCommandQuery("/model gpt"), "gpt");
  assert.equal(modelCommandQuery("/modelclaude"), "claude");
  assert.equal(modelCommandQuery("/mode"), undefined);

  assert.deepEqual(filterModelOptions("/model lite", models).map(modelOptionValue), [
    "openai/gpt-lite",
  ]);
  assert.deepEqual(filterModelOptions("/model claude", models).map(modelOptionValue), [
    "anthropic/claude-sonnet-4",
  ]);
});

test("model command popup selection completes and submits explicit model commands", () => {
  let draft = "";
  assert.equal(
    completeModelCommand(models, { selectedIndex: 1 }, (value) => {
      draft = value;
    }),
    true,
  );
  assert.equal(draft, "/model openai/gpt-lite");

  const selected = selectedModelOption(
    "/model gpt",
    { selectedIndex: 1 },
    filterModelOptions("/model gpt", models),
  );
  assert.equal(selected && modelOptionValue(selected), "openai/gpt-lite");
});

test("keeps selected model option inside the visible window", () => {
  const manyModels: TuiModelOption[] = Array.from({ length: 10 }, (_, index) => ({
    id: `provider/model-${index}`,
  }));

  assert.deepEqual(visibleModelOptionWindow(manyModels, 9, 8), {
    models: manyModels.slice(2, 10),
    selectedIndex: 7,
    startIndex: 2,
  });
});

test("renders model suggestions with model names first and muted right providers", () => {
  const panel = ModelSuggestionPanel({
    contentWidth: 34,
    currentModel: "openai/gpt-main",
    models,
    selectedIndex: 1,
  });

  assert.ok(panel);
  const lines = collectTextNodes(panel);
  assert.deepEqual(
    lines.map((line) => line.text),
    [
      "  ",
      "gpt-main",
      "  current",
      "openai",
      "> ",
      "gpt-lite",
      "  no plan",
      "openai",
      "  ",
      "Sonnet",
      "anthropic",
    ],
  );
  assert.equal(lines[5]?.style.fg, palette.accent);
  assert.equal(lines[7]?.style.fg, palette.muted);
  assert.equal(lines[7]?.style.flexShrink, 0);
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
