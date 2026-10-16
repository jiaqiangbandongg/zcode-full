// dwf run 进度的**出回合追加**（out-of-turn append）：run 事件到达时父会话可能正在跑一个
// 回合，也可能完全空闲，两种都必须落地。见 docs/dynamic-workflow/presentation.md「The run state the pane draws」。
//
// 为什么需要 runtime 上的一个公共方法：BackgroundTask* 走的是 core 内部
// （tool executor 的 deps.emitEvent → runtime.appendEvent），而 dwf 的事件源在 bootstrap 的
// run service 里，那一层拿不到 AgentRuntimeInternal。既有的同形先例是 recordTargetChanged
// （bootstrap 的 session-facade 就那样出回合追加 TargetChanged）。
import { describe, expect, it, vi } from "vitest";
import {
  SessionEventType,
  createSessionId,
  createToolCallId,
  type SessionEvent,
} from "@zcode/contracts";
import { AgentRuntime } from "../src/index.js";
import { createTestSessionEventStore } from "./test-event-store.js";

function makeRuntime(name: string): { runtime: AgentRuntime; events: SessionEvent[] } {
  const runtime = new AgentRuntime(
    createSessionId(name),
    { agentName: "dwf-progress-test", workingDirectory: "/tmp/zcode-dwf-progress" },
    { eventStore: createTestSessionEventStore(), modelAdapter: {} as never },
  );
  const events: SessionEvent[] = [];
  runtime.subscribeEvents({ onSessionEvent: (event) => events.push(event) });
  return { runtime, events };
}

const progress = {
  runId: "dwfrun-1",
  sequence: 3,
  eventType: "node-dispatched",
  payload: { instance: { siteId: "ask#1", ordinal: 1 } },
};

describe("recordDynamicWorkflowRunProgress", () => {
  it("会话空闲时也能追加（run 事件不等回合）", async () => {
    const { runtime, events } = makeRuntime("dwf-progress-idle");
    expect(runtime.getActiveTurnInfo()).toBeUndefined();

    await runtime.recordDynamicWorkflowRunProgress(progress);

    const appended = events.filter(
      (event) => event.type === SessionEventType.DynamicWorkflowRunProgress,
    );
    expect(appended).toHaveLength(1);
    expect(appended[0]?.payload).toEqual(progress);
    // 空闲期追加的事件不冒领任何回合：turnId 必须为空，否则冷恢复会把它塞进上一轮的尾巴。
    expect(appended[0]?.turnId).toBeUndefined();
  });

  it("事件经 event store 补号后才发布（live 与 replay 共用同一套顺序事实）", async () => {
    const { runtime, events } = makeRuntime("dwf-progress-seq");
    await runtime.recordDynamicWorkflowRunProgress(progress);
    await runtime.recordDynamicWorkflowRunProgress({ ...progress, sequence: 4 });

    const appended = events.filter(
      (event) => event.type === SessionEventType.DynamicWorkflowRunProgress,
    );
    expect(appended.map((event) => event.sequenceNumber)).toEqual([1, 2]);
    // 载荷里的 sequence 是 **journal** sequence，与会话事件的 sequenceNumber 是两把不同的尺。
    expect(appended.map((event) => (event.payload as typeof progress).sequence)).toEqual([3, 4]);
  });

  it("toolCallId 透传（工具卡 → 详情页的关联键）", async () => {
    const { runtime, events } = makeRuntime("dwf-progress-toolcall");
    const toolCallId = createToolCallId("create-workflow-call");
    await runtime.recordDynamicWorkflowRunProgress({ ...progress, toolCallId });

    const appended = events.find(
      (event) => event.type === SessionEventType.DynamicWorkflowRunProgress,
    );
    expect((appended?.payload as { toolCallId?: string }).toolCallId).toBe(toolCallId);
  });
});

