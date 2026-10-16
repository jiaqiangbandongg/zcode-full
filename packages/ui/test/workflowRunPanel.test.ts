// dwf run 详情页的纯逻辑：Cancel 可用性、结果/失败面板判定、事件日志行摘要。
// 全部无 jsdom、无组件——这些是详情页里唯一有"规则"的部分，穷举它们不需要渲染一张图。
// 见 docs/dynamic-workflow/presentation.md「The run pane」「Cancel 语义」「事件日志」。
import { describe, expect, it } from "vitest";
import type {
  WorkflowRunNode,
  WorkflowRunState,
  WorkflowRunActor,
} from "@zcode/shared/zcode-protocol-v4";
import {
  isWorkflowRunCancellable,
  isWorkflowRunResumable,
  workflowActorStartState,
  type WorkflowActorSlotRef,
  workflowRunEventLines,
  workflowRunResultView,
} from "@/app-shell/workflowRunPanel.js";
// 升级问答的规则住在同族的 workflowRunQuestions.ts（拆出去是为了守住 max-lines 门），
// 但它与上面那几组同属"详情页的纯规则"，所以钉在同一份用例里。
import { workflowRunQuestionWaitedLabel } from "@/app-shell/workflowRunQuestions.js";

/** 测试用 formatMessage：原样回 id，带插值时拼成 `id:v1/v2`，便于断言取到了哪个 key。 */
const format = (descriptor: { id: string }, values?: Record<string, string>) =>
  values ? `${descriptor.id}:${Object.values(values).join("/")}` : descriptor.id;

function run(overrides: Partial<WorkflowRunState> = {}): WorkflowRunState {
  return {
    runId: "dwfrun-1",
    status: "running",
    usage: { spentTokens: 0, nodesUsed: 0 },
    actors: [],
    nodes: [],
    lastEventSequence: 0,
    ...overrides,
  };
}

describe("isWorkflowRunCancellable", () => {
  it("只有 running 可取消", () => {
    expect(isWorkflowRunCancellable(run({ status: "running" }))).toBe(true);
    for (const status of ["pending", "completed", "errored", "stopped"] as const) {
      expect(isWorkflowRunCancellable(run({ status }))).toBe(false);
    }
  });

  it("run 不在投影里（被淘汰 / 冷启动）时不可取消", () => {
    expect(isWorkflowRunCancellable(undefined)).toBe(false);
  });
});

describe("workflowRunResultView", () => {
  it("pending / running 没有结果面板", () => {
    expect(workflowRunResultView(run({ status: "pending" })).kind).toBe("none");
    expect(workflowRunResultView(run({ status: "running" })).kind).toBe("none");
  });

  it("completed 且无 resultPreview 时只报完成、绝不编造结果", () => {
    // resultPreview 本阶段恒缺席（脚本产物只在 RunSettlement.artifact 里，既不在 run-settled
    // 事件上也不在 journal 里）。产物的去处是会话里那条后台结果轮，详情页只能指路。
    const view = workflowRunResultView(run({ status: "completed" }));
    expect(view).toEqual({ kind: "completed" });
  });

  it("completed 且真带 resultPreview 时如实展示（schema 允许，本阶段不可达）", () => {
    const view = workflowRunResultView(run({ status: "completed", resultPreview: "42 files" }));
    expect(view).toEqual({ kind: "completed", preview: "42 files" });
  });

  it("errored / stopped 报错误原文；error 缺省时仍进错误面板；stopped 带原因词", () => {
    expect(workflowRunResultView(run({ status: "errored", error: "boom" }))).toEqual({
      kind: "error",
      status: "errored",
      message: "boom",
    });
    expect(workflowRunResultView(run({ status: "stopped" }))).toEqual({
      kind: "error",
      status: "stopped",
    });
    expect(
      workflowRunResultView(run({ status: "stopped", stopReason: "provider", error: "expired" })),
    ).toEqual({ kind: "error", status: "stopped", stopReason: "provider", message: "expired" });
  });

  it("run 缺席时是 absent，而不是伪造一个 pending", () => {
    expect(workflowRunResultView(undefined)).toEqual({ kind: "absent" });
  });
});

