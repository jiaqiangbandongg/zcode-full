import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("packages/ui/src/styles.css", "utf8");

describe("blocking interaction theme tokens", () => {
  it("defines Ask blue and confirmation green semantics for every supported theme", () => {
    const tokens = [
      "--color-interaction-ask-surface",
      "--color-interaction-ask-foreground",
      "--color-interaction-ask-fill",
      "--color-interaction-confirmation-surface",
      "--color-interaction-confirmation-foreground",
    ];

    for (const token of tokens) {
      expect(styles.match(new RegExp(`${token}:`, "g"))).toHaveLength(4);
    }
    expect(styles).toContain("--color-interaction-ask-fill: rgba(70, 191, 114, 0.2);");
    expect(styles).toContain("--color-interaction-ask-fill: rgba(70, 191, 114, 0.24);");
    expect(styles).toContain("--color-interaction-confirmation-surface: #eaf7ee;");
    expect(styles).toContain("--color-interaction-confirmation-surface: rgba(70, 191, 114, 0.16);");
  });
});
