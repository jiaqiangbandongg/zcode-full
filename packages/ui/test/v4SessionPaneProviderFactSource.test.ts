import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sessionPaneSource = readFileSync(
  new URL("../src/v4/SessionPane.tsx", import.meta.url),
  "utf8",
);

describe("V4 SessionPane provider fact source", () => {
  it("recovers custom providers only from the Model Selection View", () => {
    expect(sessionPaneSource).toContain("modelSelectionView?.providers.find(");
    expect(sessionPaneSource).toContain("?.models[0]?.modelId");
    expect(sessionPaneSource).not.toContain("modelProviderService.getAllCached()");
  });
});
