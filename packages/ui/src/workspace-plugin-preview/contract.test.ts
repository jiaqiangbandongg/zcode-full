import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("workspace preview icon sizing", () => {
  it("keeps both thumbnail and picker images governed by the shared PluginIcon", () => {
    const source = readFileSync(new URL("./WorkspacePluginPreview.tsx", import.meta.url), "utf8");
    const icons = source.match(/<PluginIcon\b[\s\S]*?\/>/g) ?? [];
    expect(icons).toHaveLength(2);
    for (const icon of icons) {
      expect(icon).toContain("size-5");
      expect(icon).not.toMatch(/\[.*img.*\]/);
      expect(icon).toContain('iconClassName="size-4"');
    }
  });
});
