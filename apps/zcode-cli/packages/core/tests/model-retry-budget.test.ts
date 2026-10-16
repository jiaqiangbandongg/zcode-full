import { describe, expect, it } from "vitest";
import { createSessionId, type SessionTaskType } from "@zcode/contracts";
import { resolveModelRetryBudgetFromTaskType } from "../src/runtime/methods/model-request-session-type.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

// docs/dynamic-workflow/concurrency.md「Unbounded retries for workflow traffic」：workflow actor 的模型请求拿无上限重试预算。
describe("resolveModelRetryBudgetFromTaskType", () => {
  it.each<{ expected: "default" | "unbounded"; taskType: SessionTaskType | undefined }>([
    { expected: "default", taskType: undefined },
    { expected: "default", taskType: "interactive" },
    { expected: "default", taskType: "fork" },
    { expected: "default", taskType: "selection_side_chat" },
    { expected: "default", taskType: "workflow_parent" },
    { expected: "default", taskType: "subagent_child" },
    { expected: "unbounded", taskType: "workflow_child" },
    { expected: "unbounded", taskType: "nested_workflow_child" },
  ])("maps $taskType to $expected", ({ expected, taskType }) => {
    expect(resolveModelRetryBudgetFromTaskType(taskType)).toBe(expected);
  });
});

describe("AgentRuntime model requests carry modelRetryBudget", () => {
  it.each<{ expected: "default" | "unbounded"; taskType: SessionTaskType }>([
    { expected: "unbounded", taskType: "workflow_child" },
    { expected: "unbounded", taskType: "nested_workflow_child" },
    { expected: "default", taskType: "subagent_child" },
    { expected: "default", taskType: "interactive" },
  ])("$taskType → $expected", async ({ expected, taskType }) => {
    const budgets: unknown[] = [];
    const runtime = createTestAgentRuntime(
      createSessionId(`runtime-retry-budget-${taskType}`),
      {
        agentName: "zcode-general-purpose",
        modelStreaming: "off",
        taskType,
        workingDirectory: "/tmp/runtime-retry-budget",
      },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          async generateText(_request, observation) {
            budgets.push(observation.invocationContext?.modelRetryBudget);
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "done",
              toolCalls: [],
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        }),
      },
    );

    await runtime.executeTurn("prompt");

    expect(budgets).toEqual([expected]);
  });
});
