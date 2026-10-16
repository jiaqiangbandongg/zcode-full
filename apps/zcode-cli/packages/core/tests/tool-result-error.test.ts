import { describe, expect, it } from "vitest";
import { isErrorForToolResult } from "../src/runtime/helpers/tool-result.js";
import type { ToolExecutionResult } from "../src/tool/types.js";

describe("tool result model error flag", () => {
  it("uses explicit tool output error flags and execution failures", () => {
    expect(isErrorForToolResult(toolResult({ success: false, output: "boom" }))).toBe(true);
    expect(isErrorForToolResult(toolResult({ output: { isError: true } }))).toBe(true);
    expect(isErrorForToolResult(toolResult({ output: { is_error: true } }))).toBe(true);
  });

  it("marks interrupted and failed Bash commands as is_error", () => {
    expect(
      isErrorForToolResult(
        toolResult({
          toolName: "Bash",
          output: { interrupted: true, status: "cancelled" },
        }),
      ),
    ).toBe(true);

    expect(
      isErrorForToolResult(
        toolResult({
          toolName: "Bash",
          output: { exitCode: 1, interrupted: false, status: "failed" },
        }),
      ),
    ).toBe(true);

    expect(
      isErrorForToolResult(
        toolResult({
          toolName: "Bash",
          output: {
            exitCode: 1,
            interrupted: false,
            returnCodeInterpretation: "No matches found",
            status: "failed",
          },
        }),
      ),
    ).toBe(false);
  });
});

function toolResult(options: {
  output: unknown;
  success?: boolean;
  toolName?: string;
}): ToolExecutionResult {
  const now = new Date();
  return {
    completedAt: now,
    durationMs: 1,
    output: options.output,
    startedAt: now,
    success: options.success ?? true,
    toolCallId: "call_test",
    toolName: options.toolName ?? "Test",
  };
}
