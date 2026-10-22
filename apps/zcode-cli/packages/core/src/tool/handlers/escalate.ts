// ============================================================
// escalate Tool Handler
// ============================================================
// 工作流 actor（子 AgentRuntime）用它把一个**真阻塞**升级给创建这条工作流的主代理，并停驻
// 在自己那次 ask 里等答案。handler 把问题交给注入的 WorkflowEscalatePort，阻塞等待结局：
//   - answered → 返回主代理给的答案文本；actor 的轮次就地继续，ask 照常 settle。
//   - refused  → 返回端口写好的文案（预算已尽 / 无在飞 ask）。
//
// 两支都是**普通工具结果**，不是 ToolHandlerFailure。这与 submit_result 的 reject 分道：
// 那里的 error tool_result 是「修复通道」（模型该重试），而这里没有可修复的东西——把
// 「升级预算已尽」渲染成错误只会让模型反复撞同一堵墙，而投机绕过正是本特性要消灭的行为。
//
// 端口缺席仍然抛 ConfigurationError（照 submit_result）：本工具只在注入了端口的 actor 会话
// 注册，走到这里就是接线故障，不是一种结局。

import {
  CoreErrorType,
  ESCALATE_TOOL_NAME,
  EscalateInputJsonSchema,
  EscalateInputSchema,
  EscalateOutputJsonSchema,
  EscalateOutputSchema,
  createCoreError,
  type EscalateInput,
  type EscalateOutput,
  type TraceContext,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";

/** 答案可能是一整段说明；与 submit_result 同档的模型面上限。 */
const MAX_ESCALATE_MODEL_BYTES = 16_000;

/**
 * 工具描述 = actor 侧的**使用纪律**，它比这个工具的机制更重要：机制只让 actor 能提问，
 * 纪律才让它在该提问的时候提问。文案的四条约束：最后手段（不是好奇）、
 * 一次一个聚焦问题、阻塞可能很久、per-ask 上限 3。
 */
const ESCALATE_DESCRIPTION = [
  "Escalates a question that is BLOCKING you to the main agent that created this workflow, and waits here for the answer.",
  "",
  "This is a LAST RESORT, for when you are genuinely stuck on something outside your reach:",
  "- a gate that is broken or impossible to pass (a check capped at 95 when the threshold is 96);",
  "- instructions that contradict each other, so no output can satisfy both;",
  "- a fact you cannot obtain (a tradeoff, an external convention, what 'good' means here) that only whoever started this run knows.",
  "",
  "Do NOT use it for curiosity, progress reports, asking permission, confirming a conclusion you could verify yourself, or thinking out loud. None of those are blocked — keep working.",
  "",
  "Ask ONE focused question that can be answered in a sentence, and put your evidence in `context`: what you already tried, and exactly where you are stuck. The quality of the answer depends on it.",
  "",
  "The cost: this call BLOCKS until the main agent answers, which may take a long time. You get at most 3 escalations per ask; the 4th tells you the budget is spent and to proceed on your own best judgement. Do not spend them on questions not worth waiting for.",
].join("\n");

const escalateHandler: ToolHandler = async (input, context) => {
  const parsed = EscalateInputSchema.parse(input) as EscalateInput;

  // Gate 与 submit_result 同款：以端口存在为判据，与 runtimeScope / taskType 无关。
  if (!context.workflowEscalatePort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "Workflow escalate port is not configured for escalate",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: ESCALATE_TOOL_NAME,
        },
        recoverable: false,
      },
    );
  }

  const outcome = await context.workflowEscalatePort.escalate({
    toolCallId: context.toolCallId,
    question: parsed.question,
    ...(parsed.context === undefined ? {} : { context: parsed.context }),
    trace: resolveToolTraceContext(context),
  });

  if (outcome.kind === "answered") {
    return {
      status: "answered",
      message: outcome.answer,
      qid: outcome.qid,
    } satisfies EscalateOutput;
  }

  // 拒绝的文案由端口写好（陈述现状与下一步），这里原样透传——判别键与文案分开维护，
  // 两处迟早会说不同的话，而这里的读者是模型。
  return {
    status: "refused",
    message: outcome.message,
    reason: outcome.reason,
  } satisfies EscalateOutput;
};

export const escalateToolEntry: ToolEntry = {
  capability: "Escalate a blocking question from a workflow subagent to the main agent and wait",
  metadata: {
    shouldDefer: true,
    name: ESCALATE_TOOL_NAME,
    description: ESCALATE_DESCRIPTION,
    readOnly: false,
    destructive: false,
    // 与 submit_result 刻意不同：升级**不是**终态工具。它不结束 turn，也不排斥兄弟工具——
    // 停驻的是这一次调用，不是整个 actor。
    concurrentSafe: true,
    maxOutputBytes: MAX_ESCALATE_MODEL_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: escalateHandler,
  formatModelContent: formatEscalateModelContent,
  inputSchema: EscalateInputJsonSchema,
  outputSchema: EscalateOutputJsonSchema,
  runtimeInputSchema: EscalateInputSchema,
  runtimeOutputSchema: EscalateOutputSchema,
  permission: {
    permission: "workflow.escalate",
    reason: "escalate asks the main agent a blocking question from inside a workflow run",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_ESCALATE_MODEL_BYTES,
    maxModelBytes: MAX_ESCALATE_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: MAX_ESCALATE_MODEL_BYTES,
      direction: "head",
    },
  },
  // 等待可能任意长（按设计不设超时——「超时后自行判断」恰恰重新引入投机绕过）。逃生舱是
  // 既有的取消：driver 的 cancelAsk 会连同停驻中的升级 deferred 一起拒绝。
  timeout: {
    kind: "none",
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "escalate was cancelled before the main agent answered",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

/** 模型只读到一段文本：答案本身，或拒绝的文案。判别位不进模型面。 */
function formatEscalateModelContent(output: unknown): string {
  const parsed = EscalateOutputSchema.safeParse(output);
  if (!parsed.success) return "escalate returned an invalid result.";
  return parsed.data.message;
}

function resolveToolTraceContext(context: Parameters<ToolHandler>[1]): TraceContext {
  return (
    context.traceContext ?? {
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: context.parentSpanId,
      sessionId: context.sessionId,
      turnId: context.turnId,
    }
  );
}
