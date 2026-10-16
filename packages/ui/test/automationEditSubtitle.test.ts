import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Automation edit title block", () => {
  it("shows the task title and localized guidance above the tabs", () => {
    const source = readFileSync(
      new URL("../src/settings/AutomationEditView.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain('data-testid="automation-edit-title"');
    expect(source).toContain('"automations.form.createTitle"');
    expect(source).toContain('"automations.form.editTitle"');
    expect(source).toContain("text-ui-xl font-semibold text-foreground");
    expect(source).toContain('data-testid="automation-edit-subtitle"');
    expect(source).toContain('"automations.edit.createSubtitle"');
    expect(source).toContain('"automations.edit.editSubtitle"');
    expect(source).toContain("text-ui-base text-foreground-subtle");
    expect(source.indexOf('data-testid="automation-edit-title"')).toBeLessThan(
      source.indexOf('data-testid="automation-edit-subtitle"'),
    );
    expect(source.indexOf('data-testid="automation-edit-subtitle"')).toBeLessThan(
      source.indexOf("<AutomationSettingsHistoryTabs"),
    );
  });
});
