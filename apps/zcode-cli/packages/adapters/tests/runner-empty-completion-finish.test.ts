import { describe, expect, it } from "vitest";
import {
  ModelErrorCode,
  type ModelNetworkStatusEvent,
  type ModelStreamEvent,
  type ModelUsage,
} from "@zcode/contracts";
import type { AiSdkModelRuntime } from "../src/model/runner.js";
import { executeAdapterGenerateText, executeAdapterStreamText } from "./test-adapter-model.js";
import { TestAiSdkModelAdapter, TestProviderConfigFixture } from "./test-provider-config.js";

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
const MAX_ATTEMPTS = 3;
const EXCLUDED_FINISHES = [
  { finishReason: "length", rawFinishReason: "model_context_window_exceeded" },
  { finishReason: "other", rawFinishReason: "model_context_window_exceeded" },
  { finishReason: "other", rawFinishReason: "context_exceeded" },
  { finishReason: "other", rawFinishReason: "context_length_exceeded" },
  { finishReason: "other", rawFinishReason: "context_window_exceeded" },
  { finishReason: "other", rawFinishReason: "model_context_exceeded" },
  { finishReason: "other", rawFinishReason: "prompt_too_long" },
  { finishReason: "context_window_exceeded", rawFinishReason: undefined },
  { finishReason: "content-filter", rawFinishReason: undefined },
  { finishReason: "other", rawFinishReason: "content_filter" },
  { finishReason: "other", rawFinishReason: "refusal" },
] as const;

function harness(
  finishReason: string,
  rawFinishReason: string | undefined,
  rawSource: "direct" | "metadata",
  generatedText = "",
  output: {
    usage?: ModelUsage;
    reasoning?: unknown[];
    toolCalls?: unknown[];
    chunks?: unknown[];
  } = {},
) {
  let attempts = 0;
  const status: ModelNetworkStatusEvent[] = [];
  const events: ModelStreamEvent[] = [];
  const providerMetadata = {
    fixture: { marker: "preserved" },
    ...(rawSource === "metadata" && rawFinishReason !== undefined ? { rawFinishReason } : {}),
  };
  const completion = {
    finishReason,
    providerMetadata,
    ...(rawSource === "direct" ? { rawFinishReason } : {}),
  };
  const runtime: AiSdkModelRuntime = {
    async generateText() {
      attempts += 1;
      return {
        ...completion,
        text: generatedText,
        reasoning: output.reasoning,
        toolCalls: output.toolCalls,
        usage: output.usage ?? ZERO_USAGE,
      } as never;
    },
    streamText() {
      attempts += 1;
      return {
        fullStream: (async function* () {
          yield { type: "start" };
          if (generatedText) yield { type: "text-delta", id: "text", text: generatedText };
          for (const chunk of output.chunks ?? []) yield chunk;
          yield { type: "finish", ...completion, totalUsage: output.usage ?? ZERO_USAGE };
        })(),
      } as never;
    },
  };
  const adapter = new TestAiSdkModelAdapter({
    registry: new TestProviderConfigFixture({
      providers: {
        test: { kind: "custom", createLanguageModel: (modelId) => ({ modelId }) as never },
      },
    }),
    runtime,
    retry: { maxAttempts: MAX_ATTEMPTS, baseDelayMs: 0, maxDelayMs: 0, jitter: false },
  });
  return {
    status,
    events,
    get attempts() {
      return attempts;
    },
    async read(mode: "stream" | "generate") {
      const request = {
        providerId: "test",
        modelId: "model-a",
        messages: [{ role: "user" as const, content: "Continue the task" }],
        statusSink: { publish: (event: ModelNetworkStatusEvent) => void status.push(event) },
      };
      if (mode === "generate") return executeAdapterGenerateText(adapter, request);
      for await (const event of executeAdapterStreamText(adapter, request)) events.push(event);
      expect(events.at(-1)?.type).toBe("finish");
      return events.at(-1);
    },
  };
}

