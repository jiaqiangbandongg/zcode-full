// 缓存命中的结算（`node-settled { cached: true }`）在 workflowRuns 里的两件事
// （docs/dynamic-workflow/presentation.md「Reduction」与「Subagent transcripts」）：
//
//   1. **归属**：命中没有 node-queued，这条结算就是实例的出生事件，所以 ask 的那一条重发出生
//      事实（actor ref 等）。缺了它，一个全部 ask 都命中缓存的子代理在读面上就是「待开始」——
//      修订 run 从空表开始，没有任何上一世的条目可供向前携带。
//   2. **转录会话**：actor 的 `sessionId` 指向**持有它转录的那条会话**。导入命中不建会话，
//      交换只活在前驱的会话里（载荷的 `sourceSessionId`）；第一次 live 派发之后才轮到本 run 自己
//      的会话（种子已把前缀抄了进去）。
import { describe, expect, it } from "vitest";
import {
  WORKFLOW_RUNS_LIMITS,
  reduceWorkflowRunsState,
  workflowRunsStateSchema,
  type WorkflowRunEntryLimits,
  type WorkflowRunProgressEnvelope,
  type WorkflowRunState,
  type WorkflowRunsState,
} from "../src/zcode-protocol-v4/index.js";

const RUN_ID = "dwfrun-b";

function driver(limits: WorkflowRunEntryLimits = WORKFLOW_RUNS_LIMITS) {
  let sequence = -1;
  let state: WorkflowRunsState | undefined;
  return {
    send(
      eventType: string,
      payload: Record<string, unknown> = {},
      extra: Partial<WorkflowRunProgressEnvelope> = {},
    ): WorkflowRunProgressEnvelope {
      sequence += 1;
      const envelope: WorkflowRunProgressEnvelope = {
        runId: RUN_ID,
        toolCallId: "tc-1",
        sequence,
        eventType,
        payload,
        ...extra,
      };
      state = reduceWorkflowRunsState(state, envelope, limits) ?? state;
      return envelope;
    },
    replay(envelope: WorkflowRunProgressEnvelope): WorkflowRunsState | null {
      return reduceWorkflowRunsState(state, envelope, limits);
    },
    get run(): WorkflowRunState {
      return state!.runs[0]!;
    },
    get state(): WorkflowRunsState {
      return state!;
    },
  };
}

const actorRef = (index: number) => ({ siteId: `actor#${index}`, ordinal: 1 });
const askRef = (index: number, ordinal = 1) => ({ siteId: `ask#${index}`, ordinal });
/** 本 run 为这个子代理铸的会话 id（run service 的 mintActorSessionId 的替身）。 */
const ownSession = (index: number) => `sess-b-${index}`;
/** 前驱里持有这个子代理转录的会话（导入候选的 transcriptSourceSessionId）。 */
const predecessorSession = (index: number) => `sess-a-${index}`;

function createActor(driven: ReturnType<typeof driver>, index: number): void {
  driven.send(
    "actor-created",
    { actor: actorRef(index), name: `w${index}` },
    { actorSessionId: ownSession(index) },
  );
}

/** 引擎为一次缓存命中的 ask 发的那条结算：重发出生事实，导入命中另带前驱的会话。 */
function cachedAskSettle(
  driven: ReturnType<typeof driver>,
  index: number,
  options: { seq?: number; ordinal?: number; source?: string; outcome?: "ok" | "failed" } = {},
): WorkflowRunProgressEnvelope {
  return driven.send(
    "node-settled",
    {
      instance: askRef(index, options.ordinal),
      outcome: options.outcome ?? "ok",
      cached: true,
      kind: "ask",
      actor: actorRef(index),
      actorSeq: options.seq ?? 0,
      instructionsHead: `task ${index}`,
      ...(options.source === undefined ? {} : { sourceSessionId: options.source }),
    },
    { actorSessionId: ownSession(index) },
  );
}

function liveAsk(
  driven: ReturnType<typeof driver>,
  index: number,
  options: { ordinal?: number; seq?: number; settle?: boolean } = {},
): void {
  const instance = askRef(index, options.ordinal);
  driven.send("node-queued", {
    instance,
    kind: "ask",
    actor: actorRef(index),
    actorSeq: options.seq ?? 0,
  });
  driven.send(
    "node-dispatched",
    { instance, kind: "ask", actor: actorRef(index), actorName: `w${index}` },
    { actorSessionId: ownSession(index) },
  );
  driven.send("node-executing", { instance });
  if (options.settle !== false) driven.send("node-settled", { instance, outcome: "ok" });
}

const actorOf = (run: WorkflowRunState, index: number) =>
  run.actors.find((actor) => actor.siteId === `actor#${index}`);

