import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Hooks settings toolbar", () => {
  it("uses the shared scope menu and capability count", () => {
    const source = readFileSync("packages/ui/src/settings/HooksSection.tsx", "utf8");

    expect(source).toContain("<PluginScopeMenu");
    expect(source).toContain('data-independent-capability-count="true"');
    expect(source).toContain('className="hidden h-4 w-px bg-border sm:block"');
    expect(source).not.toContain("<HooksScopeTabs");
    expect(source).not.toContain("RefreshCw");
  });
});
