import { describe, expect, it } from "vitest";
import { createSessionId } from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { createTestModelSelection } from "./test-model-selection.js";
import { InMemoryRuntimeTaskRegistry } from "../src/runtime-task/registry.js";
import type { OffPeakLifecycleEvent } from "../src/runtime/off-peak/lifecycle.js";
import { getOffPeakExecution } from "../src/runtime/off-peak/runtime.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { createRecordingSubagentSessionStore } from "./subagent-test-store.js";

describe("闲时 Runtime 生命周期接入", () => {
  it.each([false, true])(
    "后台子轮保留启动模型，SendMessage 恢复与通知遵循当前归属（接管=%s）",
    async (takeover) => {
      const events: OffPeakLifecycleEvent[] = [];
      const registry = new InMemoryRuntimeTaskRegistry();
      const store = createRecordingSubagentSessionStore();
      const children: string[] = [];
      const main: string[] = [];
      let finishChild!: () => void;
      const childGate = new Promise<void>((resolve) => {
        finishChild = resolve;
      });
      const runtime = createTestAgentRuntime(
        createSessionId(`offpeak-child-${takeover}`),
        {
          modelSelection: createTestModelSelection("user/normal"),
          titleGeneration: { enabled: false },
          workingDirectory: "/workspace",
        },
        {
          runtimeTaskRegistry: registry,
          sessionStore: store,
          eventStore: createTestSessionEventStore(),
          onOffPeakLifecycleEvent: (event) => events.push(event),
          modelFactory: createTestModelFactory({
            async generateText(_request, observation) {
              const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
              if (observation.invocationContext?.metadata?.querySource === "subagent") {
                children.push(String(observation.model.providerId));
                if (children.length === 1) await childGate;
                return { text: "child done", finishReason: "stop", usage };
              }
              main.push(String(observation.model.providerId));
              if (main.length === 1)
                return {
                  text: "",
                  finishReason: "tool-calls",
                  usage,
                  toolCalls: [
                    {
                      id: "spawn",
                      name: "Agent",
                      input: {
                        description: "background helper",
                        prompt: "help",
                        subagent_type: "Explore",
                        run_in_background: true,
                      },
                    },
                  ],
                };
              if (main.length === 3)
                return {
                  text: "",
                  finishReason: "tool-calls",
                  usage,
                  toolCalls: [
                    {
                      id: "resume",
                      name: "SendMessage",
                      input: {
                        to: Object.keys(registry.all())[0],
                        summary: "continue",
                        message: "one more task",
                      },
                    },
                  ],
                };
              return { text: "main done", finishReason: "stop", usage };
            },
          }),
        },
      );
      try {
        await runtime.executeTurn("idle", undefined, {
          offPeakTaskId: "idle-task",
          intent: {
            sourceCommandId: "idle-input",
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
        expect(children).toEqual(["idle"]);
        expect(events.some((e) => e.type === "completed")).toBe(false);
        if (takeover)
          await runtime.enqueueDeferredInput({
            input: "take over",
            intent: {
              sourceCommandId: "user",
              kind: "sendText",
              admissionSeq: 2,
              modelSelection: createTestModelSelection("paid/new"),
            } as never,
          });
        finishChild();
        await expect.poll(() => children.length).toBe(2);
        if (takeover) await runtime.clearAllPendingInputs(runtime.rootTraceContext);
        await expect.poll(() => events.filter((e) => e.type === "completed").length).toBe(1);
        expect(children).toEqual(["idle", takeover ? "paid" : "idle"]);
        expect(main.slice(2).every((provider) => provider === (takeover ? "paid" : "idle"))).toBe(
          true,
        );
        const childId = Object.values(registry.all())[0]!.childSessionId!;
        const entries = await store.sessionEntries!({
          sessionID: childId,
          type: "runtime/model_selection",
        });
        expect(
          entries.some((entry) => (entry.data as { providerId?: string }).providerId === "idle"),
        ).toBe(false);
      } finally {
        finishChild();
      }
    },
  );

  it("闲时整项完成后新用户选择正常持久化，后续普通后台唤起不再读取旧闲时上下文", async () => {
    const store = createRecordingSubagentSessionStore();
    const requests: string[] = [];
    const runtime = createTestAgentRuntime(
      createSessionId("after-idle-complete"),
      {
        modelSelection: createTestModelSelection("user/old"),
        titleGeneration: { enabled: false },
        workingDirectory: "/workspace",
      },
      {
        sessionStore: store,
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          async generateText(_request, observation) {
            requests.push(String(observation.model.providerId));
            return {
              text: "done",
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        }),
      },
    );
    await runtime.executeTurn("idle", undefined, {
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
          requestAuth: { source: { resolve: async () => ({ apiKey: "test" }) } },
        },
      },
    });
    await expect
      .poll(
        () => getOffPeakExecution(runtime as unknown as AgentRuntimeInternal)?.lifecycle.terminal,
      )
      .toBe(true);
    await runtime.executeTurn("user", undefined, {
      intent: {
        sourceCommandId: "new-user",
        kind: "sendText",
        admissionSeq: 2,
        modelSelection: createTestModelSelection("paid/new"),
      } as never,
    });
    const entries = await store.sessionEntries!({
      sessionID: runtime.sessionId,
      type: "runtime/model_selection",
    });
    expect(entries.at(-1)?.data).toMatchObject({ providerId: "paid", modelId: "new" });
    runtime.enqueueBackgroundTaskNotification({
      taskId: "normal",
      text: "ordinary background done",
      traceContext: runtime.rootTraceContext,
    });
    await expect.poll(() => requests.length).toBe(3);
    expect(requests).toEqual(["idle", "paid", "paid"]);
  });

  it("等待新票时接受用户输入，当前主轮改用用户模型且迟到票据不再接管", async () => {
    const events: OffPeakLifecycleEvent[] = [];
    const requests: string[] = [];
    const runtime = createTestAgentRuntime(
      createSessionId("offpeak-takeover-wait"),
      {
        modelSelection: createTestModelSelection("user/normal"),
        titleGeneration: { enabled: false },
        workingDirectory: "/workspace",
      },
      {
        eventStore: createTestSessionEventStore(),
        onOffPeakLifecycleEvent: (event) => events.push(event),
        modelFactory: createTestModelFactory({
          async generateText(_request, observation) {
            requests.push(String(observation.model.providerId));
            if (observation.model.providerId === "idle")
              throw Object.assign(new Error("expired"), {
                code: "invalid_model_request",
                context: { providerCode: "3102", providerId: "idle" },
              });
            return {
              text: "user continued",
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        }),
      },
    );
    const pending = runtime.executeTurn("idle", undefined, {
      offPeakTaskId: "idle-task",
      intent: {
        sourceCommandId: "idle-input",
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
    await expect.poll(() => events.some((e) => e.type === "ticket_needed")).toBe(true);
    await runtime.enqueueDeferredInput({
      input: "take over",
      intent: {
        sourceCommandId: "user-input",
        kind: "sendText",
        admissionSeq: 2,
        modelSelection: createTestModelSelection("paid/new"),
      } as never,
    });
    expect((await pending).response).toBe("user continued");
    expect(requests).toEqual(["idle", "paid"]);
    const execution = getOffPeakExecution(runtime as unknown as AgentRuntimeInternal)!;
    expect(execution.replaceTicket("execution", 1, "late", { headers: { ticket: "late" } })).toBe(
      false,
    );
    expect(events.some((e) => e.type === "completed")).toBe(false);
    await runtime.clearAllPendingInputs(runtime.rootTraceContext);
    await expect.poll(() => events.filter((e) => e.type === "completed").length).toBe(1);
    expect(runtime.getSessionModelSelection()?.providerId).toBe("paid");
  });

  it.each([false, true])(
    "主轮结束后等待后台，任务取消后迟到通知不能唤起（取消=%s）",
    async (cancel) => {
      const events: OffPeakLifecycleEvent[] = [];
      const registry = new InMemoryRuntimeTaskRegistry();
      const requests: string[] = [];
      const runtime = createTestAgentRuntime(
        createSessionId("offpeak-runtime"),
        {
          modelSelection: createTestModelSelection("user/normal"),
          titleGeneration: { enabled: false },
          workingDirectory: "/workspace",
        },
        {
          runtimeTaskRegistry: registry,
          eventStore: createTestSessionEventStore(),
          onOffPeakLifecycleEvent: (event) => events.push(event),
          modelFactory: createTestModelFactory({
            async generateText(_request, observation) {
              requests.push(String(observation.model.providerId));
              if (requests.length === 1)
                registry.register({
                  taskId: "bash",
                  type: "local_bash",
                  status: "running",
                  isBackgrounded: true,
                  startedAt: new Date(),
                } as never);
              return {
                text: "done",
                finishReason: "stop",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            },
          }),
        },
      );
      await runtime.executeTurn("idle", undefined, {
        offPeakTaskId: "idle-task",
        intent: {
          sourceCommandId: "idle-input",
          kind: "sendText",
          modelSelection: createTestModelSelection("idle/model"),
        } as never,
        modelExecution: {
          selectionScope: "execution",
          memoryExtraction: "skip",
          offPeak: { executionId: "execution", ticketId: "one", providerErrorCode: "3102" },
          requestDependencies: {
            requestAuth: { source: { resolve: async () => ({ headers: { ticket: "one" } }) } },
          },
        },
      });
      expect(runtime.getSessionModelSelection()?.providerId).toBe("idle");
      expect(events.some((e) => e.type === "completed")).toBe(false);
      if (cancel) await getOffPeakExecution(runtime as unknown as AgentRuntimeInternal)!.cancel();
      registry.update("bash", (task) => ({ ...task, status: "completed" }));
      await Promise.resolve();
      expect(events.some((e) => e.type === "completed")).toBe(cancel);
      runtime.enqueueBackgroundTaskNotification({
        taskId: "bash",
        text: "Bash finished",
        traceContext: runtime.rootTraceContext,
      });
      registry.update("bash", (task) => ({ ...task, notified: true }));
      await expect.poll(() => events.filter((e) => e.type === "completed").length).toBe(1);
      await expect.poll(() => runtime.hasActiveOrQueuedTurnWork()).toBe(false);
      expect(requests).toEqual(cancel ? ["idle"] : ["idle", "idle"]);
      expect(runtime.getSessionModelSelection()?.providerId).toBe("user");
    },
  );
});
