import { ChevronRightIcon } from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";
import type { ZCodePermissionRequest } from "@zcode/shared";
import { CodeBlock } from "@/components/ai-elements/code-block.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import { cn } from "@/components/lib/utils.js";
import { buildWorkflowTimeline } from "@/components/workflow-timeline/timeline-model.js";
import { workflowPhasesDetail } from "@/components/workflow-timeline/timeline-summary.js";
import { WorkflowCardHeader } from "@/components/workflow-timeline/WorkflowCardChrome.js";
import { WorkflowTimeline } from "@/components/workflow-timeline/WorkflowTimeline.js";
import {
  formatWorkflowArgValue,
  isWorkflowAmendPredecessorLive,
  readWorkflowAdjustableSettings,
  readWorkflowAmendPredecessor,
  readWorkflowAmendScriptInherited,
  readWorkflowAmendTarget,
  readWorkflowMaxConcurrency,
  readWorkflowName,
  readWorkflowSaved,
  readWorkflowScript,
  readWorkflowSubagentModel,
  workflowScriptNamesModels,
  type WorkflowSavedSource,
} from "@/ToolCallBlocks/renderers/createWorkflowInput.js";
import {
  describeWorkflowSubagentModel,
  workflowSubagentModelText,
  workflowSubagentModelTooltip,
} from "@/components/workflow-timeline/subagent-model-label.js";
import { WorkflowAskSettings } from "@/components/workflow-timeline/WorkflowAskSettingsLines.js";
import { WorkflowAskPlainSettings } from "@/components/workflow-timeline/WorkflowAskSettingsParts.js";
import type { WorkflowAskSettingsContent } from "@/components/workflow-timeline/workflowAskSettings.js";
import { useWorkflowSubagentModelProviderName } from "@/hooks/useWorkflowSubagentModelProviderName.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { isAmendWorkflowToolCall, isFillWorkflowHoleToolCall } from "@/lib/workflowToolNames.js";
import { readWorkflowHoleTarget } from "@/ToolCallBlocks/renderers/createWorkflowHoleInput.js";
import { narrowTimelineToFill } from "@/components/workflow-timeline/timeline-holes.js";
import { WorkflowPermissionHoles } from "@/WorkflowPermissionHoles.js";

/**
 * saved 来源徽标：这次运行的脚本来自项目里的一个文件，而不是模型现写的一段。
 *
 * 刻意只有一行加一张实参表，并且放在时间线**上方**：图仍是决策主体，来源与实参是「跑的是哪一份、带什么参数」这条
 * 前置事实，读完它才轮到图。徽标不表达任何信任——不变式 1：保存不产生信任。
 */
function WorkflowSavedSourceBadge({ saved }: { saved: WorkflowSavedSource }) {
  const { intl } = useZCodeIntl();

  const savedLabel = intl.formatMessage({ id: "chat.permission.workflow.saved.badge" });
  const scopeLabel =
    saved.scope === "project"
      ? intl.formatMessage({ id: "chat.permission.workflow.saved.scope.project" })
      : saved.scope;
  const argsLabel = intl.formatMessage({ id: "chat.permission.workflow.saved.args" });
  const argEntries = Object.entries(saved.args);

  return (
    <div
      className="space-y-1.5 rounded-lg border border-border bg-surface px-2.5 py-2"
      data-workflow-saved-source="true"
    >
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="shrink-0 text-ui-sm font-medium text-foreground-subtle">
          {scopeLabel === undefined ? savedLabel : `${savedLabel} · ${scopeLabel}`}
        </span>
        <span
          className="min-w-0 flex-1 truncate font-mono text-ui-sm text-foreground-subtlest"
          data-workflow-saved-name="true"
          title={saved.path ?? saved.name}
        >
          {saved.name}
        </span>
      </div>

      {saved.path === undefined ? null : (
        <p
          className="min-w-0 truncate font-mono text-ui-xs text-foreground-subtlest"
          data-workflow-saved-path="true"
          title={saved.path}
        >
          {saved.path}
        </p>
      )}

      {argEntries.length === 0 ? null : (
        <dl
          className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 pt-0.5"
          data-workflow-saved-args="true"
          aria-label={argsLabel}
        >
          {argEntries.map(([key, value]) => (
            <Fragment key={key}>
              <dt className="font-mono text-ui-sm text-foreground-subtlest">{key}</dt>
              <dd className="min-w-0 break-words font-mono text-ui-sm text-foreground-subtle">
                {formatWorkflowArgValue(value)}
              </dd>
            </Fragment>
          ))}
        </dl>
      )}
    </div>
  );
}

