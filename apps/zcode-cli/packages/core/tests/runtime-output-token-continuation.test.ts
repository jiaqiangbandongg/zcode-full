import { describe, expect, it } from "vitest";
import { SessionEventType, createSessionId } from "@zcode/contracts";
import type { AgentRuntime } from "../src/runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import {
  OUTPUT_TOKEN_CONTINUE_PROMPT,
  countContinuePrompts,
  createRecordingMessageStore,
  createRuntime,
  estimateCanonicalHistory,
  outputLimitResult,
  requestText,
  stopResult,
} from "./runtime-output-token-continuation-test-helpers.js";

describe("AgentRuntime output-token continuation", () => {
  it.each([
    { id: "output-token-empty-continue", rawReasons: [], taskType: undefined },
    {
      id: "output-token-subagent",
      rawReasons: [undefined, "max_tokens", "max_output_tokens"],
      taskType: "subagent_child" as const,
    },
  ])("continues three empty output limits for $id", async ({ id, rawReasons, taskType }) => {
    const requests: any[] = [];
    let callCount = 0;
    const runtime = createRuntime({
      id,
      config: taskType ? { taskType } : undefined,
      modelAdapter: {
        async generateText(request: any) {
          requests.push(request);
          callCount += 1;
          if (callCount <= 3) {
            const rawFinishReason = rawReasons[callCount - 1];
            return outputLimitResult(rawFinishReason ? { rawFinishReason } : {});
          }
          return stopResult("done", 40);
        },
      } as never,
    });
    (runtime as any).messageHistory.toRuntimeEntries = () => {
      throw new Error("turn requests must not clone canonical history entries");
    };

    const result = await runtime.executeTurn("start");

    expect(result.response).toBe("done");
    expect(requests).toHaveLength(4);
    expect(requests.map((request) => countContinuePrompts(request.messages))).toEqual([0, 1, 2, 3]);
  });

  it("counts only assistant products that enter provider-visible history", async () => {
    const runtimeId = "output-token-empty-assistant-commit";
    const sessionId = createSessionId(runtimeId);
    const eventStore = createTestSessionEventStore();
    const store = createRecordingMessageStore();
    let callCount = 0;
    const runtime = createRuntime({
      id: runtimeId,
      deps: { eventStore, sessionStore: store as never },
      modelAdapter: {
        async generateText() {
          callCount += 1;
          if (callCount === 1) {
            return {
              finishReason: "length",
              reasoning: [{ text: "" }],
              text: "",
              usage: {},
            };
          }
          return stopResult("done", 2);
        },
      } as never,
    });

    await runtime.executeTurn("start");

    const events = await eventStore.getEvents(sessionId);
    const turnComplete = events.find((event) => event.type === SessionEventType.TurnComplete);
    expect(
      (turnComplete?.payload as { historyRoundCount?: number } | undefined)?.historyRoundCount,
    ).toBe(1);
    expect(store.savedMessages.filter((message) => message.role === "assistant")).toHaveLength(1);
    expect(store.savedParts.filter((part) => part.type === "reasoning")).toEqual([]);
  });

  it("keeps partial assistants but excludes Continue from canonical and durable requests", async () => {
    const runtimeId = "output-token-partial-history";
    const sessionId = createSessionId(runtimeId);
    const eventStore = createTestSessionEventStore();
    const store = createRecordingMessageStore();
    const requests: any[] = [];
    let nextTurnEstimate = 0;
    const responses = [
      outputLimitResult({
        rawFinishReason: "max_tokens",
        text: "A",
        usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 },
      }),
      outputLimitResult({
        rawFinishReason: "max_output_tokens",
        text: "B",
        usage: { inputTokens: 12, outputTokens: 1, totalTokens: 13 },
      }),
      outputLimitResult({
        rawFinishReason: "model_context_window_exceeded",
        text: "C",
        usage: { inputTokens: 14, outputTokens: 1, totalTokens: 15 },
      }),
      stopResult("D", 16),
      stopResult("next done", 18, 2),
    ];
    let runtime!: AgentRuntime;
    runtime = createRuntime({
      id: runtimeId,
      deps: {
        eventStore,
        sessionStore: store as never,
      },
      modelAdapter: {
        async generateText(request: any) {
          requests.push(request);
          if (requests.length === 5) {
            nextTurnEstimate = estimateCanonicalHistory(runtime);
          }
          return responses.shift()!;
        },
      } as never,
    });

    const first = await runtime.executeTurn("first");
    const firstTurnEvents = await eventStore.getEvents(sessionId);
    const canonicalAfterFirst = (runtime as any).messageHistory.toRuntimeEntries();

    expect(first.response).toBe("D");
    expect(
      firstTurnEvents
        .filter((event) => event.type === SessionEventType.ModelComplete)
        .map((event: any) => event.payload.content),
    ).toEqual(["A", "B", "C", "D"]);
    expect(
      firstTurnEvents
        .filter((event) => event.type === SessionEventType.ModelComplete)
        .map((event: any) => event.payload.stopReason),
    ).toEqual(["length", "length", "length", "stop"]);
    expect(
      store.savedMessages
        .filter((message) => message.role === "assistant")
        .map((message) => message.finish),
    ).toEqual(["length", "length", "length", "stop"]);
    expect(
      store.savedParts.filter((part) => part.type === "step-finish").map((part) => part.reason),
    ).toEqual(["length", "length", "length", "stop"]);
    expect(
      JSON.stringify(
        firstTurnEvents.filter((event) => event.type === SessionEventType.ModelRequest),
      ),
    ).not.toContain(OUTPUT_TOKEN_CONTINUE_PROMPT);
    expect(JSON.stringify(canonicalAfterFirst)).not.toContain(OUTPUT_TOKEN_CONTINUE_PROMPT);
    expect(JSON.stringify([store.savedMessages, store.savedParts])).not.toContain(
      OUTPUT_TOKEN_CONTINUE_PROMPT,
    );

    const second = await runtime.executeTurn("next real user");

    expect(second.response).toBe("next done");
    expect(requestText(requests[4]!.messages)).not.toContain(OUTPUT_TOKEN_CONTINUE_PROMPT);
    expect(requestText(requests[4]!.messages)).toContain("next real user");
    expect(
      canonicalAfterFirst
        .filter((entry: any) => entry.message?.role === "assistant")
        .map((entry: any) => entry.tokens?.input),
    ).toEqual([10, 12, 14, 16]);
    expect(nextTurnEstimate).toBeGreaterThan(17);
  });

  it("preserves the last valid provider usage anchor across empty recovery usage", async () => {
    const runtimeId = "output-token-empty-usage-anchor";
    const requests: any[] = [];
    let assistantEntriesBeforeThirdRequest: any[] = [];
    let nextTurnEstimate = 0;
    let runtime!: AgentRuntime;
    runtime = createRuntime({
      id: runtimeId,
      modelAdapter: {
        async generateText(request: any) {
          requests.push(request);
          if (requests.length === 1) {
            return outputLimitResult({
              text: "A",
              usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 },
            });
          }
          if (requests.length === 2) {
            return outputLimitResult({});
          }
          if (requests.length === 3) {
            assistantEntriesBeforeThirdRequest = (runtime as any).messageHistory
              .toRuntimeEntries()
              .filter((entry: any) => entry.message?.role === "assistant");
            return { finishReason: "stop", text: "C", usage: {} };
          }
          nextTurnEstimate = estimateCanonicalHistory(runtime);
          return stopResult("next done", 20);
        },
      } as never,
    });

    const first = await runtime.executeTurn("first");
    expect(first.response).toBe("C");
    expect(assistantEntriesBeforeThirdRequest).toHaveLength(1);
    expect(assistantEntriesBeforeThirdRequest[0]?.tokens).toMatchObject({ input: 10, output: 1 });

    const second = await runtime.executeTurn("next real user");

    expect(second.response).toBe("next done");
    expect(nextTurnEstimate).toBeGreaterThan(11);
  });

  it("closes the fourth output limit through the existing TurnError path", async () => {
    const runtimeId = "output-token-exhausted";
    const sessionId = createSessionId(runtimeId);
    const eventStore = createTestSessionEventStore();
    const store = createRecordingMessageStore();
    let callCount = 0;
    const runtime = createRuntime({
      id: runtimeId,
      deps: {
        eventStore,
        sessionStore: store as never,
      },
      modelAdapter: {
        async generateText() {
          callCount += 1;
          if (callCount > 4) {
            return stopResult("next turn still works", 50, 2);
          }
          return outputLimitResult({
            text: String.fromCharCode(64 + callCount),
            usage: {
              inputTokens: callCount * 10,
              outputTokens: 1,
              totalTokens: callCount * 10 + 1,
            },
          });
        },
      } as never,
    });

    await expect(runtime.executeTurn("start")).rejects.toMatchObject({
      message: "The model's response exceeded the output token maximum.",
      type: "model_error",
    });
    const events = await eventStore.getEvents(sessionId);
    const finalPartialPart = store.savedParts.find(
      (part) => part.type === "text" && part.text === "D",
    );
    const finalPartialAssistant = store.savedMessages.find(
      (message) => message.id === finalPartialPart?.messageID,
    );
    const errorCarrier = store.savedMessages.find(
      (message) => message.role === "assistant" && message.error,
    );

    expect(callCount).toBe(4);
    const turnError = events.find((event) => event.type === SessionEventType.TurnError);
    expect(turnError?.payload).toMatchObject({
      error: {
        code: "model_output_limit_exceeded",
        message: "The model's response exceeded the output token maximum.",
      },
    });
    expect(events.some((event) => event.type === SessionEventType.TurnComplete)).toBe(false);
    expect(finalPartialAssistant).toMatchObject({
      tokens: { input: 40, output: 1, total: 41 },
    });
    expect(finalPartialAssistant?.error).toBeUndefined();
    expect(errorCarrier?.id).not.toBe(finalPartialAssistant?.id);
    expect(errorCarrier?.error?.data?.message).toBe(
      "The model's response exceeded the output token maximum.",
    );
    expect(errorCarrier?.tokens).toMatchObject({
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    });
    expect(store.savedParts.filter((part) => part.messageID === errorCarrier?.id)).toEqual([
      expect.objectContaining({
        type: "step-finish",
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    ]);

    const next = await runtime.executeTurn("continue after the displayed error");
    expect(next.response).toBe("next turn still works");
    expect(callCount).toBe(5);
  });

  it("persists and hydrates an empty exhausted assistant error", async () => {
    const runtimeId = "output-token-empty-exhausted";
    const sessionId = createSessionId(runtimeId);
    const eventStore = createTestSessionEventStore();
    const store = createRecordingMessageStore();
    let callCount = 0;
    const runtime = createRuntime({
      id: runtimeId,
      deps: {
        eventStore,
        sessionStore: store as never,
      },
      modelAdapter: {
        async generateText() {
          callCount += 1;
          return outputLimitResult({
            usage: {
              inputTokens: callCount * 10,
              outputTokens: 1,
              totalTokens: callCount * 10 + 1,
            },
          });
        },
      } as never,
    });

    await expect(runtime.executeTurn("start")).rejects.toMatchObject({
      message: "The model's response exceeded the output token maximum.",
      type: "model_error",
    });

    expect(callCount).toBe(4);
    const durableAssistants = store.savedMessages.filter((message) => message.role === "assistant");
    const durableStepFinishes = store.savedParts.filter((part) => part.type === "step-finish");
    expect(durableAssistants).toHaveLength(1);
    expect(durableAssistants[0]).toMatchObject({
      error: {
        name: "model_output_limit_exceeded",
        data: {
          code: "model_output_limit_exceeded",
          message: "The model's response exceeded the output token maximum.",
          retryable: true,
          attribution: {
            providerErrorCode: "model_output_limit_exceeded",
            reason: "model_output_limit_exceeded",
            source: "provider",
          },
        },
      },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    expect(durableStepFinishes).toHaveLength(1);
    expect(durableStepFinishes[0]).toMatchObject({
      reason: "length",
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    expect(
      (runtime as any).messageHistory
        .toRuntimeEntries()
        .filter((entry: any) => entry.message?.role === "assistant"),
    ).toEqual([]);
    const exhaustedEvents = await eventStore.getEvents(sessionId);
    expect(
      exhaustedEvents.filter((event) => event.type === SessionEventType.ModelComplete),
    ).toHaveLength(4);
    expect(
      exhaustedEvents.filter((event) => event.type === SessionEventType.ModelComplete).at(-1)
        ?.payload,
    ).toMatchObject({
      usage: { inputTokens: 40, outputTokens: 1, totalTokens: 41 },
    });
    expect(
      exhaustedEvents.find((event) => event.type === SessionEventType.TurnError)?.payload,
    ).toMatchObject({
      error: {
        code: "model_output_limit_exceeded",
        message: "The model's response exceeded the output token maximum.",
      },
    });

    let coldRequest: any;
    const resumedRuntime = createRuntime({
      id: runtimeId,
      deps: {
        eventStore,
        sessionStore: store as never,
      },
      modelAdapter: {
        async generateText(request: any) {
          coldRequest = request;
          return stopResult("cold resume done", 50, 2);
        },
      } as never,
    });
    await resumedRuntime.resumeFromStore();
    await resumedRuntime.executeTurn("continue after cold resume");

    expect(coldRequest.messages.filter((message: any) => message.role === "assistant")).toEqual([]);
    expect(requestText(coldRequest.messages)).not.toContain(OUTPUT_TOKEN_CONTINUE_PROMPT);
    expect(requestText(coldRequest.messages)).toContain("continue after cold resume");
  });
});
