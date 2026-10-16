// ============================================================
// FillWorkflowHole Tool Handler
// ============================================================
// docs/dynamic-workflow/launch.md「The `FillWorkflowHole` tool」；引擎侧见
// apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Holes」。
//
// 一个正在跑的 run 到达一处留白就停下那一支、发一条留白通知；这个工具是模型还它代码的地方。它**什么
// 都不启动**：拼接、编译、站点稳定性检查、引擎放行与草稿改写全在端口实现侧（`port.fillHole`），这里
// 做的是 handler 该做的四件事——把内联函数体先写进 fill 文件（编译结果读出来**之前**）、调端口、
// 把诊断锚到它落在的那个文件、成功时用有效脚本铸 display（与 CreateWorkflow 同一条投影路径）。
// 确认之前的一切（run / 留白 / 归属 / 函数体字节）在 fill-workflow-hole-resolve.ts。

import path from "node:path";
import {
  FILL_WORKFLOW_HOLE_TOOL_NAME,
  FillWorkflowHoleInputJsonSchema,
  FillWorkflowHoleInputSchema,
  FillWorkflowHoleOutputJsonSchema,
  FillWorkflowHoleOutputSchema,
  SAVED_WORKFLOW_FILE_EXTENSION,
  type CreateWorkflowDiagnostic,
  type CreateWorkflowOutput,
  type DynamicWorkflowRunFillHoleDiagnostic,
  type DynamicWorkflowRunPort,
  type FillWorkflowHoleInput,
  type ModelMessageContent,
} from "@zcode/contracts";
import type {
  ToolApprovalGate,
  ToolEntry,
  ToolExecutionContext,
  ToolHandler,
  ToolHandlerFailure,
} from "../types.js";
import { resolveTraceContext } from "./create-workflow.js";
import { FILL_WORKFLOW_HOLE_TOOL_DESCRIPTION } from "./fill-workflow-hole-description.js";
import {
  FILL_WORKFLOW_HOLE_ERROR_CODE,
  rememberRejectedFill,
  resolveFillWorkflowHoleInput,
  takeFillPreview,
  validateFillWorkflowHoleSource,
} from "./fill-workflow-hole-resolve.js";
import { boundGraphOfAnalysis, displayOfAnalysis } from "./workflow-analysis-display.js";
import { recordAuthoredWorkflowDraft } from "./workflow-draft-read-state.js";
import { workflowDraftSlug, writeWorkflowDraft } from "./workflow-drafts.js";
import { workflowRunNotFoundFailure } from "./workflow-run-introspection.js";
import { analyzeScript } from "./workflow-script-analysis.js";
import { allScriptModelsBound } from "./workflow-script-models.js";
import { describeWorkflowScriptPath } from "./workflow-script-path.js";
import { requireDynamicWorkflowSkill } from "./workflow-skill-gate.js";

export { FILL_WORKFLOW_HOLE_ERROR_CODE } from "./fill-workflow-hole-resolve.js";

const FILL_WORKFLOW_HOLE_TIMEOUT_MS = 15_000;
const FILL_WORKFLOW_HOLE_MODEL_BYTES = 24_000;

/**
 * 「本会话不能补全留白」。端口缺席（journal 不可用 → run service 整个不构造）与方法缺席（老宿主）
 * 回同一个失败：对模型这是同一件事。绝不静默成功——那会让一支脚本永远停在留白处。
 */
function fillUnavailableFailure(): ToolHandlerFailure {
  return {
    result: false,
    errorCode: FILL_WORKFLOW_HOLE_ERROR_CODE.FILL_UNAVAILABLE,
    message:
      "workflow_fill_unavailable: this session cannot fill workflow holes — workflow execution is not available here. This is a capability gap, not a bad hole id.",
  };
}

/** 端口的非诊断拒绝 → 各配稳定错误码；message 原样来自端口（它说的就是模型的下一步）。 */
function fillRefusalFor(reason: string, message: string, runId: string): ToolHandlerFailure {
  switch (reason) {
    case "run_not_found":
      return workflowRunNotFoundFailure(runId);
    case "hole_not_waiting":
      return {
        result: false,
        errorCode: FILL_WORKFLOW_HOLE_ERROR_CODE.HOLE_NOT_WAITING,
        message: `hole_not_waiting: ${message}`,
      };
    case "fill_ids_unstable":
      // 宿主故障，不是模型的错：留白照旧在等，函数体不必改。
      return {
        result: false,
        errorCode: FILL_WORKFLOW_HOLE_ERROR_CODE.IDS_UNSTABLE,
        message: `fill_ids_unstable: ${message} This is a host fault, not a problem with your body: the hole is still waiting. Report it to the user rather than rewriting the body.`,
      };
    default:
      return {
        result: false,
        errorCode: FILL_WORKFLOW_HOLE_ERROR_CODE.HOLE_NOT_WAITING,
        message: `workflow_fill_refused: ${message} (reason: ${reason})`,
      };
  }
}

