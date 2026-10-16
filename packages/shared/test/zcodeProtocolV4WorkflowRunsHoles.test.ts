// 留白（typed holes）在 shared 协议层的三份契约（docs/dynamic-workflow/presentation.md「Holes on the timeline」、
// docs/dynamic-workflow/transcript-and-notifications.md「The hole row's live state」）：
//   1. display 载荷的 `holes` / `fill` 字段与通知载荷的 `hole` 种类过 strict schema；
//   2. reducer 把 `hole-reached` / `hole-filled` 归约成 run 的 `holes[]`、并同步 `phaseNames` 与对齐的 `phaseHoles`；
//   3. sessions-index 的侧栏摘要把留白站标成 open / waiting，并交出「等待补全」的那个名字。
import { describe, expect, it } from "vitest";
import {
  WORKFLOW_RUNS_LIMITS,
  deriveSessionWorkflowPhases,
  reduceWorkflowRunsState,
  toolCallCreateWorkflowDisplaySchema,
  workflowNotificationMetaSchema,
  workflowRunsStateSchema,
  type WorkflowRunProgressEnvelope,
  type WorkflowRunState,
  type WorkflowRunsState,
} from "../src/zcode-protocol-v4/index.js";
import { deriveSessionWorkflowActivity } from "../src/zcode-protocol-v4/index.js";
import { getZCodeToolFamilyForName, normalizeZCodeToolName } from "../src/tool-identity.js";

const RUN_ID = "dwfrun-holes";

function progressLog(runId = RUN_ID) {
  let sequence = -1;
  return function progress(
    eventType: string,
    payload: Record<string, unknown> = {},
  ): WorkflowRunProgressEnvelope {
    sequence += 1;
    return { runId, toolCallId: "tc-1", sequence, eventType, payload };
  };
}

function step(
  state: WorkflowRunsState | undefined,
  envelope: WorkflowRunProgressEnvelope,
): WorkflowRunsState {
  const next = reduceWorkflowRunsState(state, envelope);
  if (next === null) throw new Error(`事件本应产生变化却返回 null：${envelope.eventType}`);
  return next;
}

function reduceAll(
  envelopes: readonly WorkflowRunProgressEnvelope[],
): WorkflowRunsState | undefined {
  let state: WorkflowRunsState | undefined;
  for (const envelope of envelopes) state = reduceWorkflowRunsState(state, envelope) ?? state;
  return state;
}

const REACHED = {
  instance: { siteId: "hole#1", ordinal: 1 },
  name: "决定分组",
  prompt: "侦察结果如下",
  phaseName: "决定分组",
  type: "Plan",
  reachedAt: 1_700_000_000_000,
};

