import { describe, expect, it } from "vitest";
import { collectGenUiSourcePaths, matchesGenUiSourcePath } from "@/gen-ui/contract.js";

describe("Gen UI source presentation contract", () => {
  it("deduplicates validated references without treating code or incomplete text as sources", () => {
    const reference = '::visualize{"path":"/work/demo.html"}';
    expect(collectGenUiSourcePaths(`${reference}\n${reference}`)).toEqual(["/work/demo.html"]);
    expect(
      collectGenUiSourcePaths(`\`${reference}\`\n::visualize{"path":"/work/demo.html"`),
    ).toEqual([]);
  });
  it("matches full executor paths across separators without merging same-name files", () => {
    const sources = collectGenUiSourcePaths('::visualize{"path":"C:/work/demo.html"}');
    expect(matchesGenUiSourcePath(String.raw`C:\work\demo.html`, sources)).toBe(true);
    expect(matchesGenUiSourcePath("C:/other/demo.html", sources)).toBe(false);
    expect(matchesGenUiSourcePath("/work/demo.html", sources)).toBe(false);
  });
});
