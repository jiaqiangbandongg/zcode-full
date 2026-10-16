import { describe, expect, it } from "vitest";
import {
  runWithModelInvocationContext,
  type ModelNetworkStatusEvent,
  type ModelStreamEvent,
} from "@zcode/contracts";
import {
  createRegistryModelConfig,
  createRegistryProviderConfig,
  parseModelConfig,
  parseProviderConfig,
} from "@zcode/provider";
import { ProviderBusinessError } from "../src/model/model-execution.js";
import { AiSdkModelAdapter, type AiSdkModelRuntime } from "../src/model/runner.js";
import { createTestModelProperties } from "./test-model-format.js";

const SIGNATURE = "opaque-signature\nbytes ";
const STREAM_IDLE_TIMEOUT_MS = 5;
const MAX_ATTEMPTS = 2;
const MAX_OUTPUT_TOKENS = 32_000;
type Chunk = Record<string, unknown>;
type Failure = "sse-error" | "network-reset" | "idle-timeout" | "empty-eof" | "auth" | "cancel";
type Prelude = "signature" | "empty-text";

function prelude(kind: Prelude): Chunk[] {
  return kind === "signature"
    ? [
        { type: "start" },
        { type: "reasoning-start", id: "reasoning-failed" },
        {
          type: "reasoning-delta",
          id: "reasoning-failed",
          text: "",
          providerMetadata: { anthropic: { signature: SIGNATURE } },
        },
        { type: "reasoning-end", id: "reasoning-failed" },
      ]
    : [
        { type: "start" },
        { type: "text-start", id: "text-failed" },
        { type: "text-delta", id: "text-failed", text: "" },
        { type: "text-end", id: "text-failed" },
      ];
}

const TOOL_INPUT: Chunk[] = [
  { type: "tool-input-start", id: "call-failed", toolName: "Write" },
  { type: "tool-input-delta", id: "call-failed", delta: '{"file_path":"test.txt"' },
];
const COMPLETE_TOOL: Chunk[] = [
  { type: "tool-input-start", id: "call-complete", toolName: "Write" },
  { type: "tool-input-end", id: "call-complete" },
  {
    type: "tool-call",
    toolCallId: "call-complete",
    toolName: "Write",
    input: { file_path: "test.txt", content: "hello" },
  },
];

function finish(finishReason = "stop"): Chunk {
  return {
    type: "finish",
    finishReason,
    totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  };
}

function harness(options: {
  chunks: Chunk[];
  failure?: Failure;
  failedAttempts?: number;
  preserveProviderStreamBoundaries?: boolean;
}) {
  const status: ModelNetworkStatusEvent[] = [];
  const visible: ModelStreamEvent[] = [];
  const signals: AbortSignal[] = [];
  const caller = new AbortController();
  let attempts = 0;
  const runtime: AiSdkModelRuntime = {
    async generateText() {
      throw new Error("Expected streaming request");
    },
    streamText(request) {
      attempts += 1;
      const failed = attempts <= (options.failedAttempts ?? 1);
      const signal = request.abortSignal!;
      signals.push(signal);
      return {
        fullStream: (async function* () {
          if (!failed) {
            yield { type: "text-delta", id: "recovered", text: "ok" };
            yield finish();
            return;
          }
          yield* options.chunks;
          if (options.failure === "cancel") caller.abort();
          if (options.failure === "idle-timeout" || options.failure === "cancel") {
            await new Promise<void>((resolve) => {
              if (signal.aborted) resolve();
              else signal.addEventListener("abort", () => resolve(), { once: true });
            });
            return;
          }
          if (options.failure === "network-reset") {
            throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
          }
          if (options.failure === "sse-error" || options.failure === "auth") {
            const statusCode = options.failure === "auth" ? 403 : 503;
            yield {
              type: "error",
              error: new ProviderBusinessError({
                providerId: "test",
                providerKind: "anthropic",
                providerCode: String(statusCode),
                providerMessage: "provider failure",
                responseStatus: 200,
                statusCode,
              }),
            };
            return;
          }
          yield finish(options.failure === "empty-eof" ? "other" : "stop");
        })(),
      } as never;
    },
  };
  const adapter = new AiSdkModelAdapter({
    env: { ZCODE_RUNTIME_ENV: "test" },
    runtime,
    retry: { maxAttempts: MAX_ATTEMPTS, baseDelayMs: 0, maxDelayMs: 0, jitter: false },
    streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
  });
  const provider = createRegistryProviderConfig(
    parseProviderConfig({
      group: "standard-personal",
      access: { type: "api-key", apiKey: "fixture-key" },
      api: { type: "anthropic-messages", baseUrl: "https://retry.invalid/v1" },
    }),
  );
  const config = createRegistryModelConfig(
    parseModelConfig({
      enabled: true,
      properties: createTestModelProperties(),
      optionSpecs: {
        reasoningLevel: { values: ["disabled"], map: "{}" },
        maxOutputTokens: { max: MAX_OUTPUT_TOKENS, map: '{"max_tokens": maxOutputTokens}' },
      },
    }),
  );
  if (!provider.ok || !config.ok) throw new Error("Invalid model fixture config");
  const model = adapter.createModel({
    providerId: "test",
    modelId: "model-a",
    providerConfig: provider.config,
    modelConfig: config.config,
    options: { maxOutputTokens: MAX_OUTPUT_TOKENS, reasoningLevel: "disabled" },
  });
  return {
    status,
    visible,
    signals,
    get attempts() {
      return attempts;
    },
    async read() {
      const stream = runWithModelInvocationContext(
        {
          preserveProviderStreamBoundaries: options.preserveProviderStreamBoundaries,
          statusSink: { publish: (event) => void status.push(event) },
        },
        () =>
          model.streamText({
            abortSignal: caller.signal,
            messages: [{ role: "user", content: "Write test.txt" }],
          }),
      );
      for await (const event of stream) {
        visible.push(event);
      }
    },
  };
}

