import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const editableResourceRows = [
  "CommandCard.tsx",
  "HooksList.tsx",
  "McpServerList.tsx",
  "SubagentsSection.tsx",
] as const;

const defaultCursorResourceLists = [
  ...editableResourceRows,
  "SkillsSection.tsx",
] as const;

describe("settings resource row navigation", () => {
  it("removes dedicated edit icons from resource lists", async () => {
    for (const fileName of editableResourceRows) {
      const source = await readFile(
        new URL(`../src/settings/${fileName}`, import.meta.url),
        "utf8",
      );

      expect(source, fileName).not.toContain("<Pencil");
    }
  });

  it("makes editable rows keyboard accessible", async () => {
    for (const fileName of editableResourceRows) {
      const source = await readFile(
        new URL(`../src/settings/${fileName}`, import.meta.url),
        "utf8",
      );

      expect(source, fileName).toContain("settingsResourceRowInteraction");
    }

    const interactionSource = await readFile(
      new URL(
        "../src/settings/settingsResourceRowInteraction.ts",
        import.meta.url,
      ),
      "utf8",
    );
    expect(interactionSource).toContain('role: "button"');
    expect(interactionSource).toContain("onKeyDown");
    expect(interactionSource).toContain(
      'event.key === "Enter" || event.key === " "',
    );
    expect(interactionSource).toContain("closest(INTERACTIVE_SELECTOR)");
  });

  it("keeps the default arrow cursor on clickable rows", async () => {
    for (const fileName of defaultCursorResourceLists) {
      const source = await readFile(
        new URL(`../src/settings/${fileName}`, import.meta.url),
        "utf8",
      );
      expect(source, fileName).not.toContain("cursor-pointer");
      expect(source, fileName).toContain("cursor-default");
      expect(source, fileName).toContain("hover:bg-hover");
    }
  });
});