// 待答问题的等待时长（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md）。`now` 由调用方注入而不是读时钟：
// 等待中的 run 恰恰不发事件，组件因此自己按固定间隔喂新的时刻，而规则留在这里可穷举。
describe("workflowRunQuestionWaitedLabel", () => {
  const NOW = 1_756_000_000_000;
  const MINUTE = 60_000;

  it("按分钟 / 小时 / 天分档，不足一分钟说「刚刚」", () => {
    const at = (elapsedMs: number) => workflowRunQuestionWaitedLabel(NOW - elapsedMs, NOW, format);
    expect(at(0)).toBe("sidePane.time.justNow");
    expect(at(59_999)).toBe("sidePane.time.justNow");
    expect(at(MINUTE)).toBe("sidePane.time.minutesAgo:1");
    expect(at(42 * MINUTE)).toBe("sidePane.time.minutesAgo:42");
    expect(at(59 * MINUTE + 59_999)).toBe("sidePane.time.minutesAgo:59");
    expect(at(60 * MINUTE)).toBe("sidePane.time.hoursAgo:1");
    expect(at(23 * 60 * MINUTE)).toBe("sidePane.time.hoursAgo:23");
    expect(at(24 * 60 * MINUTE)).toBe("sidePane.time.daysAgo:1");
    // 阶梯止于「天」：spec 否决了超时，一个问题按设计可以无限期等下去。
    expect(at(9 * 24 * 60 * MINUTE)).toBe("sidePane.time.daysAgo:9");
  });

  it("askedAt 缺席时整段不渲染，而不是编一个「刚刚」出来", () => {
    // 老 journal 重放出的事件没有这个字段。显示一个假的时刻比不显示更坏。
    expect(workflowRunQuestionWaitedLabel(undefined, NOW, format)).toBeUndefined();
    expect(workflowRunQuestionWaitedLabel(Number.NaN, NOW, format)).toBeUndefined();
  });

  it("时钟偏斜把 askedAt 推到未来时钳到「刚刚」，绝不给出负数时长", () => {
    // 提问时刻由 CLI 进程铸造；远端会话下它与渲染进程根本不是同一台机器。
    expect(workflowRunQuestionWaitedLabel(NOW + 5 * MINUTE, NOW, format)).toBe(
      "sidePane.time.justNow",
    );
  });
});

