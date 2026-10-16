import { describe, expect, it } from "vitest";
import { normalizePowerShellReadlineRedraw } from "../src/terminal/terminalDataTransform.js";

const ESC = String.fromCharCode(0x1b);

describe("normalizePowerShellReadlineRedraw", () => {
  it("should reset PSReadLine redraw black backgrounds to the default background", () => {
    const input = `${ESC}[1;29H${ESC}[93mls${ESC}[37m${ESC}[40m  ${ESC}[37m${ESC}[40m${ESC}[0m${ESC}[1;33H`;

    const result = normalizePowerShellReadlineRedraw(input, "powershell.exe");

    expect(result).toBe(`${ESC}[1;29H${ESC}[93mls${ESC}[37m${ESC}[49m  ${ESC}[37m${ESC}[49m${ESC}[0m${ESC}[1;33H`);
  });

  it("should handle PowerShell 7 shell names", () => {
    const input = `${ESC}[1;29H${ESC}[37m${ESC}[40m  `;

    expect(normalizePowerShellReadlineRedraw(input, "C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBe(
      `${ESC}[1;29H${ESC}[37m${ESC}[49m  `,
    );
  });

  it("should leave non-PowerShell data unchanged", () => {
    const input = `${ESC}[1;29H${ESC}[37m${ESC}[40m  `;

    expect(normalizePowerShellReadlineRedraw(input, "bash")).toBe(input);
  });

  it("should leave command output with newlines unchanged", () => {
    const input = `${ESC}[37m${ESC}[40moutput${ESC}[0m\n`;

    expect(normalizePowerShellReadlineRedraw(input, "powershell.exe")).toBe(input);
  });
});
