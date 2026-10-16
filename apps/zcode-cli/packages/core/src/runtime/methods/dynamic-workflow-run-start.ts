import { randomUUID } from "node:crypto";
import {
  CREATE_WORKFLOW_TOOL_NAME,
  boundWorkflowLaunchMeta,
  createWorkflowPhaseAlongside,
  createWorkflowPhaseNames,
  type SavedWorkflowScope,
  type TraceContext,
} from "@zcode/contracts";
import type { CompileDiagnostic } from "@zcode/dynamic-workflow";
import {
  resolveSavedWorkflow,
  validateWorkflowArgs,
} from "../../tool/handlers/saved-workflows/index.js";
import {
  boundGraphOfAnalysis,
  displayOfAnalysis,
} from "../../tool/handlers/workflow-analysis-display.js";
import { writeWorkflowDraft } from "../../tool/handlers/workflow-drafts.js";
import { analyzeScript } from "../../tool/handlers/workflow-script-analysis.js";
import { bindScriptModels } from "../../tool/handlers/workflow-script-models.js";
import type { ExecutableToolCall } from "../../tool/types.js";
import { uuidv7 } from "@zcode/shared";
import { createMessageId, traceContextToLogContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { emitControlOnlyUserTurn, persistWorkflowLaunchUserMessage } from "./control-only-turn.js";
import { activateDynamicWorkflowTools } from "./dynamic-workflow-activation.js";

/**
 * `startSavedWorkflowRun` 的结构化结果。成功给 run 的两把关联键（`runId` ≡ backgroundTaskId ≡
 * cancelBackgroundWork 的 workId；`toolCallId` 联工具卡 → 详情页）；失败走 `reason` 判别键
 * （house rule：错误码而非文本做流程判断），`message` 携带人可读原因供 GUI 行内展示。
 */
export type StartSavedWorkflowRunResult =
  | { ok: true; runId: string; toolCallId: string }
  | {
      ok: false;
      reason:
        | "invalid_name"
        | "not_found"
        | "invalid_args"
        | "compile_failed"
        | "session_busy"
        | "start_failed";
      message?: string;
    };

/** 编译诊断合并后的界（≈2KB）：诊断随 ACK 的 `message` 走协议，过长的堆栈没有阅读价值。 */
const COMPILE_DIAGNOSTICS_MAX_CHARS = 2_000;

/**
 * 中枢直接启动一个已保存的工作流。
 *
 * 它是 `port.submit` 的**第二个调用方**，与 `CreateWorkflow` 工具路径同构：同一段 saved 归一化
 * （`resolveSavedWorkflow` + `validateWorkflowArgs`，不复制）、同一个后台追踪器
 * （`trackExternalBackgroundTask` 喂一个合成 CreateWorkflow 描述子），产出的 run 对通知 / 取消 /
 * 恢复 / 详情侧板不可区分。区别只在：不经 `ToolExecutor.execute`（绕开权限判定 + `alwaysAsk`——
 * 这正是本特性的全部意义，用户在中枢里的点击就是同意），并以一条 controlOnly 「启动轮」把用户的
 * 真实动作落进会话（模型直到完成 / 提问通知到来才第一次听说这次 run）。
 *
 * 顺序固定，且 ①② 失败在**任何持久化之前**（无 run、无消息、无事件、无任务）；④ 之后的失败只记
 * 日志不回滚（run 已在飞、可在侧板取消），仍返回 ok。
 */
export async function startSavedWorkflowRun(
  this: AgentRuntimeInternal,
  input: {
    name: string;
    scope?: SavedWorkflowScope;
    args?: Record<string, unknown>;
    traceContext?: TraceContext;
  },
): Promise<StartSavedWorkflowRunResult> {
  const traceContext = input.traceContext ?? this.rootTraceContext;

  // (0) 忙碌会话拒绝。本方法只对刚建的空会话有意义；把启动排进活动 turn 的队列需要 controlOnly
  // 轮与 provider grammar 协调（属「加入当前会话」的未来工作）。GUI 只对空会话发它，故正常不触发。
  if (this.hasActiveOrQueuedTurnWork()) {
    return { ok: false, reason: "session_busy" };
  }

  const cwd = this.workingDirectory;

  // (1) 解析 + 实参校验：复用 create-workflow-source 的同一段归一化（第二个调用方，不复制）。
  const found = resolveSavedWorkflow({ cwd, name: input.name, scope: input.scope });
  if (!found.ok) {
    if (found.reason === "invalid_name") {
      return {
        ok: false,
        reason: "invalid_name",
        message: `'${input.name}' is not a usable workflow name: ${found.detail}`,
      };
    }
    if (found.reason === "not_found") {
      return {
        ok: false,
        reason: "not_found",
        message:
          input.scope === undefined
            ? `No saved workflow named '${input.name}' in this project or globally.`
            : `No ${input.scope} workflow named '${input.name}'.`,
      };
    }
    // parse_error / read_error：文件在但坏了。对 GUI 与「找不到」是同一个下一步（这个名字跑不
    // 起来），归 not_found；但 message 说清是文件问题而非名字问题，好让用户去修文件而不是改名字。
    return {
      ok: false,
      reason: "not_found",
      message: `The saved workflow '${input.name}' at ${found.path} could not be read: ${found.detail}`,
    };
  }

  const validated = validateWorkflowArgs(found.meta.args, input.args);
  if (!validated.ok) {
    return {
      ok: false,
      reason: "invalid_args",
      message: [
        `The arguments for saved workflow '${found.name}' are not valid:`,
        ...validated.errors.map((error) => `- ${error}`),
      ].join("\n"),
    };
  }

  // (2) 编译。任一诊断即拒绝——与 CreateWorkflow 对编不过脚本的处理同一条原则（弹一个注定失败的
  // run 只是延迟同一个错误）。诊断进 message，有界。
  const analysis = analyzeScript(found.script);
  // 脚本点名的模型与 CreateWorkflow 同一段代码解析（docs/dynamic-workflow/launch.md「Models the script
  // names」）；没绑定的名字是 9011，与编译诊断一起按 compile_failed 拒绝。
  const models = analysis.ok ? bindScriptModels(analysis, this.modelCatalogPort) : undefined;
  const diagnostics = [...analysis.diagnostics, ...(models?.unbound ?? [])];
  if (!analysis.ok || diagnostics.length > 0) {
    return {
      ok: false,
      reason: "compile_failed",
      message: boundedCompileDiagnostics(
        `The saved workflow '${found.name}' has errors:`,
        diagnostics,
      ),
    };
  }
  const modelSelections = models?.selections;

  // —— 到此为止零副作用：无 run、无消息、无事件、无任务。——

  const port = this.dynamicWorkflowRunPort;
  if (port === undefined) {
    // 端口缺席（stub / 单测宿主）：GUI 拿到能力不支持面。刻意不降级成「假装启动了」。
    return { ok: false, reason: "start_failed", message: "dynamic workflow port unavailable" };
  }

  // 提交前先初始化上下文并持久化父会话。actor 的 session_task_link 通过
  // parent_session_id 引用父会话；父行不存在时，首个 actor 的创建会因外键约束失败。
  // 父会话以工作流名为首输入标题，后续启动轮会幂等复用。提交失败时由 GUI 在收到
  // rejected ACK 后通过 deleteSession 回收空会话。
  await this.ensureContextInitialized(traceContext);
  await this.ensureSessionPersisted(found.name, traceContext);
  // 直接启动即激活工具面（launch.md「On demand: activation」）：启动轮之后的通知要模型去调
  // GetWorkflowRun；放在落盘之后，entry 才有会话可挂。
  await activateDynamicWorkflowTools.call(this, { source: "run_control", traceContext });

  // (3) toolCallId：`launch-` 前缀，日志与工具卡可辨于模型工具调用 id（`tool_*`）与 resume 重臂。
  const toolCallId = `launch-${randomUUID()}`;
  const hasArgs = Object.keys(validated.args).length > 0;
  // 发起锚点：直接启动没有用户轮，铸一个 UUID v7 同时充当
  // run 的 `run-launched.inputId` 与下面 controlOnly 启动轮的 inputId——启动轮 run 卡与子代理的
  // agent_step 因此挂在同一个 message 下。
  const launchInputId = uuidv7();
  // 提交的声明阶段表读与启动轮 display 同一个「分析结果 → 有界显示图」投影（阶段来自控制流层，
  // 只传因果图就没有阶段），再过同一个 createWorkflowPhaseNames——两条路上同一脚本画同一条侧栏轨道。
  const launchGraph = boundGraphOfAnalysis(analysis);
  const phaseNames = createWorkflowPhaseNames(launchGraph);
  // 「同时在跑」表的下标指向 `phaseNames`，所以它必须来自同一张图、同一次投影。
  const phaseAlongside =
    phaseNames === undefined ? undefined : createWorkflowPhaseAlongside(launchGraph);

  // (3b) 工作副本。中枢直接启动与 `CreateWorkflow` 的 saved 来源是同一件事，所以拷贝也按同一条
  // 规矩写：逐字节（元数据块一起）、保存的定义本身一个字都不动。写不成就没有 `scriptPath`——run 照常起，
  // 只是终态通知里没有可编辑的文件可指。
  const draft = await writeWorkflowDraft({ cwd, name: found.name, source: found.source });

  // (4) 提交启动。提交失败（拒绝 / 抛错）在启动轮之前退出——绝不吞成带 runId 的成功。
  let runId: string;
  try {
    const submitted = await port.submit({
      scriptText: found.script,
      cwd,
      name: found.name,
      ...(hasArgs ? { args: validated.args } : {}),
      parentSessionId: this.sessionId,
      toolCallId,
      launchInputId,
      ...(phaseNames === undefined ? {} : { phaseNames }),
      ...(phaseAlongside === undefined ? {} : { phaseAlongside }),
      ...(modelSelections === undefined ? {} : { modelBindings: modelSelections }),
      ...(draft === undefined ? {} : { scriptPath: draft.path }),
      trace: traceContext,
    });
    runId = submitted.runId;
  } catch (error) {
    return { ok: false, reason: "start_failed", message: describeError(error) };
  }

  const launchText = buildLaunchMessageText(found.name, found.scope, runId, validated.args);
  // 图与脚本随启动轮走：run 详情侧板与轮尾 run 卡按 toolCallId 找「发起行」取 display.causalityGraph
  // 与 input.script，直接启动没有工具行，就把同一份 display 与脚本挂在启动元数据上
  // （否则直接启动的 run 侧板无图、无脚本）。display 走与 CreateWorkflow 同一个「分析结果 → 显示图」
  // 投影，三层（站点 / 阶段 / 子代理卡）一并在场——这里曾手拼实参而只传了因果图，
  // 图有站点却没有阶段与子代理卡，侧板因此只剩一条空脊线。
  const display = displayOfAnalysis(analysis);
  const meta = boundWorkflowLaunchMeta({
    runId,
    toolCallId,
    name: found.name,
    scope: found.scope,
    path: found.path,
    ...(hasArgs ? { args: validated.args } : {}),
    description: found.meta.description,
    ...(display?.kind === "create_workflow" ? { display } : {}),
    script: found.script,
  });

  // ④ 之后的失败只记日志不回滚：run 已在飞，可在侧板取消；把它撤回反而制造一个无归属的孤儿 run。
  try {
    // (5) 启动轮：user 可见消息（synthetic + workflowLaunch 元数据）+ history + controlOnly turn
    // 边界；会话标题 = 工作流名（ensureSessionPersisted 以名为首输入标题）。
    const messageId = createMessageId();
    await emitControlOnlyUserTurn.call(this, {
      messageId,
      titleInput: found.name,
      historyText: launchText,
      turnInput: launchText,
      traceContext,
      inputId: launchInputId,
      inputSource: "workflow_launch",
      workflowLaunch: meta,
      persistMessage: () =>
        persistWorkflowLaunchUserMessage.call(this, {
          messageID: messageId,
          text: launchText,
          meta,
          traceContext,
        }),
    });

    // (6) 后台追踪：合成一个 CreateWorkflow 描述子走 executor 的同一条 trackBackgroundTask
    // （runtime-task registry 登记 = 会话回收护栏、BackgroundTaskStarted、终态 waiter、结算通知）。
    // `input.name` 喂通知主题（workflowTaskSubject），`name: CreateWorkflow` 让 per-tool 生命周期
    // 分派归 "workflow"——完成通知 / 取消 / 恢复 / 详情侧板零改动。
    const toolCall: ExecutableToolCall = {
      id: toolCallId,
      name: CREATE_WORKFLOW_TOOL_NAME,
      input: {
        name: found.name,
        saved: {
          name: found.name,
          scope: found.scope,
          ...(hasArgs ? { args: validated.args } : {}),
        },
      },
    };
    await this.executor.trackExternalBackgroundTask(
      toolCall,
      { backgroundTaskId: runId, status: "backgrounded" },
      traceContext,
      undefined,
    );
  } catch (error) {
    this.logger?.error(
      "Saved workflow launched but post-submit bookkeeping failed",
      error instanceof Error ? error : new Error(String(error)),
      {
        ...traceContextToLogContext(traceContext),
        event: "dynamic_workflow.launch.post_submit_failed",
        module: "core.runtime",
        runId,
        toolCallId,
      },
    );
  }

  return { ok: true, runId, toolCallId };
}

/**
 * 启动轮的模型面规范句（英文，不本地化——它进 provider transcript，是模型下一回合读到的东西）。
 * 有实参时把实参以 JSON 块附上；末句无条件劝阻重复启动（run 已在飞，进度以通知形式回来）。
 */
function buildLaunchMessageText(
  name: string,
  scope: SavedWorkflowScope,
  runId: string,
  args: Record<string, unknown>,
): string {
  const lines = [
    `Started the saved workflow "${name}" (${scope}) from the workflows hub as run ${runId}.`,
  ];
  if (Object.keys(args).length > 0) {
    lines.push("", "Arguments:", "```json", JSON.stringify(args, null, 2), "```");
  }
  lines.push("", "Progress and results arrive as background notifications; do not start it again.");
  return lines.join("\n");
}

/**
 * 编译诊断合并成一段有界文本（`L{line}:C{column} {message}` 逐条）。中枢启动与 GUI「配置」共用：
 * 两者都把诊断经 ACK 的 `message` 交给 GUI 的有界等宽块。
 */
export function boundedCompileDiagnostics(
  heading: string,
  diagnostics: readonly CompileDiagnostic[],
): string {
  const body = [
    heading,
    ...diagnostics.map(
      (diagnostic) => `L${diagnostic.line}:C${diagnostic.column} ${diagnostic.message}`,
    ),
  ].join("\n");
  return body.length > COMPILE_DIAGNOSTICS_MAX_CHARS
    ? `${body.slice(0, COMPILE_DIAGNOSTICS_MAX_CHARS - 1)}…`
    : body;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
