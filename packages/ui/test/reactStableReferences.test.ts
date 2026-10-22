import { describe, expect, it } from "vitest";
import {
  createProject,
  formatFinding,
  collectMemoComponentsWithInlineDefaults,
  collectInlineProviderValues,
} from "./reactStableReferences.helpers.js";

describe("React stable reference boundaries", () => {
  it("does not create non-primitive defaults inside memoized component props", () => {
    const findings = collectMemoComponentsWithInlineDefaults(createProject());

    expect(findings.map(formatFinding)).toEqual([]);
  });

  it("does not create inline object context provider values", () => {
    const findings = collectInlineProviderValues(createProject());

    expect(findings.map(formatFinding)).toEqual([]);
  });
});