describe("缓存命中的结算：出生事实让节点归属到它的子代理", () => {
  it("修订 run 的导入命中：节点带 actor、kind 与任务摘要，子代理在 run 还在跑时就已完成", () => {
    const driven = driver();
    driven.send("run-started", { caps: { maxConcurrency: 4 } });
    for (const index of [1, 2, 3]) createActor(driven, index);
    cachedAskSettle(driven, 1, { source: predecessorSession(1) });
    cachedAskSettle(driven, 2, { source: predecessorSession(2) });
    liveAsk(driven, 3, { settle: false });

    expect(driven.run.status).toBe("running");
    expect(driven.run.nodes[0]).toEqual({
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      phase: "settled",
      outcome: "ok",
      cached: true,
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      instructionsHead: "task 1",
    });
    // 两个全部命中的子代理干完了；第三个还在跑。缺归属时前两个会被派生成 waiting（「待开始」）。
    expect(driven.run.actors.map((actor) => actor.status)).toEqual([
      "completed",
      "completed",
      "running",
    ]);
    expect(workflowRunsStateSchema.safeParse(driven.state).success).toBe(true);
  });

  it("缓存命中不计步：nodesUsed 只数 live 派发", () => {
    const driven = driver();
    driven.send("run-started", {});
    createActor(driven, 1);
    cachedAskSettle(driven, 1, { source: predecessorSession(1) });
    expect(driven.run.usage.nodesUsed).toBe(0);
  });

  it("失败的缓存结算同样归属：子代理 completed，节点 outcome 保留", () => {
    const driven = driver();
    driven.send("run-started", {});
    createActor(driven, 1);
    cachedAskSettle(driven, 1, { outcome: "failed" });
    expect(driven.run.nodes[0]).toMatchObject({ actorSiteId: "actor#1", outcome: "failed" });
    expect(actorOf(driven.run, 1)?.status).toBe("completed");
  });

  it("老 journal 的缓存结算（不带 actor）照旧落成游离节点：子代理停在 waiting，会话不动", () => {
    const driven = driver();
    driven.send("run-started", {});
    createActor(driven, 1);
    driven.send("node-settled", { instance: askRef(1), outcome: "ok", cached: true });
    expect(driven.run.nodes[0]?.actorSiteId).toBeUndefined();
    expect(actorOf(driven.run, 1)).toMatchObject({
      status: "waiting",
      sessionId: ownSession(1),
    });
  });

  it("同一条结算重放一遍是 no-op（revision 不抬）", () => {
    const driven = driver();
    driven.send("run-started", {});
    createActor(driven, 1);
    const envelope = cachedAskSettle(driven, 1, { source: predecessorSession(1) });
    expect(driven.replay(envelope)).toBeNull();
  });
});

