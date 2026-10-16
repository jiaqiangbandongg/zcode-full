import { describe, expect, it } from "vitest";
import {
  LIST_WORKFLOW_RUNS_TOOL_NAME,
  ListWorkflowRunsOutputSchema,
  type DynamicWorkflowRunListItem,
  type DynamicWorkflowRunListQuery,
  type DynamicWorkflowRunListResult,
  type DynamicWorkflowRunPort,
} from "@zcode/contracts";
import { PermissionService } from "../src/permission/service.js";
import { resolveRuntimePermissionCapability } from "../src/tool/executor/permission-capability.js";
import { listWorkflowRunsToolEntry } from "../src/tool/handlers/list-workflow-runs.js";
import { registerBuiltInTools } from "../src/tool/handlers/index.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { expectV2CommonContract } from "./tool-contract-assertions.js";
import type { ToolExecutionContext, ToolHandlerFailure } from "../src/tool/types.js";

const RUNNING_ITEM: DynamicWorkflowRunListItem = {
  runId: "dwfrun-running",
  label: "nightly triage",
  labelSource: "name",
  status: "running",
  ownedByThisSession: true,
  createdAt: Date.UTC(2026, 7, 21, 9, 0, 0),
  updatedAt: Date.UTC(2026, 7, 21, 9, 5, 0),
  spentTokens: 1_204,
};

const STRANDED_ITEM: DynamicWorkflowRunListItem = {
  runId: "dwfrun-stranded",
  label: "// triage the failing tests",
  labelSource: "script",
  status: "running",
  ownedByThisSession: false,
  possiblyInterrupted: true,
  createdAt: Date.UTC(2026, 7, 20, 8, 0, 0),
  updatedAt: Date.UTC(2026, 7, 20, 8, 1, 0),
  spentTokens: 0,
};

/**
 * 只实现 `listRuns` 的桩端口，并记录它收到的查询袋。其余成员在被触达时抛错——本文件测的是
 * 枚举面，任何对 submit / getRunDetail 的触达都说明接线跑偏了。
 */
function stubListPort(result: DynamicWorkflowRunListResult): {
  port: DynamicWorkflowRunPort;
  queries: DynamicWorkflowRunListQuery[];
} {
  const queries: DynamicWorkflowRunListQuery[] = [];
  const unreachable = (name: string) => () => {
    throw new Error(`stubListPort.${name} 不应被 ListWorkflowRuns handler 触及`);
  };
  return {
    port: {
      submit: unreachable("submit"),
      getTask: unreachable("getTask"),
      waitForTask: unreachable("waitForTask"),
      cancel: unreachable("cancel"),
      listEvents: unreachable("listEvents"),
      getRunDetail: unreachable("getRunDetail"),
      async listRuns(query) {
        queries.push(query);
        return result;
      },
    } as unknown as DynamicWorkflowRunPort,
    queries,
  };
}

function contextWith(port?: DynamicWorkflowRunPort): ToolExecutionContext {
  return {
    abortSignal: new AbortController().signal,
    sessionId: "sess_list_runs" as never,
    toolCallId: "toolu_list_runs",
    traceId: "trace_list_runs" as never,
    workingDirectory: "/workspace/project",
    workspaceRoot: "/workspace/project",
    ...(port === undefined ? {} : { dynamicWorkflowRunPort: port }),
  } as ToolExecutionContext;
}

async function call(
  input: unknown,
  port?: DynamicWorkflowRunPort,
): Promise<Record<string, unknown>> {
  return (await listWorkflowRunsToolEntry.handler(input, contextWith(port))) as Record<
    string,
    unknown
  >;
}

function asFailure(output: unknown): ToolHandlerFailure {
  const failure = output as ToolHandlerFailure;
  expect(failure.result).toBe(false);
  return failure;
}

describe("ListWorkflowRuns handler — capability absence", () => {
  // 「没有 run」与「没有能力」必须可分辨：端口/方法缺席回业务失败，绝不静默空列表。
  it("returns a business failure when the run port is absent", () => {
    return call({}).then((output) => {
      const failure = asFailure(output);
      expect(failure.message).toContain("workflow_introspection_unavailable");
      expect(failure.message).toMatch(/this session/i);
    });
  });

  it("gives the same failure when the port exists without listRuns", async () => {
    const portWithoutMethod = {
      async submit() {
        throw new Error("unreachable");
      },
    } as unknown as DynamicWorkflowRunPort;

    const withoutPort = asFailure(await call({}));
    const withoutMethod = asFailure(await call({}, portWithoutMethod));

    // 对模型这是同一件事（本会话没有这个能力），所以 code 与文案必须逐字相同。
    expect(withoutMethod).toEqual(withoutPort);
  });

  it("keeps an empty project list distinguishable from a failure", async () => {
    const { port } = stubListPort({ runs: [] });
    const output = await call({}, port);

    expect("result" in output).toBe(false);
    expect(output).toEqual({ runs: [] });
    expect(ListWorkflowRunsOutputSchema.parse(output)).toEqual({ runs: [] });
  });
});

