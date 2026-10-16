import { describe, expect, it } from "vitest";
import {
  extractPlanStepsFromToolInput,
  isMainAgentToolProjectionSource,
} from "../src/tool-plan-adapter.js";

describe("tool plan adapter", () => {
  it("extracts TodoWrite plan steps for main agent tools", () => {
    expect(
      extractPlanStepsFromToolInput({
        kind: "TodoWrite",
        input: {
          todos: [
            { content: "Inspect logs", status: "completed" },
            { content: "Patch projection", status: "in_progress" },
          ],
        },
      }),
    ).toEqual([
      { id: "Inspect logs", title: "Inspect logs", status: "completed" },
      { id: "Patch projection", title: "Patch projection", status: "in_progress" },
    ]);
  });

  it("detects nested tool payloads that must not drive the main task plan", () => {
    expect(isMainAgentToolProjectionSource({ toolCallId: "call_main" })).toBe(true);
    expect(isMainAgentToolProjectionSource({ source: "subagent" })).toBe(false);
    expect(isMainAgentToolProjectionSource({ parentToolCallId: "call_agent" })).toBe(false);
    expect(isMainAgentToolProjectionSource({ parentToolUseId: "call_agent" })).toBe(false);
    expect(
      isMainAgentToolProjectionSource({
        _meta: { claudeCode: { parentToolUseId: "call_agent" } },
      }),
    ).toBe(false);
  });
});
