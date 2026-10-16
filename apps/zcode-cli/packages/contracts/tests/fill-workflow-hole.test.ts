import { describe, expect, it } from "vitest";
import {
  FILL_WORKFLOW_HOLE_TOOL_NAME,
  FillWorkflowHoleInputJsonSchema,
  FillWorkflowHoleInputSchema,
  FillWorkflowHoleOutputSchema,
  isFillWorkflowHoleOwnedRun,
} from "../src/tools/fill-workflow-hole.js";
import { CreateWorkflowOutputSchema } from "../src/tools/create-workflow.js";
import { GetWorkflowRunOutputSchema } from "../src/tools/get-workflow-run.js";

// docs/dynamic-workflow/launch.md「The `FillWorkflowHole` tool」：模型面是 run_id + hole_id + 恰好一个
// 来源（script / path）；`hole` 是 resolveInput 回填的事实块——运行时 schema 认它、模型面 JSON schema
// 不列它（与 AmendWorkflow 的 `predecessor` 同一个姿态）。
describe("FillWorkflowHoleInputSchema", () => {
  const BODY = 'const verdict = await agent("judge").ask<string>("judge it");\nreturn verdict;';

  it("names the tool and accepts the two model-facing shapes", () => {
    expect(FILL_WORKFLOW_HOLE_TOOL_NAME).toBe("FillWorkflowHole");
    const inline = { run_id: "dwfrun-1", hole_id: "hole#1", script: BODY };
    expect(FillWorkflowHoleInputSchema.parse(inline)).toEqual(inline);
    const file = {
      run_id: "dwfrun-1",
      hole_id: "hole#1",
      path: ".zcode/workflow-drafts/a.verdict.dwf.ts",
    };
    expect(FillWorkflowHoleInputSchema.parse(file)).toEqual(file);
  });

  it("requires run_id and hole_id and rejects unknown keys", () => {
    expect(FillWorkflowHoleInputSchema.safeParse({ hole_id: "hole#1", script: BODY }).success).toBe(
      false,
    );
    expect(
      FillWorkflowHoleInputSchema.safeParse({ run_id: "dwfrun-1", script: BODY }).success,
    ).toBe(false);
    expect(
      FillWorkflowHoleInputSchema.safeParse({
        run_id: "dwfrun-1",
        hole_id: "hole#1",
        script: BODY,
        body: BODY,
      }).success,
    ).toBe(false);
    expect(
      FillWorkflowHoleInputSchema.safeParse({ run_id: "dwfrun-1", hole_id: "hole#1", script: "" })
        .success,
    ).toBe(false);
  });

  it("accepts the resolved hole block and rejects a malformed one", () => {
    const resolved = {
      run_id: "dwfrun-1",
      hole_id: "hole#1",
      script: BODY,
      hole: {
        name: "决定分组",
        type: "Verdict",
        draft_path: "/repo/.zcode/workflow-drafts/triage.dwf.ts",
        line: 12,
        owned_by_this_session: true,
      },
    };
    expect(FillWorkflowHoleInputSchema.parse(resolved)).toEqual(resolved);
    expect(
      FillWorkflowHoleInputSchema.safeParse({
        ...resolved,
        hole: { name: "决定分组", type: "Verdict", owned_by_this_session: false },
      }).success,
    ).toBe(true);
    expect(
      FillWorkflowHoleInputSchema.safeParse({ ...resolved, hole: { name: "决定分组" } }).success,
    ).toBe(false);
  });

  it("does not list the hole block in the model-facing JSON schema", () => {
    const json = FillWorkflowHoleInputJsonSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(json.properties ?? {}).sort()).toEqual([
      "hole_id",
      "path",
      "run_id",
      "script",
    ]);
    expect(json.required?.sort()).toEqual(["hole_id", "run_id"]);
  });

  it("shares CreateWorkflow's output schema so the display rides the fill row", () => {
    expect(FillWorkflowHoleOutputSchema).toBe(CreateWorkflowOutputSchema);
  });
});

