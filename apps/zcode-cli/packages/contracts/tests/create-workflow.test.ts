import { describe, expect, it } from "vitest";
import {
  CREATE_WORKFLOW_GRAPH_MAX_HANDOFF_TYPES,
  CREATE_WORKFLOW_GRAPH_MAX_HANDOFFS,
  CREATE_WORKFLOW_GRAPH_MAX_PARTICIPANTS,
  CREATE_WORKFLOW_GRAPH_MAX_PHASE_EDGES,
  CREATE_WORKFLOW_GRAPH_MAX_PHASES,
  CREATE_WORKFLOW_GRAPH_MAX_STEPS,
  CreateWorkflowCausalityGraphSchema,
  CreateWorkflowHandoffSchema,
  CreateWorkflowParticipantSchema,
  CreateWorkflowInputJsonSchema,
  CreateWorkflowInputSchema,
  CreateWorkflowOutputJsonSchema,
  CreateWorkflowOutputSchema,
  createWorkflowPhaseAlongside,
  createWorkflowPhaseNames,
  type CreateWorkflowOutput,
} from "../src/tools/create-workflow.js";
import type { BackgroundResultOriginMeta } from "../src/events/session.events.js";
import type {
  DynamicWorkflowRunPort,
  DynamicWorkflowRunSubmitRequest,
  DynamicWorkflowRunEvent,
} from "../src/interfaces/dynamic-workflow-run.port.js";
import type { WorkflowTaskSnapshot } from "../src/interfaces/workflow.port.js";
import { createTraceId } from "../src/interfaces/shared.js";

const DIAGNOSTICS_ONLY: CreateWorkflowOutput = {
  diagnostics: [{ code: 2322, column: 7, line: 1, message: "Type error" }],
  ok: false,
  response: "The script does not typecheck.",
};

describe("CreateWorkflowOutputSchema — backgrounded run", () => {
  it("keeps accepting the diagnostics-only result unchanged", () => {
    // 坏脚本路径完全不变：handler 直接回诊断，不启动、不建 run，因此两个新字段缺席。
    const parsed = CreateWorkflowOutputSchema.parse(DIAGNOSTICS_ONLY);
    expect(parsed).toEqual(DIAGNOSTICS_ONLY);
    expect("status" in parsed).toBe(false);
    expect("backgroundTaskId" in parsed).toBe(false);
  });

  it("accepts status + backgroundTaskId when a run was started", () => {
    const output = {
      diagnostics: [],
      ok: true,
      response: "Workflow started.",
      status: "backgrounded" as const,
      backgroundTaskId: "dwf_run_01H",
    };
    expect(CreateWorkflowOutputSchema.parse(output)).toEqual(output);
  });

  it("admits only the backgrounded literal as a status", () => {
    // status 是"这次调用启动了一个后台 run"的唯一信号，不是通用状态字段：
    // running/completed 等值必须被拒，否则 executor 侧的分派要靠猜。
    for (const status of ["running", "completed", "failed", ""]) {
      expect(CreateWorkflowOutputSchema.safeParse({ ...DIAGNOSTICS_ONLY, status }).success).toBe(
        false,
      );
    }
  });

  it("requires backgroundTaskId to be a non-empty string", () => {
    for (const backgroundTaskId of ["", 42, null]) {
      expect(
        CreateWorkflowOutputSchema.safeParse({ ...DIAGNOSTICS_ONLY, backgroundTaskId }).success,
      ).toBe(false);
    }
  });

  it("stays strict about unknown keys", () => {
    // .strict() 的意义就是形状变更必须是一次显式的 schema 提交，而不是经 raw 夹带。
    expect(
      CreateWorkflowOutputSchema.safeParse({ ...DIAGNOSTICS_ONLY, runId: "smuggled" }).success,
    ).toBe(false);
  });

  it("carries both new fields into the model-facing JSON schema", () => {
    const properties = (CreateWorkflowOutputJsonSchema as { properties?: Record<string, unknown> })
      .properties;
    expect(Object.keys(properties ?? {})).toEqual(
      expect.arrayContaining(["diagnostics", "ok", "response", "status", "backgroundTaskId"]),
    );
    // 两个字段都是可选的：required 只保留今天的三个。
    const required = (CreateWorkflowOutputJsonSchema as { required?: string[] }).required ?? [];
    expect(required).not.toContain("status");
    expect(required).not.toContain("backgroundTaskId");
  });
});

