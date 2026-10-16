// 「保存工作流」弹层里细线之下的那一半（docs/dynamic-workflow/transcript-and-notifications.md
// 「The popover」）：三个字段、一句后果、一枚「直接保存」。
//
// 与弹层壳分文件只为守住 400 行的门；这里不持有任何状态，全部由 WorkflowSavePopover 传进来。
import type { RefObject } from "react";
import { FolderIcon, GlobeIcon } from "lucide-react";
import type { ZCodeSavedWorkflowScope } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Spinner } from "@/components/ui/spinner.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";
import { SAVED_WORKFLOW_NAME_MAX_CHARS, type WorkflowSaveDraft } from "./workflowRunSave.js";

/** agent 拒绝了这一次保存：`reason` 是词表里的原因，`detail` 是它带回来的诊断（已有界）。 */
export interface WorkflowSaveFailure {
  reason: string;
  detail?: string;
}

export function WorkflowSaveFields({
  draft,
  failure,
  nameInvalid,
  nameRef,
  onDirectSave,
  pathPreview,
  saving,
  scopeLocked,
  shadowing,
  showDivider,
  submitDisabled,
  submitLabel,
  taken,
  update,
}: {
  draft: WorkflowSaveDraft;
  failure: WorkflowSaveFailure | undefined;
  nameInvalid: boolean;
  nameRef: RefObject<HTMLInputElement | null>;
  onDirectSave: () => void;
  pathPreview: string;
  saving: boolean;
  scopeLocked: boolean;
  /** 另一个作用域也占着这个名字：遮蔽会发生，在点下去之前说出来。 */
  shadowing: boolean;
  showDivider: boolean;
  submitDisabled: boolean;
  submitLabel: string;
  taken: boolean;
  update: (next: Partial<WorkflowSaveDraft>) => void;
}) {
  const { intl } = useZCodeIntl();
  const format = (id: string, values?: Record<string, string>) =>
    intl.formatMessage({ id }, values);
  return (
    <>
      {showDivider ? (
        <div className="flex items-center gap-2 text-ui-xs text-foreground-subtlest">
          <span aria-hidden className="h-px flex-1 bg-border" />
          <span>{format("chat.toolCall.workflow.saveRun.or")}</span>
          <span aria-hidden className="h-px flex-1 bg-border" />
        </div>
      ) : null}
      <div className="flex flex-col gap-1">
        <label className="text-ui-sm text-foreground-subtle" htmlFor="workflow-save-name">
          {format("chat.toolCall.workflow.saveRun.name")}
        </label>
        <div className="relative">
          <Input
            aria-invalid={nameInvalid}
            className="pr-16 font-mono"
            data-testid="workflow-save-name"
            disabled={saving}
            id="workflow-save-name"
            maxLength={SAVED_WORKFLOW_NAME_MAX_CHARS}
            onChange={(event) => update({ name: event.target.value })}
            placeholder={format("chat.toolCall.workflow.saveRun.name.placeholder")}
            ref={nameRef}
            value={draft.name}
          />
          {/* 后缀是**事实**不是输入：名字是文件名，扩展名由保存路径决定，用户不该也不能改它。 */}
          <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center font-mono text-ui-xs text-foreground-subtlest">
            .dwf.ts
          </span>
        </div>
        <p
          className={cn(
            "text-ui-xs",
            nameInvalid ? "text-destructive" : "text-foreground-subtlest",
          )}
          data-testid="workflow-save-name-helper"
        >
          {format(
            nameInvalid
              ? "chat.toolCall.workflow.saveRun.name.invalid"
              : "chat.toolCall.workflow.saveRun.name.helper",
          )}
        </p>
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-ui-sm text-foreground-subtle">
          {format("chat.toolCall.workflow.save.scope.label")}
        </span>
        <Select
          disabled={scopeLocked || saving}
          onValueChange={(value) => update({ scope: value as ZCodeSavedWorkflowScope })}
          value={draft.scope}
        >
          <SelectTrigger className="w-full" data-testid="workflow-save-scope">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {/* 图标说的是「落在哪」：文件夹是这个项目，地球是这台机器上的每个项目。 */}
            <SelectItem value="project">
              <FolderIcon aria-hidden className="size-3.5 text-foreground-subtle" />
              {format("chat.toolCall.workflow.save.scope.project")}
            </SelectItem>
            <SelectItem value="global">
              <GlobeIcon aria-hidden className="size-3.5 text-foreground-subtle" />
              {format("chat.toolCall.workflow.save.scope.global")}
            </SelectItem>
          </SelectContent>
        </Select>
        {scopeLocked ? (
          <p className="text-ui-xs text-foreground-subtlest">
            {format("chat.toolCall.workflow.saveRun.scope.remoteOnly")}
          </p>
        ) : null}
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-ui-sm text-foreground-subtle" htmlFor="workflow-save-description">
          {format("chat.toolCall.workflow.saveRun.description")}
        </label>
        <SettingsFormTextarea
          className="min-h-14"
          data-testid="workflow-save-description"
          disabled={saving}
          id="workflow-save-description"
          onChange={(event) => update({ description: event.target.value })}
          value={draft.description}
        />
        <p className="text-ui-xs text-foreground-subtlest">
          {format("chat.toolCall.workflow.saveRun.description.helper")}
        </p>
      </div>
      <WorkflowSaveConsequence
        failure={failure}
        pathPreview={pathPreview}
        scope={draft.scope}
        shadowing={shadowing}
        taken={taken}
      />
      <div className="flex justify-end">
        <Button
          data-testid="workflow-save-submit"
          disabled={submitDisabled}
          onClick={onDirectSave}
          type="button"
          variant="outline"
        >
          {saving ? <Spinner className="size-3.5" /> : null}
          {submitLabel}
        </Button>
      </div>
    </>
  );
}

