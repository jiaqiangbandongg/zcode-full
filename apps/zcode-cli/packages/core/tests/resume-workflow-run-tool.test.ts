import { describe, expect, it } from "vitest";
import {
  RESUME_WORKFLOW_RUN_TOOL_NAME,
  ResumeWorkflowRunOutputSchema,
  type DynamicWorkflowRunPort,
  type DynamicWorkflowRunResumeResult,
} from "@zcode/contracts";
import { PermissionService } from "../src/permission/service.js";
import { resolveRuntimePermissionCapability } from "../src/tool/executor/permission-capability.js";
import { registerBuiltInTools } from "../src/tool/handlers/index.js";
import { resumeWorkflowRunToolEntry } from "../src/tool/handlers/resume-workflow-run.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { expectV2CommonContract } from "./tool-contract-assertions.js";
import type { ToolExecutionContext, ToolHandlerFailure } from "../src/tool/types.js";

/**
 * 只实现 `resume` 的桩端口；其余成员被触达即说明接线跑偏。成功/失败形态由参数决定，
 * 恢复的 runId 与请求的 run_id 不同时也按端口返回值透传（端口是身份权威）。
 */
function stubResumePort(
  resume: (runId: string) => Promise<DynamicWorkflowRunResumeResult>,
): DynamicWorkflowRunPort {
  const unreachable = (name: string) => () => {
    throw new Error(`stubResumePort.${name} 不应被 ResumeWorkflowRun handler 触及`);
  };
  return {
    submit: unreachable("submit"),
    getTask: unreachable("getTask"),
    waitForTask: unreachable("waitForTask"),
    cancel: unreachable("cancel"),
    listEvents: unreachable("listEvents"),
    listRuns: unreachable("listRuns"),
    getRunDetail: unreachable("getRunDetail"),
    resume,
  } as unknown as DynamicWorkflowRunPort;
}

function contextWith(port?: DynamicWorkflowRunPort): ToolExecutionContext {
  return {
    abortSignal: new AbortController().signal,
    sessionId: "sess_resume_run" as never,
    toolCallId: "toolu_resume_run",
    traceId: "trace_resume_run" as never,
    workingDirectory: "/workspace/project",
    workspaceRoot: "/workspace/project",
    ...(port === undefined ? {} : { dynamicWorkflowRunPort: port }),
  } as ToolExecutionContext;
}

async function call(
  runId: string,
  port?: DynamicWorkflowRunPort,
): Promise<Record<string, unknown>> {
  return (await resumeWorkflowRunToolEntry.handler({ run_id: runId }, contextWith(port))) as Record<
    string,
    unknown
  >;
}

function asFailure(output: unknown): ToolHandlerFailure {
  const failure = output as ToolHandlerFailure;
  expect(failure.result).toBe(false);
  return failure;
}

describe("ResumeWorkflowRun handler — capability", () => {
  // 「端口缺席」（journal 不可用 → run service 整个不构造）与「端口在场但方法缺席」
  // （stub 不带 resume）对模型是同一件事：本会话没有这个能力。
  it("returns the same business failure for an absent port and an absent method", async () => {
    const portWithoutMethod = {
      async submit() {
        throw new Error("unreachable");
      },
    } as unknown as DynamicWorkflowRunPort;

    const withoutPort = asFailure(await call("dwfrun-x"));
    const withoutMethod = asFailure(await call("dwfrun-x", portWithoutMethod));

    expect(withoutPort.message).toContain("workflow_resume_unavailable");
    expect(withoutMethod).toEqual(withoutPort);
  });
});

