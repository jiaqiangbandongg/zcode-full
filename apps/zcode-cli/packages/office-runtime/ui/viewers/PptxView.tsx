import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import {
  RECOMMENDED_ZIP_LIMITS,
  buildPresentation,
  materializeSlideNodes,
  parseZipLazyMedia,
  renderSlide,
  type PresentationData,
  type SlideHandle,
  type SlideNode,
} from "@aiden0z/pptx-renderer/browser";
import { parseLocator } from "#office/domain/anchor.ts";
import { cut } from "#office/domain/text.ts";
import {
  boxOf,
  findAllRanges,
  pointOn,
  findTextRange,
  paintRanges,
  scrollToElement,
  scrollToRange,
  selectionIn,
  trackTopmost,
} from "#ui/dom.ts";
import { rasterize } from "#ui/raster.ts";
import type { RevealedTarget, ViewerHandle, ViewerProps } from "#ui/viewers/types.ts";

interface SlideSlot {
  frame: HTMLDivElement;
  host: HTMLDivElement;
  overlay: HTMLDivElement;
  handle?: SlideHandle;
  ready?: Promise<void>;
}

type TextBodyLike = { paragraphs?: { runs?: { text?: string }[] }[] };

function bodyText(body: TextBodyLike | undefined): string {
  return (body?.paragraphs ?? [])
    .map((paragraph) => (paragraph.runs ?? []).map((run) => run.text ?? "").join(""))
    .join("\n")
    .trim();
}

function nodeText(node: SlideNode): string {
  const data = node as unknown as {
    textBody?: TextBodyLike;
    rows?: { cells: { textBody?: TextBodyLike }[] }[];
  };
  if (data.rows)
    return data.rows
      .map((row) => row.cells.map((cell) => bodyText(cell.textBody)).join(" | "))
      .join("\n");
  return bodyText(data.textBody);
}

const GAP = 16;

