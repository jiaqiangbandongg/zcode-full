// ============================================================
// ResumeWorkflowRun Tool Handler
// ============================================================
// 恢复一个 stopped 的 dwf run（模型侧入口；可恢复集 = `stopped`，不论 reason）。见端口契约
// `DynamicWorkflowRunPort.resume`（contracts/src/interfaces/dynamic-workflow-run.port.ts）。
//
// handler 刻意**很薄**：门（可恢复集判定）、注册表替换、compileOnce/scriptHash 重验全部在
// port.resume 服务端，这里只做三件事：取端口、透传 run_id、把结果投影成契约形状。
// 输出的 backgrounded 形状让 executor 走 CreateWorkflow 同一条自动追踪
// （call-runner → trackBackgroundTask），快照/等待/取消/通知零新代码。
//
// resume 被 scriptHash
// 钉死在 submit 时已获批准的同一脚本上，与 UI Resume 按钮同一风险档，模型调用直接执行；
// PreToolUse deny 与项目 deny 规则仍可拦截。也不设 prepareApproval：无同步手段校验 runId，
// 坏 id 批准后照样回 run_not_found 失败，弹窗裁不掉任何东西。

import {
  RESUME_WORKFLOW_RUN_TOOL_NAME,
  ResumeWorkflowRunInputJsonSchema,
  ResumeWorkflowRunInputSchema,
  ResumeWorkflowRunOutputJsonSchema,
  ResumeWorkflowRunOutputSchema,
  type ModelMessageContent,
  type ResumeWorkflowRunInput,
  type ResumeWorkflowRunOutput,
} from "@zcode/contracts";
import type {
  ToolEntry,
  ToolExecutionContext,
  ToolHandler,
  ToolHandlerFailure,
} from "../types.js";
import { workflowRunNotFoundFailure } from "./workflow-run-introspection.js";

const RESUME_WORKFLOW_RUN_TIMEOUT_MS = 15_000;
/** 照 CreateWorkflow：输出只有一段引导文案，24k 绰绰有余。 */
const RESUME_WORKFLOW_RUN_MODEL_BYTES = 24_000;

/**
 * 本地失败码表。数值本身不进模型（executor 把 errorCode 投影成 `code: "N"` 字符串），
 * 判别键唯一权威是 message 前缀——两处数值空间归属在注释里说清：
 *
 *   - `not_found` **复用内省表**（workflow-run-introspection.ts）的 RUN_NOT_FOUND 码与其
 *     message（同键同码），所以它不在本表里；
 *   - 本表的其余四码与内省表的数值空间**互相独立、禁止跨表比对**——刻意从 11 起编避免与
 *     内省表（1/2）视觉撞车，但真正防混淆的是「数值只是日志位，判别键在 message 前缀」。
 *     选择注释归属而非并入共享表：把 introspection 模块变成 dwf 失败码总表，等于让一个
 *     只读内省工具集背负执行面的失败语义。
 */
const RESUME_WORKFLOW_RUN_ERROR_CODE = {
  RESUME_UNAVAILABLE: 11,
  NOT_RESUMABLE: 12,
  ALREADY_RUNNING: 13,
  SCRIPT_MISSING: 14,
  SCRIPT_MISMATCH: 15,
  SUPERSEDED: 16,
  COMPILE_FAILED: 17,
} as const;

const RESUME_WORKFLOW_RUN_DESCRIPTION = [
  "Resumes a dynamic-workflow run whose status is `stopped` — the user cancelled it, you stopped it with TaskStop, a provider-side error stopped it (expired sign-in, model not in the plan, quota cap), or the process that owned it exited (`interrupted`). The run continues under the same run ID: finished steps are replayed from the journal without spending tokens, unfinished steps are dispatched again. The one stopped run that is NOT resumable is a `superseded` one: an AmendWorkflow replaced it, and its successor is the live run.",
  "",
  "- Takes run_id — from CreateWorkflow's or AmendWorkflow's result, from a completion notification, or from GetWorkflowRun / ListWorkflowRuns.",
  "- The resumed run is backgrounded: you will be notified with the final output when it completes. Do not wait for it or poll it with TaskOutput; continue with other work unless the user asked you to wait.",
  "- An `errored` run (the script itself failed) is NOT resumable — replaying it would fail the same way. Fix the script and submit it with AmendWorkflow instead. A completed run is not resumable either; a `superseded` run is refused with the successor's ID.",
  "- Stop reason `user` means the user stopped it on purpose: resume it only when the user asks you to; never resume a run the user just cancelled on your own initiative. Reason `model` is your own TaskStop. Reason `provider` means a provider-side error stopped it: resolve the cause with the user first (the stop notification names it), then resume. Reason `interrupted` (the process died) is different: continuing it is usually what the user wants.",
].join("\n");

