// 完成卡「保存」弹层（docs/dynamic-workflow/transcript-and-notifications.md「The popover」）。
//
// 两条路按**价值**排序而不是按成本：先是整条宽的「让 ZCode 帮我提炼保存」，一条细线之下才是
// 「按原样直接保存」的三个字段。刚跑完的脚本是一次性的，把两次运行之间会变的值抽成 args、写清
// 说明与使用时机——这件事只有读过脚本的人能做，所以它排在第一位。
//
// 三个字段服务于两条路：填了什么，既随消息交给 ZCode，也是直接保存要写下去的那一份。
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { SparkleIcon } from "lucide-react";
import type { ZCodeSavedWorkflowScope, ZCodeWorkflowsSaveResult } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverAnchor, PopoverContent, PopoverTitle } from "@/components/ui/popover.js";
import { Spinner } from "@/components/ui/spinner.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { WorkflowSaveFields, type WorkflowSaveFailure } from "./WorkflowSaveFields.js";
import {
  initialWorkflowSaveDraft,
  isValidSavedWorkflowNameText,
  savedWorkflowPathPreview,
  type WorkflowSaveDraft,
} from "./workflowRunSave.js";

/** 占用探测的合并窗：每敲一个字符都查一次磁盘没有意义，人停下来那一刻才有。 */
const NAME_PROBE_DEBOUNCE_MS = 320;

export interface WorkflowSavePopoverHost {
  /** 弹层打开那一刻用来预填名字与说明。 */
  runName?: string;
  /** 老 agent 没有 `workflows/save`：只留 ZCode 那条路。 */
  directSaveUnsupported: boolean;
  /** 远程项目不给全局档：`~` 在 agent 机器上，中枢从不读它。 */
  scopeLocked: boolean;
  saving: boolean;
  save: (input: {
    name: string;
    scope: ZCodeSavedWorkflowScope;
    meta: { description: string };
    overwrite?: boolean;
  }) => Promise<ZCodeWorkflowsSaveResult>;
  checkNameTaken: (name: string, scope: ZCodeSavedWorkflowScope) => Promise<boolean>;
  /**
   * 把那条用户消息发出去（宿主各有各的发送路径：卡在本会话，侧板在父会话）。
   * 缺席即这条路不可达——弹层只剩细线之下的那一半。
   */
  sendLead?: (draft: WorkflowSaveDraft) => Promise<void>;
  /** 写成之后：父级据此翻成「再次运行」并播一次 aria-live。 */
  onSaved: (saved: { name: string; scope: ZCodeSavedWorkflowScope }) => void;
}

export function WorkflowSavePopover({
  anchorRef,
  host,
  onOpenChange,
  open,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  host: WorkflowSavePopoverHost;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor virtualRef={anchorRef as RefObject<HTMLElement>} />
      <PopoverContent
        align="end"
        // 手机上卡片窄于弹层：离屏幕边留 8px，宽度不超出视口（320px 的屏也放得下）。
        className="w-80 max-w-[calc(100vw-16px)] gap-2.5"
        collisionPadding={8}
        data-testid="workflow-save-popover"
        // 同「配置」弹层：portal 在外、React 事件仍沿组件树冒泡，不拦的话点空白处会被卡当成点卡身。
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") event.stopPropagation();
        }}
        onInteractOutside={(event) => {
          const target = event.target;
          if (target instanceof Node && anchorRef.current?.contains(target)) event.preventDefault();
        }}
      >
        {/* 开着才挂载：草稿的起点因此是**这一次**打开那一刻，关掉即丢弃（Esc 的语义）。 */}
        {open ? <WorkflowSaveForm host={host} onClose={() => onOpenChange(false)} /> : null}
      </PopoverContent>
    </Popover>
  );
}

