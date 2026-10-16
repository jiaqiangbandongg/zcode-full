// workflowRuns 的纯归约（workflow-runs-reducer.ts）。
// 这份归约此前长在 bootstrap 的 v4 product-projection 里，抽出来给 TUI 镜像共用
// （docs/dynamic-workflow/launch.md「The inline card」）。
//
// 桌面/协议侧的等价性由 bootstrap 的 product-projection*.test.ts 背书（断言未改）；
// 本文件钉的是 reducer 自己的契约：逐事件归约、有界化、淘汰、revision 单调、派生 actor 状态、
// 幂等重放。所有 case 都只调纯函数，不涉及投影、时钟或 I/O。
import { describe, expect, it } from "vitest";
import {
  WORKFLOW_RUNS_LIMITS,
  reduceWorkflowRunsState,
  workflowRunsStateSchema,
  type WorkflowRunProgressEnvelope,
  type WorkflowRunsState,
} from "../src/zcode-protocol-v4/index.js";

const RUN_ID = "dwfrun-1";

/** 逐条归约一串事件；null（无变化）时保持上一态，与投影"不产 delta"同义。 */
function reduceAll(
  envelopes: readonly WorkflowRunProgressEnvelope[],
  initial?: WorkflowRunsState,
): WorkflowRunsState | undefined {
  let state = initial;
  for (const envelope of envelopes) {
    state = reduceWorkflowRunsState(state, envelope) ?? state;
  }
  return state;
}

/**
 * 归约一条**预期确实产生变化**的事件。
 *
 * reducer 的 `previous` 收 `| undefined` 而返回 `| null`，链式调用因此不能直接接——这是刻意的：
 * "无变化"必须被调用方显式处理，不能顺手当成空态传下去（那会把状态整片抹掉）。
 */
function step(
  state: WorkflowRunsState | undefined,
  envelope: WorkflowRunProgressEnvelope,
): WorkflowRunsState {
  const next = reduceWorkflowRunsState(state, envelope);
  if (next === null) throw new Error(`事件本应产生变化却返回 null：${envelope.eventType}`);
  return next;
}

/** 事件信封工厂：sequence 按调用序自增，模拟 journal 的单调分配。 */
function progressLog(runId = RUN_ID) {
  let sequence = -1;
  return function progress(
    eventType: string,
    payload: Record<string, unknown> = {},
    extra: Partial<WorkflowRunProgressEnvelope> = {},
  ): WorkflowRunProgressEnvelope {
    sequence += 1;
    return { runId, toolCallId: "tc-1", sequence, eventType, payload, ...extra };
  };
}

const started = (caps: Record<string, unknown> = { maxConcurrency: 4 }) => ({
  caps,
  runId: RUN_ID,
});

describe("reduceWorkflowRunsState：逐事件归约", () => {
  it("run-started 建条目：running + 零用量，产出过 strict schema", () => {
    const progress = progressLog();
    const state = reduceWorkflowRunsState(
      undefined,
      progress("run-started", started({ maxConcurrency: 2 })),
    );
    expect(state).toEqual({
      revision: 1,
      runs: [
        {
          runId: RUN_ID,
          toolCallId: "tc-1",
          status: "running",
          usage: { spentTokens: 0, nodesUsed: 0 },
          actors: [],
          nodes: [],
          lastEventSequence: 0,
        },
      ],
    });
    expect(workflowRunsStateSchema.safeParse(state).success).toBe(true);
  });

  it("run-started 只从 caps 里读并发界：用量与步数从零起，caps 里没有任何用量上限可用", () => {
    const progress = progressLog();
    const state = reduceWorkflowRunsState(undefined, progress("run-started", started()));
    expect(state?.runs[0]?.usage).toEqual({ spentTokens: 0, nodesUsed: 0 });
    expect(state?.runs[0]).not.toHaveProperty("budget");
    // 载荷不带 concurrencyCeiling（老 CLI）：读不出天花板就无从判断这个 run 是否被压低。
    expect(state?.runs[0]).not.toHaveProperty("concurrency");
  });

  it("节点相位按 (siteId, ordinal) upsert：四条事件一个条目", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("node-queued", {
        instance: { siteId: "ask#1", ordinal: 1 },
        kind: "ask",
        actor: { siteId: "actor#1", ordinal: 1 },
      }),
      progress("node-dispatched", { instance: { siteId: "ask#1", ordinal: 1 } }),
      progress("node-repairing", { instance: { siteId: "ask#1", ordinal: 1 }, attempt: 1 }),
      progress("node-settled", { instance: { siteId: "ask#1", ordinal: 1 }, outcome: "ok" }),
    ]);
    expect(state?.runs[0]?.nodes).toEqual([
      {
        siteId: "ask#1",
        ordinal: 1,
        // kind 只在 queued 上携带，后续相位从上一条继承。
        kind: "ask",
        phase: "settled",
        outcome: "ok",
        // actor 归属同理继承——dispatched/settled 不重复带 actor。
        actorSiteId: "actor#1",
        actorOrdinal: 1,
      },
    ]);
  });

  it("cached 命中直接发 node-settled（不经 queued），kind 缺省而条目仍成立", () => {
    // engine.ts:228/232 —— resume 的完结命中短路，kind 因此不可观察。
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("node-settled", {
        instance: { siteId: "world-read#1", ordinal: 1 },
        outcome: "ok",
        cached: true,
      }),
    ]);
    expect(state?.runs[0]?.nodes).toEqual([
      { siteId: "world-read#1", ordinal: 1, phase: "settled", outcome: "ok", cached: true },
    ]);
  });

  it("用量：spentTokens 直接取 usage-updated 载荷，nodesUsed 按首次派发计步", () => {
    // docs/dynamic-workflow/authoring.md：事件携带已花总量（与 dwf_run.spent_tokens 同步写入）。
    const progress = progressLog();
    const dispatched = (siteId: string) => [
      progress("node-queued", {
        instance: { siteId, ordinal: 1 },
        kind: "ask",
        actor: { siteId: "actor#1", ordinal: 1 },
      }),
      progress("node-dispatched", { instance: { siteId, ordinal: 1 } }),
    ];
    const state = reduceAll([
      progress("run-started", started()),
      progress("actor-created", { actor: { siteId: "actor#1", ordinal: 1 } }),
      ...dispatched("ask#1"),
      progress("usage-updated", { spentTokens: 1_234 }),
      ...dispatched("ask#2"),
      ...dispatched("ask#3"),
      progress("usage-updated", { spentTokens: 2_000 }),
    ]);
    expect(state?.runs[0]?.usage).toEqual({ spentTokens: 2_000, nodesUsed: 3 });
  });

  it("步数幂等：同一实例的 node-dispatched 重放不重复计步；usage-updated 缺载荷时保持已知值", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("node-queued", { instance: { siteId: "ask#1", ordinal: 1 }, kind: "ask" }),
      progress("node-dispatched", { instance: { siteId: "ask#1", ordinal: 1 } }),
      progress("node-dispatched", { instance: { siteId: "ask#1", ordinal: 1 } }),
      progress("node-executing", { instance: { siteId: "ask#1", ordinal: 1 } }),
      progress("usage-updated", { spentTokens: 9 }),
      progress("usage-updated", {}),
    ]);
    expect(state?.runs[0]?.usage).toEqual({ spentTokens: 9, nodesUsed: 1 });
  });

  it("run-settled 落终态与错误文案，且错误按上限截断", () => {
    const progress = progressLog();
    const long = "长".repeat(WORKFLOW_RUNS_LIMITS.maxErrorLength + 50);
    const state = reduceAll([
      progress("run-started", started()),
      progress("run-settled", {
        status: "errored",
        error: { code: "ReportCapExceeded", message: long },
      }),
    ]);
    expect(state?.runs[0]?.status).toBe("errored");
    expect(state?.runs[0]?.error).toHaveLength(WORKFLOW_RUNS_LIMITS.maxErrorLength);
    expect(workflowRunsStateSchema.safeParse(state).success).toBe(true);
  });

  // 修复原因（2026-09-15）：闭集之外的词过去「一律忽略」，2026-09-14 之前 journal 里的
  // run-settled{cancelled|failed} 冷回放后把 run 留在 running。结算到了 run 就不能再活着。
  it("run-settled 的未知 status → errored 落终态，文案说明是哪个词，不亮 Resume", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("run-settled", { status: "exploded" }),
    ]);
    expect(state?.runs[0]?.status).toBe("errored");
    expect(state?.runs[0]?.error).toContain("exploded");
    expect(state?.runs[0]?.resumable).toBeUndefined();
    expect(workflowRunsStateSchema.safeParse(state).success).toBe(true);
  });

  it.each(["cancelled", "failed"] as const)(
    "旧词表 run-settled{%s}（2026-09-14 之前的 journal）→ errored，保留事件自带的文案",
    (status) => {
      const progress = progressLog();
      const state = reduceAll([
        progress("run-started", started()),
        progress("run-settled", { status, error: { code: "DriverError", message: "old words" } }),
      ]);
      expect(state?.runs[0]?.status).toBe("errored");
      expect(state?.runs[0]?.error).toBe("old words");
    },
  );

  it("同 runId 再收 run-started：清掉上一世的 error / resultPreview（进程内 cancel→resume）", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("run-settled", {
        status: "stopped",
        stopReason: "interrupted",
        error: { code: "Interrupted", message: "owner exited" },
      }),
      progress("run-started", started()),
    ]);
    expect(state?.runs).toHaveLength(1);
    expect(state?.runs[0]).toMatchObject({ runId: RUN_ID, status: "running" });
    expect(state?.runs[0]?.error).toBeUndefined();
    expect(state?.runs[0]?.resultPreview).toBeUndefined();
    // 上一世的停止原因同属结算残影。
    expect(state?.runs[0]?.stopReason).toBeUndefined();
  });

  it("log / compaction 不进图，但仍抬 lastEventSequence（事件日志需要知道有新内容）", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("log", { message: "开始" }),
    ]);
    expect(state?.runs[0]?.nodes).toEqual([]);
    expect(state?.runs[0]?.actors).toEqual([]);
    expect(state?.runs[0]?.lastEventSequence).toBe(1);
  });

  it("缺 runId 或 eventType 的信封整条无效，返回 null", () => {
    expect(
      reduceWorkflowRunsState(undefined, { eventType: "run-started", sequence: 0 }),
    ).toBeNull();
    expect(reduceWorkflowRunsState(undefined, { runId: RUN_ID, sequence: 0 })).toBeNull();
  });

  it("无法定位的 instance / actor 不建条目，只抬水位", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      // ordinal 缺席 → 无法定位。
      progress("node-queued", { instance: { siteId: "ask#1" }, kind: "ask" }),
      progress("actor-created", { actor: { ordinal: 1 }, name: "planner" }),
    ]);
    expect(state?.runs[0]?.nodes).toEqual([]);
    expect(state?.runs[0]?.actors).toEqual([]);
    expect(state?.runs[0]?.lastEventSequence).toBe(2);
  });

  // Bugfix 2026-09-04：脚本把文件路径拼成 131 字的子代理名，reducer 原样透传，而线上 schema 把
  // `actor.name` 钉在 128——于是父会话之后的每一帧（online / recovery / initial）都被渲染端拒收，
  // 订阅以 fault.subscription.recoveryFailed 失效。生产者必须先按 schema 界裁剪。
  it("子代理名超过线上上界时按上界裁剪，归约结果始终通过 schema", () => {
    const progress = progressLog();
    const longName = `reader-${"sections-x.tex+".repeat(12)}`;
    expect(longName.length).toBeGreaterThan(WORKFLOW_RUNS_LIMITS.maxActorNameLength);
    const state = reduceAll([
      progress("run-started", started()),
      progress("actor-created", { actor: { siteId: "actor#1", ordinal: 6 }, name: longName }),
      progress("escalation-raised", {
        qid: "q-1",
        question: "路径读不到",
        actor: { siteId: "actor#1", ordinal: 6 },
        actorName: longName,
      }),
    ]);
    const run = state?.runs[0];
    expect(run?.actors[0]?.name).toBe(longName.slice(0, WORKFLOW_RUNS_LIMITS.maxActorNameLength));
    expect(run?.pendingQuestions?.[0]?.actorName).toBe(
      longName.slice(0, WORKFLOW_RUNS_LIMITS.maxActorNameLength),
    );
    expect(workflowRunsStateSchema.safeParse(state).success).toBe(true);
  });

  it("首见事件不是 run-started 时条目落 pending（引擎事件流被截断的中途接入）", () => {
    const state = reduceWorkflowRunsState(undefined, {
      runId: RUN_ID,
      sequence: 7,
      eventType: "log",
      payload: { message: "中途接入" },
    });
    expect(state?.runs[0]).toMatchObject({ status: "pending", lastEventSequence: 7 });
    expect(state?.runs[0]).not.toHaveProperty("toolCallId");
  });

  it("toolCallId 只在首次出现时补齐，之后不被后续事件改写", () => {
    const first = step(undefined, {
      runId: RUN_ID,
      sequence: 0,
      eventType: "run-started",
      payload: started(),
    });
    expect(first.runs[0]).not.toHaveProperty("toolCallId");
    const withTool = step(first, {
      runId: RUN_ID,
      toolCallId: "tc-late",
      sequence: 1,
      eventType: "log",
      payload: {},
    });
    expect(withTool.runs[0]?.toolCallId).toBe("tc-late");
    const relabeled = step(withTool, {
      runId: RUN_ID,
      toolCallId: "tc-other",
      sequence: 2,
      eventType: "log",
      payload: {},
    });
    expect(relabeled.runs[0]?.toolCallId).toBe("tc-late");
  });
});

// lineage 的两端（docs/dynamic-workflow/presentation.md「The run card」）：`run-started` 带 resumedFrom，
// `run-settled` 只在 superseded 时带 supersededBy；reducer 只搬运，两者都过 strict schema。
describe("reduceWorkflowRunsState：lineage", () => {
  it("run-started 的 resumedFrom 与 run-settled 的 supersededBy 都进状态", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", { ...started(), resumedFrom: "dwfrun-prev" }),
      progress("run-settled", {
        status: "stopped",
        stopReason: "superseded",
        supersededBy: "dwfrun-next",
      }),
    ]);
    expect(state?.runs[0]).toMatchObject({
      status: "stopped",
      stopReason: "superseded",
      resumedFrom: "dwfrun-prev",
      supersededBy: "dwfrun-next",
    });
    // 被替代的 run 不可恢复：CLI 不发 resumable，这里也没有。
    expect(state?.runs[0]?.resumable).toBeUndefined();
    expect(workflowRunsStateSchema.safeParse(state).success).toBe(true);
  });

  it("supersededBy 只随 superseded 搬运；没有 lineage 的 run 两个键都缺席", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("run-settled", { status: "stopped", stopReason: "user", supersededBy: "dwfrun-x" }),
    ]);
    expect(state?.runs[0]?.supersededBy).toBeUndefined();
    expect(state?.runs[0]?.resumedFrom).toBeUndefined();
  });
});

