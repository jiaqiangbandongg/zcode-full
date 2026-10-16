// ============================================================
// 故障矩阵的格装配（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Verification」「每格断言」）
// ============================================================
// 一格 = 一台假 provider 服务器 + 一份脚本形状 + 一次完整的 dwf run：
//   真编译 → 沙箱子进程 → 引擎 → 真 driver（真 governor + 缩放时钟）→ 真 AgentRuntime ×
//   每子代理 → 真 AiSdkModelAdapter（极小退避）→ 真 fetch → 假服务器。
// 两级装配：
//   - `runFaultCell`：driver 级（`runDriverScript`），事件直接到手，重试行与 Stop 集行用它；
//   - `createFaultServiceHarness`：run service 级，走真实 submit / resume / cancel 路径，
//     生命周期行（翻转后 resume、stall、退避中取消）用它。
// 观察面统一收在 `FaultCellObservation`：settlement / RunEvent / ModelNetworkStatusEvent /
// actor 会话事件 / governor 快照 / journal / 结算时刻。`assertCommonInvariants` 是每格都断的
// 六条不变式；按行的有界计数由各矩阵文件自己写。

import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { createInMemorySessionEventStore } from "@zcode/adapters/storage";
import {
  createRootTraceContext,
  createSessionId,
  createToolCallId,
  createTurnId,
  type DynamicWorkflowRunProgressPayload,
  type DynamicWorkflowRunSnapshot,
  type ModelNetworkStatusEvent,
  type ModelStatusSink,
  type SessionEvent,
} from "@zcode/contracts";
import type { AgentRuntime } from "@zcode/core";
import {
  InMemoryJournalStore,
  type JournalStorePort,
  type NodeRecord,
  type RunEvent,
  type RunSettlement,
  type RunStopReason,
} from "@zcode/dynamic-workflow";
import {
  createDynamicWorkflowRunService,
  type DynamicWorkflowRunService,
} from "../../src/app/dynamic-workflow-run-service.js";
import { workflowActorToolPolicy } from "../../src/app/workflow-actor-tools.js";
import {
  createWorkflowConcurrencyGovernor,
  type WorkflowConcurrencyGovernor,
} from "../../src/app/workflow-concurrency-governor.js";
import { WORKFLOW_CONCURRENCY_AUTO_GROWTH_FACTOR } from "../../src/app/workflow-default-concurrency.js";
import type { AgentRuntimeWorkflowDriverDeps } from "../../src/app/workflow-driver-types.js";
import {
  fakeFileSystemPort,
  runDriverScript,
  unsupportedExecutionPort,
} from "../workflow-driver.helpers.js";
import type { FakeProviderServer, WireFormat } from "./fake-provider-server.js";
import { FAULT_MATRIX_SHAPES, type ScriptShape, type ShapeSpec } from "./fault-matrix-scripts.js";
import {
  FAULT_CONCURRENCY_KEY,
  FAULT_MODEL_SELECTION,
  createFaultModelFactory,
} from "./fault-provider-model.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";

/**
 * 缺省的 governor 默认并发 D：W16 的一半子代理起初会在闸门排队（spec「并行度轴」）。桶此后可以靠
 * 探测长到 2D（docs/dynamic-workflow/concurrency.md「The governor」）。
 */
export const FAULT_CELL_DEFAULT_CONCURRENCY = 8;
/** 缺省每子代理的空转轮数 K（与假服务器罐头模型的缺省一致；只用于算逻辑请求数）。 */
export const FAULT_CELL_TURNS = 3;
/** 缺省时钟缩放：driver 的 2s→60s 重驱曲线变成 20ms→600ms。 */
const FAULT_CELL_CLOCK_SCALE = 0.01;
/** 缺省 stall 窗（**真实**毫秒）；内部按缩放换算成 driver 时钟的虚拟毫秒。 */
export const FAULT_CELL_STALL_AFTER_MS = 400;
/** 缺省整 run 的墙钟上限（runWorkflowScript 的 timeoutMs）。 */
const FAULT_CELL_TIMEOUT_MS = 20_000;
/** 结算之后仍算"停下之前的尾巴"的到达宽限：回环网卡上在途请求的量级，远小于最短重试等待。 */
const STOP_WIRE_GRACE_MS = 10;

