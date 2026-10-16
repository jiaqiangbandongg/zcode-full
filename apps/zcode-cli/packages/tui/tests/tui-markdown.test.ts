import assert from "node:assert/strict";
import test from "node:test";
import { MessageRow } from "../src/app-transcript-components.js";
import { palette } from "../src/app-model.js";
import { detectMarkdownRenderMode, MarkdownText } from "../src/app-markdown.js";
import { markdownSyntaxRules } from "../src/app-markdown-theme.js";
import { DARK_TUI_THEME } from "../src/theme/index.js";

test("detects the best available markdown render mode", () => {
  assert.equal(
    detectMarkdownRenderMode({ code: class Code {}, markdown: class Markdown {} }),
    "markdown",
  );
  assert.equal(detectMarkdownRenderMode({ code: class Code {} }), "code");
  assert.equal(detectMarkdownRenderMode({}), "plain");
});

test("maps markdown theme tokens from the TUI palette", () => {
  const rules = markdownSyntaxRules(DARK_TUI_THEME);
  const heading = rules.find((rule) => rule.scope.includes("markup.heading"));
  const link = rules.find((rule) => rule.scope.includes("markup.link"));
  const inlineCode = rules.find((rule) => rule.scope.includes("markup.raw.inline"));

  assert.equal(heading?.style.bold, true);
  assert.equal(heading?.style.foreground, DARK_TUI_THEME.markdownHeading);
  assert.equal(link?.style.underline, true);
  assert.equal(inlineCode?.style.background, DARK_TUI_THEME.backgroundPanel);
});

test("uses OpenTUI native markdown when available", () => {
  const node = MarkdownText({
    content: "## Title\n\nThis is **bold** and `code`.",
    mode: "markdown",
    streaming: true,
  });

  assert.equal(node.type, "markdown");
  assert.equal(node.props.content, "## Title\n\nThis is **bold** and `code`.");
  assert.equal(node.props.conceal, true);
  assert.equal(node.props.streaming, true);
  assert.ok(node.props.syntaxStyle);
});

test("passes underscore-delimited text through to native markdown unchanged", () => {
  const sessionId = "sess_workflow_activity_26c91a65-2d5a-4f7b-9954-3ff7dbe92771";
  const node = MarkdownText({
    content: `- completed · import-audit · ${sessionId}\n_keep_ underscores`,
    mode: "markdown",
  });

  assert.equal(node.type, "markdown");
  assert.equal(node.props.content, `- completed · import-audit · ${sessionId}\n_keep_ underscores`);
});

test("falls markdown text back to code or plain text", () => {
  const codeNode = MarkdownText({
    content: "**bold**",
    mode: "code",
  });
  const plainNode = MarkdownText({
    content: "**bold**",
    mode: "plain",
  });

  assert.equal(codeNode.type, "code");
  assert.equal(codeNode.props.filetype, "markdown");
  assert.equal(codeNode.props.content, "**bold**");
  assert.equal(plainNode.type, "text");
  assert.deepEqual(collectTextLines(plainNode), ["**bold**"]);
});

test("message rows render assistant text as native markdown", () => {
  const node = MessageRow({
    index: 0,
    message: {
      content: "Use `npm test`.",
      role: "agent",
      streaming: true,
    },
  });
  const markdownNodes = collectElementsOfType(node, MarkdownText);

  assert.equal(markdownNodes.length, 1);
  assert.equal(markdownNodes[0]?.props.content, "Use `npm test`.");
  assert.equal(markdownNodes[0]?.props.streaming, true);
});

test("message rows hide speaker labels and only highlight user prompts", () => {
  const userRow = MessageRow({
    index: 0,
    message: {
      content: "Show `raw` markdown",
      role: "user",
    },
  });
  const agentRow = MessageRow({
    index: 1,
    message: {
      content: "Use `npm test`.",
      role: "agent",
    },
  });

  assert.equal(reactElementStyle(userRow).backgroundColor, palette.userMessageBackground);
  assert.equal(reactElementStyle(userRow).paddingTop, 1);
  assert.equal(reactElementStyle(userRow).paddingBottom, 1);
  assert.equal(reactElementStyle(agentRow).backgroundColor, palette.background);
  assert.equal(reactElementStyle(agentRow).paddingTop, 0);
  assert.equal(reactElementStyle(agentRow).paddingBottom, 0);
  assert.ok(
    collectTextNodes(userRow).some(
      (node) => node.text.includes("Show `raw` markdown") && node.style.fg === palette.text,
    ),
  );
  assert.equal(collectTextLines(userRow).some((line) => line.includes("User:")), false);
  assert.equal(collectTextLines(agentRow).some((line) => line.includes("Agent:")), false);
});

test("message rows keep user and explicit plain text parts unformatted", () => {
  const userRow = MessageRow({
    index: 0,
    message: {
      content: "Show `raw` markdown",
      role: "user",
    },
  });
  const partRow = MessageRow({
    index: 0,
    message: {
      content: "",
      parts: [{ format: "plain", text: "**plain**", type: "text" }],
      role: "agent",
    },
  });

  assert.equal(collectElementsOfType(userRow, MarkdownText).length, 0);
  assert.equal(collectElementsOfType(partRow, MarkdownText).length, 0);
  assert.ok(collectTextLines(userRow).some((line) => line.includes("Show `raw` markdown")));
  assert.ok(collectTextLines(partRow).includes("**plain**"));
});

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
  const nodes: ReturnType<typeof collectTextNodes> = [];
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
      nodes.push({
        style: element.props?.style ?? {},
        text: collectTextLines(element.props?.children).join(""),
      });
    }
    visit(element.props?.children);
  };

  visit(node);
  return nodes;
}

function collectElementsOfType(
  node: unknown,
  type: unknown,
): Array<{ props: { style?: { attributes?: number; fg?: string } } & Record<string, unknown> }> {
  const elements: ReturnType<typeof collectElementsOfType> = [];
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
      elements.push({ props: element.props ?? {} });
    }
    visit(element.props?.children);
  };

  visit(node);
  return elements;
}

function reactElementStyle(node: unknown): Record<string, unknown> {
  assert.ok(typeof node === "object" && node !== null && "props" in node);
  const element = node as { props?: { style?: Record<string, unknown> } };
  return element.props?.style ?? {};
}
