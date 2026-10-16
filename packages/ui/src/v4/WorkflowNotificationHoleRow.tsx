import { Pen } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { WorkflowNotificationMeta, WorkflowRunHole } from "@zcode/shared/zcode-protocol-v4";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { workflowRunQuestionWaitedLabel } from "@/app-shell/workflowRunQuestions.js";

/**
 * 留白通知行（docs/dynamic-workflow/transcript-and-notifications.md「The notification row」的 hole 一行、
 * 「The hole row's live state」）。从 WorkflowNotificationToolRow.tsx 拆出（max-lines 门）：同一套
 * ToolLayout 语法，笔图标，种类词按 run 投影的 `holes` 活翻转——
 *   run 在场且此 siteId 是 waiting → 「工作流留白 · 等待补全」，等待时长每 30 秒刷一次；
 *   run 在场且已 filled → 「留白已补全」；
 *   run 不在投影里（`holes` 缺席）→ 中性的「工作流留白」。
 * 主文本 `· <run 名> · <留白名>` 加类型徽标；展开体是提示全文、它站在哪两站之间、须返回什么、草稿
 * 路径、等了多久、run 链接。**永不 shimmer**：留白等的是主代理，不是工作。体不引用补全代码——那在相邻
 * 的 FillWorkflowHole 工具卡上。
 */
export type WorkflowHoleNotification = Extract<WorkflowNotificationMeta, { kind: "hole" }>;

export type HoleRowState = "waiting" | "filled" | "left";

export function holeRowState(
  holes: readonly WorkflowRunHole[] | undefined,
  siteId: string,
): HoleRowState {
  if (holes === undefined) return "left";
  const hole = holes.find((candidate) => candidate.siteId === siteId);
  if (hole === undefined) return "left";
  return hole.state === "waiting" ? "waiting" : "filled";
}

const KIND_LABEL_ID: Record<HoleRowState, string> = {
  waiting: "chat.backgroundResult.workflow.hole.waiting",
  filled: "chat.backgroundResult.workflow.hole.filled",
  left: "chat.backgroundResult.workflow.hole.left",
};

const HOLE_ICON = <Pen className="size-4 shrink-0 text-foreground-subtle" />;

const PANEL_CLASS =
  "whitespace-pre-wrap break-words rounded-lg border border-border bg-panel px-4 py-3 text-ui-base leading-5 text-foreground";

export function WorkflowNotificationHoleRow({
  forceOpen = false,
  holes,
  notification,
  onOpenRun,
  runName,
  toolId,
}: {
  notification: WorkflowHoleNotification;
  runName: string;
  toolId: string;
  /** run 投影里的留白表；undefined = run 不在活投影（中性词）。 */
  holes: readonly WorkflowRunHole[] | undefined;
  onOpenRun?: () => void;
  forceOpen?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const state = holeRowState(holes, notification.siteId);

  // 等待时长要在没有事件流时也照走（停驻的 run 恰恰不发事件），30 秒喂一次新的「现在」；只在等待时走。
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (state !== "waiting") return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [state]);
  const waited =
    state === "waiting"
      ? workflowRunQuestionWaitedLabel(notification.reachedAt, now, (descriptor, values) =>
          intl.formatMessage(descriptor, values),
        )
      : undefined;

  const primaryText = useMemo(
    () => (
      <span className="inline-flex min-w-0 items-center gap-2">
        <span aria-hidden>·</span>
        <span className="min-w-0 truncate">{runName}</span>
        <span aria-hidden>·</span>
        <span className="min-w-0 truncate" data-testid="workflow-hole-notification-name">
          {notification.name}
        </span>
      </span>
    ),
    [notification.name, runName],
  );

  const renderContent = useCallback(() => {
    const { after, before, draftPath, line, prompt } = notification;
    const standsId =
      before !== undefined && after !== undefined
        ? "chat.toolCall.workflow.hole.stands.between"
        : before !== undefined
          ? "chat.toolCall.workflow.hole.stands.after"
          : after !== undefined
            ? "chat.toolCall.workflow.hole.stands.before"
            : undefined;
    return (
      <div className="space-y-3" data-testid="workflow-hole-notification-body">
        {prompt === undefined || prompt.length === 0 ? null : (
          <p className={PANEL_CLASS}>{prompt}</p>
        )}
        <p className="text-ui-sm text-foreground-subtle">
          {standsId === undefined
            ? null
            : intl.formatMessage({ id: standsId }, { before: before ?? "", after: after ?? "" })}
        </p>
        {draftPath === undefined ? null : (
          <p className="text-ui-sm text-foreground-subtle">
            <span className="text-foreground-subtlest">
              {intl.formatMessage({ id: "chat.toolCall.workflow.hole.draftPath" })}
            </span>{" "}
            <span className="font-mono" data-testid="workflow-hole-notification-draft">
              {line === undefined ? draftPath : `${draftPath}:L${line}`}
            </span>
          </p>
        )}
        {waited ? (
          <p
            className="text-ui-sm text-foreground-subtle"
            data-testid="workflow-hole-notification-waited"
          >
            {intl.formatMessage({ id: "chat.toolCall.workflow.hole.waited" }, { time: waited })}
          </p>
        ) : null}
        {onOpenRun ? (
          <button
            type="button"
            onClick={onOpenRun}
            className="text-ui-sm text-foreground-subtle decoration-dotted underline-offset-2 hover:text-foreground hover:underline"
          >
            {intl.formatMessage({ id: "chat.toolCall.workflow.openRunDetails" })}
          </button>
        ) : null}
      </div>
    );
  }, [intl, notification, onOpenRun, waited]);

  return (
    <div data-testid={toolId} data-hole-state={state}>
      <ToolLayout
        toolId={toolId}
        persistOpenKey={toolId}
        icon={HOLE_ICON}
        canToggle
        forceOpen={forceOpen}
        kindLabel={intl.formatMessage({ id: KIND_LABEL_ID[state] })}
        primaryText={primaryText}
        title={runName}
        renderContent={renderContent}
      />
    </div>
  );
}
