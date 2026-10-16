// ============================================================
// 确认窗两句设置的零件（docs/dynamic-workflow/presentation.md「The confirmation window」）
// ============================================================
// 从 WorkflowAskSettingsLines.tsx 拆出（max-lines 门）：两句共用的类名与「· 原为 X ↺」尾巴、上界那一句、
// 以及块缺席（旧 agent）时的纯文本条件行。状态都在 WorkflowAskSettings 里，这里的组件只收烹熟的值。

import { MinusIcon, PlusIcon, Undo2Icon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { clampWorkflowRunSettingsBound } from "./workflowRunSettings.js";

/** 句中的值画成一枚芯片：平时是一小块 surface，悬停才出边框与输入底色（composer 模型触发器的语汇）。 */
export const WORKFLOW_ASK_CHIP_CLASS_NAME =
  "h-6 min-w-0 max-w-[260px] gap-1 rounded-md border border-transparent bg-surface pl-[7px] pr-1 text-ui-sm text-foreground hover:border-border-hover hover:bg-input focus-visible:border-input-border-focused data-[state=open]:border-border-hover data-[state=open]:bg-input [&_svg]:size-3";
export const WORKFLOW_ASK_LINE_CLASS_NAME =
  "flex min-h-6 min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-ui-sm text-foreground-subtle";
export const WORKFLOW_ASK_TAIL_CLASS_NAME = "text-foreground-subtlest";

/** 「· 原为 X ↺」：改过的那一行才有；↺ 把这一行放回起点。 */
export function WorkflowAskWasTail({
  disabled,
  onReset,
  testId,
  value,
}: {
  disabled: boolean;
  onReset: () => void;
  testId: string;
  value: string;
}) {
  const { intl } = useZCodeIntl();
  const resetLabel = intl.formatMessage({ id: "chat.permission.workflow.settings.reset" });
  // 按钮只有图标：aria-label 给读屏，title 给悬停（spec：「恢复原值」）。
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-0.5", WORKFLOW_ASK_TAIL_CLASS_NAME)}>
      <span className="min-w-0 truncate" data-testid={`${testId}-was`}>
        · {intl.formatMessage({ id: "chat.permission.workflow.settings.was" }, { value })}
      </span>
      <Button
        aria-label={resetLabel}
        className="text-foreground-subtlest hover:text-foreground"
        data-testid={`${testId}-reset`}
        disabled={disabled}
        onClick={onReset}
        size="icon-xs"
        title={resetLabel}
        type="button"
        variant="ghost"
      >
        <Undo2Icon className="size-3" />
      </Button>
    </span>
  );
}

