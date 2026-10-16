import { describe, expect, it } from "vitest";
import type { ResolvedModelApiCallObservation } from "@zcode/contracts";
import { resolveModelRequestSessionType } from "../src/model/runner-status.js";

function modelCall(
  operation: ResolvedModelApiCallObservation["operation"],
  actorKind: ResolvedModelApiCallObservation["actorKind"],
): ResolvedModelApiCallObservation {
  return {
    actorKind,
    logicalCallId: "logical-call",
    operation,
    reasoning: {
      capability: "unknown",
      effectiveControl: "unknown",
      effectiveState: "unknown",
      requestedControl: "provider_default",
      requestedState: "provider_default",
    },
  };
}

describe("resolveModelRequestSessionType", () => {
  it.each([
    { actorKind: "main", expected: "main", operation: "agent_step" },
    { actorKind: "subagent", expected: "subagent", operation: "agent_step" },
    { actorKind: "workflow_child", expected: "other", operation: "agent_step" },
    { actorKind: "system", expected: "other", operation: "session_title_generation" },
    { actorKind: "system", expected: "other", operation: "project_memory_extract" },
    { actorKind: "system", expected: "other", operation: "workspace_generate_text" },
    { actorKind: "tool", expected: "other", operation: "web_search" },
    { actorKind: "tool", expected: "other", operation: "web_fetch_processing" },
    { actorKind: "tool", expected: "other", operation: "read_session_context_extract" },
  ] as const)("maps $operation/$actorKind to $expected", ({ actorKind, expected, operation }) => {
    expect(resolveModelRequestSessionType(undefined, modelCall(operation, actorKind))).toBe(
      expected,
    );
  });

  it("lets compact and goal verification inherit an explicit host type", () => {
    expect(resolveModelRequestSessionType("main", modelCall("context_compaction", "system"))).toBe(
      "main",
    );
    expect(
      resolveModelRequestSessionType(
        "subagent",
        modelCall("goal_completion_verification", "system"),
      ),
    ).toBe("subagent");
  });

  it.each([
    "agent_step",
    "context_compaction",
    "project_memory_recall",
    "session_title_generation",
  ] as const)("preserves explicit side_chat for %s", (operation) => {
    expect(resolveModelRequestSessionType("side_chat", modelCall(operation, "system"))).toBe(
      "side_chat",
    );
  });

  it("falls back safely when an untyped caller provides an invalid value", () => {
    expect(
      resolveModelRequestSessionType(
        "invalid" as never,
        modelCall("tool_internal_model_call", "system"),
      ),
    ).toBe("other");
  });
});
