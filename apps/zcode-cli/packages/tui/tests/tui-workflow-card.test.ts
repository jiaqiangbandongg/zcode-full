import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, createSessionEvent, type SessionEvent } from "@zcode/contracts";
import { getZCodeCopy } from "@zcode/i18n";
import { WORKFLOW_RUNS_LIMITS } from "@zcode/shared/zcode-protocol-v4";
import {
  EMPTY_TUI_WORKFLOW_MIRROR,
  applyWorkflowProgressToMirror,
  buildTuiWorkflowCardIndex,
  seedWorkflowMirror,
  workflowRunStepCounts,
  type TuiWorkflowMirror,
} from "../src/app-workflow-mirror.js";
import { MAX_ACTOR_ROWS, WorkflowRunCardView, actorRowsForCard } from "../src/app-workflow-card.js";
import { applySessionEventToState } from "../src/app-events.js";
import { rememberSessionEvent } from "../src/app-session-event-handler.js";
import {
  appendWorkflowInterruptedNotices,
  interruptedWorkflowNotices,
  workflowInterruptedNoticeText,
  workflowRunSeedFromSummary,
} from "../src/app-workflow-seed.js";

const COPY = getZCodeCopy("en-US").tui;
const RUN_ID = "dwfrun-1";
const TOOL_CALL_ID = "tc-1";

let sequence = 0;

function progress(
  eventType: string,
  payload: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) {
  sequence += 1;
  return {
    runId: RUN_ID,
    toolCallId: TOOL_CALL_ID,
    sequence,
    eventType,
    payload,
    ...extra,
  };
}

function mirrorAfter(
  events: readonly Record<string, unknown>[],
  initial: TuiWorkflowMirror = EMPTY_TUI_WORKFLOW_MIRROR,
): TuiWorkflowMirror {
  let mirror = initial;
  for (const event of events) mirror = applyWorkflowProgressToMirror(mirror, event);
  return mirror;
}

function startedMirror(): TuiWorkflowMirror {
  sequence = -1;
  return mirrorAfter([progress("run-started", { runId: RUN_ID, caps: { maxConcurrency: 4 } })]);
}

// ── 镜像：共享 reducer 驱动 + React 引用回传 ──

test("progress events drive the mirror through the shared reducer", () => {
  const dispatched = mirrorAfter(
    [
      progress("actor-created", { actor: { siteId: "actor#1", ordinal: 1 }, name: "planner" }),
      progress("node-queued", {
        instance: { siteId: "ask#1", ordinal: 1 },
        kind: "ask",
        actor: { siteId: "actor#1", ordinal: 1 },
      }),
      progress("node-dispatched", { instance: { siteId: "ask#1", ordinal: 1 } }),
    ],
    startedMirror(),
  );

  const run = dispatched.state.runs[0];
  assert.equal(run?.runId, RUN_ID);
  assert.equal(run?.status, "running");
  // actor 状态是派生的，由共享 reducer 按决策 39 算出，TUI 不重推导
  // （docs/dynamic-workflow/concurrency.md）：dispatched 只是「会话就绪、首个请求尚未
  // 准入」，算 waiting；要到 node-executing（模型请求已发出）才是 running。
  assert.equal(run?.actors[0]?.status, "waiting");
  assert.deepEqual(workflowRunStepCounts(run!), { nodesSettled: 0, nodesTotal: 1 });

  const executing = mirrorAfter(
    [progress("node-executing", { instance: { siteId: "ask#1", ordinal: 1 } })],
    dispatched,
  );
  assert.equal(executing.state.runs[0]?.actors[0]?.status, "running");
});

