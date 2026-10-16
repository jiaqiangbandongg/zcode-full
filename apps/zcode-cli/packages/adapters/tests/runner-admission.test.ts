import { describe, expect, it } from "vitest";
import {
  ModelErrorCode,
  ModelFailureReason,
  type ModelNetworkStatusEvent,
  type ModelRequestTarget,
  type ModelRequestAdmission,
  type ModelRequestAdmissionTicket,
  type ModelStreamEvent,
} from "@zcode/contracts";
import type { AiSdkModelRuntime } from "../src/model/runner-runtime.js";
import { executeAdapterGenerateText, executeAdapterStreamText } from "./test-adapter-model.js";

/** 旧 adapter 直接返回 AsyncIterableIterator；夹具返回 AsyncIterable，这里取它的迭代器以逐步驱动。 */
function iterateAdapterStream(
  ...args: Parameters<typeof executeAdapterStreamText>
): AsyncIterator<Awaited<ReturnType<typeof executeAdapterStreamText>> extends AsyncIterable<infer T> ? T : never> {
  return executeAdapterStreamText(...args)[Symbol.asyncIterator]();
}
import {
  TestAiSdkModelAdapter as AiSdkModelAdapter,
  TestProviderConfigFixture,
} from "./test-provider-config.js";

// docs/dynamic-workflow/concurrency.md「One ticket per request attempt」：runner 每次尝试发出前 acquire、结束即 release；
// 票据是该次尝试专属的状态事件汇；退避 sleep 期间不持票。

interface FakeTicket {
  events: ModelNetworkStatusEvent[];
  releases: number;
  releasedAt?: number;
}

interface FakeAdmission extends ModelRequestAdmission {
  acquires: Array<{ at: number; model: ModelRequestTarget; signal?: AbortSignal }>;
  tickets: FakeTicket[];
  log: string[];
}

