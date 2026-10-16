import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SessionEventType,
  createRootTraceContext,
  createSessionId,
  createToolCallId,
  createTurnId,
  getCurrentModelInvocationContext,
  runWithModelInvocationContext,
  type Model,
  type ModelNetworkStatusEvent,
  type ModelStatusSink,
  type SessionEvent,
} from "@zcode/contracts";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { createToolExecutor } from "../src/tool/executor.js";
import { ToolDeadline, observeToolAdmissionClock } from "../src/tool/executor/timeout.js";
import { createToolRegistry } from "../src/tool/registry.js";
import type { ToolEntry, ToolExecutionContext } from "../src/tool/types.js";

// docs/dynamic-workflow/concurrency.md「Tool-side requests」：工具内部的模型请求在准入闸门前排队的时间
// 不计入工具超时——超时守的是「provider 挂了」，不是「我们自己的队列长」。

afterEach(() => {
  vi.useRealTimers();
});

describe("ToolDeadline", () => {
  it("暂停期间不计时，续上后剩余时长守恒，queuedMs 累计排队时长", () => {
    vi.useFakeTimers();
    const deadline = new ToolDeadline(1000);
    let expired = false;
    deadline.start(() => {
      expired = true;
    });
    vi.advanceTimersByTime(300);
    deadline.pause();
    vi.advanceTimersByTime(5000);
    expect(expired).toBe(false);
    deadline.resume();
    expect(deadline.queuedMs).toBe(5000);
    vi.advanceTimersByTime(650);
    expect(expired).toBe(false);
    vi.advanceTimersByTime(60);
    expect(expired).toBe(true);
  });

  it("多个请求并存取并集：计数归零才续；start 之前的 pause 同样生效", () => {
    vi.useFakeTimers();
    const deadline = new ToolDeadline(100);
    let expired = false;
    deadline.pause();
    deadline.start(() => {
      expired = true;
    });
    deadline.pause();
    vi.advanceTimersByTime(1000);
    deadline.resume();
    vi.advanceTimersByTime(1000);
    expect(expired).toBe(false);
    deadline.resume();
    vi.advanceTimersByTime(99);
    expect(expired).toBe(false);
    vi.advanceTimersByTime(2);
    expect(expired).toBe(true);
    expect(deadline.queuedMs).toBe(2000);
  });

  it("无 timeout 的工具：只累计排队时长，永不过期；clear 后不再触发", () => {
    vi.useFakeTimers();
    const untimed = new ToolDeadline(undefined);
    let expired = false;
    untimed.start(() => {
      expired = true;
    });
    untimed.pause();
    vi.advanceTimersByTime(10_000);
    untimed.resume();
    expect(expired).toBe(false);
    expect(untimed.queuedMs).toBe(10_000);

    const cleared = new ToolDeadline(50);
    cleared.start(() => {
      expired = true;
    });
    cleared.clear();
    vi.advanceTimersByTime(100);
    expect(expired).toBe(false);
  });

  it("observeToolAdmissionClock 只认本 toolCallId 的 queued / admitted", () => {
    vi.useFakeTimers();
    const deadline = new ToolDeadline(100);
    let expired = false;
    deadline.start(() => {
      expired = true;
    });
    const status = (type: string, toolCallId: string): SessionEvent =>
      ({
        type: SessionEventType.ModelNetworkStatus,
        payload: { type, toolCallId },
      }) as unknown as SessionEvent;
    observeToolAdmissionClock(status("model_request_queued", "other"), "mine", deadline);
    vi.advanceTimersByTime(60);
    observeToolAdmissionClock(status("model_request_queued", "mine"), "mine", deadline);
    vi.advanceTimersByTime(1000);
    expect(expired).toBe(false);
    observeToolAdmissionClock(status("model_request_admitted", "mine"), "mine", deadline);
    vi.advanceTimersByTime(45);
    expect(expired).toBe(true);
    // 非状态事件不动时钟。
    observeToolAdmissionClock(
      { type: SessionEventType.ToolCallStarted, payload: {} } as unknown as SessionEvent,
      "mine",
      deadline,
    );
  });
});

