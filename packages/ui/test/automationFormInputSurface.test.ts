import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("automation form input surface", () => {
  it("matches the settings search input size, surface, and border semantics", () => {
    const editView = readFileSync(
      "packages/ui/src/settings/AutomationEditView.tsx",
      "utf8",
    );
    const composer = readFileSync(
      "packages/ui/src/settings/AutomationInstructionsComposer.tsx",
      "utf8",
    );

    expect(editView).toContain('size="lg"');
    expect(editView).toContain(
      '"h-9 rounded-xl bg-input px-3 text-foreground"',
    );
    expect(editView).toContain(
      "rounded-xl border border-input-border bg-input",
    );
    expect(composer).toContain(
      "rounded-xl border-0 bg-surface",
    );
    expect(composer).toContain("rounded-xl border border-input-border bg-input");
    expect(composer).toContain("bg-input p-3 text-foreground");
  });
});