function WorkflowSaveForm({
  host,
  onClose,
}: {
  host: WorkflowSavePopoverHost;
  onClose: () => void;
}) {
  const { intl } = useZCodeIntl();
  const format = useCallback((id: string) => intl.formatMessage({ id }), [intl]);
  // 起点在打开那一刻定下（同「配置」弹层）：run 在弹层开着时变了，也不该把用户正在改的表单拽回去。
  const [draft, setDraft] = useState<WorkflowSaveDraft>(() =>
    initialWorkflowSaveDraft({
      ...(host.runName === undefined ? {} : { runName: host.runName }),
      ...(host.scopeLocked ? { scope: "project" as const } : {}),
    }),
  );
  const [probe, setProbe] = useState({ taken: false, shadowing: false });
  const [failure, setFailure] = useState<WorkflowSaveFailure | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const nameRef = useRef<HTMLInputElement | null>(null);

  // 打开即聚焦名字框（Tab 顺序仍是 lead → 名字 → 作用域 → 说明 → 直接保存）。
  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const name = draft.name.trim();
  const nameInvalid = name.length > 0 && !isValidSavedWorkflowNameText(name);
  const canDirectSave =
    !host.directSaveUnsupported && name.length > 0 && !nameInvalid && !host.saving;

  const { checkNameTaken, directSaveUnsupported, scopeLocked } = host;
  const { scope } = draft;
  // 占用探测：合并 320 ms，两个作用域一起问——目标那个决定「覆盖」，另一个决定「遮蔽」。
  // 名字或作用域一变先把结论作废，免得旧答案留在新名字上。
  useEffect(() => {
    setProbe({ taken: false, shadowing: false });
    if (directSaveUnsupported || name.length === 0 || !isValidSavedWorkflowNameText(name)) return;
    let cancelled = false;
    const other: ZCodeSavedWorkflowScope = scope === "global" ? "project" : "global";
    const timer = window.setTimeout(() => {
      void Promise.all([
        checkNameTaken(name, scope),
        // 远程项目只有项目档这一档，另一档问了也没有意义（中枢从不读 agent 机器的 `~`）。
        scopeLocked ? Promise.resolve(false) : checkNameTaken(name, other),
      ]).then(([taken, shadowing]) => {
        if (!cancelled) setProbe({ taken, shadowing });
      });
    }, NAME_PROBE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [checkNameTaken, directSaveUnsupported, name, scope, scopeLocked]);

  const update = (next: Partial<WorkflowSaveDraft>) => {
    setDraft((current) => ({ ...current, ...next }));
    setFailure(undefined);
  };

  const handleLead = () => {
    if (host.sendLead === undefined || sending || host.saving) return;
    setSending(true);
    void host.sendLead({ ...draft, name }).then(
      () => onClose(),
      () => setSending(false),
    );
  };

  const handleDirectSave = () => {
    if (!canDirectSave) return;
    setFailure(undefined);
    void host
      .save({
        name,
        scope,
        // 说明空着就退回名字：中枢的卡片上那一行不能是空的。
        meta: { description: draft.description.trim() || name },
        ...(probe.taken ? { overwrite: true } : {}),
      })
      .then(
        (result) => {
          if (result.ok) {
            host.onSaved({ name: result.name, scope: result.scope });
            onClose();
            return;
          }
          // 目标已存在：不是失败，是还没确认过覆盖——把警告摆出来，按钮改成「覆盖并直接保存」。
          if (result.reason === "target_exists") {
            setProbe((current) => ({ ...current, taken: true }));
            return;
          }
          setFailure({
            reason: result.reason,
            ...(result.detail === undefined ? {} : { detail: result.detail }),
          });
        },
        (error: unknown) => {
          setFailure({
            reason: "generic",
            detail: error instanceof Error ? error.message : String(error),
          });
        },
      );
  };

  const pathPreview = useMemo(
    () => savedWorkflowPathPreview(scope, name.length > 0 ? name : "…"),
    [name, scope],
  );
  const submitLabel = host.saving
    ? format("chat.toolCall.workflow.saveRun.submit.saving")
    : probe.taken
      ? format("chat.toolCall.workflow.saveRun.submit.overwrite")
      : format("chat.toolCall.workflow.saveRun.submit");

  return (
    <div
      className="flex flex-col gap-2.5"
      // `⌘↩` / `Ctrl↩` 从任何一个字段触发那条主路径：弹层的主张就是那一枚钮。
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          handleLead();
        }
      }}
    >
      <PopoverTitle>{format("chat.toolCall.workflow.saveRun.title")}</PopoverTitle>
      {host.sendLead === undefined ? null : (
        <div className="flex flex-col gap-1.5">
          <Button
            className="h-8 w-full"
            data-icon="inline-start"
            data-testid="workflow-save-lead"
            disabled={sending || host.saving}
            onClick={handleLead}
            type="button"
          >
            {sending ? <Spinner className="size-3.5" /> : <SparkleIcon className="size-3.5" />}
            {format(
              sending
                ? "chat.toolCall.workflow.saveRun.lead.sending"
                : "chat.toolCall.workflow.saveRun.lead",
            )}
          </Button>
          <p className="text-ui-sm leading-snug text-foreground-subtle">
            {format("chat.toolCall.workflow.saveRun.lead.hint")}
            {host.directSaveUnsupported
              ? ` ${format("chat.toolCall.workflow.saveRun.lead.unsupported")}`
              : ""}
          </p>
        </div>
      )}
      {host.directSaveUnsupported ? null : (
        <WorkflowSaveFields
          draft={draft}
          failure={failure}
          nameInvalid={nameInvalid}
          nameRef={nameRef}
          onDirectSave={handleDirectSave}
          pathPreview={pathPreview}
          saving={host.saving}
          scopeLocked={host.scopeLocked}
          shadowing={probe.shadowing}
          showDivider={host.sendLead !== undefined}
          submitDisabled={!canDirectSave}
          submitLabel={submitLabel}
          taken={probe.taken}
          update={update}
        />
      )}
    </div>
  );
}