describe("workflowRunEventLines", () => {
  it("把引擎实际发出的每个种类摘成可读一行，而不是 dump JSON", () => {
    const lines = workflowRunEventLines(
      [
        {
          sequence: 1,
          type: "run-started",
          payload: { runId: "dwfrun-1", caps: { maxConcurrency: 8 } },
        },
        {
          sequence: 2,
          type: "actor-created",
          payload: { actor: { siteId: "actor#1", ordinal: 1 }, name: "planner" },
        },
        {
          sequence: 3,
          type: "node-queued",
          payload: { instance: { siteId: "ask#1", ordinal: 1 }, kind: "ask" },
        },
        {
          sequence: 4,
          type: "node-dispatched",
          payload: { instance: { siteId: "ask#1", ordinal: 1 } },
        },
        {
          sequence: 5,
          type: "node-repairing",
          payload: { instance: { siteId: "ask#1", ordinal: 1 }, attempt: 2, violations: [{}, {}] },
        },
        {
          sequence: 6,
          type: "node-nudged",
          payload: { instance: { siteId: "ask#1", ordinal: 1 } },
        },
        {
          sequence: 7,
          type: "node-settled",
          payload: { instance: { siteId: "ask#1", ordinal: 1 }, outcome: "ok" },
        },
        { sequence: 8, type: "usage-updated", payload: { spentTokens: 1_234 } },
        { sequence: 9, type: "log", payload: { message: "scanning workspace" } },
        {
          sequence: 10,
          type: "import-cache-closed",
          payload: { instance: { siteId: "ask#2", ordinal: 1 }, cause: "mutating-tool", actorName: "fixer" },
        },
        { sequence: 11, type: "run-settled", payload: { status: "completed" } },
      ],
      format,
    );

    expect(lines.map((line) => line.label)).toEqual([
      "chat.toolCall.workflow.run.event.runStarted",
      "chat.toolCall.workflow.run.event.actorCreated",
      "chat.toolCall.workflow.run.event.nodeQueued",
      "chat.toolCall.workflow.run.event.nodeDispatched",
      "chat.toolCall.workflow.run.event.nodeRepairing:2",
      "chat.toolCall.workflow.run.event.nodeNudged",
      "chat.toolCall.workflow.run.event.nodeSettled:chat.toolCall.workflow.run.outcome.ok",
      "chat.toolCall.workflow.run.event.usageUpdated",
      "chat.toolCall.workflow.run.event.log",
      "chat.toolCall.workflow.run.event.importCacheClosed",
      "chat.toolCall.workflow.run.event.runSettled:chat.toolCall.workflow.run.status.completed",
    ]);
    // 身份走 detail，label 只承担本地化的那半句。
    expect(lines[1]!.detail).toBe("planner · actor#1@1");
    // 关门事件点名谁写的：子代理名 + 实例；world.run 关的门只有实例。
    expect(lines[9]!.detail).toBe("fixer · ask#2@1");
    expect(lines[2]!.detail).toBe("ask#1@1 · ask");
    expect(lines[3]!.detail).toBe("ask#1@1");
    expect(lines[8]!.detail).toBe("scanning workspace");
    // 没有任何一行泄漏原始 JSON。
    for (const line of lines) expect(line.detail ?? "").not.toContain("{");
  });

  it("cached 命中在 settled 行上明说，failed 行带错误原文并标成失败色", () => {
    const [cached, failed] = workflowRunEventLines(
      [
        {
          sequence: 1,
          type: "node-settled",
          payload: { instance: { siteId: "ask#2", ordinal: 3 }, outcome: "ok", cached: true },
        },
        {
          sequence: 2,
          type: "node-settled",
          payload: {
            instance: { siteId: "ask#2", ordinal: 4 },
            outcome: "failed",
            error: { message: "schema mismatch" },
          },
        },
      ],
      format,
    );

    expect(cached!.label).toBe(
      "chat.toolCall.workflow.run.event.nodeSettledCached:chat.toolCall.workflow.run.outcome.ok",
    );
    expect(cached!.tone).toBe("default");
    expect(failed!.detail).toBe("ask#2@4 · schema mismatch");
    expect(failed!.tone).toBe("failed");
  });

  /**
   * 升级问答（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md）。两条都不能落进 unknown 兜底：它们是这个
   * 特性在审计面上仅有的两条痕迹，显示成「未知事件 escalation-raised」等于没实现。
   */
  it("升级两行自成一类：qid 打头（唯一的关联键），actor 名缺席时退回站点实例", () => {
    const [named, anonymous, answered] = workflowRunEventLines(
      [
        {
          sequence: 1,
          type: "escalation-raised",
          payload: {
            qid: "dwfq-dwfrun1-1",
            actor: { siteId: "actor#1", ordinal: 1 },
            actorName: "poet",
            question: "评分上限 95，门槛 96，这个门是不是坏了？",
          },
        },
        {
          sequence: 2,
          type: "escalation-raised",
          payload: {
            qid: "dwfq-dwfrun1-2",
            actor: { siteId: "actor#2", ordinal: 3 },
            question: "用哪版风格指南？",
          },
        },
        {
          sequence: 3,
          type: "escalation-resolved",
          payload: { qid: "dwfq-dwfrun1-1", answer: "门确实坏了，按 95 通过。" },
        },
      ],
      format,
    );

    expect(named!.label).toBe("chat.toolCall.workflow.run.event.escalationRaised");
    expect(named!.detail).toBe("dwfq-dwfrun1-1 · poet · 评分上限 95，门槛 96，这个门是不是坏了？");
    // 升级不是失败：actor 没出错，它在等一个答案。
    expect(named!.tone).toBe("default");
    // 匿名 actor 退回 `site@ordinal`——这一行宁可说 actor#2@3，也不能不说是谁。
    expect(anonymous!.detail).toBe("dwfq-dwfrun1-2 · actor#2@3 · 用哪版风格指南？");

    expect(answered!.label).toBe("chat.toolCall.workflow.run.event.escalationResolved");
    // resolved 只有 qid 与答案：它与提问那一行通常隔着几十行，qid 是唯一能把两者接上的东西。
    expect(answered!.detail).toBe("dwfq-dwfrun1-1 · 门确实坏了，按 95 通过。");
    expect(answered!.tone).toBe("default");
  });

  it("升级行的长正文按 detail 列的既有上限截断（完整正文归待答问题区）", () => {
    const long = "很长的问题".repeat(100);
    const [raised] = workflowRunEventLines(
      [
        {
          sequence: 1,
          type: "escalation-raised",
          payload: { qid: "dwfq-1", actor: { siteId: "a", ordinal: 1 }, question: long },
        },
      ],
      format,
    );
    expect(raised!.detail!.length).toBeLessThan(long.length);
    expect(raised!.detail!.endsWith("…")).toBe(true);
  });

  it("升级行的字段残缺时只丢那一截，不整行空白（有界化可能削掉深层字段）", () => {
    const [noActor, noAnswer] = workflowRunEventLines(
      [
        {
          sequence: 1,
          type: "escalation-raised",
          payload: { qid: "dwfq-1", question: "还在吗？" },
        },
        { sequence: 2, type: "escalation-resolved", payload: { qid: "dwfq-1" } },
      ],
      format,
    );
    expect(noActor!.detail).toBe("dwfq-1 · 还在吗？");
    expect(noAnswer!.detail).toBe("dwfq-1");
  });

  it("run-settled 的出错/停止同样标成失败色", () => {
    const [failed, cancelled] = workflowRunEventLines(
      [
        {
          sequence: 1,
          type: "run-settled",
          payload: { status: "errored", error: { message: "aborted by cap" } },
        },
        { sequence: 2, type: "run-settled", payload: { status: "stopped", stopReason: "user" } },
      ],
      format,
    );
    expect(failed!.tone).toBe("failed");
    expect(failed!.detail).toBe("aborted by cap");
    expect(cancelled!.tone).toBe("failed");
  });

  /**
   * report 有自己的一行，不能落进 unknown 兜底：spec 的 Invariants 明写 report 既进事件日志、
   * 也进 Results 区（而 `log` 只进事件日志），把它显示成「未知事件 report」是自相矛盾的。
   */
  it("report 自成一行：带实例，条目只给短摘要（完整预览归 Results 区）", () => {
    const [text, object, empty] = workflowRunEventLines(
      [
        {
          sequence: 1,
          type: "report",
          payload: { instance: { siteId: "report#1", ordinal: 1 }, item: "3 stale imports" },
        },
        {
          sequence: 2,
          type: "report",
          payload: { instance: { siteId: "report#2", ordinal: 4 }, item: { file: "a.ts" } },
        },
        { sequence: 3, type: "report", payload: { instance: { siteId: "report#3", ordinal: 1 } } },
      ],
      format,
    );

    expect(text!.label).toBe("chat.toolCall.workflow.run.event.report");
    expect(text!.detail).toBe("report#1@1 · 3 stale imports");
    expect(text!.tone).toBe("default");
    // object 压成单行 JSON（事件日志一行一条，多行 JSON 会把它撑成第二个产物视图）。
    expect(object!.detail).toBe('report#2@4 · {"file":"a.ts"}');
    // item 缺席（有界化削掉 / 脚本报了 undefined）时只剩身份，绝不空白。
    expect(empty!.detail).toBe("report#3@1");
  });

  it("phase-entered 自成一行：名字，第二次起带轮次", () => {
    const [first, second, bare] = workflowRunEventLines(
      [
        { sequence: 1, type: "phase-entered", payload: { name: "Verify", ordinal: 1 } },
        { sequence: 2, type: "phase-entered", payload: { name: "Verify", ordinal: 2 } },
        { sequence: 3, type: "phase-entered", payload: {} },
      ],
      format,
    );
    expect(first!.label).toBe("chat.toolCall.workflow.run.event.phaseEntered");
    expect(first!.detail).toBe("Verify");
    expect(second!.detail).toBe("Verify · 2");
    expect(bare!.detail).toBeUndefined();
    expect(bare!.tone).toBe("default");
  });

  it("未知种类退化成 type + 截断 JSON，既不崩也不假装认识它", () => {
    // compaction 是引擎为长上下文压缩预留的种类（v1 从不发出）。将来它一出现，
    // 事件日志必须仍然显示一条有信息量的行，而不是空白或异常。
    const [line] = workflowRunEventLines(
      [{ sequence: 1, type: "compaction", payload: { actor: { siteId: "actor#1", ordinal: 1 } } }],
      format,
    );
    expect(line!.label).toBe("chat.toolCall.workflow.run.event.unknown:compaction");
    expect(line!.detail).toContain("actor#1");
  });

  it("超长未知载荷被截断，不把整条 journal 灌进 DOM", () => {
    const [line] = workflowRunEventLines(
      [{ sequence: 1, type: "mystery", payload: { blob: "x".repeat(5_000) } }],
      format,
    );
    expect(line!.detail!.length).toBeLessThanOrEqual(200);
    expect(line!.detail!.endsWith("…")).toBe(true);
  });

  it("载荷形状不符时不抛异常（有界化可能已经削掉字段）", () => {
    const lines = workflowRunEventLines(
      [
        { sequence: 1, type: "node-settled", payload: {} },
        { sequence: 2, type: "actor-created", payload: { actor: "not-a-ref" } },
        { sequence: 3, type: "log", payload: {} },
      ],
      format,
    );
    expect(lines).toHaveLength(3);
    expect(lines.every((line) => typeof line.label === "string")).toBe(true);
  });

  it("truncated 事件原样透出标记，让读者知道原始事实要去 journal 取", () => {
    const [line] = workflowRunEventLines(
      [{ sequence: 9, type: "log", payload: { message: "partial" }, truncated: true }],
      format,
    );
    expect(line!.truncated).toBe(true);
    expect(line!.sequence).toBe(9);
  });
});