// 免确认的 owner 规则（docs/dynamic-workflow/launch.md「Approval」）：与 AmendWorkflow 的谓词一样住在
// 契约里，权限服务与 handler 读同一条。
describe("isFillWorkflowHoleOwnedRun", () => {
  it("is true only for a hole block that says owned_by_this_session", () => {
    expect(isFillWorkflowHoleOwnedRun({ name: "n", type: "T", owned_by_this_session: true })).toBe(
      true,
    );
    expect(isFillWorkflowHoleOwnedRun({ name: "n", type: "T", owned_by_this_session: false })).toBe(
      false,
    );
    expect(isFillWorkflowHoleOwnedRun({ name: "n", type: "T", owned_by_this_session: "yes" })).toBe(
      false,
    );
    expect(isFillWorkflowHoleOwnedRun(undefined)).toBe(false);
    expect(isFillWorkflowHoleOwnedRun(null)).toBe(false);
  });
});

// GetWorkflowRun 的 `holes` 与 pendingQuestions 同规：零条缺席、≤32 条、strict 字段。
describe("GetWorkflowRunOutputSchema.holes", () => {
  const base = {
    runId: "dwfrun-1",
    label: "triage",
    labelSource: "name",
    status: "running",
    ownedByThisSession: true,
    createdAt: 1,
    updatedAt: 2,
    generatedAt: 3,
    summary: "Running.",
    usage: { spentTokens: 0, nodesObserved: 0, nodesRunning: 0, nodesCompleted: 0, nodesFailed: 0 },
    actors: [],
    logTail: [],
    subagents: [],
    health: { consecutiveFailures: 0, cachedSteps: 0, pendingQuestionsKnown: true },
  };

  it("accepts waiting and filled holes", () => {
    const holes = [
      {
        siteId: "hole#1",
        ordinal: 1,
        name: "决定分组",
        type: "Verdict",
        state: "waiting",
        since: 10,
      },
      {
        siteId: "hole#2",
        ordinal: 1,
        name: "收尾",
        type: "string",
        state: "filled",
        filledAt: 20,
        filledBy: "sess_a",
      },
    ];
    expect(GetWorkflowRunOutputSchema.parse({ ...base, holes })).toMatchObject({ holes });
    expect(
      GetWorkflowRunOutputSchema.safeParse({ ...base, holes: [{ ...holes[0], state: "open" }] })
        .success,
    ).toBe(false);
  });
});

// 递归留白：一次补全的函数体里可以再留白，站点 id 形如 `hole#1/hole#1`（可更深）。入参对 id 只要求非空，
// 不设任何会拒绝 `/` 的正则——模型要能把通知里的 id 原样抄回来。
describe("FillWorkflowHoleInputSchema — nested hole ids", () => {
  it("accepts nested site ids verbatim", () => {
    for (const id of ["hole#1/hole#1", "hole#1/hole#1/hole#2", "hole#3/hole#1/hole#1/hole#1"]) {
      const input = { run_id: "dwfrun-1", hole_id: id, script: "return 1;" };
      expect(FillWorkflowHoleInputSchema.parse(input)).toEqual(input);
    }
  });
});

describe("CreateWorkflowOutputSchema.fill（补全行给自己起名的那一块）", () => {
  const base = { diagnostics: [], ok: true, response: "joined" };
  it("站点 id + 名字过 strict，草稿路径与行号可选；未知键与空名被拒；缺席照常通过", () => {
    expect(CreateWorkflowOutputSchema.safeParse(base).success).toBe(true);
    expect(
      CreateWorkflowOutputSchema.safeParse({
        ...base,
        fill: { siteId: "hole#1", name: "决定分组" },
      }).success,
    ).toBe(true);
    expect(
      CreateWorkflowOutputSchema.safeParse({
        ...base,
        fill: {
          siteId: "hole#1/hole#1",
          name: "第2步",
          draftPath: "/w/.zcode/workflow-drafts/a.dwf.ts",
          line: 61,
        },
      }).success,
    ).toBe(true);
    expect(
      CreateWorkflowOutputSchema.safeParse({ ...base, fill: { siteId: "hole#1", name: "" } })
        .success,
    ).toBe(false);
    expect(
      CreateWorkflowOutputSchema.safeParse({
        ...base,
        fill: { siteId: "hole#1", name: "x", type: "T" },
      }).success,
    ).toBe(false);
  });
});