describe("ListWorkflowRuns handler — query", () => {
  it("always queries the session working directory with the default limit", async () => {
    const { port, queries } = stubListPort({ runs: [] });
    await call({}, port);

    expect(queries).toEqual([{ cwd: "/workspace/project", limit: 20 }]);
    // 未过滤时不给端口造一个 statuses 键（缺席 = 不过滤，空数组 = 不匹配任何状态）。
    expect("statuses" in queries[0]!).toBe(false);
  });

  it("passes an explicit limit and status filter through", async () => {
    const { port, queries } = stubListPort({ runs: [] });
    await call({ limit: 5, statuses: ["running", "pending"] }, port);

    expect(queries).toEqual([
      { cwd: "/workspace/project", limit: 5, statuses: ["running", "pending"] },
    ]);
  });

  // 界由 schema 施加（preprocess 钳制），所以越界的 limit 不会变成模型要恢复的工具错误，
  // 也永远不会作为一个无界枚举下推到 SQL。
  it("clamps an out-of-range limit before it reaches the port", async () => {
    const { port, queries } = stubListPort({ runs: [] });
    await call({ limit: 5_000 }, port);
    await call({ limit: 0 }, port);

    expect(queries.map((query) => query.limit)).toEqual([50, 1]);
  });
});

describe("ListWorkflowRuns handler — projection", () => {
  it("passes the cooked label, ownership and truncation flag through unchanged", async () => {
    const { port } = stubListPort({ runs: [RUNNING_ITEM, STRANDED_ITEM], truncated: true });
    const output = await call({}, port);

    expect(ListWorkflowRunsOutputSchema.parse(output)).toEqual({
      runs: [RUNNING_ITEM, STRANDED_ITEM],
      truncated: true,
    });
  });

  it("omits truncated and possiblyInterrupted instead of reporting them as false", async () => {
    const { port } = stubListPort({ runs: [RUNNING_ITEM] });
    const output = (await call({}, port)) as { runs: Array<Record<string, unknown>> };

    expect("truncated" in output).toBe(false);
    expect("possiblyInterrupted" in output.runs[0]!).toBe(false);
  });
});

describe("ListWorkflowRuns model content", () => {
  it("renders one line per run with ISO timestamps", () => {
    const content = String(
      listWorkflowRunsToolEntry.formatModelContent?.({
        runs: [RUNNING_ITEM, STRANDED_ITEM],
        truncated: true,
      }),
    );
    const lines = content.split("\n");

    expect(lines[0]).toBe('<workflow_runs count="2" truncated="true">');
    expect(lines.at(-1)).toBe("</workflow_runs>");
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain('id="dwfrun-running"');
    expect(lines[1]).toContain('status="running"');
    expect(lines[1]).toContain('label="nightly triage"');
    expect(lines[1]).toContain('owned_by_this_session="true"');
    expect(lines[1]).toContain('spent_tokens="1204"');
    // epoch ms 留在结构化输出里；模型面给 ISO，那才是它能直接读出"多久以前"的形式。
    expect(lines[1]).toContain('updated_at="2026-08-21T09:05:00.000Z"');
    expect(lines[1]).not.toContain("possibly_interrupted");
    expect(lines[2]).toContain('possibly_interrupted="true"');
  });

  it("says so in words when the project has no runs", () => {
    const content = String(listWorkflowRunsToolEntry.formatModelContent?.({ runs: [] }));

    expect(content).toContain('count="0"');
    expect(content).toMatch(/no workflow runs/i);
  });

  it("escapes a label that would otherwise break out of the attribute", () => {
    const content = String(
      listWorkflowRunsToolEntry.formatModelContent?.({
        runs: [{ ...RUNNING_ITEM, label: 'ship "it" & <now>\nsecond line' }],
      }),
    );

    expect(content).toContain('label="ship &quot;it&quot; &amp; &lt;now&gt; second line"');
    // 一 run 一行的前提：属性里的换行会把它拆成两行。
    expect(content.split("\n")).toHaveLength(3);
  });

  it("reports an invalid result instead of throwing", () => {
    expect(String(listWorkflowRunsToolEntry.formatModelContent?.({ runs: "many" }))).toContain(
      "invalid result",
    );
  });
});

