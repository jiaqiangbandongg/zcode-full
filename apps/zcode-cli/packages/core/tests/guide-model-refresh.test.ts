import { describe, expect, it, vi } from "vitest";
import {
  createSessionId,
  SessionEventType,
  type ModelRequest,
  type ModelSelection,
} from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { createTestSessionEventStore } from "./test-event-store.js";

const selection: ModelSelection = {
  providerId: "fixture",
  modelId: "original",
  options: { reasoningLevel: "high" },
};

describe("Guide refresh versus model switching", () => {
  it.each([false, true])(
    "固定执行模型的 Guide 仍应用 Plan=%s 和权限，但不切模型",
    async (planEnabled) => {
      const observed: { mode: string; plan: boolean }[] = [];
      const onCreate = vi.fn();
      const runtime = createTestAgentRuntime(
        createSessionId("fixed-guide-plan"),
        {
          mode: "build",
          planEnabled: !planEnabled,
          modelSelection: selection,
          workingDirectory: "/fixture",
        },
        {
          eventStore: createTestSessionEventStore(),
          modelFactory: createTestModelFactory({
            onCreate,
            async generateText() {
              observed.push({ mode: runtime.getMode(), plan: runtime.getPlanEnabled() });
              if (observed.length === 1)
                await runtime.steerTurn({
                  expectedTurnId: runtime.getActiveTurnInfo()?.turnId,
                  input: "guide",
                  delivery: "guide",
                  intent: {
                    sourceCommandId: "guide",
                    kind: "sendText",
                    requestedDelivery: "guide",
                    admittedDelivery: "guide",
                    mode: "yolo",
                    planEnabled,
                    modelSelection: { ...selection, modelId: "must-not-switch" },
                  },
                });
              return { text: "done", finishReason: "stop", usage: {} };
            },
          }),
        },
      );
      try {
        await runtime.executeTurn("start", undefined, {
          modelExecution: { selectionScope: "execution" },
        });
        expect(observed).toEqual([
          { mode: "build", plan: !planEnabled },
          { mode: "yolo", plan: planEnabled },
        ]);
        expect(onCreate).toHaveBeenCalledTimes(1);
        expect(runtime.getSessionModelSelection()).toEqual(selection);
      } finally {
        runtime.beginShutdown();
      }
    },
  );

  it.each([
    { name: "same selection", guides: [selection], changes: 0 },
    { name: "same selection and new config", guides: [selection], changes: 0, newConfig: true },
    { name: "same selection and mode", guides: [selection], changes: 0, mode: "plan" as const },
    { name: "provider switch", guides: [{ ...selection, providerId: "other" }], changes: 1 },
    { name: "model switch", guides: [{ ...selection, modelId: "other" }], changes: 1 },
    {
      name: "reasoning switch",
      guides: [{ ...selection, options: { reasoningLevel: "low" } }],
      changes: 1,
    },
    {
      name: "A to B then B again",
      guides: [
        { ...selection, modelId: "other" },
        { ...selection, modelId: "other" },
      ],
      changes: 1,
    },
    { name: "Session differs from Loop", guides: [selection], changes: 0, sessionChanged: true },
    {
      name: "Session already equals new choice but Loop differs",
      guides: [{ ...selection, modelId: "external-session-change" }],
      changes: 1,
      sessionChanged: true,
    },
  ])("$name", async ({ guides, changes, newConfig, mode, sessionChanged }) => {
    const eventStore = createTestSessionEventStore();
    const requests: ModelRequest[] = [];
    let outputLimit = 8_000;
    const onCreate = vi.fn();
    const runtime = createTestAgentRuntime(
      createSessionId("guide-refresh"),
      {
        mode: "build",
        modelSelection: selection,
        workingDirectory: "/fixture",
        outputStyle: { name: "Learning", prompt: "LEARNING_STYLE_FIXTURE" },
      },
      {
        eventStore,
        modelFactory: createTestModelFactory({
          onCreate,
          maxOutputTokens: () => outputLimit,
          async generateText(request) {
            requests.push(request);
            const guide = guides[requests.length - 1];
            if (guide) {
              runtime.updateConfig({
                outputStyle: { name: "Explanatory", prompt: "EXPLANATORY_STYLE_FIXTURE" },
              });
              if (newConfig) outputLimit = 16_000;
              if (sessionChanged)
                runtime.setSessionModelSelection({
                  ...selection,
                  modelId: "external-session-change",
                });
              const result = await runtime.steerTurn({
                expectedTurnId: runtime.getActiveTurnInfo()?.turnId,
                input: `GUIDE_REFRESH_${requests.length}`,
                delivery: "guide",
                intent: {
                  sourceCommandId: `guide-${requests.length}`,
                  kind: "sendText",
                  requestedDelivery: "guide",
                  admittedDelivery: "guide",
                  modelSelection: guide,
                  ...(mode ? { mode } : {}),
                },
              });
              expect(result.kind).toBe("queued");
            }
            return { text: "step complete", finishReason: "stop", usage: {} };
          },
        }),
      },
    );
    const rebuild = vi.spyOn(
      runtime as never as { createContextBuilderFromSnapshot: () => unknown },
      "createContextBuilderFromSnapshot",
    );
    try {
      await runtime.executeTurn("start guide fixture");
      expect(requests).toHaveLength(guides.length + 1);
      expect(onCreate.mock.calls.length).toBeGreaterThanOrEqual(guides.length + 1);
      // 初始构造之外，仅真实执行选择变化才重建；单独观察新对象无法证明这个边界。
      expect(rebuild.mock.calls.length).toBe(changes + 1);
      const firstSystem = requests[0]!.messages.filter((m) => m.role === "system");
      if (changes === 0) {
        expect(requests[1]!.messages.filter((m) => m.role === "system")).toEqual(firstSystem);
        expect(JSON.stringify(requests[1]!.messages)).not.toContain("EXPLANATORY_STYLE_FIXTURE");
      }
      for (let index = 1; index < requests.length; index++) {
        expect(JSON.stringify(requests[index]!.messages)).toContain(`GUIDE_REFRESH_${index}`);
        expect(requests[index]!.options?.maxOutputTokens).toBe(newConfig ? 16_000 : 8_000);
      }
      if (mode) {
        expect(runtime.getMode()).toBe(mode === "plan" ? "build" : mode);
        expect(runtime.getPlanEnabled()).toBe(mode === "plan");
      }
      const events = await eventStore.getEvents(runtime.sessionId);
      expect(events.filter((e) => e.type === SessionEventType.TurnSteerDrained)).toHaveLength(
        guides.length,
      );
    } finally {
      runtime.beginShutdown();
    }
  });
});