describe("ResumeWorkflowRun handler — success", () => {
  it("passes run_id to port.resume and returns the backgrounded shape", async () => {
    const resumed: string[] = [];
    const output = await call(
      "dwfrun-1",
      stubResumePort(async (runId) => {
        resumed.push(runId);
        return { ok: true, runId };
      }),
    );

    expect(resumed).toEqual(["dwfrun-1"]);
    // runId ≡ taskId ≡ workId：backgroundTaskId 就是 runId，三条路径共用一个键。
    expect(output.backgroundTaskId).toBe("dwfrun-1");
    expect(output.status).toBe("backgrounded");
    expect(output.ok).toBe(true);
    expect(ResumeWorkflowRunOutputSchema.parse(output)).toEqual({
      ok: true,
      runId: "dwfrun-1",
      response: output.response,
      status: "backgrounded",
      backgroundTaskId: "dwfrun-1",
    });
  });

  // 异步引导（照 CreateWorkflow 的 backgrounded 文案）：模型拿到输出后不得立刻 TaskOutput
  // 阻塞等待或轮询——桌面实测过它会把异步 run 变成同步等待。钉关键词，不钉逐字。
  it("steers the model away from polling and towards the completion notification", async () => {
    const output = await call(
      "dwfrun-1",
      stubResumePort(async () => ({ ok: true, runId: "dwfrun-1" })),
    );
    const response = String(output.response);

    expect(response).toContain("dwfrun-1");
    expect(response).toMatch(/background/i);
    expect(response).toMatch(/notified/i);
    expect(response).toMatch(/do not wait/i);
    expect(response).toContain("TaskOutput");
  });
});

describe("ResumeWorkflowRun handler — structured failures", () => {
  const REASONS = [
    "not_found",
    "not_resumable",
    "already_running",
    "script_missing",
    "script_mismatch",
    "compile_failed",
  ] as const;

  it.each(REASONS)("maps port reason %s to a prefixed, actionable failure", async (reason) => {
    const failure = asFailure(
      await call(
        "dwfrun-1",
        stubResumePort(async () => ({ ok: false, reason })),
      ),
    );

    // 判别键是 message 前缀（errorCode 数值不进模型，executor 投影成 code:"N" 字符串）。
    // not_found 复用内省工具的 run_not_found 键（同键同码）。
    const expectedPrefix =
      reason === "not_found" ? "run_not_found" : `workflow_run_${reason}`;
    expect(failure.message.startsWith(`${expectedPrefix}:`)).toBe(true);
    // 可操作性：失败要说清下一步（not_found 指向 ListWorkflowRuns，其余各自说清因由）。
    expect(failure.message.length).toBeGreaterThan(expectedPrefix.length + 1);
  });

  it("compile_failed 指向 AmendWorkflow 并附上端口的诊断", async () => {
    const failure = asFailure(
      await call(
        "dwfrun-1",
        stubResumePort(async () => ({
          ok: false,
          reason: "compile_failed",
          message: "L3:C1 Property 'askWithOldFacade' does not exist",
        })),
      ),
    );
    expect(failure.message.startsWith("workflow_run_compile_failed:")).toBe(true);
    expect(failure.message).toContain("AmendWorkflow");
    expect(failure.message).toContain("askWithOldFacade");
  });

  it("keeps not_found key and code identical to the introspection tool's failure", async () => {
    const failure = asFailure(
      await call(
        "dwfrun-nope",
        stubResumePort(async () => ({ ok: false, reason: "not_found" })),
      ),
    );
    expect(failure.message).toContain("dwfrun-nope");
    expect(failure.message).toContain("ListWorkflowRuns");
  });
});

describe("ResumeWorkflowRun model content", () => {
  it("renders the response text for a valid output", () => {
    const content = String(
      resumeWorkflowRunToolEntry.formatModelContent?.({
        ok: true,
        runId: "dwfrun-1",
        response: "resumed in the background",
        status: "backgrounded",
        backgroundTaskId: "dwfrun-1",
      }),
    );
    expect(content).toContain("resumed in the background");
  });

  it("reports an invalid result instead of throwing", () => {
    expect(String(resumeWorkflowRunToolEntry.formatModelContent?.({ runId: 42 }))).toContain(
      "invalid result",
    );
  });
});

