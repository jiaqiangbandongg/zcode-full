/**
 * driver × 座位闸门 × 真治理器（docs/dynamic-workflow/concurrency.md「Retuning a live run」）：
 * 上界从 4 压到 1 之后，工作中的子代理在**下一个 turn step** 上停驻，而手上有工具在跑的那个
 * 子代理的工具侧请求照常发得出去；抬高按 FIFO 放行；停驻期间取消 ask 会连同座位等待一起拒绝，
 * 并且不腾出任何座位。
 *
 * ask 的起止走的是**生产那两条**：起点是 `driver.startAsk`，终点是引擎经 `driver.emit` 记下的
 * `node-settled`——测试直接调 emit 来扮演引擎的 record()。
 */

import { describe, expect, it } from "vitest";
import {
  SessionEventType,
  type ModelRequestAdmission,
  type SessionEvent,
  type SessionEventSink,
} from "@zcode/contracts";
import {
  InMemoryJournalStore,
  type ActorRef,
  type InstanceRef,
  type RunEvent,
  type WorkflowReportSink,
} from "@zcode/dynamic-workflow";
import { createWorkflowEscalationRegistry } from "../src/app/workflow-escalation-registry.js";
import { createJournalSequenceCapture } from "../src/app/dynamic-workflow-run-sequence-capture.js";
import { createAgentRuntimeWorkflowDriver } from "../src/app/workflow-driver.js";
import { createWorkflowConcurrencyGovernor } from "../src/app/workflow-concurrency-governor.js";
import { createWorkflowRunControl } from "../src/app/workflow-run-control.js";
import { createWorkflowRunSeatGate } from "../src/app/workflow-seat-gate.js";
import { fakeFileSystemPort, unsupportedExecutionPort } from "./workflow-driver.helpers.js";

const RUN = "run-seat";
const MODEL = { providerId: "prov", modelId: "alpha" } as never;
const actorOf = (ordinal: number): ActorRef => ({ siteId: "actor#1", ordinal });
const instanceOf = (ordinal: number): InstanceRef => ({ siteId: "ask#1", ordinal });

const flush = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
};

/** 最小 actor runtime：捕获 turn 的 abortSignal（cancelAsk 要经它到达座位等待），可发工具事件。 */
function stubRuntime() {
  const sinks = new Set<SessionEventSink>();
  let sessionId = "";
  let abortSignal: AbortSignal | undefined;
  const emit = (type: string, toolCallId: string): void => {
    const event = {
      id: `evt-${toolCallId}`,
      sessionId,
      type,
      timestamp: new Date(),
      traceId: "trace",
      sequenceNumber: 1,
      payload: { toolCallId, toolName: "WebSearch", startedAt: new Date() },
    } as unknown as SessionEvent;
    for (const sink of sinks) void sink.onSessionEvent(event);
  };
  return {
    executeTurn: (_input: string, _history: unknown, options?: { abortSignal?: AbortSignal }) => {
      abortSignal = options?.abortSignal;
      return new Promise<never>(() => {});
    },
    subscribeEvents(sink: SessionEventSink) {
      sinks.add(sink);
      return () => sinks.delete(sink);
    },
    getModelRef: () => MODEL,
    closeBrowserSession: async () => {},
    signal: (): AbortSignal | undefined => abortSignal,
    toolStarted: (toolCallId: string) => emit(SessionEventType.ToolCallStarted, toolCallId),
    toolFinished: (toolCallId: string) => emit(SessionEventType.ToolCallResult, toolCallId),
    bind: (id: string) => {
      sessionId = id;
    },
  };
}

const silentSink: WorkflowReportSink = {
  askSubmitAttempted: () => {},
  askTurnEnded: () => {},
  askProgress: () => {},
  askStats: () => {},
  askFailed: () => {},
  askWaiting: () => {},
  askExecuting: () => {},
  askMutating: () => {},
  concurrencyChanged: () => {},
  stopRun: () => {},
  runStalled: () => {},
};

