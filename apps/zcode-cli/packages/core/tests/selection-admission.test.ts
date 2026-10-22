import { describe, expect, it } from "vitest";
import { createSessionId, type TurnInputIntentMetadata } from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { createTestModelSelection } from "./test-model-selection.js";
import { acceptSubmissionModelSelection } from "../src/runtime/methods/turn-model.js";

function intent(sequence: number, model: string): TurnInputIntentMetadata {
  return {
    sourceCommandId: `input-${sequence}`,
    queueItemId: `input-${sequence}`,
    clientId: "test",
    kind: "sendText",
    admissionSeq: sequence,
    admittedAt: sequence,
    requestedDelivery: "queue",
    admittedDelivery: "queue",
    modelSelection: createTestModelSelection(`provider/${model}`),
  };
}

describe("Session selection admission", () => {
  it("加速卡接纳保存本次普通选择，既不保存加速端点也不保留临时闲时选择", async () => {
    const runtime = createTestAgentRuntime(
      createSessionId("highspeed-takeover"),
      {
        modelSelection: createTestModelSelection("idle/idle"),
      },
      { eventStore: createTestSessionEventStore() },
    );
    const fallback = createTestModelSelection("user/normal");
    await acceptSubmissionModelSelection(
      runtime,
      intent(1, "accelerated"),
      runtime.rootTraceContext,
      {
        selectionScope: "execution",
        selectionFallback: {
          providerId: "provider",
          target: fallback,
          rules: [{ reason: "highspeed_card_expired", providerErrorCode: "3102" }],
        },
      },
    );
    expect(runtime.getSessionModelSelection()).toEqual(fallback);
  });
  it("接受排队输入立即更新续跑选择，旧输入执行仍用自己的选择且不覆盖新选择", async () => {
    const requests: string[] = [];
    const runtime = createTestAgentRuntime(
      createSessionId("selection-admission"),
      {
        modelSelection: createTestModelSelection("provider/initial"),
        workingDirectory: "/workspace",
        titleGeneration: { enabled: false },
      },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          async generateText(_request, observation) {
            requests.push(String(observation.model.modelId));
            return {
              finishReason: "stop",
              text: "done",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        }),
      },
    );
    const first = intent(1, "first");
    const second = intent(2, "second");
    await runtime.enqueueDeferredInput({ input: "first", intent: first });
    expect(runtime.getSessionModelSelection()).toEqual(first.modelSelection);
    await runtime.enqueueDeferredInput({ input: "second", intent: second });
    expect(runtime.getSessionModelSelection()).toEqual(second.modelSelection);
    await runtime.executeTurn("consume first", undefined, { intent: first });
    expect(requests[0]).toBe("first");
    expect(runtime.getSessionModelSelection()).toEqual(second.modelSelection);
  });

  it("拒绝的排队输入不接管续跑选择", async () => {
    const initial = createTestModelSelection("provider/initial");
    const runtime = createTestAgentRuntime(
      createSessionId("selection-rejected"),
      { modelSelection: initial },
      { eventStore: createTestSessionEventStore() },
    );
    const result = await runtime.enqueueDeferredInput({ input: "", intent: intent(1, "rejected") });
    expect(result.kind).toBe("rejected");
    expect(runtime.getSessionModelSelection()).toEqual(initial);
  });
});
