import { describe, expect, it } from "vitest";
import type { ExecutionShellSelection } from "@zcode/contracts";
import {
  shouldInjectEmbeddedSearchBashPrelude,
  supportsEmbeddedSearchShellSelection,
} from "../src/embedded-search/shell.js";

describe("shouldInjectEmbeddedSearchBashPrelude", () => {
  it("enables runtime find/grep alias injection by default", () => {
    expect(shouldInjectEmbeddedSearchBashPrelude()).toBe(true);
  });
});

describe("supportsEmbeddedSearchShellSelection", () => {
  it("supports POSIX and Git Bash session shells for runtime prelude injection", () => {
    expect(supportsEmbeddedSearchShellSelection(undefined)).toBe(false);
    expect(
      supportsEmbeddedSearchShellSelection({
        dialect: "posix",
        display: { name: "bash" },
        path: "/bin/bash",
        source: "auto-detected",
      } satisfies ExecutionShellSelection),
    ).toBe(true);
    expect(
      supportsEmbeddedSearchShellSelection({
        dialect: "git-bash",
        display: { name: "Git Bash" },
        path: "C:\\Program Files\\Git\\bin\\bash.exe",
        source: "auto-detected",
      } satisfies ExecutionShellSelection),
    ).toBe(true);
    expect(
      supportsEmbeddedSearchShellSelection({
        dialect: "cmd",
        display: { name: "CMD" },
        path: "cmd.exe",
        source: "user-config",
      } satisfies ExecutionShellSelection),
    ).toBe(false);
    expect(
      supportsEmbeddedSearchShellSelection({
        dialect: "legacy-shell",
        display: { name: "system shell" },
        source: "legacy-fallback",
      } satisfies ExecutionShellSelection),
    ).toBe(false);
  });
});