function fakeAdmission(options: { blockForever?: boolean } = {}): FakeAdmission {
  const admission: FakeAdmission = {
    acquires: [],
    tickets: [],
    log: [],
    acquire({ model, signal }) {
      admission.acquires.push({ at: Date.now(), model, ...(signal ? { signal } : {}) });
      admission.log.push(`acquire#${admission.acquires.length}`);
      if (options.blockForever) {
        return new Promise<ModelRequestAdmissionTicket>((_resolve, reject) => {
          if (signal?.aborted) {
            reject(signal.reason);
            return;
          }
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      const record: FakeTicket = { events: [], releases: 0 };
      admission.tickets.push(record);
      const index = admission.tickets.length;
      const ticket: ModelRequestAdmissionTicket = {
        publish(event) {
          record.events.push(event);
        },
        release() {
          record.releases += 1;
          record.releasedAt = Date.now();
          admission.log.push(`release#${index}`);
        },
      };
      return Promise.resolve(ticket);
    },
  };
  return admission;
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
    inputTokenDetails: { noCacheTokens: inputTokens, cacheReadTokens: undefined, cacheWriteTokens: undefined },
    outputTokenDetails: { textTokens: outputTokens, reasoningTokens: undefined },
  };
}

function apiError(
  message: string,
  options: { isRetryable: boolean; responseHeaders?: Record<string, string>; statusCode: number },
): Error {
  return Object.assign(new Error(message), {
    isRetryable: options.isRetryable,
    responseHeaders: options.responseHeaders,
    statusCode: options.statusCode,
  });
}

async function* stream(chunks: unknown[]) {
  for (const chunk of chunks) yield chunk;
}

async function* failingStream(error: unknown) {
  throw error;
}

const okChunks = () => [
  { type: "start" },
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", text: "hello" },
  { type: "text-end", id: "t" },
  { type: "finish", finishReason: "stop", totalUsage: usage(1, 1) },
];

describe("runner request admission (generate)", () => {
  it("acquires once per attempt, forwards exactly that attempt's events, releases before the backoff sleep", async () => {
    const admission = fakeAdmission();
    const events: ModelNetworkStatusEvent[] = [];
    let attempts = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        attempts += 1;
        admission.log.push(`generate#${attempts}`);
        if (attempts === 1) {
          // 不带 Retry-After：让本地退避（backoffMs）生效，才能量「release 在 sleep 之前」。
          throw apiError("rate limited", { isRetryable: true, statusCode: 429 });
        }
        return { text: "ok", finishReason: "stop", usage: usage(1, 1), totalUsage: usage(1, 1) } as never;
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const backoffMs = 80;
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: backoffMs, jitter: false, maxAttempts: 2, maxDelayMs: backoffMs },
      runtime,
    });

    const result = await executeAdapterGenerateText(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Ping" }],
      modelRequestAdmission: admission,
      statusSink: { publish: (event) => void events.push(event) },
    });

    expect(result.text).toBe("ok");
    expect(admission.acquires).toHaveLength(2);
    expect(String(admission.acquires[0]!.model.modelId)).toBe("model-a");
    expect(admission.log).toEqual(["acquire#1", "generate#1", "release#1", "acquire#2", "generate#2", "release#2"]);
    expect(admission.tickets.map((ticket) => ticket.releases)).toEqual([1, 1]);
    expect(admission.tickets[0]!.events.map((event) => event.type)).toEqual([
      "model_request_started",
      "model_request_failed",
      "model_retry_scheduled",
    ]);
    expect(admission.tickets[1]!.events.map((event) => event.type)).toEqual([
      "model_request_started",
      "model_request_completed",
    ]);
    // 退避期间不持票：第 2 次 acquire 与第 1 次 release 之间隔着整段 backoff。
    expect(admission.acquires[1]!.at - admission.tickets[0]!.releasedAt!).toBeGreaterThanOrEqual(backoffMs - 10);
    // 请求级 sink 照常收到全部事件（票据是并列的一路投递，不替代）。
    expect(events.map((event) => event.type)).toEqual([
      "model_request_started",
      "model_request_failed",
      "model_retry_scheduled",
      "model_request_started",
      "model_request_completed",
    ]);
  });

  it("releases the ticket exactly once when the attempt throws a permanent failure", async () => {
    const admission = fakeAdmission();
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw apiError("bad request", { isRetryable: false, statusCode: 400 });
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 3, maxDelayMs: 0 },
      runtime,
    });
    await expect(
      executeAdapterGenerateText(adapter, {
        providerId: "test" as never,
      modelId: "model-a" as never,
        messages: [{ role: "user", content: "Ping" }],
        modelRequestAdmission: admission,
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(admission.acquires).toHaveLength(1);
    expect(admission.tickets[0]!.releases).toBe(1);
    expect(admission.tickets[0]!.events.map((event) => event.type)).toEqual([
      "model_request_started",
      "model_request_failed",
    ]);
    expect(admission.tickets[0]!.events[1]).toMatchObject({ retryable: false });
  });

  it("cancels while waiting for admission like a cancelled backoff: connect-phase cancelled failure, no request sent", async () => {
    const admission = fakeAdmission({ blockForever: true });
    const events: ModelNetworkStatusEvent[] = [];
    let attempts = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        attempts += 1;
        return { text: "never", finishReason: "stop", usage: usage(1, 1), totalUsage: usage(1, 1) } as never;
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
      runtime,
    });
    const controller = new AbortController();
    const pending = executeAdapterGenerateText(adapter, {
      abortSignal: controller.signal,
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Ping" }],
      modelRequestAdmission: admission,
      statusSink: { publish: (event) => void events.push(event) },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(admission.acquires).toHaveLength(1);
    controller.abort();
    const error = await pending.catch((cause: unknown) => cause);
    expect(error).toMatchObject({
      code: ModelErrorCode.ModelRequestCancelled,
      context: { errorPhase: "connect", reason: ModelFailureReason.Cancelled },
    });
    expect(attempts).toBe(0);
    expect(events.map((event) => event.type)).toEqual(["model_request_failed"]);
    expect(events[0]).toMatchObject({ reason: ModelFailureReason.Cancelled, retryable: false });
  });

  it("is a no-op when the request carries no admission", async () => {
    const events: ModelNetworkStatusEvent[] = [];
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        return { text: "ok", finishReason: "stop", usage: usage(1, 1), totalUsage: usage(1, 1) } as never;
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
      runtime,
    });
    const result = await executeAdapterGenerateText(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Ping" }],
      statusSink: { publish: (event) => void events.push(event) },
    });
    expect(result.text).toBe("ok");
    expect(events.map((event) => event.type)).toEqual(["model_request_started", "model_request_completed"]);
  });
});

