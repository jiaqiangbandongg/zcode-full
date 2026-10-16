import { describe, expect, it } from "vitest";
import { buildBashOutputPreview } from "../src/exec/bash-output-preview.js";

describe("bounded Bash output preview", () => {
  it("keeps the last 5 and 100 lines of one tail, including trailing newlines", () => {
    const text = Array.from({ length: 120 }, (_, i) => `line-${i + 1}`).join("\n");
    const bytes = Buffer.byteLength(text);
    expect(buildBashOutputPreview(text, bytes, bytes, 0)).toEqual({
      text: Array.from({ length: 5 }, (_, i) => `line-${i + 116}`).join("\n"),
      fullText: Array.from({ length: 100 }, (_, i) => `line-${i + 21}`).join("\n"),
      totalBytes: bytes,
      totalLines: 120,
      linesEstimated: false,
    });
    expect(buildBashOutputPreview("a\nb\n", 4, 4, 0).totalLines).toBe(3);
  });
  it("preserves CRLF and leading/trailing empty lines", () => {
    const text = "\r\none\r\ntwo\r\n";
    expect(buildBashOutputPreview(text, 12, 12, 0)).toMatchObject({
      text,
      fullText: text,
      totalLines: 4,
      linesEstimated: false,
    });
    expect(buildBashOutputPreview("", 0, 100, 12)).toMatchObject({
      totalLines: 12,
      linesEstimated: false,
    });
  });
  it("estimates from raw bytes and never decreases an estimate", () => {
    expect(buildBashOutputPreview("中文\n", 5, 100, 0)).toMatchObject({
      totalLines: 40,
      linesEstimated: true,
    });
    expect(buildBashOutputPreview("one long line", 13, 100, 40).totalLines).toBe(40);
  });
  it("handles empty output and a long line without division by zero", () => {
    expect(buildBashOutputPreview("", 0, 0, 0)).toEqual({
      text: "",
      fullText: "",
      totalBytes: 0,
      totalLines: 0,
      linesEstimated: false,
    });
    expect(buildBashOutputPreview("x".repeat(4096), 4096, 8192, 0)).toMatchObject({
      totalLines: 2,
      linesEstimated: true,
    });
  });
});