export function WorkflowAskBoundLine({
  bound,
  changed,
  defaultConcurrency,
  disabled,
  initial,
  onChange,
  onReset,
}: {
  bound: number | null;
  changed: boolean;
  /** 默认并发 D：只用来写「· 默认 N」与判「= 默认」，不是步进器的上界。 */
  defaultConcurrency: number | undefined;
  disabled: boolean;
  initial: number | null;
  onChange: (bound: number) => void;
  onReset: () => void;
}) {
  const { intl } = useZCodeIntl();
  const format = intl.formatMessage.bind(intl);
  const tail =
    defaultConcurrency === undefined
      ? bound === null
        ? format({ id: "chat.permission.workflow.settings.limit.none" })
        : undefined
      : bound === defaultConcurrency
        ? format({ id: "chat.toolCall.workflow.run.settings.limit.atDefault" })
        : format(
            { id: "chat.toolCall.workflow.run.settings.limit.default" },
            { n: defaultConcurrency },
          );
  const initialText =
    initial === null
      ? format({ id: "chat.permission.workflow.settings.limit.none" })
      : String(initial);
  return (
    <div
      className={WORKFLOW_ASK_LINE_CLASS_NAME}
      data-changed={changed ? "true" : undefined}
      data-testid="workflow-permission-settings-bound"
    >
      <span>{format({ id: "chat.permission.workflow.settings.limit.lead" })}</span>
      <InputGroup className="h-6 w-auto shrink-0">
        <InputGroupAddon align="inline-start">
          <InputGroupButton
            aria-label={format({ id: "chat.toolCall.workflow.run.settings.limit.decrease" })}
            data-testid="workflow-permission-settings-bound-decrease"
            disabled={disabled || bound === null || bound <= 1}
            onClick={() => bound !== null && onChange(clampWorkflowRunSettingsBound(bound - 1))}
            size="icon-xs"
          >
            <MinusIcon className="size-3" />
          </InputGroupButton>
        </InputGroupAddon>
        <InputGroupInput
          aria-label={format({ id: "chat.toolCall.workflow.run.settings.limit" })}
          className={cn(
            "h-6 w-[30px] px-0 text-center font-mono text-ui-sm tabular-nums",
            changed && "font-medium",
          )}
          data-testid="workflow-permission-settings-bound-value"
          disabled={disabled}
          inputMode="numeric"
          onChange={(event) => {
            const parsed = Number.parseInt(event.target.value, 10);
            if (Number.isFinite(parsed)) onChange(clampWorkflowRunSettingsBound(parsed));
          }}
          placeholder="—"
          value={bound === null ? "" : String(bound)}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            aria-label={format({ id: "chat.toolCall.workflow.run.settings.limit.increase" })}
            data-testid="workflow-permission-settings-bound-increase"
            disabled={disabled || bound === null}
            onClick={() => bound !== null && onChange(clampWorkflowRunSettingsBound(bound + 1))}
            size="icon-xs"
          >
            <PlusIcon className="size-3" />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      <span>{format({ id: "chat.permission.workflow.settings.limit.trail" })}</span>
      {tail === undefined ? null : (
        <span
          className={WORKFLOW_ASK_TAIL_CLASS_NAME}
          data-testid="workflow-permission-settings-bound-tail"
        >
          · {tail}
        </span>
      )}
      {changed ? (
        <WorkflowAskWasTail
          disabled={disabled}
          onReset={onReset}
          testId="workflow-permission-settings-bound"
          value={initialText}
        />
      ) : null}
    </div>
  );
}

/**
 * 块缺席时的纯文本条件行（旧 agent）：只有调用设了的字段，模型在上、上界在下，`text-ui-xs` 最淡色。
 * 与可调的两行同一个次序，好让新旧两种窗读起来是同一件事。模型说解析好的名字，规范串只进 tooltip。
 */
export function WorkflowAskPlainSettings({
  maxConcurrency,
  scriptNamesModels = false,
  subagentModel,
}: {
  maxConcurrency: number | undefined;
  /** 脚本给某些子代理点名了模型：模型那一句说「默认」（它不再替每一个子代理说话）。 */
  scriptNamesModels?: boolean;
  subagentModel: { text: string; tooltip: string } | undefined;
}) {
  const { intl } = useZCodeIntl();
  if (maxConcurrency === undefined && subagentModel === undefined) return null;
  return (
    <div className="space-y-1">
      {subagentModel === undefined ? null : (
        <p
          className="min-w-0 text-ui-xs text-foreground-subtlest"
          data-testid="workflow-permission-subagent-model"
          title={subagentModel.tooltip}
        >
          {intl.formatMessage(
            {
              id: scriptNamesModels
                ? "chat.permission.workflow.subagentModelDefault"
                : "chat.permission.workflow.subagentModel",
            },
            { model: subagentModel.text },
          )}
        </p>
      )}
      {maxConcurrency === undefined ? null : (
        <p
          className="min-w-0 text-ui-xs text-foreground-subtlest"
          data-testid="workflow-permission-max-concurrency"
        >
          {intl.formatMessage(
            { id: "chat.permission.workflow.maxConcurrency" },
            { count: String(maxConcurrency) },
          )}
        </p>
      )}
    </div>
  );
}