// resumable 状态位（docs/dynamic-workflow/presentation.md「Cold replay」）：CLI 在 run-settled
// 载荷上按 resume 门裁定，reducer 只搬运——为真才在场，UI 与 TUI 绝不按 status 重推导。
describe("reduceWorkflowRunsState：resumable 状态位", () => {
  it("run-settled 携 resumable: true → 状态位在场，且过 strict schema", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("run-settled", {
        status: "stopped",
        stopReason: "interrupted",
        error: { code: "Interrupted", message: "owning process exited" },
        resumable: true,
      }),
    ]);
    expect(state?.runs[0]).toMatchObject({
      status: "stopped",
      stopReason: "interrupted",
      resumable: true,
    });
    expect(workflowRunsStateSchema.safeParse(state).success).toBe(true);
  });

  it("run-settled 不携该位（或携 false）→ 键缺席，哪怕 status 是 stopped", () => {
    const progress = progressLog();
    const stopped = reduceAll([
      progress("run-started", started()),
      progress("run-settled", { status: "stopped", stopReason: "user" }),
    ]);
    expect(stopped?.runs[0]?.resumable).toBeUndefined();
    const explicit = reduceAll([
      progress("run-started", started()),
      progress("run-settled", { status: "errored", resumable: false }),
    ]);
    expect(explicit?.runs[0]?.resumable).toBeUndefined();
  });

  // 停止原因（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md）：只在 stopped 上搬运，闭集之外与其余
  // 终态上的 stopReason 一律丢弃——reducer 不替 CLI 编原因。
  it("run-settled 的 stopReason 只在 stopped 上搬运，且只收四个值", () => {
    const progress = progressLog();
    for (const stopReason of ["user", "model", "provider", "interrupted"] as const) {
      const state = reduceAll([
        progress("run-started", started()),
        progress("run-settled", { status: "stopped", stopReason, resumable: true }),
      ]);
      expect(state?.runs[0]).toMatchObject({ status: "stopped", stopReason });
      expect(workflowRunsStateSchema.safeParse(state).success).toBe(true);
    }
    const bogus = reduceAll([
      progress("run-started", started()),
      progress("run-settled", { status: "stopped", stopReason: "crash" }),
    ]);
    expect(bogus?.runs[0]?.status).toBe("stopped");
    expect(bogus?.runs[0]?.stopReason).toBeUndefined();
    const errored = reduceAll([
      progress("run-started", started()),
      progress("run-settled", { status: "errored", stopReason: "user" }),
    ]);
    expect(errored?.runs[0]?.stopReason).toBeUndefined();
  });

  it("run-stalled 是纯观察事件：不改 run 的任何状态键", () => {
    const progress = progressLog();
    const before = reduceAll([progress("run-started", started())]);
    const after = reduceAll(
      [progress("run-stalled", { sinceMs: 1_200_000, reason: "rate_limited", cap: 2 })],
      before,
    );
    expect(after?.runs[0]?.status).toBe("running");
    expect(workflowRunsStateSchema.safeParse(after).success).toBe(true);
  });

  it("同 runId 再收 run-started（resume 开跑）→ 上一世的 resumable 随 error 一起清掉", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("run-settled", { status: "stopped", stopReason: "user", resumable: true }),
      progress("run-started", started()),
    ]);
    expect(state?.runs[0]).toMatchObject({ status: "running" });
    expect(state?.runs[0]?.resumable).toBeUndefined();
  });
});

describe("reduceWorkflowRunsState：派生 actor 状态", () => {
  it("actor 状态由自己名下节点的相位派生（有在飞节点 → running）", () => {
    // Boundary C 除 actor-created 外不发 actor 生命周期事件，所以状态只能派生。
    const progress = progressLog();
    const created = reduceAll([
      progress("run-started", started()),
      progress(
        "actor-created",
        { actor: { siteId: "actor#1", ordinal: 1 }, name: "planner" },
        { actorSessionId: "sess_dwf-1-actor.1" },
      ),
    ]);
    expect(created?.runs[0]?.actors).toEqual([
      {
        siteId: "actor#1",
        ordinal: 1,
        name: "planner",
        sessionId: "sess_dwf-1-actor.1",
        // 建了还没被 ask、run 未终态：等待中（决策 39）。
        status: "waiting",
      },
    ]);

    const dispatched = reduceAll(
      [
        progress("node-queued", {
          instance: { siteId: "ask#1", ordinal: 1 },
          kind: "ask",
          actor: { siteId: "actor#1", ordinal: 1 },
        }),
        progress("node-dispatched", { instance: { siteId: "ask#1", ordinal: 1 } }),
      ],
      created,
    );
    // dispatched 只是「会话就绪、首个请求尚未准入」：仍是等待；真正在跑由 node-executing 说。
    expect(dispatched?.runs[0]?.actors[0]?.status).toBe("waiting");

    const executing = reduceAll(
      [progress("node-executing", { instance: { siteId: "ask#1", ordinal: 1 } })],
      dispatched,
    );
    expect(executing?.runs[0]?.actors[0]?.status).toBe("running");

    const settled = reduceAll(
      [progress("node-settled", { instance: { siteId: "ask#1", ordinal: 1 }, outcome: "ok" })],
      executing,
    );
    expect(settled?.runs[0]?.actors[0]?.status).toBe("completed");
  });

  it("executing / repairing / nudged 算在跑；queued / dispatched / waiting 算在等", () => {
    const progress = progressLog();
    const base = reduceAll([
      progress("run-started", started()),
      progress("actor-created", { actor: { siteId: "actor#1", ordinal: 1 } }),
      progress("node-queued", {
        instance: { siteId: "ask#1", ordinal: 1 },
        kind: "ask",
        actor: { siteId: "actor#1", ordinal: 1 },
      }),
    ]);
    expect(base?.runs[0]?.actors[0]?.status).toBe("waiting");
    for (const phase of ["executing", "repairing", "nudged"] as const) {
      const busy = reduceAll(
        [progress(`node-${phase}`, { instance: { siteId: "ask#1", ordinal: 1 } })],
        base,
      );
      expect(busy?.runs[0]?.actors[0]?.status).toBe("running");
    }
    for (const phase of ["dispatched", "waiting"] as const) {
      const idle = reduceAll(
        [progress(`node-${phase}`, { instance: { siteId: "ask#1", ordinal: 1 } })],
        base,
      );
      expect(idle?.runs[0]?.actors[0]?.status).toBe("waiting");
    }
  });

  it("失败的 ask 也是「干完了」：completed 不区分 outcome（结果在节点上）", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("actor-created", { actor: { siteId: "actor#1", ordinal: 1 } }),
      progress("node-queued", {
        instance: { siteId: "ask#1", ordinal: 1 },
        kind: "ask",
        actor: { siteId: "actor#1", ordinal: 1 },
      }),
      progress("node-executing", { instance: { siteId: "ask#1", ordinal: 1 } }),
      progress("node-settled", { instance: { siteId: "ask#1", ordinal: 1 }, outcome: "failed" }),
    ]);
    expect(state?.runs[0]?.actors[0]?.status).toBe("completed");
  });

  it("run 终态让每个 actor 都变 completed——包括建了却从未被 ask 的、和节点还挂在 queued 上的", () => {
    const progress = progressLog();
    const running = reduceAll([
      progress("run-started", started()),
      progress("actor-created", { actor: { siteId: "actor#1", ordinal: 1 } }),
      progress("actor-created", { actor: { siteId: "actor#2", ordinal: 1 } }),
      progress("node-queued", {
        instance: { siteId: "ask#1", ordinal: 1 },
        kind: "ask",
        actor: { siteId: "actor#1", ordinal: 1 },
      }),
    ]);
    expect(running?.runs[0]?.actors.map((actor) => actor.status)).toEqual(["waiting", "waiting"]);
    for (const status of ["completed", "errored", "stopped"] as const) {
      const settled = reduceAll([progress("run-settled", { status })], running);
      expect(settled?.runs[0]?.actors.map((actor) => actor.status)).toEqual([
        "completed",
        "completed",
      ]);
    }
  });

  it("无 actor 归属的节点（world-read）不会把任何 actor 点亮", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("actor-created", { actor: { siteId: "actor#1", ordinal: 1 } }),
      progress("node-executing", { instance: { siteId: "world-read#1", ordinal: 1 } }),
    ]);
    expect(state?.runs[0]?.actors[0]?.status).toBe("waiting");
  });

  it("同 siteId 的不同 ordinal 是不同 actor：一个在飞不点亮另一个", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("actor-created", { actor: { siteId: "actor#1", ordinal: 1 } }),
      progress("actor-created", { actor: { siteId: "actor#1", ordinal: 2 } }),
      progress("node-executing", {
        instance: { siteId: "ask#1", ordinal: 1 },
        actor: { siteId: "actor#1", ordinal: 2 },
      }),
    ]);
    expect(state?.runs[0]?.actors.map((actor) => [actor.ordinal, actor.status])).toEqual([
      [1, "waiting"],
      [2, "running"],
    ]);
  });

  it("派生键有分隔符：(a,12) 与 (a1,2) 是两个 actor，不互相点亮", () => {
    // 这一对是**裸拼接会撞车**的最小反例："a"+12 与 "a1"+2 都等于 "a12"。
    // 归约用 `${siteId}\0${ordinal}` 做键（搬移时保留原实现的 NUL 分隔符语义，只把源码里的
    // 裸 NUL 字节写成转义 `\0`——同一个运行时字符。上面那条同 siteId 用例换成任何分隔符、
    // 甚至不加分隔符都能过，所以真正钉住分隔符存在的是这一条）。
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("actor-created", { actor: { siteId: "a", ordinal: 12 } }),
      progress("actor-created", { actor: { siteId: "a1", ordinal: 2 } }),
      // 只有 ("a1", 2) 名下有在跑节点。
      progress("node-executing", {
        instance: { siteId: "ask#1", ordinal: 1 },
        actor: { siteId: "a1", ordinal: 2 },
      }),
    ]);
    expect(
      state?.runs[0]?.actors.map((actor) => [actor.siteId, actor.ordinal, actor.status]),
    ).toEqual([
      ["a", 12, "waiting"],
      ["a1", 2, "running"],
    ]);
  });
});

describe("reduceWorkflowRunsState：有界化与淘汰", () => {
  it("nodes 触上限置 truncated 且不再增长，但已在表内的实例仍可更新相位", () => {
    const progress = progressLog();
    let state: WorkflowRunsState | undefined = step(undefined, progress("run-started", started()));
    for (let ordinal = 1; ordinal <= WORKFLOW_RUNS_LIMITS.maxNodes + 5; ordinal += 1) {
      state = reduceAll(
        [progress("node-queued", { instance: { siteId: "ask#1", ordinal }, kind: "ask" })],
        state,
      );
    }
    expect(state?.runs[0]?.nodes).toHaveLength(WORKFLOW_RUNS_LIMITS.maxNodes);
    expect(state?.runs[0]?.truncated).toBe(true);

    // 超界只拒绝**新**实例：把在跑的实例冻结在 queued 上比少列一个更误导人。
    const updated = reduceAll(
      [progress("node-dispatched", { instance: { siteId: "ask#1", ordinal: 1 } })],
      state,
    );
    expect(updated?.runs[0]?.nodes[0]?.phase).toBe("dispatched");
    expect(workflowRunsStateSchema.safeParse(updated).success).toBe(true);
  });

  it("actors 触上限同样置 truncated，且 truncated 一旦置位不再回落", () => {
    const progress = progressLog();
    let state: WorkflowRunsState | undefined = step(undefined, progress("run-started", started()));
    for (let ordinal = 1; ordinal <= WORKFLOW_RUNS_LIMITS.maxActors + 2; ordinal += 1) {
      state = reduceAll(
        [progress("actor-created", { actor: { siteId: "actor#1", ordinal } })],
        state,
      );
    }
    expect(state?.runs[0]?.actors).toHaveLength(WORKFLOW_RUNS_LIMITS.maxActors);
    expect(state?.runs[0]?.truncated).toBe(true);

    const later = reduceAll(
      [progress("node-queued", { instance: { siteId: "ask#1", ordinal: 1 }, kind: "ask" })],
      state,
    );
    expect(later?.runs[0]?.truncated).toBe(true);
  });

  it("runs ≤ maxRuns 且按最旧淘汰（终态事实仍在 journal）", () => {
    let state: WorkflowRunsState | undefined;
    const total = WORKFLOW_RUNS_LIMITS.maxRuns + 3;
    for (let index = 0; index < total; index += 1) {
      state = step(state, {
        runId: `dwfrun-${index}`,
        sequence: 0,
        eventType: "run-started",
        payload: { runId: `dwfrun-${index}`, caps: { maxConcurrency: 1 } },
      });
    }
    expect(state?.runs).toHaveLength(WORKFLOW_RUNS_LIMITS.maxRuns);
    expect(state?.runs.map((run) => run.runId)).toEqual(
      Array.from({ length: WORKFLOW_RUNS_LIMITS.maxRuns }, (_, offset) => `dwfrun-${offset + 3}`),
    );
    expect(workflowRunsStateSchema.safeParse(state).success).toBe(true);
  });

  it("被淘汰的 run 再来事件时作为新条目回到队尾（不复活旧事实）", () => {
    let state: WorkflowRunsState | undefined;
    for (let index = 0; index < WORKFLOW_RUNS_LIMITS.maxRuns + 1; index += 1) {
      state = step(state, {
        runId: `dwfrun-${index}`,
        sequence: 0,
        eventType: "run-started",
        payload: { runId: `dwfrun-${index}`, caps: { maxConcurrency: 1 } },
      });
    }
    expect(state?.runs.map((run) => run.runId)).not.toContain("dwfrun-0");
    const revived = reduceWorkflowRunsState(state, {
      runId: "dwfrun-0",
      sequence: 9,
      eventType: "log",
      payload: { message: "迟到的日志" },
    });
    expect(revived?.runs.at(-1)).toMatchObject({
      runId: "dwfrun-0",
      status: "pending",
      lastEventSequence: 9,
    });
    expect(revived?.runs).toHaveLength(WORKFLOW_RUNS_LIMITS.maxRuns);
  });
});

