import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const editForms = ["CommandForm.tsx", "HookForm.tsx", "McpServerForm.tsx"] as const;
const resourceLists = ["CommandCard.tsx", "HooksList.tsx", "McpServerList.tsx"] as const;

describe("settings edit form delete action", () => {
  it("uses the Subagent delete action style in editable forms", async () => {
    for (const fileName of editForms) {
      const source = await readFile(new URL(`../src/settings/${fileName}`, import.meta.url), "utf8");
      expect(source, fileName).toContain("onDelete");
      expect(source, fileName).toContain('variant="link"');
      expect(source, fileName).toContain('size="lg"');
      expect(source, fileName).toContain("px-0 text-destructive hover:text-destructive");
      expect(source, fileName).toContain('<Trash2 className="size-3.5"');
    }
  });

  it("removes duplicate delete actions from list rows", async () => {
    for (const fileName of resourceLists) {
      const source = await readFile(new URL(`../src/settings/${fileName}`, import.meta.url), "utf8");
      expect(source, fileName).not.toContain("<Trash2");
    }
  });
});