// 步数读法只有一处（@zcode/shared 的 workflowRunStepCounts）。镜像此前自己数 nodes，于是一条
// 撞过节点界的 run 在 TUI 卡、run 卡与时间线摘要上显示三个数字，而且三个都比真实步数小。
test("step counts include the instances the node cap kept out of the list", () => {
  const rejected = 3;
  const events = [progress("run-started", { runId: RUN_ID, caps: { maxConcurrency: 4 } })];
  for (let ordinal = 1; ordinal <= WORKFLOW_RUNS_LIMITS.maxNodes + rejected; ordinal += 1) {
    events.push(progress("node-queued", { instance: { siteId: "ask#1", ordinal }, kind: "ask" }));
  }
  events.push(
    progress("node-settled", {
      instance: { siteId: "ask#1", ordinal: WORKFLOW_RUNS_LIMITS.maxNodes + 1 },
      outcome: "ok",
    }),
  );
  sequence = -1;
  const run = mirrorAfter(events).state.runs[0]!;

  assert.equal(run.nodes.length, WORKFLOW_RUNS_LIMITS.maxNodes);
  assert.equal(run.truncated, true);
  assert.deepEqual(workflowRunStepCounts(run), {
    nodesSettled: 1,
    nodesTotal: WORKFLOW_RUNS_LIMITS.maxNodes + rejected,
  });
  // 卡片读的是同一个函数，所以两处不可能再各说各话。
  const card = buildTuiWorkflowCardIndex({ ...EMPTY_TUI_WORKFLOW_MIRROR, state: { revision: 1, runs: [run] } }).get(
    TOOL_CALL_ID,
  );
  assert.equal(card?.nodesTotal, WORKFLOW_RUNS_LIMITS.maxNodes + rejected);
  assert.equal(card?.nodesSettled, 1);
});

test("an unchanged event returns the identical mirror reference so React skips the repaint", () => {
  const mirror = startedMirror();
  const settle = progress("node-settled", {
    instance: { siteId: "ask#1", ordinal: 1 },
    outcome: "ok",
  });
  const advanced = applyWorkflowProgressToMirror(mirror, settle);
  assert.notEqual(advanced, mirror);
  // 同一条事件立刻重放：共享 reducer 回 null，镜像回传同一个引用。
  assert.equal(applyWorkflowProgressToMirror(advanced, settle), advanced);
});

test("an invalid envelope never allocates a new mirror", () => {
  const mirror = startedMirror();
  assert.equal(applyWorkflowProgressToMirror(mirror, { eventType: "run-started" }), mirror);
  assert.equal(applyWorkflowProgressToMirror(mirror, { runId: RUN_ID }), mirror);
});

test("log events stay out of the protocol state but land in the bounded TUI log tail", () => {
  const mirror = mirrorAfter(
    [progress("log", { message: "  step   one\n" }), progress("log", { message: "step two" })],
    startedMirror(),
  );
  // log 不进图：没有 site id，节点/actor 表不动。
  assert.deepEqual(mirror.state.runs[0]?.nodes, []);
  assert.deepEqual(mirror.logTailByRunId[RUN_ID], ["step one", "step two"]);
});

test("the log tail is bounded and keeps the newest entries", () => {
  let mirror = startedMirror();
  for (let index = 0; index < 20; index += 1) {
    mirror = applyWorkflowProgressToMirror(mirror, progress("log", { message: `line ${index}` }));
  }
  const tail = mirror.logTailByRunId[RUN_ID] ?? [];
  assert.equal(tail.length, 10);
  assert.equal(tail.at(-1), "line 19");
  assert.equal(tail[0], "line 10");
});

test("a log event with no usable message stays out of the tail but still raises the水位", () => {
  // 一条有效事件哪怕内容不可用也会抬 lastEventSequence（共享 reducer 的既有裁定：
  // 事件日志需要知道有新内容可取）。所以这里能断言的是**日志尾不动**，不是整个镜像不动。
  const mirror = startedMirror();
  const before = mirror.state.runs[0]?.lastEventSequence ?? 0;
  for (const payload of [{ message: "   " }, {}]) {
    const next = applyWorkflowProgressToMirror(mirror, progress("log", payload));
    assert.equal(next.logTailByRunId[RUN_ID], undefined, "empty log entered the tail");
    assert.ok(
      (next.state.runs[0]?.lastEventSequence ?? 0) > before,
      "lastEventSequence should still rise",
    );
  }
});

// ── join：按 toolCallId（运行态只来自镜像状态；补种只给展示名）──

