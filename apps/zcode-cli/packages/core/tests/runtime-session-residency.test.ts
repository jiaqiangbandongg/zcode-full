import { describe, expect, it } from "vitest";
import { createSessionId, createTraceId, createTurnId, type TraceContext } from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { InMemoryRuntimeTaskRegistry, type RuntimeTaskType } from "../src/runtime-task/registry.js";
import { createTestSessionEventStore } from "./test-event-store.js";

function createRuntime(
  suffix: string,
  registry = new InMemoryRuntimeTaskRegistry(),
): { registry: InMemoryRuntimeTaskRegistry; runtime: AgentRuntime } {
  const sessionId = createSessionId(`runtime-residency-${suffix}`);
  return {
    registry,
    runtime: createTestAgentRuntime(
      sessionId,
      { workingDirectory: "/tmp/zcode-runtime-residency" },
      {
        eventStore: createTestSessionEventStore(),
        runtimeTaskRegistry: registry,
      },
    ),
  };
}

describe("AgentRuntime session residency facts", () => {
  it("idle runtime 没有 active/queued work 或 running background work", () => {
    const { runtime } = createRuntime("idle");

    expect(runtime.hasActiveOrQueuedTurnWork()).toBe(false);
    expect(runtime.hasRunningBackgroundTasks()).toBe(false);
    expect(runtime.hasResidencyBlockingWork()).toBe(false);
  });

  it("turn-start reservation 在真正 active turn 建立前也保护 runtime", () => {
    const { runtime } = createRuntime("reservation");
    const sessionId = createSessionId("runtime-residency-reservation");
    const turnId = createTurnId("runtime-residency-reservation-turn");
    const traceContext: TraceContext = {
      sessionId,
      traceId: createTraceId("runtime-residency-reservation-trace"),
    };
    const reservationRuntime = runtime as AgentRuntime & {
      releaseTurnStart(turnId: typeof turnId): void;
      reserveTurnStart(turnId: typeof turnId, traceContext: TraceContext, kind: "regular"): void;
    };

    reservationRuntime.reserveTurnStart(turnId, traceContext, "regular");
    expect(runtime.hasActiveOrQueuedTurnWork()).toBe(true);
    expect(runtime.hasResidencyBlockingWork()).toBe(true);

    reservationRuntime.releaseTurnStart(turnId);
    expect(runtime.hasActiveOrQueuedTurnWork()).toBe(false);
    expect(runtime.hasResidencyBlockingWork()).toBe(false);
  });

  it.each([
    ["background subagent", "local_agent"],
    ["background Bash", "local_bash"],
    ["background Workflow", "local_workflow"],
    ["background MCP monitor", "monitor_mcp"],
  ] as const)(
    "%s 的 running registry task 保护 runtime，终态后解除",
    (_label, taskType: RuntimeTaskType) => {
      const { registry, runtime } = createRuntime(taskType);
      registry.register({
        isBackgrounded: true,
        sessionId: createSessionId(`runtime-residency-${taskType}`),
        startedAt: new Date(1),
        status: "running",
        taskId: `background-${taskType}`,
        type: taskType,
      });

      expect(runtime.hasRunningBackgroundTasks()).toBe(true);
      expect(runtime.hasResidencyBlockingWork()).toBe(true);

      registry.update(`background-${taskType}`, (task) => ({
        ...task,
        completedAt: new Date(2),
        status: "completed",
      }));
      expect(runtime.hasRunningBackgroundTasks()).toBe(false);
      expect(runtime.hasResidencyBlockingWork()).toBe(false);
    },
  );

  // 不再经 cast：登记口在公开 AgentRuntime 面上（runtime 之外的 sidecar——dwf 引擎——也要用它，
  // 见 execution-engine.md「Engine ownership」规则一），这一行同时钉住那个暴露。
  it("detached sidecar 从同步登记到 promise finally 全程保护 runtime", async () => {
    const { runtime } = createRuntime("detached-sidecar");
    const sidecar = deferred<void>();

    const tracked = runtime.trackResidencyBlockingWork(sidecar.promise);
    expect(runtime.hasResidencyBlockingWork()).toBe(true);

    sidecar.resolve();
    await tracked;
    expect(runtime.hasResidencyBlockingWork()).toBe(false);
  });

  it("memory extraction 与 recall prefetch 的既有状态进入统一保护事实", () => {
    const { runtime } = createRuntime("memory-work");
    const internal = runtime as unknown as {
      memoryExtractionScheduler?: { hasPendingWork(): boolean };
      memoryRecallPrefetch?: { settled: boolean };
    };

    internal.memoryExtractionScheduler = { hasPendingWork: () => true };
    expect(runtime.hasResidencyBlockingWork()).toBe(true);
    internal.memoryExtractionScheduler = undefined;

    internal.memoryRecallPrefetch = { settled: false };
    expect(runtime.hasResidencyBlockingWork()).toBe(true);
    internal.memoryRecallPrefetch.settled = true;
    expect(runtime.hasResidencyBlockingWork()).toBe(false);
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}
