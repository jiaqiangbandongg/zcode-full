// ============================================================
// ResolveWorkflowQuestion Tool Handler
// ============================================================
// 主代理用它回答一个 actor 从**正在跑的** workflow 里升级上来的阻塞问题。见端口 `DynamicWorkflowRunPort.resolveQuestion`。
//
// handler 刻意**很薄**：qid 查表、driver 结算、事件双轨全在 port 服务端，这里只做三件事:
// 取端口（typeof 探测，照 resume/listRuns 先例）、透传 qid 与答案、把结果投影成契约形状。
//
// 拒绝文案**原样透传**服务端的 message：那段文字由写注册表的那一层写好（陈述现状与下一步），
// 判别键与文案分开维护则两处迟早会说不同的话，而这里的读者是模型——它读到的就是它的下一步。
// 因此本文件的三个拒绝分支只负责挑一个稳定的 errorCode，不重写一个字。

import {
  RESOLVE_WORKFLOW_QUESTION_TOOL_NAME,
  ResolveWorkflowQuestionInputJsonSchema,
  ResolveWorkflowQuestionInputSchema,
  ResolveWorkflowQuestionOutputJsonSchema,
  ResolveWorkflowQuestionOutputSchema,
  type ModelMessageContent,
  type ResolveWorkflowQuestionInput,
  type ResolveWorkflowQuestionOutput,
} from "@zcode/contracts";
import type {
  ToolEntry,
  ToolExecutionContext,
  ToolHandler,
  ToolHandlerFailure,
} from "../types.js";

const RESOLVE_WORKFLOW_QUESTION_TIMEOUT_MS = 15_000;
/** 输出只有一段确认文案，24k 绰绰有余（照 ResumeWorkflowRun）。 */
const RESOLVE_WORKFLOW_QUESTION_MODEL_BYTES = 24_000;

/**
 * 本地失败码表。数值只是日志位（executor 把它投影成 `code: "N"` 字符串）；模型真正读的是
 * message，而三个拒绝分支的 message 由服务端写好。刻意从 21 起编，与内省表（1/2）和
 * ResumeWorkflowRun 表（11–15）视觉分开——三张表的数值空间互相独立、禁止跨表比对。
 */
const RESOLVE_WORKFLOW_QUESTION_ERROR_CODE = {
  ANSWERING_UNAVAILABLE: 21,
  UNKNOWN_QUESTION: 22,
  ALREADY_RESOLVED: 23,
  RUN_NOT_IN_FLIGHT: 24,
} as const;

const RESOLVE_WORKFLOW_QUESTION_DESCRIPTION = [
  "Answers a blocking question that a subagent escalated from inside a RUNNING dynamic-workflow run.",
  "",
  "- Takes question_id — the ID from the escalation notification (it looks like `dwfq-...`). If that notification was lost, GetWorkflowRun lists the questions a run still owes an answer to.",
  "- The run keeps running the whole time: only the subagent that asked is parked on its call, while every other subagent and the script's control flow keep going. Your answer becomes that call's result verbatim and the subagent continues from there.",
  "- Answer directly and actionably. If you are not sure, look at the run first with GetWorkflowRun, or ask the user with AskUserQuestion, then come back and answer — nothing answers on your behalf, and the subagent waits indefinitely.",
  "- If the question reveals the SCRIPT is structurally broken (a broken gate, wrong control flow), a sentence cannot fix that: cancel the run and continue with a revised script via CreateWorkflow's `resume_from`.",
].join("\n");

/**
 * 「本会话没有应答能力」。端口缺席（journal 不可用 → run service 整个不构造）与方法缺席
 * （stub 不带 resolveQuestion）回同一个失败：对模型这是同一件事（照 resume 的 typeof 探测
 * 先例）。绝不静默成功——那会让一个 actor 永远等下去，而模型以为自己已经答过了。
 */
function resolveQuestionUnavailableFailure(): ToolHandlerFailure {
  return {
    result: false,
    errorCode: RESOLVE_WORKFLOW_QUESTION_ERROR_CODE.ANSWERING_UNAVAILABLE,
    message:
      "workflow_question_answering_unavailable: this session cannot answer workflow escalations — workflow execution is not available here. This is a capability gap, not a bad question ID.",
  };
}

