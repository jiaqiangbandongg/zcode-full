import { describe, expect, it } from "vitest";
import { projectGenUiReferences } from "./references.js";
const token = 'visualize{"path":"/work/demo.html"}';
const directive = '::visualize{path="/work/demo.html" title="工作区体积" mode="wide"}';
const jsonDirective = '::visualize{"path":"/work/demo.html","title":"贝塞尔曲线进阶"}';
describe("Gen UI reference projection", () => {
  it("renders the JSON directive emitted in a completed assistant response", () => {
    expect(projectGenUiReferences(`Before\n${jsonDirective}\nAfter`, true)).toEqual([
      { kind: "text", text: "Before\n" },
      { kind: "ui", reference: { path: "/work/demo.html", title: "贝塞尔曲线进阶" }, offset: 7 },
      { kind: "text", text: "\nAfter" },
    ]);
  });
  it("decodes JSON escapes without confusing quoted braces or directive text with boundaries", () => {
    const reference = {
      path: String.raw`C:\work area\demo.html`,
      title: 'Group {A} and "B" ::visualize{path="x"}',
      mode: "wide",
    };
    expect(projectGenUiReferences(`::visualize ${JSON.stringify(reference)}`, true)).toEqual([
      { kind: "ui", reference, offset: 0 },
    ]);
  });
  it("renders the actual model directive with surrounding prose from a completed message", () => {
    expect(projectGenUiReferences(`Before\n${directive}\nAfter`, true)).toEqual([
      { kind: "text", text: "Before\n" },
      {
        kind: "ui",
        reference: { path: "/work/demo.html", title: "工作区体积", mode: "wide" },
        offset: 7,
      },
      { kind: "text", text: "\nAfter" },
    ]);
  });
  it("preserves original offsets for mixed and repeated marker formats", () => {
    const text = `${directive}\n${token}\n${jsonDirective}`;
    expect(
      projectGenUiReferences(text, true)
        .filter((part) => part.kind === "ui")
        .map((part) => part.offset),
    ).toEqual([0, directive.length + 1, directive.length + token.length + 2]);
  });
  it("uses directive quoting rules for braces, escaped quotes and Windows paths", () => {
    const text = String.raw`::visualize{path="C:\work area\demo.html" title="Group {A} and \"B\""}`;
    expect(projectGenUiReferences(text, true)).toEqual([
      {
        kind: "ui",
        offset: 0,
        reference: { path: String.raw`C:\work area\demo.html`, title: 'Group {A} and "B"' },
      },
    ]);
  });
  it.each([
    `\`${directive}\``,
    `\`\`\`text\n${directive}\n\`\`\``,
    `~~~text\n${directive}\n~~~`,
    `<pre>${directive}</pre>`,
    `\`\`\`text\n::visualize{path="`,
    `\`::visualize\``,
    `\`${jsonDirective}\``,
    `\`\`\`text\n${jsonDirective}\n\`\`\``,
  ])("keeps directive examples inert: %s", (text) => {
    for (const completed of [true, false]) {
      expect(projectGenUiReferences(text, completed)).toEqual([{ kind: "text", text }]);
    }
  });
  it("never mounts a streamed or interrupted directive and suppresses its partial prefix", () => {
    for (const source of [directive, jsonDirective]) {
      for (let length = 2; length <= source.length; length++) {
        const parts = projectGenUiReferences(`Before ${source.slice(0, length)}`, false);
        expect(parts.some((part) => part.kind === "ui")).toBe(false);
        expect(parts.filter((part) => part.kind === "text")).toEqual([
          { kind: "text", text: "Before " },
        ]);
      }
    }
    expect(projectGenUiReferences(directive, false)).toEqual([{ kind: "pending" }]);
    expect(projectGenUiReferences('::visualize{path="/work/demo.html"', true)).toEqual([
      { kind: "invalid" },
    ]);
  });
  it.each([
    '::visualize{path="https://example.com/demo.html"}',
    '::visualize{path="relative/demo.html"}',
    '::visualize{path="/work/../demo.html"}',
    '::visualize{path="/work/demo.html" mode="fullscreen"}',
    '::visualize{path="/work/demo.html" sessionId="other"}',
    '::visualize{title="No path"}',
    '::visualize{path:"/work/demo.html"}',
    '::visualize{"path":"/work/demo.html",}',
    '::visualize{"path":"/work/demo.html","sessionId":"other"}',
    '::visualize{"path":"/work/demo.html","mode":"fullscreen"}',
    '::visualize{"path":"/work/demo.html","title":7}',
    '::visualize{"path":"/work/../demo.html"}',
    '::visualize{"path":"https://example.com/demo.html"}',
    '::visualize{"path":"/work/demo.html"',
  ])("rejects invalid directive parameters: %s", (text) => {
    expect(projectGenUiReferences(text, true)).toEqual([{ kind: "invalid" }]);
  });
  it.each([
    ':visualize{path="/work/demo.html"}',
    ':::visualize{path="/work/demo.html"}',
    '::visualizer{path="/work/demo.html"}',
  ])("does not extend unrelated directive syntax: %s", (text) => {
    expect(projectGenUiReferences(text, true)).toEqual([{ kind: "text", text }]);
  });
  it("does not swallow prose after an unclosed JSON directive", () => {
    const text = '::visualize{"path":"/work/demo.html"\nThis is ordinary prose.';
    expect(projectGenUiReferences(text, false)).toEqual([{ kind: "text", text }]);
  });
  it("only executes references in completed assistant text", () => {
    expect(projectGenUiReferences(`before${token}after`, true).map((part) => part.kind)).toEqual([
      "text",
      "ui",
      "text",
    ]);
    expect(projectGenUiReferences(token, false)).toEqual([{ kind: "pending" }]);
  });
  it("leaves quoted code inert and suppresses partial stream markers", () => {
    expect(projectGenUiReferences("```html\nvis", false)).toEqual([
      { kind: "text", text: "```html\nvis" },
    ]);
    expect(projectGenUiReferences(`\`${token}\``, true)).toEqual([
      { kind: "text", text: `\`${token}\`` },
    ]);
    expect(projectGenUiReferences('hellovisualize{"path":', false)).toEqual([
      { kind: "text", text: "hello" },
      { kind: "pending" },
    ]);
  });
  it("does not execute malformed paths and preserves repeated occurrences", () => {
    expect(
      projectGenUiReferences('visualize{"path":"https://evil/a.html"}', true)[0]?.kind,
    ).toBe("invalid");
    expect(
      projectGenUiReferences(token + token, true).filter((part) => part.kind === "ui"),
    ).toHaveLength(2);
  });
});
