import { describe, expect, it } from "vitest";
import {
  createSessionId,
  type ModelRequestAdmission,
  type ModelRequestAdmissionTicket,
} from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

// docs/dynamic-workflow/concurrency.md「Where the port is bound」：准入端口从 runtime deps 经调用上下文到达
// adapter 请求（runner 把调用上下文整份铺进请求）；缺席即缺席；subagent 子 runtime 继承父的端口。

function admissionStub(): ModelRequestAdmission {
  const ticket: ModelRequestAdmissionTicket = { publish() {}, release() {} };
  return { acquire: async () => ticket };
}

function okResult(text = "done") {
  return {
    finishReason: "stop" as const,
    providerMetadata: undefined,
    text,
    toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  };
}

describe("AgentRuntime model requests carry modelRequestAdmission", () => {
  it("passes the deps admission through to the adapter request", async () => {
    const admission = admissionStub();
    const seen: unknown[] = [];
    const runtime = createTestAgentRuntime(
      createSessionId("runtime-admission-present"),
      { agentName: "zcode-general-purpose", modelStreaming: "off", workingDirectory: "/tmp/runtime-admission" },
      {
        eventStore: createTestSessionEventStore(),
        modelRequestAdmission: admission,
        modelFactory: createTestModelFactory({
          async generateText(_request, observation) {
            seen.push(observation.invocationContext?.modelRequestAdmission);
            return okResult();
          },
        }),
      },
    );
    await runtime.executeTurn("prompt");
    expect(seen).toEqual([admission]);
  });

  it("leaves the field absent when deps carry no admission", async () => {
    const seen: Array<boolean> = [];
    const runtime = createTestAgentRuntime(
      createSessionId("runtime-admission-absent"),
      { agentName: "zcode-general-purpose", modelStreaming: "off", workingDirectory: "/tmp/runtime-admission" },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          async generateText(_request, observation) {
            seen.push(observation.invocationContext?.modelRequestAdmission !== undefined);
            return okResult();
          },
        }),
      },
    );
    await runtime.executeTurn("prompt");
    expect(seen).toEqual([false]);
  });

  it("subagent child runtimes inherit the parent's admission", async () => {
    const admission = admissionStub();
    const childAdmissions: unknown[] = [];
    let parentCalls = 0;
    const runtime = createTestAgentRuntime(
      createSessionId("runtime-admission-subagent"),
      { mode: "build", modelStreaming: "off", workingDirectory: "/workspace/project" },
      {
        eventStore: createTestSessionEventStore(),
        modelRequestAdmission: admission,
        modelFactory: createTestModelFactory({
          async generateText(request, observation) {
            const toolNames = (request.tools ?? []).map((tool) => tool.name);
            if (toolNames.includes("Agent")) {
              parentCalls += 1;
              if (parentCalls === 1) {
                return {
                  finishReason: "tool-calls",
                  providerMetadata: undefined,
                  text: "",
                  toolCalls: [
                    {
                      id: "call_child",
                      name: "Agent",
                      input: { description: "child", prompt: "say hi", subagent_type: "Explore" },
                    },
                  ],
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                };
              }
              return okResult("parent done");
            }
            childAdmissions.push(observation.invocationContext?.modelRequestAdmission);
            return okResult("child done");
          },
        }),
      },
    );
    const result = await runtime.executeTurn("spawn a child");
    expect(result.response).toBe("parent done");
    expect(childAdmissions.length).toBeGreaterThan(0);
    expect(childAdmissions.every((value) => value === admission)).toBe(true);
  });
});