/** 装配一个带闸门与真治理器的 driver，并起 `count` 个各自在飞一个 ask 的子代理。 */
async function startRun(count: number, limit: number) {
  const journal = new InMemoryJournalStore();
  journal.createRun({ runId: RUN, caps: { maxConcurrency: limit }, spentTokens: 0, status: "running" });
  const seatGate = createWorkflowRunSeatGate({ limit });
  const control = createWorkflowRunControl();
  control.bindSeatGate(seatGate);
  // 引擎的替身：只回答「这次真的改了」——真引擎的 caps / journal / 事件那半边由
  // dynamic-workflow 侧的 engine-retune-concurrency 测试钉住。
  const engineCalls: number[] = [];
  control.bind({
    setMaxConcurrency: (next) => {
      engineCalls.push(next);
      return true;
    },
  });

  const runtimes = Array.from({ length: count }, () => stubRuntime());
  const admissions: ModelRequestAdmission[] = [];
  const emitted: RunEvent[] = [];
  const emittedSequences: (number | undefined)[] = [];
  // 与生产 launch 逐字同构：driver 拿到的是**被截获的** journal，emit 钩子按事件对象的引用
  // 反查刚分配到的 sequence（dynamic-workflow-run-launch.ts）。座位闸门那层包装如果换了对象，
  // 这里立刻就能看出来。
  const sequenceCapture = createJournalSequenceCapture(journal);
  let index = 0;
  const driver = createAgentRuntimeWorkflowDriver({
    journal: sequenceCapture.journal,
    emit: (event) => {
      emitted.push(event);
      emittedSequences.push(sequenceCapture.sequenceOf(event));
    },
    escalationRegistry: createWorkflowEscalationRegistry(),
    executionPort: unsupportedExecutionPort(),
    fileSystemPort: fakeFileSystemPort({}),
    cwd: process.cwd(),
    runId: RUN,
    concurrency: createWorkflowConcurrencyGovernor({ defaultConcurrency: 16 }),
    seatGate,
    runtimeFactory: ({ sessionId, modelRequestAdmission }) => {
      const runtime = runtimes[index++]!;
      runtime.bind(sessionId);
      admissions.push(modelRequestAdmission!);
      return runtime as never;
    },
  })(silentSink);

  for (let ordinal = 1; ordinal <= count; ordinal++) {
    const session = await driver.createActorSession(actorOf(ordinal), {});
    driver.startAsk(session, instanceOf(ordinal), { instructions: "go", typed: false });
  }
  await flush();
  return {
    admissions,
    control,
    driver,
    emitted,
    emittedSequences,
    engineCalls,
    journal,
    runtimes,
    seatGate,
  };
}