describe("reduceWorkflowRunsState：revision 与 sequence 单调", () => {
  it("每次有效变化抬一格 revision", () => {
    const progress = progressLog();
    const first = step(undefined, progress("run-started", started()));
    expect(first.revision).toBe(1);
    const second = step(
      first,
      progress("node-queued", { instance: { siteId: "ask#1", ordinal: 1 }, kind: "ask" }),
    );
    expect(second.revision).toBe(2);
    const third = step(
      second,
      progress("node-dispatched", { instance: { siteId: "ask#1", ordinal: 1 } }),
    );
    expect(third.revision).toBe(3);
    expect(third.runs[0]?.lastEventSequence).toBe(2);
  });

  it("revision 承接传入态：非零起点继续抬，不重置", () => {
    const seeded: WorkflowRunsState = { revision: 41, runs: [] };
    const next = reduceWorkflowRunsState(seeded, {
      runId: RUN_ID,
      sequence: 0,
      eventType: "run-started",
      payload: started(),
    });
    expect(next?.revision).toBe(42);
  });

  it("lastEventSequence 单调：迟到/乱序事件仍归约内容，但水位不回退", () => {
    // 界之下**照单全收**：冷物化会把 journal 重放与在线事件喂进同一个归约，在线事件先给一条
    // run 开了头的话，它整段前缀就全在水位之下——丢掉就等于卡片空着。收紧只发生在溢出过的
    // run 上，见下一条。
    const state = reduceAll([
      { runId: RUN_ID, sequence: 5, eventType: "run-started", payload: started() },
      {
        runId: RUN_ID,
        sequence: 2,
        eventType: "node-queued",
        payload: { instance: { siteId: "ask#1", ordinal: 1 }, kind: "ask" },
      },
    ]);
    expect(state?.runs[0]?.lastEventSequence).toBe(5);
    expect(state?.runs[0]?.nodes).toHaveLength(1);
  });

  it("溢出过的 run 才收紧：水位之下的事件开不出新条目，但照常更新已有的", () => {
    // 理由在 admitsNewEntry：腾位让表会变短，一个空出来的位子可能把一条早已计进
    // nodesUnlisted 的实例放回来，那条实例就既列又计。
    const progress = progressLog();
    const seeded = reduceAll([
      progress("run-started", started()),
      progress("node-queued", { instance: { siteId: "ask#1", ordinal: 1 }, kind: "ask" }),
    ])!;
    const overflowed: WorkflowRunsState = {
      ...seeded,
      runs: [{ ...seeded.runs[0]!, truncated: true }],
    };
    const late = (eventType: string, siteId: string) => ({
      runId: RUN_ID,
      sequence: 1,
      eventType,
      payload: { instance: { siteId, ordinal: 1 }, kind: "ask" },
    });
    const updated = reduceWorkflowRunsState(overflowed, late("node-executing", "ask#1"))!;
    expect(updated.runs[0]?.nodes.map((node) => node.phase)).toEqual(["executing"]);
    const ignored = reduceWorkflowRunsState(updated, late("node-queued", "ask#2"));
    expect(ignored).toBeNull();
  });

  it("sequence 缺席按 0 处理，且不会把已有水位拉低", () => {
    const state = reduceAll([
      { runId: RUN_ID, sequence: 3, eventType: "run-started", payload: started() },
      { runId: RUN_ID, eventType: "log", payload: {} },
    ]);
    expect(state?.runs[0]?.lastEventSequence).toBe(3);
  });
});

describe("reduceWorkflowRunsState：幂等重放", () => {
  it("同一条事件重放返回 null：不抬 revision、不改状态", () => {
    const progress = progressLog();
    const settle = progress("node-settled", {
      instance: { siteId: "ask#1", ordinal: 1 },
      outcome: "ok",
    });
    const state = reduceAll([progress("run-started", started()), settle]);
    expect(reduceWorkflowRunsState(state, settle)).toBeNull();
  });

  it("每一条事件在它自己刚归约完之后立刻重放都是 no-op（逐步幂等）", () => {
    // 幂等的作用域是"刚到的那条"：journal 有序投递，重传只会重传队尾。
    const progress = progressLog();
    const events = [
      progress("run-started", started()),
      progress("actor-created", { actor: { siteId: "actor#1", ordinal: 1 }, name: "planner" }),
      progress("node-queued", {
        instance: { siteId: "ask#1", ordinal: 1 },
        kind: "ask",
        actor: { siteId: "actor#1", ordinal: 1 },
      }),
      progress("node-dispatched", { instance: { siteId: "ask#1", ordinal: 1 } }),
      progress("usage-updated", { spentTokens: 12 }),
      progress("run-settled", { status: "completed" }),
    ];
    let state: WorkflowRunsState | undefined;
    for (const event of events) {
      state = reduceWorkflowRunsState(state, event) ?? state;
      expect(reduceWorkflowRunsState(state, event)).toBeNull();
    }
    expect(state?.revision).toBe(events.length);
  });

  it("整串事件从终态再跑一遍不是 no-op：run-started 就是重开一世（记录在案）", () => {
    // 幂等**不**延伸到乱序/整串重放：run-started 会清结算残影并把 run 拉回 running，
    // node-queued 也没有相位单调守卫，会把已 dispatched 的节点拉回 queued。
    // journal 有序投递让这两条不会在生产上发生；这里钉住它们，免得日后误以为有守卫。
    const progress = progressLog();
    const events = [
      progress("run-started", started()),
      progress("node-queued", { instance: { siteId: "ask#1", ordinal: 1 }, kind: "ask" }),
      progress("node-dispatched", { instance: { siteId: "ask#1", ordinal: 1 } }),
      progress("run-settled", { status: "completed" }),
    ];
    const once = reduceAll(events)!;
    expect(once.runs[0]?.status).toBe("completed");

    const replayed = reduceAll(events, once)!;
    expect(replayed.runs[0]?.status).toBe("completed");
    expect(replayed.revision).toBe(once.revision + events.length);
    // 水位是唯一有单调守卫的量：整串重放也不会让它回退。
    expect(replayed.runs[0]?.lastEventSequence).toBe(once.runs[0]?.lastEventSequence);
  });

  it("重放一条会改内容的事件（相位前进）不算幂等，照常抬 revision", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("node-queued", { instance: { siteId: "ask#1", ordinal: 1 }, kind: "ask" }),
    ]);
    const advanced = reduceWorkflowRunsState(state, {
      runId: RUN_ID,
      toolCallId: "tc-1",
      sequence: 2,
      eventType: "node-dispatched",
      payload: { instance: { siteId: "ask#1", ordinal: 1 } },
    });
    expect(advanced?.revision).toBe((state?.revision ?? 0) + 1);
  });
});

// ── 升级问答（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md）──────────────────────────────
// 两个事件维护同一张「现在还欠谁一个答案」的表：raised 加、resolved 减。身份是 qid（全局唯一、
// 跨 run），不是站点实例——升级没有 site 身份，不写 dwf_node 行、不占 maxNodes。
describe("reduceWorkflowRunsState：升级问答", () => {
  const ASKED_AT = 1_756_000_000_000;
  const raised = (overrides: Record<string, unknown> = {}) => ({
    qid: "dwfq-dwfrun1-1",
    actor: { siteId: "actor#1", ordinal: 1 },
    actorName: "poet",
    question: "评分上限是 95，但通过门槛是 96，这个门是不是坏了？",
    askedAt: ASKED_AT,
    ...overrides,
  });

  it("escalation-raised 建一条停驻问题（qid 为键，actor 身份、名字与提问时刻随事件带上）", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("escalation-raised", raised({ context: "已经试过 4 轮，最高分 95。" })),
    ]);
    expect(state?.runs[0]?.pendingQuestions).toEqual([
      {
        qid: "dwfq-dwfrun1-1",
        actorSiteId: "actor#1",
        actorOrdinal: 1,
        actorName: "poet",
        question: "评分上限是 95，但通过门槛是 96，这个门是不是坏了？",
        context: "已经试过 4 轮，最高分 95。",
        // 提问时刻只能由事件携带——本模块是纯归约，没有时钟可用。
        askedAt: ASKED_AT,
      },
    ]);
    expect(workflowRunsStateSchema.safeParse(state).success).toBe(true);
  });

  it("askedAt 缺席（老 journal 重放出的事件）时字段整个不落，其余照常成条", () => {
    // 事件侧 askedAt 是必填的，但老开发机上的 journal 可能重放出加字段之前的事件。
    // 缺席不是错误：渲染侧据此不显示等待时长，而不是编一个"刚刚"出来。
    const progress = progressLog();
    const { askedAt: _legacy, ...preAmendment } = raised();
    const state = reduceAll([
      progress("run-started", started()),
      progress("escalation-raised", preAmendment),
    ]);
    const pending = state?.runs[0]?.pendingQuestions?.[0];
    expect(pending).not.toHaveProperty("askedAt");
    expect(pending?.question).toBe("评分上限是 95，但通过门槛是 96，这个门是不是坏了？");
    expect(workflowRunsStateSchema.safeParse(state).success).toBe(true);
  });

  it("askedAt 不是有限数时按缺席处理，不把 NaN / Infinity 落进状态", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("escalation-raised", raised({ qid: "dwfq-nan", askedAt: Number.NaN })),
      progress("escalation-raised", raised({ qid: "dwfq-inf", askedAt: Number.POSITIVE_INFINITY })),
      progress("escalation-raised", raised({ qid: "dwfq-str", askedAt: "刚刚" })),
    ]);
    for (const pending of state?.runs[0]?.pendingQuestions ?? []) {
      expect(pending).not.toHaveProperty("askedAt");
    }
    // JSON 承载不了 NaN/Infinity，落进去会让整帧 patch 在协议线上变成 null。
    expect(workflowRunsStateSchema.safeParse(state).success).toBe(true);
  });

  it("匿名 actor 与无补充说明时字段整个缺席，不落空串", () => {
    // 事件侧刻意不合成兜底标签（engine/types.ts 的 actorName 注释），归约也不替它编一个：
    // 「无名」的渲染是消费者的决定。
    const progress = progressLog();
    const { actorName: _anonymous, ...anonymous } = raised();
    const state = reduceAll([
      progress("run-started", started()),
      progress("escalation-raised", anonymous),
    ]);
    const pending = state?.runs[0]?.pendingQuestions?.[0];
    expect(pending).not.toHaveProperty("actorName");
    expect(pending).not.toHaveProperty("context");
    expect(pending?.qid).toBe("dwfq-dwfrun1-1");
  });

  it("actor ref 读不动时**仍然**建条目：身份是 qid，actor 只是属性", () => {
    // 与 node/actor 那三张表刻意不同（那里无法定位即不建条目）：为了一个残缺的 ref 把问题
    // 藏起来，恰好毁掉「被卡住的问题必须可见」这个唯一的兜底价值。
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("escalation-raised", raised({ actor: { siteId: "actor#1" } })),
    ]);
    const pending = state?.runs[0]?.pendingQuestions?.[0];
    expect(pending?.qid).toBe("dwfq-dwfrun1-1");
    expect(pending).not.toHaveProperty("actorSiteId");
    expect(pending).not.toHaveProperty("actorOrdinal");
    expect(workflowRunsStateSchema.safeParse(state).success).toBe(true);
  });

  it("缺 qid 或 question 的事件不建条目，只抬水位", () => {
    const progress = progressLog();
    const { qid: _noQid, ...withoutQid } = raised();
    const { question: _noQuestion, ...withoutQuestion } = raised();
    const state = reduceAll([
      progress("run-started", started()),
      progress("escalation-raised", withoutQid),
      progress("escalation-raised", withoutQuestion),
    ]);
    expect(state?.runs[0]?.pendingQuestions).toBeUndefined();
    expect(state?.runs[0]?.lastEventSequence).toBe(2);
  });

  it("升级不进图也不动 actor 状态：不写节点、不计步（等待不是工作量）", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("actor-created", { actor: { siteId: "actor#1", ordinal: 1 }, name: "poet" }),
      progress("node-queued", {
        instance: { siteId: "ask#1", ordinal: 1 },
        kind: "ask",
        actor: { siteId: "actor#1", ordinal: 1 },
      }),
      progress("node-dispatched", { instance: { siteId: "ask#1", ordinal: 1 } }),
      progress("node-executing", { instance: { siteId: "ask#1", ordinal: 1 } }),
      progress("escalation-raised", raised()),
    ]);
    expect(state?.runs[0]?.nodes).toHaveLength(1);
    // 那一次 ask 派发计了一步；升级本身不再加。
    expect(state?.runs[0]?.usage.nodesUsed).toBe(1);
    // 提问的 actor 仍然在跑——它那次 ask 还是 executing 的，停驻不等于空闲。
    expect(state?.runs[0]?.actors[0]?.status).toBe("running");
  });

  it("同一条 raised 重放是 no-op（按 qid upsert，不是 push）", () => {
    const progress = progressLog();
    const event = progress("escalation-raised", raised());
    const state = reduceAll([progress("run-started", started()), event]);
    expect(state?.runs[0]?.pendingQuestions).toHaveLength(1);
    expect(reduceWorkflowRunsState(state, event)).toBeNull();
  });

  it("escalation-resolved 划掉对应那条，最后一条走后整个键缺席（不留空数组）", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("escalation-raised", raised()),
      progress("escalation-resolved", { qid: "dwfq-dwfrun1-1", answer: "门确实坏了，跳过它。" }),
    ]);
    // 「零条 ⇒ 键缺席」是协议约定：侧栏据此整区不渲染，而不是留一节空壳。
    expect(state?.runs[0]).not.toHaveProperty("pendingQuestions");
    expect(workflowRunsStateSchema.safeParse(state).success).toBe(true);
  });

  it("多个问题并存时 resolve 只动对应那条（一轮里可以并行发出几个 escalate）", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("escalation-raised", raised({ qid: "dwfq-a" })),
      progress(
        "escalation-raised",
        raised({ qid: "dwfq-b", actorName: "critic", question: "用哪版风格指南？" }),
      ),
      progress("escalation-raised", raised({ qid: "dwfq-c" })),
      progress("escalation-resolved", { qid: "dwfq-b", answer: "用 v2。" }),
    ]);
    expect(state?.runs[0]?.pendingQuestions?.map((pending) => pending.qid)).toEqual([
      "dwfq-a",
      "dwfq-c",
    ]);
  });

  it("resolve 一个不在表里的 qid 不动那张表，只抬水位（与 log 同族）", () => {
    // qid 全局唯一（跨 run），所以一条串错 run 的 resolved 事件必然找不到条目。它仍然是一条
    // 到达过的事件，水位照抬——「无变化」只对**内容**成立（幂等的那一条见下一例）。
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("escalation-raised", raised()),
    ]);
    const next = reduceWorkflowRunsState(state, {
      runId: RUN_ID,
      toolCallId: "tc-1",
      sequence: 9,
      eventType: "escalation-resolved",
      payload: { qid: "dwfq-别的-run", answer: "无关" },
    });
    expect(next?.runs[0]?.pendingQuestions?.map((pending) => pending.qid)).toEqual([
      "dwfq-dwfrun1-1",
    ]);
    expect(next?.runs[0]?.lastEventSequence).toBe(9);
  });

  it("同一条 resolved 重放是 no-op：不抬 revision、不改状态", () => {
    // 重放同一条事件时 sequence 也一样，水位不动，于是整条 run 逐字节相同 → null。
    // 这才是「幂等」真正落地的地方（journal 有序投递，重传只会重传队尾）。
    const progress = progressLog();
    const parked = reduceAll([
      progress("run-started", started()),
      progress("escalation-raised", raised()),
    ]);
    const resolve = progress("escalation-resolved", {
      qid: "dwfq-dwfrun1-1",
      answer: "门确实坏了，跳过它。",
    });
    const state = reduceAll([resolve], parked);
    expect(state?.runs[0]).not.toHaveProperty("pendingQuestions");
    expect(reduceWorkflowRunsState(state, resolve)).toBeNull();
  });

  it("run 从没有过停驻问题时，resolved 不凭空造出一个空数组", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("escalation-resolved", { qid: "dwfq-dwfrun1-1", answer: "…" }),
    ]);
    expect(state?.runs[0]).not.toHaveProperty("pendingQuestions");
  });

  it.each(["completed", "errored", "stopped"] as const)(
    "run-settled（%s）清空停驻问题：终态 run 没有在听的人",
    (status) => {
      // 真相是进程内的停驻 deferred。cancel 时它们随 cancelAsk 被拒，进程亡故则整张注册表
      // 消失——`resolved` 事件永远不会来。留着等于摆出一个不可能被作答的问题。
      const progress = progressLog();
      const state = reduceAll([
        progress("run-started", started()),
        progress("escalation-raised", raised()),
        progress("run-settled", { status }),
      ]);
      expect(state?.runs[0]?.status).toBe(status);
      expect(state?.runs[0]).not.toHaveProperty("pendingQuestions");
    },
  );

  it("同 runId 再收 run-started 也清掉上一世的停驻问题（进程内 cancel→resume）", () => {
    // 新的一世里那个 ask 会重跑、actor 重新提问、得一个新 qid；旧的留着只会是永远等不到
    // 答案、也再没有人在等它的残影。
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("escalation-raised", raised()),
      progress("run-settled", { status: "stopped", stopReason: "user" }),
      progress("run-started", started()),
      progress("escalation-raised", raised({ qid: "dwfq-dwfrun1-2" })),
    ]);
    expect(state?.runs[0]?.status).toBe("running");
    expect(state?.runs[0]?.pendingQuestions?.map((pending) => pending.qid)).toEqual([
      "dwfq-dwfrun1-2",
    ]);
  });

  it("触上限置 truncated 且不再增长，但表内已有的 qid 仍可被更新与划掉", () => {
    const progress = progressLog();
    let state: WorkflowRunsState | undefined = step(undefined, progress("run-started", started()));
    for (let index = 1; index <= WORKFLOW_RUNS_LIMITS.maxPendingQuestions + 3; index += 1) {
      state = reduceAll([progress("escalation-raised", raised({ qid: `dwfq-${index}` }))], state);
    }
    expect(state?.runs[0]?.pendingQuestions).toHaveLength(WORKFLOW_RUNS_LIMITS.maxPendingQuestions);
    expect(state?.runs[0]?.truncated).toBe(true);
    expect(workflowRunsStateSchema.safeParse(state).success).toBe(true);

    const resolved = reduceAll(
      [progress("escalation-resolved", { qid: "dwfq-1", answer: "好" })],
      state,
    );
    expect(resolved?.runs[0]?.pendingQuestions).toHaveLength(
      WORKFLOW_RUNS_LIMITS.maxPendingQuestions - 1,
    );
  });

  it("超长问题按上限截断，产出仍过 strict schema", () => {
    const progress = progressLog();
    const long = "问".repeat(WORKFLOW_RUNS_LIMITS.maxQuestionLength + 50);
    const state = reduceAll([
      progress("run-started", started()),
      progress("escalation-raised", raised({ question: long, context: long })),
    ]);
    const pending = state?.runs[0]?.pendingQuestions?.[0];
    expect(pending?.question).toHaveLength(WORKFLOW_RUNS_LIMITS.maxQuestionLength);
    // 省略号让截断在 UI 上可见（与 report 预览同一个习语）。
    expect(pending?.question.endsWith("…")).toBe(true);
    expect(pending?.context).toHaveLength(WORKFLOW_RUNS_LIMITS.maxQuestionLength);
    expect(workflowRunsStateSchema.safeParse(state).success).toBe(true);
  });
});