/**
 * CreateWorkflow / AmendWorkflow 的运行确认块（docs/dynamic-workflow/presentation.md「The confirmation window」）：表头（问句 +
 * 名字，右侧只有 `N phases`——2026-09-09 起没有「compiled」灯，也不再数子代理与步）+ lineage（只有修订有）+ 两项 run
 * 设置（模型在上、上界在下；agent 回填了 `adjustable_settings` 时句中的值可改）+ saved 徽标 + **时间线** + 折叠脚本。
 * Deny / Refine / Run 仍由 PermissionDialog 给；改过的设置经 `onSettingsChange` 交回给它，随 Allow 应答发出。
 *
 * 修订的确认窗只在前驱是**别的会话**的 run（或用户亲手停过的 run）时出现：问句换成「调整此工作流？」，lineage 行说要改哪个 run、它是否还在跑。
 *
 * 权限块通常禁止折叠（见 PermissionDialog getPermissionBlockInteraction 的注释）；时间线和名称
 * 是决策关键内容且不可折叠，脚本是审计细节层。
 */
export function WorkflowPermissionBlock({
  onSettingsBlockedChange,
  onSettingsChange,
  remoteSessionId,
  request,
  sessionModel,
  settingsDisabled = false,
  workspaceIdentity,
  workspacePath,
}: {
  /** 所选子代理模型不可用：Allow 要等用户换一个。 */
  onSettingsBlockedChange?: (blocked: boolean) => void;
  /** 用户在窗里改了设置：只含改过的字段；全改回去即 undefined。 */
  onSettingsChange?: (content: WorkflowAskSettingsContent | undefined) => void;
  remoteSessionId?: string;
  request: ZCodePermissionRequest;
  /** 会话当前模型：「会话模型」那一项的名字。 */
  sessionModel?: { providerId: string; modelId: string };
  /** 应答在途：控件与选项一起禁用。 */
  settingsDisabled?: boolean;
  workspaceIdentity?: string;
  /** 会话模型清单的作用域（PermissionDialog 给）：模型菜单与 provider 名都从它读。 */
  workspacePath?: string;
}) {
  const { intl } = useZCodeIntl();

  // v4 ask 的 raw 就是工具入参（product-projection 的 detail: payload.input），
  // 与聊天卡片共用 create-workflow.tsx 的读取规则，避免两处对同一入参各自解析。
  const scriptText = readWorkflowScript(request.raw);
  const workflowName = readWorkflowName(request.raw);
  const saved = readWorkflowSaved(request.raw);
  // 修订按工具名判（kind / title 是 v4 ask 挂上的工具名）；lineage 只对修订成立。
  const amend = isAmendWorkflowToolCall(request);
  // 留白补全的确认窗（docs/dynamic-workflow/launch.md「Approval」）：问句换成「补全此留白？」，时间线画补全的
  // 草稿阶段线（新的站在两侧 ghost 的邻站之间）。名字与类型由工具回填在入参的 `hole` 块里。
  const fill = isFillWorkflowHoleToolCall(request);
  const holeTarget = fill ? readWorkflowHoleTarget(request.raw) : undefined;
  const amendTarget = amend ? readWorkflowAmendTarget(request.raw) : undefined;
  const predecessor = amend ? readWorkflowAmendPredecessor(request.raw) : undefined;
  // 这次修订沿用前驱的脚本：
  // 入参里的脚本是 CLI 回填的那一份——图与折叠照常画将要跑的脚本，lineage 行多说一句「脚本不变」。
  const scriptInherited = amend && readWorkflowAmendScriptInherited(request.raw);
  // 并发上限：Create 与 Amend 同一个
  // 入参字段，所以不按工具名分叉——批准的是「以这个上限跑」，两种窗都要把它说出来。入参到这里
  // 已经过 resolveInput 的 clamp，所以窗上这个数就是会生效的那一条界。
  const maxConcurrency = readWorkflowMaxConcurrency(request.raw);
  // 子代理模型：与并发上限同族的一条「用户自己提的条件」，
  // 而且比它更该说出口——批准的是「让这些子代理跑在另一个模型上」。入参到这里已被 resolveInput
  // 解析成规范串，所以窗上这个 id 就是真会被用上的那个。主代理不受影响，文案因此只说子代理。
  const subagentModel = readWorkflowSubagentModel(request.raw);
  // agent 说这台宿主能应用哪些调整（docs/dynamic-workflow/launch.md「Adjusting the settings in the
  // window」）；缺席（旧 agent）即只画调用设了的字段，纯文本——agent 会丢掉的改动，窗里就不提供。
  const adjustable = readWorkflowAdjustableSettings(request.raw);
  // 模型清单要有作用域才读得到；读不到时模型那一行退成一句话，上界照样可调。
  const hasModelScope = Boolean(workspacePath?.trim() || workspaceIdentity?.trim());
  // 规范串只进 tooltip：屏幕上说模型名（必要时加思考强度），拼名规则与模型菜单同一条。
  const subagentModelProviderName = useWorkflowSubagentModelProviderName(workspacePath);
  const describedSubagentModel = useMemo(
    () =>
      subagentModel === undefined
        ? undefined
        : describeWorkflowSubagentModel(subagentModel, {
            formatMessage: intl.formatMessage.bind(intl),
            ...(subagentModelProviderName === undefined
              ? {}
              : { providerName: subagentModelProviderName }),
          }),
    [intl, subagentModel, subagentModelProviderName],
  );

  // 空图（脚本里一次 ask / files.* 都没有）不值得一条空轨道；和聊天卡片同一判定。
  const display = request.display?.kind === "create_workflow" ? request.display : null;
  const causalityGraph =
    display?.causalityGraph !== undefined && display.causalityGraph.steps.length > 0
      ? display.causalityGraph
      : undefined;
  const hasGraph = causalityGraph !== undefined;
  const holeId = holeTarget?.holeId;
  const holeName = holeTarget?.name;
  const model = useMemo(() => {
    if (causalityGraph === undefined) return undefined;
    if (holeId === undefined) return buildWorkflowTimeline(causalityGraph, undefined);
    const labels = new Map(holeName === undefined ? [] : [[holeId, { name: holeName }]]);
    const whole = buildWorkflowTimeline(causalityGraph, undefined, labels);
    return narrowTimelineToFill(whole, holeId) ?? whole;
  }, [causalityGraph, holeId, holeName]);

  // 有图时脚本默认收起；零 step 脚本没有图可看，代码就是唯一内容，默认展开。
  const [scriptOpen, setScriptOpen] = useState(!hasGraph);

  // PermissionDialog 会跨请求复用同一组件实例（只按 requestId 重置内部状态），
  // 换请求后必须回到默认折叠态，否则上一次的展开会泄漏到下一个工作流。
  useEffect(() => {
    setScriptOpen(!hasGraph);
  }, [hasGraph, request.requestId]);

  const fallbackName = intl.formatMessage({ id: "chat.toolCall.workflow.fallbackName" });
  const title = intl.formatMessage({
    id: fill
      ? "chat.permission.workflow.hole.title"
      : amend
        ? "chat.permission.workflow.amend.title"
        : "chat.permission.workflow.title",
  });
  const amendsLabel = intl.formatMessage({ id: "chat.permission.workflow.amends" });
  const stillRunningLabel = intl.formatMessage({ id: "chat.permission.workflow.amends.running" });
  const scriptUnchangedLabel = intl.formatMessage({
    id: "chat.permission.workflow.amends.scriptUnchanged",
  });
  const scriptToggleLabel = intl.formatMessage({
    id: scriptOpen ? "chat.permission.workflow.hideScript" : "chat.permission.workflow.showScript",
  });
  const detail =
    model === undefined
      ? undefined
      : workflowPhasesDetail(intl.formatMessage.bind(intl), model, causalityGraph);

  return (
    <div className="space-y-3" data-workflow-permission-block="true">
      {/* 问句在最上：弹窗通用标题「需要权限」紧贴其上，两句连读才是完整的决策提问；
          名字随后，作为它下方那条时间线的标题。 */}
      <WorkflowCardHeader
        detail={detail}
        expanded
        kind={title}
        name={fill ? (holeName ?? holeId ?? fallbackName) : (workflowName ?? fallbackName)}
      />

      {/* 留白行（docs/dynamic-workflow/presentation.md「Holes on the timeline」）：还开着的留白与它们的类型，
          外加一句「运行到留白处会暂停」。 */}
      <WorkflowPermissionHoles holes={causalityGraph?.holes} />

      {/* lineage 行（修订才有）：紧贴名称行，与它一同构成「这次要改的是什么」的抬头；前驱还在跑时
          多说一句「将被停止」——用户批准的不只是一段新脚本，还有停掉一个正在跑的 run。 */}
      {amendTarget === undefined ? null : (
        <div
          className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5"
          data-workflow-amends="true"
          {...(isWorkflowAmendPredecessorLive(predecessor)
            ? { "data-workflow-amends-live": "true" }
            : {})}
          {...(scriptInherited ? { "data-workflow-amends-script-inherited": "true" } : {})}
        >
          <span className="shrink-0 text-ui-xs text-foreground-subtlest">{amendsLabel}</span>
          <span
            className="min-w-0 truncate font-mono text-ui-xs text-foreground-subtlest"
            title={amendTarget}
          >
            {amendTarget}
          </span>
          {scriptInherited ? (
            <span className="shrink-0 text-ui-xs text-foreground-subtlest">
              · {scriptUnchangedLabel}
            </span>
          ) : null}
          {isWorkflowAmendPredecessorLive(predecessor) ? (
            <span className="shrink-0 text-ui-xs text-warning">· {stillRunningLabel}</span>
          ) : null}
        </div>
      )}

      {/* 两项 run 设置：与 lineage 行同族的「这次 run 受什么约束」，紧随其后、排在来源徽标之前。
          可调时两句总在（没动过也说出将会发生什么）；按 requestId 重挂，换请求即回到新入参的起点。 */}
      {adjustable === undefined ? (
        <WorkflowAskPlainSettings
          maxConcurrency={maxConcurrency}
          scriptNamesModels={workflowScriptNamesModels(request.raw)}
          subagentModel={
            describedSubagentModel === undefined
              ? undefined
              : {
                  text: workflowSubagentModelText(
                    intl.formatMessage.bind(intl),
                    describedSubagentModel,
                  ),
                  tooltip: workflowSubagentModelTooltip(
                    intl.formatMessage.bind(intl),
                    describedSubagentModel,
                  ),
                }
          }
        />
      ) : (
        <WorkflowAskSettings
          key={request.requestId}
          adjustable={{
            ...adjustable,
            subagentModel: adjustable.subagentModel && hasModelScope,
          }}
          disabled={settingsDisabled}
          input={request.raw}
          scope={{
            workspacePath: workspacePath ?? "",
            ...(workspaceIdentity === undefined ? {} : { workspaceIdentity }),
            ...(remoteSessionId === undefined ? {} : { remoteSessionId }),
            ...(sessionModel === undefined ? {} : { sessionModel }),
          }}
          {...(onSettingsChange === undefined ? {} : { onContentChange: onSettingsChange })}
          {...(onSettingsBlockedChange === undefined
            ? {}
            : { onBlockedChange: onSettingsBlockedChange })}
        />
      )}

      {saved ? <WorkflowSavedSourceBadge saved={saved} /> : null}

      {model === undefined ? null : <WorkflowTimeline className="py-1" model={model} />}

      {scriptText ? (
        <Collapsible open={scriptOpen} onOpenChange={setScriptOpen}>
          <CollapsibleTrigger className="flex min-w-0 items-center gap-1 rounded-md py-0.5 text-left text-ui-xs font-medium text-foreground-subtlest transition-colors hover:text-foreground-subtle">
            <ChevronRightIcon
              className={cn("size-3.5 shrink-0 transition-transform", scriptOpen && "rotate-90")}
            />
            <span className="min-w-0 truncate">{scriptToggleLabel}</span>
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-1.5">
            {/* 限高可滚动：长脚本不再把确认窗撑高。 */}
            <div className="max-h-72 overflow-auto" data-testid="workflow-script-scroll">
              <CodeBlock
                code={scriptText}
                language="typescript"
                renderMermaid={false}
                showLineNumbers
              />
            </div>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  );
}