// ————————————————————————————————————————————————
// run 中的升级通知（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「How progress and completion reach the app and the main agent」）。
//
// 这是主代理**唯一**会主动收到的「有人在等你」的信号：actor 停驻在自己那次 escalate 调用上，
// 没有超时会替它兜底。所以三件事被钉死：恰好一条通知、载有 qid 与逐字的下一步、
// escalation-resolved 不再发第二条（作答方就是主代理自己，回执已经是那次工具调用的结果）。
// ————————————————————————————————————————————————

interface CapturedEscalationMeta {
  kind: "escalation";
  qid: string;
  actor: string;
  question: string;
  context?: string;
  askedAt?: number;
}

interface CapturedNotification {
  text: string;
  taskId?: string;
  originMeta?: {
    backgroundSource?: string;
    title?: string;
    workId?: string;
    workflowNotification?: CapturedEscalationMeta;
  };
}

/** 通知在 runtime 上产出（enqueueBackgroundTaskNotification 是原型方法），实例桩即可截获。 */
function captureNotifications(runtime: AgentRuntime): CapturedNotification[] {
  const captured: CapturedNotification[] = [];
  (runtime as unknown as { enqueueBackgroundTaskNotification: (n: CapturedNotification) => void })
    .enqueueBackgroundTaskNotification = (notification) => {
    captured.push(notification);
  };
  return captured;
}

const raised = {
  runId: "dwfrun-esc",
  sequence: 7,
  eventType: "escalation-raised",
  payload: {
    qid: "dwfq-esc12345-1",
    actor: { siteId: "actor#1", ordinal: 2 },
    actorName: "implementer",
    question: "评分上限是 95，通过线是 96，这个门不可能过。",
    context: "已经试了 6 轮，最高 95。",
  },
};

