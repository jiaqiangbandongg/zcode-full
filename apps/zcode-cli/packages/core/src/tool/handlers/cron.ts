// ============================================================
// Cron Tool Handlers
// ============================================================

import {
  CoreErrorType,
  CronCreateInputJsonSchema,
  CronCreateInputSchema,
  CronCreateOutputJsonSchema,
  CronCreateOutputSchema,
  CronDeleteInputJsonSchema,
  CronDeleteInputSchema,
  CronDeleteOutputJsonSchema,
  CronDeleteOutputSchema,
  CronListInputJsonSchema,
  CronListInputSchema,
  CronListOutputJsonSchema,
  CronListOutputSchema,
  CronUpdateInputJsonSchema,
  CronUpdateInputSchema,
  CronUpdateOutputJsonSchema,
  CronUpdateOutputSchema,
  createCoreError,
  type CronAutomation,
  type CronCreateInput,
  type CronCreateOutput,
  type CronDeleteInput,
  type CronDeleteOutput,
  type CronListOutput,
  type CronUpdateInput,
  type CronUpdateOutput,
  type ToolPermissionSpec,
} from "@zcode/contracts";
import type { ToolEntry, ToolExecutionContext, ToolHandler } from "../types.js";

const CRON_TOOL_TIMEOUT_MS = 30_000;
const CRON_MODEL_BYTES = 32_000;

function assertNotAutomationTurn(
  context: ToolExecutionContext,
  toolName: "CronCreate" | "CronUpdate" | "CronDelete",
): void {
  if (!context.automationTurn) return;
  // provider tool denylist 只是可见性约束，旧入口或异常 provider 仍可能直接提交
  // automation 写工具。handler 必须以 executor 传入的本轮事实做最终拒绝，且不能调用端口。
  throw createCoreError(
    CoreErrorType.PermissionDenied,
    `${toolName} is not allowed while running a scheduled automation.`,
    {
      context: {
        toolCallId: context.toolCallId,
        toolName,
      },
      recoverable: false,
      retryable: false,
    },
  );
}

function assertAutomationPort(
  context: ToolExecutionContext,
  toolName: "CronCreate" | "CronList" | "CronUpdate" | "CronDelete",
): asserts context is ToolExecutionContext & {
  automationPort: NonNullable<ToolExecutionContext["automationPort"]>;
} {
  if (context.automationPort) return;
  throw createCoreError(
    CoreErrorType.ConfigurationError,
    `AutomationPort is not configured for ${toolName}`,
    {
      context: {
        toolCallId: context.toolCallId,
        toolName,
      },
      recoverable: false,
    },
  );
}

function toModelAutomation(automation: CronAutomation): CronAutomation {
  return {
    automationId: automation.automationId,
    title: automation.title,
    cronExpr: automation.cronExpr,
    prompt: automation.prompt,
    enabled: automation.enabled,
    lifecycleStatus: automation.lifecycleStatus,
    nextRunAt: automation.nextRunAt,
    lastRunAt: automation.lastRunAt,
    runCount: automation.runCount,
    recurring: automation.recurring,
    maxRuns: automation.maxRuns,
    // 工具输出曾在此处重新投影 automation 时遗漏 scheduleRule，导致 CronCreate /
    // CronUpdate / CronList 虽收到真实间隔仍只展示兼容 cron，错误显示成每小时或每天。
    scheduleRule: automation.scheduleRule,
  };
}

export const cronCreateHandler: ToolHandler = async (input, context) => {
  assertNotAutomationTurn(context, "CronCreate");
  const parsed = CronCreateInputSchema.parse(input) as CronCreateInput;
  assertAutomationPort(context, "CronCreate");

  const automation = await context.automationPort.create(parsed, {
    // 会话内创建定时任务时模型来自当前 runtime，而不是模型可控的工具入参。
    ...(context.model ? { model: `${context.model.providerId}/${context.model.modelId}` } : {}),
    // 会话内创建的 cron 固定复用当前 session，后续触发不再新建 session。
    sessionId: context.sessionId,
  });
  return {
    automation: toModelAutomation(automation),
    message: `Created automation ${automation.automationId}.`,
  } satisfies CronCreateOutput;
};