describe("driver 侧座位闸门", () => {
  it("压低 4→1：后来的 turn step 逐个停驻，工具在跑的那个子代理照常发请求", async () => {
    const run = await startRun(4, 4);
    expect(run.seatGate.stats()).toEqual({ limit: 4, working: 4, parked: 0 });

    // 一个子代理手上有两个并行工具调用；上界压低的那一刻它正在工具里。
    run.runtimes[0]!.toolStarted("tc-a");
    run.runtimes[0]!.toolStarted("tc-b");
    expect(run.control.setMaxConcurrency(1)).toBe(true);
    expect(run.engineCalls).toEqual([1]);
    expect(run.seatGate.stats().limit).toBe(1);

    // 工具侧请求：快路径命中、不停驻——它的主人本就在工作、本就占着座位。
    expect(run.admissions[0]!.tryAcquire?.({ model: MODEL })).toBeDefined();
    await run.admissions[0]!.acquire({ model: MODEL });
    expect(run.seatGate.stats()).toEqual({ limit: 1, working: 4, parked: 0 });

    // 其余三个的下一个 turn step：快路径未命中（runner 因此发 queued → waiting(slot)），随后停驻。
    const parked = run.admissions.slice(1).map((admission, offset) => {
      expect(admission.tryAcquire?.({ model: MODEL })).toBeUndefined();
      return admission.acquire({
        model: MODEL,
        signal: run.runtimes[offset + 1]!.signal()!,
      });
    });
    await flush();
    expect(run.seatGate.stats()).toEqual({ limit: 1, working: 1, parked: 3 });
    expect(parked).toHaveLength(3);

    // 工具跑完之后，同一个子代理的下一个请求就是 turn step 了——但它是此刻唯一在工作的那个，
    // 上界之内，所以照常通过（上界 1 永远留得下一个在跑的人）。
    run.runtimes[0]!.toolFinished("tc-a");
    run.runtimes[0]!.toolFinished("tc-b");
    expect(run.admissions[0]!.tryAcquire?.({ model: MODEL })).toBeDefined();
    expect(run.seatGate.stats()).toEqual({ limit: 1, working: 1, parked: 3 });
  });

  it("引擎记下的 node-settled 腾出座位并按 FIFO 放行一位；事件原样转交给 emit 钩子", async () => {
    const run = await startRun(3, 3);
    run.control.setMaxConcurrency(1);
    const granted: number[] = [];
    run.admissions.slice(0, 2).forEach((admission, offset) => {
      void admission.acquire({ model: MODEL }).then(() => granted.push(offset + 1));
    });
    await flush();
    expect(run.seatGate.stats()).toEqual({ limit: 1, working: 1, parked: 2 });

    // 扮演引擎的 record()：先 appendEvent、紧接着 emit **同一个对象**（engine.ts 的顺序）。
    const settled: RunEvent = { type: "node-settled", instance: instanceOf(3), outcome: "ok" };
    const stored = run.journal.appendEvent(RUN, settled);
    run.driver.emit(settled);
    await flush();
    // 闸门那层包装必须原样往下递：sequence 截取按**引用相等**核对，换了对象就反查不到。
    expect(run.emitted.at(-1)).toBe(settled);
    expect(run.emittedSequences.at(-1)).toBe(stored.sequence);
    expect(granted).toEqual([1]);
    expect(run.seatGate.stats()).toEqual({ limit: 1, working: 1, parked: 1 });
  });

  it("闸门没见过开始的 node-settled（命中缓存、world 节点）是严格无操作", async () => {
    const run = await startRun(2, 2);
    run.control.setMaxConcurrency(1);
    const granted: number[] = [];
    void run.admissions[0]!.acquire({ model: MODEL }).then(() => granted.push(1));
    await flush();
    expect(run.seatGate.stats()).toEqual({ limit: 1, working: 1, parked: 1 });

    // 命中导入缓存的 ask 只发一条 `node-settled { cached: true }`，从不经 startAsk；
    // world-read / world.run 节点住在另一套站点上，同样从不经 startAsk。
    run.driver.emit({
      type: "node-settled",
      instance: { siteId: "ask#1", ordinal: 42 },
      outcome: "ok",
      cached: true,
    });
    run.driver.emit({ type: "node-settled", instance: { siteId: "world#1", ordinal: 1 }, outcome: "ok" });
    await flush();
    expect(granted).toEqual([]);
    expect(run.seatGate.stats()).toEqual({ limit: 1, working: 1, parked: 1 });
  });

  it("抬高上界按 FIFO 放行", async () => {
    const run = await startRun(4, 4);
    run.control.setMaxConcurrency(1);
    const granted: number[] = [];
    run.admissions.slice(1).forEach((admission, offset) => {
      void admission.acquire({ model: MODEL }).then(() => granted.push(offset + 2));
    });
    await flush();
    expect(run.seatGate.stats()).toEqual({ limit: 1, working: 1, parked: 3 });

    expect(run.control.setMaxConcurrency(3)).toBe(true);
    await flush();
    expect(granted).toEqual([2, 3]);
    expect(run.seatGate.stats()).toEqual({ limit: 3, working: 3, parked: 1 });
  });

  it("停驻期间取消这个 ask：座位等待随 turn 的 abort 一起拒绝，且不腾座位", async () => {
    const run = await startRun(2, 2);
    run.control.setMaxConcurrency(1);
    const waiting = run.admissions[1]!.acquire({
      model: MODEL,
      signal: run.runtimes[1]!.signal()!,
    });
    await flush();
    expect(run.seatGate.stats()).toEqual({ limit: 1, working: 1, parked: 1 });

    // 引擎取消 ask：abortInFlight 先调 cancelAsk（abort）、再记 node-settled，这里同序。
    run.driver.cancelAsk(instanceOf(2));
    await expect(waiting).rejects.toThrow(/cancelled/);
    run.driver.emit({ type: "node-settled", instance: instanceOf(2), outcome: "cancelled" });
    await flush();
    // 被取消的那位停驻时就已经不占座位，这里绝不能再腾一次。
    expect(run.seatGate.stats()).toEqual({ limit: 1, working: 1, parked: 0 });
  });

  it("从未被压低过的 run：闸门全程不介入，快路径逐次命中", async () => {
    const run = await startRun(3, 3);
    for (const admission of run.admissions) {
      expect(admission.tryAcquire?.({ model: MODEL })).toBeDefined();
      await admission.acquire({ model: MODEL });
    }
    expect(run.seatGate.stats()).toEqual({ limit: 3, working: 3, parked: 0 });
  });
});