/** fill 文件的模型面身份：内联提交刚写下的（「saved at」）或模型自己给的（「The fill file is」）。 */
interface FillFileLocation {
  kind: "draft" | "path";
  described: string;
}

/**
 * 内联函数体的 fill 文件：`<slug>.<hole-slug>.dwf.ts`（docs/dynamic-workflow/launch.md「The fill file」）。
 * `<slug>` 是 run 草稿的主干（草稿文件名去掉扩展名），run 没记过草稿时取 run 名；`<hole-slug>` 是
 * 留白名走同一条铸名规则。同名顺延 `-2`、`-3`… 由 writeWorkflowDraft 负责：一次内联重提铸新文件，
 * 绝不在模型背后覆盖。写不成回 `undefined`（尽力而为，与草稿同规）。
 */
async function writeFillFile(
  parsed: FillWorkflowHoleInput,
  body: string,
  port: DynamicWorkflowRunPort,
  cwd: string | undefined,
): Promise<string | undefined> {
  const draftPath = parsed.hole?.draft_path;
  let runSlug: string;
  if (draftPath !== undefined) {
    runSlug = path.basename(draftPath, SAVED_WORKFLOW_FILE_EXTENSION);
  } else {
    const snapshot = await port.getTask(parsed.run_id).catch(() => undefined);
    runSlug = workflowDraftSlug(snapshot?.name ?? snapshot?.description ?? "workflow");
  }
  const holeSlug = workflowDraftSlug(parsed.hole?.name ?? parsed.hole_id);
  const written = await writeWorkflowDraft({ cwd, name: `${runSlug}.${holeSlug}`, source: body });
  return written?.path;
}

/**
 * 诊断行：`{path}:L{line}:C{column} {message}`，锚到**它落在的文件**——函数体内的（`inFill`）按 fill
 * 文件的行，函数体外的（如 9005 的另一处在父脚本里）按 run 草稿的行与路径，因为那才是它指着的代码。
 * 没有可锚的文件时退回 `L:C`。
 */
function formatFillDiagnosticLines(
  diagnostics: readonly DynamicWorkflowRunFillHoleDiagnostic[],
  fillFile: string | undefined,
  draftFile: string | undefined,
): string[] {
  return diagnostics.map((diagnostic) => {
    const anchor = diagnostic.inFill ? fillFile : draftFile;
    const where = `L${diagnostic.line}:C${diagnostic.column}`;
    return `${anchor === undefined ? where : `${anchor}:${where}`} ${diagnostic.message}`;
  });
}

/**
 * 输出里的 `fill` 块：行给自己起名的唯一来源（docs/dynamic-workflow/presentation.md「The fill row」）。
 * transcript 只存模型自己的入参，resolveInput 回填的 `hole` 到不了行，所以名字必须随输出走；
 * `hole` 缺席（端口 stub、绕过归一化的调用方）时退回站点 id，行至少有 id 可写。
 */
function fillBlock(parsed: FillWorkflowHoleInput): NonNullable<CreateWorkflowOutput["fill"]> {
  const hole = parsed.hole;
  return {
    siteId: parsed.hole_id,
    name: hole?.name ?? parsed.hole_id,
    ...(hole?.draft_path === undefined ? {} : { draftPath: hole.draft_path }),
    ...(hole?.line === undefined ? {} : { line: hole.line }),
  };
}

function compileFailureResponse(
  parsed: FillWorkflowHoleInput,
  diagnostics: readonly DynamicWorkflowRunFillHoleDiagnostic[],
  fillFile: FillFileLocation | undefined,
  cwd: string | undefined,
): string {
  const lead =
    fillFile === undefined
      ? "The fill could not be saved to a file; fix the body below and resubmit it inline."
      : fillFile.kind === "draft"
        ? `The fill is saved at ${fillFile.described}. Edit that file in place and resubmit with \`path\`; do not paste it inline again.`
        : `The fill file is ${fillFile.described}. Edit that file in place and resubmit with \`path\`.`;
  const draftFile =
    parsed.hole?.draft_path === undefined
      ? undefined
      : describeWorkflowScriptPath(parsed.hole.draft_path, cwd ?? "");
  // 落在函数体之外的诊断指着 run **记录在案**的脚本：这个工具改不了它，磁盘上的草稿改了也不算数
  // （2026-09-28 首次实测：主代理把草稿改好又重提，拿到逐字相同的诊断，才猜到要 AmendWorkflow）。
  // 所以这里直接把出路写明，省掉那一轮猜。
  const outsideFill = diagnostics.some((diagnostic) => diagnostic.inFill !== true);
  const recordedScriptNote = outsideFill
    ? `The lines outside the fill are in the run's recorded script${draftFile === undefined ? "" : ` (${draftFile} as the run launched it)`}: this tool cannot change them, and editing the draft on disk does not change what the fill is compiled into. Fix them with AmendWorkflow (pass the corrected script, or its \`path\`); the revised run will reach the hole and ask again.`
    : undefined;
  return [
    lead,
    "The effective script does not compile:",
    ...formatFillDiagnosticLines(diagnostics, fillFile?.described, draftFile),
    ...(recordedScriptNote === undefined ? [] : [recordedScriptNote]),
    "",
    `NOTE: Nothing was spliced or journaled — hole ${parsed.hole_id} of run ${parsed.run_id} is still waiting for its body.`,
  ].join("\n");
}

