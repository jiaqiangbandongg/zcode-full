import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Plugin detail Hero style", () => {
  it("uses a wide responsive banner and readable prompt pills", () => {
    const source = readFileSync(
      "packages/ui/src/settings/PluginStoreDetailView.tsx",
      "utf8",
    );

    expect(source).toContain('data-testid="plugin-store-hero"');
    expect(source).toContain("sm:aspect-[3/1]");
    expect(source).toContain("min-h-72");
    expect(source).toContain('data-testid="plugin-store-hero-overlay"');
    expect(source).toContain("<ThemeHeroVisual");
    expect(source).toContain("opacity-80");
    expect(source).toContain("max-w-2xl");
    expect(source).toContain("whitespace-normal");
    expect(source).not.toContain('className="min-w-0 truncate">{prompt}</span>');
    expect(source).not.toContain('className="h-72 w-full select-none object-cover"');
    expect(source).not.toContain('return <div className="flex flex-col items-center gap-3">{prompts}</div>');
  });
});
