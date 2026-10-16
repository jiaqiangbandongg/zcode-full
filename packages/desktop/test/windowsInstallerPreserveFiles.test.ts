import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const desktopDir = resolve(import.meta.dirname, "..");

describe.skipIf(process.platform !== "win32")("Windows installer file ownership", () => {
  it("preserves files that are absent from the ownership manifest", () => {
    const output = execFileSync(
      process.execPath,
      [resolve(desktopDir, "scripts/test-installer-preserve-files.mjs")],
      { cwd: desktopDir, encoding: "utf-8" },
    );
    expect(output).toContain("[installer-preserve-files] passed");
  }, 120_000);
});
