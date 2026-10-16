import { describe, expect, it, vi } from "vitest";
import type { Logger, ModelNetworkStatusEvent, ModelStreamEvent } from "@zcode/contracts";
import type { AiSdkModelRuntime } from "../src/model/runner.js";
import { ProviderBusinessError } from "../src/model/model-execution.js";
import {
  TestAiSdkModelAdapter as AiSdkModelAdapter,
  TestProviderConfigFixture,
} from "./test-provider-config.js";
import { executeAdapterGenerateText, executeAdapterStreamText } from "./test-adapter-model.js";

const PROVIDER_NETWORK_BUSINESS_CODE = "1234";
const PROVIDER_NETWORK_REQUEST_ID = "20260507204936c1a89ada366747b7";
const PROVIDER_NETWORK_MESSAGE = `网络错误，错误id：${PROVIDER_NETWORK_REQUEST_ID}，请稍后重试`;
const PROVIDER_FLOW_LIMIT_BUSINESS_CODE = "1305";
const PROVIDER_FLOW_LIMIT_REQUEST_ID = "20260608093000flowlimit";
const PROVIDER_FLOW_LIMIT_MESSAGE = `平台流量限制，错误id：${PROVIDER_FLOW_LIMIT_REQUEST_ID}，请稍后重试`;
const PROVIDER_BRACKET_RATE_LIMIT_REQUEST_ID = "20260608211523b786be6a48924736";
const PROVIDER_BRACKET_RATE_LIMIT_MESSAGE = `[1302][Rate limit reached for requests][${PROVIDER_BRACKET_RATE_LIMIT_REQUEST_ID}]`;
const PROVIDER_SOCKET_RESET_REQUEST_ID = "call_00_socket_reset";
const PROVIDER_SOCKET_RESET_MESSAGE = "Cannot connect to API: socket hang up";