// docs/dynamic-workflow/launch.md「The `CreateWorkflow` tool」：修订是 AmendWorkflow 的工作，CreateWorkflow
// 没有前驱字段——`.strict()` 让旧写法 `resume_from` 成为可见的 schema 错误，而不是被静默忽略后变成
// 一次全价重跑。
describe("CreateWorkflowInputSchema — no predecessor field", () => {
  const SCRIPT = 'return await agent("a").ask<string>("go");';

  it("rejects resume_from in every spelling", () => {
    for (const key of ["resume_from", "resumeFrom", "run_id"]) {
      expect(CreateWorkflowInputSchema.safeParse({ script: SCRIPT, [key]: "dwfrun-prev" }).success).toBe(
        false,
      );
    }
  });

  it("does not project a predecessor field into the model-facing JSON schema", () => {
    const properties = (CreateWorkflowInputJsonSchema as { properties?: Record<string, unknown> })
      .properties;
    expect(Object.keys(properties ?? {})).toEqual(
      expect.arrayContaining(["name", "script", "saved", "max_concurrency", "subagent_model"]),
    );
    expect(properties).not.toHaveProperty("resume_from");
  });

  // 子代理选型（docs/dynamic-workflow/launch.md）：模型面收一个宽松的字符串，规范化留给
  // resolveInput。空白串是错——它会让「设了但没说清」与「没设」在确认窗上长得一样。
  it("takes subagent_model as an optional trimmed non-empty string", () => {
    expect(CreateWorkflowInputSchema.parse({ script: SCRIPT })).toEqual({ script: SCRIPT });
    expect(
      CreateWorkflowInputSchema.parse({ script: SCRIPT, subagent_model: "  glm-5.3-flash  " }),
    ).toEqual({ script: SCRIPT, subagent_model: "glm-5.3-flash" });
    expect(
      CreateWorkflowInputSchema.safeParse({ script: SCRIPT, subagent_model: "   " }).success,
    ).toBe(false);
    expect(
      CreateWorkflowInputSchema.safeParse({ script: SCRIPT, subagent_model: null }).success,
    ).toBe(false);
  });
});

// docs/dynamic-workflow/launch.md「Script files」：第三条来源 `path` 与只跟它走的顶层 `args`，
// 外加两处回填事实。XOR 与「args 只跟 path」都住在 validateInput——归一化之后 `script` 与
// `path` / `saved` 同时在场是合法执行态，schema 必须容得下它。
describe("CreateWorkflowInputSchema — the file sources", () => {
  const SCRIPT = 'return await agent("a").ask<string>("go");';

  it("lists `path` and `args` for the model and hides the resolved facts", () => {
    const properties = (CreateWorkflowInputJsonSchema as { properties?: Record<string, unknown> })
      .properties;
    expect(Object.keys(properties ?? {}).sort()).toEqual([
      "args",
      "max_concurrency",
      "name",
      "path",
      "saved",
      "script",
      "subagent_model",
    ]);
    // 回填项与 `AmendWorkflow.predecessor` 同一姿态：运行时认它们，模型面不列它们。
    expect(properties).not.toHaveProperty("script_line_offset");
    const saved = (properties?.saved as { properties?: Record<string, unknown> } | undefined)
      ?.properties;
    expect(saved).not.toHaveProperty("draft");
  });

  it("accepts the normalized shape a `path` call resolves to", () => {
    const resolved = {
      script: SCRIPT,
      path: "/repo/.zcode/workflow-drafts/x.dwf.ts",
      args: { depth: 3 },
      script_line_offset: 5,
    };
    expect(CreateWorkflowInputSchema.parse(resolved)).toEqual(resolved);
    expect(CreateWorkflowInputSchema.safeParse({ path: "" }).success).toBe(false);
    expect(CreateWorkflowInputSchema.safeParse({ path: "a", script_line_offset: -1 }).success).toBe(
      false,
    );
  });

  it("accepts the normalized shape a `saved` call resolves to, draft included", () => {
    const resolved = {
      name: "nightly",
      script: SCRIPT,
      saved: {
        name: "nightly",
        args: { depth: 3 },
        path: "/repo/.zcode/workflows/nightly.dwf.ts",
        scope: "project" as const,
        draft: "/repo/.zcode/workflow-drafts/nightly.dwf.ts",
      },
      script_line_offset: 3,
    };
    expect(CreateWorkflowInputSchema.parse(resolved)).toEqual(resolved);
  });
});

describe("BackgroundResultOriginMeta", () => {
  it("admits workflow as a background source", () => {
    // 完成通知复用整条后台管线，所以 workflow run 的终态要能标注来源。
    const meta: BackgroundResultOriginMeta = {
      backgroundSource: "workflow",
      workId: "dwf_run_01H",
      title: "Review the codebase",
    };
    expect(meta.backgroundSource).toBe("workflow");
  });
});

