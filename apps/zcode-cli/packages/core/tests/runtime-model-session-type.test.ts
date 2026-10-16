import { describe, expect, it } from "vitest";
import {
  createRootTraceContext,
  createSessionId,
  getCurrentModelInvocationContext,
  runWithModelInvocationContext,
  type ModelInvocationContext,
  type SessionTaskType,
} from "@zcode/contracts";
import { createRuntimeModel } from "../src/runtime/methods/runtime-model.js";
import { generateTitleCandidate } from "../src/runtime/methods/title-generation-sidecar.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

const selection = { providerId: "test", modelId: "model" };
const request = { messages: [{ role: "user" as const, content: "hello" }] };
const result = { text: '{"title":"Session title"}', finishReason: "stop" as const };

function createRuntime(taskType: SessionTaskType, seen: ModelInvocationContext[]) {
  return createTestAgentRuntime(
    createSessionId(`session-type-${taskType}`),
    { modelSelection: selection, taskType },
    {
      eventStore: createTestSessionEventStore(),
      modelFactory: createTestModelFactory({
        async generateText(_request, observation) {
          seen.push(observation.invocationContext!);
          return result;
        },
        async *streamText() {
          // 在 iterator 真正消费时观察上下文，覆盖 stream 创建与消费跨异步边界的情形。
          await Promise.resolve();
          seen.push(getCurrentModelInvocationContext()!);
          yield { type: "finish", finishReason: "stop" };
        },
      }),
    },
  );
}

describe("runtime model session attribution", () => {
  it.each([
    ["interactive", "main"],
    ["subagent_child", "subagent"],
    ["selection_side_chat", "side_chat"],
    ["workflow_child", "other"],
  ] as const)("%s binds its session type independently of purpose", async (taskType, expected) => {
    const seen: ModelInvocationContext[] = [];
    const runtime = createRuntime(taskType, seen);
    const model = createRuntimeModel(runtime as never, { selection }).bind({ maxOutputTokens: 64 });
    await Promise.all(
      ["main_turn", "compact", "session_title", "project_memory_recall"].map((querySource) =>
        runWithModelInvocationContext(
          { metadata: { querySource }, modelRequestSessionType: "other" },
          () => model.generateText(request),
        ),
      ),
    );
    const stream = runWithModelInvocationContext(
      { metadata: { querySource: "web_search_tool" }, modelRequestSessionType: "other" },
      () => model.streamText(request),
    );
    for await (const _event of stream) {
      /* 消费完整流。 */
    }
    expect(seen.map((context) => context.modelRequestSessionType)).toEqual([
      expected,
      expected,
      expected,
      expected,
      expected,
    ]);
    expect(seen.map((context) => context.metadata?.querySource)).toEqual([
      "main_turn",
      "compact",
      "session_title",
      "project_memory_recall",
      "web_search_tool",
    ]);
    expect(getCurrentModelInvocationContext()).toBeUndefined();
  });

  it("concurrent main and subagent models retain their own session classification", async () => {
    const seen: ModelInvocationContext[] = [];
    await Promise.all(
      (["interactive", "subagent_child"] as const).map(async (taskType) => {
        const runtime = createRuntime(taskType, seen);
        const model = createRuntimeModel(runtime as never, { selection });
        const stream = runWithModelInvocationContext(
          { metadata: { querySource: "project_memory_recall" } },
          () => model.streamText(request),
        );
        for await (const _event of stream) {
          /* 消费完整流。 */
        }
      }),
    );
    expect(seen.map((context) => context.modelRequestSessionType).sort()).toEqual([
      "main",
      "subagent",
    ]);
  });

  it.each([
    ["interactive", "main"],
    ["subagent_child", "subagent"],
    ["selection_side_chat", "side_chat"],
  ] as const)(
    "%s title sidecars inherit their host while keeping the title purpose",
    async (taskType, expected) => {
      const seen: ModelInvocationContext[] = [];
      const runtime = createRuntime(taskType, seen);
      for (const querySource of ["session_title", "goal_summary_title"]) {
        const candidate = await generateTitleCandidate.call(runtime as never, "Improve headers", {
          querySource,
          traceContext: createRootTraceContext({ sessionId: runtime.getSessionId() }),
        });
        expect(candidate?.title).toBe("Session title");
      }
      expect(
        seen.map((context) => [context.modelRequestSessionType, context.metadata?.querySource]),
      ).toEqual([
        [expected, "session_title"],
        [expected, "goal_summary_title"],
      ]);
    },
  );
});
