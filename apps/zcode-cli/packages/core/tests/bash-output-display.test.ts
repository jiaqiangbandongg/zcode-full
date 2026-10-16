import { describe, expect, it } from "vitest";
import { toolResultDisplayPayloadSchema } from "@zcode/contracts";
import { createToolResultDisplay } from "../src/tool/executor/result-display.js";
const base = {
  stdout: "head",
  stderr: "",
  interrupted: false,
  isImage: false,
  status: "completed",
};
describe("Bash result display", () => {
  it("preserves the bounded head, actual truncation and canonical file path", () => {
    const display = createToolResultDisplay("Bash", {
      ...base,
      stdout: "x".repeat(30000),
      stdoutTruncated: true,
      persistedOutputPath: "/中文 空格/output.log",
    });
    expect(display).toEqual({
      kind: "bash_output",
      output: "x".repeat(30000),
      truncated: true,
      outputPath: "/中文 空格/output.log",
    });
    expect(toolResultDisplayPayloadSchema.parse(display)).toEqual(display);
  });
  it("retains small-output and background/image rendering without introducing a display", () => {
    for (const output of [
      base,
      { ...base, stdout: "x".repeat(30000), stdoutTruncated: false },
      { ...base, status: "backgrounded", persistedOutputPath: "/file" },
      { ...base, isImage: true, persistedOutputPath: "/file" },
    ]) {
      expect(createToolResultDisplay("Bash", output)).toBeUndefined();
    }
  });
  it("shows truncation without promising a file after output-limit cleanup", () => {
    expect(
      createToolResultDisplay("Bash", { ...base, stdoutTruncated: true, stderr: "killed" }),
    ).toEqual({ kind: "bash_output", output: "head\nkilled", truncated: true });
  });
  it("bounds display independently of an oversized or multibyte handler result", () => {
    const display = createToolResultDisplay("Bash", {
      ...base,
      stdout: "中".repeat(60000),
      persistedOutputPath: "/file",
    });
    expect(display?.kind).toBe("bash_output");
    if (display?.kind !== "bash_output") throw new Error("missing display");
    expect(display.truncated).toBe(true);
    expect(Buffer.byteLength(display.output)).toBeLessThanOrEqual(150000);
    expect(display.output).not.toContain("�");
  });
});
