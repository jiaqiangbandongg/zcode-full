// ============================================================
// 确认窗里的两项 run 设置（docs/dynamic-workflow/presentation.md「The confirmation window」）
// ============================================================
// 两句话，句中的值就是控件：「子代理运行在 [模型 ▾] [思考 高 ▾]」「最多 [− 4 +] 个子代理同时运行 · 默认 13」。
// 脚本给某些子代理点名了模型时第一句改口「子代理默认运行在」，那些名字本身不列（作者模型的选择）。
// 没动过的值安静地待在句子里；改过的那一行值加粗，句尾跟一截「· 原为 X ↺」。
//
// 块缺席（旧 agent 不回填 `adjustable_settings`）时画 `WorkflowAskPlainSettings`（WorkflowAskSettingsParts.tsx）：
// 只有调用设了的字段、纯文本、不可调——agent 不会应用的改动，窗里就不提供。
//
// 草稿住在这里，改动经 `onContentChange` 事件式地交给 PermissionDialog（它在 Allow 时把它放进应答的
// `content`）；换请求靠父组件按 requestId 给 key 重挂，不靠 effect 追。唯一的 effect 是「所选模型
// 不可用」：它取决于异步读回的模型清单，不是用户的一次操作，只能在清单到达后回报给父组件。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ZCODE_AGENT_PROVIDER } from "@zcode/shared";
import { ThoughtLevelCycleControl } from "@/chat-input-toolbar/ThoughtLevelCycleControl.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { MODEL_CONFIG_SELECT_BADGE_CLASS_NAME, ModelConfigSelect } from "@/ModelConfigSelect.js";
import {
  workflowScriptNamesModels,
  type WorkflowAdjustableSettings,
} from "@/ToolCallBlocks/renderers/createWorkflowInput.js";
import {
  describeWorkflowSubagentModel,
  workflowSubagentModelText,
  workflowSubagentModelTooltip,
} from "./subagent-model-label.js";
import {
  WORKFLOW_ASK_CHIP_CLASS_NAME,
  WORKFLOW_ASK_LINE_CLASS_NAME,
  WORKFLOW_ASK_TAIL_CLASS_NAME,
  WorkflowAskBoundLine,
  WorkflowAskWasTail,
} from "./WorkflowAskSettingsParts.js";
import {
  useWorkflowSettingsModelChoices,
  type WorkflowSettingsModelScope,
} from "./useWorkflowSettingsModelChoices.js";
import {
  initialWorkflowAskSettingsDraft,
  workflowAskSettingsChangedLines,
  workflowAskSettingsContent,
  type WorkflowAskSettingsContent,
} from "./workflowAskSettings.js";
import {
  workflowRunSettingsModelCanonical,
  type WorkflowRunSettingsDraft,
  type WorkflowRunSettingsModel,
} from "./workflowRunSettings.js";