describe("AiSdkModelAdapter provider business network retries", () => {
  it("retries HTTP 200 provider network business errors before succeeding", async () => {
    const events: ModelNetworkStatusEvent[] = [];
    let attempts = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        attempts += 1;
        if (attempts === 1) {
          throw providerNetworkBusinessError();
        }

        return {
          text: "ok after network business retry",
          finishReason: "stop",
          usage: usage(1, 2),
          totalUsage: usage(1, 2),
        } as never;
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const adapter = adapterWithRuntime(runtime);

    const result = await executeAdapterGenerateText(adapter, {
      metadata: { requestId: "model_req_provider_network", traceId: "trace_provider_network" },
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Ping" }],
      statusSink: captureEvents(events),
    });

    expect(result.text).toBe("ok after network business retry");
    expect(attempts).toBe(2);
    expect(events.map((event) => event.type)).toEqual([
      "model_request_started",
      "model_request_failed",
      "model_retry_scheduled",
      "model_request_started",
      "model_request_completed",
    ]);
    expect(events[1]).toMatchObject({
      message: PROVIDER_NETWORK_MESSAGE,
      reason: "network_error",
      retryable: true,
      statusCode: undefined,
    });
    expect(events[2]).toMatchObject({
      message: PROVIDER_NETWORK_MESSAGE,
      nextAttempt: 2,
      reason: "network_error",
      statusCode: undefined,
      type: "model_retry_scheduled",
    });
  });

  it("retries SSE provider network business errors before visible output", async () => {
    const events: ModelNetworkStatusEvent[] = [];
    let attempts = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText() {
        attempts += 1;
        if (attempts === 1) {
          return { fullStream: failingStream(providerNetworkBusinessError()) } as never;
        }

        return {
          fullStream: stream([
            { type: "text-delta", id: "1", text: "ok" },
            {
              type: "finish",
              finishReason: "stop",
              rawFinishReason: undefined,
              totalUsage: usage(1, 1),
            },
          ]),
        } as never;
      },
    };
    const adapter = adapterWithRuntime(runtime);

    const streamed: ModelStreamEvent[] = [];
    for await (const event of executeAdapterStreamText(adapter, {
      metadata: {
        requestId: "model_req_sse_provider_network",
        traceId: "trace_sse_provider_network",
      },
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Ping" }],
      statusSink: captureEvents(events),
    })) {
      streamed.push(event);
    }

    expect(streamed[0]).toEqual({ id: "1", text: "ok", type: "text_delta" });
    expect(attempts).toBe(2);
    expect(events.map((event) => event.type)).toEqual([
      "model_request_started",
      "model_request_failed",
      "model_retry_scheduled",
      "model_request_started",
      "model_request_completed",
    ]);
    expect(events[1]).toMatchObject({
      reason: "network_error",
      retryable: true,
    });
    expect(events[2]).toMatchObject({
      nextAttempt: 2,
      reason: "network_error",
      type: "model_retry_scheduled",
    });
  });

  it("retries SSE provider flow-limit business errors before visible output", async () => {
    const events: ModelNetworkStatusEvent[] = [];
    let attempts = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText() {
        attempts += 1;
        if (attempts === 1) {
          return { fullStream: failingStream(providerFlowLimitBusinessError()) } as never;
        }

        return {
          fullStream: stream([
            { type: "text-delta", id: "1", text: "ok" },
            {
              type: "finish",
              finishReason: "stop",
              rawFinishReason: undefined,
              totalUsage: usage(1, 1),
            },
          ]),
        } as never;
      },
    };
    const adapter = adapterWithRuntime(runtime);

    const streamed: ModelStreamEvent[] = [];
    for await (const event of executeAdapterStreamText(adapter, {
      metadata: {
        requestId: "model_req_sse_provider_flow_limit",
        traceId: "trace_sse_provider_flow_limit",
      },
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Ping" }],
      statusSink: captureEvents(events),
    })) {
      streamed.push(event);
    }

    expect(streamed[0]).toEqual({ id: "1", text: "ok", type: "text_delta" });
    expect(attempts).toBe(2);
    expect(events.map((event) => event.type)).toEqual([
      "model_request_started",
      "model_request_failed",
      "model_retry_scheduled",
      "model_request_started",
      "model_request_completed",
    ]);
    expect(events[1]).toMatchObject({
      message: PROVIDER_FLOW_LIMIT_MESSAGE,
      reason: "rate_limited",
      retryable: true,
    });
    expect(events[2]).toMatchObject({
      nextAttempt: 2,
      reason: "rate_limited",
      type: "model_retry_scheduled",
    });
  });

  it("waits for asynchronous ordinary SSE iterator close before the next retry", async () => {
    const attemptSignals: AbortSignal[] = [];
    const closedAttempts: number[] = [];
    const closeStarted = [deferred(), deferred()];
    const closeCompleted = [deferred(), deferred()];
    const releaseClose = [deferred(), deferred()];
    const retainedCleanupStarted = [deferred(), deferred()];
    const retainedCleanupCompleted = [deferred(), deferred()];
    const releaseRetainedCleanup = [deferred(), deferred()];
    let attempts = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText(options) {
        attempts += 1;
        if (!options.abortSignal) {
          throw new Error("ordinary SSE attempt 缺少 abort signal");
        }
        attemptSignals.push(options.abortSignal);
        if (attempts <= 2) {
          const failedAttempt = attempts;
          return {
            fullStream: failingStreamWithReturn(
              providerFlowLimitBusinessError({ "retry-after": "0" }),
              async () => {
                closeStarted[failedAttempt - 1]?.resolve();
                await releaseClose[failedAttempt - 1]?.promise;
                closedAttempts.push(failedAttempt);
                closeCompleted[failedAttempt - 1]?.resolve();
              },
            ),
            async consumeStream() {
              retainedCleanupStarted[failedAttempt - 1]?.resolve();
              await releaseRetainedCleanup[failedAttempt - 1]?.promise;
              retainedCleanupCompleted[failedAttempt - 1]?.resolve();
            },
          } as never;
        }

        // 回归 BG26：第三次物理请求启动前，前两个失败 stream 必须已经 abort 且异步关闭完成。
        expect(attemptSignals.slice(0, 2).every((signal) => signal.aborted)).toBe(true);
        expect(closedAttempts).toEqual([1, 2]);
        return {
          fullStream: stream([
            { type: "text-delta", id: "1", text: "ok" },
            {
              type: "finish",
              finishReason: "stop",
              rawFinishReason: undefined,
              totalUsage: usage(1, 1),
            },
          ]),
        } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 3, maxDelayMs: 0 },
      runtime,
    });

    const streaming = collectStreamEvents(adapter);

    await Promise.all([closeStarted[0]?.promise, retainedCleanupStarted[0]?.promise]);
    expect(attempts).toBe(1);
    expect(closedAttempts).toEqual([]);
    releaseClose[0]?.resolve();
    await closeCompleted[0]?.promise;
    expect(attempts).toBe(1);
    releaseRetainedCleanup[0]?.resolve();
    await retainedCleanupCompleted[0]?.promise;

    await Promise.all([closeStarted[1]?.promise, retainedCleanupStarted[1]?.promise]);
    expect(attempts).toBe(2);
    expect(closedAttempts).toEqual([1]);
    releaseClose[1]?.resolve();
    await closeCompleted[1]?.promise;
    expect(attempts).toBe(2);
    releaseRetainedCleanup[1]?.resolve();
    await retainedCleanupCompleted[1]?.promise;

    const streamed = await streaming;

    expect(attempts).toBe(3);
    expect(attemptSignals.map((signal) => signal.aborted)).toEqual([true, true, false]);
    expect(closedAttempts).toEqual([1, 2]);
    expect(streamed[0]).toEqual({ id: "1", text: "ok", type: "text_delta" });
  });

  it("waits for ordinary SSE error-chunk cleanup before the next retry", async () => {
    const attemptSignals: AbortSignal[] = [];
    const closeStarted = deferred();
    const closeCompleted = deferred();
    const releaseClose = deferred();
    const retainedCleanupStarted = deferred();
    const retainedCleanupCompleted = deferred();
    const releaseRetainedCleanup = deferred();
    const nextAttemptStarted = deferred();
    let attempts = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText(options) {
        attempts += 1;
        if (!options.abortSignal) {
          throw new Error("ordinary SSE error chunk attempt 缺少 abort signal");
        }
        attemptSignals.push(options.abortSignal);
        if (attempts === 1) {
          return {
            fullStream: errorChunkStreamWithReturn(
              providerFlowLimitBusinessError({ "retry-after": "0" }),
              async () => {
                closeStarted.resolve();
                await releaseClose.promise;
                closeCompleted.resolve();
              },
            ),
            async consumeStream() {
              retainedCleanupStarted.resolve();
              await releaseRetainedCleanup.promise;
              retainedCleanupCompleted.resolve();
            },
          } as never;
        }

        nextAttemptStarted.resolve();
        return {
          fullStream: stream([
            { type: "text-delta", id: "1", text: "ok after error chunk cleanup" },
            {
              type: "finish",
              finishReason: "stop",
              rawFinishReason: undefined,
              totalUsage: usage(1, 1),
            },
          ]),
        } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
      runtime,
    });

    const streaming = collectStreamEvents(adapter);
    const firstLifecycleStep = await Promise.race([
      Promise.all([closeStarted.promise, retainedCleanupStarted.promise]).then(
        () => "cleanup" as const,
      ),
      nextAttemptStarted.promise.then(() => "retry" as const),
    ]);

    expect(firstLifecycleStep).toBe("cleanup");
    expect(attempts).toBe(1);
    expect(attemptSignals[0]?.aborted).toBe(true);

    releaseClose.resolve();
    await closeCompleted.promise;
    expect(attempts).toBe(1);

    releaseRetainedCleanup.resolve();
    await retainedCleanupCompleted.promise;
    const streamed = await streaming;

    expect(attempts).toBe(2);
    expect(attemptSignals.map((signal) => signal.aborted)).toEqual([true, false]);
    expect(streamed[0]).toEqual({
      id: "1",
      text: "ok after error chunk cleanup",
      type: "text_delta",
    });
  });

  it("continues retry after bounded iterator close timeout", async () => {
    vi.useFakeTimers();
    try {
      const closeStarted = deferred();
      const warn = vi.fn();
      const logger: Logger = {
        child() {
          return logger;
        },
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn,
      };
      let attempts = 0;
      const runtime: AiSdkModelRuntime = {
        async generateText() {
          throw new Error("not used");
        },
        streamText() {
          attempts += 1;
          if (attempts === 1) {
            return {
              fullStream: failingStreamWithReturn(
                providerFlowLimitBusinessError({ "retry-after": "0" }),
                async () => {
                  closeStarted.resolve();
                  await new Promise<never>(() => undefined);
                },
              ),
            } as never;
          }
          return {
            fullStream: stream([
              { type: "text-delta", id: "1", text: "ok after close timeout" },
              {
                type: "finish",
                finishReason: "stop",
                rawFinishReason: undefined,
                totalUsage: usage(1, 1),
              },
            ]),
          } as never;
        },
      };
      const adapter = new AiSdkModelAdapter({
        logger,
        registry: registry(),
        retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
        runtime,
      });

      const streaming = collectStreamEvents(adapter);
      await closeStarted.promise;
      expect(attempts).toBe(1);

      await vi.advanceTimersByTimeAsync(1_000);
      const streamed = await streaming;

      expect(attempts).toBe(2);
      expect(streamed[0]).toEqual({
        id: "1",
        text: "ok after close timeout",
        type: "text_delta",
      });
      expect(warn).toHaveBeenCalledWith(
        "Model stream attempt cleanup timed out",
        expect.objectContaining({
          attempt: 1,
          event: "model.stream_attempt_cleanup.timeout",
          timeoutMs: 1_000,
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses retry-after from provider business errors before retrying", async () => {
    vi.useFakeTimers();
    try {
      const events: ModelNetworkStatusEvent[] = [];
      let attempts = 0;
      const runtime: AiSdkModelRuntime = {
        async generateText() {
          attempts += 1;
          if (attempts === 1) {
            throw providerFlowLimitBusinessError({ "retry-after": "41" });
          }

          return {
            text: "ok after provider retry-after",
            finishReason: "stop",
            usage: usage(1, 2),
            totalUsage: usage(1, 2),
          } as never;
        },
        streamText() {
          throw new Error("not used");
        },
      };
      const adapter = adapterWithRuntime(runtime);

      const resultPromise = executeAdapterGenerateText(adapter, {
        metadata: {
          requestId: "model_req_provider_flow_limit_retry_after",
          traceId: "trace_provider_flow_limit_retry_after",
        },
        providerId: "test" as never,
        modelId: "model-a" as never,
        messages: [{ role: "user", content: "Ping" }],
        statusSink: captureEvents(events),
      });
      await waitForRetryEvents(events, 1);

      expect(events[2]).toMatchObject({
        delayMs: 41_000,
        nextAttempt: 2,
        reason: "rate_limited",
        type: "model_retry_scheduled",
      });

      await vi.advanceTimersByTimeAsync(41_000);
      await expect(resultPromise).resolves.toMatchObject({
        text: "ok after provider retry-after",
      });
      expect(attempts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses retry-after from SSE provider business error chunks before retrying", async () => {
    vi.useFakeTimers();
    try {
      const events: ModelNetworkStatusEvent[] = [];
      let attempts = 0;
      const runtime: AiSdkModelRuntime = {
        async generateText() {
          throw new Error("not used");
        },
        streamText() {
          attempts += 1;
          if (attempts === 1) {
            return {
              fullStream: stream([
                {
                  type: "error",
                  error: providerFlowLimitBusinessError({
                    "retry-after": "37",
                    "x-should-retry": "true",
                  }),
                },
              ]),
            } as never;
          }

          return {
            fullStream: stream([
              { type: "text-delta", id: "1", text: "ok after provider retry-after" },
              {
                type: "finish",
                finishReason: "stop",
                rawFinishReason: undefined,
                totalUsage: usage(1, 1),
              },
            ]),
          } as never;
        },
      };
      const adapter = adapterWithRuntime(runtime);

      const resultPromise = (async () => {
        const streamed: ModelStreamEvent[] = [];
        for await (const event of executeAdapterStreamText(adapter, {
          metadata: {
            requestId: "model_req_sse_provider_flow_limit_retry_after",
            traceId: "trace_sse_provider_flow_limit_retry_after",
          },
          providerId: "test" as never,
          modelId: "model-a" as never,
          messages: [{ role: "user", content: "Ping" }],
          statusSink: captureEvents(events),
        })) {
          streamed.push(event);
        }
        return streamed;
      })();
      await waitForRetryEvents(events, 1);

      expect(events[2]).toMatchObject({
        delayMs: 37_000,
        nextAttempt: 2,
        reason: "rate_limited",
        type: "model_retry_scheduled",
      });
      expect(attempts).toBe(1);

      await vi.advanceTimersByTimeAsync(37_000);
      await expect(resultPromise).resolves.toMatchObject([
        { id: "1", text: "ok after provider retry-after", type: "text_delta" },
        { finishReason: "stop", type: "finish" },
      ]);
      expect(attempts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores retry-after when provider business headers mark should-retry false", async () => {
    const events: ModelNetworkStatusEvent[] = [];
    let attempts = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        attempts += 1;
        if (attempts === 1) {
          throw providerFlowLimitBusinessError({
            "retry-after": "41",
            "x-should-retry": "false",
          });
        }

        return {
          text: "ok after local retry delay",
          finishReason: "stop",
          usage: usage(1, 2),
          totalUsage: usage(1, 2),
        } as never;
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const adapter = adapterWithRuntime(runtime);

    const result = await executeAdapterGenerateText(adapter, {
      metadata: {
        requestId: "model_req_provider_flow_limit_should_retry_false",
        traceId: "trace_provider_flow_limit_should_retry_false",
      },
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Ping" }],
      statusSink: captureEvents(events),
    });

    expect(result.text).toBe("ok after local retry delay");
    expect(attempts).toBe(2);
    expect(events[2]).toMatchObject({
      delayMs: 0,
      nextAttempt: 2,
      reason: "rate_limited",
      type: "model_retry_scheduled",
    });
  });

  it("retries SSE BigModel bracket-coded message errors before visible output", async () => {
    const events: ModelNetworkStatusEvent[] = [];
    let attempts = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText() {
        attempts += 1;
        if (attempts === 1) {
          return {
            fullStream: stream([
              {
                type: "error",
                error: new Error(PROVIDER_BRACKET_RATE_LIMIT_MESSAGE),
              },
            ]),
          } as never;
        }

        return {
          fullStream: stream([
            { type: "text-delta", id: "1", text: "ok" },
            {
              type: "finish",
              finishReason: "stop",
              rawFinishReason: undefined,
              totalUsage: usage(1, 1),
            },
          ]),
        } as never;
      },
    };
    const adapter = adapterWithRuntime(runtime);

    const streamed: ModelStreamEvent[] = [];
    for await (const event of executeAdapterStreamText(adapter, {
      metadata: {
        requestId: "model_req_sse_provider_bracket_rate_limit",
        traceId: "trace_sse_provider_bracket_rate_limit",
      },
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Ping" }],
      statusSink: captureEvents(events),
    })) {
      streamed.push(event);
    }

    expect(streamed[0]).toEqual({ id: "1", text: "ok", type: "text_delta" });
    expect(attempts).toBe(2);
    expect(events.map((event) => event.type)).toEqual([
      "model_request_started",
      "model_request_failed",
      "model_retry_scheduled",
      "model_request_started",
      "model_request_completed",
    ]);
    expect(events[1]).toMatchObject({
      message: PROVIDER_BRACKET_RATE_LIMIT_MESSAGE,
      reason: "rate_limited",
      retryable: true,
    });
    expect(events[2]).toMatchObject({
      nextAttempt: 2,
      reason: "rate_limited",
      type: "model_retry_scheduled",
    });
  });

  it("retries SSE provider transport reset error chunks before visible output", async () => {
    const events: ModelNetworkStatusEvent[] = [];
    let attempts = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText() {
        attempts += 1;
        if (attempts === 1) {
          return {
            fullStream: stream([
              {
                type: "error",
                error: providerSocketResetApiCallError(),
              },
            ]),
          } as never;
        }

        return {
          fullStream: stream([
            { type: "text-delta", id: "1", text: "ok" },
            {
              type: "finish",
              finishReason: "stop",
              rawFinishReason: undefined,
              totalUsage: usage(1, 1),
            },
          ]),
        } as never;
      },
    };
    const adapter = adapterWithRuntime(runtime);

    const streamed: ModelStreamEvent[] = [];
    for await (const event of executeAdapterStreamText(adapter, {
      metadata: {
        requestId: "model_req_sse_provider_socket_reset",
        traceId: "trace_sse_provider_socket_reset",
      },
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Ping" }],
      statusSink: captureEvents(events),
    })) {
      streamed.push(event);
    }

    expect(streamed[0]).toEqual({ id: "1", text: "ok", type: "text_delta" });
    expect(attempts).toBe(2);
    expect(events.map((event) => event.type)).toEqual([
      "model_request_started",
      "model_request_failed",
      "model_retry_scheduled",
      "model_request_started",
      "model_request_completed",
    ]);
    expect(events[1]).toMatchObject({
      message: PROVIDER_SOCKET_RESET_MESSAGE,
      reason: "network_error",
      retryable: true,
    });
    expect(events[2]).toMatchObject({
      nextAttempt: 2,
      reason: "network_error",
      type: "model_retry_scheduled",
    });
  });
});

function adapterWithRuntime(runtime: AiSdkModelRuntime): AiSdkModelAdapter {
  return new AiSdkModelAdapter({
    registry: registry(),
    retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
    runtime,
  });
}

function captureEvents(events: ModelNetworkStatusEvent[]) {
  return {
    publish(event: ModelNetworkStatusEvent): void {
      events.push(event);
    },
  };
}

function providerNetworkBusinessError(): ProviderBusinessError {
  return new ProviderBusinessError({
    providerCode: PROVIDER_NETWORK_BUSINESS_CODE,
    providerId: "zcode-anthropic",
    providerKind: "openai-compatible",
    providerMessage: PROVIDER_NETWORK_MESSAGE,
    providerRequestId: PROVIDER_NETWORK_REQUEST_ID,
    responseBodySummary: {
      error: {
        code: PROVIDER_NETWORK_BUSINESS_CODE,
        message: PROVIDER_NETWORK_MESSAGE,
      },
      request_id: PROVIDER_NETWORK_REQUEST_ID,
      type: "error",
    },
    responseStatus: 200,
  });
}

function providerFlowLimitBusinessError(
  responseHeaders?: Record<string, string>,
): ProviderBusinessError {
  return new ProviderBusinessError({
    providerCode: PROVIDER_FLOW_LIMIT_BUSINESS_CODE,
    providerId: "zcode-anthropic",
    providerKind: "openai-compatible",
    providerMessage: PROVIDER_FLOW_LIMIT_MESSAGE,
    providerRequestId: PROVIDER_FLOW_LIMIT_REQUEST_ID,
    responseBodySummary: {
      error: {
        code: PROVIDER_FLOW_LIMIT_BUSINESS_CODE,
        message: PROVIDER_FLOW_LIMIT_MESSAGE,
      },
      request_id: PROVIDER_FLOW_LIMIT_REQUEST_ID,
      type: "error",
    },
    responseHeaders,
    responseStatus: 200,
  });
}

function providerSocketResetApiCallError() {
  return {
    cause: { code: "ECONNRESET" },
    id: PROVIDER_SOCKET_RESET_REQUEST_ID,
    isRetryable: true,
    message: PROVIDER_SOCKET_RESET_MESSAGE,
    name: "AI_APICallError",
  };
}

function registry(): TestProviderConfigFixture {
  return new TestProviderConfigFixture({
    providers: {
      test: {
        kind: "custom",
        createLanguageModel: (modelId) => ({ modelId }) as never,
      },
    },
  });
}

function usage(inputTokens: number, outputTokens: number) {
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    inputTokenDetails: {
      noCacheTokens: inputTokens,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    },
    outputTokenDetails: {
      textTokens: outputTokens,
      reasoningTokens: undefined,
    },
  };
}

async function* stream(chunks: unknown[]) {
  for (const chunk of chunks) {
    yield chunk;
  }
}

async function* failingStream(error: unknown) {
  throw error;
}

function failingStreamWithReturn(
  error: unknown,
  onReturn: () => Promise<void> | void,
): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          throw error;
        },
        async return() {
          await onReturn();
          return { done: true as const, value: undefined };
        },
      };
    },
  };
}

function errorChunkStreamWithReturn(
  error: unknown,
  onReturn: () => Promise<void> | void,
): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      let emitted = false;
      return {
        async next() {
          if (emitted) return { done: true as const, value: undefined };
          emitted = true;
          return { done: false as const, value: { error, type: "error" } };
        },
        async return() {
          await onReturn();
          return { done: true as const, value: undefined };
        },
      };
    },
  };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function collectStreamEvents(adapter: AiSdkModelAdapter): Promise<ModelStreamEvent[]> {
  const streamed: ModelStreamEvent[] = [];
  for await (const event of executeAdapterStreamText(adapter, {
    providerId: "test" as never,
    modelId: "model-a" as never,
    messages: [{ role: "user", content: "Ping" }],
  })) {
    streamed.push(event);
  }
  return streamed;
}

async function waitForRetryEvents(events: ModelNetworkStatusEvent[], count: number): Promise<void> {
  const retryEvents = () => events.filter((event) => event.type === "model_retry_scheduled");
  for (let turn = 0; turn < 20 && retryEvents().length < count; turn += 1) {
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(retryEvents()).toHaveLength(count);
}