const fillWorkflowHoleHandler: ToolHandler = async (input, context: ToolExecutionContext) => {
  const parsed = FillWorkflowHoleInputSchema.parse(input) as FillWorkflowHoleInput;
  const port = context.dynamicWorkflowRunPort;
  if (port === undefined || typeof port.fillHole !== "function") return fillUnavailableFailure();
  // resolveInput 恒把函数体落定进 `script`（`path` 读成字节）；到这里还缺，只可能是绕过归一化的调用方。
  const body = parsed.script;
  if (body === undefined) {
    return {
      result: false,
      errorCode: FILL_WORKFLOW_HOLE_ERROR_CODE.BODY_UNAVAILABLE,
      message:
        "workflow_fill_body_unavailable: the call reached the handler without a resolved body. Pass `script` or `path`. Nothing was filled.",
    } satisfies ToolHandlerFailure;
  }
  const cwd = context.workingDirectory;

  // 内联函数体**先**落盘，再读编译结果（docs/dynamic-workflow/launch.md「The fill file」）：编不过的
  // 函数体走不到别处，这里是它唯一必经的地方。`path` 提交什么都不铸——那个文件已经是工作副本。
  let fillFile: FillFileLocation | undefined;
  if (parsed.path === undefined) {
    const written = await writeFillFile(parsed, body, port, cwd);
    if (written !== undefined) {
      fillFile = { kind: "draft", described: describeWorkflowScriptPath(written, cwd ?? "") };
      // 这份字节就是模型本次的 `script`：记作它写过的文件，下一次 Edit 不必先 Read。
      await recordAuthoredWorkflowDraft(context, {
        path: written,
        source: body,
        toolName: "FillWorkflowHole",
      });
    }
  } else {
    fillFile = { kind: "path", described: describeWorkflowScriptPath(parsed.path, cwd ?? "") };
  }

  const result = await port.fillHole({
    runId: parsed.run_id,
    holeId: parsed.hole_id,
    body,
    parentSessionId: context.sessionId,
    toolCallId: context.toolCallId,
    trace: resolveTraceContext(context),
  });

  if (!result.ok) {
    if (result.reason !== "compile_failed") {
      return fillRefusalFor(result.reason, result.message, parsed.run_id);
    }
    // 记下这份被拒的字节：同一份再经 `path` 交回来就是忘了编辑（`fill_unchanged`）。
    rememberRejectedFill(context.sessionId, parsed.run_id, parsed.hole_id, body);
    const diagnostics = result.diagnostics ?? [];
    return {
      fill: fillBlock(parsed),
      diagnostics: diagnostics.map(
        (diagnostic): CreateWorkflowDiagnostic => ({
          code: diagnostic.code,
          column: diagnostic.column,
          line: diagnostic.line,
          message: diagnostic.message,
        }),
      ),
      ok: false,
      response: compileFailureResponse(parsed, diagnostics, fillFile, cwd),
    } satisfies CreateWorkflowOutput;
  }

  // 成功：display 铸自端口交回的**有效脚本**（已拼入函数体、已落库的那一份），走 CreateWorkflow 的同一条
  // 投影路径，run 卡取它 run id 下最新的 display（docs/dynamic-workflow/presentation.md「Holes on the timeline」）。
  const analysis = analyzeScript(result.scriptText);
  const causalityGraph = boundGraphOfAnalysis(analysis);
  const holeName = parsed.hole?.name ?? parsed.hole_id;
  const phases =
    result.phasesAdded.length === 0
      ? "It added no phases."
      : `It added the phase${result.phasesAdded.length === 1 ? "" : "s"} ${result.phasesAdded.join(", ")}.`;
  const draft =
    result.scriptPath === undefined
      ? "The run has no draft file, so a later revision must pass the whole script to AmendWorkflow."
      : `The run's draft ${describeWorkflowScriptPath(result.scriptPath, cwd ?? "")} now holds the effective script: edit that file and pass \`path\` to AmendWorkflow for any later revision.`;
  return {
    fill: fillBlock(parsed),
    diagnostics: [],
    ok: true,
    response: `The fill joined run ${parsed.run_id} at hole "${holeName}" (${parsed.hole_id}); the branch parked there has resumed and the run keeps going in the background. ${phases} ${draft} Do not wait for the run or poll it with TaskOutput; you will be notified when it completes.`,
    ...(causalityGraph === undefined ? {} : { causalityGraph }),
  } satisfies CreateWorkflowOutput;
};