interface FaultCellOptions {
  server: FakeProviderServer;
  shape: ScriptShape;
  apiFormat: WireFormat;
  /** governor 默认并发，缺省 {@link FAULT_CELL_DEFAULT_CONCURRENCY}。 */
  defaultConcurrency?: number;
  /** stall 窗，**真实**毫秒，缺省 {@link FAULT_CELL_STALL_AFTER_MS}。 */
  stallAfterMs?: number;
  /** driver 时钟缩放，缺省 {@link FAULT_CELL_CLOCK_SCALE}。 */
  clockScale?: number;
  timeoutMs?: number;
  /** 每子代理空转轮数 K（信息性：只影响 `logicalRequests`），缺省 {@link FAULT_CELL_TURNS}。 */
  turns?: number;
}

export interface FaultCellObservation {
  runId: string;
  settlement: RunSettlement;
  events: RunEvent[];
  statusEvents: ModelNetworkStatusEvent[];
  /** 所有 actor runtime 的会话事件（流恢复标记等从这里找）。 */
  sessionEvents: SessionEvent[];
  governor: WorkflowConcurrencyGovernor;
  key: string;
  journal: InMemoryJournalStore;
  /** 观察到结算的时刻（Date.now()）。 */
  settledAt: number;
  shape: ShapeSpec;
  /** 逻辑请求数 = asks × (K + 1)；重试不计。 */
  logicalRequests: number;
}

/**
 * 缩放时钟：虚拟时间以 1/scale 的速度流逝，`schedule` 把虚拟延迟按 scale 换成真实延迟。
 * `now` 与 `schedule` 必须**同一套刻度**——stall 时钟用 `now()` 复核「距上次成功是否已过
 * afterMs」，只缩 schedule 不缩 now 会让它按剩余量无限重排。`stallAfterMs` 因此是虚拟毫秒。
 */
function makeScaledClock(input: {
  scale: number;
  /** 虚拟毫秒。 */
  stallAfterMs: number;
}): NonNullable<AgentRuntimeWorkflowDriverDeps["clock"]> {
  const { scale } = input;
  return {
    now: () => Date.now() / scale,
    schedule: (callback, delayMs) => {
      const timer = setTimeout(callback, Math.max(1, Math.round(delayMs * scale)));
      return () => clearTimeout(timer);
    },
    // 重驱抖动去随机（transientBackoffMs 的 random 入口）。
    random: () => 0.5,
    stallAfterMs: input.stallAfterMs,
  };
}

/** 数某一类 ModelNetworkStatusEvent。 */
export function statusCount(events: readonly ModelNetworkStatusEvent[], type: string): number {
  return events.filter((event) => event.type === type).length;
}

/** 按类型筛 RunEvent（带类型收窄）。 */
export function eventsOfType<T extends RunEvent["type"]>(
  events: readonly RunEvent[],
  type: T,
): Extract<RunEvent, { type: T }>[] {
  return events.filter((event): event is Extract<RunEvent, { type: T }> => event.type === type);
}

interface CellWiring {
  statusEvents: ModelNetworkStatusEvent[];
  sessionEvents: SessionEvent[];
  governor: WorkflowConcurrencyGovernor;
  clock: NonNullable<AgentRuntimeWorkflowDriverDeps["clock"]>;
  model: ReturnType<typeof createFaultModelFactory>;
  fileSystemPort: ReturnType<typeof fakeFileSystemPort>;
  scale: number;
}

function wireCell(options: Omit<FaultCellOptions, "shape">): CellWiring {
  const statusEvents: ModelNetworkStatusEvent[] = [];
  const sessionEvents: SessionEvent[] = [];
  const statusSink: ModelStatusSink = {
    publish: (event) => {
      statusEvents.push(event);
    },
  };
  const scale = options.clockScale ?? FAULT_CELL_CLOCK_SCALE;
  return {
    statusEvents,
    sessionEvents,
    governor: createWorkflowConcurrencyGovernor({
      defaultConcurrency: options.defaultConcurrency ?? FAULT_CELL_DEFAULT_CONCURRENCY,
    }),
    clock: makeScaledClock({
      scale,
      stallAfterMs: (options.stallAfterMs ?? FAULT_CELL_STALL_AFTER_MS) / scale,
    }),
    model: createFaultModelFactory({
      apiFormat: options.apiFormat,
      baseURL: options.server.baseURL,
      statusSink,
    }),
    fileSystemPort: fakeFileSystemPort({}),
    scale,
  };
}

