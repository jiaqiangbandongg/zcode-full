import { describe, expect, it } from "vitest";

import {
  decodeMarkdownArtifactImageSource,
  extractMarkdownArtifactImageRefs,
  rewriteMarkdownArtifactImageSources,
} from "../src/markdown-artifact-images.js";

describe("Markdown artifact image references", () => {
  it("extracts only image destinations and deduplicates them", () => {
    expect(
      extractMarkdownArtifactImageRefs(
        [
          "![first](zcode-artifact://session/a)",
          "[download](zcode-artifact://session/not-an-image)",
          '![again](<zcode-artifact://session/a> "preview")',
          "![second](zcode-artifact://session/b 'title')",
        ].join("\n"),
      ),
    ).toEqual(["zcode-artifact://session/a", "zcode-artifact://session/b"]);
  });

  it("does not authorize image-looking text inside fenced code", () => {
    expect(
      extractMarkdownArtifactImageRefs(
        "```md\n![secret](zcode-artifact://session/secret)\n```\n![ok](zcode-artifact://session/ok)",
      ),
    ).toEqual(["zcode-artifact://session/ok"]);
  });

  it("rewrites artifact image destinations to a harden-safe relative source", () => {
    const rewritten = rewriteMarkdownArtifactImageSources(
      "before ![shot](zcode-artifact://session/shot-1) after",
    );
    expect(rewritten).not.toContain("zcode-artifact://");
    const source = rewritten.match(/!\[shot\]\(([^)]+)\)/u)?.[1];
    expect(source).toBeTruthy();
    expect(decodeMarkdownArtifactImageSource(source ?? "")).toBe("zcode-artifact://session/shot-1");
  });

  it("leaves normal images, links, and fenced examples unchanged", () => {
    const markdown = [
      "![web](https://example.com/image.png)",
      "[artifact](zcode-artifact://session/file)",
      "```md",
      "![example](zcode-artifact://session/example)",
      "```",
    ].join("\n");
    expect(rewriteMarkdownArtifactImageSources(markdown)).toBe(markdown);
  });
});