/** 端口三种 reason → 各自的稳定错误码；message 原样来自服务端。 */
function resolveQuestionFailureFor(reason: string, message: string): ToolHandlerFailure {
  switch (reason) {
    case "unknown_question":
      return {
        result: false,
        errorCode: RESOLVE_WORKFLOW_QUESTION_ERROR_CODE.UNKNOWN_QUESTION,
        message,
      };
    case "already_resolved":
      return {
        result: false,
        errorCode: RESOLVE_WORKFLOW_QUESTION_ERROR_CODE.ALREADY_RESOLVED,
        message,
      };
    case "run_not_in_flight":
      return {
        result: false,
        errorCode: RESOLVE_WORKFLOW_QUESTION_ERROR_CODE.RUN_NOT_IN_FLIGHT,
        message,
      };
    default:
      // 端口契约外的 reason：仍回结构化失败（throw 是接线故障的通道），文案带原词供排查。
      return {
        result: false,
        errorCode: RESOLVE_WORKFLOW_QUESTION_ERROR_CODE.UNKNOWN_QUESTION,
        message: `${message} (reason: ${reason})`,
      };
  }
}

const resolveWorkflowQuestionHandler: ToolHandler = async (
  input,
  context: ToolExecutionContext,
) => {
  const parsed = ResolveWorkflowQuestionInputSchema.parse(
    input,
  ) as ResolveWorkflowQuestionInput;

  const port = context.dynamicWorkflowRunPort;
  if (port === undefined || typeof port.resolveQuestion !== "function") {
    return resolveQuestionUnavailableFailure();
  }

  const result = await port.resolveQuestion(parsed.question_id, parsed.answer);
  if (!result.ok) {
    return resolveQuestionFailureFor(result.reason, result.message);
  }

  return {
    ok: true,
    qid: result.qid,
    // 说清两件事：答案已经送达，以及 run 并没有因此停下——主代理不必守着它。
    response: `Answer delivered for question ${result.qid}. The subagent that asked has resumed its turn with your answer; the run keeps going as before.`,
  } satisfies ResolveWorkflowQuestionOutput;
};

function formatResolveWorkflowQuestionModelContent(output: unknown): ModelMessageContent {
  const parsed = ResolveWorkflowQuestionOutputSchema.safeParse(output);
  if (!parsed.success) return "ResolveWorkflowQuestion returned an invalid result.";
  return parsed.data.response;
}

export const resolveWorkflowQuestionToolEntry: ToolEntry = {
  capability: "Answer a blocking question escalated by a subagent inside a running workflow run",
  metadata: {
    shouldDefer: true,
    name: RESOLVE_WORKFLOW_QUESTION_TOOL_NAME,
    description: RESOLVE_WORKFLOW_QUESTION_DESCRIPTION,
    // 作答会让一个停驻的 actor 带着这段文字继续干活——不是只读。
    readOnly: false,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: RESOLVE_WORKFLOW_QUESTION_TIMEOUT_MS,
    maxOutputBytes: RESOLVE_WORKFLOW_QUESTION_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    // 免确认：作答只是把一段文字送进一个已获批准的 run（run 本身在 CreateWorkflow 的确认窗
    // 已经过关），与 ResumeWorkflowRun 同一风险档。弹窗还会把一个正在等答案的 actor 挂更久。
    needsApproval: false,
  },
  handler: resolveWorkflowQuestionHandler,
  inputSchema: ResolveWorkflowQuestionInputJsonSchema,
  outputSchema: ResolveWorkflowQuestionOutputJsonSchema,
  runtimeInputSchema: ResolveWorkflowQuestionInputSchema,
  runtimeOutputSchema: ResolveWorkflowQuestionOutputSchema,
  formatModelContent: formatResolveWorkflowQuestionModelContent,
  permission: {
    permission: "resolveWorkflowQuestion",
    reason: "resolveWorkflowQuestion answers a blocked subagent inside a running workflow run",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    // question_id 进入模式匹配面（照 ResumeWorkflowRun 的 run_id）。
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: RESOLVE_WORKFLOW_QUESTION_MODEL_BYTES,
    maxModelBytes: RESOLVE_WORKFLOW_QUESTION_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: RESOLVE_WORKFLOW_QUESTION_MODEL_BYTES,
      direction: "head",
    },
  },
  timeout: {
    kind: "timed",
    defaultMs: RESOLVE_WORKFLOW_QUESTION_TIMEOUT_MS,
    maxMs: RESOLVE_WORKFLOW_QUESTION_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: false,
    cleanup: "none",
    userVisibleMessage:
      "ResolveWorkflowQuestion delivers the answer synchronously and cannot be cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