describe("runner request admission (stream)", () => {
  it("acquires once per attempt, forwards that attempt's events, releases before the backoff sleep", async () => {
    const admission = fakeAdmission();
    let attempts = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText() {
        attempts += 1;
        admission.log.push(`stream#${attempts}`);
        if (attempts === 1) {
          return {
            fullStream: failingStream(apiError("rate limited", { isRetryable: true, statusCode: 429 })),
          } as never;
        }
        return { fullStream: stream(okChunks()) } as never;
      },
    };
    const backoffMs = 80;
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: backoffMs, jitter: false, maxAttempts: 2, maxDelayMs: backoffMs },
      runtime,
    });

    const seen: ModelStreamEvent[] = [];
    for await (const event of executeAdapterStreamText(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Ping" }],
      modelRequestAdmission: admission,
    })) {
      seen.push(event);
    }

    expect(seen.map((event) => event.type)).toEqual(["start", "text_start", "text_delta", "text_end", "finish"]);
    expect(admission.log).toEqual(["acquire#1", "stream#1", "release#1", "acquire#2", "stream#2", "release#2"]);
    expect(admission.tickets.map((ticket) => ticket.releases)).toEqual([1, 1]);
    expect(admission.tickets[0]!.events.map((event) => event.type)).toEqual([
      "model_request_started",
      "model_request_failed",
      "model_retry_scheduled",
    ]);
    expect(admission.tickets[1]!.events.map((event) => event.type)).toEqual([
      "model_request_started",
      "model_request_completed",
    ]);
    expect(admission.acquires[1]!.at - admission.tickets[0]!.releasedAt!).toBeGreaterThanOrEqual(backoffMs - 10);
  });

  it("releases the ticket when the consumer abandons the stream early", async () => {
    const admission = fakeAdmission();
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText() {
        return { fullStream: stream(okChunks()) } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
      runtime,
    });
    const iterator = iterateAdapterStream(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Ping" }],
      modelRequestAdmission: admission,
    });
    const first = await iterator.next();
    expect(first.done).toBe(false);
    await iterator.return(undefined);
    expect(admission.acquires).toHaveLength(1);
    expect(admission.tickets[0]!.releases).toBe(1);
    expect(admission.tickets[0]!.events[0]?.type).toBe("model_request_started");
  });

  it("cancels while waiting for admission with a connect-phase cancelled failure", async () => {
    const admission = fakeAdmission({ blockForever: true });
    let attempts = 0;
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        throw new Error("not used");
      },
      streamText() {
        attempts += 1;
        return { fullStream: stream(okChunks()) } as never;
      },
    };
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
      runtime,
    });
    const controller = new AbortController();
    const iterator = iterateAdapterStream(adapter, {
      abortSignal: controller.signal,
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Ping" }],
      modelRequestAdmission: admission,
    });
    const pending = iterator.next();
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    const error = await pending.catch((cause: unknown) => cause);
    expect(error).toMatchObject({
      code: ModelErrorCode.ModelRequestCancelled,
      context: { errorPhase: "connect", reason: ModelFailureReason.Cancelled },
    });
    expect(attempts).toBe(0);
  });
});

// v3 决策 44：tryAcquire 快路径未命中 → runner 发 queued，拿到票 → admitted（带排队时长）；
// 命中或端口没有快路径 → 一条都不发。

interface QueueingAdmission extends ModelRequestAdmission {
  tryAcquires: number;
  grant: () => void;
}

/** 有快路径的端口：`fastHits` 次快路径命中后转排队；排队由测试 `grant()` 兑现。 */
function queueingAdmission(options: { fastHits?: number; hasFastPath?: boolean } = {}): QueueingAdmission {
  const hasFastPath = options.hasFastPath ?? true;
  let fastHits = options.fastHits ?? 0;
  let pending: (() => void) | undefined;
  const ticket = (): ModelRequestAdmissionTicket => ({ publish() {}, release() {} });
  const admission: QueueingAdmission = {
    tryAcquires: 0,
    grant: () => {
      pending?.();
      pending = undefined;
    },
    acquire({ signal }) {
      return new Promise<ModelRequestAdmissionTicket>((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        pending = () => resolve(ticket());
      });
    },
  };
  if (hasFastPath) {
    admission.tryAcquire = () => {
      admission.tryAcquires += 1;
      if (fastHits > 0) {
        fastHits -= 1;
        return ticket();
      }
      return undefined;
    };
  }
  return admission;
}