describe("tool executor pauses the deadline while a tool-side request is queued", () => {
  function slowEntry(input: {
    name: string;
    timeoutMs: number;
    run: (context: ToolExecutionContext) => Promise<void>;
  }): ToolEntry {
    return {
      capability: "test",
      metadata: {
        name: input.name,
        description: "test tool",
        readOnly: true,
        destructive: false,
        concurrentSafe: true,
        timeoutMs: input.timeoutMs,
        maxOutputBytes: 1000,
        sideEffectScope: "none",
        riskLevel: "low",
        needsApproval: false,
      },
      handler: async (_input: unknown, context: ToolExecutionContext) => {
        await input.run(context);
        return { ok: true };
      },
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
    } as unknown as ToolEntry;
  }

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  async function run(entry: ToolEntry, emitted: SessionEvent[] = []) {
    const sessionId = createSessionId("deadline-exec");
    const turnId = createTurnId("deadline-exec");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const registry = createToolRegistry();
    registry.register(entry);
    const executor = createToolExecutor({
      emitEvent: async (event) => {
        emitted.push(event);
      },
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
      traceContext,
    });
    return executor.execute(
      { id: createToolCallId("deadline-call"), input: {}, name: entry.metadata.name },
      { traceContext },
    );
  }

  const statusEvent = (
    context: ToolExecutionContext,
    type: string,
    extra: Record<string, unknown> = {},
  ): SessionEvent =>
    ({
      id: `evt-${type}`,
      sessionId: context.sessionId,
      turnId: context.turnId,
      type: SessionEventType.ModelNetworkStatus,
      timestamp: new Date(),
      traceId: context.traceId,
      sequenceNumber: 0,
      payload: { type, toolCallId: context.toolCallId, ...extra },
    }) as unknown as SessionEvent;

  it("排队 120ms 的工具在 60ms 超时下仍成功：排队不计时，事件照常透传", async () => {
    const emitted: SessionEvent[] = [];
    const entry = slowEntry({
      name: "QueuedTool",
      timeoutMs: 60,
      run: async (context) => {
        await context.emitEvent!(statusEvent(context, "model_request_queued"));
        await sleep(120);
        await context.emitEvent!(statusEvent(context, "model_request_admitted", { queuedMs: 120 }));
        await sleep(20);
      },
    });
    const result = await run(entry, emitted);
    expect(result.success).toBe(true);
    expect(
      emitted.filter((event) => event.type === SessionEventType.ModelNetworkStatus),
    ).toHaveLength(2);
  });

  it("同样的 120ms 不排队（没有 queued 事件）→ 超时", async () => {
    const entry = slowEntry({
      name: "SlowTool",
      timeoutMs: 60,
      run: async () => {
        await sleep(120);
      },
    });
    const result = await run(entry);
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("timed out after 60ms");
  });

  it("别的工具调用的 queued 事件不暂停本调用的时钟", async () => {
    const entry = slowEntry({
      name: "OtherQueuedTool",
      timeoutMs: 60,
      run: async (context) => {
        await context.emitEvent!({
          ...statusEvent(context, "model_request_queued"),
          payload: { type: "model_request_queued", toolCallId: "someone-else" },
        } as SessionEvent);
        await sleep(120);
      },
    });
    const result = await run(entry);
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("timed out after 60ms");
  });
});

