import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("shared tabs layout spacing", () => {
  it("does not impose an implicit gap between the toolbar and content", async () => {
    const source = await readFile(
      new URL("../src/components/ui/tabs.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain('"group/tabs flex data-horizontal:flex-col"');
    expect(source).not.toContain(
      '"group/tabs flex gap-2 data-horizontal:flex-col"',
    );
  });
});