/**
 * 确认窗预览：有效脚本的图（resolveInput 拼好、记在单槽里的那份）。拼不出来窗照开、只是没图；
 * 有效脚本编不过、或点名了 run 绑定表之外的模型，则放行给 handler——端口会回诊断（后者是 9011），
 * 一个注定作废的窗没有意义（与 AmendWorkflow、CreateWorkflow 同规）。
 */
function prepareFillWorkflowHoleApproval(input: unknown): ToolApprovalGate {
  const parsed = FillWorkflowHoleInputSchema.safeParse(input);
  if (!parsed.success || parsed.data.script === undefined) return { gate: "ask" };
  const preview = takeFillPreview(parsed.data.run_id, parsed.data.hole_id, parsed.data.script);
  if (preview === undefined) return { gate: "ask" };
  const analysis = analyzeScript(preview.effectiveScript);
  if (!analysis.ok || !allScriptModelsBound(analysis, preview.modelBindings)) {
    return { gate: "proceed" };
  }
  const display = displayOfAnalysis(analysis, FILL_WORKFLOW_HOLE_TOOL_NAME);
  return { gate: "ask", ...(display ? { display } : {}) };
}

export const fillWorkflowHoleToolEntry: ToolEntry = {
  capability:
    "Supply the body of a hole a running dynamic-workflow run is waiting at, so the parked branch resumes",
  metadata: {
    name: FILL_WORKFLOW_HOLE_TOOL_NAME,
    description: FILL_WORKFLOW_HOLE_TOOL_DESCRIPTION,
    readOnly: false,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: FILL_WORKFLOW_HOLE_TIMEOUT_MS,
    maxOutputBytes: FILL_WORKFLOW_HOLE_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: true,
  },
  handler: fillWorkflowHoleHandler,
  // 函数体来源恰好一个，只对模型入参成立（归一化后 `script` 与 `path` 同时在场是合法执行态）。
  validateInput: (input) => validateFillWorkflowHoleSource(input),
  resolveInput: async (input, context) => {
    // 技能门先于 run 解析：补全永远是在写脚本。
    const refused = requireDynamicWorkflowSkill(context, FILL_WORKFLOW_HOLE_TOOL_NAME);
    if (refused) return refused;
    return resolveFillWorkflowHoleInput(input, context);
  },
  prepareApproval: prepareFillWorkflowHoleApproval,
  inputSchema: FillWorkflowHoleInputJsonSchema,
  outputSchema: FillWorkflowHoleOutputJsonSchema,
  runtimeInputSchema: FillWorkflowHoleInputSchema,
  runtimeOutputSchema: FillWorkflowHoleOutputSchema,
  formatModelContent: formatFillWorkflowHoleModelContent,
  permission: {
    permission: "createWorkflow",
    reason:
      "fillWorkflowHole.runConfirmation: user must confirm the body that joins the running script",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: true,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
    // 与 CreateWorkflow / AmendWorkflow 同一道门（alwaysAsk）；本会话自己的 run 由权限服务的 owner
    // 规则在 always-ask 分支里放行（docs/dynamic-workflow/launch.md「Approval」）。
    alwaysAsk: true,
    askOptions: { allowAlways: "session" },
  },
  resultBudget: {
    maxInlineBytes: FILL_WORKFLOW_HOLE_MODEL_BYTES,
    maxModelBytes: FILL_WORKFLOW_HOLE_MODEL_BYTES,
    strategy: "truncate",
    preview: { maxBytes: FILL_WORKFLOW_HOLE_MODEL_BYTES, direction: "head" },
  },
  timeout: {
    defaultMs: FILL_WORKFLOW_HOLE_TIMEOUT_MS,
    maxMs: FILL_WORKFLOW_HOLE_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: false,
    cleanup: "none",
    userVisibleMessage:
      "FillWorkflowHole compiles the effective script synchronously and cannot be cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function formatFillWorkflowHoleModelContent(output: unknown): ModelMessageContent {
  const parsed = FillWorkflowHoleOutputSchema.safeParse(output);
  if (!parsed.success) return "FillWorkflowHole returned an invalid result.";
  return parsed.data.response;
}
