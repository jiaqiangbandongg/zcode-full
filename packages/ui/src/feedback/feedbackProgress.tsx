import type { FeedbackTicketStatus } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * 简化的工单流转进度（用户视角）：
 *   已提交 → 评估中 → 处理中 → 已完结
 * 「已拒绝」是单独的终态，单独高亮一条灰红色完结。
 */
type Stage = "submitted" | "reviewing" | "in_progress" | "done";

const STAGES: { key: Stage; label: string }[] = [
  { key: "submitted", label: "feedback.progress.stage.submitted" },
  { key: "reviewing", label: "feedback.progress.stage.reviewing" },
  { key: "in_progress", label: "feedback.progress.stage.inProgress" },
  { key: "done", label: "feedback.progress.stage.done" },
];

function statusToStage(status: FeedbackTicketStatus): {
  current: Stage;
  rejected: boolean;
} {
  switch (status) {
    case "已提交":
      return { current: "submitted", rejected: false };
    case "信息不足":
      return { current: "reviewing", rejected: false };
    case "已采纳":
    case "开发中":
    case "已解决":
      return { current: "in_progress", rejected: false };
    case "已上线":
    case "答复关闭":
    case "已归档":
      return { current: "done", rejected: false };
    case "已拒绝":
      return { current: "done", rejected: true };
    default:
      return { current: "submitted", rejected: false };
  }
}

export function FeedbackProgress({
  status,
  assigneeDisplay,
}: {
  status: FeedbackTicketStatus;
  assigneeDisplay?: string | null;
}) {
  const { intl } = useZCodeIntl();
  const formatMessage = intl.formatMessage;
  const { current, rejected } = statusToStage(status);
  const currentIdx = STAGES.findIndex((item) => item.key === current);
  // Bugfix: 用户侧不需要暴露具体开发同学姓名；后端仍保留真实处理人供管理员端协作。
  const assigneeLabel = assigneeDisplay
    ? formatMessage({ id: "feedback.progress.assignee.dev" })
    : formatMessage({ id: "feedback.progress.assignee.unassigned" });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 text-ui-base text-foreground-subtle">
        <span className="font-medium">
          {formatMessage({ id: "feedback.progress.title" })}
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-surface px-2.5 py-1 text-foreground-subtle">
          <span>{formatMessage({ id: "feedback.progress.currentHandler" })}</span>
          <span className="font-medium text-foreground">{assigneeLabel}</span>
        </span>
      </div>
      <ol className="grid grid-cols-4 gap-2">
        {STAGES.map((stage, idx) => {
          const reached = idx <= currentIdx;
          const isCurrent = idx === currentIdx && !rejected;
          const isRejected = rejected && idx === currentIdx;
          return (
            <li key={stage.key} className="flex flex-col gap-1.5">
              <span
                className={cn(
                  "h-1.5 w-full rounded-full transition-colors",
                  isRejected
                    ? "bg-destructive/70"
                    : reached
                      ? isCurrent
                        ? "bg-primary"
                        : "bg-primary/65"
                      : "bg-border",
                )}
              />
              <span
                className={cn(
                  "text-ui-xs leading-tight",
                  isRejected
                    ? "text-destructive"
                    : isCurrent
                      ? "font-medium text-primary"
                      : reached
                        ? "text-foreground"
                        : "text-foreground-subtle",
                )}
              >
                {isRejected && stage.key === "done"
                  ? formatMessage({ id: "feedback.progress.stage.closed" })
                  : formatMessage({ id: stage.label })}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