describe("display 载荷：holes 与 fill", () => {
  const graph = {
    steps: [{ id: "ask#1", kind: "ask", label: "scout", lane: "actor#1", phase: "phase#1" }],
    lanes: [{ id: "actor#1", name: "scout" }],
    participants: [{ id: "p1", phase: "phase#1", lane: "actor#1", steps: ["ask#1"] }],
    handoffs: [],
    phases: [
      { id: "phase#1", name: "探索" },
      { id: "hole#1", name: "决定分组" },
      { id: "phase#2", name: "冒烟测试", fill: "hole#1" },
    ],
    holes: [{ siteId: "hole#2", name: "评判", type: "Verdict", tail: true }],
  };

  it("phases[].fill、steps[].fill 与 holes[] 过 strict schema；旧载荷不带它们照常通过", () => {
    const display = {
      kind: "create_workflow",
      ok: true,
      errorCount: 0,
      diagnostics: [],
      causalityGraph: graph,
    };
    const parsed = toolCallCreateWorkflowDisplaySchema.safeParse(display);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.causalityGraph?.holes?.[0]?.tail).toBe(true);
    expect(parsed.success && parsed.data.causalityGraph?.phases?.[2]?.fill).toBe("hole#1");
    const withFillStep = {
      ...display,
      causalityGraph: { ...graph, steps: [{ ...graph.steps[0], fill: "hole#1" }] },
    };
    expect(toolCallCreateWorkflowDisplaySchema.safeParse(withFillStep).success).toBe(true);
    const { holes: _holes, ...legacyGraph } = graph;
    void _holes;
    expect(
      toolCallCreateWorkflowDisplaySchema.safeParse({ ...display, causalityGraph: legacyGraph })
        .success,
    ).toBe(true);
  });

  it("开着的留白自己的站点是 kind `hole`、车道 `main` 的 step（与 contracts 的 CREATE_WORKFLOW_STEP_KINDS 同步）", () => {
    const holeStep = { id: "hole#2", kind: "hole", label: "评判", lane: "main", phase: "hole#2" };
    const parsed = toolCallCreateWorkflowDisplaySchema.safeParse({
      kind: "create_workflow",
      ok: true,
      errorCount: 0,
      diagnostics: [],
      causalityGraph: { ...graph, steps: [...graph.steps, holeStep] },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.causalityGraph?.steps[1]?.kind).toBe("hole");
    expect(
      toolCallCreateWorkflowDisplaySchema.safeParse({
        kind: "create_workflow",
        ok: true,
        errorCount: 0,
        diagnostics: [],
        causalityGraph: { ...graph, steps: [{ ...holeStep, kind: "gap" }] },
      }).success,
    ).toBe(false);
  });

  it("display.fill：补全行的站点 id 与名字过 strict；未知键与空名被拒；缺席照常通过", () => {
    const display = {
      kind: "create_workflow",
      ok: true,
      errorCount: 0,
      diagnostics: [],
      causalityGraph: graph,
    };
    const fill = {
      siteId: "hole#1",
      name: "决定分组",
      draftPath: ".zcode/workflow-drafts/a.dwf.ts",
      line: 12,
    };
    expect(toolCallCreateWorkflowDisplaySchema.safeParse({ ...display, fill }).success).toBe(true);
    expect(
      toolCallCreateWorkflowDisplaySchema.safeParse({
        ...display,
        fill: { siteId: "hole#1", name: "" },
      }).success,
    ).toBe(false);
    expect(
      toolCallCreateWorkflowDisplaySchema.safeParse({ ...display, fill: { ...fill, type: "Plan" } })
        .success,
    ).toBe(false);
  });

  it("holes 上界 32；hole 条目里的未知键被 strict 拒绝", () => {
    const many = Array.from({ length: 33 }, (_, i) => ({
      siteId: `hole#${i + 1}`,
      name: `h${i + 1}`,
      type: "T",
    }));
    expect(
      toolCallCreateWorkflowDisplaySchema.safeParse({
        kind: "create_workflow",
        ok: true,
        errorCount: 0,
        diagnostics: [],
        causalityGraph: { ...graph, holes: many },
      }).success,
    ).toBe(false);
    expect(
      toolCallCreateWorkflowDisplaySchema.safeParse({
        kind: "create_workflow",
        ok: true,
        errorCount: 0,
        diagnostics: [],
        causalityGraph: { ...graph, holes: [{ siteId: "hole#9", name: "x", type: "T", extra: 1 }] },
      }).success,
    ).toBe(false);
  });
});

describe("通知载荷：kind = hole", () => {
  it("最小与完整两形都通过；prompt 超 4000 被拒", () => {
    expect(
      workflowNotificationMetaSchema.safeParse({
        kind: "hole",
        siteId: "hole#1",
        ordinal: 1,
        name: "决定分组",
        type: "Plan",
      }).success,
    ).toBe(true);
    expect(
      workflowNotificationMetaSchema.safeParse({
        kind: "hole",
        siteId: "hole#1",
        ordinal: 1,
        name: "决定分组",
        type: "Plan",
        prompt: "p",
        draftPath: "/w/.zcode/workflow-drafts/flaky.dwf.ts",
        line: 12,
        before: "探索",
        after: "执行",
        reachedAt: 1,
      }).success,
    ).toBe(true);
    expect(
      workflowNotificationMetaSchema.safeParse({
        kind: "hole",
        siteId: "hole#1",
        ordinal: 1,
        name: "n",
        type: "T",
        prompt: "x".repeat(4001),
      }).success,
    ).toBe(false);
  });
});

