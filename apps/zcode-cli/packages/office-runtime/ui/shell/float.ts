import { useLayoutEffect, useRef, type RefObject } from "react";
import type { Locate } from "#ui/viewers/types.ts";

const EDGE = 8;

export interface FloatOptions {
  /** Preferred side of the anchor; flips when there is no room. */
  side: "top" | "bottom";
  /** Gap between anchor and element (ZCode's popover uses 8). */
  offset?: number;
  /** With no anchor box, sit at the top centre of the frame instead of hiding. */
  dock?: boolean;
}

/**
 * Keep an absolutely positioned element next to an anchor inside `frame` while the document
 * scrolls, like ZCode's Radix popovers (collision padding 8, hidden when the anchor leaves view).
 * Positions are written straight to the element every frame, so scrolling never re-renders React.
 * The element gets `data-side` ("top" | "bottom" | "none") and `--tip` for its arrow.
 */
export function useFloating<T extends HTMLElement>(
  frame: RefObject<HTMLElement | null>,
  locate: Locate | null | undefined,
  options: FloatOptions,
) {
  const ref = useRef<T>(null);
  const { side, offset = 8, dock = false } = options;
  useLayoutEffect(() => {
    const element = ref.current;
    const container = frame.current;
    if (!element || !container) return;
    let frameId = 0;
    const place = () => {
      frameId = 0;
      const bounds = container.getBoundingClientRect();
      const width = element.offsetWidth;
      const height = element.offsetHeight;
      const box = locate?.() ?? null;
      const show = (left: number, top: number, placed: string, centre: number) => {
        element.style.visibility = "";
        element.style.left = `${Math.round(left)}px`;
        element.style.top = `${Math.round(top)}px`;
        element.dataset.side = placed;
        element.style.setProperty(
          "--tip",
          `${Math.round(Math.max(14, Math.min(width - 14, centre - left)))}px`,
        );
      };
      if (!box) {
        if (dock) show((bounds.width - width) / 2, EDGE, "none", bounds.width / 2);
        else element.style.visibility = "hidden";
        return;
      }
      if (box.bottom < bounds.top + 4 || box.top > bounds.bottom - 4) {
        element.style.visibility = "hidden";
        return;
      }
      const centre = (box.left + box.right) / 2 - bounds.left;
      const left = Math.max(EDGE, Math.min(bounds.width - width - EDGE, centre - width / 2));
      const above = box.top - bounds.top - height - offset;
      const below = box.bottom - bounds.top + offset;
      const fitsAbove = above >= EDGE;
      const fitsBelow = below + height <= bounds.height - EDGE;
      if (side === "top" ? fitsAbove : !fitsBelow && fitsAbove) show(left, above, "top", centre);
      else if (fitsBelow) show(left, below, "bottom", centre);
      // A tall anchor (a whole page): pin to the visible edge nearest the preferred side.
      else show(left, side === "top" ? EDGE : bounds.height - height - EDGE, "none", centre);
    };
    const schedule = () => {
      if (!frameId) frameId = requestAnimationFrame(place);
    };
    place();
    container.addEventListener("scroll", schedule, { capture: true, passive: true });
    const resize = new ResizeObserver(schedule);
    resize.observe(container);
    resize.observe(element);
    // Rendering (fonts, lazy pages, zoom) can move the anchor without a scroll.
    const settle = setInterval(schedule, 250);
    return () => {
      container.removeEventListener("scroll", schedule, { capture: true });
      resize.disconnect();
      clearInterval(settle);
      if (frameId) cancelAnimationFrame(frameId);
    };
  }, [frame, locate, side, offset, dock]);
  return ref;
}
