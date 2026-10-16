import { memo, useCallback } from "react";
import {
  TID_V4_BACKGROUND_WORKS,
  TID_V4_BACKGROUND_WORK_CANCEL,
  TID_V4_BACKGROUND_WORK_ITEM,
  testId,
} from "@zcode/shared";
import type { BackgroundWorkSummary } from "@zcode/shared/zcode-protocol-v4";
import { runUserAction } from "@/lib/userActionTelemetry.js";

export interface ConversationBackgroundWorksProps {
  works: readonly BackgroundWorkSummary[];
  /** M4 cancelBackgroundWork：取消某后台工作（仅 running 可取消）。 */
  onCancel: (workId: string) => void;
}

/**
 * M4 后台工作面板：渲染 projection.backgroundWorks + running 项 cancel 入口。
 * memo：works 不变时不随 pane 其他状态重渲染（回调由父层 useCallback 稳定）。
 */
function ConversationBackgroundWorksImpl({
  works,
  onCancel,
}: ConversationBackgroundWorksProps) {
  if (works.length === 0) return null;
  return (
    <div
      data-testid={TID_V4_BACKGROUND_WORKS}
      className="border-t border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2"
    >
      <div className="mb-1 text-ui-sm text-[var(--color-foreground-subtle)]">
        后台工作 · {works.length}
      </div>
      <ul className="flex flex-col gap-1">
        {works.map((work) => (
          <BackgroundWorkRow key={work.workId} work={work} onCancel={onCancel} />
        ))}
      </ul>
    </div>
  );
}

/** 单项抽成 memo 组件，避免整表随任一项变化全量重渲染。 */
const BackgroundWorkRow = memo(function BackgroundWorkRow({
  work,
  onCancel,
}: {
  work: BackgroundWorkSummary;
  onCancel: (workId: string) => void;
}) {
  return (
    <li
      data-testid={testId(TID_V4_BACKGROUND_WORK_ITEM, work.workId)}
      data-work-id={work.workId}
      data-work-status={work.status}
      className="flex items-center justify-between gap-2 rounded border border-[var(--color-border)] px-2 py-1 text-ui-sm"
    >
      <span className="min-w-0 flex-1 truncate text-[var(--color-foreground)]">
        {work.kind} · {work.title}
      </span>
      <span className="shrink-0 text-[var(--color-foreground-subtle)]">
        {work.status}
      </span>
      {work.status === "running" ? (
        <CancelButton workId={work.workId} onCancel={onCancel} />
      ) : null}
    </li>
  );
});

/** cancel 按钮抽出，内部封装 workId 闭包，父传稳定 onCancel。 */
const CancelButton = memo(function CancelButton({
  workId,
  onCancel,
}: {
  workId: string;
  onCancel: (workId: string) => void;
}) {
  const handleClick = useCallback(
    () =>
      runUserAction({
        input: { featureId: "conversation.background_work", action: "cancel", trigger: "button" },
        operation: () => onCancel(workId),
        completed: { resultSource: "optimistic_projection" },
        failureStage: "background_work_cancel",
      }),
    [onCancel, workId],
  );
  return (
    <button
      type="button"
      data-testid={testId(TID_V4_BACKGROUND_WORK_CANCEL, workId)}
      onClick={handleClick}
      className="shrink-0 rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[var(--color-danger)] hover:bg-[var(--color-surface-hover)]"
    >
      取消
    </button>
  );
});

export const ConversationBackgroundWorks = memo(
  ConversationBackgroundWorksImpl,
);