export const PptxView = forwardRef<ViewerHandle, ViewerProps>(function PptxView(props, ref) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const presentation = useRef<PresentationData | null>(null);
  const slots = useRef<SlideSlot[]>([]);
  const mediaCache = useRef(new Map<string, string>());
  const [width, setWidth] = useState(0);
  // Bumped when a presentation finishes parsing; the ref alone would not re-render.
  const [loaded, setLoaded] = useState(0);
  const callbacks = useRef(props);
  callbacks.current = props;
  // Slides always fit the pane width; there is no zoom.
  const scale = loaded && presentation.current ? width / presentation.current.width : 0;
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const thumbs = useRef(new Map<number, { element: HTMLElement; handle: SlideHandle }>());
  const reveal = useRef<Range[]>([]);
  /** Per agent target, what a click on it hits: its quote or its shape (not a whole slide). */
  const revealHits = useRef<(Range | Element | null)[]>([]);
  const find = useRef<{ ranges: Range[]; current: number } | null>(null);
  const glance = Boolean(props.glance);

  useEffect(() => {
    let cancelled = false;
    const list = listRef.current!;
    (async () => {
      const files = await parseZipLazyMedia(props.bytes, RECOMMENDED_ZIP_LIMITS);
      if (cancelled) return;
      const built = buildPresentation(files, { lazySlides: true });
      presentation.current = built;
      list.replaceChildren();
      slots.current = built.slides.map((_: unknown, i: number) => {
        const frame = document.createElement("div");
        frame.className = "slide-frame";
        frame.dataset.at = `slide:${i + 1}`;
        const host = document.createElement("div");
        host.className = "slide-host";
        host.style.width = `${built.width}px`;
        host.style.height = `${built.height}px`;
        const overlay = document.createElement("div");
        overlay.className = "slide-overlay";
        host.append(overlay);
        frame.append(host);
        list.append(frame);
        return { frame, host, overlay };
      });
      setWidth(Math.max(200, scrollRef.current!.clientWidth - GAP * 2));
      setLoaded((count) => count + 1);
      callbacks.current.onPage?.({ current: 1, count: built.slides.length });
      callbacks.current.onReady();
    })().catch((error) => !cancelled && callbacks.current.onError(error));
    return () => {
      cancelled = true;
      for (const slot of slots.current) slot.handle?.dispose();
      slots.current = [];
      for (const thumb of thumbs.current.values()) thumb.handle.dispose();
      thumbs.current.clear();
      for (const url of mediaCache.current.values()) URL.revokeObjectURL(url);
      mediaCache.current.clear();
    };
  }, [props.bytes]);

  useEffect(() => {
    const scroll = scrollRef.current!;
    const resize = new ResizeObserver(() => setWidth(Math.max(200, scroll.clientWidth - GAP * 2)));
    resize.observe(scroll);
    return () => resize.disconnect();
  }, []);

  // Apply scale and (re)observe for lazy rendering.
  useEffect(() => {
    const built = presentation.current;
    if (!built || !scale) return;
    for (const slot of slots.current) {
      slot.frame.style.width = `${built.width * scale}px`;
      slot.frame.style.height = `${built.height * scale}px`;
      slot.host.style.transform = `scale(${scale})`;
      slot.frame.style.setProperty("--slide-scale", String(scale));
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const index = slots.current.findIndex((slot) => slot.frame === entry.target);
          if (index >= 0) void ensureRendered(index);
        }
      },
      { root: scrollRef.current, rootMargin: "800px 0px" },
    );
    for (const slot of slots.current) observer.observe(slot.frame);
    return () => observer.disconnect();
  }, [scale, loaded]);

  function ensureRendered(index: number): Promise<void> {
    const built = presentation.current;
    const slot = slots.current[index];
    if (!built || !slot) return Promise.resolve();
    if (slot.ready) return slot.ready;
    const slide = built.slides[index];
    materializeSlideNodes(built, slide);
    const handle = renderSlide(built, slide, {
      mediaUrlCache: mediaCache.current,
      pdfjs: false,
      onNavigate: (target: { slideIndex?: number; url?: string }) => {
        if (target.url) callbacks.current.onLink(target.url);
        else if (typeof target.slideIndex === "number") {
          const frame = slots.current[target.slideIndex]?.frame;
          if (frame) scrollToElement(frame, "start");
        }
      },
    });
    slot.handle = handle;
    slot.host.insertBefore(handle.element, slot.overlay);
    const ready = handle.ready.catch(() => undefined);
    slot.ready = ready;
    return ready;
  }

  /** Topmost node under a point in slide coordinates (later nodes paint on top). */
  function hitTest(index: number, x: number, y: number): SlideNode | null {
    const built = presentation.current;
    if (!built) return null;
    const slide = built.slides[index];
    materializeSlideNodes(built, slide);
    for (let i = slide.nodes.length - 1; i >= 0; i--) {
      const node = slide.nodes[i];
      const { x: left, y: top } = node.position;
      const { w, h } = node.size;
      if (w <= 0 && h <= 0) continue;
      const pad = Math.min(w, h) < 6 ? 4 : 0;
      if (x >= left - pad && x <= left + w + pad && y >= top - pad && y <= top + h + pad)
        return node;
    }
    return null;
  }

  function outline(slot: SlideSlot, node: SlideNode | null, kind: "selected" | "revealed") {
    slot.overlay.querySelectorAll(`.shape-${kind}`).forEach((element) => element.remove());
    if (!node) return;
    const box = document.createElement("div");
    box.className = `shape-${kind}`;
    box.style.left = `${node.position.x}px`;
    box.style.top = `${node.position.y}px`;
    box.style.width = `${node.size.w}px`;
    box.style.height = `${node.size.h}px`;
    slot.overlay.append(box);
  }

  useEffect(() => {
    const scroll = scrollRef.current!;
    const untrack = trackTopmost(
      scroll,
      () => slots.current.map((slot) => slot.frame),
      (element) => element.dataset.at ?? null,
      (at) => {
        callbacks.current.onLocation(at);
        callbacks.current.onPage?.({ current: Number(at.slice(6)), count: slots.current.length });
      },
      1 / 3,
    );
    const pick = (event: MouseEvent) => {
      const frame = (event.target as Element).closest<HTMLElement>(".slide-frame");
      const index = slots.current.findIndex((slot) => slot.frame === frame);
      if (index < 0) {
        for (const other of slots.current) outline(other, null, "selected");
        callbacks.current.onSelect(null);
        return;
      }
      const slot = slots.current[index];
      const selected = selectionIn(slot.host);
      // A click on one of the agent's marks brings its note back instead of selecting.
      const hit = selected
        ? -1
        : revealHits.current.findIndex((mark) => pointOn(mark, event.clientX, event.clientY));
      if (hit >= 0 && callbacks.current.onRevealHit?.(hit)) {
        for (const other of slots.current) outline(other, null, "selected");
        callbacks.current.onSelect(null);
        return;
      }
      const rect = slot.host.getBoundingClientRect();
      const point = selected
        ? selected.range.getBoundingClientRect()
        : { left: event.clientX, top: event.clientY, width: 0, height: 0 };
      const x = (point.left + point.width / 2 - rect.left) / scaleRef.current;
      const y = (point.top + point.height / 2 - rect.top) / scaleRef.current;
      const node = hitTest(index, x, y);
      for (const other of slots.current) outline(other, null, "selected");
      outline(slot, node, "selected");
      const at = node ? `slide:${index + 1}/shape:${node.id}` : `slide:${index + 1}`;
      const text = selected?.text ?? (node ? nodeText(node) : "");
      const range = selected?.range.cloneRange();
      const box = slot.overlay.querySelector(".shape-selected");
      callbacks.current.onSelect(
        { at, text: cut(text, 0, 2000) },
        {
          text: Boolean(range),
          locate: () => (range ? boxOf(range) : (boxOf(box) ?? boxOf(slot.frame))),
          user: true,
        },
      );
    };
    const onUp = (event: MouseEvent) => setTimeout(() => pick(event), 0);
    scroll.addEventListener("mouseup", onUp);
    return () => {
      untrack();
      scroll.removeEventListener("mouseup", onUp);
    };
  }, []);

  function slotFor(at: string) {
    const locator = parseLocator("pptx", at);
    if (locator.kind !== "pptx") return null;
    return { locator, slot: slots.current[locator.from - 1] ?? null };
  }

  function paint() {
    paintRanges("office-reveal", reveal.current);
    const state = find.current;
    const current = state ? state.ranges[state.current] : undefined;
    paintRanges("office-find", state ? state.ranges.filter((range) => range !== current) : []);
    paintRanges("office-find-current", current ? [current] : []);
  }

  useImperativeHandle(
    ref,
    (): ViewerHandle => ({
      async reveal(targets) {
        this.clearReveal();
        const results: RevealedTarget[] = [];
        for (const target of targets) {
          const found = slotFor(target.at);
          if (!found?.slot) continue;
          const { locator, slot } = found;
          await ensureRendered(locator.from - 1);
          if (locator.shape) {
            const built = presentation.current!;
            const slide = built.slides[locator.from - 1];
            materializeSlideNodes(built, slide);
            outline(
              slot,
              slide.nodes.find((node: SlideNode) => node.id === locator.shape) ?? null,
              "revealed",
            );
          } else {
            for (let n = locator.from; n <= locator.to; n++)
              slots.current[n - 1]?.frame.classList.add("revealed");
          }
          const range = target.quote ? findTextRange(slot.host, target.quote) : null;
          if (range) reveal.current.push(range);
          const shape = locator.shape ? slot.overlay.querySelector(".shape-revealed") : null;
          revealHits.current.push(range ?? shape);
          results.push({
            at: target.at,
            locate: () => boxOf(range) ?? boxOf(shape) ?? boxOf(slot.frame),
            scrollTo: () =>
              range
                ? scrollToRange(range, "upper")
                : scrollToElement(shape ?? slot.frame, shape ? "upper" : "start"),
          });
        }
        paint();
        results[0]?.scrollTo();
        return results;
      },
      goTo(at) {
        const found = slotFor(at);
        if (found?.slot) scrollToElement(found.slot.frame, "start");
      },
      clearReveal() {
        reveal.current = [];
        revealHits.current = [];
        for (const slot of slots.current) {
          slot.frame.classList.remove("revealed");
          outline(slot, null, "revealed");
        }
        paint();
      },
      async capture(at, maxWidth) {
        const built = presentation.current;
        if (!built) throw new Error("The presentation is still loading.");
        let index: number;
        if (at) {
          const found = slotFor(at);
          if (!found?.slot)
            throw new Error(`${at} is not in this presentation (${built.slides.length} slides).`);
          index = found.locator.from - 1;
        } else {
          const top = scrollRef.current!.getBoundingClientRect().top;
          index = Math.max(
            0,
            slots.current.findIndex((slot) => slot.frame.getBoundingClientRect().bottom > top + 8),
          );
        }
        await ensureRendered(index);
        const slot = slots.current[index];
        const raster = await rasterize(slot.handle!.element, {
          maxWidth,
          context: slot.host,
          background: "#fff",
        });
        return { ...raster, at: at ?? `slide:${index + 1}` };
      },
      zoom() {},
      fit() {},
      async find(query) {
        if (!query.trim()) {
          this.clearFind();
          return 0;
        }
        await Promise.all(slots.current.map((_, i) => ensureRendered(i)));
        const ranges = slots.current.flatMap((slot) => findAllRanges(slot.host, query));
        find.current = ranges.length ? { ranges, current: -1 } : null;
        paint();
        return ranges.length;
      },
      findGo(index) {
        const state = find.current;
        if (!state?.ranges[index]) return;
        state.current = index;
        paint();
        scrollToRange(state.ranges[index], "center");
      },
      clearFind() {
        find.current = null;
        paint();
      },
      clearSelection() {
        for (const slot of slots.current) outline(slot, null, "selected");
        if (scrollRef.current && selectionIn(scrollRef.current))
          document.getSelection()?.removeAllRanges();
      },
      goToPage(page) {
        const slot = slots.current[Math.min(Math.max(1, page), slots.current.length) - 1];
        if (slot) scrollToElement(slot.frame, "start");
      },
      async thumbnail(page, thumbWidth) {
        const built = presentation.current;
        if (!built) throw new Error("The presentation is still loading.");
        const cached = thumbs.current.get(page);
        if (cached) return cached.element;
        const slide = built.slides[page - 1];
        materializeSlideNodes(built, slide);
        const handle = renderSlide(built, slide, {
          mediaUrlCache: mediaCache.current,
          pdfjs: false,
        });
        const thumbScale = thumbWidth / built.width;
        const element = document.createElement("div");
        element.className = "slide-thumb";
        element.style.width = `${thumbWidth}px`;
        element.style.height = `${built.height * thumbScale}px`;
        const inner = document.createElement("div");
        inner.className = "slide-host";
        inner.style.width = `${built.width}px`;
        inner.style.height = `${built.height}px`;
        inner.style.transform = `scale(${thumbScale})`;
        inner.append(handle.element);
        element.append(inner);
        thumbs.current.set(page, { element, handle });
        await handle.ready.catch(() => undefined);
        return element;
      },
    }),
    [],
  );

  return (
    <div ref={scrollRef} className={`viewer-scroll pptx-scroll${glance ? " glance" : ""}`}>
      <div ref={listRef} className="slide-list" />
    </div>
  );
});
