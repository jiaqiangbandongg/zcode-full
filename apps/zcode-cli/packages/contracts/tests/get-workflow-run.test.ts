import { describe, expect, it } from "vitest";
import {
  GET_WORKFLOW_RUN_TOOL_NAME,
  GetWorkflowRunInputJsonSchema,
  GetWorkflowRunInputSchema,
  GetWorkflowRunOutputJsonSchema,
  GetWorkflowRunOutputSchema,
} from "../src/tools/get-workflow-run.js";

const RUNNING = {
  runId: "dwfrun-1",
  label: "// triage the failing tests",
  labelSource: "script" as const,
  status: "running" as const,
  ownedByThisSession: true,
  createdAt: 1_755_000_000_000,
  updatedAt: 1_755_000_001_000,
  summary: "Running for 1m 00s. 2 of 3 dispatched steps settled, 1 running (1 executing).",
  generatedAt: 1_755_000_001_500,
  usage: {
    spentTokens: 1_204,
    nodesObserved: 3,
    nodesRunning: 1,
    nodesCompleted: 2,
    nodesFailed: 0,
  },
  actors: [{ siteId: "agent#1", ordinal: 1, name: "judge" }],
  logTail: [{ sequence: 12, message: "collected the failing specs" }],
  subagents: [
    {
      siteId: "agent#1",
      ordinal: 1,
      name: "judge",
      state: "executing" as const,
      stepsSettled: 2,
      stepsFailed: 0,
      tokens: 1_204,
    },
  ],
  health: { consecutiveFailures: 0, cachedSteps: 0, pendingQuestionsKnown: true },
};

describe("GetWorkflowRun input schema", () => {
  it("names the tool exactly as it registers", () => {
    expect(GET_WORKFLOW_RUN_TOOL_NAME).toBe("GetWorkflowRun");
  });

  // snake_case 随 TaskOutput 的 task_id：两个工具在模型眼里是同一族的 run/task 键。
  it("requires a non-empty snake_case run_id", () => {
    expect(GetWorkflowRunInputSchema.parse({ run_id: "dwfrun-1" })).toEqual({
      run_id: "dwfrun-1",
    });
    expect(GetWorkflowRunInputSchema.safeParse({ run_id: "" }).success).toBe(false);
    expect(GetWorkflowRunInputSchema.safeParse({}).success).toBe(false);
    expect(GetWorkflowRunInputSchema.safeParse({ runId: "dwfrun-1" }).success).toBe(false);
  });

  it("stays strict about unknown keys", () => {
    expect(
      GetWorkflowRunInputSchema.safeParse({ run_id: "dwfrun-1", logTailLimit: 100 }).success,
    ).toBe(false);
  });

  it("requires run_id in the model-facing JSON schema", () => {
    const schema = GetWorkflowRunInputJsonSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(schema.properties ?? {})).toEqual(["run_id"]);
    expect(schema.required).toEqual(["run_id"]);
  });
});