function actor(overrides: Partial<WorkflowRunActor> = {}): WorkflowRunActor {
  return {
    siteId: "actor#1",
    ordinal: 1,
    sessionId: "dwf-run1-actor_1@1",
    status: "waiting",
    ...overrides,
  };
}

describe("workflowActorStartState", () => {
  // actor 未启动门（docs/dynamic-workflow/presentation.md「Subagent transcripts」，身份改按槽位：
  // docs/dynamic-workflow/presentation.md「The pill」）。三值里最要紧的是 unknown 与
  // notStarted 的分界：拦错一格就把一份仍然可读的 transcript 关死，漏拦一格就回到那个死错误面板。
  const node = (overrides: Partial<WorkflowRunNode> = {}): WorkflowRunNode => ({
    siteId: "ask#1",
    ordinal: 1,
    phase: "queued",
    actorSiteId: "actor#1",
    actorOrdinal: 1,
    ...overrides,
  });
  const slot = (overrides: Partial<WorkflowActorSlotRef> = {}): WorkflowActorSlotRef => ({
    runId: "dwfrun-1",
    siteId: "actor#1",
    ordinal: 1,
    ...overrides,
  });

  it("actor 在投影里但一个节点都没有 → notStarted，会话 id 取投影", () => {
    const runs = [run({ actors: [actor({ sessionId: "s-a" })] })];
    expect(workflowActorStartState(runs, slot())).toEqual({
      state: "notStarted",
      sessionId: "s-a",
    });
  });

  it("只有 queued 节点 → notStarted：队列里的节点不构成会话已落库的证据", () => {
    // 持久化顺序的保证挂在「派发前」（workflow-driver 先 await 会话落库再首次派发），
    // 所以 queued 不能开门——那正是实测里点早了的那 5 秒。
    const runs = [
      run({ actors: [actor({ sessionId: "s-a" })], nodes: [node(), node({ ordinal: 2 })] }),
    ];
    expect(workflowActorStartState(runs, slot()).state).toBe("notStarted");
  });

  it("dispatched / repairing / nudged / settled（含 cached）都算 started，订阅投影里的会话", () => {
    for (const phase of ["dispatched", "repairing", "nudged", "settled"] as const) {
      const runs = [
        run({
          actors: [actor({ sessionId: "s-a" })],
          nodes: [node(), node({ ordinal: 2, phase })],
        }),
      ];
      expect(workflowActorStartState(runs, slot())).toEqual({ state: "started", sessionId: "s-a" });
    }
    // 缓存命中直接发 node-settled（不经 queued，也不经 ensureSession）：门照样打开，订阅的是
    // 投影里 actor 的 sessionId——reducer 让它指向持有转录的那条会话
    // （workflowCachedSettleAttribution.test.ts 走真实 reducer 钉住修订 run 的那一种）。
    const cached = [
      run({
        actors: [actor({ sessionId: "s-a" })],
        nodes: [node({ phase: "settled", outcome: "ok", cached: true })],
      }),
    ];
    expect(workflowActorStartState(cached, slot()).state).toBe("started");
  });

  it("actor 不在投影里、tab 带会话 id → unknown：run 被淘汰、冷恢复、投影整体缺席", () => {
    // tab 刻意没有 GC，比 8-run 淘汰活得久。这一格绝不能是 notStarted：那会把已完结 run
    // 的唯一持久视图关死，而直接订阅本来是能读到的。订阅目标就是 tab 带的那个 id。
    const expected = { state: "unknown", sessionId: "s-a" };
    const runs = [run({ actors: [actor({ ordinal: 2, sessionId: "s-other" })] })];
    expect(workflowActorStartState(runs, slot({ actorSessionId: "s-a" }))).toEqual(expected);
    expect(workflowActorStartState([], slot({ actorSessionId: "s-a" }))).toEqual(expected);
    expect(workflowActorStartState(undefined, slot({ actorSessionId: "s-a" }))).toEqual(expected);
    // 另一条 run 里的同名同序号不算命中：身份含 runId。
    const other = [
      run({
        runId: "dwfrun-2",
        actors: [actor({ sessionId: "s-a" })],
        nodes: [node({ phase: "dispatched" })],
      }),
    ];
    expect(workflowActorStartState(other, slot({ actorSessionId: "s-a" }))).toEqual(expected);
  });

  it("actor 不在投影里、tab 没有会话 id → notStarted：未启动药丸开的槽位，没有可订阅的东西", () => {
    expect(workflowActorStartState([run()], slot())).toEqual({ state: "notStarted" });
    expect(workflowActorStartState(undefined, slot())).toEqual({ state: "notStarted" });
  });

  it("投影里的会话 id 优先于 tab 带的；投影没有时才用 tab 的；两边都没有就只有处境", () => {
    const live = [
      run({ actors: [actor({ sessionId: "s-live" })], nodes: [node({ phase: "dispatched" })] }),
    ];
    expect(workflowActorStartState(live, slot({ actorSessionId: "s-stale" }))).toEqual({
      state: "started",
      sessionId: "s-live",
    });
    // sessionId 尚未落到投影上的 actor（schema-optional）：tab 带的兜底。
    const bare = [
      run({ actors: [actor({ sessionId: undefined })], nodes: [node({ phase: "dispatched" })] }),
    ];
    expect(workflowActorStartState(bare, slot({ actorSessionId: "s-tab" }))).toEqual({
      state: "started",
      sessionId: "s-tab",
    });
    expect(workflowActorStartState(bare, slot())).toEqual({ state: "started" });
  });

  it("跨多 run 按 runId 命中正确的 actor，而不是同名同序号的邻居", () => {
    const runs = [
      run({
        runId: "dwfrun-1",
        actors: [actor({ sessionId: "s-a" })],
        nodes: [node({ phase: "dispatched" })],
      }),
      run({
        runId: "dwfrun-2",
        actors: [actor({ sessionId: "s-b" })],
        nodes: [node()],
      }),
    ];
    expect(workflowActorStartState(runs, slot({ runId: "dwfrun-1" }))).toEqual({
      state: "started",
      sessionId: "s-a",
    });
    // 同一个 siteId@ordinal，另一条 run：节点只在第一条 run 里派发过。
    expect(workflowActorStartState(runs, slot({ runId: "dwfrun-2" }))).toEqual({
      state: "notStarted",
      sessionId: "s-b",
    });
  });

  it("别的 actor 的节点、以及无 actor 的 world-read 节点，都不算它启动了", () => {
    const runs = [
      run({
        actors: [actor({ sessionId: "s-a" }), actor({ ordinal: 2, sessionId: "s-b" })],
        nodes: [
          // 同站点、另一个序号：实例是身份的一部分，序号错了就是另一个人。
          node({ phase: "dispatched", actorOrdinal: 2 }),
          // world-read 没有 actor 归属，不给任何人开门。
          node({
            siteId: "world-read#1",
            phase: "settled",
            actorSiteId: undefined,
            actorOrdinal: undefined,
          }),
        ],
      }),
    ];
    expect(workflowActorStartState(runs, slot()).state).toBe("notStarted");
    expect(workflowActorStartState(runs, slot({ ordinal: 2 })).state).toBe("started");
  });
});

// Resume 可用性（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md；docs/dynamic-workflow/presentation.md
// 2026-09-09「冷回放」）：一个信源——投影 run 的 `resumable` 状态位，由 CLI 按 resume 门的同一个
// 谓词算好并经 run-settled 载荷落进状态；UI 绝不自行按 status + failureCode 推导。
describe("isWorkflowRunResumable", () => {
  it("状态位在场 → 可恢复，无论 stopped 的原因是什么", () => {
    expect(isWorkflowRunResumable(run({ status: "stopped", resumable: true }))).toBe(true);
    expect(
      isWorkflowRunResumable(
        run({ status: "stopped", stopReason: "interrupted", resumable: true }),
      ),
    ).toBe(true);
  });

  it("状态位缺席 → 不可恢复，哪怕 status 是 stopped（旧 CLI 不发该位；宁可少一个按钮）", () => {
    for (const status of ["pending", "running", "completed", "errored", "stopped"] as const) {
      expect(isWorkflowRunResumable(run({ status }))).toBe(false);
    }
  });

  it("投影缺席（被淘汰）→ 不可恢复", () => {
    expect(isWorkflowRunResumable(undefined)).toBe(false);
  });
});