describe("escalation-raised → run 中通知", () => {
  it("恰好一条通知，载 qid、问题、上下文与逐字的下一步", async () => {
    const { runtime } = makeRuntime("dwf-progress-escalation");
    const captured = captureNotifications(runtime);

    await runtime.recordDynamicWorkflowRunProgress(raised);

    expect(captured).toHaveLength(1);
    const text = captured[0]?.text ?? "";
    expect(text).toContain("dwfq-esc12345-1");
    expect(text).toContain("评分上限是 95，通过线是 96，这个门不可能过。");
    expect(text).toContain("已经试了 6 轮，最高 95。");
    // 逐字的下一步：模型读完这条通知就该知道要调哪个工具、传什么。
    expect(text).toContain('ResolveWorkflowQuestion with question_id="dwfq-esc12345-1"');
    // run 没有停：缺了这句，模型会以为整条工作流在等它，从而放下手上一切事。
    expect(text).toContain("The run is still running");
    // 通知丢弃后的查询兜底（GetWorkflowRun 的 pendingQuestions）。
    expect(text).toContain("GetWorkflowRun");
    // 合成 user 消息不得被误读成用户发言。
    expect(text).toContain("[SYSTEM NOTIFICATION - NOT USER INPUT]");
  });

  it("actorName 在场时用人名；匿名 actor 落到结构化 ref site@ordinal", async () => {
    const { runtime } = makeRuntime("dwf-progress-escalation-actor");
    const captured = captureNotifications(runtime);

    await runtime.recordDynamicWorkflowRunProgress(raised);
    await runtime.recordDynamicWorkflowRunProgress({
      ...raised,
      sequence: 8,
      payload: { ...raised.payload, actorName: undefined, qid: "dwfq-esc12345-2" },
    });

    expect(captured[0]?.text).toContain("implementer");
    // 引擎刻意不合成兜底标签（匿名 actor 缺席 actorName），渲染兜底在读侧。
    expect(captured[1]?.text).toContain("actor#1@2");
  });

  it("展示名走 registry 的 description，缺席时回落到 runId", async () => {
    const { runtime } = makeRuntime("dwf-progress-escalation-label");
    const captured = captureNotifications(runtime);

    // registry 里没有这个 run（还没登记 / 已退场）→ 展示名回落到 runId，绝不留空。
    await runtime.recordDynamicWorkflowRunProgress(raised);
    expect(captured[0]?.text).toContain("dwfrun-esc");
    expect(captured[0]?.originMeta).toEqual({
      backgroundSource: "workflow",
      title: "dwfrun-esc",
      // workId ≡ runId：与该 run 的终态通知同一个展示锚点。
      workId: "dwfrun-esc",
      // manifest 载荷（escalation 判别分支）随 originMeta 走全管线。
      workflowNotification: {
        kind: "escalation",
        qid: "dwfq-esc12345-1",
        actor: "implementer",
        question: "评分上限是 95，通过线是 96，这个门不可能过。",
        context: "已经试了 6 轮，最高 95。",
      },
    });
    expect(captured[0]?.taskId).toBe("dwfrun-esc");
  });

  it("manifest 载荷：qid/actor/question/context/askedAt 同源，缺 askedAt 即字段缺席", async () => {
    const { runtime } = makeRuntime("dwf-progress-escalation-manifest");
    const captured = captureNotifications(runtime);

    // askedAt 在场：作为数字直读进载荷（stringField 读不出数字）。
    await runtime.recordDynamicWorkflowRunProgress({
      ...raised,
      payload: { ...raised.payload, askedAt: 1_725_000_000_000 },
    });
    // askedAt 缺席：整字段缺席，不置 0。
    await runtime.recordDynamicWorkflowRunProgress({
      ...raised,
      sequence: 8,
      payload: { ...raised.payload, qid: "dwfq-esc12345-9" },
    });

    expect(captured[0]?.originMeta?.workflowNotification).toEqual({
      kind: "escalation",
      qid: "dwfq-esc12345-1",
      actor: "implementer",
      question: "评分上限是 95，通过线是 96，这个门不可能过。",
      context: "已经试了 6 轮，最高 95。",
      askedAt: 1_725_000_000_000,
    });
    expect(captured[1]?.originMeta?.workflowNotification?.askedAt).toBeUndefined();
    expect(captured[1]?.originMeta?.workflowNotification?.qid).toBe("dwfq-esc12345-9");
  });

  it("匿名 actor 的载荷 actor 落到结构化 ref site@ordinal（与通知文本同一条兜底链）", async () => {
    const { runtime } = makeRuntime("dwf-progress-escalation-manifest-anon");
    const captured = captureNotifications(runtime);

    await runtime.recordDynamicWorkflowRunProgress({
      ...raised,
      payload: { ...raised.payload, actorName: undefined },
    });
    expect(captured[0]?.originMeta?.workflowNotification?.actor).toBe("actor#1@2");
  });

  it("超界 question/context 在发射侧就地截断到 ≤4000（shared schema 同界）", async () => {
    const { runtime } = makeRuntime("dwf-progress-escalation-manifest-cap");
    const captured = captureNotifications(runtime);

    const longQuestion = "问".repeat(5_000);
    const longContext = "境".repeat(5_000);
    await runtime.recordDynamicWorkflowRunProgress({
      ...raised,
      payload: { ...raised.payload, question: longQuestion, context: longContext },
    });
    const meta = captured[0]?.originMeta?.workflowNotification;
    expect(meta?.question.length).toBe(4_000);
    expect(meta?.context?.length).toBe(4_000);
  });

  it("escalation-resolved 不产生通知（主代理就是作答方，回执已在工具结果里）", async () => {
    const { runtime, events } = makeRuntime("dwf-progress-escalation-resolved");
    const captured = captureNotifications(runtime);

    await runtime.recordDynamicWorkflowRunProgress({
      runId: "dwfrun-esc",
      sequence: 9,
      eventType: "escalation-resolved",
      payload: { qid: "dwfq-esc12345-1", answer: "按 95 通过。" },
    });

    expect(captured).toHaveLength(0);
    // 事件本身照常落库（GUI 的事件日志要渲染它）——不发通知与不记事件是两件事。
    expect(
      events.filter((event) => event.type === SessionEventType.DynamicWorkflowRunProgress),
    ).toHaveLength(1);
  });

  it("其他 run 事件不产生通知", async () => {
    const { runtime } = makeRuntime("dwf-progress-escalation-other");
    const captured = captureNotifications(runtime);
    await runtime.recordDynamicWorkflowRunProgress(progress);
    expect(captured).toHaveLength(0);
  });

  it("载荷缺 qid 或 question 时跳过通知，但事件照常落库", async () => {
    const { runtime, events } = makeRuntime("dwf-progress-escalation-malformed");
    const captured = captureNotifications(runtime);
    const logged = vi.fn();
    (runtime as unknown as { logger?: unknown }).logger = {
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      warn: logged,
    };

    await runtime.recordDynamicWorkflowRunProgress({
      ...raised,
      payload: { actor: { siteId: "actor#1", ordinal: 1 } },
    });

    // 进度面是观察面：载荷形状不对只跳过通知并留痕，绝不打挂一个正在跑的 run。
    expect(captured).toHaveLength(0);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(
      events.filter((event) => event.type === SessionEventType.DynamicWorkflowRunProgress),
    ).toHaveLength(1);
  });
});