describe.each<Prelude>(["signature", "empty-text"])("retry after %s only", (kind) => {
  it.each<Failure>(["sse-error", "network-reset", "idle-timeout", "empty-eof"])(
    "discards incomplete tool input and retries %s without leaking the failed attempt",
    async (failure) => {
      const run = harness({ chunks: [...prelude(kind), ...TOOL_INPUT], failure });
      await run.read();

      expect(run.attempts).toBe(MAX_ATTEMPTS);
      expect(run.visible).toEqual([
        { type: "text_delta", id: "recovered", text: "ok" },
        expect.objectContaining({ type: "finish", finishReason: "stop" }),
      ]);
      expect(run.status.filter((event) => event.type === "model_retry_scheduled")).toHaveLength(1);
      expect(run.status.find((event) => event.type === "model_request_failed")).toMatchObject({
        retryable: true,
        streamOutputCommitted: false,
      });
      if (failure !== "empty-eof") expect(run.signals[0]?.aborted).toBe(true);
    },
  );
});

describe("empty delta retry boundaries", () => {
  it("preserves the successful signature and event order before a complete tool call", async () => {
    const run = harness({ chunks: [...prelude("signature"), ...COMPLETE_TOOL] });
    await run.read();

    expect(run.attempts).toBe(1);
    expect(run.visible.map((event) => event.type)).toEqual([
      "start",
      "reasoning_start",
      "reasoning_delta",
      "reasoning_end",
      "tool_input_start",
      "tool_input_end",
      "tool_call",
      "finish",
    ]);
    expect(run.visible[2]).toMatchObject({
      text: "",
      providerMetadata: { anthropic: { signature: SIGNATURE } },
    });
    expect(run.visible[6]).toMatchObject({ toolCall: { id: "call-complete" } });
  });

  it.each([
    ["text", [{ type: "text-delta", id: "visible", text: " " }]],
    ["reasoning", [{ type: "reasoning-delta", id: "reasoning-failed", text: "thinking" }]],
    ["tool call", COMPLETE_TOOL],
  ] as const)("leaves failures after nonempty %s to core recovery", async (_name, chunks) => {
    const run = harness({ chunks: [...prelude("signature"), ...chunks], failure: "network-reset" });
    await expect(run.read()).rejects.toMatchObject({ name: "AiSdkModelAdapterError" });

    expect(run.attempts).toBe(1);
    expect(run.visible).not.toHaveLength(0);
    expect(run.status.some((event) => event.type === "model_retry_scheduled")).toBe(false);
  });

  it.each<Failure>(["auth", "cancel"])(
    "keeps %s terminal before visible output",
    async (failure) => {
      const run = harness({ chunks: [...prelude("signature"), ...TOOL_INPUT], failure });
      await expect(run.read()).rejects.toMatchObject({ name: "AiSdkModelAdapterError" });

      expect(run.attempts).toBe(1);
      expect(run.visible).toEqual([]);
      expect(run.status.some((event) => event.type === "model_retry_scheduled")).toBe(false);
    },
  );

  it("stops at the existing adapter retry budget without committing the failed prelude", async () => {
    const run = harness({
      chunks: [...prelude("signature"), ...TOOL_INPUT],
      failure: "network-reset",
      failedAttempts: MAX_ATTEMPTS,
    });
    await expect(run.read()).rejects.toMatchObject({ name: "AiSdkModelAdapterError" });

    expect(run.attempts).toBe(MAX_ATTEMPTS);
    expect(run.visible).toEqual([]);
    expect(
      run.status.filter((event) => event.type === "model_request_failed").at(-1),
    ).toMatchObject({
      retryable: false,
    });
  });

  it("preserves the stricter compact provider boundary", async () => {
    const run = harness({
      chunks: prelude("signature"),
      failure: "network-reset",
      preserveProviderStreamBoundaries: true,
    });
    await expect(run.read()).rejects.toMatchObject({ name: "AiSdkModelAdapterError" });
    expect(run.attempts).toBe(1);
    expect(run.visible[2]).toMatchObject({
      providerMetadata: { anthropic: { signature: SIGNATURE } },
    });
  });
});