describe("reduceWorkflowRunsState：纯度", () => {
  it("不改动传入态（新态是新对象，旧态逐字节不变）", () => {
    const progress = progressLog();
    const before = reduceAll([progress("run-started", started())])!;
    const frozen = JSON.parse(JSON.stringify(before)) as WorkflowRunsState;
    const after = reduceWorkflowRunsState(
      before,
      progress("node-queued", {
        instance: { siteId: "ask#1", ordinal: 1 },
        kind: "ask",
      }),
    );
    expect(before).toEqual(frozen);
    expect(after).not.toBe(before);
    expect(after?.runs[0]).not.toBe(before.runs[0]);
  });

  it("同一入参重复调用得到同一结果（无时钟、无随机）", () => {
    const envelope: WorkflowRunProgressEnvelope = {
      runId: RUN_ID,
      toolCallId: "tc-1",
      sequence: 0,
      eventType: "run-started",
      payload: started(),
    };
    expect(reduceWorkflowRunsState(undefined, envelope)).toEqual(
      reduceWorkflowRunsState(undefined, envelope),
    );
  });

  it("payload 非 record 时退化成空 payload，不抛", () => {
    const state = reduceWorkflowRunsState(undefined, {
      runId: RUN_ID,
      sequence: 0,
      eventType: "run-started",
      payload: undefined,
    });
    expect(state?.runs[0]).toMatchObject({
      status: "running",
      usage: { spentTokens: 0, nodesUsed: 0 },
    });
  });
});