test("the card index joins by toolCallId and carries settled/observed step counts", () => {
  const mirror = mirrorAfter(
    [
      progress("node-queued", { instance: { siteId: "ask#1", ordinal: 1 }, kind: "ask" }),
      progress("node-settled", { instance: { siteId: "ask#1", ordinal: 1 }, outcome: "ok" }),
      progress("node-queued", { instance: { siteId: "ask#2", ordinal: 1 }, kind: "ask" }),
    ],
    startedMirror(),
  );
  const card = buildTuiWorkflowCardIndex(mirror).get(TOOL_CALL_ID);
  assert.equal(card?.runId, RUN_ID);
  assert.equal(card?.nodesSettled, 1);
  // 分母是**已排程**节点数，不是冒充的全程总数。
  assert.equal(card?.nodesTotal, 2);
});

test("a run with no toolCallId has no card to join", () => {
  const mirror = applyWorkflowProgressToMirror(EMPTY_TUI_WORKFLOW_MIRROR, {
    runId: "dwfrun-orphan",
    sequence: 0,
    eventType: "run-started",
    payload: { caps: { maxConcurrency: 1 } },
  });
  assert.equal(buildTuiWorkflowCardIndex(mirror).size, 0);
});

test("cold replay drives the mirror through the shared reducer; seeding only adds the label", () => {
  // docs/dynamic-workflow/presentation.md：运行态只从回放来（journal 的真实有序事件），
  // 摘要只补展示名。回放出的 run 与 live 归约同形：步数、用量、actor、resumable 一个不少。
  sequence = -1;
  const replayed = mirrorAfter(
    [
      progress("run-started", { runId: RUN_ID, caps: { maxConcurrency: 4 } }),
      progress("actor-created", { actor: { siteId: "actor#1", ordinal: 1 }, name: "planner" }),
      progress("node-queued", { instance: { siteId: "ask#1", ordinal: 1 }, kind: "ask" }),
      progress("node-settled", { instance: { siteId: "ask#1", ordinal: 1 }, outcome: "ok" }),
      progress("usage-updated", { spentTokens: 4200 }),
      progress("run-settled", { status: "stopped", stopReason: "user", resumable: true }),
    ],
    EMPTY_TUI_WORKFLOW_MIRROR,
  );
  const seeded = seedWorkflowMirror(replayed, [
    { runId: RUN_ID, label: "cold run" },
    // 镜像里没有的 run：摘要不会为它造一张卡。
    { runId: "dwfrun-unknown", label: "ghost" },
  ]);
  const index = buildTuiWorkflowCardIndex(seeded);

  assert.equal(index.size, 1);
  const card = index.get(TOOL_CALL_ID);
  assert.equal(card?.status, "stopped");
  assert.equal(card?.stopReason, "user");
  assert.equal(card?.label, "cold run");
  assert.equal(card?.resumable, true);
  assert.deepEqual(
    { settled: card?.nodesSettled, total: card?.nodesTotal },
    { settled: 1, total: 1 },
  );
  assert.equal(card?.usage?.spentTokens, 4200);
  assert.equal(card?.actors.length, 1);
});

test("seeding the same summaries twice returns the identical reference", () => {
  const seeds = [{ runId: "dwfrun-cold", label: "cold" }];
  const once = seedWorkflowMirror(EMPTY_TUI_WORKFLOW_MIRROR, seeds);
  assert.notEqual(once, EMPTY_TUI_WORKFLOW_MIRROR);
  assert.equal(seedWorkflowMirror(once, seeds), once);
  assert.equal(seedWorkflowMirror(once, []), once);
});

test("resumable is rendered from the state bit and never re-derived from status", () => {
  sequence = -1;
  const withoutBit = mirrorAfter([
    progress("run-started", { runId: RUN_ID, caps: { maxConcurrency: 4 } }),
    progress("run-settled", { status: "stopped" }),
  ]);
  // stopped 却没带状态位（旧 CLI）：不当成可恢复。
  assert.equal(buildTuiWorkflowCardIndex(withoutBit).get(TOOL_CALL_ID)?.resumable, undefined);
});