function okRuntime(): AiSdkModelRuntime {
  return {
    async generateText() {
      return { text: "ok", finishReason: "stop", usage: usage(1, 1), totalUsage: usage(1, 1) } as never;
    },
    streamText() {
      return { fullStream: stream(okChunks()) } as never;
    },
  };
}

describe("runner request admission — queued / admitted 状态事件（v3 决策 44）", () => {
  it("generate：快路径未命中 → queued → 拿到票 admitted(queuedMs) → started → completed", async () => {
    const admission = queueingAdmission();
    const events: ModelNetworkStatusEvent[] = [];
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
      runtime: okRuntime(),
    });
    const pending = executeAdapterGenerateText(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Ping" }],
      modelRequestAdmission: admission,
      statusSink: { publish: (event) => void events.push(event) },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(admission.tryAcquires).toBe(1);
    expect(events.map((event) => event.type)).toEqual(["model_request_queued"]);
    admission.grant();
    const result = await pending;
    expect(result.text).toBe("ok");
    expect(events.map((event) => event.type)).toEqual([
      "model_request_queued",
      "model_request_admitted",
      "model_request_started",
      "model_request_completed",
    ]);
    const admitted = events[1] as Extract<ModelNetworkStatusEvent, { type: "model_request_admitted" }>;
    expect(admitted.queuedMs).toBeGreaterThanOrEqual(25);
    // 两端事件与该尝试的其余事件同一 requestId：消费方能把它们归到同一条链。
    expect(events.every((event) => event.requestId === events[0]!.requestId)).toBe(true);
  });

  it("stream：同一顺序", async () => {
    const admission = queueingAdmission();
    const events: ModelNetworkStatusEvent[] = [];
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
      runtime: okRuntime(),
    });
    const iterator = iterateAdapterStream(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Ping" }],
      modelRequestAdmission: admission,
      statusSink: { publish: (event) => void events.push(event) },
    });
    const first = iterator.next();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events.map((event) => event.type)).toEqual(["model_request_queued"]);
    admission.grant();
    await first;
    for await (const _event of { [Symbol.asyncIterator]: () => iterator }) {
      // drain
    }
    expect(events.map((event) => event.type)).toEqual([
      "model_request_queued",
      "model_request_admitted",
      "model_request_started",
      "model_request_completed",
    ]);
  });

  it("快路径命中：不发 queued / admitted", async () => {
    const admission = queueingAdmission({ fastHits: 1 });
    const events: ModelNetworkStatusEvent[] = [];
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
      runtime: okRuntime(),
    });
    await executeAdapterGenerateText(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Ping" }],
      modelRequestAdmission: admission,
      statusSink: { publish: (event) => void events.push(event) },
    });
    expect(admission.tryAcquires).toBe(1);
    expect(events.map((event) => event.type)).toEqual(["model_request_started", "model_request_completed"]);
  });

  it("端口没有快路径：分不清排队与放行，一律不发", async () => {
    const admission = queueingAdmission({ hasFastPath: false });
    const events: ModelNetworkStatusEvent[] = [];
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
      runtime: okRuntime(),
    });
    const pending = executeAdapterGenerateText(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Ping" }],
      modelRequestAdmission: admission,
      statusSink: { publish: (event) => void events.push(event) },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    admission.grant();
    await pending;
    expect(events.map((event) => event.type)).toEqual(["model_request_started", "model_request_completed"]);
  });

  it("排队中被取消：queued 之后只有 connect 阶段的 cancelled failed，没有 admitted", async () => {
    const admission = queueingAdmission();
    const events: ModelNetworkStatusEvent[] = [];
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: { baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
      runtime: okRuntime(),
    });
    const controller = new AbortController();
    const pending = executeAdapterGenerateText(adapter, {
      abortSignal: controller.signal,
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Ping" }],
      modelRequestAdmission: admission,
      statusSink: { publish: (event) => void events.push(event) },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: ModelErrorCode.ModelRequestCancelled });
    expect(events.map((event) => event.type)).toEqual(["model_request_queued", "model_request_failed"]);
    expect(events[1]).toMatchObject({ reason: ModelFailureReason.Cancelled });
  });
});