// ── 自适应并发（docs/dynamic-workflow/concurrency.md「Protocol and UI」）：node-waiting / node-executing /
// concurrency-changed 三条观察事件。它们与 escalation 同族——引擎不据其决策，只是 driver /
// 治理器观察到的事实经 record() 落下来；归约侧同样只做"记下它"，不推导任何时钟。
describe("reduceWorkflowRunsState：自适应并发", () => {
  const ASK = { siteId: "ask#1", ordinal: 1 };
  const ACTOR = { siteId: "actor#1", ordinal: 1 };

  function dispatchedState() {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("actor-created", { actor: ACTOR, name: "planner" }),
      progress("node-queued", { instance: ASK, kind: "ask", actor: ACTOR, actorSeq: 1 }),
      progress("node-dispatched", { instance: ASK }),
    ]);
    return { progress, state };
  }

  it("node-executing：相位 executing、actor running，过 strict schema", () => {
    const { progress, state } = dispatchedState();
    const next = step(state, progress("node-executing", { instance: ASK }));
    expect(next.runs[0]?.nodes[0]).toEqual({
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      phase: "executing",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
    });
    expect(next.runs[0]?.actors[0]?.status).toBe("running");
    expect(() => workflowRunsStateSchema.parse(next)).not.toThrow();
  });

  it("node-waiting（slot / backoff）：相位 waiting、actor waiting；载荷细节不进状态（只在事件日志）", () => {
    const { progress, state } = dispatchedState();
    for (const payload of [
      { instance: ASK, cause: "slot" },
      {
        instance: ASK,
        cause: "backoff",
        reason: "rate_limited",
        attempt: 2,
        delayMs: 20_000,
        retryAfterMs: 20_000,
      },
    ]) {
      const next = step(
        step(state, progress("node-executing", { instance: ASK })),
        progress("node-waiting", payload),
      );
      expect(next.runs[0]?.nodes[0]).toEqual({
        siteId: "ask#1",
        ordinal: 1,
        kind: "ask",
        phase: "waiting",
        actorSiteId: "actor#1",
        actorOrdinal: 1,
      });
      expect(next.runs[0]?.actors[0]?.status).toBe("waiting");
      expect(() => workflowRunsStateSchema.parse(next)).not.toThrow();
    }
  });

  it("waiting → executing → settled：来回切换后结算，actor 走 waiting → running → completed", () => {
    const { progress, state } = dispatchedState();
    const waiting = step(state, progress("node-waiting", { instance: ASK, cause: "slot" }));
    expect(waiting.runs[0]?.actors[0]?.status).toBe("waiting");
    const executing = step(waiting, progress("node-executing", { instance: ASK }));
    expect(executing.runs[0]?.nodes[0]).toMatchObject({ phase: "executing" });
    expect(executing.runs[0]?.actors[0]?.status).toBe("running");
    const settled = step(executing, progress("node-settled", { instance: ASK, outcome: "ok" }));
    expect(settled.runs[0]?.nodes[0]).toMatchObject({ phase: "settled", outcome: "ok" });
    expect(settled.runs[0]?.actors[0]?.status).toBe("completed");
  });

  it("concurrency-changed：cap=next，ceiling 取见过的最大 previous/next，cooldownMs 与 key 透传", () => {
    const { progress, state } = dispatchedState();
    const next = step(
      state,
      progress("concurrency-changed", {
        key: "anthropic/claude-x",
        previous: 14,
        next: 7,
        reason: "rate_limited",
        cooldownMs: 20_000,
      }),
    );
    expect(next.runs[0]?.concurrency).toEqual({
      key: "anthropic/claude-x",
      cap: 7,
      ceiling: 14,
      cooldownMs: 20_000,
    });
    expect(() => workflowRunsStateSchema.parse(next)).not.toThrow();
  });

  it("ceiling 只升不降：后续 recovered 事件把 cap 抬回去时 ceiling 不变；无 Retry-After 的减半不带 cooldownMs", () => {
    const { progress, state } = dispatchedState();
    const halved = step(
      state,
      progress("concurrency-changed", { key: "k", previous: 14, next: 7, reason: "rate_limited" }),
    );
    expect(halved.runs[0]?.concurrency).toEqual({ key: "k", cap: 7, ceiling: 14 });
    const recovered = step(
      halved,
      progress("concurrency-changed", { key: "k", previous: 7, next: 8, reason: "recovered" }),
    );
    expect(recovered.runs[0]?.concurrency).toEqual({ key: "k", cap: 8, ceiling: 14 });
  });

  it("idle_reset 清掉冷却：桶回到天花板不是冷却", () => {
    const { progress, state } = dispatchedState();
    const cooled = step(
      state,
      progress("concurrency-changed", {
        key: "k",
        previous: 14,
        next: 7,
        reason: "rate_limited",
        cooldownMs: 60_000,
      }),
    );
    const reset = step(
      cooled,
      progress("concurrency-changed", {
        key: "k",
        previous: 7,
        next: 14,
        reason: "idle_reset",
        cooldownMs: 1,
      }),
    );
    expect(reset.runs[0]?.concurrency).toEqual({ key: "k", cap: 14, ceiling: 14 });
  });

  it("run-settled 摘掉 cooldownMs、保留 cap/ceiling（历史事实）", () => {
    const { progress, state } = dispatchedState();
    const cooled = step(
      state,
      progress("concurrency-changed", {
        previous: 14,
        next: 7,
        reason: "provider_overloaded",
        cooldownMs: 60_000,
      }),
    );
    const settled = step(cooled, progress("run-settled", { status: "completed" }));
    expect(settled.runs[0]?.concurrency).toEqual({ cap: 7, ceiling: 14 });
  });

  it("concurrency-changed 不碰 nodes / actors，next 读不动时只抬水位", () => {
    const { progress, state } = dispatchedState();
    const before = state!.runs[0]!;
    const next = step(
      state,
      progress("concurrency-changed", { previous: 14, next: 7, reason: "rate_limited" }),
    );
    expect(next.runs[0]?.nodes).toEqual(before.nodes);
    expect(next.runs[0]?.actors).toEqual(before.actors);
    const malformed = step(next, progress("concurrency-changed", { previous: 7, next: "x" }));
    expect(malformed.runs[0]?.concurrency).toEqual(next.runs[0]?.concurrency);
    expect(malformed.runs[0]?.lastEventSequence).toBeGreaterThan(next.runs[0]!.lastEventSequence);
  });

  it("幂等：同一条 node-waiting / concurrency-changed 重放得到 null", () => {
    const { progress, state } = dispatchedState();
    const waitingEvent = progress("node-waiting", { instance: ASK, cause: "slot" });
    const once = step(state, waitingEvent);
    expect(reduceWorkflowRunsState(once, waitingEvent)).toBeNull();
    const changeEvent = progress("concurrency-changed", {
      previous: 14,
      next: 7,
      reason: "rate_limited",
      cooldownMs: 5_000,
    });
    const changed = step(once, changeEvent);
    expect(reduceWorkflowRunsState(changed, changeEvent)).toBeNull();
  });

  // ── 本 run 自己的那条界（docs/dynamic-workflow/concurrency.md「Two bounds on a run」）──
  // `run-started` 载荷带引擎的 `caps.maxConcurrency` 与 CLI 铸载荷那一刻的默认并发 D
  // （线上键名 `concurrencyCeiling` 早于「默认并发」，为兼容旧端保留）。两条界互不相干：治理器
  // 压共享桶，用户调这一条——高于或低于 D 都行。

  const LIMITED = { ...started({ maxConcurrency: 3 }), concurrencyCeiling: 8 };

  it("run-started：maxConcurrency 低于默认时落 limit，共享 cap 从默认起步", () => {
    const progress = progressLog();
    const state = step(undefined, progress("run-started", LIMITED));
    expect(state.runs[0]?.concurrency).toEqual({ cap: 8, ceiling: 8, limit: 3 });
    expect(() => workflowRunsStateSchema.parse(state)).not.toThrow();
  });

  it.each([
    ["跑在默认上", { ...started({ maxConcurrency: 8 }), concurrencyCeiling: 8 }],
    ["老 CLI 不发默认", started({ maxConcurrency: 3 })],
    ["maxConcurrency 读不动", { ...started({ maxConcurrency: 0 }), concurrencyCeiling: 8 }],
    ["天花板读不动", { ...started({ maxConcurrency: 3 }), concurrencyCeiling: "8" }],
    ["caps 整块读不动", { caps: "nope", concurrencyCeiling: 8, runId: RUN_ID }],
  ])("%s：整个 concurrency 键缺席（没有可显示的东西）", (_case, payload) => {
    const state = step(undefined, progressLog()("run-started", payload));
    expect(state.runs[0]).not.toHaveProperty("concurrency");
  });

  it("run-started：maxConcurrency 高于默认同样落 limit——默认是起点不是上限", () => {
    const progress = progressLog();
    const state = step(
      undefined,
      progress("run-started", { ...started({ maxConcurrency: 20 }), concurrencyCeiling: 8 }),
    );
    expect(state.runs[0]?.concurrency).toEqual({ cap: 8, ceiling: 8, limit: 20 });
    expect(() => workflowRunsStateSchema.parse(state)).not.toThrow();
  });

  it("默认已知时 concurrency.ceiling 就是 D：共享桶长到 D 之上也不抬它", () => {
    const progress = progressLog();
    const state = step(
      undefined,
      progress("run-started", { ...started({ maxConcurrency: 20 }), concurrencyCeiling: 8 }),
    );
    const grown = step(
      state,
      progress("concurrency-changed", { key: "k", previous: 11, next: 12, reason: "recovered" }),
    );
    expect(grown.runs[0]?.concurrency).toEqual({ key: "k", cap: 12, ceiling: 8, limit: 20 });
    const lowered = step(
      grown,
      progress("concurrency-changed", { key: "k", previous: 12, next: 9, reason: "limit_lowered" }),
    );
    expect(lowered.runs[0]?.concurrency).toEqual({ key: "k", cap: 9, ceiling: 8, limit: 20 });
    // 默认跑的 run 同理：水位不再是「见过的最大 cap」。
    const plain = progressLog();
    const atDefault = step(
      undefined,
      plain("run-started", { ...started({ maxConcurrency: 8 }), concurrencyCeiling: 8 }),
    );
    const cut = step(
      atDefault,
      plain("concurrency-changed", { key: "k", previous: 14, next: 10, reason: "rate_limited" }),
    );
    expect(cut.runs[0]?.concurrency).toEqual({ key: "k", cap: 10, ceiling: 8 });
  });

  it("concurrency-changed 照搬 limit：共享桶的涨落改不了用户定的界", () => {
    const progress = progressLog();
    const state = step(undefined, progress("run-started", LIMITED));
    const cut = step(
      state,
      progress("concurrency-changed", { previous: 8, next: 6, reason: "rate_limited" }),
    );
    expect(cut.runs[0]?.concurrency).toEqual({ cap: 6, ceiling: 8, limit: 3 });
    // 终态只摘冷却；两条界都是「这次 run 跑在什么并发下」的历史事实，照留。
    const settled = step(cut, progress("run-settled", { status: "completed" }));
    expect(settled.runs[0]?.concurrency).toEqual({ cap: 6, ceiling: 8, limit: 3 });
  });

  it("resume 再发一条 run-started：不拿天花板盖掉进程里已经学到的 cap", () => {
    const progress = progressLog();
    const first = step(undefined, progress("run-started", LIMITED));
    const throttled = step(
      first,
      progress("concurrency-changed", { key: "k", previous: 8, next: 2, reason: "rate_limited" }),
    );
    expect(throttled.runs[0]?.concurrency).toEqual({ key: "k", cap: 2, ceiling: 8, limit: 3 });
    const resumed = step(throttled, progress("run-started", LIMITED));
    expect(resumed.runs[0]?.concurrency).toEqual({ key: "k", cap: 2, ceiling: 8, limit: 3 });
  });

  // 天花板单独记一份（docs/dynamic-workflow/concurrency.md「Protocol state」）：「配置」弹层的步进器
  // 停在这里，而跑在天花板上的 run 没有 `concurrency` 可挂。
  it("run-started 记下 concurrencyCeiling，不论本 run 是否低于它", () => {
    const progress = progressLog();
    const atCeiling = step(
      undefined,
      progress("run-started", { ...started({ maxConcurrency: 8 }), concurrencyCeiling: 8 }),
    );
    expect(atCeiling.runs[0]?.concurrencyCeiling).toBe(8);
    expect(atCeiling.runs[0]).not.toHaveProperty("concurrency");
    const limited = step(undefined, progressLog()("run-started", LIMITED));
    expect(limited.runs[0]?.concurrencyCeiling).toBe(8);
    expect(() => workflowRunsStateSchema.parse(atCeiling)).not.toThrow();
  });

  it.each([
    ["老 CLI 不发天花板", started({ maxConcurrency: 3 })],
    ["天花板读不动", { ...started({ maxConcurrency: 3 }), concurrencyCeiling: "8" }],
    ["天花板越界", { ...started({ maxConcurrency: 3 }), concurrencyCeiling: 100_000 }],
  ])("%s：没有 concurrencyCeiling 键；已知值被后来读不出的载荷沿用", (_case, payload) => {
    const fresh = step(undefined, progressLog()("run-started", payload));
    expect(fresh.runs[0]).not.toHaveProperty("concurrencyCeiling");
    const progress = progressLog();
    const known = step(undefined, progress("run-started", LIMITED));
    const again = step(known, progress("run-started", payload));
    expect(again.runs[0]?.concurrencyCeiling).toBe(8);
  });

  // ── 在飞改界（docs/dynamic-workflow/concurrency.md）──────────────────────────────────
  // 只改 `max_concurrency` 的修订就地生效：不停这次 run、不另起一次，引擎改完 caps 发
  // `run-caps-changed`。载荷与 `run-started` 同形（`caps` + CLI 拼进来的 `concurrencyCeiling`），
  // 所以归约必须与 `run-started` 得出同一份状态——同一个数经两条路进来不能有两份读数。

  /** `run-caps-changed` 的载荷；`ceiling: null` = 这条载荷不带天花板（与 run-started 同一种老 CLI）。 */
  const capsChanged = (maxConcurrency: unknown, previous = 3, ceiling: unknown = 8) => ({
    runId: RUN_ID,
    caps: { maxConcurrency },
    previous: { maxConcurrency: previous },
    ...(ceiling === null ? {} : { concurrencyCeiling: ceiling }),
  });

  it("run-caps-changed：limit 就地改成新值，共享桶那一侧一个字不动", () => {
    const progress = progressLog();
    const state = step(undefined, progress("run-started", LIMITED));
    const throttled = step(
      state,
      progress("concurrency-changed", { key: "k", previous: 8, next: 6, reason: "rate_limited" }),
    );
    const retuned = step(throttled, progress("run-caps-changed", capsChanged(2)));
    expect(retuned.runs[0]?.concurrency).toEqual({ key: "k", cap: 6, ceiling: 8, limit: 2 });
    expect(() => workflowRunsStateSchema.parse(retuned)).not.toThrow();
    // 之后的共享桶涨落照旧不碰新界（与 run-started 带来的界同一条规则）。
    const recovered = step(
      retuned,
      progress("concurrency-changed", { key: "k", previous: 6, next: 8, reason: "recovered" }),
    );
    expect(recovered.runs[0]?.concurrency).toEqual({ key: "k", cap: 8, ceiling: 8, limit: 2 });
  });

  it("run-caps-changed 抬到默认之上：同样落 limit", () => {
    const progress = progressLog();
    const state = step(undefined, progress("run-started", LIMITED));
    const raised = step(state, progress("run-caps-changed", capsChanged(24)));
    expect(raised.runs[0]?.concurrency).toEqual({ cap: 8, ceiling: 8, limit: 24 });
  });

  it("从默认之上调回默认：共享 cap 在 D 之上也算无话可说，整个 concurrency 键缺席", () => {
    const progress = progressLog();
    const state = step(
      undefined,
      progress("run-started", { ...started({ maxConcurrency: 20 }), concurrencyCeiling: 8 }),
    );
    const grown = step(
      state,
      progress("concurrency-changed", { key: "k", previous: 11, next: 12, reason: "recovered" }),
    );
    const back = step(grown, progress("run-caps-changed", capsChanged(8, 20)));
    expect(back.runs[0]).not.toHaveProperty("concurrency");
    expect(back.runs[0]?.concurrencyCeiling).toBe(8);
  });

  it("run-caps-changed 也能给一个从未被压低的 run 立一条界：共享 cap 从默认起步", () => {
    const progress = progressLog();
    const atCeiling = step(
      undefined,
      progress("run-started", { ...started({ maxConcurrency: 8 }), concurrencyCeiling: 8 }),
    );
    expect(atCeiling.runs[0]).not.toHaveProperty("concurrency");
    const limited = step(atCeiling, progress("run-caps-changed", capsChanged(3, 8)));
    expect(limited.runs[0]?.concurrency).toEqual({ cap: 8, ceiling: 8, limit: 3 });
  });

  it("调回默认：limit 摘掉；共享桶无话可说时整个 concurrency 键随之缺席", () => {
    const progress = progressLog();
    const state = step(undefined, progress("run-started", LIMITED));
    expect(state.runs[0]?.concurrency).toEqual({ cap: 8, ceiling: 8, limit: 3 });
    const lifted = step(state, progress("run-caps-changed", capsChanged(8)));
    // 与一个从没被压低过的 run 逐字节相同（天花板另记在 concurrencyCeiling 上）。
    expect(lifted.runs[0]).not.toHaveProperty("concurrency");
    expect(lifted.runs[0]?.concurrencyCeiling).toBe(8);
  });

  it.each([
    ["共享桶被压低", { key: "k", previous: 8, next: 6, reason: "rate_limited" }, { cap: 6 }],
    [
      "还在冷却",
      { key: "k", previous: 8, next: 8, reason: "rate_limited", cooldownMs: 30_000 },
      { cap: 8, cooldownMs: 30_000 },
    ],
  ])("调回默认但%s：只摘 limit，共享桶那一侧留着", (_case, changed, expected) => {
    const progress = progressLog();
    const state = step(undefined, progress("run-started", LIMITED));
    const shared = step(state, progress("concurrency-changed", changed));
    const lifted = step(shared, progress("run-caps-changed", capsChanged(8)));
    expect(lifted.runs[0]?.concurrency).toEqual({ key: "k", ceiling: 8, ...expected });
  });

  it.each([
    ["caps 整块读不动", { runId: RUN_ID, caps: "nope", concurrencyCeiling: 8 }],
    ["maxConcurrency 读不动", capsChanged("2")],
    ["maxConcurrency 非正", capsChanged(0)],
  ])("%s：界一个字不改（只抬水位，与 concurrency-changed 同一条兜底）", (_case, payload) => {
    const progress = progressLog();
    const state = step(undefined, progress("run-started", LIMITED));
    const after = step(state, progress("run-caps-changed", payload));
    expect(after.runs[0]?.concurrency).toEqual({ cap: 8, ceiling: 8, limit: 3 });
    expect(after.runs[0]?.concurrencyCeiling).toBe(8);
  });

  it("载荷不带天花板：退回本 run 已知的那个（天花板是整条 run 恒定的进程事实）", () => {
    const progress = progressLog();
    const state = step(undefined, progress("run-started", LIMITED));
    const retuned = step(state, progress("run-caps-changed", capsChanged(2, 3, null)));
    expect(retuned.runs[0]?.concurrency).toEqual({ cap: 8, ceiling: 8, limit: 2 });
    // 天花板从未知过（老 CLI 的 run）：判不出这个数是否被压低，界一个字不改。
    const blind = progressLog();
    const unknown = step(undefined, blind("run-started", started({ maxConcurrency: 3 })));
    const after = step(unknown, blind("run-caps-changed", capsChanged(2, 3, null)));
    expect(after.runs[0]).not.toHaveProperty("concurrency");
    expect(after.runs[0]).not.toHaveProperty("concurrencyCeiling");
  });

  it("run-caps-changed 记下载荷里的天花板（与 run-started 同一条）", () => {
    const progress = progressLog();
    const state = step(undefined, progress("run-started", started({ maxConcurrency: 3 })));
    expect(state.runs[0]).not.toHaveProperty("concurrencyCeiling");
    const retuned = step(state, progress("run-caps-changed", capsChanged(2)));
    expect(retuned.runs[0]?.concurrencyCeiling).toBe(8);
    expect(retuned.runs[0]?.concurrency).toEqual({ cap: 8, ceiling: 8, limit: 2 });
  });

  it("幂等：同一条 run-caps-changed 重放得到 null", () => {
    const progress = progressLog();
    const state = step(undefined, progress("run-started", LIMITED));
    const event = progress("run-caps-changed", capsChanged(2));
    const retuned = step(state, event);
    expect(reduceWorkflowRunsState(retuned, event)).toBeNull();
  });
});

