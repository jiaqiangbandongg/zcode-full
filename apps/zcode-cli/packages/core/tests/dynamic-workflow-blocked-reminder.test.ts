// ============================================================
// 「run 还欠着决定、主代理闲着」的提醒：文案、载荷与 runtime 接线
// （docs/dynamic-workflow/transcript-and-notifications.md「Reminding an idle main agent」）
// ============================================================
// 钟的规则在 workflow-blocked-reminder-clock.test.ts；这里钉另外三件事：
//   1. 模型读到的 `<workflow-blocked>` 文本（逐字的下一步、两次的收尾句、截断诚实）；
//   2. runtime 宿主：从任务注册表取在飞的 run、从端口快照取开集、铸 `workflowBlocked` 载荷并走既有的后台通知入口；
//   3. 四个接线点：队列排空 = 空闲沿、命令开始 = 忙、用户 prompt / steer = 新的一对、开集事件 = 该 run 新的一对。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSessionId,
  type BackgroundResultOriginMeta,
  type DynamicWorkflowRunPort,
  type DynamicWorkflowRunSnapshot,
} from "@zcode/contracts";
import { AgentRuntime } from "../src/index.js";
import { createRuntimeCommandQueue } from "../src/runtime/command-queue.js";
import type { RuntimeCommand, RuntimeCommandId } from "../src/runtime/command-queue.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { drainRuntimeCommandQueue } from "../src/runtime/methods/runtime-command-queue.js";
import { steerTurn } from "../src/runtime/methods/steering.js";
import { InMemoryRuntimeTaskRegistry } from "../src/runtime-task/registry.js";
import {
  WORKFLOW_BLOCKED_REMINDER_DELAYS_MS,
  WorkflowBlockedReminderClock,
} from "../src/runtime-task/workflow-blocked-reminder.js";
import { formatWorkflowBlockedNotification } from "../src/runtime-task/workflow-notification-copy.js";
import { createTestSessionEventStore } from "./test-event-store.js";

const MIN = 60_000;
const [FIRST, SECOND] = WORKFLOW_BLOCKED_REMINDER_DELAYS_MS;