export function WorkflowAskSettings({
  adjustable,
  disabled,
  input,
  onBlockedChange,
  onContentChange,
  scope,
}: {
  adjustable: WorkflowAdjustableSettings;
  disabled: boolean;
  /** 确认窗的工具入参（CLI resolveInput 归一化过的那一份）。 */
  input: unknown;
  onContentChange?: (content: WorkflowAskSettingsContent | undefined) => void;
  /** 所选模型读好清单后仍不可用：Allow 要等用户换一个（与弹层的 Apply 同一条规则）。 */
  onBlockedChange?: (blocked: boolean) => void;
  scope: WorkflowSettingsModelScope;
}) {
  const defaultConcurrency = adjustable.defaultConcurrency;
  // 起点在挂载那一刻定下：父组件按 requestId 重挂，同一个请求的入参不会变。
  const [initial] = useState(() => initialWorkflowAskSettingsDraft(input, defaultConcurrency));
  const [draft, setDraft] = useState<WorkflowRunSettingsDraft>(initial);
  const update = (next: WorkflowRunSettingsDraft) => {
    setDraft(next);
    onContentChange?.(workflowAskSettingsContent(initial, next, defaultConcurrency));
  };
  const changed = workflowAskSettingsChangedLines(initial, draft, defaultConcurrency);

  return (
    <div className="space-y-1" data-testid="workflow-permission-settings">
      <WorkflowAskModelLine
        adjustable={adjustable.subagentModel}
        changed={changed.model}
        disabled={disabled}
        initial={initial.model}
        model={draft.model}
        onChange={(model) => update({ ...draft, model })}
        onReset={() => update({ ...draft, model: initial.model })}
        scope={scope}
        scriptNamesModels={workflowScriptNamesModels(input)}
        {...(onBlockedChange === undefined ? {} : { onBlockedChange })}
      />
      <WorkflowAskBoundLine
        bound={draft.bound}
        changed={changed.bound}
        defaultConcurrency={defaultConcurrency}
        disabled={disabled}
        initial={initial.bound}
        onChange={(bound) => update({ ...draft, bound })}
        onReset={() => update({ ...draft, bound: initial.bound })}
      />
    </div>
  );
}