/**
 * 「本会话没有 resume 能力」。端口缺席（journal 不可用 → run service 整个不构造）与方法
 * 缺席（stub 不带 resume）回同一个失败：对模型这是同一件事（照 listRuns/getRunDetail 的
 * typeof 探测先例）。绝不静默降级——模型据此会去等一个永不到来的通知。
 */
function workflowResumeUnavailableFailure(): ToolHandlerFailure {
  return {
    result: false,
    errorCode: RESUME_WORKFLOW_RUN_ERROR_CODE.RESUME_UNAVAILABLE,
    message:
      "workflow_resume_unavailable: this session cannot resume workflow runs — workflow execution is not available here. This is a capability gap, not a status problem.",
  };
}

/** 端口的 reason → 各配可操作文案的结构化失败（判别键在 message 前缀）。 */
function resumeFailureFor(reason: string, runId: string, detail?: string): ToolHandlerFailure {
  switch (reason) {
    // 已保存脚本可能不再适配当前 facade；编译失败时需先修订脚本，不能直接重放。
    case "compile_failed":
      return {
        result: false,
        errorCode: RESUME_WORKFLOW_RUN_ERROR_CODE.COMPILE_FAILED,
        message: `workflow_run_compile_failed: the stored script of run ${runId} no longer compiles against the current workflow facade, so it cannot be replayed as-is. Rewrite it for the current facade and submit it with AmendWorkflow, which keeps the finished work of this run.${detail === undefined ? "" : `\n${detail}`}`,
      };
    case "not_resumable":
      return {
        result: false,
        errorCode: RESUME_WORKFLOW_RUN_ERROR_CODE.NOT_RESUMABLE,
        message:
          "workflow_run_not_resumable: this run is not in the resumable set — only a `stopped` run can be resumed (any stop reason except `superseded`). An `errored` run needs a corrected script submitted with AmendWorkflow; a completed run has nothing to resume. Check the status with GetWorkflowRun.",
      };
    case "superseded":
      return {
        result: false,
        errorCode: RESUME_WORKFLOW_RUN_ERROR_CODE.SUPERSEDED,
        message: `workflow_run_superseded: run ${runId} was stopped by an AmendWorkflow and superseded; its unfinished work belongs to the successor run (see GetWorkflowRun's <superseded_by>). Read or amend the successor instead of resuming this run.`,
      };
    // already_running 的门作用域是**本 run service 实例**（per-app/per-session）内的在飞
    // 注册表：跨会话并发 resume 同一 journal run 不被拦——既有开放语义，此处文案只描述本实例的语义，不替跨实例行为做承诺。
    case "already_running":
      return {
        result: false,
        errorCode: RESUME_WORKFLOW_RUN_ERROR_CODE.ALREADY_RUNNING,
        message:
          "workflow_run_already_running: this run is already in flight in this session's workflow runtime. Wait for its completion notification instead of resuming it again.",
      };
    case "script_missing":
      return {
        result: false,
        errorCode: RESUME_WORKFLOW_RUN_ERROR_CODE.SCRIPT_MISSING,
        message:
          "workflow_run_script_missing: this run's journal record has no stored script text (it predates script persistence), so there is nothing to re-run. Start a fresh run with CreateWorkflow instead.",
      };
    case "script_mismatch":
      return {
        result: false,
        errorCode: RESUME_WORKFLOW_RUN_ERROR_CODE.SCRIPT_MISMATCH,
        message: `workflow_run_script_mismatch: the stored script hash for run ${runId} no longer matches the stored script text — the journal record was modified by an outside force. Start a fresh run with CreateWorkflow instead.`,
      };
    default:
      // 端口契约外的 reason：仍回结构化失败（不 throw——那是接线故障的通道），判别键用
      // 保留前缀，文案带原词供日志排查。
      return {
        result: false,
        errorCode: RESUME_WORKFLOW_RUN_ERROR_CODE.NOT_RESUMABLE,
        message: `workflow_run_not_resumable: the workflow runtime refused to resume run ${runId} (reason: ${reason}).`,
      };
  }
}