// 决策 48：执行器交给 handler 的 context.model 自带默认会话事件出口。调用点（如 WebFetch 处理）
// 不设 statusSink 也能让自己的排队被 deadline 与 driver 看见；调用点自己设了的保留。
describe("tool executor gives tool-side model calls a default status sink", () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /** 假模型：每次 generateText 走「排队 120ms → 放行 → 完成」，事件发到当前调用上下文的 statusSink。 */
  function queueingModel(): Model {
    const publish = async (event: Record<string, unknown>) => {
      const sink = getCurrentModelInvocationContext()?.statusSink;
      const metadata = getCurrentModelInvocationContext()?.metadata ?? {};
      await sink?.publish({
        toolCallId: metadata.toolCallId,
        ...event,
      } as unknown as ModelNetworkStatusEvent);
    };
    const model = {
      providerId: "fake",
      modelId: "fake-model",
      displayName: "fake",
      properties: {},
      optionSpecs: { maxOutputTokens: { max: 1000 } },
      options: {},
      bind: () => model,
      generateText: async () => {
        await publish({ type: "model_request_queued" });
        await sleep(120);
        await publish({ type: "model_request_admitted", queuedMs: 120 });
        await sleep(20);
        await publish({ type: "model_request_completed", durationMs: 20 });
        return { text: "ok", toolCalls: [], usage: {}, finishReason: "stop" };
      },
      streamText: () => {
        throw new Error("not used");
      },
    };
    return model as unknown as Model;
  }

  function fetchLikeEntry(input: {
    name: string;
    timeoutMs: number;
    statusSink?: ModelStatusSink;
  }): ToolEntry {
    return {
      capability: "test",
      metadata: {
        name: input.name,
        description: "test tool",
        readOnly: true,
        destructive: false,
        concurrentSafe: true,
        timeoutMs: input.timeoutMs,
        maxOutputBytes: 1000,
        sideEffectScope: "none",
        riskLevel: "low",
        needsApproval: false,
      },
      // 与 webfetch-processing.ts 同形：只设「为什么调」，不设 statusSink。
      handler: async (_input: unknown, context: ToolExecutionContext) => {
        const result = await runWithModelInvocationContext(
          {
            metadata: { querySource: "web_fetch_processing", toolCallId: context.toolCallId },
            ...(input.statusSink === undefined ? {} : { statusSink: input.statusSink }),
          },
          () => context.model!.generateText({ messages: [], tools: [], options: {} }),
        );
        return { ok: result.text === "ok" };
      },
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
    } as unknown as ToolEntry;
  }

  async function run(entry: ToolEntry, emitted: SessionEvent[]) {
    const sessionId = createSessionId("sink-exec");
    const turnId = createTurnId("sink-exec");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const registry = createToolRegistry();
    registry.register(entry);
    const executor = createToolExecutor({
      emitEvent: async (event) => {
        emitted.push(event);
      },
      model: queueingModel(),
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
      traceContext,
    });
    return executor.execute(
      { id: createToolCallId("sink-call"), input: {}, name: entry.metadata.name },
      { traceContext },
    );
  }

  it("调用点没设 statusSink：排队事件以本 toolCallId 进会话，60ms 超时的工具排队 120ms 仍成功", async () => {
    const emitted: SessionEvent[] = [];
    const result = await run(fetchLikeEntry({ name: "FetchLike", timeoutMs: 60 }), emitted);
    expect(result.success).toBe(true);
    const statuses = emitted.filter((event) => event.type === SessionEventType.ModelNetworkStatus);
    expect(statuses.map((event) => (event.payload as { type: string }).type)).toEqual([
      "model_request_queued",
      "model_request_admitted",
      "model_request_completed",
    ]);
    for (const event of statuses) {
      expect((event.payload as { toolCallId?: string }).toolCallId).toBe(
        createToolCallId("sink-call"),
      );
      expect(event.sessionId).toBe(createSessionId("sink-exec"));
    }
  });

  it("调用点自己设了 statusSink：默认出口不压过它，事件只到调用点的 sink", async () => {
    const emitted: SessionEvent[] = [];
    const own: ModelNetworkStatusEvent[] = [];
    const result = await run(
      fetchLikeEntry({
        name: "OwnSink",
        timeoutMs: 1000,
        statusSink: {
          publish: async (event) => {
            own.push(event);
          },
        },
      }),
      emitted,
    );
    expect(result.success).toBe(true);
    expect(own.map((event) => event.type)).toEqual([
      "model_request_queued",
      "model_request_admitted",
      "model_request_completed",
    ]);
    expect(emitted.filter((event) => event.type === SessionEventType.ModelNetworkStatus)).toEqual(
      [],
    );
  });
});
