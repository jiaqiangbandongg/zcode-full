import { describe, expect, it } from "vitest";
import {
  parseZCodeProcessDiagnostic,
  ZCODE_PROCESS_DIAGNOSTIC_PREFIX,
  ZCODE_PROCESS_DIAGNOSTIC_MAX_LINE_CHARS,
} from "@zcode/shared/process-diagnostic";
import { hostResponseMessageSchema } from "@zcode/shared";

const diagnostic = {
  version: 1,
  errorId: "1f51b7dc-c52a-46ad-bc97-d2f984e6e3de",
  kind: "uncaughtException",
  origin: "uncaughtException",
  name: "TypeError",
  message: "test exception",
  stack: "TypeError: test exception\n    at run (C:\\repo\\cli.js:1:2)",
  occurredAt: 123,
};

describe("CLI process diagnostic contract", () => {
  it("preserves multiline stack in one stderr frame and validates Host IPC", () => {
    const line = ZCODE_PROCESS_DIAGNOSTIC_PREFIX + JSON.stringify(diagnostic);
    expect(line.split("\n")).toHaveLength(1);
    expect(parseZCodeProcessDiagnostic(line)).toEqual(diagnostic);
    expect(
      hostResponseMessageSchema.parse({
        type: "agent-process-exception",
        diagnostic,
        pid: 123,
        provider: "glm",
        workspacePath: "C:\\repo",
        runtimeGeneration: 1,
        runtimeInstanceId: "agent-instance",
      }),
    ).toMatchObject({ diagnostic });
  });

  it("rejects unknown versions, extra fields, malformed/oversized data and ordinary logs", () => {
    for (const value of [
      { ...diagnostic, version: 2 },
      { ...diagnostic, taskId: "private" },
      { ...diagnostic, kind: "console.error" },
      { ...diagnostic, message: "x".repeat(4001) },
    ]) {
      expect(
        parseZCodeProcessDiagnostic(ZCODE_PROCESS_DIAGNOSTIC_PREFIX + JSON.stringify(value)),
      ).toBeUndefined();
    }
    for (const line of [
      "Error: ordinary stderr",
      ZCODE_PROCESS_DIAGNOSTIC_PREFIX + "{",
      ZCODE_PROCESS_DIAGNOSTIC_PREFIX + "x".repeat(ZCODE_PROCESS_DIAGNOSTIC_MAX_LINE_CHARS),
    ]) {
      expect(parseZCodeProcessDiagnostic(line)).toBeUndefined();
    }
  });
});