const resumeWorkflowRunHandler: ToolHandler = async (input, context: ToolExecutionContext) => {
  const parsed = ResumeWorkflowRunInputSchema.parse(input) as ResumeWorkflowRunInput;

  const port = context.dynamicWorkflowRunPort;
  if (port === undefined || typeof port.resume !== "function") {
    return workflowResumeUnavailableFailure();
  }

  const result = await port.resume(parsed.run_id);
  if (!result.ok) {
    // not_found 复用内省工具的 run_not_found 键（同键同码同 message）。
    return result.reason === "not_found"
      ? workflowRunNotFoundFailure(parsed.run_id)
      : resumeFailureFor(result.reason, parsed.run_id, result.message);
  }

  return {
    ok: true,
    runId: result.runId,
    // 文案照 CreateWorkflow 的 backgrounded 引导（create-workflow.ts）：给出 id、说明仍在
    // 跑、明确结果以通知形式回来、显式劝阻默认轮询（实测缺这句模型会立刻用
    // TaskOutput 把异步 run 变成同步等待）。
    response: `The workflow run ${result.runId} has been resumed and is running in the background. It is still running — you will be notified with the final output when it completes. Do not wait for it or poll it with TaskOutput; continue with other work unless the user asked you to wait.`,
    status: "backgrounded",
    // backgroundTaskId ≡ runId（与 CreateWorkflow 的 backgrounded 输出同一恒等式）：
    // 取消、TaskOutput 查询、终态通知三条路径共用这一个键。
    backgroundTaskId: result.runId,
  } satisfies ResumeWorkflowRunOutput;
};

function formatResumeWorkflowRunModelContent(output: unknown): ModelMessageContent {
  const parsed = ResumeWorkflowRunOutputSchema.safeParse(output);
  if (!parsed.success) return "ResumeWorkflowRun returned an invalid result.";
  return parsed.data.response;
}

export const resumeWorkflowRunToolEntry: ToolEntry = {
  capability: "Resume a stopped dynamic-workflow run under the same run ID",
  metadata: {
    shouldDefer: true,
    name: RESUME_WORKFLOW_RUN_TOOL_NAME,
    description: RESUME_WORKFLOW_RUN_DESCRIPTION,
    // 恢复 = 重新启动执行子进程与 actor 会话（完结节点 replay、未完结重派发），与
    // CreateWorkflow 同档，只读声明不成立。
    readOnly: false,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: RESUME_WORKFLOW_RUN_TIMEOUT_MS,
    maxOutputBytes: RESUME_WORKFLOW_RUN_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    // 免确认：钉死在已批准的同一脚本上，不弹窗。
    needsApproval: false,
  },
  handler: resumeWorkflowRunHandler,
  inputSchema: ResumeWorkflowRunInputJsonSchema,
  outputSchema: ResumeWorkflowRunOutputJsonSchema,
  runtimeInputSchema: ResumeWorkflowRunInputSchema,
  runtimeOutputSchema: ResumeWorkflowRunOutputSchema,
  formatModelContent: formatResumeWorkflowRunModelContent,
  permission: {
    permission: "resumeWorkflowRun",
    reason: "resumeWorkflowRun.runConfirmation: resuming continues executing a stopped workflow run",
    riskLevel: "low",
    sideEffectScope: "none",
    // resume 被
    // scriptHash 钉死在 submit 时已获批准的同一脚本上，完结节点纯 replay，与 UI 按钮同一
    // 风险档——模型调用直接执行。拦截面仍在：PreToolUse deny（call-runner，先于执行）与
    // 项目 deny 规则（denyPriority:"beforeAsk"）照常生效。
    needsApproval: false,
    // run_id 进入模式匹配面（照 TaskOutput 的 task_id），好让项目规则能约束到具体 run。
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: RESUME_WORKFLOW_RUN_MODEL_BYTES,
    maxModelBytes: RESUME_WORKFLOW_RUN_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: RESUME_WORKFLOW_RUN_MODEL_BYTES,
      direction: "head",
    },
  },
  timeout: {
    kind: "timed",
    defaultMs: RESUME_WORKFLOW_RUN_TIMEOUT_MS,
    maxMs: RESUME_WORKFLOW_RUN_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: false,
    cleanup: "none",
    userVisibleMessage: "ResumeWorkflowRun resumes the run synchronously and cannot be cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
