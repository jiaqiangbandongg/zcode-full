import { describe, expect, it } from "vitest";
import {
  createSessionId,
  runWithModelInvocationContext,
  type ModelInvocationContext,
  type ModelRequestAdmission,
  type ModelRequestAdmissionTicket,
  type ModelSelection,
} from "@zcode/contracts";
import { createRuntimeModel } from "../src/runtime/methods/runtime-model.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

// docs/dynamic-workflow/concurrency.md「Where the port is bound」：准入端口与重试预算绑定在 runtime 的模型工厂上，
// runtime 交出的每一个句柄——turn step 与工具内部的模型调用——都带它们；调用层设什么都压不过。
// 设计缺口的根因：此前只在 turn step 注入，WebSearch 这类工具侧请求全部绕过闸门。

const modelSelection: ModelSelection = { providerId: "deepseek", modelId: "deepseek-chat" };

function admissionStub(): ModelRequestAdmission {
  const ticket: ModelRequestAdmissionTicket = { publish() {}, release() {} };
  return { acquire: async () => ticket };
}

/** adapter 看到的请求：runner 把调用上下文整份铺进请求（adapters/src/model/runner.ts），这里照样记。 */
type SeenRequest = Record<string, unknown> & Partial<ModelInvocationContext>;

/** 一轮：主请求发一次 WebSearch，工具内部发流式 web_search 请求，再收口。 */
function modelFactoryWithWebSearch(requests: SeenRequest[]) {
  let mainRequestCount = 0;
  return createTestModelFactory({
    properties: { supportsNativeWebSearch: true },
    async generateText(request, observation) {
      requests.push({ ...request, ...observation.invocationContext });
      mainRequestCount += 1;
      if (mainRequestCount === 1) {
        return {
          finishReason: "tool-calls",
          model: request.model,
          providerMetadata: undefined,
          text: "",
          toolCalls: [
            { id: "call_websearch", input: { query: "latest zcode" }, name: "WebSearch" },
          ],
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      }
      return {
        finishReason: "stop",
        model: request.model,
        providerMetadata: undefined,
        text: "done",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
    async *streamText(request, observation) {
      requests.push({ ...request, ...observation.invocationContext });
      yield { type: "start" };
      yield { id: "t", type: "text_start" };
      yield { id: "t", text: "summary", type: "text_delta" };
      yield { id: "t", type: "text_end" };
      yield {
        finishReason: "stop",
        providerMetadata: { rawFinishReason: "end_turn" },
        type: "finish",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          serverToolUse: { webSearchRequests: 1 },
          totalTokens: 2,
        },
      };
    },
  } as never);
}

describe("runtime model factory binds admission and retry budget (v3 决策 42)", () => {
  it("WebSearch 工具内部的模型请求带 runtime 的准入端口与 workflow_child 的无上限预算", async () => {
    const admission = admissionStub();
    const requests: SeenRequest[] = [];
    const runtime = createTestAgentRuntime(
      createSessionId("runtime-admission-websearch"),
      { modelSelection, modelStreaming: "off", taskType: "workflow_child" },
      {
        eventStore: createTestSessionEventStore(),
        modelRequestAdmission: admission,
        modelFactory: modelFactoryWithWebSearch(requests),
      },
    );
    await runtime.executeTurn("search");

    const tool = requests.find(
      (request) =>
        (request.metadata as { querySource?: string })?.querySource === "web_search_tool",
    );
    const turn = requests.find(
      (request) =>
        (request.metadata as { querySource?: string })?.querySource !== "web_search_tool",
    );
    expect(tool).toBeDefined();
    expect(turn).toBeDefined();
    expect(tool!.modelRequestAdmission).toBe(admission);
    expect(tool!.modelRetryBudget).toBe("unbounded");
    expect(turn!.modelRequestAdmission).toBe(admission);
    expect(turn!.modelRetryBudget).toBe("unbounded");
  });

  it.each([
    ["interactive", "main"],
    ["subagent_child", "subagent"],
    ["selection_side_chat", "side_chat"],
  ] as const)(
    "%s 工具请求继承宿主类型，保持默认重试预算且无准入端口",
    async (taskType, expectedSessionType) => {
      const requests: SeenRequest[] = [];
      const runtime = createTestAgentRuntime(
        createSessionId("runtime-admission-websearch-absent"),
        { modelSelection, modelStreaming: "off", taskType },
        {
          eventStore: createTestSessionEventStore(),
          modelFactory: modelFactoryWithWebSearch(requests),
        },
      );
      await runtime.executeTurn("search");
      const tool = requests.find(
        (request) =>
          (request.metadata as { querySource?: string })?.querySource === "web_search_tool",
      );
      expect(tool).toBeDefined();
      expect(tool!.modelRequestAdmission).toBeUndefined();
      expect(tool!.modelRetryBudget).toBe("default");
      expect(tool!.modelRequestSessionType).toBe(expectedSessionType);
    },
  );

  it("runtime 层压过调用层：调用点塞的 modelRequestAdmission 到不了 adapter", async () => {
    const admission = admissionStub();
    const other = admissionStub();
    const seen: unknown[] = [];
    const runtime = createTestAgentRuntime(
      createSessionId("runtime-admission-layer-precedence"),
      { modelSelection, modelStreaming: "off", taskType: "workflow_child" },
      {
        eventStore: createTestSessionEventStore(),
        modelRequestAdmission: admission,
        modelFactory: createTestModelFactory({
          async generateText(_request, observation) {
            const context = observation.invocationContext;
            seen.push([context?.modelRequestAdmission, context?.modelRetryBudget]);
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "ok",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            } as never;
          },
        }),
      },
    );
    const model = createRuntimeModel(runtime as never, { selection: modelSelection });
    await runWithModelInvocationContext(
      {
        modelRequestAdmission: other,
        modelRetryBudget: "default",
        metadata: { querySource: "probe" },
      },
      () => model.generateText({ messages: [{ role: "user", content: "hi" }] } as never),
    );
    expect(seen).toEqual([[admission, "unbounded"]]);
  });
});