/**
 * 同一个位置的三选一：agent 的拒绝 → 覆盖警告 → 一句后果。拒绝在场时弹层不关，因为一个字节
 * 都没写；覆盖警告与后果句都会在另一个作用域也占着这个名字时补上遮蔽那一句（与 SaveWorkflow
 * 卡同一句话）——遮蔽与覆盖是两件事，只说其中一件会让用户以为另一件不会发生。
 */
function WorkflowSaveConsequence({
  failure,
  pathPreview,
  scope,
  shadowing,
  taken,
}: {
  failure: WorkflowSaveFailure | undefined;
  pathPreview: string;
  scope: ZCodeSavedWorkflowScope;
  shadowing: boolean;
  taken: boolean;
}) {
  const { intl } = useZCodeIntl();
  const format = (id: string, values?: Record<string, string>) =>
    intl.formatMessage({ id }, values);
  // 遮蔽那一句借 SaveWorkflow 卡的原词（它本身不带句号），句号随语言由词条补上。
  const shadowingText = shadowing
    ? format("chat.toolCall.workflow.saveRun.shadowing", {
        text: format(
          scope === "global"
            ? "chat.toolCall.workflow.save.scope.hiddenByProject"
            : "chat.toolCall.workflow.save.scope.hidesGlobal",
        ),
      })
    : null;
  if (failure !== undefined) {
    return (
      <div className="text-ui-xs text-warning" data-testid="workflow-save-failure" role="status">
        <span>{format(`chat.toolCall.workflow.saveRun.error.${failure.reason}`)}</span>
        {failure.detail === undefined ? null : (
          <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap font-mono text-ui-xs text-foreground-subtle">
            {failure.detail}
          </pre>
        )}
      </div>
    );
  }
  if (taken) {
    return (
      <div
        className="rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-2 text-ui-sm leading-snug text-foreground-subtle"
        data-testid="workflow-save-overwrite"
      >
        {format("chat.toolCall.workflow.saveRun.overwrite")}
        {shadowingText === null ? null : ` ${shadowingText}`}
      </div>
    );
  }
  // 路径是技术值，要等宽排印（DESIGN.md 把 font-mono 留给技术值）；词条引擎只收字符串，所以
  // 用一个不会出现在文案里的占位符把句子切成前后两段，再把路径以 <code> 嵌回去。
  const [before, after = ""] = format("chat.toolCall.workflow.saveRun.consequence", {
    path: PATH_SLOT,
  }).split(PATH_SLOT);
  return (
    <p
      className="text-ui-sm leading-snug text-foreground-subtle"
      data-testid="workflow-save-consequence"
    >
      {before}
      <code className="font-mono text-ui-xs">{pathPreview}</code>
      {after}
      {shadowingText === null ? null : ` ${shadowingText}`}
    </p>
  );
}

/** 路径在句子里的占位：NUL 不会出现在任何词条里。 */
const PATH_SLOT = "\u0000";
