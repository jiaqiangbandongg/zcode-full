import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const [
  automationsSectionSource,
  offPeakTaskListSource,
  offPeakNewTaskEntrySource,
  automationDesignPrimitivesSource,
] = await Promise.all([
  readFile(
    new URL("../src/settings/AutomationsSection.tsx", import.meta.url),
    "utf8",
  ),
  readFile(
    new URL("../src/settings/OffPeakTaskList.tsx", import.meta.url),
    "utf8",
  ),
  readFile(
    new URL("../src/v4/OffPeakNewTaskEntry.tsx", import.meta.url),
    "utf8",
  ),
  readFile(
    new URL("../src/settings/AutomationDesignPrimitives.tsx", import.meta.url),
    "utf8",
  ),
]);

describe("automation card border tokens", () => {
  it("aligns homepage and automation cards to the Card Border semantic token", () => {
    expect(offPeakNewTaskEntrySource).toContain(
      "rounded-2xl border border-card-border bg-background",
    );
    expect(automationsSectionSource).toContain(
      "rounded-xl border border-card-border bg-background",
    );
    expect(automationsSectionSource).toContain(
      "rounded-2xl border border-card-border bg-background",
    );
    expect(offPeakTaskListSource).toContain(
      "rounded-[10px] border border-card-border",
    );
    expect(automationDesignPrimitivesSource).toContain(
      "rounded-xl border border-dashed border-card-border bg-background",
    );
  });

  it("does not use weaker surface borders or inset shadows for automation cards", () => {
    expect(automationsSectionSource).not.toContain(
      "rounded-xl border border-surface bg-background",
    );
    expect(automationsSectionSource).not.toContain(
      "rounded-2xl border border-surface bg-background",
    );
    expect(offPeakTaskListSource).not.toContain(
      "shadow-[inset_0_0_0_1px_var(--color-surface)]",
    );
    expect(automationDesignPrimitivesSource).not.toContain(
      '"border border-surface bg-background"',
    );
  });
});
