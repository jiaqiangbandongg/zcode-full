import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Web home-only media preview service", () => {
  it("declares an explicit unsupported service before a workspace bridge exists", () => {
    const source = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
    expect(source).toContain("mediaPreviewService:");
    expect(source).toContain(
      'createUnsupportedHomeOnlyService<NonNullable<RootServices["mediaPreviewService"]>>',
    );
    expect(source).toContain('"mediaPreviewService"');
  });
});