describe("formatWorkflowBlockedNotification", () => {
  const base = {
    runLabel: "nightly audit",
    runId: "dwfrun-1",
    now: 20 * MIN,
    questions: [
      {
        qid: "dwfq-aaaa-1",
        actor: "actor#1@2",
        actorName: "reviewer",
        question: "通过线是 96 还是 95？",
        context: "已经试了 6 轮。",
        askedAt: 3 * MIN,
      },
    ],
    holes: [
      {
        siteId: "hole#21b40fca",
        ordinal: 1,
        name: "修复方案",
        type: "Plan",
        state: "waiting" as const,
        since: 5 * MIN,
        line: 42,
      },
    ],
    draftPath: "/Users/dev/proj/.zcode/workflow-drafts/audit.dwf.ts",
  };

  it("第 1 次：块里是 run、次数与每个开着的决定；散文给逐字的下一步，并说还有一次", () => {
    const text = formatWorkflowBlockedNotification({ ...base, ordinal: 1, total: 2 });
    expect(text).toContain("[SYSTEM NOTIFICATION - NOT USER INPUT]");
    expect(text).toContain("<workflow-blocked>");
    expect(text).toContain("<run-id>dwfrun-1</run-id>");
    expect(text).toContain("<run>nightly audit</run>");
    expect(text).toContain("<reminder>1 of 2</reminder>");
    expect(text).toContain('<open-questions count="1" shown="1">');
    expect(text).toContain('<question id="dwfq-aaaa-1" subagent="reviewer" waited-ms="1020000">');
    expect(text).toContain("<text>通过线是 96 还是 95？</text>");
    expect(text).toContain("<context>已经试了 6 轮。</context>");
    expect(text).toContain('<open-holes count="1" shown="1">');
    expect(text).toContain(
      '<hole id="hole#21b40fca" name="修复方案" type="Plan" line="42" waited-ms="900000"/>',
    );
    expect(text).toContain("<draft>/Users/dev/proj/.zcode/workflow-drafts/audit.dwf.ts</draft>");
    // 最久的那个决定等了 17 分钟。
    expect(text).toContain(
      "Workflow run nightly audit (dwfrun-1) is still waiting on you: 1 question and 1 hole are open, the oldest for 17 minutes, and you have not acted on them since your last turn ended.",
    );
    expect(text).toContain(
      "call ResolveWorkflowQuestion with its id as question_id and your answer",
    );
    expect(text).toContain('call FillWorkflowHole with run_id="dwfrun-1" and its id as hole_id');
    expect(text).toContain("read the draft at /Users/dev/proj/.zcode/workflow-drafts/audit.dwf.ts");
    expect(text).toContain(
      "If a decision needs the user, tell the user exactly what you need from them and end your turn; do not guess an answer to make the reminders stop.",
    );
    expect(text).toContain("One more reminder follows if nothing changes.");
    expect(text).toContain("nothing times out on their behalf");
  });

  it("第 2 次：说这是最后一次，以及什么会重新开始", () => {
    const text = formatWorkflowBlockedNotification({ ...base, ordinal: 2, total: 2 });
    expect(text).toContain("<reminder>2 of 2</reminder>");
    expect(text).toContain(
      "This is the last reminder: nothing further is sent until the user writes or this run's open decisions change.",
    );
    expect(text).not.toContain("One more reminder follows");
  });

  it("只有问题 / 只有留白：另一节整节缺席，下一步也只说在场的那一种", () => {
    const onlyQuestions = formatWorkflowBlockedNotification({
      ...base,
      holes: [],
      ordinal: 1,
      total: 2,
    });
    expect(onlyQuestions).not.toContain("<open-holes");
    expect(onlyQuestions).not.toContain("FillWorkflowHole");
    expect(onlyQuestions).toContain("1 question is open, for 17 minutes");

    const onlyHoles = formatWorkflowBlockedNotification({
      ...base,
      questions: [],
      ordinal: 1,
      total: 2,
    });
    expect(onlyHoles).not.toContain("<open-questions");
    expect(onlyHoles).not.toContain("ResolveWorkflowQuestion");
    expect(onlyHoles).toContain("1 hole is open, for 15 minutes");
  });

  it("没有草稿路径：让模型用 GetWorkflowRun 取留白的上下文", () => {
    const text = formatWorkflowBlockedNotification({
      ...base,
      draftPath: undefined,
      ordinal: 1,
      total: 2,
    });
    expect(text).not.toContain("<draft>");
    expect(text).toContain('read the run\'s script with GetWorkflowRun (run_id="dwfrun-1")');
  });

  it("匿名子代理用结构化引用；标记字符被转义", () => {
    const text = formatWorkflowBlockedNotification({
      ...base,
      runLabel: "a <b> & c",
      questions: [{ qid: "q-1", actor: "actor#3@1", question: 'x < y && "z"', askedAt: 0 }],
      holes: [],
      ordinal: 1,
      total: 2,
    });
    expect(text).toContain("<run>a &lt;b&gt; &amp; c</run>");
    expect(text).toContain('subagent="actor#3@1"');
    expect(text).toContain("<text>x &lt; y &amp;&amp; &quot;z&quot;</text>");
  });

  it("截断诚实：至多列 8 个问题与 8 处留白，count 说真数；长文本截到 2000 字符", () => {
    const questions = Array.from({ length: 11 }, (_, index) => ({
      qid: `q-${index}`,
      actor: "actor#1@1",
      question: index === 0 ? "长".repeat(5_000) : `问题 ${index}`,
      askedAt: 0,
    }));
    const holes = Array.from({ length: 9 }, (_, index) => ({
      siteId: `hole#${index}`,
      ordinal: 1,
      name: `留白 ${index}`,
      type: "T",
      state: "waiting" as const,
      since: 0,
    }));
    const text = formatWorkflowBlockedNotification({
      ...base,
      questions,
      holes,
      ordinal: 1,
      total: 2,
    });
    expect(text).toContain('<open-questions count="11" shown="8">');
    expect(text).toContain('<open-holes count="9" shown="8">');
    expect(text).not.toContain('id="q-8"');
    expect(text).not.toContain('id="hole#8"');
    expect(text).toContain(`<text>${"长".repeat(1_999)}…</text>`);
    expect(text).toContain("11 questions and 9 holes are open");
    expect(text).toContain("GetWorkflowRun lists the ones not shown here");
  });
});

// ————————————————————————————————————————————————
// runtime 宿主
// ————————————————————————————————————————————————

interface Captured {
  text: string;
  taskId?: string;
  originMeta?: BackgroundResultOriginMeta;
}