describe("DynamicWorkflowRunPort", () => {
  it("is implementable over JSON-able shapes alone", () => {
    // 端口只承载 JSON 形状：引擎的词汇表（RunEvent / StoredEvent / RunStatus）留在领域包里，
    // contracts 绝不 import dynamic-workflow。这个 fake 就是那条规则的可执行证明。
    const events: DynamicWorkflowRunEvent[] = [
      { sequence: 0, type: "run-started", payload: { runId: "run_1" } },
      { sequence: 1, type: "node-settled", payload: { instance: { siteId: "ask#1", ordinal: 1 } } },
    ];
    const snapshot: WorkflowTaskSnapshot = {
      runId: "run_1",
      startedAt: new Date(0),
      status: "running",
      taskId: "run_1",
    };
    let cancelled = false;

    const port: DynamicWorkflowRunPort = {
      submit: (request: DynamicWorkflowRunSubmitRequest) =>
        Promise.resolve({ ok: true, runId: `run_${request.scriptText.length}` }),
      getTask: () => Promise.resolve(snapshot),
      waitForTask: () =>
        Promise.resolve({ ...snapshot, status: "completed", output: { artifact: 1 } }),
      cancel: () => {
        cancelled = true;
        return Promise.resolve(true);
      },
      listEvents: (_runId, opts) =>
        Promise.resolve({
          events: events.filter(
            (e) => opts.afterSequence === undefined || e.sequence > opts.afterSequence,
          ),
          hasMore: false,
        }),
    };

    return Promise.all([
      port.submit({
        scriptText: "return 1;",
        cwd: "/tmp",
        parentSessionId: "sess_p",
        trace: { traceId: createTraceId() },
      }),
      port.listEvents("run_1", { afterSequence: 0, limit: 10 }),
      port.cancel("run_1"),
    ]).then(([submitted, page]) => {
      expect(submitted.ok === true && submitted.runId).toBe("run_9");
      expect(page.events.map((e) => e.sequence)).toEqual([1]);
      expect(cancelled).toBe(true);
    });
  });
});

describe("CreateWorkflowCausalityGraphSchema — withdrawn refined display names", () => {
  // docs/dynamic-workflow/presentation.md：模型精炼整条撤回，
  // `refinedLabel` / `refinedName` 从四层 schema 删除。带它们的旧持久化载荷在进入严格
  // 解析前由 tool-result-metadata 剥离；schema 本身对它们一无所知，.strict() 直接拒绝。
  const graph = {
    steps: [
      {
        id: "ask#1",
        kind: "ask" as const,
        label: "ask",
        labelPattern: { head: "研究员" },
        lane: "actor#1",
      },
    ],
    lanes: [{ id: "actor#1", name: "planner" }],
    participants: [
      { id: "unphased:actor#1", phase: "unphased", lane: "actor#1", steps: ["ask#1"] },
    ],
    handoffs: [],
  };

  it("keeps accepting plain graphs byte-for-byte", () => {
    expect(CreateWorkflowCausalityGraphSchema.parse(graph)).toEqual(graph);
  });

  it("rejects refinedLabel on steps and refinedName on lanes", () => {
    expect(
      CreateWorkflowCausalityGraphSchema.safeParse({
        ...graph,
        steps: [{ ...graph.steps[0], refinedLabel: "调研市场行情" }],
      }).success,
    ).toBe(false);
    expect(
      CreateWorkflowCausalityGraphSchema.safeParse({
        ...graph,
        lanes: [{ ...graph.lanes[0], refinedName: "规划者" }],
      }).success,
    ).toBe(false);
  });
});

