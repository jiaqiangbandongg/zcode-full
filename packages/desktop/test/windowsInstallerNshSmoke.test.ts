import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const desktopDir = resolve(import.meta.dirname, "..");

describe.skipIf(process.platform !== "win32")("Windows installer.nsh smoke", () => {
  it(
    "compiles with electron-builder NSIS and preserves shortcut intent",
    () => {
      const output = execFileSync(
        process.execPath,
        [resolve(desktopDir, "scripts/test-installer-nsh-smoke.mjs")],
        {
          cwd: desktopDir,
          encoding: "utf-8",
          env: process.env,
        },
      );

      expect(output).toContain("[installer-nsh-smoke] passed");
    },
    120_000,
  );
});
