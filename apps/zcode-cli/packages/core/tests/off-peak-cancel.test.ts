import { expect, it, vi } from "vitest";
import { createSessionId } from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { createTestModelSelection } from "./test-model-selection.js";
import { controlOffPeakRuntime, getOffPeakExecution } from "../src/runtime/off-peak/runtime.js";
import { InMemoryRuntimeTaskRegistry } from "../src/runtime-task/registry.js";

it.each(["completed", "cancelled"])(
  "旧执行已 %s 时迟到 cancel 不应停止新用户轮",
  async (terminal) => {
    const registry = new InMemoryRuntimeTaskRegistry();
    let finish!: () => void;
    const gate = new Promise<void>((r) => {
      finish = r;
    });
    let calls = 0;
    const runtime = createTestAgentRuntime(
      createSessionId("review-cancel"),
      {
        modelSelection: createTestModelSelection("user/normal"),
        titleGeneration: { enabled: false },
        workingDirectory: "/workspace",
      },
      {
        runtimeTaskRegistry: registry,
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          async generateText() {
            if (calls === 0 && terminal === "cancelled")
              registry.register({
                taskId: "background",
                type: "local_bash",
                status: "running",
                isBackgrounded: true,
                startedAt: new Date(),
              } as never);
            if (++calls === 2) await gate;
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
        offPeak: { executionId: "old", ticketId: "one", providerErrorCode: "3102" },
        requestDependencies: {
          requestAuth: { source: { resolve: async () => ({ apiKey: "test" }) } },
        },
      },
    });
    if (terminal === "cancelled") await getOffPeakExecution(runtime as never)!.cancel();
    await expect.poll(() => getOffPeakExecution(runtime as never)?.lifecycle.terminal).toBe(true);
    const pending = runtime.executeTurn("new user", undefined, {
      intent: {
        sourceCommandId: "new",
        admissionSeq: 2,
        kind: "sendText",
        modelSelection: createTestModelSelection("paid/new"),
      } as never,
    });
    await expect.poll(() => calls).toBe(2);
    const stop = vi.spyOn(runtime, "stopActiveForegroundExecution");
    try {
      await controlOffPeakRuntime(runtime as never, {
        sessionId: runtime.sessionId,
        executionId: "old",
        action: "cancel",
      });
      expect(stop).not.toHaveBeenCalled();
      finish();
      await expect(pending).resolves.toMatchObject({ response: "done" });
    } finally {
      finish();
      await pending.catch(() => undefined);
    }
  },
);
