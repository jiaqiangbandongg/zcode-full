import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { cn } from "@/components/lib/utils.js";
import type { WorkflowTimelineModel } from "@/components/workflow-timeline/timeline-model.js";
import {
  fillDepthOf,
  fillMarksOf,
  framePath,
  spineFrameBox,
  type FrameBox,
} from "@/components/workflow-timeline/timeline-frames.js";
import {
  useFillHeadTarget,
  useFreshFills,
} from "@/components/workflow-timeline/WorkflowTimelineFills.js";

/**
 * 侧板上补全的框（docs/dynamic-workflow/presentation.md「The pane」）：与卡上同一个框竖着画——同墨、同圆角、
 * 同一笔。卡上的框按列几何算得出；这里节的高随展开 / 折叠、名单开合而变，所以纵向位置从 DOM 量：
 * 标题行（`data-fill-heading`）的顶与补全最后一节（`data-phase-id`）的底，相对列表内容（算上滚动）。
 * 每次提交后量一遍，列表尺寸变了由 ResizeObserver 补量；量到的与上次相同就不动 state。
 *
 * 点亮只认头（`useFillHeadTarget`，与卡共用）：标题行与笔标带 `data-fill-head`。
 * 侧板不缩进（用户修订：嵌套由框套框说出），嵌套的框每层各收 4px。
 */
interface SpineFrameGeometry {
  width: number;
  height: number;
  boxes: Readonly<Record<string, FrameBox>>;
}

const EMPTY: SpineFrameGeometry = { width: 0, height: 0, boxes: {} };

function sectionOf(root: HTMLElement, attribute: string, value: string): HTMLElement | undefined {
  return [...root.querySelectorAll<HTMLElement>(`[${attribute}]`)].find(
    (element) => element.getAttribute(attribute) === value,
  );
}

export function useSpineFillFrames(
  rootRef: RefObject<HTMLDivElement | null>,
  model: WorkflowTimelineModel,
): {
  /** 挂在列表根上的委托（没有补全时为空对象）。 */
  handlers: ReturnType<typeof useFillHeadTarget>["handlers"];
  /** 此刻画出的框（指针或焦点所在的头）。 */
  active: string | undefined;
  fresh: ReadonlySet<string>;
  frames: ReactNode;
} {
  const fills = model.fills ?? [];
  const marks = fillMarksOf(model.stations, fills);
  const parents = model.holeParents ?? {};
  const fresh = useFreshFills([...fills, ...marks]);
  const [geometry, setGeometry] = useState<SpineFrameGeometry>(EMPTY);
  const any = fills.length + marks.length > 0;

  const measure = () => {
    const root = rootRef.current;
    if (root === null || !any) return;
    const rootTop = root.getBoundingClientRect().top - root.scrollTop;
    const top = (element: HTMLElement) => element.getBoundingClientRect().top - rootTop;
    const bottom = (element: HTMLElement) => top(element) + element.getBoundingClientRect().height;
    const width = root.clientWidth;
    const boxes: Record<string, FrameBox> = {};
    for (const fill of fills) {
      const heading = sectionOf(root, "data-fill-heading", fill.holeId);
      const last = model.stations[fill.to];
      const section = last === undefined ? undefined : sectionOf(root, "data-phase-id", last.id);
      if (heading === undefined || section === undefined) continue;
      boxes[fill.holeId] = spineFrameBox({
        bottom: bottom(section),
        depth: fillDepthOf(fill.holeId, fills, parents),
        headed: true,
        top: top(heading),
        width,
      });
    }
    for (const mark of marks) {
      const station = model.stations[mark.index];
      const section =
        station === undefined ? undefined : sectionOf(root, "data-phase-id", station.id);
      if (section === undefined) continue;
      boxes[mark.holeId] = spineFrameBox({
        bottom: bottom(section),
        depth: fillDepthOf(mark.holeId, fills, parents),
        headed: false,
        top: top(section),
        width,
      });
    }
    const next: SpineFrameGeometry = { boxes, height: root.scrollHeight, width };
    setGeometry((previous) =>
      JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
    );
  };
  // 观察者只建一次，却总要调到最新的一版量法（它闭包里有这一帧的 fills 与站）。
  const measureRef = useRef(measure);
  measureRef.current = measure;
  useLayoutEffect(() => measureRef.current());
  useEffect(() => {
    const root = rootRef.current;
    if (root === null || !any || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => measureRef.current());
    observer.observe(root);
    // 节展开 / 折叠时列表自己的盒子不变、内容高度变：连同每一节一起观察。框自己的 svg 不观察。
    for (const child of root.children) if (!(child instanceof SVGElement)) observer.observe(child);
    return () => observer.disconnect();
  }, [any, rootRef]);

  const { active, handlers } = useFillHeadTarget(any);
  if (!any) return { active: undefined, fresh, frames: null, handlers };

  const frames = (
    <svg
      aria-hidden
      className="pointer-events-none absolute left-0 top-0 overflow-visible"
      data-testid="workflow-run-fill-frames"
      height={geometry.height}
      width={geometry.width}
    >
      {[...fills, ...marks].map(({ holeId }) => {
        const box = geometry.boxes[holeId];
        const isFresh = fresh.has(holeId);
        return (
          <path
            className={cn("wf-fill-frame", isFresh && "wf-fill-frame-fresh")}
            d={box === undefined ? "" : framePath(box)}
            data-fill-frame={holeId}
            data-fill-fresh={isFresh ? "true" : undefined}
            data-fill-on={isFresh || active === holeId ? "true" : undefined}
            data-testid="workflow-run-fill-frame"
            key={holeId}
            pathLength={1}
          />
        );
      })}
    </svg>
  );
  return { active, fresh, frames, handlers };
}