describe("GetWorkflowRun output schema", () => {
  it("roundtrips a running run with neither result nor error", () => {
    const parsed = GetWorkflowRunOutputSchema.parse(RUNNING);
    expect(parsed).toEqual(RUNNING);
    expect("result" in parsed).toBe(false);
    expect("error" in parsed).toBe(false);
  });

  // 子代理模型（docs/dynamic-workflow/launch.md）：设过才在场，继承会话模型的 run 整字段缺席——
  // AmendWorkflow 省略 `subagent_model` 时沿用的就是这个值，所以「缺席」必须与「空串」可分辨。
  it("round-trips a subagent model and keeps it absent when the run inherits the session model", () => {
    const withModel = GetWorkflowRunOutputSchema.parse({
      ...RUNNING,
      subagentModel: "zhipu/glm-5.3$high",
    });
    expect(withModel.subagentModel).toBe("zhipu/glm-5.3$high");
    expect("subagentModel" in GetWorkflowRunOutputSchema.parse(RUNNING)).toBe(false);
  });

  // 脚本文件（docs/dynamic-workflow/launch.md「Script files」）：记过才在场。在场时它就是下一次
  // AmendWorkflow 该传的 `path`，所以「缺席」必须与「空串」一样可分辨。
  it("round-trips the run's script file and keeps it absent when the run recorded none", () => {
    const withPath = GetWorkflowRunOutputSchema.parse({
      ...RUNNING,
      scriptPath: ".zcode/workflow-drafts/audit.dwf.ts",
    });
    expect(withPath.scriptPath).toBe(".zcode/workflow-drafts/audit.dwf.ts");
    expect("scriptPath" in GetWorkflowRunOutputSchema.parse(RUNNING)).toBe(false);
  });

  it("accepts a completed run whose result is the serialized artifact", () => {
    const output = {
      ...RUNNING,
      status: "completed" as const,
      result: '{\n  "verdict": "ship"\n}',
    };
    expect(GetWorkflowRunOutputSchema.parse(output)).toEqual(output);
  });

  it("accepts an errored run and keeps the failure code verbatim", () => {
    // DriverError（脚本真失败）与 ReportCapExceeded 等契约码必须能被模型分辨，所以 code 是
    // 自由字符串而不是一个我们自己收窄的枚举。
    for (const code of ["DriverError", "ReportCapExceeded"]) {
      const output = {
        ...RUNNING,
        status: "errored" as const,
        error: { code, message: `run ended: ${code}` },
      };
      expect(GetWorkflowRunOutputSchema.parse(output).error).toEqual({
        code,
        message: `run ended: ${code}`,
      });
    }
  });

  // stopped（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md）：reason 四值；provider 停下带结构化明细。
  it("accepts a stopped run with its reason and a provider stop's details", () => {
    const interrupted = {
      ...RUNNING,
      status: "stopped" as const,
      stopReason: "interrupted" as const,
      error: { code: "Interrupted", message: "the owning process exited" },
    };
    expect(GetWorkflowRunOutputSchema.parse(interrupted)).toEqual(interrupted);

    const providerStop = {
      ...RUNNING,
      status: "stopped" as const,
      stopReason: "provider" as const,
      error: {
        code: "ProviderStop",
        message: "Subagent turn failed: [1006] token expired",
        providerStop: {
          kind: "auth" as const,
          reason: "auth_failed",
          providerId: "account:bigmodel-coding-plan",
          modelId: "GLM-5.3",
          providerCode: "1006",
          subagent: "verify@2",
          rawMessage: "[1006] token expired",
        },
      },
    };
    expect(GetWorkflowRunOutputSchema.parse(providerStop)).toEqual(providerStop);
    expect(
      GetWorkflowRunOutputSchema.safeParse({ ...RUNNING, status: "stopped", stopReason: "crash" })
        .success,
    ).toBe(false);
    expect(
      GetWorkflowRunOutputSchema.safeParse({
        ...providerStop,
        error: {
          ...providerStop.error,
          providerStop: { ...providerStop.error.providerStop, kind: "bogus" },
        },
      }).success,
    ).toBe(false);
  });

  it("carries the actor name only when present", () => {
    const parsed = GetWorkflowRunOutputSchema.parse({
      ...RUNNING,
      actors: [{ siteId: "agent#1", ordinal: 1 }],
    });
    expect("name" in parsed.actors[0]!).toBe(false);
  });

  // docs/dynamic-workflow/authoring.md：用量是观察面，没有任何上限字段。
  it("has no cap fields on usage: budgetTotal / maxNodes are unknown keys", () => {
    for (const extra of [{ budgetTotal: 200_000 }, { maxNodes: 100 }]) {
      expect(
        GetWorkflowRunOutputSchema.safeParse({ ...RUNNING, usage: { ...RUNNING.usage, ...extra } })
          .success,
      ).toBe(false);
    }
  });

  it("accepts empty actor and log collections", () => {
    const parsed = GetWorkflowRunOutputSchema.parse({ ...RUNNING, actors: [], logTail: [] });
    expect(parsed.actors).toEqual([]);
    expect(parsed.logTail).toEqual([]);
  });

  it("requires the whole node-count block: a partial usage is a shape error", () => {
    expect(
      GetWorkflowRunOutputSchema.safeParse({
        ...RUNNING,
        usage: { spentTokens: 1, nodesObserved: 3 },
      }).success,
    ).toBe(false);
  });

  it("stays strict about unknown keys at every level", () => {
    expect(GetWorkflowRunOutputSchema.safeParse({ ...RUNNING, elapsedMs: 12 }).success).toBe(false);
    expect(
      GetWorkflowRunOutputSchema.safeParse({
        ...RUNNING,
        usage: { ...RUNNING.usage, budgetRemaining: 1 },
      }).success,
    ).toBe(false);
    expect(
      GetWorkflowRunOutputSchema.safeParse({
        ...RUNNING,
        actors: [{ siteId: "agent#1", ordinal: 1, persona: "you are…" }],
      }).success,
    ).toBe(false);
    expect(
      GetWorkflowRunOutputSchema.safeParse({
        ...RUNNING,
        logTail: [{ sequence: 1, message: "hi", timestamp: 0 }],
      }).success,
    ).toBe(false);
  });

  // ————————————————————————————————————————————————
  // 情势截面（阶段 / 花名册 / 健康）。docs/dynamic-workflow/launch.md「`GetWorkflowRun`」。
  // ————————————————————————————————————————————————

  // `at` 是事件的落库时刻；老 journal 上缺席，那样的行读不出年龄——两者必须可分辨。
  it("takes an optional journal time on a log entry and keeps it absent otherwise", () => {
    const timed = GetWorkflowRunOutputSchema.parse({
      ...RUNNING,
      logTail: [{ sequence: 12, message: "collected the failing specs", at: 1_755_000_000_500 }],
    });
    expect(timed.logTail[0]?.at).toBe(1_755_000_000_500);
    expect("at" in GetWorkflowRunOutputSchema.parse(RUNNING).logTail[0]!).toBe(false);
  });

  it("round-trips a phase table and rejects a state outside the closed set", () => {
    const withPhases = {
      ...RUNNING,
      phases: [
        { name: "collect", state: "done" as const, rounds: 1, nodesSettled: 2, nodesRunning: 0, enteredAt: 1, exitedAt: 2 },
        { name: "judge", state: "current" as const, rounds: 1, nodesSettled: 3, nodesRunning: 2, enteredAt: 2 },
        { name: "verify", state: "ahead" as const, rounds: 0, nodesSettled: 0, nodesRunning: 0 },
      ],
    };
    expect(GetWorkflowRunOutputSchema.parse(withPhases)).toEqual(withPhases);
    // 声明了阶段但一个都没进过的 run 整字段缺席，而不是空数组。
    expect("phases" in GetWorkflowRunOutputSchema.parse(RUNNING)).toBe(false);
    expect(
      GetWorkflowRunOutputSchema.safeParse({
        ...RUNNING,
        phases: [{ name: "judge", state: "skipped", rounds: 1, nodesSettled: 0, nodesRunning: 0 }],
      }).success,
    ).toBe(false);
  });

  // turn / toolCalls 缺席读作「不知道」，`0` 读作「一个工具都没调过」：老 journal 没有
  // node-progress，两者必须能在同一个 schema 下分别表达。
  it("round-trips a full subagent row and keeps every progress reading optional", () => {
    const full = {
      ...RUNNING,
      subagents: [
        {
          siteId: "agent#2",
          ordinal: 1,
          name: "judge",
          state: "executing" as const,
          phaseName: "judge",
          currentAsk: {
            siteId: "ask#4",
            ordinal: 1,
            actorSeq: 2,
            instructionsHead: "Judge specs 1-7 for flakiness",
            startedAt: 1_755_000_000_100,
            turn: 4,
            toolCalls: 7,
            lastTool: { name: "Read", target: "packages/net/retry.spec.ts", at: 1_755_000_001_000 },
          },
          wait: { cause: "backoff" as const, reason: "429", retryAfterMs: 20_000, since: 1_755_000_000_900 },
          parkedOn: "dwfq-1",
          stepsSettled: 2,
          stepsFailed: 1,
          tokens: 5_100,
          lastProgressAt: 1_755_000_001_000,
        },
      ],
    };
    expect(GetWorkflowRunOutputSchema.parse(full)).toEqual(full);

    const bare = GetWorkflowRunOutputSchema.parse(RUNNING).subagents[0]!;
    for (const key of ["currentAsk", "wait", "parkedOn", "phaseName", "lastProgressAt"]) {
      expect(key in bare).toBe(false);
    }
    // 花名册恒在场，一个 actor 都没有的 run 是空数组（与 phases 的「无则缺席」刻意不同）。
    expect(GetWorkflowRunOutputSchema.parse({ ...RUNNING, subagents: [] }).subagents).toEqual([]);
    expect(GetWorkflowRunOutputSchema.safeParse({ ...RUNNING, subagents: undefined }).success).toBe(false);
  });

  it("closes the subagent state and wait-cause enums", () => {
    for (const patch of [{ state: "thinking" }, { wait: { cause: "quota" } }]) {
      expect(
        GetWorkflowRunOutputSchema.safeParse({
          ...RUNNING,
          subagents: [{ ...RUNNING.subagents[0]!, ...patch }],
        }).success,
      ).toBe(false);
    }
  });

  it("bounds the roster at 64 rows and the phase table at 32", () => {
    const subagent = RUNNING.subagents[0]!;
    expect(
      GetWorkflowRunOutputSchema.safeParse({
        ...RUNNING,
        subagents: Array.from({ length: 65 }, () => subagent),
      }).success,
    ).toBe(false);
    const phase = { name: "p", state: "done" as const, rounds: 1, nodesSettled: 0, nodesRunning: 0 };
    expect(
      GetWorkflowRunOutputSchema.safeParse({ ...RUNNING, phases: Array.from({ length: 33 }, () => phase) }).success,
    ).toBe(false);
  });

  // leftoverRunning 为 0 时缺席（终态 run 没有残留是常态）；pendingQuestionsKnown 必填——
  // 「没有人在等」与「查不到」是两个不同的事实，缺省会把后者读成前者。
  it("round-trips health, requires pendingQuestionsKnown and keeps concurrency optional", () => {
    const health = {
      lastProgressAt: 1_755_000_001_000,
      stalledSince: 1_755_000_000_800,
      concurrency: { effective: 2, cap: 3, reason: "rate_limited", since: 1_755_000_000_700 },
      consecutiveFailures: 1,
      cachedSteps: 4,
      leftoverRunning: 2,
      pendingQuestionsKnown: false,
    };
    expect(GetWorkflowRunOutputSchema.parse({ ...RUNNING, health }).health).toEqual(health);
    expect(
      GetWorkflowRunOutputSchema.safeParse({
        ...RUNNING,
        health: { consecutiveFailures: 0, cachedSteps: 0 },
      }).success,
    ).toBe(false);
    expect(
      GetWorkflowRunOutputSchema.safeParse({
        ...RUNNING,
        health: { ...RUNNING.health, leftoverRunning: 0 },
      }).success,
    ).toBe(false);
  });

  it("marks a clamped roster with a literal-true flag only", () => {
    expect(GetWorkflowRunOutputSchema.parse({ ...RUNNING, subagentsTruncated: true }).subagentsTruncated).toBe(true);
    expect(
      GetWorkflowRunOutputSchema.safeParse({ ...RUNNING, subagentsTruncated: false }).success,
    ).toBe(false);
  });

  // 摘要是 handler 拼出来的一句话，不是模型写的散文：上界拦住「又一份报告」。
  it("bounds the summary at 400 characters", () => {
    expect(GetWorkflowRunOutputSchema.safeParse({ ...RUNNING, summary: "x".repeat(400) }).success).toBe(true);
    expect(GetWorkflowRunOutputSchema.safeParse({ ...RUNNING, summary: "x".repeat(401) }).success).toBe(false);
  });

  it("carries the primary flag on a published artifact as a literal true only", () => {
    const artifact = { id: "report", kind: "markdown" as const, version: 1, itemCount: 0 };
    const withPrimary = { ...RUNNING, artifacts: [{ ...artifact, primary: true as const }] };
    expect(GetWorkflowRunOutputSchema.parse(withPrimary)).toEqual(withPrimary);
    expect(GetWorkflowRunOutputSchema.parse({ ...RUNNING, artifacts: [artifact] })).toEqual({
      ...RUNNING,
      artifacts: [artifact],
    });
    // strict + literal: a non-deliverable is the absence of the key, never `false`.
    expect(
      GetWorkflowRunOutputSchema.safeParse({ ...RUNNING, artifacts: [{ ...artifact, primary: false }] })
        .success,
    ).toBe(false);
  });

  // result 是**已序列化的文本**：序列化在 core 只有一处实现（serializeWorkflowArtifact），
  // 通知与本工具共用它。放行原值等于允许「同一个产物在两处长得不一样」。
  it("takes result as text only, never as a raw structure", () => {
    expect(
      GetWorkflowRunOutputSchema.safeParse({
        ...RUNNING,
        status: "completed",
        result: { verdict: "ship" },
      }).success,
    ).toBe(false);
  });

  it("projects the common cross-section into the model-facing JSON schema", () => {
    const schema = GetWorkflowRunOutputJsonSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(schema.properties ?? {})).toEqual([
      "runId",
      "label",
      "labelSource",
      "status",
      "stopReason",
      "resumedFrom",
      "supersededBy",
      "ownedByThisSession",
      "possiblyInterrupted",
      "createdAt",
      "updatedAt",
      // 情势的一句话，以及它和模型面所有「多久以前」共用的那一把尺。
      "summary",
      "generatedAt",
      "usage",
      // run 自有的并发上界（docs/dynamic-workflow/concurrency.md「Two bounds on a run」）：只在低于本机天花板时出现。
      "maxConcurrency",
      // run 自有的子代理模型（docs/dynamic-workflow/launch.md）：只在设过时出现，继承会话模型的 run 缺席。
      "subagentModel",
      // 脚本点名的模型绑定表（docs/dynamic-workflow/launch.md「Models the script names」）：只在脚本点过名时出现。
      "modelBindings",
      // run 的脚本文件（docs/dynamic-workflow/launch.md「Script files」）：只在记过时出现，
      // 已经写成模型面该看到的样子（工作区相对或绝对）。
      "scriptPath",
      "actors",
      "logTail",
      // 情势截面：阶段表「无则缺席」，花名册恒在场，健康恒在场。
      "phases",
      "subagents",
      "subagentsTruncated",
      "health",
      "result",
      "error",
      // 停驻中的升级问题（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md）：可选、零条时整字段缺席。
      // 它是模型侧唯一的发现面——升级通知丢弃后，主代理只能从这里重新拿到 qid。
      "pendingQuestions",
      // 留白（docs/dynamic-workflow/launch.md「The `FillWorkflowHole` tool」）：等着的与补过的，零条时整字段缺席。
      // 与 pendingQuestions 同一种角色——留白通知丢失后模型侧唯一的发现面。
      "holes",
      // 用户面产物（docs/dynamic-workflow/authoring.md）：任意状态都附、零件时整字段缺席。
      // 模型据此知道哪些交付物已经以卡片呈现给用户，按标题引用而不复述内容。
      "artifacts",
    ]);
    const required = schema.required ?? [];
    expect(required).toContain("usage");
    expect(required).toContain("logTail");
    expect(required).toContain("summary");
    expect(required).toContain("generatedAt");
    expect(required).toContain("subagents");
    expect(required).toContain("health");
    expect(required).not.toContain("phases");
    expect(required).not.toContain("subagentsTruncated");
    expect(required).not.toContain("result");
    expect(required).not.toContain("error");
    expect(required).not.toContain("possiblyInterrupted");
    expect(required).not.toContain("pendingQuestions");
    expect(required).not.toContain("scriptPath");
  });
});