describe("ResumeWorkflowRun declaration", () => {
  it("declares an executing, prompt-less capability consistently on both faces", () => {
    expect(resumeWorkflowRunToolEntry.metadata).toMatchObject({
      name: RESUME_WORKFLOW_RUN_TOOL_NAME,
      // 恢复 = 重新启动执行子进程与 actor 会话，与 CreateWorkflow 同档，只读声明不成立。
      readOnly: false,
      destructive: false,
      concurrentSafe: true,
      // 免确认（2026-08-30 用户裁决）：resume 钉死在已批准的同一脚本上，不弹窗。
      needsApproval: false,
      sideEffectScope: "none",
      riskLevel: "low",
      timeoutMs: 15_000,
    });
    expect(resumeWorkflowRunToolEntry.permission).toMatchObject({
      permission: "resumeWorkflowRun",
      needsApproval: false,
      sideEffectScope: "none",
      riskLevel: "low",
      denyPriority: "beforeAsk",
      patternSources: ["toolName", "input"],
      alwaysAllowPatternSources: ["toolName"],
    });
    // 免确认裁决的负面钉子：alwaysAsk 若被顺手加回，这里必须红。
    expect(resumeWorkflowRunToolEntry.permission).not.toHaveProperty("alwaysAsk");
    expect(resumeWorkflowRunToolEntry.permission).not.toHaveProperty("askOptions");
  });

  it("budgets and times the result like the sibling run tools", () => {
    expect(resumeWorkflowRunToolEntry.resultBudget).toMatchObject({
      maxInlineBytes: 24_000,
      maxModelBytes: 24_000,
      strategy: "truncate",
    });
    expect(resumeWorkflowRunToolEntry.resultBudget.maxInlineBytes).toBeGreaterThan(0);
    // timeout 与 metadata.timeoutMs 一致（v2 common contract 断言之外再各自钉一遍）。
    expect(resumeWorkflowRunToolEntry.timeout).toMatchObject({
      kind: "timed",
      defaultMs: 15_000,
      maxMs: 15_000,
      allowCallOverride: false,
    });
  });

  // tool-contracts.test.ts 的 v2 全量循环在第一处不一致就中止；新工具在这里各自再钉一遍。
  it("declares the v2 common contract", () => {
    expectV2CommonContract(resumeWorkflowRunToolEntry);
  });

  it("describes the resumable set and the do-not-poll steering", () => {
    const description = resumeWorkflowRunToolEntry.metadata.description ?? "";
    expect(description).toMatch(/cancel/i);
    expect(description).toContain("interrupted");
    expect(description).toMatch(/errored/);
    expect(description).toMatch(/do not wait|do not poll/i);
    expect(description).toContain("TaskOutput");
    expect(description).toContain("GetWorkflowRun");
  });

  // 用户取消之后主代理不得自行恢复（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Cancel and resume」 2026-09-09）：
  // 描述要把「cancelled 是有人故意停的，只在用户要求时恢复」说出来。钉关键词不钉逐字。
  it("tells the model a cancelled run is resumed only when the user asks", () => {
    const description = resumeWorkflowRunToolEntry.metadata.description ?? "";
    expect(description).toMatch(/stopped it on purpose/i);
    expect(description).toMatch(/only when the user asks/i);
    expect(description).toContain("TaskStop");
  });
});

describe("ResumeWorkflowRun registration", () => {
  it("is always on, with no gate option", () => {
    const registry = createToolRegistry();
    registerBuiltInTools(registry);

    expect(registry.has(RESUME_WORKFLOW_RUN_TOOL_NAME)).toBe(true);
    expect(registry.toContracts().map((tool) => tool.name)).toContain(RESUME_WORKFLOW_RUN_TOOL_NAME);
  });

  // 免确认（2026-08-30）：build/yolo 自动放行（prompt-less 直行）；plan 按 read-only 契约
  // 拒绝（mode.plan.nonReadOnly——resume 是执行面工具，plan 模式不执行副作用）。
  // 完整的 run() 全链路权限矩阵在 resume-workflow-run-permission.test.ts。
  it("auto-allows in build and yolo; plan mode still denies (read-only contract)", () => {
    const service = new PermissionService();
    const capability = resolveRuntimePermissionCapability(
      resumeWorkflowRunToolEntry,
      { run_id: "dwfrun-1" },
      {
        workingDirectory: "/workspace/project",
        workspaceRoot: "/workspace/project",
      } as never,
    );
    for (const mode of ["build", "yolo"] as const) {
      const decision = service.checkPermission(
        {
          input: { run_id: "dwfrun-1" },
          mode,
          riskLevel: "low",
          toolName: RESUME_WORKFLOW_RUN_TOOL_NAME,
        },
        capability,
      );
      expect(decision.allowed, mode).toBe(true);
    }
    const planDecision = service.checkPermission(
      {
        input: { run_id: "dwfrun-1" },
        mode: "plan",
        riskLevel: "low",
        toolName: RESUME_WORKFLOW_RUN_TOOL_NAME,
      },
      capability,
    );
    expect(planDecision.allowed).toBe(false);
  });
});