// ── 子代理模型（docs/dynamic-workflow/launch.md）─────────────────────────────────────────
// `CreateWorkflow` / `AmendWorkflow` 的 `subagent_model` 落到 `run-started` 载荷的
// `subagentModel`（规范串 `providerId/modelId`，可带 `$reasoningLevel` 后缀）。与
// `concurrency.limit` 同族：用户给这次 run 定下的条件，整条 run 不动。主代理始终留在会话模型上，
// 所以这个键说的只是子代理那一侧。
describe("reduceWorkflowRunsState：子代理模型", () => {
  const withModel = (subagentModel: unknown) => ({ ...started(), subagentModel });

  it("run-started 带 subagentModel 时记下它，产出过 strict schema", () => {
    const state = step(undefined, progressLog()("run-started", withModel("zhipu/glm-5.3-flash")));

    expect(state.runs[0]?.subagentModel).toBe("zhipu/glm-5.3-flash");
    expect(() => workflowRunsStateSchema.parse(state)).not.toThrow();
  });

  it("带推理档后缀的规范串原样留着：档位是模型选择的一部分，不是可丢的修饰", () => {
    const state = step(undefined, progressLog()("run-started", withModel("anthropic/opus-5$high")));

    expect(state.runs[0]?.subagentModel).toBe("anthropic/opus-5$high");
  });

  it("两侧空白裁掉：显示的是模型 id，不是载荷的排版", () => {
    const state = step(undefined, progressLog()("run-started", withModel("  zhipu/glm-5.3  ")));

    expect(state.runs[0]?.subagentModel).toBe("zhipu/glm-5.3");
  });

  it("后续事件改不了它：整条 run 自始至终说的是同一个模型", () => {
    const progress = progressLog();
    const state = step(undefined, progress("run-started", withModel("zhipu/glm-5.3-flash")));
    const used = step(state, progress("usage-updated", { spentTokens: 4_096 }));
    const throttled = step(
      used,
      progress("concurrency-changed", { previous: 8, next: 4, reason: "rate_limited" }),
    );
    const settled = step(throttled, progress("run-settled", { status: "completed" }));

    expect(settled.runs[0]?.subagentModel).toBe("zhipu/glm-5.3-flash");
  });

  it("重臂不带这个键时保留已知值，而不是让 run 看上去换回了会话模型", () => {
    // 老 CLI 不发它；把已经显示出来的模型抹掉是退化里最坏的一种（读数变了，事实没变）。
    const progress = progressLog();
    const first = step(undefined, progress("run-started", withModel("zhipu/glm-5.3-flash")));
    const resumed = step(first, progress("run-started", started()));

    expect(resumed.runs[0]?.subagentModel).toBe("zhipu/glm-5.3-flash");
  });

  it.each([
    ["缺席（子代理跟随会话模型）", started()],
    ["空串", withModel("")],
    ["只有空白", withModel("   ")],
    ["不是字符串", withModel({ providerId: "zhipu", modelId: "glm-5.3-flash" })],
    [
      "超过线上上界（截断出来的模型 id 是假话）",
      withModel(`zhipu/${"x".repeat(WORKFLOW_RUNS_LIMITS.maxSubagentModelLength)}`),
    ],
  ])("%s：整个键缺席，而不是一个 undefined 值", (_case, payload) => {
    const state = step(undefined, progressLog()("run-started", payload));

    expect(state.runs[0]).not.toHaveProperty("subagentModel");
    expect(() => workflowRunsStateSchema.parse(state)).not.toThrow();
  });
});

// ── 用户面产物（docs/dynamic-workflow/authoring.md「How the user sees them」）─────────────────
// ⚠ 术语：这里的 artifact 是脚本经 `artifact.*` 发布给**用户**看的产出，不是 resultPreview
// 背后那个「脚本顶层返回值」（引擎内部也叫 artifact，给模型看）。见 workflow-artifacts.ts。
//
// 三条归约规则，各有各的键：
//   artifact-published ⇒ 按**产物 id** upsert（同 id 再发布 = 新版本覆盖同一张卡）
//   artifact-failed    ⇒ 不动状态（失败的发布不认领 id / 种类 / 版本，只进事件日志）
//   report(artifactId) ⇒ 该 id 的 itemCount 加一（去重键仍是 (siteId, ordinal)）
describe("reduceWorkflowRunsState：用户面产物", () => {
  const PUBLISHED_AT = 1_756_100_000_000;
  const record = (overrides: Record<string, unknown> = {}) => ({
    id: "book",
    kind: "file",
    version: 1,
    title: "注意力之书",
    contentType: "application/pdf",
    bytes: 4_194_304,
    uri: "zcode-artifact://session-1/tool-result-abc",
    sourcePath: "out/book.pdf",
    publishedAt: PUBLISHED_AT,
    ...overrides,
  });

  it("artifact-published 建一张卡，且只留最新版元数据（不带 uri / sourcePath / publishedAt）", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("artifact-published", {
        instance: { siteId: "artifact#1", ordinal: 1 },
        artifact: record(),
      }),
    ]);
    // 裁剪是这个键的全部理由：高频状态帧只回答「有哪些、第几版、变了没有」。
    expect(state?.runs[0]?.artifacts).toEqual([
      {
        id: "book",
        kind: "file",
        title: "注意力之书",
        version: 1,
        contentType: "application/pdf",
        bytes: 4_194_304,
      },
    ]);
    expect(workflowRunsStateSchema.parse(state)).toEqual(state);
  });

  it("交付物的 primary 进快照（UI 据它排先后与选形态）；description 仍被裁掉", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("artifact-published", {
        instance: { siteId: "artifact#1", ordinal: 1 },
        artifact: record({ primary: true, description: "一本书" }),
      }),
    ]);
    expect(state?.runs[0]?.artifacts).toEqual([
      {
        id: "book",
        kind: "file",
        title: "注意力之书",
        version: 1,
        contentType: "application/pdf",
        bytes: 4_194_304,
        primary: true,
      },
    ]);
    expect(workflowRunsStateSchema.parse(state)).toEqual(state);
  });

  it("预置看板的声明也走 artifact-published：无 contentType / bytes，spec 不进快照", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("artifact-published", {
        instance: { siteId: "artifact#1", ordinal: 1 },
        artifact: {
          id: "perf",
          kind: "chart",
          version: 1,
          title: "每轮查询耗时",
          spec: { x: { field: "round" }, y: { field: "queryMs" } },
          publishedAt: PUBLISHED_AT,
        },
      }),
    ]);
    expect(state?.runs[0]?.artifacts).toEqual([
      { id: "perf", kind: "chart", title: "每轮查询耗时", version: 1 },
    ]);
    expect(workflowRunsStateSchema.parse(state)).toEqual(state);
  });

  it("同 id 再发布 = 新版本覆盖同一张卡（按产物 id 去重，不是按站点实例）", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("artifact-published", {
        instance: { siteId: "artifact#1", ordinal: 1 },
        artifact: record(),
      }),
      // 第二次发布来自**另一个**站点实例——按实例去重会长出第二张卡，那是错的。
      progress("artifact-published", {
        instance: { siteId: "artifact#2", ordinal: 1 },
        artifact: record({ version: 2, bytes: 5_000_000, title: "注意力之书（第二版）" }),
      }),
    ]);
    expect(state?.runs[0]?.artifacts).toEqual([
      {
        id: "book",
        kind: "file",
        title: "注意力之书（第二版）",
        version: 2,
        contentType: "application/pdf",
        bytes: 5_000_000,
      },
    ]);
  });

  it("新版本覆盖时**保留** itemCount：正在被喂数据的看板不能被清零", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("artifact-published", {
        instance: { siteId: "artifact#1", ordinal: 1 },
        artifact: { id: "perf", kind: "chart", version: 1, publishedAt: PUBLISHED_AT },
      }),
      progress("report", {
        instance: { siteId: "report#1", ordinal: 1 },
        item: { round: 1 },
        artifactId: "perf",
      }),
      progress("report", {
        instance: { siteId: "report#1", ordinal: 2 },
        item: { round: 2 },
        artifactId: "perf",
      }),
      // 同 spec 的重复声明在引擎侧是 no-op，但版本记录若真的再来一条，计数必须活下来：
      // 清零会让刷新信号归零，看板从此不再增量取数。
      progress("artifact-published", {
        instance: { siteId: "artifact#1", ordinal: 2 },
        artifact: { id: "perf", kind: "chart", version: 1, publishedAt: PUBLISHED_AT },
      }),
    ]);
    expect(state?.runs[0]?.artifacts).toEqual([
      { id: "perf", kind: "chart", version: 1, itemCount: 2 },
    ]);
  });

  it("artifact-failed 不动任何状态：失败的发布不认领 id / 种类 / 版本", () => {
    const progress = progressLog();
    const started1 = step(undefined, progress("run-started", started()));
    const failed = step(
      started1,
      progress("artifact-failed", {
        instance: { siteId: "artifact#1", ordinal: 1 },
        id: "book",
        op: "file",
        error: { code: "ArtifactSourceMissing", message: "out/book.pdf does not exist" },
      }),
    );
    // 卡片整个不出现——为一件并不存在的交付物摆一张失败卡会让用户看见不存在的东西，
    // 而脚本很可能已经 catch 住它、让子代理补写后重新发布成功了。
    expect(failed.runs[0]?.artifacts).toBeUndefined();
    // 但水位照抬：事件日志需要知道有新内容。
    expect(failed.runs[0]?.lastEventSequence).toBeGreaterThan(started1.runs[0]!.lastEventSequence);
  });

  it("artifact-failed 也不擦掉同 id 已发布成功的旧版本（第 2 版失败，第 1 版仍在）", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("artifact-published", {
        instance: { siteId: "artifact#1", ordinal: 1 },
        artifact: record(),
      }),
      progress("artifact-failed", {
        instance: { siteId: "artifact#1", ordinal: 2 },
        id: "book",
        op: "file",
        error: { code: "ArtifactTooLarge", message: "too large" },
      }),
    ]);
    expect(state?.runs[0]?.artifacts).toEqual([
      {
        id: "book",
        kind: "file",
        title: "注意力之书",
        version: 1,
        contentType: "application/pdf",
        bytes: 4_194_304,
      },
    ]);
  });

  it("载荷读不动（缺 id / 种类不在闭集 / version 非正整数）时不建卡，只抬水位", () => {
    const progress = progressLog();
    const base = step(undefined, progress("run-started", started()));
    for (const artifact of [
      { kind: "file", version: 1 },
      { id: "x", kind: "spreadsheet", version: 1 },
      { id: "x", kind: "file", version: 0 },
      { id: "x", kind: "file", version: 1.5 },
      { id: "x", kind: "file" },
      "not-a-record",
    ]) {
      const next = step(
        base,
        progress("artifact-published", {
          instance: { siteId: "artifact#1", ordinal: 1 },
          artifact,
        }),
      );
      expect(next.runs[0]?.artifacts).toBeUndefined();
      expect(next.runs[0]?.lastEventSequence).toBeGreaterThan(base.runs[0]!.lastEventSequence);
    }
  });

  it("标签 report 计数：itemCount 随条目增长，条目本身照旧进 reports", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("artifact-published", {
        instance: { siteId: "artifact#1", ordinal: 1 },
        artifact: { id: "perf", kind: "chart", version: 1, publishedAt: PUBLISHED_AT },
      }),
      progress("report", {
        instance: { siteId: "report#1", ordinal: 1 },
        item: { round: 1 },
        artifactId: "perf",
      }),
      progress("report", {
        instance: { siteId: "report#1", ordinal: 2 },
        item: { round: 2 },
        artifactId: "perf",
      }),
      // 未打标签的条目照旧只进 Results 区，不碰任何产物。
      progress("report", { instance: { siteId: "report#2", ordinal: 1 }, item: "plain" }),
    ]);
    expect(state?.runs[0]?.artifacts).toEqual([
      { id: "perf", kind: "chart", version: 1, itemCount: 2 },
    ]);
    // 一条通道一套上限：打标签只是多一个去处，不是改道。
    expect(state?.runs[0]?.reports).toEqual([
      { siteId: "report#1", ordinal: 1, preview: '{\n  "round": 1\n}', artifactId: "perf" },
      { siteId: "report#1", ordinal: 2, preview: '{\n  "round": 2\n}', artifactId: "perf" },
      { siteId: "report#2", ordinal: 1, preview: "plain" },
    ]);
    expect(workflowRunsStateSchema.parse(state)).toEqual(state);
  });

  it("计数幂等：同一条标签 report 重放不重复计数（去重键与 reports 表同为 (siteId, ordinal)）", () => {
    const progress = progressLog();
    const declared = reduceAll([
      progress("run-started", started()),
      progress("artifact-published", {
        instance: { siteId: "artifact#1", ordinal: 1 },
        artifact: { id: "perf", kind: "chart", version: 1, publishedAt: PUBLISHED_AT },
      }),
    ]);
    const event = progress("report", {
      instance: { siteId: "report#1", ordinal: 1 },
      item: { round: 1 },
      artifactId: "perf",
    });
    const once = step(declared, event);
    expect(once.runs[0]?.artifacts?.[0]?.itemCount).toBe(1);
    // 逐字节相同 ⇒ 顶层比对返回 null ⇒ 不抬 revision、不改状态。
    expect(reduceWorkflowRunsState(once, event)).toBeNull();
    expect(once.runs[0]?.artifacts?.[0]?.itemCount).toBe(1);
  });

  it("标签指向未在表里的 id 时忽略计数，条目仍进 reports（运行期已 failRun，这里只是防御）", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("artifact-published", {
        instance: { siteId: "artifact#1", ordinal: 1 },
        artifact: { id: "perf", kind: "chart", version: 1, publishedAt: PUBLISHED_AT },
      }),
      progress("report", {
        instance: { siteId: "report#1", ordinal: 1 },
        item: { round: 1 },
        artifactId: "ghost",
      }),
    ]);
    expect(state?.runs[0]?.artifacts).toEqual([{ id: "perf", kind: "chart", version: 1 }]);
    expect(state?.runs[0]?.reports).toEqual([
      { siteId: "report#1", ordinal: 1, preview: '{\n  "round": 1\n}', artifactId: "ghost" },
    ]);
  });

  it("一张产物都没有时标签 report 不凭空造出一个 artifacts 键", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("report", {
        instance: { siteId: "report#1", ordinal: 1 },
        item: 1,
        artifactId: "perf",
      }),
    ]);
    expect(state?.runs[0]?.artifacts).toBeUndefined();
    expect(state?.runs[0]?.reports).toHaveLength(1);
  });

  it("零件时整个键缺席（不是空数组）——Artifacts 区据此整区不渲染", () => {
    const progress = progressLog();
    const state = reduceAll([progress("run-started", started()), progress("log", { text: "hi" })]);
    expect(state?.runs[0]).not.toHaveProperty("artifacts");
  });

  it("触上限置 truncated 且不再增长，但表内已有的 id 仍可更新版本与计数", () => {
    const progress = progressLog();
    let state = step(undefined, progress("run-started", started()));
    for (let index = 0; index < WORKFLOW_RUNS_LIMITS.maxArtifacts; index += 1) {
      state = step(
        state,
        progress("artifact-published", {
          instance: { siteId: `artifact#${index + 1}`, ordinal: 1 },
          artifact: { id: `a${index}`, kind: "markdown", version: 1, publishedAt: PUBLISHED_AT },
        }),
      );
    }
    expect(state.runs[0]?.artifacts).toHaveLength(WORKFLOW_RUNS_LIMITS.maxArtifacts);
    expect(state.runs[0]?.truncated).toBeUndefined();
    const overflowed = step(
      state,
      progress("artifact-published", {
        instance: { siteId: "artifact#33", ordinal: 1 },
        artifact: { id: "a33", kind: "markdown", version: 1, publishedAt: PUBLISHED_AT },
      }),
    );
    expect(overflowed.runs[0]?.artifacts).toHaveLength(WORKFLOW_RUNS_LIMITS.maxArtifacts);
    expect(overflowed.runs[0]?.truncated).toBe(true);
    // 拒新、仍更新已有：把一张卡的版本冻在第 1 版比少列一张卡更误导。
    const updated = step(
      overflowed,
      progress("artifact-published", {
        instance: { siteId: "artifact#1", ordinal: 2 },
        artifact: { id: "a0", kind: "markdown", version: 2, publishedAt: PUBLISHED_AT },
      }),
    );
    expect(updated.runs[0]?.artifacts?.[0]).toEqual({ id: "a0", kind: "markdown", version: 2 });
    expect(workflowRunsStateSchema.parse(updated)).toEqual(updated);
  });

  it("产物不进图也不计步：nodes / actors / usage 一个字不动", () => {
    const progress = progressLog();
    const before = reduceAll([
      progress("run-started", started()),
      progress("actor-created", { actor: { siteId: "actor#1", ordinal: 1 }, name: "writer" }),
    ]);
    const after = step(
      before,
      progress("artifact-published", {
        instance: { siteId: "artifact#1", ordinal: 1 },
        artifact: record(),
      }),
    );
    expect(after.runs[0]?.nodes).toEqual(before?.runs[0]?.nodes);
    expect(after.runs[0]?.actors).toEqual(before?.runs[0]?.actors);
    expect(after.runs[0]?.usage).toEqual(before?.runs[0]?.usage);
  });

  it("幂等：同一条 artifact-published / artifact-failed 重放得到 null", () => {
    const progress = progressLog();
    const base = step(undefined, progress("run-started", started()));
    const publishEvent = progress("artifact-published", {
      instance: { siteId: "artifact#1", ordinal: 1 },
      artifact: record(),
    });
    const published = step(base, publishEvent);
    expect(reduceWorkflowRunsState(published, publishEvent)).toBeNull();
    // artifact-failed 不改任何**展示**状态，但仍抬水位（事件日志要知道有新内容），
    // 所以它的第一次不是 null，重放才是。
    const failEvent = progress("artifact-failed", {
      instance: { siteId: "artifact#2", ordinal: 1 },
      id: "gone",
      op: "file",
      error: { code: "ArtifactSourceMissing", message: "missing" },
    });
    const failedOnce = step(published, failEvent);
    expect(reduceWorkflowRunsState(failedOnce, failEvent)).toBeNull();
  });
});