describe("tool identity：FillWorkflowHole 属于 workflow family", () => {
  it("按名归一并落到 workflow family（确认窗按 family 选运行确认块）", () => {
    expect(normalizeZCodeToolName("fillworkflowhole")).toBe("FillWorkflowHole");
    expect(getZCodeToolFamilyForName("FillWorkflowHole")).toBe("workflow");
  });
});

describe("workflowRuns reducer · hole-reached / hole-filled", () => {
  it("hole-reached 建一条 waiting 记录：站点 id 去重，type / prompt / since 随载荷而来", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", { runId: RUN_ID, caps: {} }),
      progress("hole-reached", REACHED),
    ]);
    expect(state?.runs[0]?.holes).toEqual([
      {
        siteId: "hole#1",
        ordinal: 1,
        name: "决定分组",
        type: "Plan",
        prompt: "侦察结果如下",
        state: "waiting",
        since: REACHED.reachedAt,
      },
    ]);
    expect(workflowRunsStateSchema.safeParse(state).success).toBe(true);
  });

  it("prompt 截到 500 字（499 字加 …）；再次到达不带 prompt / type 时沿用记过的", () => {
    const progress = progressLog();
    const long = "长".repeat(WORKFLOW_RUNS_LIMITS.maxHolePromptLength + 40);
    const base = reduceAll([
      progress("run-started", { runId: RUN_ID, caps: {} }),
      progress("hole-reached", { ...REACHED, prompt: long }),
    ]);
    const prompt = base?.runs[0]?.holes?.[0]?.prompt;
    expect(prompt).toHaveLength(WORKFLOW_RUNS_LIMITS.maxHolePromptLength);
    expect(prompt?.endsWith("…")).toBe(true);
    expect(workflowRunsStateSchema.safeParse(base).success).toBe(true);
    const again = step(
      base,
      progress("hole-reached", { instance: { siteId: "hole#1", ordinal: 2 }, name: "决定分组" }),
    );
    expect(again.runs[0]?.holes?.[0]).toMatchObject({ ordinal: 2, type: "Plan", prompt });
  });

  it("同一站点再次到达（循环里的第二个 ordinal）只更新序号，不加第二条；重放幂等", () => {
    const progress = progressLog();
    const base = reduceAll([
      progress("run-started", { runId: RUN_ID, caps: {} }),
      progress("hole-reached", REACHED),
    ]);
    const second = progress("hole-reached", {
      ...REACHED,
      instance: { siteId: "hole#1", ordinal: 2 },
    });
    const again = step(base, second);
    expect(again.runs[0]?.holes).toHaveLength(1);
    expect(again.runs[0]?.holes?.[0]?.ordinal).toBe(2);
    // 同一条事件（同 sequence）重放：逐字节无变化 → null。
    expect(reduceWorkflowRunsState(again, second)).toBeNull();
  });

  it("type 与 reachedAt 缺席（旧 CLI / 简载荷）时键缺席，记录仍在", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", { runId: RUN_ID, caps: {} }),
      progress("hole-reached", { instance: { siteId: "hole#1", ordinal: 1 }, name: "n" }),
    ]);
    expect(state?.runs[0]?.holes).toEqual([
      { siteId: "hole#1", ordinal: 1, name: "n", state: "waiting" },
    ]);
  });

  it("name 缺席即整条无从展示：只抬水位", () => {
    const progress = progressLog();
    const base = step(undefined, progress("run-started", { runId: RUN_ID, caps: {} }));
    const next = step(
      base,
      progress("hole-reached", { instance: { siteId: "hole#1", ordinal: 1 } }),
    );
    expect(next.runs[0]).not.toHaveProperty("holes");
  });

  it("holes 上界 32：超出的站点被拒并置 truncated", () => {
    const progress = progressLog();
    let state: WorkflowRunsState | undefined = step(
      undefined,
      progress("run-started", { runId: RUN_ID, caps: {} }),
    );
    for (let i = 1; i <= WORKFLOW_RUNS_LIMITS.maxHoles + 1; i += 1) {
      state =
        reduceWorkflowRunsState(
          state,
          progress("hole-reached", {
            instance: { siteId: `hole#${i}`, ordinal: 1 },
            name: `h${i}`,
          }),
        ) ?? state;
    }
    expect(state?.runs[0]?.holes).toHaveLength(WORKFLOW_RUNS_LIMITS.maxHoles);
    expect(state?.runs[0]?.truncated).toBe(true);
  });

  it("hole-filled 把记录翻成 filled（提示语丢掉），并换上补全后的 phaseNames 与对齐的 phaseHoles", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", { runId: RUN_ID, caps: {} }),
      progress("run-launched", {
        inputId: "in-1",
        phaseNames: ["探索", "决定分组", "执行", "评判"],
        holes: [1, 3],
        phaseAlongside: [[], [], [3], []],
      }),
      progress("hole-reached", REACHED),
      progress("hole-filled", {
        siteId: "hole#1",
        filledAt: 1_700_000_001_000,
        filledBy: "main",
        phaseNames: ["探索", "决定分组", "冒烟测试", "分组", "执行", "评判"],
        holes: [5],
      }),
    ]);
    const run = state?.runs[0];
    expect(run?.holes).toEqual([
      {
        siteId: "hole#1",
        ordinal: 1,
        name: "决定分组",
        type: "Plan",
        state: "filled",
        since: REACHED.reachedAt,
        filledAt: 1_700_000_001_000,
        filledBy: "main",
      },
    ]);
    expect(run?.phaseNames).toEqual(["探索", "决定分组", "冒烟测试", "分组", "执行", "评判"]);
    expect(run?.phaseHoles).toEqual([5]);
    // 「同时在跑」表按插入位置右移：原来 执行(2) ∥ 评判(3) → 执行(4) ∥ 评判(5)。
    expect(run?.phaseAlongside).toEqual([[], [], [], [], [5], []]);
    expect(workflowRunsStateSchema.safeParse(state).success).toBe(true);
  });

  it("run-launched 的 holes 下标：越界、非整数、重复一律丢；phaseNames 缺席时不建 phaseHoles", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", { runId: RUN_ID, caps: {} }),
      progress("run-launched", {
        inputId: "in-1",
        phaseNames: ["a", "b"],
        holes: [1, 1, 7, -1, 0.5],
      }),
    ]);
    expect(state?.runs[0]?.phaseHoles).toEqual([1]);
    const bare = reduceAll([
      progress("run-started", { runId: RUN_ID, caps: {} }),
      progress("run-launched", { inputId: "in-2", holes: [0] }),
    ]);
    expect(bare?.runs[0]).not.toHaveProperty("phaseHoles");
  });

  it("hole-filled 不认识的站点：不造 holes 记录，但阶段表照换；siteId 缺席只抬水位", () => {
    const progress = progressLog();
    const base = reduceAll([
      progress("run-started", { runId: RUN_ID, caps: {} }),
      progress("run-launched", { inputId: "in-1", phaseNames: ["a", "h"], holes: [1] }),
    ]);
    const filled = step(
      base,
      progress("hole-filled", { siteId: "hole#9", filledAt: 1, phaseNames: ["a", "h", "x"] }),
    );
    expect(filled.runs[0]).not.toHaveProperty("holes");
    expect(filled.runs[0]?.phaseNames).toEqual(["a", "h", "x"]);
    expect(filled.runs[0]).not.toHaveProperty("phaseHoles");
    // siteId 缺席：只抬水位——除了 lastEventSequence 之外什么都不变。
    const bare = step(filled, progress("hole-filled", { filledAt: 2 }));
    expect(bare.runs[0]).toEqual({
      ...filled.runs[0],
      lastEventSequence: bare.runs[0]?.lastEventSequence,
    });
  });

  it("新的一世（run-started）剥掉 waiting 记录、保留 filled；终态同样清掉 waiting", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", { runId: RUN_ID, caps: {} }),
      progress("hole-reached", REACHED),
      progress("hole-filled", { siteId: "hole#1", filledAt: 5, phaseNames: ["决定分组"] }),
      progress("hole-reached", {
        instance: { siteId: "hole#2", ordinal: 1 },
        name: "评判",
        type: "Verdict",
      }),
    ]);
    expect(state?.runs[0]?.holes?.map((hole) => hole.state)).toEqual(["filled", "waiting"]);
    const settled = step(state, progress("run-settled", { status: "stopped", stopReason: "user" }));
    expect(settled.runs[0]?.holes?.map((hole) => hole.siteId)).toEqual(["hole#1"]);
    const resumed = step(settled, progress("run-started", { runId: RUN_ID, caps: {} }));
    expect(resumed.runs[0]?.holes?.map((hole) => hole.siteId)).toEqual(["hole#1"]);
    const reReached = step(
      resumed,
      progress("hole-reached", { instance: { siteId: "hole#2", ordinal: 1 }, name: "评判" }),
    );
    expect(reReached.runs[0]?.holes?.map((hole) => hole.state)).toEqual(["filled", "waiting"]);
  });
});

