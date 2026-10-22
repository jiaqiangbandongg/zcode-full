import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Source Server Host release wiring", () => {
  it("injects one development release resolver into every Manager connection path", async () => {
    const source = await readFile(new URL("../src/host/index.ts", import.meta.url), "utf8");

    expect(source).toContain("const resolveSourceServerRelease = async");
    expect(source).toMatch(
      /new SourceServerConnectionManager\(\{[\s\S]*?resolveRelease: resolveSourceServerRelease,[\s\S]*?\}\)/,
    );
    expect(source).toMatch(
      /createSourceServerManagementService\(\{[\s\S]*?resolveRelease: resolveSourceServerRelease,[\s\S]*?\}\)/,
    );
  });
});
