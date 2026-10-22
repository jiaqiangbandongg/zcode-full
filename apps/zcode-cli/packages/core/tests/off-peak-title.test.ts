import { describe, expect, it } from "vitest";
import { createSessionId } from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { createTestModelSelection } from "./test-model-selection.js";
import { createRecordingSubagentSessionStore } from "./subagent-test-store.js";
import type { OffPeakLifecycleEvent } from "../src/runtime/off-peak/lifecycle.js";
import { getOffPeakExecution, prepareOffPeakTurn } from "../src/runtime/off-peak/runtime.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { maybeStartSessionTitleGeneration } from "../src/runtime/methods/session-title.js";
import { retainTitleModelContext } from "../src/runtime/methods/title-generation-sidecar.js";

describe("闲时默认标题请求", () => {
  it("标题读库尚未结束时主轮不能收口，早退也释放租约；独立调用与接管不借用闲时票", async () => {
    const events: OffPeakLifecycleEvent[] = [];
    const gate = Promise.withResolvers<null>();
    const store = createRecordingSubagentSessionStore();
    store.getSession = () => gate.promise;
    const runtime = createTestAgentRuntime(
      createSessionId("idle-title-read"),
      {
        modelSelection: createTestModelSelection("user/normal"),
        titleGeneration: {},
        workingDirectory: "/workspace",
      },
      {
        sessionStore: store,
        eventStore: createTestSessionEventStore(),
        onOffPeakLifecycleEvent: (event) => events.push(event),
      },
    );
    const internal = runtime as unknown as AgentRuntimeInternal;
    const turn = prepareOffPeakTurn(internal, {
      offPeakTaskId: "task",
      intent: { modelSelection: createTestModelSelection("idle/model") } as never,
      modelExecution: {
        selectionScope: "execution",
        offPeak: { executionId: "execution", ticketId: "one", providerErrorCode: "3102" },
      },
    });
    try {
      expect(
        maybeStartSessionTitleGeneration.call(
          internal,
          "请生成一个完整的测试会话标题",
          "message" as never,
          runtime.rootTraceContext,
          { offPeakExecutionId: "execution" },
        ),
      ).toBe(true);
      const independent = retainTitleModelContext(internal);
      expect(independent.selection?.providerId).toBe("user");
      expect(independent.requestDependencies).toBeUndefined();
      turn.release("succeeded");
      await expect
        .poll(() => getOffPeakExecution(internal)!.lifecycle.state)
        .toBe("waiting_background");
      expect(events.some((event) => event.type === "completed")).toBe(false);
      getOffPeakExecution(internal)!.lifecycle.takeOver();
      runtime.setSessionModelSelection(createTestModelSelection("paid/new"));
      const afterTakeover = retainTitleModelContext(internal, "execution");
      expect(afterTakeover.selection?.providerId).toBe("paid");
      expect(afterTakeover.requestDependencies).toBeUndefined();
      gate.resolve(null);
      await expect.poll(() => events.filter((event) => event.type === "completed").length).toBe(1);
      expect(events.filter((event) => event.type === "ticket_released")).toHaveLength(1);
    } finally {
      gate.resolve(null);
    }
  });

  it.each(["success", "expired", "failure", "explicit"])(
    "主轮结束后标题独立收口：%s",
    async (mode) => {
      const events: OffPeakLifecycleEvent[] = [];
      const store = createRecordingSubagentSessionStore();
      const titleRequests: Array<{ provider: string; ticket?: string }> = [];
      const gate = Promise.withResolvers<void>();
      const runtime = createTestAgentRuntime(
        createSessionId(`idle-title-${mode}`),
        {
          modelSelection: createTestModelSelection("user/normal"),
          titleGeneration:
            mode === "explicit" ? { modelSelection: createTestModelSelection("title/custom") } : {},
          workingDirectory: "/workspace",
        },
        {
          sessionStore: store,
          eventStore: createTestSessionEventStore(),
          onOffPeakLifecycleEvent: (event) => events.push(event),
          modelFactory: createTestModelFactory({
            async generateText(request, observation) {
              if (observation.invocationContext?.metadata?.querySource === "session_title") {
                const auth =
                  await observation.factoryInput.requestDependencies?.requestAuth?.source?.resolve({
                    attempt: 1,
                    providerId: "idle",
                    modelId: "model",
                    abortSignal: request.abortSignal,
                  });
                titleRequests.push({
                  provider: String(observation.model.providerId),
                  ticket: auth?.headers?.ticket,
                });
                await gate.promise;
                if (mode === "failure") throw new Error("title failed");
                if (mode === "expired" && titleRequests.length === 1)
                  throw Object.assign(new Error("expired"), {
                    code: "invalid_model_request",
                    context: { providerCode: "3102", providerId: "idle" },
                  });
              }
              return {
                text: '{"title":"测试闲时标题"}',
                finishReason: "stop",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            },
          }),
        },
      );
      try {
        await runtime.executeTurn("请帮我完成这项需要后台执行的开发任务", undefined, {
          offPeakTaskId: "task",
          intent: {
            sourceCommandId: "idle",
            kind: "sendText",
            modelSelection: createTestModelSelection("idle/model"),
          } as never,
          modelExecution: {
            selectionScope: "execution",
            offPeak: { executionId: "execution", ticketId: "one", providerErrorCode: "3102" },
            requestDependencies: {
              requestAuth: { source: { resolve: async () => ({ headers: { ticket: "one" } }) } },
            },
          },
        });
        await expect.poll(() => titleRequests.length).toBe(1);
        expect(titleRequests[0]).toEqual(
          mode === "explicit"
            ? { provider: "title", ticket: undefined }
            : { provider: "idle", ticket: "one" },
        );
        if (mode !== "explicit") {
          expect(
            events.some((event) => event.type === "completed" || event.type === "ticket_released"),
          ).toBe(false);
        }
        gate.resolve();
        if (mode === "expired") {
          await expect
            .poll(() => events.some((event) => event.type === "ticket_needed"))
            .toBe(true);
          expect(
            getOffPeakExecution(runtime as unknown as AgentRuntimeInternal)!.replaceTicket(
              "execution",
              1,
              "two",
              { headers: { ticket: "two" } },
            ),
          ).toBe(true);
          await expect.poll(() => titleRequests.length).toBe(2);
          expect(titleRequests[1]?.ticket).toBe("two");
        }
        await expect
          .poll(() => events.filter((event) => event.type === "completed").length)
          .toBe(1);
        if (mode !== "failure")
          await expect
            .poll(async () => (await store.getSession(runtime.sessionId))?.title)
            .toBe("测试闲时标题");
      } finally {
        gate.resolve();
      }
    },
  );
});