function WorkflowAskModelLine({
  adjustable,
  changed,
  disabled,
  initial,
  model,
  onBlockedChange,
  onChange,
  onReset,
  scope,
  scriptNamesModels,
}: {
  adjustable: boolean;
  changed: boolean;
  disabled: boolean;
  initial: WorkflowRunSettingsModel;
  model: WorkflowRunSettingsModel;
  onBlockedChange?: (blocked: boolean) => void;
  onChange: (model: WorkflowRunSettingsModel) => void;
  onReset: () => void;
  scope: WorkflowSettingsModelScope;
  /**
   * 脚本给某些子代理点名了模型（`model_bindings`）：窗不逐名列出——那是作者模型的选择——只把这一句
   * 改口成「子代理默认运行在」，因为它不再替每一个子代理说话。
   */
  scriptNamesModels: boolean;
}) {
  const { intl } = useZCodeIntl();
  const format = intl.formatMessage.bind(intl);
  const choices = useWorkflowSettingsModelChoices(scope);
  const levelTriggerRef = useRef<HTMLSpanElement | null>(null);
  const [levelOpen, setLevelOpen] = useState(false);
  // ModelConfigSelect 是 memo 组件：内联数组每次渲染都是新引用（reactStableReferences.test.ts）。
  const leadingItems = useMemo(() => [choices.sessionModelItem], [choices.sessionModelItem]);
  const selectable = adjustable && !choices.noCatalog;
  const face = choices.describe(model);
  const blocked = selectable && face.unavailable;
  // ModelConfigSelect 是 memo 组件：回调同样不能是内联函数。
  const { pick } = choices;
  const handleValueChange = useCallback(
    (value: string) => onChange(pick(value, model)),
    [model, onChange, pick],
  );
  useEffect(() => {
    onBlockedChange?.(blocked);
  }, [blocked, onBlockedChange]);

  const labelOf = (choice: WorkflowRunSettingsModel) => {
    const canonical = workflowRunSettingsModelCanonical(choice);
    if (choice.kind === "session" || canonical === undefined) {
      // 会话模型的名字读不出时，名字本身就是「会话模型」，不再叠一个同词徽标。
      const text =
        scope.sessionModel === undefined
          ? choices.sessionModelName
          : `${choices.sessionModelName} · ${choices.sessionBadge}`;
      return { text, tooltip: undefined };
    }
    const label = describeWorkflowSubagentModel(canonical, {
      formatMessage: format,
      providerName: choices.providerName,
    });
    return {
      text: workflowSubagentModelText(format, label),
      tooltip: workflowSubagentModelTooltip(format, label),
    };
  };

  const lead = format({
    id: scriptNamesModels
      ? "chat.permission.workflow.settings.model.leadDefault"
      : "chat.permission.workflow.settings.model.lead",
  });
  // 选不了模型（宿主没有目录，或本机清单是空的）：句子不再有控件。入参里有模型（沿用来的）就照实说它，
  // 没有才说「沿用会话模型」——不能让窗说一句与将要发生的事相反的话。
  if (!selectable) {
    const current = labelOf(model);
    return (
      <div
        className={WORKFLOW_ASK_LINE_CLASS_NAME}
        data-testid="workflow-permission-settings-model"
      >
        {model.kind === "session" ? (
          <>
            <span>
              {format({
                id: scriptNamesModels
                  ? "chat.permission.workflow.settings.model.noCatalogDefault"
                  : "chat.permission.workflow.settings.model.noCatalog",
              })}
            </span>
            <span className={WORKFLOW_ASK_TAIL_CLASS_NAME}>
              · {format({ id: "chat.permission.workflow.settings.model.noCatalogReason" })}
            </span>
          </>
        ) : (
          <span title={current.tooltip}>
            {lead} {current.text}
          </span>
        )}
      </div>
    );
  }

  const tooltip = labelOf(model).tooltip;
  return (
    <div
      className={WORKFLOW_ASK_LINE_CLASS_NAME}
      data-changed={changed ? "true" : undefined}
      data-testid="workflow-permission-settings-model"
    >
      <span>{lead}</span>
      <ModelConfigSelect
        contentAlign="start"
        contentSide="bottom"
        disabled={disabled || choices.loading}
        focusSelectorOnClose={null}
        indicatorClassName="size-3"
        isItemLocked={MODEL_ITEM_NEVER_LOCKED}
        labelVisibilityClassName="inline-flex min-w-0"
        leadingItems={leadingItems}
        lockReasonMessage=""
        modelGroups={choices.groups}
        normalizedValue={face.value}
        onValueChange={handleValueChange}
        showManageModelsAction={false}
        triggerClassName={WORKFLOW_ASK_CHIP_CLASS_NAME}
        triggerLabel={face.triggerLabel}
        triggerLabelClassName={cn("min-w-0 truncate", changed && "font-medium")}
        triggerTestId="workflow-permission-settings-model-trigger"
        {...(tooltip === undefined ? {} : { tooltipTitle: tooltip })}
        {...(model.kind === "session"
          ? {
              triggerBadge: (
                <span className={MODEL_CONFIG_SELECT_BADGE_CLASS_NAME}>{choices.sessionBadge}</span>
              ),
            }
          : face.unavailable
            ? {
                triggerBadge: (
                  <span
                    className={cn(MODEL_CONFIG_SELECT_BADGE_CLASS_NAME, "text-warning")}
                    data-testid="workflow-permission-settings-model-unavailable"
                  >
                    {format({ id: "chat.toolCall.workflow.run.settings.model.unavailable" })}
                  </span>
                ),
              }
            : {})}
      />
      {face.thoughtOption === null || model.kind !== "model" ? null : (
        <ThoughtLevelCycleControl
          disabled={disabled}
          intl={intl}
          labelVisibilityClassName="inline-flex"
          onCurrentValueCommit={(level) => {
            if (level !== model.level) onChange({ ...model, level });
          }}
          onOpenChange={setLevelOpen}
          onValueChange={(level) => {
            if (level !== model.level) onChange({ ...model, level });
          }}
          open={disabled ? false : levelOpen}
          option={face.thoughtOption}
          provider={ZCODE_AGENT_PROVIDER}
          restoreFocusSelector={null}
          showInvalidCurrentValue
          triggerClassName={cn(WORKFLOW_ASK_CHIP_CLASS_NAME, changed && "font-medium")}
          triggerRef={levelTriggerRef}
        />
      )}
      {changed ? (
        <WorkflowAskWasTail
          disabled={disabled}
          onReset={onReset}
          testId="workflow-permission-settings-model"
          value={labelOf(initial).text}
        />
      ) : null}
    </div>
  );
}

const MODEL_ITEM_NEVER_LOCKED = () => false;