// ── 阶段进入记录（docs/dynamic-workflow/presentation.md）──────────
describe("workflowRuns reducer · run-launched（声明阶段表）", () => {
  it("run-launched 携 phaseNames → run.phaseNames 按声明序落位，裁到 maxPhases × maxPhaseNameLength", () => {
    const progress = progressLog();
    const long = "p".repeat(WORKFLOW_RUNS_LIMITS.maxPhaseNameLength + 5);
    const many = Array.from({ length: WORKFLOW_RUNS_LIMITS.maxPhases + 2 }, (_, i) => `s${i}`);
    const state = step(
      step(undefined, progress("run-started", started())),
      progress("run-launched", { inputId: "in-1", phaseNames: ["plan", long, ...many] }),
    );
    const run = state.runs[0]!;
    expect(run.phaseNames).toHaveLength(WORKFLOW_RUNS_LIMITS.maxPhases);
    expect(run.phaseNames?.[0]).toBe("plan");
    expect(run.phaseNames?.[1]).toBe("p".repeat(WORKFLOW_RUNS_LIMITS.maxPhaseNameLength));
    expect(workflowRunsStateSchema.safeParse(state).success).toBe(true);
  });

  it("没有 phaseNames（旧 CLI / 无标记脚本）或空表 → 只抬水位，不建键", () => {
    const progress = progressLog();
    const base = step(undefined, progress("run-started", started()));
    const anchored = step(base, progress("run-launched", { inputId: "in-1" }));
    expect(anchored.runs[0]?.phaseNames).toBeUndefined();
    expect(anchored.runs[0]?.lastEventSequence).toBe(1);
    const empty = step(anchored, progress("run-launched", { inputId: "in-1", phaseNames: [] }));
    expect(empty.runs[0]?.phaseNames).toBeUndefined();
  });

  it("run-launched 携 phaseAlongside → 裁到被接受的名字表，越界 / 自指 / 重复 / 非整数丢掉", () => {
    const progress = progressLog();
    const state = step(
      step(undefined, progress("run-started", started())),
      progress("run-launched", {
        inputId: "in-1",
        phaseNames: ["A", "B", "C"],
        // B 与 A 并行；其余每一项都该被丢掉：自指、越界、负数、小数、重复，以及名字表之外的第四行。
        phaseAlongside: [[], [0, 1, 7, -1, 1.5, 0], [3], [0]],
      }),
    );
    const run = state.runs[0]!;
    // 表按被接受的名字表裁齐——下标指向的就是它，多出来的一行没有站可依。
    expect(run.phaseAlongside).toHaveLength(3);
    expect(run.phaseAlongside).toEqual([[], [0], []]);
    expect(workflowRunsStateSchema.safeParse(state).success).toBe(true);
  });

  it("phaseNames 不在场、或没有一项并行 → phaseAlongside 一起不建键", () => {
    const progress = progressLog();
    const base = step(undefined, progress("run-started", started()));
    // 名字表被拒（缺席）时下标没有可指的表，整张表一起丢。
    const nameless = step(
      base,
      progress("run-launched", { inputId: "in-1", phaseAlongside: [[1], [0]] }),
    );
    expect(nameless.runs[0]?.phaseNames).toBeUndefined();
    expect(nameless.runs[0]?.phaseAlongside).toBeUndefined();
    // 名字表立住但一项都不剩：缺席就是「这条轨道是一条直线」，不是一串空数组。
    const straight = step(
      base,
      progress("run-launched", {
        inputId: "in-1",
        phaseNames: ["A", "B"],
        phaseAlongside: [[], [1]],
      }),
    );
    expect(straight.runs[0]?.phaseNames).toEqual(["A", "B"]);
    expect(straight.runs[0]?.phaseAlongside).toBeUndefined();
  });

  it("resume 的 run-started 不清 phaseNames（同一世只记一次，重放幂等）", () => {
    const progress = progressLog();
    const launched = step(
      step(undefined, progress("run-started", started())),
      progress("run-launched", { inputId: "in-1", phaseNames: ["plan", "verify"] }),
    );
    const settled = step(launched, progress("run-settled", { status: "stopped", stopReason: "user" }));
    const resumed = step(settled, progress("run-started", started()));
    expect(resumed.runs[0]?.phaseNames).toEqual(["plan", "verify"]);
    expect(
      reduceWorkflowRunsState(
        resumed,
        progress("run-launched", { inputId: "in-1", phaseNames: ["plan", "verify"] }, { sequence: 3 }),
      ),
    ).toBeNull();
  });
});

describe("workflowRuns reducer · phase-entered", () => {
  it("首进建条、再入取 max、currentPhase 跟最后一条；不碰 nodes", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("phase-entered", { name: "plan", ordinal: 1 }),
      progress("phase-entered", { name: "verify", ordinal: 1 }),
      progress("phase-entered", { name: "plan", ordinal: 2 }),
    ]);
    expect(state?.runs[0]?.phases).toEqual([
      { name: "plan", rounds: 2 },
      { name: "verify", rounds: 1 },
    ]);
    expect(state?.runs[0]?.currentPhase).toBe("plan");
    expect(state?.runs[0]?.nodes).toEqual([]);
    expect(workflowRunsStateSchema.parse(state)).toEqual(state);
  });

  it("重放幂等：resume 重跑的前缀逐条无变化（rounds 取 max，不是 +1）", () => {
    const progress = progressLog();
    const base = reduceAll([
      progress("run-started", started()),
      progress("phase-entered", { name: "plan", ordinal: 1 }),
      progress("phase-entered", { name: "plan", ordinal: 2 }),
    ]);
    // 引擎在 resume 时从 1 数起再发一遍：rounds 不能变成 3、4。
    const replayed = reduceAll(
      [
        progress("phase-entered", { name: "plan", ordinal: 1 }),
        progress("phase-entered", { name: "plan", ordinal: 2 }),
      ],
      base,
    );
    expect(replayed?.runs[0]?.phases).toEqual([{ name: "plan", rounds: 2 }]);
  });

  it("从未进入过任何阶段时两键缺席；ordinal 缺席按 1 记；名字截到上界", () => {
    const progress = progressLog();
    const started1 = step(undefined, progress("run-started", started()));
    expect(started1.runs[0]?.phases).toBeUndefined();
    expect(started1.runs[0]?.currentPhase).toBeUndefined();
    const long = "长".repeat(WORKFLOW_RUNS_LIMITS.maxPhaseNameLength + 10);
    const next = step(started1, progress("phase-entered", { name: long }));
    expect(next.runs[0]?.phases).toEqual([
      { name: "长".repeat(WORKFLOW_RUNS_LIMITS.maxPhaseNameLength), rounds: 1 },
    ]);
    expect(workflowRunsStateSchema.parse(next)).toEqual(next);
  });

  it("触界：第 33 个不同阶段不建条但置 truncated，已有条目照常更新", () => {
    const progress = progressLog();
    const envelopes = [progress("run-started", started())];
    for (let i = 0; i < WORKFLOW_RUNS_LIMITS.maxPhases; i += 1) {
      envelopes.push(progress("phase-entered", { name: `p${i}`, ordinal: 1 }));
    }
    envelopes.push(progress("phase-entered", { name: "overflow", ordinal: 1 }));
    envelopes.push(progress("phase-entered", { name: "p0", ordinal: 2 }));
    const state = reduceAll(envelopes);
    expect(state?.runs[0]?.phases).toHaveLength(WORKFLOW_RUNS_LIMITS.maxPhases);
    expect(state?.runs[0]?.phases?.[0]).toEqual({ name: "p0", rounds: 2 });
    expect(state?.runs[0]?.truncated).toBe(true);
    // 当前阶段仍然跟着最后一条走——越界的阶段进不了表，但「控制流在哪」是事实。
    expect(state?.runs[0]?.currentPhase).toBe("p0");
  });
});

// ── 实例的出生阶段坐标（docs/dynamic-workflow/presentation.md）──────
// 静态因果图按阶段拷贝共享站点，运行时实例必须带同一个坐标，否则每张卡都认领全部实例
// （「所有子代理出现在所有阶段」）。引擎只在**出生事件**上打戳：actor-created / node-queued /
// node-settled { cached }；其余节点事件不带，由本 reducer 沿用 actorSiteId 的先例向前携带。
describe("workflowRuns reducer · phaseName（实例的出生阶段）", () => {
  it("actor 从 actor-created 取 phaseName", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("phase-entered", { name: "调查", ordinal: 1 }),
      progress("actor-created", {
        actor: { siteId: "actor#1", ordinal: 1 },
        name: "reader",
        phaseName: "调查",
      }),
      // 标记之前出生的实例不带戳（引擎的 currentPhase 当时是 undefined）。
      progress("actor-created", { actor: { siteId: "actor#0", ordinal: 1 } }),
    ]);
    expect(state?.runs[0]?.actors).toEqual([
      { siteId: "actor#1", ordinal: 1, name: "reader", phaseName: "调查", status: "waiting" },
      { siteId: "actor#0", ordinal: 1, status: "waiting" },
    ]);
    expect(workflowRunsStateSchema.parse(state)).toEqual(state);
  });

  it("节点从 node-queued 取，并在 dispatched / executing / settled 上携带", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("node-queued", {
        instance: { siteId: "ask#1", ordinal: 37 },
        kind: "ask",
        actor: { siteId: "actor#1", ordinal: 37 },
        phaseName: "第三阶段",
      }),
      progress("node-dispatched", { instance: { siteId: "ask#1", ordinal: 37 } }),
      progress("node-executing", { instance: { siteId: "ask#1", ordinal: 37 } }),
      progress("node-settled", { instance: { siteId: "ask#1", ordinal: 37 }, outcome: "ok" }),
    ]);
    expect(state?.runs[0]?.nodes).toEqual([
      {
        siteId: "ask#1",
        ordinal: 37,
        kind: "ask",
        phase: "settled",
        outcome: "ok",
        actorSiteId: "actor#1",
        actorOrdinal: 37,
        phaseName: "第三阶段",
      },
    ]);
    expect(workflowRunsStateSchema.parse(state)).toEqual(state);
  });

  it("cached settle 没有前序 queued，戳直接从这条事件取", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      // resume / amend-resume 的完结命中短路：不经 node-queued，settled 就是它的出生事件。
      progress("node-settled", {
        instance: { siteId: "ask#1", ordinal: 2 },
        actor: { siteId: "actor#1", ordinal: 2 },
        outcome: "ok",
        cached: true,
        phaseName: "复核",
      }),
    ]);
    expect(state?.runs[0]?.nodes).toEqual([
      {
        siteId: "ask#1",
        ordinal: 2,
        phase: "settled",
        outcome: "ok",
        cached: true,
        actorSiteId: "actor#1",
        actorOrdinal: 2,
        phaseName: "复核",
      },
    ]);
  });

  it("名字截到上界（128），actor 与 node 同一条界", () => {
    const progress = progressLog();
    const long = "长".repeat(WORKFLOW_RUNS_LIMITS.maxPhaseNameLength + 10);
    const bounded = "长".repeat(WORKFLOW_RUNS_LIMITS.maxPhaseNameLength);
    const state = reduceAll([
      progress("run-started", started()),
      progress("actor-created", { actor: { siteId: "actor#1", ordinal: 1 }, phaseName: long }),
      progress("node-queued", {
        instance: { siteId: "ask#1", ordinal: 1 },
        kind: "ask",
        phaseName: long,
      }),
    ]);
    expect(state?.runs[0]?.actors[0]?.phaseName).toBe(bounded);
    expect(state?.runs[0]?.nodes[0]?.phaseName).toBe(bounded);
    // 截断后仍在界内：一个 138 字的阶段名不该让父会话之后的每一帧被渲染端拒收。
    expect(workflowRunsStateSchema.parse(state)).toEqual(state);
  });

  it("旧载荷（无该键）归约结果逐字节不变：状态里不出现 phaseName", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("actor-created", { actor: { siteId: "actor#1", ordinal: 1 }, name: "reader" }),
      progress("node-queued", {
        instance: { siteId: "ask#1", ordinal: 1 },
        kind: "ask",
        actor: { siteId: "actor#1", ordinal: 1 },
      }),
      progress("node-settled", { instance: { siteId: "ask#1", ordinal: 1 }, outcome: "ok" }),
    ]);
    // 投影按 JSON 逐字节比对快照判「有无变化」：一个 undefined 值的键也不许出现。
    expect(JSON.stringify(state)).not.toContain("phaseName");
    expect(state?.runs[0]?.actors).toEqual([
      { siteId: "actor#1", ordinal: 1, name: "reader", status: "completed" },
    ]);
    expect(state?.runs[0]?.nodes).toEqual([
      {
        siteId: "ask#1",
        ordinal: 1,
        kind: "ask",
        phase: "settled",
        outcome: "ok",
        actorSiteId: "actor#1",
        actorOrdinal: 1,
      },
    ]);
    expect(workflowRunsStateSchema.parse(state)).toEqual(state);
  });

  it("空串 / 非字符串戳不上线，也不擦掉已携带的戳", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("actor-created", { actor: { siteId: "actor#1", ordinal: 1 }, phaseName: "" }),
      progress("node-queued", {
        instance: { siteId: "ask#1", ordinal: 1 },
        kind: "ask",
        phaseName: "调查",
      }),
      progress("node-dispatched", { instance: { siteId: "ask#1", ordinal: 1 }, phaseName: 7 }),
    ]);
    expect(state?.runs[0]?.actors[0]).not.toHaveProperty("phaseName");
    expect(state?.runs[0]?.nodes[0]?.phaseName).toBe("调查");
  });
});