test("interrupted notices come from the server boolean and preserve the server's order", () => {
  // 端口注释明确：updatedAt 只供展示，读侧拿它重排会与服务端的 tie-break 漂移。服务端按
  // 「最近更新在前」给序，这里必须原样保留——先来的 newer 就该排在 older 之前。
  const notices = interruptedWorkflowNotices([
    { runId: "newer", status: "stopped", resumable: true, updatedAt: 900, label: "N" },
    { runId: "older", status: "stopped", resumable: true, updatedAt: 100 },
    { runId: "plain", status: "errored", resumable: false, updatedAt: 500 },
    { runId: "done", status: "completed", updatedAt: 700 },
  ]);
  assert.deepEqual(
    notices.map((seed) => seed.runId),
    ["newer", "older"],
  );
  assert.equal(notices[0]?.label, "N");
});

// ── 事件开关：progress 事件不再落进 default ──

function sessionEvent(payload: unknown): SessionEvent {
  return {
    id: `evt-${(sequence += 1)}`,
    sessionId: "session-1",
    type: SessionEventType.DynamicWorkflowRunProgress,
    timestamp: new Date(0),
    traceId: "trace-1",
    sequenceNumber: sequence,
    payload,
  } as SessionEvent;
}

test("applySessionEventToState routes dwf progress into the mirror", () => {
  let mirror = EMPTY_TUI_WORKFLOW_MIRROR;
  const handlers = {
    setActiveTurnId: () => {},
    setCacheStats: () => {},
    setContextUsage: () => {},
    setLastError: () => {},
    setLiveModelText: () => {},
    setMessages: () => {},
    setModel: () => {},
    setNetworkRequests: () => {},
    setStatus: () => {},
    setTodos: () => {},
    setUsage: () => {},
    setWorkflowMirror: (update: unknown) => {
      mirror =
        typeof update === "function"
          ? (update as (m: TuiWorkflowMirror) => TuiWorkflowMirror)(mirror)
          : (update as TuiWorkflowMirror);
    },
    assistantMessageIdsByToolCallId: new Map<string, string>(),
    toolNamesById: new Map<string, string>(),
  } as unknown as Parameters<typeof applySessionEventToState>[1];

  applySessionEventToState(
    sessionEvent({
      runId: RUN_ID,
      toolCallId: TOOL_CALL_ID,
      sequence: 0,
      eventType: "run-started",
      payload: { caps: { maxConcurrency: 2 } },
    }),
    handlers,
    COPY,
  );

  assert.equal(mirror.state.runs[0]?.runId, RUN_ID);
  assert.equal(mirror.state.runs[0]?.status, "running");
});

// ── 去重：常驻订阅与 per-turn sink 绝不双投 ──

test("an event id is applied once no matter how many sinks deliver it", () => {
  const applied = new Set<string>();
  const event = sessionEvent({ runId: RUN_ID, sequence: 0, eventType: "log", payload: {} });
  assert.equal(rememberSessionEvent(applied, event), true);
  assert.equal(rememberSessionEvent(applied, event), false);
});

test("events built by the real contracts factory always carry a dedup key", () => {
  // 去重的全部依据是 SessionEvent.id。这条用例故意走**真实**的 createSessionEvent，
  // 而不是本文件的手写 fixture：如果哪天有人加了一条不铸 id 的事件构造路径，
  // 「缺 id 就放行」会静默退化成「双份渲染」（流式增量双投会当场把可见文本写坏）。
  // 结构性保证有两层：createSessionEvent 无条件铸 id，且 SessionEvent.id 是必填字段。
  const applied = new Set<string>();
  for (const type of [
    SessionEventType.ModelStreaming,
    SessionEventType.AssistantMessage,
    SessionEventType.ToolCallScheduled,
    SessionEventType.ToolCallResult,
    SessionEventType.TurnComplete,
    SessionEventType.DynamicWorkflowRunProgress,
  ]) {
    const event = createSessionEvent(type, "session-1" as never, {});
    assert.ok(event.id, `${type} must carry an id`);
    // 第一次投递应用，第二个 sink 的同一条被丢弃。
    assert.equal(rememberSessionEvent(applied, event), true);
    assert.equal(rememberSessionEvent(applied, event), false);
  }
});

