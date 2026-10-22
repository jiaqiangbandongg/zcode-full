import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sessionPaneSource = readFileSync(
  new URL("../src/v4/SessionPane.tsx", import.meta.url),
  "utf8",
);

describe("V4 SessionPane provider fact source", () => {
  it("keeps provider-only recovery sourced from the Model Selection View in SessionPane source", () => {
    expect(sessionPaneSource).toContain("modelSelectionView?.providers.find(");
    expect(sessionPaneSource).not.toContain("modelProviderService.getAllCached()");
  });
});
