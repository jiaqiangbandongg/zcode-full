import assert from "node:assert/strict";
import test from "node:test";
import { SlashSuggestionPanel } from "../src/app-components.js";
import { palette } from "../src/app-model.js";

const narrowCommands = [
  {
    name: "compact",
    summary: "Compact the current conversation with optional instructions.",
    usage: "/compact",
  },
  {
    name: "mcp",
    summary: "Show or manage configured MCP servers.",
    usage: "/mcp",
  },
];

test("renders slash command suggestions with wrapping-friendly layout", () => {
  const panel = SlashSuggestionPanel({
    commands: narrowCommands,
    contentWidth: 34,
    selectedIndex: 0,
  });

  assert.ok(panel);
  const panelStyle = elementStyle(panel);
  assert.equal(typeof panelStyle.height, "number");
  assert.equal((panelStyle.height as number) > narrowCommands.length + 2, true);
  assert.equal(panelStyle.width, "100%");

  const lines = collectTextNodes(panel);
  assert.deepEqual(
    lines.map((line) => line.text),
    [
      "> ",
      "/compact",
      "  ",
      "Compact the current conversation with optional instructions.",
      "  ",
      "/mcp",
      "  ",
      "Show or manage configured MCP servers.",
    ],
  );
  assert.equal(lines[1]?.style.fg, palette.accent);
  assert.equal(lines[3]?.style.fg, palette.muted);
  assert.equal(lines[3]?.style.wrapMode, "word");
  assert.equal(lines[5]?.style.fg, palette.text);
  assert.equal(lines[7]?.style.fg, palette.muted);
  assert.equal(lines[7]?.style.wrapMode, "word");
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

function elementStyle(node: unknown): Record<string, unknown> {
  if (typeof node !== "object" || node === null || !("props" in node)) return {};
  const element = node as {
    props?: {
      style?: Record<string, unknown>;
    };
  };
  return element.props?.style ?? {};
}