/** 造一个 actor runtime：真 model factory + 请求级准入端口 + 会话事件收集。 */
function makeActorRuntime(
  wiring: CellWiring,
  input: {
    sessionId: Parameters<typeof createTestAgentRuntime>[0];
    persona: { system?: string; tools?: "default" | "readonly" | "none" };
    submitPort: unknown;
    escalatePort: unknown;
    modelRequestAdmission?: unknown;
  },
): AgentRuntime {
  return createTestAgentRuntime(
    input.sessionId,
    {
      systemPrompt: input.persona.system ?? "You are a workflow actor.",
      mode: "yolo",
      taskType: "workflow_child",
      subagents: { enabled: false },
      modelSelection: FAULT_MODEL_SELECTION,
      // 生产的 runtime 缺省流式（zcode-protocol/workspace-model-runtime.ts 的 `?? "on"`）；不开的话 turn 走
      // generateText，B7/B8 的「流中切断」在服务器侧退化成连接重置，测不到决策 25 那条边。
      modelStreaming: "on",
      ...workflowActorToolPolicy(input.persona as never),
    },
    {
      eventStore: createInMemorySessionEventStore(),
      eventSink: {
        onSessionEvent: (event) => {
          wiring.sessionEvents.push(event);
        },
      },
      modelFactory: wiring.model.modelFactory,
      workflowSubmitPort: input.submitPort as never,
      workflowEscalatePort: input.escalatePort as never,
      ...(input.modelRequestAdmission === undefined
        ? {}
        : { modelRequestAdmission: input.modelRequestAdmission as never }),
      fileSystemPort: wiring.fileSystemPort,
    },
  );
}

/** driver 级：跑一格，回全部观察面。 */
export async function runFaultCell(options: FaultCellOptions): Promise<FaultCellObservation> {
  const shape = FAULT_MATRIX_SHAPES[options.shape];
  const wiring = wireCell(options);
  const runId = `fault-${options.shape.toLowerCase()}-${randomUUID().slice(0, 8)}`;
  try {
    const result = await runDriverScript(shape.script, {
      actorScripts: {},
      caps: { maxConcurrency: 16 },
      clock: wiring.clock,
      concurrency: wiring.governor,
      runId,
      runtimeFactory: ({ sessionId, persona, submitPort, escalatePort, modelRequestAdmission }) =>
        makeActorRuntime(wiring, {
          sessionId,
          persona,
          submitPort,
          escalatePort,
          modelRequestAdmission,
        }),
      timeoutMs: options.timeoutMs ?? FAULT_CELL_TIMEOUT_MS,
    });
    const settledAt = Date.now();
    return {
      runId,
      settlement: result.settlement,
      events: result.events,
      statusEvents: wiring.statusEvents,
      sessionEvents: wiring.sessionEvents,
      governor: wiring.governor,
      key: FAULT_CONCURRENCY_KEY,
      journal: result.journal,
      settledAt,
      shape,
      logicalRequests: shape.asks * ((options.turns ?? FAULT_CELL_TURNS) + 1),
    };
  } finally {
    wiring.model.dispose();
  }
}

// ————————————————————————————————————————————————————————————————
// run service 级装配
// ————————————————————————————————————————————————————————————————

export interface FaultServiceHarness {
  service: DynamicWorkflowRunService;
  /** 具体类型（不是窄端口）：B18 要把它原样交给第二台 harness 复用。 */
  journal: InMemoryJournalStore;
  runEvents: DynamicWorkflowRunProgressPayload[];
  statusEvents: ModelNetworkStatusEvent[];
  sessionEvents: SessionEvent[];
  governor: WorkflowConcurrencyGovernor;
  key: string;
  cwd: string;
  parentSessionId: string;
  /** 提交一份形状，回 runId（提交被拒即抛）。 */
  submit(shape: ScriptShape): Promise<string>;
  /** 等 run 结算，回快照。 */
  settle(runId: string): Promise<DynamicWorkflowRunSnapshot | undefined>;
  /** 观察到该 run `run-settled` 进度事件的时刻；没结算过即 undefined。 */
  settledAt(runId: string): number | undefined;
  /** 该 run 的 RunEvent 视图（从进度载荷还原 `{ type, ...payload }`）。 */
  eventsOf(runId: string): RunEvent[];
  dispose(): Promise<void>;
}

/** run service 级装配的额外入参。 */
interface FaultServiceHarnessOptions extends Omit<FaultCellOptions, "shape"> {
  /**
   * 复用一份既有 journal（B18：第一台 harness 被 close 停下之后，第二台在**同一份 journal**
   * 上 resume——这正是「下一次激活」的形态）。缺省每台 harness 各起一份内存 journal。
   */
  journal?: InMemoryJournalStore;
}