describe("缓存命中的结算：actor 的 sessionId 指向持有转录的会话", () => {
  it("导入命中：sessionId 换成前驱的会话（本 run 的那条从未建过）", () => {
    const driven = driver();
    driven.send("run-started", {});
    createActor(driven, 1);
    expect(actorOf(driven.run, 1)?.sessionId).toBe(ownSession(1));
    cachedAskSettle(driven, 1, { source: predecessorSession(1) });
    expect(actorOf(driven.run, 1)?.sessionId).toBe(predecessorSession(1));
  });

  it("导入命中之后分歧：第一次 live 派发把 sessionId 换回本 run 的会话（种子已抄入前缀）", () => {
    const driven = driver();
    driven.send("run-started", {});
    createActor(driven, 1);
    cachedAskSettle(driven, 1, { source: predecessorSession(1) });
    liveAsk(driven, 1, { ordinal: 2, seq: 1, settle: false });
    expect(actorOf(driven.run, 1)?.sessionId).toBe(ownSession(1));
  });

  it("普通 resume 的重放命中（不带 sourceSessionId）：本 run 的会话", () => {
    const driven = driver();
    driven.send("run-started", {});
    createActor(driven, 1);
    liveAsk(driven, 1);
    driven.send("run-settled", { status: "stopped", stopReason: "user", resumable: true });
    driven.send("run-started", {});
    createActor(driven, 1);
    cachedAskSettle(driven, 1);
    expect(actorOf(driven.run, 1)?.sessionId).toBe(ownSession(1));
    expect(actorOf(driven.run, 1)?.status).toBe("completed");
  });

  it("修订 run 崩溃后 resume：导入行的重放带前驱会话，其后 live 过的行不带——最后一条说了算", () => {
    const driven = driver();
    driven.send("run-started", {});
    createActor(driven, 1);
    // seq 0、1 是原次的导入命中，seq 2 原次 live 跑完（会话是本 run 的，种子里有前缀）。
    cachedAskSettle(driven, 1, { ordinal: 1, seq: 0, source: predecessorSession(1) });
    cachedAskSettle(driven, 1, { ordinal: 2, seq: 1, source: predecessorSession(1) });
    expect(actorOf(driven.run, 1)?.sessionId).toBe(predecessorSession(1));
    cachedAskSettle(driven, 1, { ordinal: 3, seq: 2 });
    expect(actorOf(driven.run, 1)?.sessionId).toBe(ownSession(1));
  });

  it("超界或非字符串的 sourceSessionId 整条丢弃：退回信封上本 run 的会话，不截断", () => {
    const driven = driver();
    driven.send("run-started", {});
    createActor(driven, 1);
    cachedAskSettle(driven, 1, {
      source: "s".repeat(WORKFLOW_RUNS_LIMITS.maxSessionIdLength + 1),
    });
    expect(actorOf(driven.run, 1)?.sessionId).toBe(ownSession(1));
    driven.send(
      "node-settled",
      {
        instance: askRef(1, 2),
        outcome: "ok",
        cached: true,
        kind: "ask",
        actor: actorRef(1),
        sourceSessionId: 42,
      },
      { actorSessionId: ownSession(1) },
    );
    expect(actorOf(driven.run, 1)?.sessionId).toBe(ownSession(1));
    expect(workflowRunsStateSchema.safeParse(driven.state).success).toBe(true);
  });

  it("两个 id 都没带的事件不动 sessionId（老 CLI 的派发与结算）", () => {
    const driven = driver();
    driven.send("run-started", {});
    createActor(driven, 1);
    cachedAskSettle(driven, 1, { source: predecessorSession(1) });
    driven.send("node-queued", {
      instance: askRef(1, 2),
      kind: "ask",
      actor: actorRef(1),
      actorSeq: 1,
    });
    driven.send("node-dispatched", { instance: askRef(1, 2), kind: "ask", actor: actorRef(1) });
    expect(actorOf(driven.run, 1)?.sessionId).toBe(predecessorSession(1));
  });

  it("没有 actor ref 的节点事件不碰任何 actor（world-read 的缓存结算）", () => {
    const driven = driver();
    driven.send("run-started", {});
    createActor(driven, 1);
    driven.send(
      "node-settled",
      { instance: { siteId: "world#1", ordinal: 1 }, outcome: "ok", cached: true },
      { actorSessionId: "sess-stray" },
    );
    expect(actorOf(driven.run, 1)?.sessionId).toBe(ownSession(1));
  });
});

describe("缓存命中的结算：溢出过的 run 里画不出徽章的出生照 B2 拒绝", () => {
  const LIMITS: WorkflowRunEntryLimits = { maxActors: 1, maxNodes: 3, maxPhases: 2 };

  it("子代理不在表上：结算被拒（哪怕节点表有空），计进表外，而不是留一行永远淘汰不掉的节点", () => {
    const driven = driver(LIMITS);
    driven.send("run-started", {});
    driven.send("phase-entered", { name: "p1", ordinal: 1 });
    createActor(driven, 1);
    liveAsk(driven, 1, { settle: false });
    // actor 表满、唯一的组在跑：第二个子代理出生即被拒，run 从此 truncated。
    driven.send(
      "actor-created",
      { actor: actorRef(2), name: "w2", phaseName: "p1" },
      { actorSessionId: ownSession(2) },
    );
    expect(driven.run.truncated).toBe(true);
    expect(driven.run.actors.map((actor) => actor.siteId)).toEqual(["actor#1"]);

    driven.send(
      "node-settled",
      {
        instance: askRef(2),
        outcome: "ok",
        cached: true,
        kind: "ask",
        actor: actorRef(2),
        actorSeq: 0,
        phaseName: "p1",
      },
      { actorSessionId: ownSession(2) },
    );
    expect(driven.run.nodes.map((node) => node.siteId)).toEqual(["ask#1"]);
    expect(driven.run.usage).toMatchObject({ nodesUnlisted: 1, nodesUnlistedSettled: 1 });
    // 子代理已作为 actors 计在它自己的出生阶段那一格；它的结算只记节点的 settled，不重复记人。
    expect(driven.run.unlistedByPhase).toEqual([{ phaseName: "p1", actors: 1, settled: 1 }]);
  });

  it("子代理在表上：照常入表并归属（B2 只拒画不出徽章的那一条）", () => {
    const driven = driver(LIMITS);
    driven.send("run-started", {});
    createActor(driven, 1);
    // 第二个子代理被拒，run truncated；随后已列的子代理 1 的缓存结算照常入座。
    createActor(driven, 2);
    expect(driven.run.truncated).toBe(true);
    cachedAskSettle(driven, 1, { source: predecessorSession(1) });
    expect(driven.run.nodes).toHaveLength(1);
    expect(driven.run.nodes[0]).toMatchObject({ actorSiteId: "actor#1", cached: true });
    expect(actorOf(driven.run, 1)?.sessionId).toBe(predecessorSession(1));
  });
});