describe("sessions-index 侧栏摘要 · 留白站", () => {
  function run(overrides: Partial<WorkflowRunState> & { runId: string }): WorkflowRunState {
    return {
      status: "running",
      usage: { spentTokens: 0, nodesUsed: 0 },
      actors: [],
      nodes: [],
      lastEventSequence: 0,
      ...overrides,
    };
  }

  it("phaseHoles 标出的站带 hole: open；run.holes 里 waiting 的那一站带 hole: waiting", () => {
    const phases = deriveSessionWorkflowPhases(
      run({
        runId: "r1",
        phaseNames: ["探索", "决定分组", "执行", "评判"],
        phaseHoles: [1, 3],
        phases: [{ name: "探索", rounds: 1 }],
        currentPhase: "探索",
        holes: [{ siteId: "hole#1", ordinal: 1, name: "决定分组", state: "waiting" }],
      }),
    );
    expect(phases.map((phase) => phase.hole)).toEqual([undefined, "waiting", undefined, "open"]);
    expect(phases[1]?.status).toBe("pending");
  });

  it("补全后的留白不再是留白：phaseHoles 不再指向它，摘要行也没有 hole 键", () => {
    const phases = deriveSessionWorkflowPhases(
      run({
        runId: "r1",
        phaseNames: ["探索", "决定分组", "冒烟测试", "执行"],
        phaseHoles: [],
        holes: [{ siteId: "hole#1", ordinal: 1, name: "决定分组", state: "filled", filledAt: 1 }],
      }),
    );
    expect(phases.every((phase) => phase.hole === undefined)).toBe(true);
  });

  it("运行摘要交出 waitingHole：正在等补全的留白名（侧栏写「{name} · 等待补全」）", () => {
    const activity = deriveSessionWorkflowActivity({
      workflowRuns: {
        revision: 1,
        runs: [
          run({
            runId: "r1",
            phaseNames: ["探索", "决定分组"],
            phaseHoles: [1],
            holes: [{ siteId: "hole#1", ordinal: 1, name: "决定分组", state: "waiting" }],
          }),
          run({ runId: "r2", phaseNames: ["a"] }),
        ],
      },
      backgroundWorks: [],
    });
    expect(activity?.runs[0]?.waitingHole).toBe("决定分组");
    expect(activity?.runs[1]).not.toHaveProperty("waitingHole");
  });
});