describe("run-launched：发起锚点事件只抬水位（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Token telemetry for subagents」）", () => {
  it("run-started 之后的 run-launched 不改状态，只推进 lastEventSequence", () => {
    const progress = progressLog();
    const started = step(
      undefined,
      progress("run-started", { caps: { maxConcurrency: 2 }, runId: RUN_ID }),
    );
    const before = started.runs[0];
    const after = step(
      started,
      progress("run-launched", { inputId: "launch-input-1", toolCallId: "tc-1" }),
    );
    expect(after.runs[0]).toEqual({ ...before, lastEventSequence: 1 });
    expect(workflowRunsStateSchema.parse(after)).toEqual(after);
  });
});

// ── 一次 ask 的进度读数（docs/dynamic-workflow/presentation.md「The run state the pane draws」）──
// 相位只说得出「在跑」，说不出在跑什么、跑到哪；这几个键是 GetWorkflowRun 那份态势报告的底料。
describe("workflowRuns reducer · node-progress（ask 的任务与进度读数）", () => {
  const ASK = { siteId: "ask#1", ordinal: 1 };
  const ACTOR = { siteId: "actor#1", ordinal: 1 };

  /** 一个已派发的 ask：带任务摘要出生，随后 dispatched。 */
  function assignedState(instructionsHead = "把 packages/shared 下的协议测试跑一遍并修掉红的") {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("actor-created", { actor: ACTOR, name: "planner" }),
      progress("node-queued", { instance: ASK, kind: "ask", actor: ACTOR, instructionsHead }),
      progress("node-dispatched", { instance: ASK }),
    ]);
    return { progress, state };
  }

  it("node-queued 带 instructionsHead → 落到节点上，并被后续生命周期事件向前携带", () => {
    const { progress, state } = assignedState();
    expect(state?.runs[0]?.nodes[0]).toEqual({
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      phase: "dispatched",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      instructionsHead: "把 packages/shared 下的协议测试跑一遍并修掉红的",
    });
    const settled = step(state, progress("node-settled", { instance: ASK, outcome: "ok" }));
    expect(settled.runs[0]?.nodes[0]).toMatchObject({
      phase: "settled",
      instructionsHead: "把 packages/shared 下的协议测试跑一遍并修掉红的",
    });
    expect(workflowRunsStateSchema.parse(settled)).toEqual(settled);
  });

  it("node-progress 更新三个读数：不动相位、不计步、不动 actor 状态（一个轮次解析不是生命周期跃迁）", () => {
    const { progress, state } = assignedState();
    const executing = step(state, progress("node-executing", { instance: ASK }));
    const before = executing.runs[0]!;
    const next = step(
      executing,
      progress("node-progress", {
        instance: ASK,
        turn: 2,
        toolCalls: 7,
        lastTool: { name: "Bash", target: "pnpm exec vitest run packages/shared" },
      }),
    );
    expect(next.runs[0]?.nodes[0]).toEqual({
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      phase: "executing",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      instructionsHead: "把 packages/shared 下的协议测试跑一遍并修掉红的",
      turn: 2,
      toolCalls: 7,
      lastTool: { name: "Bash", target: "pnpm exec vitest run packages/shared" },
    });
    // 只抬水位，别的 run 级事实一个字不动。
    expect(next.runs[0]?.usage).toEqual(before.usage);
    expect(next.runs[0]?.actors).toEqual(before.actors);
    expect(next.runs[0]?.lastEventSequence).toBe(before.lastEventSequence + 1);
    expect(workflowRunsStateSchema.parse(next)).toEqual(next);
  });

  it("读数被后续生命周期事件向前携带（不携带的话 node-progress 的下一条事件就把它擦了）", () => {
    const { progress, state } = assignedState();
    const withProgress = step(
      step(state, progress("node-executing", { instance: ASK })),
      progress("node-progress", {
        instance: ASK,
        turn: 3,
        toolCalls: 12,
        lastTool: { name: "Read" },
      }),
    );
    const waiting = step(withProgress, progress("node-waiting", { instance: ASK, cause: "slot" }));
    expect(waiting.runs[0]?.nodes[0]).toMatchObject({
      phase: "waiting",
      turn: 3,
      toolCalls: 12,
      lastTool: { name: "Read" },
    });
    const settled = step(waiting, progress("node-settled", { instance: ASK, outcome: "ok" }));
    expect(settled.runs[0]?.nodes[0]).toMatchObject({ phase: "settled", turn: 3, toolCalls: 12 });
  });

  it("再次 node-queued（resume 重跑同一站点）清掉上一世的读数：新一次 ask 的轮次从 1 重新数", () => {
    const { progress, state } = assignedState();
    const withProgress = step(
      state,
      progress("node-progress", {
        instance: ASK,
        turn: 7,
        toolCalls: 40,
        lastTool: { name: "Bash" },
      }),
    );
    const requeued = step(
      withProgress,
      progress("node-queued", {
        instance: ASK,
        kind: "ask",
        actor: ACTOR,
        instructionsHead: "改一版",
      }),
    );
    const node = requeued.runs[0]?.nodes[0];
    expect(node).toMatchObject({ phase: "queued", instructionsHead: "改一版" });
    expect(node).not.toHaveProperty("turn");
    expect(node).not.toHaveProperty("toolCalls");
    expect(node).not.toHaveProperty("lastTool");
    // 新一世的第一条进度就是第 1 轮：取 max 的话这里会显示 7，读面据此把一个刚开跑的 ask
    // 当成跑了半天的。
    const restarted = step(
      requeued,
      progress("node-progress", { instance: ASK, turn: 1, toolCalls: 0 }),
    );
    expect(restarted.runs[0]?.nodes[0]).toMatchObject({
      instructionsHead: "改一版",
      turn: 1,
      toolCalls: 0,
    });
    expect(restarted.runs[0]?.nodes[0]).not.toHaveProperty("lastTool");
  });

  it("缓存命中的结算也是出生事件：读数清空，任务摘要留着（完结缓存按输入哈希命中，指令逐字相同）", () => {
    // 这条钉的是「一步没走的节点不许显示上一世的读数」。走的是 resume 的完结命中短路
    // （engine.ts:228/232）：那条 node-settled 没有前序 queued，它自己就是出生事件。
    const { progress, state } = assignedState();
    const lived = step(
      state,
      progress("node-progress", {
        instance: ASK,
        turn: 9,
        toolCalls: 40,
        lastTool: { name: "Bash", target: "pnpm test" },
      }),
    );
    const cached = step(
      step(lived, progress("run-started", started())),
      progress("node-settled", { instance: ASK, outcome: "ok", cached: true }),
    );
    const node = cached.runs[0]?.nodes[0];
    expect(node).toMatchObject({
      phase: "settled",
      outcome: "ok",
      cached: true,
      instructionsHead: "把 packages/shared 下的协议测试跑一遍并修掉红的",
    });
    expect(node).not.toHaveProperty("turn");
    expect(node).not.toHaveProperty("toolCalls");
    expect(node).not.toHaveProperty("lastTool");
    expect(workflowRunsStateSchema.parse(cached)).toEqual(cached);
  });

  it("queued → settled(cached) 之间没有任何进度事件时三键始终缺席（不是 0）", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("node-queued", {
        instance: ASK,
        kind: "ask",
        actor: ACTOR,
        instructionsHead: "查一遍",
      }),
      progress("node-settled", { instance: ASK, outcome: "ok", cached: true }),
    ]);
    const node = state?.runs[0]?.nodes[0];
    expect(node).toEqual({
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      phase: "settled",
      outcome: "ok",
      cached: true,
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      instructionsHead: "查一遍",
    });
  });

  it("没有 cached 的普通 node-settled 照常携带读数（结算不是出生，跑过的账要留下）", () => {
    const { progress, state } = assignedState();
    const lived = step(
      state,
      progress("node-progress", {
        instance: ASK,
        turn: 5,
        toolCalls: 18,
        lastTool: { name: "Edit" },
      }),
    );
    const settled = step(lived, progress("node-settled", { instance: ASK, outcome: "ok" }));
    expect(settled.runs[0]?.nodes[0]).toMatchObject({
      phase: "settled",
      turn: 5,
      toolCalls: 18,
      lastTool: { name: "Edit" },
    });
  });

  it("指向表里没有的实例时不建条目，只抬水位（与其他节点事件对未知实例同族）", () => {
    const { progress, state } = assignedState();
    const before = state!.runs[0]!;
    const next = step(
      state,
      progress("node-progress", {
        instance: { siteId: "ask#9", ordinal: 9 },
        turn: 1,
        toolCalls: 0,
      }),
    );
    expect(next.runs[0]?.nodes).toEqual(before.nodes);
    expect(next.runs[0]?.lastEventSequence).toBe(before.lastEventSequence + 1);
  });

  it("instance 读不动、或三个读数一个都读不出来时，节点逐字节不变", () => {
    const { progress, state } = assignedState();
    const before = state!.runs[0]!.nodes;
    for (const payload of [
      { instance: { ordinal: 1 } },
      { instance: ASK },
      { instance: ASK, turn: 0 },
      { instance: ASK, turn: 1.5 },
      { instance: ASK, turn: Number.NaN },
      { instance: ASK, toolCalls: -1 },
      { instance: ASK, lastTool: { name: "" } },
      { instance: ASK, lastTool: "Bash" },
    ]) {
      const next = step(state, progress("node-progress", payload));
      expect(next.runs[0]?.nodes).toEqual(before);
    }
  });

  it("读不出的单个字段保持已知值，读得出的照常覆盖（后来者覆盖，不是取 max）", () => {
    const { progress, state } = assignedState();
    const first = step(
      state,
      progress("node-progress", {
        instance: ASK,
        turn: 4,
        toolCalls: 11,
        lastTool: { name: "Edit", target: "packages/shared/src/index.ts" },
      }),
    );
    // 只带 toolCalls 的一条：turn 与 lastTool 保持，不被擦掉。
    const second = step(first, progress("node-progress", { instance: ASK, toolCalls: 12 }));
    expect(second.runs[0]?.nodes[0]).toMatchObject({
      turn: 4,
      toolCalls: 12,
      lastTool: { name: "Edit", target: "packages/shared/src/index.ts" },
    });
    // 取 max 会把这里冻在 4；后来者覆盖才让重跑的 ask 能退回 1。
    const third = step(second, progress("node-progress", { instance: ASK, turn: 1, toolCalls: 0 }));
    expect(third.runs[0]?.nodes[0]).toMatchObject({ turn: 1, toolCalls: 0 });
  });

  it("三个字符串按线上界裁剪（生产侧已切，这里是第二道闸），产出仍过 strict schema", () => {
    const limits = WORKFLOW_RUNS_LIMITS;
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("node-queued", {
        instance: ASK,
        kind: "ask",
        instructionsHead: "指".repeat(limits.maxInstructionsHeadLength + 20),
      }),
      progress("node-progress", {
        instance: ASK,
        turn: 1,
        toolCalls: 1,
        lastTool: {
          name: "T".repeat(limits.maxLastToolNameLength + 10),
          target: "p".repeat(limits.maxLastToolTargetLength + 10),
        },
      }),
    ]);
    const node = state?.runs[0]?.nodes[0];
    expect(node?.instructionsHead).toHaveLength(limits.maxInstructionsHeadLength);
    expect(node?.lastTool?.name).toHaveLength(limits.maxLastToolNameLength);
    expect(node?.lastTool?.target).toHaveLength(limits.maxLastToolTargetLength);
    expect(workflowRunsStateSchema.parse(state)).toEqual(state);
  });

  it("幂等：同一条 node-progress 立刻重放只抬水位，内容不变", () => {
    const { progress, state } = assignedState();
    const payload = { instance: ASK, turn: 2, toolCalls: 3, lastTool: { name: "Read" } };
    const first = step(state, progress("node-progress", payload));
    const second = step(first, progress("node-progress", payload));
    expect(second.runs[0]?.nodes).toEqual(first.runs[0]?.nodes);
    // 同一条事件（同 sequence）重放才是真的无变化：水位不动，reducer 返回 null。
    const replay = reduceWorkflowRunsState(first, {
      runId: RUN_ID,
      toolCallId: "tc-1",
      sequence: first.runs[0]!.lastEventSequence,
      eventType: "node-progress",
      payload,
    });
    expect(replay).toBeNull();
  });

  it("旧 journal（没有这些键）归约结果逐字节不变：状态里不出现这四个字段", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("node-queued", { instance: ASK, kind: "ask", actor: ACTOR }),
      progress("node-dispatched", { instance: ASK }),
      progress("node-settled", { instance: ASK, outcome: "ok" }),
    ]);
    const node = state?.runs[0]?.nodes[0];
    expect(node).toEqual({
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      phase: "settled",
      outcome: "ok",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
    });
    expect(workflowRunsStateSchema.parse(state)).toEqual(state);
  });

  it("更新的 CLI 发来的未知事件仍然落到 default：只抬水位，不建节点", () => {
    const { progress, state } = assignedState();
    const before = state!.runs[0]!;
    const next = step(
      state,
      progress("node-heartbeat", { instance: { siteId: "ask#2", ordinal: 1 } }),
    );
    expect(next.runs[0]).toEqual({ ...before, lastEventSequence: before.lastEventSequence + 1 });
  });
});
