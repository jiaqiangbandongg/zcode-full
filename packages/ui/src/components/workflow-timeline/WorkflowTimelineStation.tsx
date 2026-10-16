import type { ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
import type { TimelineRail, TimelineStation } from "./timeline-model.js";
import {
  CAPTION_X,
  PLATFORM_ROW,
  RAIL_ROW,
  STATION_PITCH,
  STATION_WIDTH,
  TAIL_STUB,
  stationX,
  type TimelineLayout,
} from "./timeline-geometry.js";
import { railKey } from "./timeline-ledge.js";
import type { TypewriterState } from "./use-typewriter.js";
import { HoleFillMark, HoleWaitingMeta } from "./WorkflowHoleParts.js";
import { StationMeta } from "./WorkflowStationMeta.js";
import { StreamChevronsBox } from "./WorkflowStreamChevrons.js";
import { stationLampClass } from "./WorkflowTimelineLedge.js";
import { slideClass, slideStyle, type FillSlide } from "./use-fill-growth.js";

/**
 * 站头：名字 + 元数据，一枚没有背景的
 * 药丸。没有带时它排在轨道行上、灯的右边；有带时它搬到站台行，
 * 灯留在自己那条轨道上——两处的标记完全一样，所以从 `WorkflowTimeline.tsx` 拆出来共用一份。
 *
 * 不可点的站头是 `span` 而不是禁用的 `button`：浏览器对禁用控件不派发
 * click，整块开关就收不到；span 没有语义，点击照常冒泡。
 */
export function StationHead({
  caret,
  foldClass,
  name,
  onSelect,
  station,
  title,
}: {
  station: TimelineStation;
  name: string;
  /** 草稿里跟着笔走的光标；其余时候 null。 */
  caret: ReactNode;
  foldClass: string;
  title: string;
  /** 缺席即站头不是控件——点击冒泡给宿主（轮尾摘要的整块开关）。 */
  onSelect?: () => void;
}) {
  const pending = station.status === undefined || station.status === "pending";
  // 留白站（docs/dynamic-workflow/presentation.md「Holes on the timeline」）：名字到达前 subtle，
  // 等待时元数据位写「等待补全」；无阶段的补全在名字之后放一枚笔标。类型不上界面。
  const hole = station.hole;
  const head = (
    <>
      <span
        className={cn(
          "truncate text-ui-caption font-medium",
          pending ? "text-foreground-subtle" : "text-foreground",
        )}
      >
        {name}
        {caret}
      </span>
      {hole?.state === "filled" ? <HoleFillMark holeId={hole.siteId} /> : null}
      {hole?.state === "waiting" ? (
        <HoleWaitingMeta hole={hole} />
      ) : (
        <StationMeta station={station} />
      )}
    </>
  );
  return onSelect === undefined ? (
    <span
      className={cn(
        "wf-station flex h-6 min-w-0 shrink items-center gap-2 rounded-md text-left",
        foldClass,
      )}
      data-testid="workflow-timeline-station-head"
      title={title}
    >
      {head}
    </span>
  ) : (
    <button
      className={cn(
        "wf-station wf-station-open flex h-6 min-w-0 shrink cursor-pointer items-center gap-2 rounded-md text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40",
        foldClass,
      )}
      onClick={onSelect}
      title={title}
      type="button"
    >
      {head}
    </button>
  );
}

interface RowProps {
  stations: readonly TimelineStation[];
  /** 补全的生长（`use-fill-growth.ts`）：下标大于 `after` 的站带 `wf-slide`，从 −shift 滑到位。 */
  slide?: FillSlide;
  /** 站的全名，按下标；草稿里笔只写出前几个字。 */
  fullNames: readonly string[];
  folded: ReadonlySet<number>;
  titleOf: (station: TimelineStation) => string;
  onSelectStation?: (station: TimelineStation) => void;
}

/**
 * 轨道行（没有带时）：站头（灯 + 名字 + 元数据）与到下一站的轨道段，一站一格。折到檐上的站只留
 * 轨道段；药丸列不折（用户修订：两侧对称）——它们只随滚动走，在视口真正的边界处渐隐。
 */
export function WorkflowStationRow({
  draft,
  folded,
  fresh,
  fullNames,
  onSelectStation,
  pen,
  rails,
  slide,
  stations,
  tailStub,
  titleOf,
  top,
  width,
}: RowProps & {
  /** 相邻两站之间的轨道段，按 `railKey` 查。 */
  rails: ReadonlyMap<string, TimelineRail>;
  draft: boolean;
  pen: TypewriterState;
  top: number;
  width: number;
  /** 末站是尾巴留白：`open` 在它之后画 40px 淡出的虚线残段，`filled` 只留余地。 */
  tailStub?: "open" | "filled";
  /** 刚接进 run 的补全所写的站：灯落地、轨道段长出（`wf-land` / `wf-rail-grow`）。 */
  fresh?: ReadonlySet<string>;
}) {
  const n = stations.length;
  return (
    <div className="absolute left-0 flex" style={{ height: RAIL_ROW, top, width }}>
      {stations.map((station, i) => {
        const rail = rails.get(railKey(i, i + 1));
        const stream = rail?.kind === "stream";
        const full = fullNames[i]!;
        const name = draft ? full.slice(0, pen.shown[i] ?? 0) : full;
        const penHere = draft && i === n - 1;
        const foldClass = cn("wf-foldable", folded.has(i) && "wf-folded");
        const landing = draft || (station.fill !== undefined && fresh?.has(station.fill) === true);
        const last = i === n - 1;
        return (
          <div
            className={cn(
              "flex h-6 min-w-0 items-center",
              station.ghost && "wf-ghost",
              slideClass(i, slide),
            )}
            data-fill={station.fill}
            data-station-folded={folded.has(i) ? "true" : undefined}
            data-station-ghost={station.ghost ? "true" : undefined}
            data-station-hole={station.hole?.state}
            data-station-status={station.status ?? "pending"}
            data-testid="workflow-timeline-station"
            key={station.id}
            style={{
              ...slideStyle(i, slide),
              width: !last
                ? STATION_PITCH
                : STATION_WIDTH + (tailStub === undefined ? 0 : TAIL_STUB),
            }}
          >
            <span
              aria-hidden
              className={cn(
                stationLampClass(station.status, station.hole),
                "mx-3",
                foldClass,
                landing && "wf-land",
              )}
              data-lamp={
                station.hole !== undefined && station.hole.state !== "filled"
                  ? `hole-${station.hole.state}`
                  : (station.status ?? "pending")
              }
            />
            <StationHead
              caret={
                penHere ? (
                  // 光标跟着笔：写字时稳住，追上流时闪烁。
                  <span
                    aria-hidden
                    className={cn(
                      "ml-px inline-block h-3 w-px bg-foreground align-[-1px]",
                      pen.idle && "wf-caret",
                    )}
                    data-pen={pen.idle ? "idle" : "writing"}
                    data-testid="workflow-timeline-caret"
                  />
                ) : null
              }
              foldClass={foldClass}
              name={name}
              station={station}
              title={titleOf(station)}
              {...(onSelectStation === undefined
                ? {}
                : { onSelect: () => onSelectStation(station) })}
            />
            {!last ? (
              <span
                aria-hidden
                className={cn(
                  "wf-ink relative h-0 flex-1 rounded-full border-t border-foreground-subtlest",
                  // 流轨（presentation.md「Stream rails」）：线在正中让出 chevron 的缺口（`::before`
                  // 画线、border 透明），至少 42px 宽，三枚两侧各留得下一段线；它从不叠行进的光。
                  stream ? "wf-rail-stream min-w-[42px]" : "min-w-3",
                  landing && "wf-rail-grow",
                  rail === undefined && "invisible",
                  // 触到开着的留白的段是虚线：那里还不是代码（docs/dynamic-workflow/presentation.md）。
                  rail?.dashed && "border-dashed",
                  // 行进的段照常画底线，再叠一道不动的光（`.wf-rail-march::after`）：朝着灯渐亮。
                  !stream && rail?.ink === "march" && "wf-rail-march",
                )}
                data-rail-dashed={rail?.dashed ? "true" : undefined}
                data-rail-from={i}
                data-rail-ink={rail?.ink ?? "none"}
                data-rail-kind={rail?.kind}
                data-rail-to={i + 1}
                data-testid="workflow-timeline-rail"
                style={{ marginLeft: 10, marginRight: -6 }}
              >
                {stream ? (
                  <StreamChevronsBox ink={rail.ink} style={{ left: "50%", top: -0.5 }} />
                ) : null}
              </span>
            ) : tailStub === "open" ? (
              // 尾巴留白：轨道在它之后再跑 40px 并淡出——脚本的结尾还没有写下。
              <span
                aria-hidden
                className="wf-tail-stub h-0 shrink-0 border-t border-dashed border-foreground-subtlest"
                data-testid="workflow-timeline-tail-stub"
                style={{ marginLeft: 10, width: TAIL_STUB }}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * 站台行：有带时站头一律搬到轨道下面
 * 这一行，灯留在自己的轨道上，分支轨道的站由一条点状引线接回名字——主线的站不需要，它的灯就在
 * 名字正上方。草稿永远没有带，所以这里不必管笔。
 */
export function WorkflowStationPlatform({
  folded,
  fullNames,
  layout,
  onSelectStation,
  slide,
  stations,
  titleOf,
}: RowProps & { layout: TimelineLayout }) {
  return (
    <>
      {stations.map((station, i) => (
        <div
          className={cn(
            "absolute flex h-6 min-w-0 items-center",
            station.ghost && "wf-ghost",
            slideClass(i, slide),
          )}
          data-fill={station.fill}
          data-station-folded={folded.has(i) ? "true" : undefined}
          data-station-hole={station.hole?.state}
          data-station-status={station.status ?? "pending"}
          data-station-track={station.track}
          data-testid="workflow-timeline-station"
          key={station.id}
          style={{
            ...slideStyle(i, slide),
            left: stationX(i, layout.inset) + CAPTION_X,
            top: layout.capY - PLATFORM_ROW / 2,
            width: STATION_WIDTH - CAPTION_X,
          }}
        >
          <StationHead
            caret={null}
            foldClass={cn("wf-foldable", folded.has(i) && "wf-folded")}
            name={fullNames[i]!}
            station={station}
            title={titleOf(station)}
            {...(onSelectStation === undefined ? {} : { onSelect: () => onSelectStation(station) })}
          />
        </div>
      ))}
    </>
  );
}
