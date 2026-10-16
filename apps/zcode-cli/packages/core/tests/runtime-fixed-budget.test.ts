import { describe, expect, it } from "vitest";
import { createSessionId } from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";

describe("Runtime 固定预算策略", () => {
  it.each(["legacy", "preflight-v1", undefined] as const)(
    "兼容输入 %s 归一并用于真实请求",
    async (strategy) => {
      const budgets: number[] = [];
      const runtime = createTestAgentRuntime(
        createSessionId("fixed-budget"),
        {
          modelContextBudgetStrategy: strategy,
          titleGeneration: { enabled: false },
          workingDirectory: "/workspace/project",
        },
        {
          eventStore: createTestSessionEventStore(),
          modelFactory: createTestModelFactory({
            maxOutputTokens: 64_000,
            properties: { contextWindow: 128_000 },
            async generateText(request, observation) {
              budgets.push(request.options?.maxOutputTokens ?? 0);
              return {
                finishReason: "stop",
                model: observation.model,
                text: "done",
                usage: { inputTokens: 70_000, outputTokens: 1, totalTokens: 70_001 },
              };
            },
          }),
        },
      );
      expect((runtime as unknown as AgentRuntimeInternal).config.modelContextBudgetStrategy).toBe(
        "preflight-v1",
      );
      await runtime.executeTurn("x".repeat(210_000));
      expect(budgets).toHaveLength(1);
      expect(budgets[0]).toBeGreaterThan(0);
      expect(budgets[0]).toBeLessThan(64_000);
    },
  );
});