// ————————————————————————————————————————————————
// run 级停滞（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Terminal states」）：`run-stalled` → 一条 run 中通知。
// ————————————————————————————————————————————————

const stalled = {
  runId: "dwfrun-stall",
  sequence: 11,
  eventType: "run-stalled",
  payload: { sinceMs: 1_200_000, reason: "rate_limited", cap: 2 },
};

describe("run-stalled → run 中通知", () => {
  it("恰好一条通知：run 仍在跑、不需要模型做什么、不要取消或重建", async () => {
    const { runtime } = makeRuntime("dwf-progress-stall");
    const captured = captureNotifications(runtime);

    await runtime.recordDynamicWorkflowRunProgress(stalled);

    expect(captured).toHaveLength(1);
    const text = captured[0]?.text ?? "";
    expect(text).toContain("[SYSTEM NOTIFICATION - NOT USER INPUT]");
    expect(text).toContain("<workflow-stall>");
    expect(text).toContain("<since-ms>1200000</since-ms>");
    expect(text).toContain("<dominant-reason>rate_limited</dominant-reason>");
    expect(text).toContain("<cap>2</cap>");
    expect(text).toContain("has not completed a model request in 20 minutes");
    expect(text).toContain("rate_limited");
    expect(text).toContain("It is still running and needs nothing from you.");
    expect(text).toContain("Do not cancel or rebuild it on your own.");
    expect(captured[0]?.taskId).toBe("dwfrun-stall");
    expect(captured[0]?.originMeta).toEqual({
      backgroundSource: "workflow",
      title: "dwfrun-stall",
      workId: "dwfrun-stall",
      workflowNotification: { kind: "stall", sinceMs: 1_200_000, reason: "rate_limited", cap: 2 },
    });
  });

  it("reason / cap 缺席即字段缺席；sinceMs 形状不对则整条跳过", async () => {
    const { runtime } = makeRuntime("dwf-progress-stall-shape");
    const captured = captureNotifications(runtime);

    await runtime.recordDynamicWorkflowRunProgress({
      ...stalled,
      payload: { sinceMs: 1_500_000 },
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.originMeta?.workflowNotification).toEqual({
      kind: "stall",
      sinceMs: 1_500_000,
    });
    expect(captured[0]?.text).toContain("the provider keeps failing requests");
    expect(captured[0]?.text).not.toContain("<cap>");

    await runtime.recordDynamicWorkflowRunProgress({
      ...stalled,
      sequence: 12,
      payload: { sinceMs: "soon" },
    });
    expect(captured).toHaveLength(1);
  });
});

// ————————————————————————————————————————————————
// 留白（docs/dynamic-workflow/transcript-and-notifications.md 的 `hole` 载荷与「What the model reads」）：
// `hole-reached` → 恰好一条 run 中通知，载荷从快照的 `holes[]` 补齐类型 / 行号 / 前后阶段，草稿路径
// 来自快照的 `scriptPath`；`hole-filled` 不发通知（补全方就是主代理自己，回执已在工具结果里）。
// ————————————————————————————————————————————————

interface CapturedHoleMeta {
  kind: "hole";
  siteId: string;
  ordinal: number;
  name: string;
  type: string;
  prompt?: string;
  draftPath?: string;
  line?: number;
  before?: string;
  after?: string;
  reachedAt?: number;
}

const reached = {
  runId: "dwfrun-hole",
  sequence: 21,
  eventType: "hole-reached",
  payload: {
    instance: { siteId: "hole#1", ordinal: 1 },
    name: "决定分组",
    prompt: "把 7 个候选按风险分成两组。",
    phaseName: "收集",
  },
};

function attachHoleSnapshot(
  runtime: AgentRuntime,
  holes: unknown[] | undefined,
  scriptPath?: string,
): string[] {
  const calls: string[] = [];
  (runtime as unknown as { dynamicWorkflowRunPort: unknown }).dynamicWorkflowRunPort = {
    async getTask(runId: string) {
      calls.push(runId);
      return {
        runId,
        taskId: runId,
        status: "running",
        startedAt: new Date(0),
        ...(scriptPath === undefined ? {} : { scriptPath }),
        ...(holes === undefined ? {} : { holes }),
      };
    },
  };
  return calls;
}

describe("hole-reached → run 中通知", () => {
  const waiting = {
    siteId: "hole#1",
    ordinal: 1,
    name: "决定分组",
    type: "Verdict",
    state: "waiting",
    since: 1_725_000_000_000,
    line: 12,
    before: "收集",
    after: "汇总",
  };

  it("恰好一条通知，载荷从快照补齐，文本带逐字的下一步", async () => {
    const { runtime } = makeRuntime("dwf-progress-hole");
    const captured = captureNotifications(runtime);
    const calls = attachHoleSnapshot(
      runtime,
      [waiting],
      "/repo/.zcode/workflow-drafts/triage.dwf.ts",
    );

    await runtime.recordDynamicWorkflowRunProgress(reached);

    expect(calls).toEqual(["dwfrun-hole"]);
    expect(captured).toHaveLength(1);
    const meta = captured[0]?.originMeta?.workflowNotification as unknown as CapturedHoleMeta;
    expect(meta).toEqual({
      kind: "hole",
      siteId: "hole#1",
      ordinal: 1,
      name: "决定分组",
      type: "Verdict",
      prompt: "把 7 个候选按风险分成两组。",
      draftPath: "/repo/.zcode/workflow-drafts/triage.dwf.ts",
      line: 12,
      before: "收集",
      after: "汇总",
      reachedAt: 1_725_000_000_000,
    });
    expect(captured[0]?.taskId).toBe("dwfrun-hole");
    expect(captured[0]?.originMeta?.workId).toBe("dwfrun-hole");
    const text = captured[0]?.text ?? "";
    expect(text).toContain("[SYSTEM NOTIFICATION - NOT USER INPUT]");
    expect(text).toContain("<workflow-hole>");
    expect(text).toContain("<run-id>dwfrun-hole</run-id>");
    expect(text).toContain("<hole-id>hole#1</hole-id>");
    expect(text).toContain("<name>决定分组</name>");
    expect(text).toContain("<type>Verdict</type>");
    expect(text).toContain("<prompt>把 7 个候选按风险分成两组。</prompt>");
    expect(text).toContain("<draft>/repo/.zcode/workflow-drafts/triage.dwf.ts</draft>");
    expect(text).toContain("<line>12</line>");
    expect(text).toContain("<before>收集</before>");
    expect(text).toContain("<after>汇总</after>");
    // 逐字的下一步：读草稿、写函数体、带 hole_id 调 FillWorkflowHole。
    expect(text).toContain('FillWorkflowHole with run_id="dwfrun-hole" and hole_id="hole#1"');
    expect(text).toContain("Only this branch of the script is parked");
    expect(text).toContain("nothing times out");
    expect(text).toContain("compiled where the hole stands");
    expect(text).toContain("must return a value of type `Verdict`");
    expect(text).toContain("GetWorkflowRun");
  });

  it("快照缺席时仍发通知，只带载荷自己说得出的字段；prompt 超界截到 4000 并以 … 收尾", async () => {
    const { runtime } = makeRuntime("dwf-progress-hole-noport");
    const captured = captureNotifications(runtime);

    await runtime.recordDynamicWorkflowRunProgress({
      ...reached,
      payload: { ...reached.payload, prompt: "问".repeat(5_000) },
    });

    expect(captured).toHaveLength(1);
    const meta = captured[0]?.originMeta?.workflowNotification as unknown as CapturedHoleMeta;
    expect(meta.type).toBe("unknown");
    expect("draftPath" in meta).toBe(false);
    expect("line" in meta).toBe(false);
    expect(meta.prompt?.length).toBe(4_000);
    expect(meta.prompt?.endsWith("…")).toBe(true);
    expect(captured[0]?.text).not.toContain("<draft>");
  });

  it("hole-filled 不产生通知；载荷缺 name 时跳过并留痕，事件照常落库", async () => {
    const { runtime, events } = makeRuntime("dwf-progress-hole-filled");
    const captured = captureNotifications(runtime);
    const logged = vi.fn();
    (runtime as unknown as { logger?: unknown }).logger = {
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      warn: logged,
    };

    await runtime.recordDynamicWorkflowRunProgress({
      runId: "dwfrun-hole",
      sequence: 22,
      eventType: "hole-filled",
      payload: { siteId: "hole#1", filledAt: 5, phaseNames: ["收集", "决定分组", "汇总"] },
    });
    await runtime.recordDynamicWorkflowRunProgress({
      ...reached,
      sequence: 23,
      payload: { instance: { siteId: "hole#1", ordinal: 2 } },
    });

    expect(captured).toHaveLength(0);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(
      events.filter((event) => event.type === SessionEventType.DynamicWorkflowRunProgress),
    ).toHaveLength(2);
  });
});

// 递归留白：嵌套站点 id（`hole#1/hole#1`）在载荷与文本里逐字出现，模型才能原样抄回 FillWorkflowHole。
describe("hole-reached → 嵌套 id 逐字透传", () => {
  it("载荷 siteId 与 <hole-id> / hole_id 都是嵌套 id 原文", async () => {
    const { runtime } = makeRuntime("dwf-progress-hole-nested");
    const captured = captureNotifications(runtime);
    attachHoleSnapshot(runtime, [
      {
        siteId: "hole#1/hole#1",
        ordinal: 1,
        name: "内层裁决",
        type: "Inner",
        state: "waiting",
        since: 7,
      },
    ]);
    await runtime.recordDynamicWorkflowRunProgress({
      ...reached,
      payload: { instance: { siteId: "hole#1/hole#1", ordinal: 1 }, name: "内层裁决" },
    });
    expect(captured).toHaveLength(1);
    const meta = captured[0]?.originMeta?.workflowNotification as unknown as CapturedHoleMeta;
    expect(meta).toMatchObject({
      kind: "hole",
      siteId: "hole#1/hole#1",
      type: "Inner",
      reachedAt: 7,
    });
    const text = captured[0]?.text ?? "";
    expect(text).toContain("<hole-id>hole#1/hole#1</hole-id>");
    expect(text).toContain('hole_id="hole#1/hole#1"');
  });
});