test("events with no id are always applied rather than silently swallowed", () => {
  const applied = new Set<string>();
  const anonymous = { ...sessionEvent({}), id: "" } as SessionEvent;
  assert.equal(rememberSessionEvent(applied, anonymous), true);
  assert.equal(rememberSessionEvent(applied, anonymous), true);
});

test("the dedup window is bounded", () => {
  const applied = new Set<string>();
  for (let index = 0; index < 3_000; index += 1) {
    rememberSessionEvent(applied, { ...sessionEvent({}), id: `bulk-${index}` } as SessionEvent);
  }
  assert.ok(applied.size <= 2_048, `window grew to ${applied.size}`);
});

// ── 卡片渲染 ──

function renderCardText(element: React.ReactElement): string[] {
  const lines: string[] = [];
  const visit = (node: unknown): void => {
    if (node === null || node === undefined || typeof node === "boolean") return;
    if (typeof node === "string" || typeof node === "number") {
      lines.push(String(node));
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    const element = node as { props?: { children?: unknown } };
    if (element.props?.children !== undefined) visit(element.props.children);
  };
  visit(element);
  return lines;
}

test("the collapsed card line shows label, run status and settled/observed steps", () => {
  const mirror = mirrorAfter(
    [
      progress("node-queued", { instance: { siteId: "ask#1", ordinal: 1 }, kind: "ask" }),
      progress("node-settled", { instance: { siteId: "ask#1", ordinal: 1 }, outcome: "ok" }),
    ],
    startedMirror(),
  );
  const card = buildTuiWorkflowCardIndex(
    seedWorkflowMirror(mirror, [{ runId: RUN_ID, label: "lean-loop" }]),
  ).get(TOOL_CALL_ID)!;

  const collapsed = renderCardText(WorkflowRunCardView({ card, copy: COPY })).join("\n");
  assert.match(collapsed, /lean-loop/u);
  assert.match(collapsed, /running/u);
  assert.match(collapsed, /1\/1 steps/u);
  assert.match(collapsed, /\+ to expand/u);
  // 折叠态不泄漏展开详情。
  assert.doesNotMatch(collapsed, /budget/u);
});

test("the card falls back to the runId when the server has not supplied a label", () => {
  const card = buildTuiWorkflowCardIndex(startedMirror()).get(TOOL_CALL_ID)!;
  const collapsed = renderCardText(WorkflowRunCardView({ card, copy: COPY })).join("\n");
  assert.match(collapsed, new RegExp(RUN_ID, "u"));
});

test("the expanded card shows usage, actors, log tail and result", () => {
  const mirror = mirrorAfter(
    [
      progress("actor-created", { actor: { siteId: "actor#1", ordinal: 1 }, name: "planner" }),
      // usage-updated 直接携带已花总量（docs/dynamic-workflow/authoring.md），没有派生字段。
      progress("usage-updated", { spentTokens: 1_234 }),
      progress("log", { message: "compiling proof" }),
    ],
    startedMirror(),
  );
  const card = buildTuiWorkflowCardIndex(mirror).get(TOOL_CALL_ID)!;
  const expanded = renderCardText(WorkflowRunCardView({ card, copy: COPY, expanded: true })).join(
    "\n",
  );

  assert.match(expanded, /usage: 1234 tokens/u);
  assert.doesNotMatch(expanded, /budget/u);
  assert.match(expanded, /planner/u);
  assert.match(expanded, /compiling proof/u);
  assert.match(expanded, /- to collapse/u);
});

// ── 六行位置的挑选：跑着的优先（docs/dynamic-workflow/launch.md「The inline card」）──

function actorFixture(
  name: string,
  status: "running" | "waiting" | "completed",
): { siteId: string; ordinal: number; name: string; status: "running" | "waiting" | "completed" } {
  return { siteId: `site-${name}`, ordinal: 1, name, status };
}

test("the six actor rows go running, then waiting, then completed, stable within a bucket", () => {
  const rows = actorRowsForCard([
    actorFixture("done-1", "completed"),
    actorFixture("wait-1", "waiting"),
    actorFixture("done-2", "completed"),
    actorFixture("run-1", "running"),
    actorFixture("wait-2", "waiting"),
    actorFixture("done-3", "completed"),
    actorFixture("run-2", "running"),
    actorFixture("wait-3", "waiting"),
  ]);

  assert.equal(rows.length, MAX_ACTOR_ROWS);
  // 桶内保持协议顺序：run-1 在 run-2 之前，wait-1..3 原序。
  assert.deepEqual(
    rows.map((actor) => actor.name),
    ["run-1", "run-2", "wait-1", "wait-2", "wait-3", "done-1"],
  );
});

test("a card that fits every subagent still leads with the running ones", () => {
  const rows = actorRowsForCard(
    [
      actorFixture("done-1", "completed"),
      actorFixture("run-1", "running"),
      actorFixture("wait-1", "waiting"),
    ],
    MAX_ACTOR_ROWS,
  );
  assert.deepEqual(
    rows.map((actor) => actor.name),
    ["run-1", "wait-1", "done-1"],
  );
});

test("a wide run's expanded card shows the agent that is running, not the six that finished", () => {
  sequence = -1;
  const events: Record<string, unknown>[] = [
    progress("run-started", { runId: RUN_ID, caps: { maxConcurrency: 8 } }),
  ];
  const total = MAX_ACTOR_ROWS + 1;
  for (let index = 1; index <= total; index += 1) {
    const actor = { siteId: `actor#${index}`, ordinal: 1 };
    const instance = { siteId: `ask#${index}`, ordinal: 1 };
    events.push(progress("actor-created", { actor, name: `planner-${index}` }));
    events.push(progress("node-queued", { instance, kind: "ask", actor }));
    // 最后一个还在跑，前六个都已结算——协议顺序下它恰好被挤出六行之外。
    events.push(
      index === total
        ? progress("node-executing", { instance })
        : progress("node-settled", { instance, outcome: "ok" }),
    );
  }

  const card = buildTuiWorkflowCardIndex(mirrorAfter(events)).get(TOOL_CALL_ID)!;
  assert.equal(card.actors.length, total);
  const expanded = renderCardText(WorkflowRunCardView({ card, copy: COPY, expanded: true }));
  const rows = expanded.filter((line) => /planner-/u.test(line));

  assert.equal(rows.length, MAX_ACTOR_ROWS);
  assert.match(rows[0]!, /planner-7/u);
  assert.match(rows[0]!, /running/u);
  // 被挤出去的是最后一个已完成的，不是那个还在跑的。
  assert.ok(
    rows.every((line) => !/planner-6/u.test(line)),
    "a completed agent should be the one dropped",
  );
});

test("the expanded card surfaces the settlement error", () => {
  const mirror = mirrorAfter(
    [progress("run-settled", { status: "errored", error: { message: "node cap exhausted" } })],
    startedMirror(),
  );
  const card = buildTuiWorkflowCardIndex(mirror).get(TOOL_CALL_ID)!;
  const expanded = renderCardText(WorkflowRunCardView({ card, copy: COPY, expanded: true })).join(
    "\n",
  );
  assert.match(expanded, /node cap exhausted/u);
  assert.match(renderCardText(WorkflowRunCardView({ card, copy: COPY })).join("\n"), /errored/u);
});

test("a stopped run renders the stop reason next to the status word", () => {
  const mirror = mirrorAfter(
    [progress("run-settled", { status: "stopped", stopReason: "provider", resumable: true })],
    startedMirror(),
  );
  const card = buildTuiWorkflowCardIndex(mirror).get(TOOL_CALL_ID)!;
  assert.equal(card.stopReason, "provider");
  assert.match(
    renderCardText(WorkflowRunCardView({ card, copy: COPY })).join("\n"),
    /stopped \(model error\)/u,
  );
});

test("a replayed stopped run renders its real facts after a cold start", () => {
  sequence = -1;
  const mirror = seedWorkflowMirror(
    mirrorAfter([
      progress("run-started", { runId: RUN_ID, caps: { maxConcurrency: 4 } }),
      progress("actor-created", { actor: { siteId: "actor#1", ordinal: 1 }, name: "planner" }),
      progress("run-settled", { status: "stopped", resumable: true }),
    ]),
    [{ runId: RUN_ID, label: "cold" }],
  );
  const card = buildTuiWorkflowCardIndex(mirror).get(TOOL_CALL_ID)!;
  const expanded = renderCardText(WorkflowRunCardView({ card, copy: COPY, expanded: true })).join(
    "\n",
  );
  assert.match(expanded, /cold/u);
  assert.match(expanded, /stopped/u);
  // 回放带回了真实的 actor，不再是空壳。
  assert.match(expanded, /planner/u);
});

test("both locales render the card without leaking raw copy keys", () => {
  const card = buildTuiWorkflowCardIndex(startedMirror()).get(TOOL_CALL_ID)!;
  for (const locale of ["en-US", "zh-CN"] as const) {
    const copy = getZCodeCopy(locale).tui;
    const text = renderCardText(WorkflowRunCardView({ card, copy, expanded: true })).join("\n");
    assert.ok(text.length > 0, `${locale} rendered nothing`);
    assert.doesNotMatch(text, /undefined/u, `${locale} leaked undefined`);
    assert.doesNotMatch(text, /\[object Object\]/u, `${locale} leaked an object`);
  }
});

// ── 冷补种 → notice 行（启动 / /resume 后）──

test("summaries map to seeds carrying only display facts, never runtime state", () => {
  const seed = workflowRunSeedFromSummary({ runId: "dwfrun-1", status: "running" });
  assert.deepEqual(seed, { runId: "dwfrun-1" });
  // label / updatedAt 缺席就该缺席，不造默认值；status / resumable 是运行态，走回放，不进补种。
  assert.equal("label" in seed, false);

  const full = workflowRunSeedFromSummary({
    runId: "dwfrun-2",
    toolCallId: "tc-2",
    status: "stopped",
    label: "lean-loop",
    resumable: true,
    updatedAt: 1_700_000_000_000,
  });
  assert.deepEqual(full, { runId: "dwfrun-2", label: "lean-loop", updatedAt: 1_700_000_000_000 });
});

test("notice lines carry the label and the /dwf resume hint", () => {
  const text = workflowInterruptedNoticeText({ runId: "dwfrun-1", label: "lean-loop" }, COPY);
  assert.match(text, /lean-loop/u);
  assert.match(text, /\/dwf resume dwfrun-1/u);
});

test("a notice falls back to the runId when the server sent no label", () => {
  const text = workflowInterruptedNoticeText({ runId: "dwfrun-9" }, COPY);
  assert.match(text, /dwfrun-9/u);
  assert.doesNotMatch(text, /undefined/u);
});

test("notices append as system rows, never as fabricated user rows", () => {
  const messages = appendWorkflowInterruptedNotices([], [{ runId: "dwfrun-1", label: "A" }], COPY);
  assert.equal(messages.length, 1);
  // 这不是用户说的话：system 行，不伪造 user 行（与不渲染 model-only 合成 user 行同一裁定）。
  assert.equal(messages[0]?.role, "system");
});

test("no resumable runs means zero notice output", () => {
  const before: never[] = [];
  assert.equal(appendWorkflowInterruptedNotices(before, [], COPY), before);
});

test("both locales render a notice without leaking raw keys", () => {
  for (const locale of ["en-US", "zh-CN"] as const) {
    const text = workflowInterruptedNoticeText(
      { runId: "dwfrun-1", label: "L" },
      getZCodeCopy(locale).tui,
    );
    assert.ok(text.length > 0);
    assert.doesNotMatch(text, /undefined|\[object Object\]/u);
    assert.match(text, /\/dwf resume/u);
  }
});
