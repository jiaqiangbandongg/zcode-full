import type { CSSProperties } from "react";
import { cn } from "@/components/lib/utils.js";
import type { TimelineInk } from "./timeline-model.js";

/**
 * 流轨的 chevron（docs/dynamic-workflow/presentation.md「Stream rails」）：轨道在它可见跨度的正中断开
 * 一截 `STREAM_GAP`，缺口里站着一组 `›››`——三枚相距 5px、每枚 2.6 × 6.4、描边 1.35、圆头圆角，朝流的
 * 方向。墨在 chevron 上：`faint`（还什么都没过去）是 workflow-trace，`strong`（过去过、此刻没在过）是
 * workflow-trace-strong，`march`（两端都在跑，东西正在过）是警示色，三枚沿流向依次亮起
 * （`wf-stream-flow`，1.2s 一轮、相隔 0.15s）。轨道本身不动；动的只有 chevron。
 *
 * 画在 SVG 坐标里（卡的弧层、带的轨道层都是 SVG）；站头行的 DOM 轨道用 {@link StreamChevronsBox}
 * 包一层小 SVG。脊线竖着用，两枚、朝下。
 */
export const STREAM_GAP = 22;
const PITCH = 5;
const HALF_WIDTH = 1.3;
const HALF_HEIGHT = 3.2;
const STAGGER_S = 0.15;

const STROKE: Record<TimelineInk, string> = {
  faint: "var(--color-workflow-trace)",
  march: "var(--color-warning)",
  strong: "var(--color-workflow-trace-strong)",
};

export type StreamDirection = "right" | "left" | "down";

/** 一组 chevron 的路径（纯函数）：中心在 (x, y)，`count` 枚沿 `direction` 排开并朝它指。 */
export function streamChevronPaths(
  x: number,
  y: number,
  direction: StreamDirection,
  count = 3,
): string[] {
  const sign = direction === "left" ? -1 : 1;
  return Array.from({ length: count }, (_, k) => {
    const offset = (k - (count - 1) / 2) * PITCH * sign;
    if (direction === "down") {
      const cy = y + offset;
      return `M${x - HALF_HEIGHT},${cy - HALF_WIDTH} L${x},${cy + HALF_WIDTH} L${x + HALF_HEIGHT},${cy - HALF_WIDTH}`;
    }
    const cx = x + offset;
    return `M${cx - HALF_WIDTH * sign},${y - HALF_HEIGHT} L${cx + HALF_WIDTH * sign},${y} L${cx - HALF_WIDTH * sign},${y + HALF_HEIGHT}`;
  });
}

export function StreamChevrons({
  count = 3,
  direction = "right",
  ink,
  x,
  y,
}: {
  x: number;
  y: number;
  ink: TimelineInk;
  direction?: StreamDirection;
  count?: number;
}) {
  const flowing = ink === "march";
  return (
    <g aria-hidden data-stream-ink={ink} data-testid="workflow-stream-chevrons">
      {streamChevronPaths(x, y, direction, count).map((d, k) => (
        <path
          className={cn("wf-ink", flowing && "wf-stream-flow")}
          d={d}
          fill="none"
          key={d}
          stroke={STROKE[ink]}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.35}
          // 依次亮起：沿流向第 k 枚晚 0.15s·k。
          style={flowing ? { animationDelay: `${k * STAGGER_S}s` } : undefined}
        />
      ))}
    </g>
  );
}

/** DOM 里用的一小块 SVG：中心贴在宿主的 (left, top)，宿主负责把自己的线在这里断开。 */
export function StreamChevronsBox({
  count = 3,
  direction = "right",
  ink,
  style,
}: {
  ink: TimelineInk;
  direction?: StreamDirection;
  count?: number;
  style?: CSSProperties;
}) {
  const vertical = direction === "down";
  const long = (count - 1) * PITCH + 2 * HALF_HEIGHT + 2;
  const width = vertical ? 2 * HALF_HEIGHT + 2 : long;
  const height = vertical ? long : 2 * HALF_HEIGHT + 2;
  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute overflow-visible"
      height={height}
      style={{ transform: "translate(-50%, -50%)", ...style }}
      viewBox={`${-width / 2} ${-height / 2} ${width} ${height}`}
      width={width}
    >
      <StreamChevrons count={count} direction={direction} ink={ink} x={0} y={0} />
    </svg>
  );
}