export const cronListHandler: ToolHandler = async (input, context) => {
  CronListInputSchema.parse(input);
  assertAutomationPort(context, "CronList");

  const automations = await context.automationPort.list();
  return {
    automations: automations.map(toModelAutomation),
  } satisfies CronListOutput;
};

export const cronUpdateHandler: ToolHandler = async (input, context) => {
  assertNotAutomationTurn(context, "CronUpdate");
  const parsed = CronUpdateInputSchema.parse(input) as CronUpdateInput;
  assertAutomationPort(context, "CronUpdate");

  const automation = await context.automationPort.update(parsed);
  return {
    automation: toModelAutomation(automation),
    message: `Updated automation ${automation.automationId}.`,
  } satisfies CronUpdateOutput;
};

export const cronDeleteHandler: ToolHandler = async (input, context) => {
  assertNotAutomationTurn(context, "CronDelete");
  const parsed = CronDeleteInputSchema.parse(input) as CronDeleteInput;
  assertAutomationPort(context, "CronDelete");

  const deleted = await context.automationPort.delete(parsed);
  return {
    deleted,
    id: parsed.id,
    message: deleted
      ? `Deleted automation ${parsed.id}.`
      : `Automation ${parsed.id} was not found in the current workspace.`,
  } satisfies CronDeleteOutput;
};

function cronPermission(
  permission: string,
  reason: string,
  needsApproval: boolean,
): ToolPermissionSpec {
  return {
    permission,
    reason,
    riskLevel: "medium" as const,
    sideEffectScope: "workspace" as const,
    needsApproval,
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: needsApproval ? undefined : ["toolName"],
    denyPriority: "beforeAsk" as const,
  };
}

const cronResultBudget = {
  maxInlineBytes: CRON_MODEL_BYTES,
  maxModelBytes: CRON_MODEL_BYTES,
  strategy: "truncate" as const,
  preview: {
    maxBytes: CRON_MODEL_BYTES,
    direction: "head" as const,
  },
};

const cronTimeout = {
  defaultMs: CRON_TOOL_TIMEOUT_MS,
  maxMs: CRON_TOOL_TIMEOUT_MS,
  allowCallOverride: false,
};

