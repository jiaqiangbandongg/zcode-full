// 工作流运行的迷你轨道（docs/dynamic-workflow/presentation.md「The sidebar run line」）：6px 灯按
// 声明序排开，之间是 6×1px 的轨段——控制流走过的段用强色，并行的两站之间画双线段；超过六站时折到
// 运行站 ±2 并带「+n」尾。侧栏运行行与任务岛的 run 行共用这一个组件：一条 run 在两处长得一样。
import { cn } from "@/components/lib/utils.js";
import { STATUS_DOT } from "@/components/workflow-graph/run-status-presentation.js";
import type { WorkflowRunRail as WorkflowRunRailModel } from "@/lib/workflowRunLine.js";

export interface WorkflowRunRailIntl {
  formatMessage: (desc: { id: string }, values?: Record<string, string>) => string;
}

const TRACE_FAINT = "var(--color-workflow-trace)";
const TRACE_STRONG = "var(--color-workflow-trace-strong)";

export function WorkflowRunRail({
  rail,
  intl,
}: {
  rail: WorkflowRunRailModel;
  intl: WorkflowRunRailIntl;
}) {
  if (rail.implicit) {
    return (
      <span
        data-workflow-run-rail="true"
        data-implicit="true"
        className="flex shrink-0 items-center"
      >
        <span aria-hidden="true" className={cn("size-1.5 rounded-full", STATUS_DOT.running)} />
      </span>
    );
  }
  return (
    <span data-workflow-run-rail="true" className="flex shrink-0 items-center">
      {rail.stations.map((station, index) => (
        <span key={`${station.name}:${index}`} className="flex items-center">
          {index > 0 ? (
            station.twin === true ? (
              // 双线段：本站与前一站并行，控制流没有从那站走到这站。两条 1px 线相距 2px
              // （容器 4px，上下各贴一条），宽度与墨色规则与普通段完全相同。
              <span
                aria-hidden="true"
                data-rail-segment={station.reached ? "strong" : "faint"}
                data-rail-twin="true"
                className="flex h-1 w-1.5 flex-col justify-between"
              >
                <span
                  className="h-px w-full"
                  style={{ backgroundColor: station.reached ? TRACE_STRONG : TRACE_FAINT }}
                />
                <span
                  className="h-px w-full"
                  style={{ backgroundColor: station.reached ? TRACE_STRONG : TRACE_FAINT }}
                />
              </span>
            ) : (
              <span
                aria-hidden="true"
                data-rail-segment={station.reached ? "strong" : "faint"}
                className="h-px w-1.5"
                style={{ backgroundColor: station.reached ? TRACE_STRONG : TRACE_FAINT }}
              />
            )
          ) : null}
          {station.hole === undefined ? (
            <span
              aria-hidden="true"
              data-rail-station={station.status}
              title={station.name}
              className={cn("size-1.5 rounded-full", STATUS_DOT[station.status])}
            />
          ) : (
            // 留白（docs/dynamic-workflow/presentation.md「Holes on the timeline」的「The sidebar」）：
            // 虚线 6px 灯，等待时警示色。补全后它就是普通站，这一支不再走。
            <span
              aria-hidden="true"
              data-rail-station={station.status}
              data-rail-hole={station.hole}
              title={station.name}
              className={cn(
                "size-1.5 rounded-full border border-dashed bg-transparent",
                station.hole === "waiting" ? "border-warning" : "border-foreground-subtlest",
              )}
            />
          )}
        </span>
      ))}
      {rail.hidden > 0 ? (
        <span className="ml-1 text-ui-xs leading-none text-foreground-subtlest">
          {intl.formatMessage(
            { id: "taskList.workflowRun.moreStations" },
            { count: String(rail.hidden) },
          )}
        </span>
      ) : null}
    </span>
  );
}
