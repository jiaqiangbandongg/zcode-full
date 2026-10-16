import { describe, expect, it } from "vitest";
import { parseMarkdownFrontmatter } from "../src/plugins/markdown-frontmatter.js";

describe("parseMarkdownFrontmatter", () => {
  it("reads a plain single-line description", () => {
    const content = ["---", "name: airtable-overview", "description: Explains the data model.", "---", "", "# Body"].join(
      "\n",
    );
    expect(parseMarkdownFrontmatter(content)).toEqual({
      name: "airtable-overview",
      description: "Explains the data model.",
    });
  });

  it("folds a `>` block scalar instead of returning the indicator", () => {
    // Bugfix 回归：市场详情技能描述此前只剩一个 `>`。
    const content = [
      "---",
      "name: 42crunch-api-security-testing",
      "description: >",
      "  Automate API security directly in your editor with 42Crunch -",
      "  automatically audit OpenAPI specs and apply AI-powered fixes.",
      "---",
      "",
      "# Body",
    ].join("\n");
    const result = parseMarkdownFrontmatter(content);
    expect(result.name).toBe("42crunch-api-security-testing");
    expect(result.description).toBe(
      "Automate API security directly in your editor with 42Crunch - automatically audit OpenAPI specs and apply AI-powered fixes.",
    );
    expect(result.description).not.toBe(">");
  });

  it("keeps newlines for a `|` literal block scalar", () => {
    const content = [
      "---",
      "description: |",
      "  line one",
      "  line two",
      "---",
    ].join("\n");
    expect(parseMarkdownFrontmatter(content).description).toBe("line one\nline two");
  });

  it("strips surrounding quotes from scalar values", () => {
    const content = ["---", 'name: "quoted-name"', "description: 'single quoted'", "---"].join("\n");
    expect(parseMarkdownFrontmatter(content)).toEqual({
      name: "quoted-name",
      description: "single quoted",
    });
  });

  it("returns empty object when there is no frontmatter", () => {
    expect(parseMarkdownFrontmatter("# Just a heading\n")).toEqual({});
  });

  it("omits keys whose block scalar bodies are empty", () => {
    const content = ["---", "name: only-name", "description: >", "---"].join("\n");
    expect(parseMarkdownFrontmatter(content)).toEqual({ name: "only-name" });
  });
});
