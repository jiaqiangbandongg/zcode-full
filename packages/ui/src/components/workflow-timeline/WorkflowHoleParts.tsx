import { PenIcon } from "lucide-react";
import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { TimelineHole } from "./timeline-holes.js";

/**
 * 留白的小零件（docs/dynamic-workflow/presentation.md「Holes on the timeline」），卡、侧板与工具行共用：
 * 无阶段补全后站名旁的笔标（它的头）、等待中的元数据词「等待补全」、表头与侧板的「{n} 处留白待补全」芯片。
 *
 * 留白的类型（`hole<T>` 的 T）**不在任何界面上出现**：它是编译器与主代理之间的契约，不是用户要读
 * 的东西。2026-09-28 的实测里它曾作为等宽徽标挂在站名之后：`{ target: string; reason: string }`
 * 这样的原文把站头撑满、站名被挤到零宽——所以这里只剩名字。
 */
export function HoleFillMark({ className, holeId }: { className?: string; holeId: string }) {
  // 笔标就是无阶段补全的头（presentation.md「Filled without phases」）：指针落在它上面，时间线与侧板
  // 画出这一站的框（`data-fill-head`）。
  return (
    <span
      className={cn(
        "inline-flex h-4 shrink-0 items-center rounded-sm bg-tag px-1 text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground",
        className,
      )}
      data-fill-head={holeId}
      data-testid="workflow-hole-fill-mark"
    >
      <PenIcon aria-hidden className="size-2.5" />
    </span>
  );
}

/** 站头右侧的「等待补全」：警示色、不换行；只在 run 停在这处留白上时出现。 */
export function HoleWaitingMeta({ hole }: { hole: TimelineHole | undefined }) {
  const { intl } = useZCodeIntl();
  if (hole?.state !== "waiting") return null;
  return (
    <span
      className="shrink-0 whitespace-nowrap text-ui-xs text-warning"
      data-testid="workflow-hole-waiting"
    >
      {intl.formatMessage({ id: "chat.toolCall.workflow.hole.waiting" })}
    </span>
  );
}

/** 侧板状态头的同一枚芯片：直接读 run 的留白表，数等待中的。 */
export function RunHolesWaitingChip({
  run,
  testId,
}: {
  run: Pick<WorkflowRunState, "holes"> | undefined;
  testId: string;
}) {
  const count = (run?.holes ?? []).filter((hole) => hole.state === "waiting").length;
  return <HolesWaitingChip count={count} testId={testId} />;
}

/**
 * 「{n} 处留白待补全」芯片（run 卡表头、侧板状态头）：笔图标，落在问题芯片的槽位上；两枚可以同时在。
 * 与问题芯片同一副面孔（警示色 12% 底、`text-ui-xs`），可点时开 run 详情。
 */
export function HolesWaitingChip({
  count,
  onOpen,
  testId = "workflow-digest-holes",
}: {
  count: number;
  onOpen?: () => void;
  testId?: string;
}) {
  const { intl } = useZCodeIntl();
  if (count <= 0) return null;
  const label = intl.formatMessage(
    {
      id:
        count === 1 ? "chat.toolCall.workflow.digest.hole" : "chat.toolCall.workflow.digest.holes",
    },
    { count },
  );
  const face =
    "wf-arrive flex shrink-0 items-center gap-1 rounded-full bg-[color-mix(in_oklab,var(--color-warning)_12%,transparent)] py-0.5 pl-1.5 pr-2 text-ui-xs font-medium text-warning";
  return onOpen === undefined ? (
    <span className={face} data-testid={testId}>
      <PenIcon aria-hidden className="size-3" />
      {label}
    </span>
  ) : (
    <button
      className={cn(
        face,
        "cursor-pointer outline-none transition-colors hover:bg-[color-mix(in_oklab,var(--color-warning)_20%,transparent)] focus-visible:ring-2 focus-visible:ring-ring/40",
      )}
      data-testid={testId}
      onClick={onOpen}
      type="button"
    >
      <PenIcon aria-hidden className="size-3" />
      {label}
    </button>
  );
}
