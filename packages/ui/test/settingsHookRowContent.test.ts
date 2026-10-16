import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("settings Hook row content", () => {
  it("does not render the backing configuration path", async () => {
    const source = await readFile(
      new URL("../src/settings/HooksList.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("{command}");
    expect(source).not.toContain("{path}</p>");
    expect(source).not.toContain("text-foreground-subtle/60");
    expect(source).toContain(
      'className="mt-1 truncate font-mono text-ui-sm text-foreground-subtle"',
    );
  });
});