function makeRuntime(
  name: string,
  snapshots: Map<string, Partial<DynamicWorkflowRunSnapshot> | Error>,
): {
  runtime: AgentRuntime;
  internal: AgentRuntimeInternal;
  registry: InMemoryRuntimeTaskRegistry;
  captured: Captured[];
  getTask: ReturnType<typeof vi.fn>;
} {
  const registry = new InMemoryRuntimeTaskRegistry();
  const getTask = vi.fn(async (runId: string) => {
    const snapshot = snapshots.get(runId);
    if (snapshot instanceof Error) throw snapshot;
    return snapshot as DynamicWorkflowRunSnapshot | undefined;
  });
  const runtime = new AgentRuntime(
    createSessionId(name),
    { agentName: "dwf-blocked-test", workingDirectory: "/tmp/zcode-dwf-blocked" },
    {
      dynamicWorkflowRunPort: { getTask } as unknown as DynamicWorkflowRunPort,
      eventStore: createTestSessionEventStore(),
      modelAdapter: {} as never,
      runtimeTaskRegistry: registry,
    },
  );
  const captured: Captured[] = [];
  (
    runtime as unknown as { enqueueBackgroundTaskNotification: (n: Captured) => void }
  ).enqueueBackgroundTaskNotification = (notification) => {
    captured.push(notification);
  };
  return {
    captured,
    getTask,
    internal: runtime as unknown as AgentRuntimeInternal,
    registry,
    runtime,
  };
}

function registerRun(
  registry: InMemoryRuntimeTaskRegistry,
  runId: string,
  overrides: Record<string, unknown> = {},
): void {
  registry.register({
    agentId: runId,
    agentType: "local_dynamic_workflow",
    description: `run ${runId}`,
    isBackgrounded: true,
    startedAt: new Date(0),
    status: "running",
    taskId: runId,
    taskType: "local_dynamic_workflow",
    type: "local_dynamic_workflow",
    ...overrides,
  } as never);
}

const openSnapshot: Partial<DynamicWorkflowRunSnapshot> = {
  pendingQuestions: [
    { qid: "dwfq-1", actor: "actor#1@1", actorName: "poet", question: "继续吗？", askedAt: 0 },
    { qid: "dwfq-2", actor: "actor#2@1", question: "用哪个分支？", askedAt: 4 * MIN },
  ],
  holes: [
    {
      siteId: "hole#aa",
      ordinal: 1,
      name: "下一步",
      type: "Plan",
      state: "waiting",
      since: 2 * MIN,
    },
    { siteId: "hole#bb", ordinal: 1, name: "已补", type: "Plan", state: "filled", filledAt: MIN },
  ],
  scriptPath: "/Users/dev/proj/.zcode/workflow-drafts/x.dwf.ts",
};