describe("ListWorkflowRuns declaration", () => {
  it("declares a read-only, no-side-effect capability consistently on both faces", () => {
    expect(listWorkflowRunsToolEntry.metadata).toMatchObject({
      name: LIST_WORKFLOW_RUNS_TOOL_NAME,
      readOnly: true,
      destructive: false,
      concurrentSafe: true,
      needsApproval: false,
      sideEffectScope: "none",
      riskLevel: "low",
      timeoutMs: 10_000,
    });
    expect(listWorkflowRunsToolEntry.permission).toMatchObject({
      permission: "listWorkflowRuns",
      needsApproval: false,
      sideEffectScope: "none",
      riskLevel: "low",
      denyPriority: "beforeAsk",
    });
    // CreateWorkflow 的 alwaysAsk 是「执行整块代码」的 gate；读状态绝不继承它。
    expect(listWorkflowRunsToolEntry.permission.alwaysAsk).toBeUndefined();
  });

  it("budgets the list for truncation rather than an artifact", () => {
    expect(listWorkflowRunsToolEntry.resultBudget).toMatchObject({
      maxInlineBytes: 24_000,
      maxModelBytes: 24_000,
      strategy: "truncate",
      preview: { direction: "head" },
    });
  });

  // tool-contracts.test.ts 的 v2 全量循环在第一处不一致就中止，所以两个新工具在这里各自
  // 再钉一遍那份契约——否则一个上游工具的既有偏差会把这两条断言永久遮住。
  it("declares the v2 common contract", () => {
    expectV2CommonContract(listWorkflowRunsToolEntry);
  });

  // 引导文案（spec 的「模型引导文案」行）：钉关键词，不钉逐字。
  it("steers the model away from polling in-flight runs", () => {
    const description = listWorkflowRunsToolEntry.metadata.description ?? "";

    expect(description).toMatch(/do not poll/i);
    expect(description).toMatch(/notification/i);
    expect(description).toMatch(/other sessions|across sessions|another session/i);
    expect(description).toContain("GetWorkflowRun");
  });

  // 路由引导（2026-08-29）：列表也要指路 ResumeWorkflowRun（跨会话历史里最常见的就是
  // cancelled / Interrupted 的 run）。钉关键词，不钉逐字。
  it("cross-references ResumeWorkflowRun for the resumable states", () => {
    const description = listWorkflowRunsToolEntry.metadata.description ?? "";

    expect(description).toContain("ResumeWorkflowRun");
    expect(description).toMatch(/cancel/i);
    expect(description).toContain("interrupted");
    // cancelled 是有人故意停的：只在用户要求时恢复（cancel-resume 追记 2026-09-09）。
    expect(description).toMatch(/only when the user asks/i);
  });

  // 修订续跑（2026-08-31，apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md）：列表是模型看见「上次那个
  // 跑挂了的 run」的地方，第二条路由必须在这里就出现，且谓词与 plain resume 明确不同。
  it("cross-references AmendWorkflow for any run, running included", () => {
    const description = listWorkflowRunsToolEntry.metadata.description ?? "";

    expect(description).toContain("AmendWorkflow");
    expect(description).not.toContain("resume_from");
    expect(description).toMatch(/revised/i);
    expect(description).toMatch(/completed, stopped, errored, or still running/i);
    expect(description).toContain("superseded");
  });
});

describe("ListWorkflowRuns registration", () => {
  it("is always on, with no gate option", () => {
    const registry = createToolRegistry();
    registerBuiltInTools(registry);

    expect(registry.has(LIST_WORKFLOW_RUNS_TOOL_NAME)).toBe(true);
    expect(registry.toContracts().map((tool) => tool.name)).toContain(
      LIST_WORKFLOW_RUNS_TOOL_NAME,
    );
  });

  // plan / build 模式的只读直通（permission/service.ts 的 mode.plan.readOnly 分支）：
  // 一个查询状态的工具在任何模式下都不该弹窗。
  for (const mode of ["plan", "build", "yolo"] as const) {
    it(`is auto-allowed in ${mode} mode`, () => {
      const capability = resolveRuntimePermissionCapability(listWorkflowRunsToolEntry, {}, {
        workingDirectory: "/workspace/project",
        workspaceRoot: "/workspace/project",
      } as never);

      expect(
        new PermissionService().checkPermission(
          { input: {}, mode, riskLevel: "low", toolName: LIST_WORKFLOW_RUNS_TOOL_NAME },
          capability,
        ),
      ).toMatchObject({ allowed: true, decision: "allow" });
    });
  }
});