export const cronCreateToolEntry: ToolEntry = {
  capability: "Create a scheduled automation for the current workspace",
  metadata: {
    name: "CronCreate",
    // 二阶调度要求应在工具 contract 中直接约束模型；自然语言不能靠关键词或正则可靠判定，
    // automation 执行轮的 mutation tool denylist 才是阻止递归修改任务定义的权限边界。
    description:
      "Create a persistent scheduled automation in the current workspace. It uses the host's real current clock for relative delayMinutes schedules, or a standard 5-field cron expression in the user's local timezone for absolute/recurring schedules, and survives app restarts. The prompt must describe the final scheduled work directly and must never ask the run to create, schedule, or configure another automation or call CronCreate.",
    modelInstructions: [
      "Use this only when the user explicitly asks to schedule future automatic work.",
      "Interpret cron in the user's local timezone using fields: minute hour day-of-month month day-of-week. Do not convert to UTC.",
      // '8分钟后上课提醒' 既是相对延迟又是一次性提醒；旧指令里“一次性提醒就 pin
      // 绝对月日时分”的措辞覆盖了相对延迟规则，模型据此自算出 '29 7 29 7 *' 这类固定日历 cron。
      // 模型对“现在”的时刻常是陈旧的，自算的一次性时刻一旦刚过去就被 host 静默滚到下一年。
      // 修复：任何“从现在起 N 后”的表达（含小时、中英文）一律走 delayMinutes；pin 绝对 cron 只
      // 用于用户明确点名的墙钟日期，且显式声明相对一次性必须改用 delayMinutes。
      "For any schedule expressed as a delay from now — 'in 3 minutes' sets delayMinutes=3, '8分钟后' sets delayMinutes=8, 'in 2 hours' sets delayMinutes=120, 'later'/'稍后' — set delayMinutes to the total whole minutes, omit cron, set recurring=false, and omit maxRuns. The host anchors to its real current clock; never infer the current time or convert a relative delay into a cron or clock time yourself.",
      "Use '*/20 * * * *' for every 20 minutes, '0 * * * *' for hourly, and '0 9 * * 1-5' for weekdays at 09:00.",
      // 只用 cron 表达“每 N 单位”会受字段上限影响，且即使 N 未越界也会变成墙钟对齐，
      // 与 UI 自定义重复从保存时刻锚定的语义不一致。所有每 N 单位统一用 carrier + scheduleRule。
      "For every N minutes/hours/days/weeks/months/years, always set intervalUnit (minute|hourly|daily|weekly|monthly|yearly) and interval together. interval must be an integer from 1 to 200, including values cron could express directly. Supply a legal 5-field compatible cron only for time-of-day/day/weekday/month slots; never put an out-of-range step in cron. Examples: every 20 minutes -> intervalUnit='minute', interval=20, cron='* * * * *'; every 31 hours at minute 49 -> intervalUnit='hourly', interval=31, cron='49 * * * *'; every 40 days at 09:00 -> intervalUnit='daily', interval=40, cron='0 9 * * *'. Omit intervalUnit/interval only for ordinary calendar cron schedules, such as weekdays at 09:00.",
      "Pin minute, hour, day-of-month, and month in cron only for an absolute wall-clock date the user names outright, such as 'tomorrow at 9am' or 'on July 30 at 20:00'; set recurring=false and omit maxRuns (the default limit is 1). A relative one-shot such as '8分钟后' or 'in 2 hours' must use delayMinutes instead, because a self-computed one-shot time that has just passed silently rolls a full year forward.",
      "For exactly N scheduled runs, set recurring=false and maxRuns=N. recurring=true is indefinite and must not be combined with maxRuns.",
      "Automations persist in the current workspace until the user deletes them. Finite automations become completed and retain their history; they are not session-only or auto-deleted.",
      "Honor exact user-provided times without adding jitter or shifting the schedule.",
      "Do not include workspace paths or identities in the input; the current session workspace is used.",
      "Always set title and preserve the user's natural-language schedule phrase verbatim in it. The title may be concise, but must not omit timing such as '每20分钟', '每天早上9点', or 'every Friday'.",
      "Write prompt as a complete instruction that can run later without relying on unstated conversation context.",
      "Write the final work directly in prompt. Never ask the scheduled run to create, schedule, or configure another automation, and never ask it to call CronCreate.",
    ],
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: CRON_TOOL_TIMEOUT_MS,
    maxOutputBytes: CRON_MODEL_BYTES,
    sideEffectScope: "workspace",
    riskLevel: "medium",
    needsApproval: true,
  },
  handler: cronCreateHandler,
  inputSchema: CronCreateInputJsonSchema,
  outputSchema: CronCreateOutputJsonSchema,
  runtimeInputSchema: CronCreateInputSchema,
  runtimeOutputSchema: CronCreateOutputSchema,
  permission: cronPermission(
    "automation.create",
    "CronCreate creates a scheduled background automation for this workspace",
    true,
  ),
  resultBudget: cronResultBudget,
  timeout: cronTimeout,
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "CronCreate was cancelled before the automation was created",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

export const cronListToolEntry: ToolEntry = {
  capability: "List scheduled automations for the current workspace",
  metadata: {
    name: "CronList",
    description: "List scheduled automations in the current workspace.",
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: CRON_TOOL_TIMEOUT_MS,
    maxOutputBytes: CRON_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: cronListHandler,
  inputSchema: CronListInputJsonSchema,
  outputSchema: CronListOutputJsonSchema,
  runtimeInputSchema: CronListInputSchema,
  runtimeOutputSchema: CronListOutputSchema,
  permission: {
    permission: "automation.read",
    reason: "CronList only reads scheduled automations for this workspace",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: cronResultBudget,
  timeout: cronTimeout,
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "CronList was cancelled before automations were returned",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

export const cronUpdateToolEntry: ToolEntry = {
  capability: "Update a scheduled automation in the current workspace",
  metadata: {
    name: "CronUpdate",
    description:
      "Update selected definition fields of an existing scheduled automation in the current workspace while preserving its id and run history.",
    modelInstructions: [
      "Use CronList first when the automation id is not already known. Never guess an automation id.",
      "Always pass title on every CronUpdate. Rewrite it so it describes the task after the update and keeps the user's natural-language schedule phrase consistent with cron; for example, changing every 5 minutes to every 6 minutes must also update the title.",
      "Apart from the required synchronized title, only pass fields the user asked to change. Omitted fields preserve their existing values.",
      "Interpret cron in the user's local timezone using five fields: minute hour day-of-month month day-of-week. Do not convert to UTC.",
      // 更新“每 N 单位”时同样必须使用 carrier；否则小间隔会退化为墙钟 cron，长间隔会生成非法 cron。
      "To create or change every N minutes/hours/days/weeks/months/years, pass intervalUnit and interval together for every N-unit schedule. interval must be an integer from 1 to 200 even when cron could express N. Also pass a legal compatible cron with only the time/day/weekday/month slot; for example, every 40 days at 09:00 uses intervalUnit='daily', interval=40, cron='0 9 * * *'. Omit the pair only when preserving or using an ordinary calendar cron schedule.",
      "Use numeric maxRuns only with recurring=false. Setting recurring=true clears any old finite limit automatically; never combine recurring=true with a numeric maxRuns.",
      "CronUpdate cannot change workspace, session binding, model, provider, mode, thought level, run count, history, or enabled state.",
      "Do not simulate an update by deleting and recreating the automation.",
      "After a successful update, reply with only a brief confirmation. Do not restate the automation fields in a fenced code block or simulate a text file because the UI renders the updated automation card.",
    ],
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: CRON_TOOL_TIMEOUT_MS,
    maxOutputBytes: CRON_MODEL_BYTES,
    sideEffectScope: "workspace",
    riskLevel: "medium",
    needsApproval: true,
  },
  handler: cronUpdateHandler,
  inputSchema: CronUpdateInputJsonSchema,
  outputSchema: CronUpdateOutputJsonSchema,
  runtimeInputSchema: CronUpdateInputSchema,
  runtimeOutputSchema: CronUpdateOutputSchema,
  permission: cronPermission(
    "automation.update",
    "CronUpdate changes a scheduled background automation in this workspace",
    true,
  ),
  resultBudget: cronResultBudget,
  timeout: cronTimeout,
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "CronUpdate was cancelled before the automation was updated",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

export const cronDeleteToolEntry: ToolEntry = {
  capability: "Delete a scheduled automation from the current workspace",
  metadata: {
    name: "CronDelete",
    description: "Delete a scheduled automation from the current workspace by automation id.",
    readOnly: false,
    destructive: true,
    concurrentSafe: false,
    timeoutMs: CRON_TOOL_TIMEOUT_MS,
    maxOutputBytes: CRON_MODEL_BYTES,
    sideEffectScope: "workspace",
    riskLevel: "medium",
    needsApproval: true,
  },
  handler: cronDeleteHandler,
  inputSchema: CronDeleteInputJsonSchema,
  outputSchema: CronDeleteOutputJsonSchema,
  runtimeInputSchema: CronDeleteInputSchema,
  runtimeOutputSchema: CronDeleteOutputSchema,
  permission: cronPermission(
    "automation.delete",
    "CronDelete removes a scheduled background automation from this workspace",
    true,
  ),
  resultBudget: cronResultBudget,
  timeout: cronTimeout,
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "CronDelete was cancelled before the automation was deleted",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
