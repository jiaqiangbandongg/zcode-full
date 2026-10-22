// ============================================================
// ListSavedWorkflows Tool Handler
// ============================================================
// 枚举本项目（= 会话工作目录）保存的 dwf 定义。
//
// 与 ListWorkflowRuns 是**两件事**，且两个描述都要把这件事说穿：那个列的是跑过的 run
// （历史、有状态、有 runId），这个列的是可以拿来跑的定义（清单、无状态、有名字）。模型最
// 容易犯的错就是把「有哪些工作流可用」问成「有哪些工作流跑过」，然后回答用户"你没有任何
// 工作流"——而项目里其实存着五个。

import {
  LIST_SAVED_WORKFLOWS_TOOL_NAME,
  ListSavedWorkflowsInputJsonSchema,
  ListSavedWorkflowsInputSchema,
  ListSavedWorkflowsOutputJsonSchema,
  ListSavedWorkflowsOutputSchema,
  SAVED_WORKFLOW_PROJECT_DIR,
  type ListSavedWorkflowsOutput,
  type ModelMessageContent,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";
import { listSavedWorkflows } from "./saved-workflows/index.js";

const LIST_SAVED_WORKFLOWS_TIMEOUT_MS = 10_000;
/** 照 ListWorkflowRuns：清单刻意轻（一次目录扫描可答），24k 足够几十条还留着余量。 */
const LIST_SAVED_WORKFLOWS_MODEL_BYTES = 24_000;

const LIST_SAVED_WORKFLOWS_DESCRIPTION = [
  `Lists the dynamic workflows saved in this project (\`${SAVED_WORKFLOW_PROJECT_DIR}/\`, keyed on the session's working directory) and the global archive (\`~/.zcode/workflows\`, available from every project). These are workflow DEFINITIONS you can run, not past runs — for the run history use ListWorkflowRuns instead.`,
  "",
  "- Each row gives the name, what the workflow does, when to reach for it, and the arguments it takes.",
  "- Run one by passing its name to CreateWorkflow as `saved: { name, args }`. The user still confirms the run.",
  "- Check here before writing a workflow from scratch: if the project already saved one that fits, running it beats rebuilding it.",
  "- `invalid` lists saved files that could not be read (usually a hand-edited metadata block). They are named so they can be fixed, not silently skipped.",
].join("\n");

const listSavedWorkflowsHandler: ToolHandler = async (input, context) => {
  ListSavedWorkflowsInputSchema.parse(input);

  // cwd 恒取本会话的工作目录：模型无权跨项目扫盘，这同时是 `sideEffectScope: "none"` 的前提。
  const { entries, invalid } = listSavedWorkflows({ cwd: context.workingDirectory ?? "." });

  return {
    workflows: entries,
    // 为空时缺席：一个空数组会给每次调用挂一个噪音字段。
    ...(invalid.length > 0 ? { invalid } : {}),
  } satisfies ListSavedWorkflowsOutput;
};

/**
 * 模型面：一个 XML-ish 容器 + 一 workflow 一块。
 *
 * 与 ListWorkflowRuns 的**单行**属性式刻意不同：run 是低信息密度的高基数实体（50 行都长
 * 一个样，属性挤一行正好），而一个保存的 workflow 带着描述、使用时机和参数表——这些是模型
 * 用来**选**工作流的依据，挤成一行会把选择所需的信息压没。条数也低得多（一个项目里几个到
 * 几十个），撑得起每条几行。
 */
function formatListSavedWorkflowsModelContent(output: unknown): ModelMessageContent {
  const parsed = ListSavedWorkflowsOutputSchema.safeParse(output);
  if (!parsed.success) return "ListSavedWorkflows returned an invalid result.";

  const { workflows, invalid } = parsed.data;

  if (workflows.length === 0 && invalid === undefined) {
    // 「这个项目没存过 workflow」必须说成一句话：空容器容易被读成「工具没答上来」。
    return [
      '<saved_workflows count="0">',
      `No workflows are saved in this project yet. Saved definitions live in ${SAVED_WORKFLOW_PROJECT_DIR}/.`,
      "</saved_workflows>",
    ].join("\n");
  }

  const blocks = workflows.map((workflow) => {
    const lines = [
      `<workflow name="${escapeAttribute(workflow.name)}" scope="${workflow.scope}">`,
      `  ${workflow.description}`,
    ];
    if (workflow.whenToUse !== undefined) lines.push(`  When to use: ${workflow.whenToUse}`);
    for (const [key, spec] of Object.entries(workflow.args ?? {})) {
      const notes = [
        spec.type,
        spec.required === true ? "required" : undefined,
        spec.default === undefined ? undefined : `default ${JSON.stringify(spec.default)}`,
      ].filter((note) => note !== undefined);
      const description = spec.description === undefined ? "" : ` — ${spec.description}`;
      lines.push(`  arg ${key} (${notes.join(", ")})${description}`);
    }
    lines.push("</workflow>");
    return lines.join("\n");
  });

  const invalidLines = (invalid ?? []).map(
    (entry) => `<invalid path="${escapeAttribute(entry.path)}">${entry.reason}</invalid>`,
  );

  return [
    `<saved_workflows count="${workflows.length}">`,
    ...blocks,
    ...invalidLines,
    "</saved_workflows>",
  ].join("\n");
}

/** 名字与路径进属性位：两者都可能带引号（路径尤其），不转义会造出畸形标签。 */
function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

export const listSavedWorkflowsToolEntry: ToolEntry = {
  capability: "List the reusable dynamic-workflow definitions saved in this project",
  metadata: {
    shouldDefer: true,
    name: LIST_SAVED_WORKFLOWS_TOOL_NAME,
    description: LIST_SAVED_WORKFLOWS_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: LIST_SAVED_WORKFLOWS_TIMEOUT_MS,
    maxOutputBytes: LIST_SAVED_WORKFLOWS_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: listSavedWorkflowsHandler,
  inputSchema: ListSavedWorkflowsInputJsonSchema,
  outputSchema: ListSavedWorkflowsOutputJsonSchema,
  runtimeInputSchema: ListSavedWorkflowsInputSchema,
  runtimeOutputSchema: ListSavedWorkflowsOutputSchema,
  formatModelContent: formatListSavedWorkflowsModelContent,
  permission: {
    permission: "listSavedWorkflows",
    reason: "ListSavedWorkflows reads the saved workflow definitions of the current project",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    // 输入里没有路径主体（cwd 来自会话上下文），所以模式只按工具名匹配。
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
    // 刻意**不**继承 SaveWorkflow / CreateWorkflow 的 alwaysAsk：那两道 gate 的理由分别是
    // 「写用户的仓库」与「执行整块代码」，读清单不属于任何一条。
  },
  resultBudget: {
    maxInlineBytes: LIST_SAVED_WORKFLOWS_MODEL_BYTES,
    maxModelBytes: LIST_SAVED_WORKFLOWS_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: LIST_SAVED_WORKFLOWS_MODEL_BYTES,
      direction: "head",
    },
  },
  timeout: {
    kind: "timed",
    defaultMs: LIST_SAVED_WORKFLOWS_TIMEOUT_MS,
    maxMs: LIST_SAVED_WORKFLOWS_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: false,
    cleanup: "none",
    userVisibleMessage:
      "ListSavedWorkflows scans the project's workflow directory synchronously and cannot be cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