describe("runtime 上的提醒钟", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("空闲 15 分钟：一条 blocked 通知，载荷是计数与最久的等待，taskId 让它继承 run 的分支代", async () => {
    const { runtime, internal, registry, captured } = makeRuntime(
      "dwf-blocked-first",
      new Map([["dwfrun-a", openSnapshot]]),
    );
    registerRun(registry, "dwfrun-a");
    await internal.drainRuntimeCommandQueue();

    await vi.advanceTimersByTimeAsync(FIRST - 1);
    expect(captured).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect(captured).toHaveLength(1);
    expect(captured[0]?.taskId).toBe("dwfrun-a");
    expect(captured[0]?.originMeta).toEqual({
      backgroundSource: "workflow",
      title: "run dwfrun-a",
      workId: "dwfrun-a",
      // 补过的留白不算开着；最久的是 askedAt = 0 的那个问题。载荷在它自己的键上，不进
      // `workflowNotification` 的闭集：闭集多一个 kind，老客户端会拒掉整帧。
      workflowBlocked: { questions: 2, holes: 1, sinceMs: FIRST },
    });
    const text = captured[0]?.text ?? "";
    expect(text).toContain("<reminder>1 of 2</reminder>");
    expect(text).toContain('<question id="dwfq-1" subagent="poet"');
    expect(text).toContain('<question id="dwfq-2" subagent="actor#2@1"');
    expect(text).toContain('<hole id="hole#aa"');
    expect(text).not.toContain("hole#bb");
    expect(text).toContain("<draft>/Users/dev/proj/.zcode/workflow-drafts/x.dwf.ts</draft>");
    runtime.beginShutdown();
  });

  it("没有开着的决定：读过快照，但不发", async () => {
    const { runtime, internal, registry, captured, getTask } = makeRuntime(
      "dwf-blocked-none",
      new Map([
        [
          "dwfrun-a",
          { holes: [{ siteId: "h", ordinal: 1, name: "n", type: "T", state: "filled" }] },
        ],
      ]),
    );
    registerRun(registry, "dwfrun-a");
    await internal.drainRuntimeCommandQueue();
    await vi.advanceTimersByTimeAsync(FIRST);
    expect(getTask).toHaveBeenCalledWith("dwfrun-a");
    expect(captured).toEqual([]);
    runtime.beginShutdown();
  });

  it("只看在飞的 workflow run：结算了的、别的任务类型、被 rewind 掉的分支都不算", async () => {
    const { runtime, internal, registry, captured, getTask } = makeRuntime(
      "dwf-blocked-live",
      new Map([
        ["dwfrun-done", openSnapshot],
        ["bash-1", openSnapshot],
        ["dwfrun-stale", openSnapshot],
      ]),
    );
    registerRun(registry, "dwfrun-done", { status: "completed" });
    registerRun(registry, "bash-1", { type: "local_bash", taskType: "local_bash" });
    registerRun(registry, "dwfrun-stale", { branchGeneration: 7 });
    await internal.drainRuntimeCommandQueue();
    await vi.advanceTimersByTimeAsync(SECOND + FIRST);
    expect(getTask).not.toHaveBeenCalled();
    expect(captured).toEqual([]);
    runtime.beginShutdown();
  });

  it("快照读失败只跳过那个 run，不抛、不影响别的 run", async () => {
    const { runtime, internal, registry, captured } = makeRuntime(
      "dwf-blocked-read-error",
      new Map<string, Partial<DynamicWorkflowRunSnapshot> | Error>([
        ["dwfrun-bad", new Error("journal closed")],
        ["dwfrun-ok", openSnapshot],
      ]),
    );
    registerRun(registry, "dwfrun-bad");
    registerRun(registry, "dwfrun-ok");
    await internal.drainRuntimeCommandQueue();
    await vi.advanceTimersByTimeAsync(FIRST);
    expect(captured.map((entry) => entry.taskId)).toEqual(["dwfrun-ok"]);
    runtime.beginShutdown();
  });

  it("开集事件（raised / resolved / reached / filled）给该 run 新的一对；其余 run 事件不动次数", async () => {
    const { runtime, internal, registry, captured } = makeRuntime(
      "dwf-blocked-events",
      new Map([["dwfrun-a", openSnapshot]]),
    );
    registerRun(registry, "dwfrun-a");
    const spend = (): void => {
      // 每条提醒唤起的那一轮：忙 → 闲。
      internal.workflowBlockedReminder?.sessionBusy();
      internal.workflowBlockedReminder?.sessionIdle();
    };
    await internal.drainRuntimeCommandQueue();
    await vi.advanceTimersByTimeAsync(FIRST);
    spend();
    await vi.advanceTimersByTimeAsync(SECOND);
    spend();
    const blocked = (): number =>
      captured.filter((entry) => entry.originMeta?.workflowBlocked !== undefined).length;
    expect(blocked()).toBe(2);

    // 与开集无关的事件：不给新的一对。
    await runtime.recordDynamicWorkflowRunProgress({
      runId: "dwfrun-a",
      sequence: 20,
      eventType: "node-dispatched",
      payload: { instance: { siteId: "ask#1", ordinal: 1 } },
    });
    await vi.advanceTimersByTimeAsync(SECOND + FIRST);
    expect(blocked()).toBe(2);

    for (const [sequence, eventType] of [
      [21, "escalation-resolved"],
      [22, "hole-filled"],
      [23, "escalation-raised"],
      [24, "hole-reached"],
    ] as const) {
      // 事件自己的通知（raised / reached，这里载荷不全会被跳过）不是要数的；只看它给不给新的一对。
      await runtime.recordDynamicWorkflowRunProgress({
        runId: "dwfrun-a",
        sequence,
        eventType,
        payload: {},
      });
      const before = blocked();
      await vi.advanceTimersByTimeAsync(FIRST);
      expect(blocked(), eventType).toBe(before + 1);
      spend();
      await vi.advanceTimersByTimeAsync(SECOND);
      spend();
      expect(blocked(), eventType).toBe(before + 2);
    }
    runtime.beginShutdown();
  });

  it("beginShutdown 停钟：关会话之后不再唤起任何一轮", async () => {
    const { runtime, internal, registry, captured } = makeRuntime(
      "dwf-blocked-shutdown",
      new Map([["dwfrun-a", openSnapshot]]),
    );
    registerRun(registry, "dwfrun-a");
    await internal.drainRuntimeCommandQueue();
    runtime.beginShutdown();
    await vi.advanceTimersByTimeAsync(SECOND + FIRST);
    expect(captured).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ————————————————————————————————————————————————
// 队列与 steer 上的接线点（忙 / 闲 / 用户发话）
// ————————————————————————————————————————————————

function fakeClock(): {
  clock: WorkflowBlockedReminderClock;
  calls: string[];
} {
  const calls: string[] = [];
  const clock = {
    openSetChanged: (runId: string) => calls.push(`changed:${runId}`),
    sessionBusy: () => calls.push("busy"),
    sessionIdle: () => calls.push("idle"),
    stop: () => calls.push("stop"),
    userSpoke: () => calls.push("user"),
  } as unknown as WorkflowBlockedReminderClock;
  return { calls, clock };
}

function queueRuntime(clock: WorkflowBlockedReminderClock): AgentRuntimeInternal {
  return {
    activeForegroundExecution: undefined,
    activeTurn: undefined,
    activeTurnStartReservation: undefined,
    executeTurnCommand: vi.fn().mockResolvedValue({}),
    foregroundPromotionLease: undefined,
    runtimeCommandDrainActive: false,
    runtimeCommandQueue: createRuntimeCommandQueue(),
    workflowBlockedReminder: clock,
  } as unknown as AgentRuntimeInternal;
}

function prompt(id: string, options?: Record<string, unknown>): RuntimeCommand {
  return {
    createdAt: new Date(0),
    id: id as RuntimeCommandId,
    input: id,
    mode: "prompt",
    ...(options ? { options } : {}),
    priority: "next",
    reject: () => {},
    resolve: () => {},
    traceContext: { sessionId: "sess_blocked_queue", spanId: `span_${id}`, traceId: "trace" },
  } as RuntimeCommand;
}

describe("命令队列上的接线", () => {
  it("用户 prompt：忙 + 用户发话，排空后闲", async () => {
    const { clock, calls } = fakeClock();
    const runtime = queueRuntime(clock);
    runtime.runtimeCommandQueue.enqueue(prompt("hello"));
    await drainRuntimeCommandQueue.call(runtime);
    expect(calls).toEqual(["busy", "user", "idle"]);
  });

  it("带合成来源的 prompt 不是用户发话", async () => {
    const { clock, calls } = fakeClock();
    const runtime = queueRuntime(clock);
    runtime.runtimeCommandQueue.enqueue(prompt("synthetic", { inputSource: "todo_reminder" }));
    await drainRuntimeCommandQueue.call(runtime);
    expect(calls).toEqual(["busy", "idle"]);
  });

  it("空排一次队列也报闲（钟自己去重），持着晋升租约时不报", async () => {
    const { clock, calls } = fakeClock();
    const runtime = queueRuntime(clock);
    await drainRuntimeCommandQueue.call(runtime);
    expect(calls).toEqual(["idle"]);

    calls.length = 0;
    runtime.foregroundPromotionLease = { leaseId: "l", promotedInputId: "p" };
    runtime.runtimeCommandQueue.enqueue(prompt("waiting-behind-lease"));
    await drainRuntimeCommandQueue.call(runtime);
    expect(calls).toEqual([]);
  });

  it("连着两条命令：每条开始都报忙，只在全部排空后报一次闲", async () => {
    const { clock, calls } = fakeClock();
    const runtime = queueRuntime(clock);
    runtime.runtimeCommandQueue.enqueue(prompt("one"));
    runtime.runtimeCommandQueue.enqueue(prompt("two", { inputSource: "goal-continuation" }));
    await drainRuntimeCommandQueue.call(runtime);
    expect(calls).toEqual(["busy", "user", "busy", "idle"]);
  });
});

describe("steer 上的接线", () => {
  function steerRuntime(clock: WorkflowBlockedReminderClock): AgentRuntimeInternal {
    return {
      activeTurn: {
        kind: "regular",
        pendingInputs: [],
        steerable: true,
        traceContext: { sessionId: "sess_blocked_steer", spanId: "span", traceId: "trace" },
        turnId: "turn_1",
      },
      appendEvent: vi.fn().mockResolvedValue(undefined),
      createPendingInputId: () => "pending_1",
      sessionId: createSessionId("sess_blocked_steer"),
      workflowBlockedReminder: clock,
    } as unknown as AgentRuntimeInternal;
  }

  it("用户 steer 进在跑的一轮：算用户发话", async () => {
    const { clock, calls } = fakeClock();
    const result = await steerTurn.call(steerRuntime(clock), {
      input: "先答那个问题",
      inputPresentation: "user_steer",
    });
    expect(result.kind).toBe("queued");
    expect(calls).toEqual(["user"]);
  });

  it("协调者 / 信箱 / 工具跟进的 steer 不是用户发话", async () => {
    const { clock, calls } = fakeClock();
    const runtime = steerRuntime(clock);
    await steerTurn.call(runtime, {
      input: "from coordinator",
      inputPresentation: "coordinator_steer",
    });
    await steerTurn.call(runtime, { delivery: "guide", input: "mailbox" });
    expect(calls).toEqual([]);
  });
});