/** 真 run service：submit / resume / cancel 全走产品路径；actor runtime 与 driver 级同构。 */
export function createFaultServiceHarness(
  options: FaultServiceHarnessOptions,
): FaultServiceHarness {
  const wiring = wireCell(options);
  const journal = options.journal ?? new InMemoryJournalStore();
  const runEvents: DynamicWorkflowRunProgressPayload[] = [];
  const settledAtByRun = new Map<string, number>();
  const parentSessionId = `fault-parent-${randomUUID().slice(0, 8)}`;
  const cwd = mkdtempSync(join(tmpdir(), "dwf-fault-matrix-"));
  let submitted = 0;

  const service = createDynamicWorkflowRunService({
    concurrency: wiring.governor,
    createActorRuntime: (input) => {
      const runtime = makeActorRuntime(wiring, {
        sessionId: input.sessionId,
        persona: input.persona,
        submitPort: input.submitPort,
        escalatePort: input.escalatePort,
        modelRequestAdmission: input.modelRequestAdmission,
      });
      // 装配里没有 session store，真实的 resumeFromStore 必抛配置错误。resume 路径上
      // 已完结 ask 从 journal 回放、未完结 ask 在**全新**子代理会话里重问（terminal-states
      // 决策 13），转录水化在这里没有语义，只钉「重挂成功」这一条。
      runtime.resumeFromStore = async () => ({ resumed: true }) as never;
      return runtime;
    },
    driverClock: wiring.clock,
    executionPort: unsupportedExecutionPort(),
    fileSystemPort: wiring.fileSystemPort,
    journal,
    onRunEvent: (progress) => {
      runEvents.push(progress);
      if (progress.eventType === "run-settled" && !settledAtByRun.has(progress.runId)) {
        settledAtByRun.set(progress.runId, Date.now());
      }
    },
    parentSessionId,
  });

  return {
    service,
    journal,
    runEvents,
    statusEvents: wiring.statusEvents,
    sessionEvents: wiring.sessionEvents,
    governor: wiring.governor,
    key: FAULT_CONCURRENCY_KEY,
    cwd,
    parentSessionId,
    async submit(shape) {
      submitted += 1;
      const name = `fault-${shape.toLowerCase()}-${submitted}`;
      const sessionId = createSessionId(parentSessionId);
      const result = await service.submit({
        cwd,
        parentSessionId,
        scriptText: FAULT_MATRIX_SHAPES[shape].script,
        toolCallId: createToolCallId(`${name}-call`),
        trace: createRootTraceContext({ sessionId, turnId: createTurnId(name) }),
      });
      if (!result.ok) throw new Error(`fault matrix submit refused: ${result.reason}`);
      return result.runId;
    },
    settle(runId) {
      return service.waitForTask(runId);
    },
    settledAt(runId) {
      return settledAtByRun.get(runId);
    },
    eventsOf(runId) {
      return runEvents
        .filter((progress) => progress.runId === runId)
        .map((progress) => ({ type: progress.eventType, ...progress.payload }) as RunEvent);
    },
    async dispose() {
      wiring.model.dispose();
    },
  };
}

// ————————————————————————————————————————————————————————————————
// 公共不变式
// ————————————————————————————————————————————————————————————————

interface CommonInvariantExpectation {
  status: "completed" | "stopped" | "errored";
  stopReason?: RunStopReason;
  server: FakeProviderServer;
  /** governor 默认并发，缺省 {@link FAULT_CELL_DEFAULT_CONCURRENCY}。 */
  defaultConcurrency?: number;
  /** 罐头模型的提交载荷（completed 格逐节点比对）；缺省 `{ note: "done" }`。 */
  submitPayload?: unknown;
}

/** 该 run 的 ask 节点行。 */
export function askNodes(journal: JournalStorePort, runId: string): NodeRecord[] {
  return journal
    .listNodes(runId, { kinds: "all", withResult: true })
    .filter((node) => node.siteId.startsWith("ask#"));
}

/**
 * 每格都断的六条（spec「每格断言」1–6）：
 *   1 终态如所述；2 不丢子代理；3 脚本从未看见模型错误；4 事件语法；5 停下后零请求；6 在飞上界。
 */
