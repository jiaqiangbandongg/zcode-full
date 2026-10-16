import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const rowActionFiles = [
  "PluginStoreCard.tsx",
  "SubagentsSection.tsx",
] as const;

describe("settings list row actions", () => {
  it("行内纯图标操作统一使用 icon-md", async () => {
    for (const fileName of rowActionFiles) {
      const source = await readFile(
        new URL(`../src/settings/${fileName}`, import.meta.url),
        "utf8",
      );
      expect(
        source.includes('size="icon-md"') ||
          source.includes('triggerSize = "icon-md"'),
        fileName,
      ).toBe(true);
      expect(source, fileName).not.toContain('size="icon-sm"');
      expect(source, fileName).not.toContain('size="icon"');
    }
  });

  it("剩余行内操作按钮组使用 4px 间距", async () => {
    for (const fileName of ["SubagentsSection.tsx"]) {
      const source = await readFile(
        new URL(`../src/settings/${fileName}`, import.meta.url),
        "utf8",
      );
      expect(source, fileName).toContain('className="flex items-center gap-1"');
      expect(source, fileName).not.toContain('className="flex items-center gap-0"');
    }
  });
});