describe("CreateWorkflowCausalityGraphSchema — phase vocabulary", () => {
  // docs/dynamic-workflow/presentation.md：phases / phaseEdges / exits / Step.phase 是
  // **全有或全无**的一套词汇表，全部 additive 可选——零标记脚本的载荷照常通过 .strict()。
  const unphasedGraph = {
    steps: [
      {
        id: "world-read#1",
        kind: "world-read" as const,
        label: "glob *.ts",
        lane: "workspace",
        phase: "unphased",
      },
      {
        id: "ask#1",
        kind: "ask" as const,
        label: "planner",
        lane: "actor#1",
        phase: "phase#1",
      },
    ],
    lanes: [{ id: "workspace" }, { id: "actor#1", name: "planner" }],
    // 第二层：每阶段一张参与者卡，交接边在卡之间（docs/dynamic-workflow/presentation.md）。
    participants: [
      { id: "unphased:workspace", phase: "unphased", lane: "workspace", steps: ["world-read#1"] },
      { id: "phase#1:actor#1", phase: "phase#1", lane: "actor#1", steps: ["ask#1"] },
    ],
    handoffs: [{ from: "unphased:workspace", to: "phase#1:actor#1" }],
    // `unphased` 排在最前且**无 name**（UI 本地化）；作者的阶段带 name 与首个标记的位置。
    phases: [{ id: "unphased" }, { id: "phase#1", name: "preflight", line: 3, column: 1 }],
    phaseEdges: [{ from: "unphased", to: "phase#1" }],
    // 控制流可在其后正常完成的阶段（阶段视图的「阶段 → 返回物」箭头）。
    exits: ["phase#1"],
  };

  it("round-trips the four fields together", () => {
    expect(CreateWorkflowCausalityGraphSchema.parse(unphasedGraph)).toEqual(unphasedGraph);
  });

  it("keeps accepting a payload with no phase field at all", () => {
    // 零标记脚本 = 词汇表整体缺席的载荷，逐字节通过。
    const legacy = {
      steps: [{ ...unphasedGraph.steps[1]!, phase: undefined }],
      lanes: unphasedGraph.lanes,
      // 无阶段词汇时参与者的 phase 恒为 `unphased`（此时 `phases` 缺席）。
      participants: [
        { id: "unphased:actor#1", phase: "unphased", lane: "actor#1", steps: ["ask#1"] },
      ],
      handoffs: [],
    };
    delete (legacy.steps[0] as { phase?: string }).phase;
    const parsed = CreateWorkflowCausalityGraphSchema.parse(legacy);
    expect(parsed).toEqual(legacy);
    expect("phases" in parsed).toBe(false);
    expect("phaseEdges" in parsed).toBe(false);
    expect("exits" in parsed).toBe(false);
    expect("phase" in parsed.steps[0]!).toBe(false);
  });

  it("represents an empty-but-present vocabulary", () => {
    // 有标记却零 step 的脚本会产出在场但空的三个数组。UI 的视图切换是「在场**且非空**」，
    // 所以空词汇表必须是**可表示**的——数组只有 .max() 上界，绝不能加 .min(1)，否则
    // handler 那条诚实的直通路径会在契约边界上被打回。`exits` 在组内也可以是空数组
    // （脚本没有正常完成路径，例如无条件 throw）。
    const empty = {
      steps: [],
      lanes: [],
      participants: [],
      handoffs: [],
      phases: [],
      phaseEdges: [],
      exits: [],
    };
    const parsed = CreateWorkflowCausalityGraphSchema.parse(empty);
    expect(parsed).toEqual(empty);
    expect(parsed.phases).toEqual([]);
    expect(parsed.phaseEdges).toEqual([]);
    expect(parsed.exits).toEqual([]);
  });

  it("round-trips exits and bounds them at 32 phase ids", () => {
    // exits 与阶段表同一上界：它是阶段 id 的子集，最多与阶段表一样长。
    const exits = Array.from(
      { length: CREATE_WORKFLOW_GRAPH_MAX_PHASES },
      (_, i) => `phase#${i + 1}`,
    );
    const parsed = CreateWorkflowCausalityGraphSchema.parse({ ...unphasedGraph, exits });
    expect(parsed.exits).toEqual(exits);
    expect(
      CreateWorkflowCausalityGraphSchema.safeParse({
        ...unphasedGraph,
        exits: [...exits, "phase#33"],
      }).success,
    ).toBe(false);
    // 元素走同一组 id 上界。
    for (const bad of [[""], ["p".repeat(65)], [42]]) {
      expect(
        CreateWorkflowCausalityGraphSchema.safeParse({ ...unphasedGraph, exits: bad }).success,
      ).toBe(false);
    }
  });

  it("rejects the withdrawn refinedName on phases", () => {
    expect(
      CreateWorkflowCausalityGraphSchema.safeParse({
        ...unphasedGraph,
        phases: [
          unphasedGraph.phases[0]!,
          { ...unphasedGraph.phases[1]!, refinedName: "起飞前检查" },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects every field of the pre-single-arrow shape", () => {
    // docs/dynamic-workflow/presentation.md「The display contract」：硬断，不留可选过渡。
    // 分析器的边种类 / certainty / exact 见证位、step 的 region / certainty、车道的 families
    // 与顶层 regions 表都不再是载荷的一部分——.strict() 把每一个都挡回去，防止生产侧悄悄
    // 加回来（旧载荷在 UI 侧走 safeParse 失败的既有兜底：整个 display 视为不在场）。
    // docs/dynamic-workflow/presentation.md 再砍一刀：step 级 `edges` 与 `Lane.nesting`
    // 没有读者了，同样硬断。
    const [step0, step1] = unphasedGraph.steps;
    const [lane0, lane1] = unphasedGraph.lanes;
    const edge = { from: "world-read#1", to: "ask#1" };
    const handoff = unphasedGraph.handoffs[0]!;
    const phaseEdge = { from: "unphased", to: "phase#1" };
    const rejected: unknown[] = [
      // step 级边整个字段都不在了——空数组也是多出来的键。
      { ...unphasedGraph, edges: [] },
      { ...unphasedGraph, edges: [edge] },
      { ...unphasedGraph, edges: [{ ...edge, kind: "data" }] },
      // 交接边上的旧字段。
      { ...unphasedGraph, handoffs: [{ ...handoff, kind: "data" }] },
      { ...unphasedGraph, handoffs: [{ ...handoff, kind: "carry" }] },
      { ...unphasedGraph, handoffs: [{ ...handoff, certainty: "always" }] },
      { ...unphasedGraph, handoffs: [{ ...handoff, exact: true }] },
      { ...unphasedGraph, handoffs: [{ ...handoff, count: 2 }] },
      // 阶段边上的旧字段。
      { ...unphasedGraph, phaseEdges: [{ ...phaseEdge, kind: "seq" }] },
      { ...unphasedGraph, phaseEdges: [{ ...phaseEdge, certainty: "maybe" }] },
      { ...unphasedGraph, phaseEdges: [{ ...phaseEdge, exact: true }] },
      // step 上的旧字段。
      { ...unphasedGraph, steps: [{ ...step0, region: "seq#1" }, step1] },
      { ...unphasedGraph, steps: [{ ...step0, certainty: "always" }, step1] },
      // 车道上的旧字段：families（单一箭头之前）与 nesting（交接栈之前）。
      { ...unphasedGraph, lanes: [lane0, { ...lane1, families: ["loop#1"] }] },
      { ...unphasedGraph, lanes: [lane0, { ...lane1, nesting: 1 }] },
      { ...unphasedGraph, lanes: [lane0, { ...lane1, nesting: 0 }] },
      // 顶层 regions 表——空表也一样是多出来的键。
      { ...unphasedGraph, regions: [] },
      { ...unphasedGraph, regions: [{ id: "seq#1", kind: "seq" }] },
    ];
    for (const graph of rejected) {
      expect(CreateWorkflowCausalityGraphSchema.safeParse(graph).success).toBe(false);
    }
  });

  it("accepts only the literal true for `back` on either edge layer", () => {
    // `back` 是回边标记，不是布尔状态：false / "yes" 都不是「没标回边」的另一种拼法。
    // 缺席就是前向边；两层边同一形状，所以两层都要钉。
    const edge = { from: "phase#1:actor#1", to: "unphased:workspace" };
    const phaseEdge = { from: "phase#1", to: "unphased" };
    expect(
      CreateWorkflowCausalityGraphSchema.parse({
        ...unphasedGraph,
        handoffs: [{ ...edge, back: true }],
      }).handoffs,
    ).toEqual([{ ...edge, back: true }]);
    expect(
      CreateWorkflowCausalityGraphSchema.parse({
        ...unphasedGraph,
        phaseEdges: [{ ...phaseEdge, back: true }],
      }).phaseEdges,
    ).toEqual([{ ...phaseEdge, back: true }]);
    for (const back of [false, "yes", 1, null]) {
      expect(
        CreateWorkflowCausalityGraphSchema.safeParse({
          ...unphasedGraph,
          handoffs: [{ ...edge, back }],
        }).success,
      ).toBe(false);
      expect(
        CreateWorkflowCausalityGraphSchema.safeParse({
          ...unphasedGraph,
          phaseEdges: [{ ...phaseEdge, back }],
        }).success,
      ).toBe(false);
    }
  });

  it("bounds the vocabulary at 32 phases and 128 phase edges", () => {
    const phase = { id: "phase#1", name: "p" };
    const edge = { from: "phase#1", to: "phase#2", back: true as const };
    expect(
      CreateWorkflowCausalityGraphSchema.safeParse({
        ...unphasedGraph,
        phases: Array.from({ length: CREATE_WORKFLOW_GRAPH_MAX_PHASES }, (_, i) => ({
          ...phase,
          id: `phase#${i + 1}`,
        })),
      }).success,
    ).toBe(true);
    expect(
      CreateWorkflowCausalityGraphSchema.safeParse({
        ...unphasedGraph,
        phases: Array.from({ length: CREATE_WORKFLOW_GRAPH_MAX_PHASES + 1 }, (_, i) => ({
          ...phase,
          id: `phase#${i + 1}`,
        })),
      }).success,
    ).toBe(false);
    expect(
      CreateWorkflowCausalityGraphSchema.safeParse({
        ...unphasedGraph,
        phaseEdges: Array.from({ length: CREATE_WORKFLOW_GRAPH_MAX_PHASE_EDGES + 1 }, () => edge),
      }).success,
    ).toBe(false);
  });

  it("round-trips phase streams and keeps them to {from, to}, at most 128", () => {
    // docs/dynamic-workflow/presentation.md「Streams」：channel 串起来的两个 future 阶段是一条
    // 阶段流——不是 runs after，所以没有 `back`，也不带分析器的边种类。
    const streams = [
      { from: "phase#1", to: "phase#2" },
      { from: "phase#2", to: "phase#3" },
    ];
    const parsed = CreateWorkflowCausalityGraphSchema.parse({
      ...unphasedGraph,
      phaseStreams: streams,
    });
    expect(parsed.phaseStreams).toEqual(streams);
    for (const phaseStreams of [
      [{ from: "phase#1", to: "phase#2", back: true }],
      [{ from: "phase#1", to: "phase#2", kind: "data" }],
      [{ from: "", to: "phase#2" }],
      [{ from: "phase#1", to: "p".repeat(65) }],
      Array.from({ length: CREATE_WORKFLOW_GRAPH_MAX_PHASE_EDGES + 1 }, () => streams[0]),
    ]) {
      expect(
        CreateWorkflowCausalityGraphSchema.safeParse({ ...unphasedGraph, phaseStreams }).success,
      ).toBe(false);
    }
  });

  it("bounds phase ids and names like every other graph string", () => {
    for (const phases of [
      [{ id: "" }],
      [{ id: "p".repeat(65) }],
      [{ id: "phase#1", name: "" }],
      [{ id: "phase#1", name: "长".repeat(129) }],
      [{ id: "phase#1", line: 0 }],
      [{ id: "phase#1", label: "smuggled" }],
    ]) {
      expect(
        CreateWorkflowCausalityGraphSchema.safeParse({ ...unphasedGraph, phases }).success,
      ).toBe(false);
    }
    expect(
      CreateWorkflowCausalityGraphSchema.safeParse({
        ...unphasedGraph,
        steps: [{ ...unphasedGraph.steps[0]!, phase: "p".repeat(65) }],
      }).success,
    ).toBe(false);
  });
});

describe("CreateWorkflowCausalityGraphSchema — participants and handoffs", () => {
  // docs/dynamic-workflow/presentation.md「The display contract」：第二层是子代理导向——每阶段一张参与者
  // 卡（`${phase}:${lane}`，家族成员再带 `[index]`）+ 卡之间的交接边。两个字段**必填**：
  // 零参与者的图是空数组，不是缺席——step 级 `edges` 就是这样悄悄退出的，新字段不给缺席
  // 一条可通过的路。
  const step = (id: string, lane: string, phase: string) => ({
    id,
    kind: "ask" as const,
    label: lane,
    lane,
    phase,
  });
  const graph = {
    steps: [step("ask#1", "actor#1", "phase#1"), step("ask#2", "actor#2", "phase#1")],
    lanes: [
      { id: "actor#1", name: "planner" },
      { id: "actor#2", name: "worker" },
    ],
    participants: [
      { id: "phase#1:actor#1", phase: "phase#1", lane: "actor#1", steps: ["ask#1"] },
      { id: "phase#1:actor#2", phase: "phase#1", lane: "actor#2", steps: ["ask#2"] },
    ],
    handoffs: [{ from: "phase#1:actor#1", to: "phase#1:actor#2" }],
    phases: [{ id: "phase#1", name: "plan" }],
    phaseEdges: [],
    exits: ["phase#1"],
  };
  const [p0, p1] = graph.participants;
  const [h0] = graph.handoffs;

  it("exposes the bounds as constants the handler truncates against", () => {
    expect(CREATE_WORKFLOW_GRAPH_MAX_PARTICIPANTS).toBe(64);
    expect(CREATE_WORKFLOW_GRAPH_MAX_HANDOFFS).toBe(256);
    expect(CREATE_WORKFLOW_GRAPH_MAX_HANDOFF_TYPES).toBe(8);
  });

  it("round-trips participants and handoffs and requires both fields", () => {
    expect(CreateWorkflowCausalityGraphSchema.parse(graph)).toEqual(graph);
    const noParticipants: Record<string, unknown> = { ...graph };
    delete noParticipants.participants;
    const noHandoffs: Record<string, unknown> = { ...graph };
    delete noHandoffs.handoffs;
    expect(CreateWorkflowCausalityGraphSchema.safeParse(noParticipants).success).toBe(false);
    expect(CreateWorkflowCausalityGraphSchema.safeParse(noHandoffs).success).toBe(false);
    // 空图：两个数组在场且为空。
    expect(
      CreateWorkflowCausalityGraphSchema.parse({
        steps: [],
        lanes: [],
        participants: [],
        handoffs: [],
      }),
    ).toEqual({ steps: [], lanes: [], participants: [], handoffs: [] });
  });

  it("requires at least one step per participant and bounds the list at 64", () => {
    // 一张没有 step 的卡不代表任何子代理——运行状态无从聚合，检视器无 ask 可列。
    expect(CreateWorkflowParticipantSchema.safeParse({ ...p0, steps: [] }).success).toBe(false);
    expect(
      CreateWorkflowCausalityGraphSchema.safeParse({
        ...graph,
        participants: [{ ...p0, steps: [] }, p1],
      }).success,
    ).toBe(false);
    const manySteps = Array.from({ length: CREATE_WORKFLOW_GRAPH_MAX_STEPS }, (_, i) => `ask#${i}`);
    expect(CreateWorkflowParticipantSchema.safeParse({ ...p0, steps: manySteps }).success).toBe(
      true,
    );
    expect(
      CreateWorkflowParticipantSchema.safeParse({ ...p0, steps: [...manySteps, "ask#64"] }).success,
    ).toBe(false);
    // step id 走同一组 id 上界。
    for (const bad of [[""], ["s".repeat(65)], [42]]) {
      expect(CreateWorkflowParticipantSchema.safeParse({ ...p0, steps: bad }).success).toBe(false);
    }
  });

  it("requires id, phase and lane on every participant and rejects extra keys", () => {
    for (const key of ["id", "phase", "lane", "steps"]) {
      const partial: Record<string, unknown> = { ...p0 };
      delete partial[key];
      expect(CreateWorkflowParticipantSchema.safeParse(partial).success).toBe(false);
    }
    // 卡的展示名从车道表查，不进参与者；step 级 edges 的残留键也一样。
    for (const extra of [{ name: "planner" }, { edges: [] }, { nesting: 1 }, { region: "seq#1" }]) {
      expect(CreateWorkflowParticipantSchema.safeParse({ ...p0, ...extra }).success).toBe(false);
    }
    // 无阶段词汇的脚本：phase 恒为 `unphased`，与 `phases` 缺席同时成立。
    expect(
      CreateWorkflowCausalityGraphSchema.safeParse({
        steps: [step("ask#1", "actor#1", "unphased")],
        lanes: [graph.lanes[0]],
        participants: [
          { id: "unphased:actor#1", phase: "unphased", lane: "actor#1", steps: ["ask#1"] },
        ],
        handoffs: [],
      }).success,
    ).toBe(true);
  });

  it("shapes fan-out members as `member: {index ≥ 0, of ≥ 1}` and `many: true`", () => {
    // 字面量基数的家族每成员一张卡（id 带 `[index]`）；基数未知时一张 `many` 卡代表全部。
    const member = { ...p1, id: "phase#1:actor#2[0]", member: { index: 0, of: 3 } };
    expect(CreateWorkflowParticipantSchema.parse(member)).toEqual(member);
    const many = { ...p1, many: true as const };
    expect(CreateWorkflowParticipantSchema.parse(many)).toEqual(many);
    for (const bad of [
      { index: -1, of: 3 },
      { index: 0.5, of: 3 },
      { index: 0, of: 0 },
      { index: 0, of: -1 },
      { index: 0 },
      { of: 3 },
      { index: "0", of: 3 },
      { index: 0, of: 3, label: "smuggled" },
    ]) {
      expect(CreateWorkflowParticipantSchema.safeParse({ ...p1, member: bad }).success).toBe(false);
    }
    // `many` 是标记，不是布尔状态：false 不是「不是 many」的另一种拼法。
    for (const many of [false, "yes", 1, null]) {
      expect(CreateWorkflowParticipantSchema.safeParse({ ...p1, many }).success).toBe(false);
    }
  });

  it("bounds the participant list at 64 and the handoff list at 256", () => {
    const participants = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        ...p0,
        id: `phase#1:actor#1[${i}]`,
        member: { index: i, of: n },
      }));
    expect(
      CreateWorkflowCausalityGraphSchema.safeParse({
        ...graph,
        participants: participants(CREATE_WORKFLOW_GRAPH_MAX_PARTICIPANTS),
      }).success,
    ).toBe(true);
    expect(
      CreateWorkflowCausalityGraphSchema.safeParse({
        ...graph,
        participants: participants(CREATE_WORKFLOW_GRAPH_MAX_PARTICIPANTS + 1),
      }).success,
    ).toBe(false);
    const handoffs = (n: number) => Array.from({ length: n }, () => h0);
    expect(
      CreateWorkflowCausalityGraphSchema.safeParse({
        ...graph,
        handoffs: handoffs(CREATE_WORKFLOW_GRAPH_MAX_HANDOFFS),
      }).success,
    ).toBe(true);
    expect(
      CreateWorkflowCausalityGraphSchema.safeParse({
        ...graph,
        handoffs: handoffs(CREATE_WORKFLOW_GRAPH_MAX_HANDOFFS + 1),
      }).success,
    ).toBe(false);
  });

  it("carries 1..8 artifact type names on a handoff, each within the name bound", () => {
    // `types` 只进检视器，不上箭头；在场就至少一个，最多 8 个，每个走名字上界。
    const withTypes = { ...h0, types: ["Plan", "Report"] };
    expect(CreateWorkflowHandoffSchema.parse(withTypes)).toEqual(withTypes);
    expect(CreateWorkflowHandoffSchema.parse({ ...h0, back: true })).toEqual({ ...h0, back: true });
    const max = Array.from({ length: CREATE_WORKFLOW_GRAPH_MAX_HANDOFF_TYPES }, (_, i) => `T${i}`);
    expect(CreateWorkflowHandoffSchema.safeParse({ ...h0, types: max }).success).toBe(true);
    for (const bad of [[], [...max, "T8"], [""], ["长".repeat(129)], [42], "Plan"]) {
      expect(CreateWorkflowHandoffSchema.safeParse({ ...h0, types: bad }).success).toBe(false);
      expect(
        CreateWorkflowCausalityGraphSchema.safeParse({
          ...graph,
          handoffs: [{ ...h0, types: bad }],
        }).success,
      ).toBe(false);
    }
    // 阶段边没有 types——它是控制流商，不携带产物。
    expect(
      CreateWorkflowCausalityGraphSchema.safeParse({
        ...graph,
        phaseEdges: [{ from: "phase#1", to: "phase#1", types: ["Plan"] }],
      }).success,
    ).toBe(false);
  });
});

describe("createWorkflowPhaseNames — the declared phase table for run-launched", () => {
  it("returns the named phases in declared order and skips the synthetic unnamed one", () => {
    expect(
      createWorkflowPhaseNames({
        steps: [],
        lanes: [],
        participants: [],
        handoffs: [],
        phases: [
          { id: "p1", name: "Research" },
          { id: "unphased" },
          { id: "p2", name: "Write" },
        ],
      }),
    ).toEqual(["Research", "Write"]);
  });

  it("returns undefined when the graph is absent or declares no phase vocabulary", () => {
    expect(createWorkflowPhaseNames(undefined)).toBeUndefined();
    expect(
      createWorkflowPhaseNames({ steps: [], lanes: [], participants: [], handoffs: [] }),
    ).toBeUndefined();
    expect(
      createWorkflowPhaseNames({
        steps: [],
        lanes: [],
        participants: [],
        handoffs: [],
        phases: [{ id: "unphased" }],
      }),
    ).toBeUndefined();
  });

  it("keeps at most CREATE_WORKFLOW_GRAPH_MAX_PHASES names", () => {
    const phases = Array.from({ length: CREATE_WORKFLOW_GRAPH_MAX_PHASES + 3 }, (_, index) => ({
      id: `p${index}`,
      name: `Phase ${index}`,
    }));
    expect(
      createWorkflowPhaseNames({ steps: [], lanes: [], participants: [], handoffs: [], phases }),
    ).toHaveLength(CREATE_WORKFLOW_GRAPH_MAX_PHASES);
  });
});

describe("createWorkflowPhaseAlongside — the phases a phase was entered beside", () => {
  const empty = { steps: [], lanes: [], participants: [], handoffs: [] };

  it("indexes into the named-phase table, dropping references to unnamed phases", () => {
    // 下标空间是**有名阶段**的：合成的 `unphased` 排在表首却不占位，所以 Research 是 0、
    // Write 是 1，而指向 `unphased` 的引用无处可落，只能丢掉。
    const graph = {
      ...empty,
      phases: [
        { id: "unphased", alongside: ["p1"] },
        { id: "p1", name: "Research", alongside: ["unphased", "p2"] },
        { id: "p2", name: "Write", alongside: ["p1"] },
      ],
    };
    expect(createWorkflowPhaseNames(graph)).toEqual(["Research", "Write"]);
    expect(createWorkflowPhaseAlongside(graph)).toEqual([[1], [0]]);
  });

  it("drops references to unlisted phases and to itself, and dedupes", () => {
    expect(
      createWorkflowPhaseAlongside({
        ...empty,
        phases: [
          { id: "p1", name: "Research", alongside: ["p1", "p9", "p2", "p2"] },
          { id: "p2", name: "Write" },
        ],
      }),
    ).toEqual([[1], []]);
  });

  it("returns undefined when no phase was entered beside another", () => {
    // 缺席就是「这条轨道是一条直线」，所以一串空数组也要塌成 undefined——包括每个引用都被
    // 丢光的情形。
    expect(createWorkflowPhaseAlongside(undefined)).toBeUndefined();
    expect(createWorkflowPhaseAlongside(empty)).toBeUndefined();
    expect(
      createWorkflowPhaseAlongside({ ...empty, phases: [{ id: "unphased", alongside: ["p1"] }] }),
    ).toBeUndefined();
    expect(
      createWorkflowPhaseAlongside({
        ...empty,
        phases: [
          { id: "p1", name: "Research" },
          { id: "p2", name: "Write" },
        ],
      }),
    ).toBeUndefined();
    expect(
      createWorkflowPhaseAlongside({
        ...empty,
        phases: [{ id: "p1", name: "Research", alongside: ["unphased"] }, { id: "unphased" }],
      }),
    ).toBeUndefined();
  });

  it("stops at CREATE_WORKFLOW_GRAPH_MAX_PHASES, with it the references past the cut", () => {
    const phases = Array.from({ length: CREATE_WORKFLOW_GRAPH_MAX_PHASES + 3 }, (_, index) => ({
      id: `p${index}`,
      name: `Phase ${index}`,
      alongside: [`p${index + 1}`],
    }));
    const alongside = createWorkflowPhaseAlongside({ ...empty, phases });
    expect(alongside).toHaveLength(CREATE_WORKFLOW_GRAPH_MAX_PHASES);
    expect(createWorkflowPhaseNames({ ...empty, phases })).toHaveLength(alongside!.length);
    expect(alongside![0]).toEqual([1]);
    // 最后一站指向的是被截掉的那个阶段：越界下标会把侧栏连到不存在的站上，所以它一起走。
    expect(alongside![CREATE_WORKFLOW_GRAPH_MAX_PHASES - 1]).toEqual([]);
  });
});