export function assertCommonInvariants(
  observation: Pick<
    FaultCellObservation,
    "runId" | "settlement" | "events" | "statusEvents" | "settledAt"
  > & { journal: JournalStorePort },
  expectation: CommonInvariantExpectation,
): void {
  const { runId, settlement, events, statusEvents, journal, settledAt } = observation;
  const { server } = expectation;

  // 1 终态
  expect(settlement.status).toBe(expectation.status);
  if (expectation.stopReason !== undefined) {
    expect(settlement.status === "stopped" ? settlement.reason : undefined).toBe(
      expectation.stopReason,
    );
  }
  expect(journal.getRun(runId)?.status).toBe(expectation.status);

  // 2 不丢子代理
  const nodes = askNodes(journal, runId);
  expect(nodes.length).toBeGreaterThan(0);
  if (expectation.status === "completed") {
    for (const node of nodes) {
      expect(node.status, `ask node ${node.siteId}@${node.ordinal}`).toBe("completed");
      expect(node.result).toEqual(expectation.submitPayload ?? { note: "done" });
    }
  } else {
    // 停下时在飞节点不落 journal（scheduler.abortInFlight 只发 node-settled(cancelled)），
    // 所以行状态只能是 completed（已完结）或 running（被中止）；绝不能有 failed。
    for (const node of nodes) {
      expect(["completed", "running"], `ask node ${node.siteId}@${node.ordinal}`).toContain(
        node.status,
      );
    }
  }

  // 3 脚本从未看见模型错误：没有 failed 的节点结算，也没有 DriverError 落进 journal。
  const failedSettlements = eventsOfType(events, "node-settled").filter(
    (event) => event.outcome === "failed",
  );
  expect(failedSettlements).toEqual([]);
  const run = journal.getRun(runId);
  expect(run?.failure?.code).not.toBe("DriverError");

  // 4 事件语法：每条可重试失败后同一 requestId 上有 retry_scheduled；不可重试失败只允许
  // 出现在 stopped(provider) 的格里。
  const failed = statusEvents.filter(
    (event): event is Extract<ModelNetworkStatusEvent, { type: "model_request_failed" }> =>
      event.type === "model_request_failed",
  );
  const scheduledByRequest = new Map<string, number>();
  for (const event of statusEvents) {
    if (event.type !== "model_retry_scheduled") continue;
    scheduledByRequest.set(event.requestId, (scheduledByRequest.get(event.requestId) ?? 0) + 1);
  }
  const retryableFailed = failed.filter((event) => event.retryable);
  for (const event of retryableFailed) {
    expect(
      scheduledByRequest.get(event.requestId) ?? 0,
      `retryable failure ${event.requestId} (${event.reason}) has a retry_scheduled`,
    ).toBeGreaterThan(0);
  }
  // 可见输出之后的流失败是 runner 层的「不重放」（adaptive-concurrency 决策 25）：它以
  // `retryable:false` + `streamOutputCommitted:true` 报出，接力的是 core 的流恢复而不是
  // runner 的重试，所以不算终止型失败——B8 两行专门断它。
  // 兄弟被 abort 时 runner 报 `reason:"cancelled"` 的 failed——那是取消的回声，不是 provider
  // 的终止型失败，任何停下的格里都会有。
  const terminalFailed = failed.filter(
    (event) =>
      !event.retryable && event.streamOutputCommitted !== true && event.reason !== "cancelled",
  );
  if (!(expectation.status === "stopped" && expectation.stopReason === "provider")) {
    expect(terminalFailed).toEqual([]);
  }

  // 5 停下后零请求。引擎 stop() 先 abort 在飞节点再结算，但假服务器与客户端共用一个事件循环：
  // 一个在 abort 之前就已写到回环网卡上的请求，要等结算那一串同步工作（journal、通知、兄弟
  // abort）做完才轮到服务器的 handler 给它盖"到达"戳——负载重时能晚十几毫秒。那不是停下之后
  // 的新工作，是停下之前的尾巴，runner 那边会把它报成 `reason:"cancelled"`。所以：宽限之外的
  // 晚到请求，每一条都必须对得上一条 cancelled 回声；一个没被撤掉的退避定时器发出的请求不会
  // 被 runner 报成 cancelled，照样抓得到。
  const late = server.requests.filter((entry) => entry.at > settledAt + STOP_WIRE_GRACE_MS);
  const cancelledEchoes = failed.filter((event) => event.reason === "cancelled").length;
  expect(
    late.length,
    `requests arriving after run-settled (${late.length}) must all be cancel echoes (${cancelledEchoes})`,
  ).toBeLessThanOrEqual(cancelledEchoes);

  // 6 在飞上界：治理器的增长上限。格子里的 run 跑在默认上界上、不抬它，所以就是 2D。
  expect(server.inFlightPeak).toBeLessThanOrEqual(
    WORKFLOW_CONCURRENCY_AUTO_GROWTH_FACTOR *
      (expectation.defaultConcurrency ?? FAULT_CELL_DEFAULT_CONCURRENCY),
  );
}

/** 等一小段真实时间（结算之后复查「零请求」用）。 */
export function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