it("normalizes context overflow when a streamed tool call never passed its completion gate", async () => {
  const run = harness("length", "model_context_window_exceeded", "direct", "", {
    chunks: [
      { type: "tool-input-start", id: "call", toolName: "Read" },
      { type: "tool-call", toolCallId: "call", toolName: "Read", input: { path: "example.txt" } },
    ],
  });
  await expect(run.read("stream")).rejects.toMatchObject({
    code: ModelErrorCode.ModelContextExceeded,
  });
  expect(run.events.some((event) => event.type === "tool_call" || event.type === "finish")).toBe(
    false,
  );
});

describe.each(["stream", "generate"] as const)("%s empty completion finish semantics", (mode) => {
  it.each([
    { finishReason: "other", rawFinishReason: "prompt_too_long", text: "Valid title" },
    { finishReason: "other", rawFinishReason: "context_exceeded", text: '{"passed":false}' },
    { finishReason: "other", rawFinishReason: " MODEL_CONTEXT_WINDOW_EXCEEDED ", text: "partial" },
  ])("returns nonempty $rawFinishReason unchanged for every caller", async (entry) => {
    const run = harness(entry.finishReason, entry.rawFinishReason, "direct", entry.text);
    const result = await run.read(mode);
    expect(result).toMatchObject({ finishReason: entry.finishReason });
    if (mode === "generate")
      expect(result).toMatchObject({
        text: entry.text,
        providerMetadata: { fixture: { marker: "preserved" } },
      });
    if (mode === "stream")
      expect(run.events.filter((event) => event.type === "text_delta")).toMatchObject([
        { text: entry.text },
      ]);
    expect(run.status.some((event) => event.type === "model_request_failed")).toBe(false);
    expect(run.status.filter((event) => event.type === "model_request_completed")).toHaveLength(1);
    expect(run.attempts).toBe(1);
  });

  it("preserves nonzero reported usage on the failed request", async () => {
    const usage = { inputTokens: 80, outputTokens: 5, totalTokens: 85 };
    const run = harness("length", "model_context_window_exceeded", "direct", "", { usage });
    await expect(run.read(mode)).rejects.toMatchObject({
      code: ModelErrorCode.ModelContextExceeded,
      usage,
    });
    expect(run.status.filter((event) => event.type === "model_request_failed")).toMatchObject([
      { usage },
    ]);
    expect(run.status.some((event) => event.type === "model_request_completed")).toBe(false);
    expect(run.events.some((event) => event.type === "finish")).toBe(false);
    expect(run.attempts).toBe(1);
  });

  describe.each([
    { finishReason: "length", rawFinishReason: "model_context_window_exceeded" },
    { finishReason: "other", rawFinishReason: "prompt_too_long" },
  ])("partial $finishReason / $rawFinishReason", (completion) => {
    it.each(["text", "whitespace", "reasoning", "opaque-reasoning", "tool-call"])(
      "preserves partial %s output",
      async (kind) => {
        const opaque = { test: { signature: "retained" } };
        const toolCall = {
          type: "tool-call",
          toolCallId: "call",
          toolName: "Read",
          input: { path: "example.txt" },
        };
        const run = harness(
          completion.finishReason,
          completion.rawFinishReason,
          "metadata",
          kind === "text" ? "partial" : kind === "whitespace" ? " " : "",
          {
            ...(kind === "reasoning" || kind === "opaque-reasoning"
              ? {
                  reasoning: [
                    {
                      type: "reasoning",
                      text: kind === "reasoning" ? "thinking" : "",
                      providerMetadata: opaque,
                    },
                  ],
                  chunks: [
                    { type: "reasoning-start", id: "reasoning" },
                    {
                      type: "reasoning-delta",
                      id: "reasoning",
                      text: kind === "reasoning" ? "thinking" : "",
                      providerMetadata: opaque,
                    },
                    { type: "reasoning-end", id: "reasoning" },
                  ],
                }
              : {}),
            ...(kind === "tool-call" ? { toolCalls: [toolCall], chunks: [toolCall] } : {}),
          },
        );
        expect(await run.read(mode)).toMatchObject({
          finishReason: completion.finishReason,
          providerMetadata: { rawFinishReason: completion.rawFinishReason },
        });
        expect(run.status.filter((event) => event.type === "model_request_completed")).toHaveLength(
          1,
        );
        expect(run.status.some((event) => event.type === "model_request_failed")).toBe(false);
        expect(run.attempts).toBe(1);
      },
    );
  });

  describe.each(["direct", "metadata"] as const)("raw reason from %s", (rawSource) => {
    it.each(
      EXCLUDED_FINISHES.filter(
        (entry) => rawSource === "direct" || entry.rawFinishReason !== undefined,
      ),
    )("does not retry excluded finish $finishReason / $rawFinishReason", async (entry) => {
      const { rawFinishReason } = entry;
      const run = harness(entry.finishReason, rawFinishReason, rawSource);
      const contextLimit = !["content-filter", "content_filter", "refusal"].includes(
        rawFinishReason ?? entry.finishReason,
      );
      if (contextLimit) {
        await expect(run.read(mode)).rejects.toMatchObject({
          code: ModelErrorCode.ModelContextExceeded,
          usage: ZERO_USAGE,
          context: {
            reason: "context_exceeded",
            rawFinishReason,
            finishReason: entry.finishReason,
          },
        });
        expect(run.events.some((event) => event.type === "finish")).toBe(false);
        expect(run.attempts).toBe(1);
        expect(run.status.filter((event) => event.type === "model_request_failed")).toMatchObject([
          { reason: "context_exceeded", retryable: false, usage: ZERO_USAGE },
        ]);
        expect(
          run.status.some(
            (event) =>
              event.type === "model_request_completed" || event.type === "model_retry_scheduled",
          ),
        ).toBe(false);
        return;
      }
      const result = await run.read(mode);

      expect(run.attempts).toBe(1);
      expect(run.status.filter((event) => event.type === "model_request_started")).toHaveLength(1);
      expect(run.status.some((event) => event.type === "model_retry_scheduled")).toBe(false);
      expect(run.status.some((event) => event.type === "model_request_failed")).toBe(false);
      expect(result).toMatchObject({
        finishReason: entry.finishReason,
        usage: ZERO_USAGE,
        providerMetadata: {
          fixture: { marker: "preserved" },
          ...(rawFinishReason !== undefined && (mode === "stream" || rawSource === "metadata")
            ? { rawFinishReason }
            : {}),
        },
      });
      if (mode === "generate" && rawSource === "direct") {
        expect(result).toHaveProperty("providerMetadata", { fixture: { marker: "preserved" } });
      }
    });

    it.each(["stop", "tool-calls", "tool_calls"])(
      "preserves the existing no-retry behavior for %s",
      async (finishReason) => {
        const run = harness(finishReason, "unrecognized_provider_marker", rawSource);
        const result = await run.read(mode);

        expect(run.attempts).toBe(1);
        expect(run.status.some((event) => event.type === "model_retry_scheduled")).toBe(false);
        expect(result).toHaveProperty("finishReason", finishReason);
      },
    );

    it.each(
      [
        { finishReason: "other", rawFinishReason: undefined },
        { finishReason: "length", rawFinishReason: undefined },
        { finishReason: "length", rawFinishReason: "max_tokens" },
        { finishReason: "other", rawFinishReason: "max_output_tokens" },
        { finishReason: "other", rawFinishReason: "end_turn" },
        { finishReason: "unknown", rawFinishReason: "unknown" },
        { finishReason: "other", rawFinishReason: "unrecognized_provider_marker" },
      ].filter((entry) => rawSource === "direct" || entry.rawFinishReason !== undefined),
    )(
      "preserves the existing retry for other finish $finishReason / $rawFinishReason",
      async (entry) => {
        const run = harness(entry.finishReason, entry.rawFinishReason, rawSource);
        const result = await run.read(mode);

        expect(run.attempts).toBe(2);
        expect(run.status.filter((event) => event.type === "model_retry_scheduled")).toHaveLength(
          1,
        );
        expect(result).toHaveProperty("providerMetadata", {
          fixture: { marker: "preserved" },
          ...(entry.rawFinishReason !== undefined && (mode === "stream" || rawSource === "metadata")
            ? { rawFinishReason: entry.rawFinishReason }
            : {}),
        });
      },
    );
  });
});
