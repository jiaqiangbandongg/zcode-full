import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { parseLocator } from "#office/domain/anchor.ts";
import { normalizeCjkCompat } from "#office/domain/cjk.ts";
import { readBinary, readText } from "#ui/assets.ts";
import {
  boxOf,
  countMatches,
  pointOn,
  findAllRanges,
  findTextRange,
  paintRanges,
  safeExternalUrl,
  scrollToElement,
  scrollToRange,
  selectionIn,
  trackTopmost,
} from "#ui/dom.ts";
import { canvasToPng } from "#ui/raster.ts";
import {
  nextZoom,
  type FitMode,
  type RevealedTarget,
  type ViewerHandle,
  type ViewerProps,
} from "#ui/viewers/types.ts";

// pdf.js would fetch cMaps, fonts and wasm over the network; the sandbox has none, so read them
// through the plugin's MCP resources instead.
class AssetCMapFactory {
  constructor(private readonly options: { baseUrl: string | null; isCompressed: boolean }) {}
  async fetch({ name }: { name: string }) {
    return {
      cMapData: await readBinary(`${this.options.baseUrl}${name}.bcmap`),
      isCompressed: true,
    };
  }
}
class AssetBinaryFactory {
  constructor(private readonly options: { baseUrl: string | null }) {}
  async fetch({ filename }: { filename: string }) {
    return readBinary(`${this.options.baseUrl}${filename}`);
  }
}

let sharedWorker: Promise<pdfjs.PDFWorker> | undefined;
/**
 * One pdf.js worker for the page's lifetime. Passed explicitly, so destroying a document (reload,
 * switching files) never tears down the worker the next document is about to use.
 */
function worker(): Promise<pdfjs.PDFWorker> {
  return (sharedWorker ??= readText("pdf-worker.js").then((source) => {
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    return pdfjs.PDFWorker.create({ port: new Worker(url, { type: "module" }) });
  }));
}

type TextContent = Awaited<ReturnType<PDFPageProxy["getTextContent"]>>;

/** Page text with CJK radicals mapped back to ideographs (see src/domain/cjk.ts). */
async function pageTextContent(page: PDFPageProxy): Promise<TextContent> {
  const content = await page.getTextContent();
  return {
    ...content,
    items: content.items.map((item) =>
      "str" in item ? { ...item, str: normalizeCjkCompat(item.str) } : item,
    ),
  };
}

interface PageSlot {
  element: HTMLDivElement;
  /** Resolves when the canvas and text layer of the current scale are in place. */
  done?: Promise<void>;
  task?: { cancel(): void };
  textLayer?: HTMLDivElement;
}

/** Canvas padding and the gap between pages (CSS keeps these in step). */
const PADDING = 16;
/** pdf.js scale 1 is 72 dpi; "100%" means actual size at 96 CSS px per inch. */
const CSS_UNITS = 96 / 72;

interface Zoom {
  mode: FitMode | null;
  /** Percent of actual size when mode is null. */
  percent: number;
}

interface RevealItem {
  page: number;
  to: number;
  quote?: string;
}

export const PdfView = forwardRef<ViewerHandle, ViewerProps>(function PdfView(props, ref) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const slots = useRef<PageSlot[]>([]);
  const sizes = useRef<{ width: number; height: number }[]>([]);
  const [zoom, setZoom] = useState<Zoom>({ mode: "width", percent: 100 });
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [loaded, setLoaded] = useState(0);
  const callbacks = useRef(props);
  callbacks.current = props;
  const glance = Boolean(props.glance);

  const scale = (() => {
    if (!loaded || !box.width || !sizes.current.length) return 0;
    const maxWidth = Math.max(...sizes.current.map((size) => size.width));
    const maxHeight = Math.max(...sizes.current.map((size) => size.height));
    const columns = glance && box.width >= 520 ? 2 : 1;
    const fitWidth = Math.min(4, (box.width - PADDING * (columns + 1)) / columns / maxWidth);
    if (zoom.mode === "width" || glance) return fitWidth;
    if (zoom.mode === "page") return Math.min(fitWidth, (box.height - PADDING * 2) / maxHeight);
    if (zoom.mode === "actual") return CSS_UNITS;
    return (zoom.percent / 100) * CSS_UNITS;
  })();
  const scaleRef = useRef(scale);
  const previousScale = useRef(0);
  scaleRef.current = scale;
  /** Point (in container coordinates) that should stay put across the next zoom change. */
  const zoomAnchor = useRef<{ x: number; y: number } | null>(null);
  const observer = useRef<IntersectionObserver | null>(null);
  /** Bumped whenever pages are resized; a render from an older generation must not land. */
  const generation = useRef(0);

  // Decorations that must survive re-rendering a page (zoom replaces the text layers).
  const revealItems = useRef<RevealItem[]>([]);
  const revealRanges = useRef(new Map<number, Range>());
  const find = useRef<{
    query: string;
    matches: { page: number; k: number }[];
    current: number;
    ranges: Map<number, Range[]>;
  } | null>(null);
  const pageTexts = useRef<Promise<string>[]>([]);

  // Load the document.
  useEffect(() => {
    let cancelled = false;
    let loadedDoc: PDFDocumentProxy | null = null;
    (async () => {
      const task = pdfjs.getDocument({
        worker: await worker(),
        data: new Uint8Array(props.bytes.slice(0)),
        cMapUrl: "pdfjs/cmaps/",
        cMapPacked: true,
        standardFontDataUrl: "pdfjs/standard_fonts/",
        wasmUrl: "pdfjs/wasm/",
        CMapReaderFactory: AssetCMapFactory,
        StandardFontDataFactory: AssetBinaryFactory,
        WasmFactory: AssetBinaryFactory,
        useWorkerFetch: false,
        isEvalSupported: false,
        enableXfa: false,
      });
      loadedDoc = await task.promise;
      if (cancelled) return void loadedDoc.destroy();
      docRef.current = loadedDoc;
      const pageSizes: { width: number; height: number }[] = [];
      const count = glance ? Math.min(4, loadedDoc.numPages) : loadedDoc.numPages;
      for (let n = 1; n <= count; n++) {
        const page = await loadedDoc.getPage(n);
        const viewport = page.getViewport({ scale: 1 });
        pageSizes.push({ width: viewport.width, height: viewport.height });
      }
      if (cancelled) return;
      sizes.current = pageSizes;
      const container = scrollRef.current!;
      container.replaceChildren();
      slots.current = pageSizes.map((_, i) => {
        const element = document.createElement("div");
        element.className = "pdf-page";
        element.dataset.at = `page:${i + 1}`;
        container.append(element);
        return { element };
      });
      setBox({ width: container.clientWidth, height: container.clientHeight });
      setLoaded((value) => value + 1);
      callbacks.current.onPage?.({ current: 1, count: loadedDoc.numPages });
      callbacks.current.onReady();
    })().catch((error) => !cancelled && callbacks.current.onError(error));
    return () => {
      cancelled = true;
      observer.current?.disconnect();
      void loadedDoc?.destroy();
      docRef.current = null;
      pageTexts.current = [];
    };
  }, [props.bytes, glance]);

  // Follow the pane size.
  useEffect(() => {
    const container = scrollRef.current!;
    const resize = new ResizeObserver(() =>
      setBox((previous) =>
        Math.abs(previous.width - container.clientWidth) > 1 ||
        Math.abs(previous.height - container.clientHeight) > 1
          ? { width: container.clientWidth, height: container.clientHeight }
          : previous,
      ),
    );
    resize.observe(container);
    return () => resize.disconnect();
  }, []);

  // Report the zoom the control shows.
  useEffect(() => {
    if (!scale) return;
    callbacks.current.onZoom?.({
      mode: zoom.mode,
      percent: Math.round((scale / CSS_UNITS) * 100),
    });
  }, [scale, zoom.mode]);

  // Size page placeholders, keep the anchor point in place, render what is visible.
  useLayoutEffect(() => {
    const doc = docRef.current;
    const container = scrollRef.current;
    if (!doc || !scale || !container) return;
    const before = previousScale.current;
    previousScale.current = scale;
    const anchor = zoomAnchor.current ?? {
      x: container.clientWidth / 2,
      y: container.clientHeight / 2,
    };
    zoomAnchor.current = null;
    const fraction = {
      x: container.scrollLeft + anchor.x,
      y: container.scrollTop + anchor.y,
    };
    observer.current?.disconnect();
    generation.current++;
    for (const [i, slot] of slots.current.entries()) {
      slot.task?.cancel();
      slot.done = undefined;
      slot.textLayer = undefined;
      slot.element.replaceChildren();
      slot.element.style.width = `${sizes.current[i].width * scale}px`;
      slot.element.style.height = `${sizes.current[i].height * scale}px`;
    }
    revealRanges.current.clear();
    find.current?.ranges.clear();
    paint();
    if (before && before !== scale) {
      const ratio = scale / before;
      container.scrollTo({
        left: Math.max(0, (fraction.x - PADDING) * ratio + PADDING - anchor.x),
        top: Math.max(0, (fraction.y - PADDING) * ratio + PADDING - anchor.y),
      });
    }
    observer.current = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const index = slots.current.findIndex((slot) => slot.element === entry.target);
          if (index >= 0) void renderPage(index);
        }
      },
      { root: container, rootMargin: "600px 0px" },
    );
    for (const slot of slots.current) observer.current.observe(slot.element);
  }, [scale]);

  function renderPage(index: number): Promise<void> {
    const slot = slots.current[index];
    if (!slot) return Promise.resolve();
    return (slot.done ??= draw(index, slot));
  }

  async function draw(index: number, slot: PageSlot) {
    const doc = docRef.current;
    if (!doc) return;
    const currentScale = scaleRef.current;
    const mine = generation.current;
    const page = await doc.getPage(index + 1);
    // The pane was resized while the page loaded: a newer render owns this slot now.
    if (generation.current !== mine) return;
    const viewport = page.getViewport({ scale: currentScale });
    const ratio = window.devicePixelRatio || 1;
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    const textLayer = document.createElement("div");
    textLayer.className = "textLayer";
    const links = document.createElement("div");
    links.className = "pdf-links";
    slot.element.style.setProperty("--scale-factor", String(currentScale));
    slot.element.style.setProperty("--user-unit", "1");
    slot.element.style.setProperty("--total-scale-factor", String(currentScale));
    slot.element.replaceChildren(canvas, textLayer, links);
    const task = page.render({
      canvas,
      canvasContext: canvas.getContext("2d")!,
      viewport,
      transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
    });
    slot.task = task;
    try {
      await task.promise;
      if (generation.current !== mine) return;
      // 文字层用归一后的文字：复制、选区引用、查找与 Agent 引文定位都要看到“文”而不是“⽂”。
      const content = await pageTextContent(page);
      if (generation.current !== mine) return;
      const text = new pdfjs.TextLayer({
        textContentSource: content,
        container: textLayer,
        viewport,
      });
      await text.render();
      if (generation.current !== mine || !textLayer.isConnected) return;
      slot.textLayer = textLayer;
      await addLinks(page, viewport, links);
      decorate(index + 1);
    } catch (error) {
      if ((error as Error)?.name !== "RenderingCancelledException")
        console.warn("pdf render", error);
    }
  }

  async function addLinks(
    page: PDFPageProxy,
    viewport: ReturnType<PDFPageProxy["getViewport"]>,
    layer: HTMLDivElement,
  ) {
    const annotations = await page.getAnnotations({ intent: "display" });
    for (const annotation of annotations) {
      if (annotation.subtype !== "Link") continue;
      const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(annotation.rect);
      const link = document.createElement("a");
      link.className = "pdf-link";
      link.style.left = `${Math.min(x1, x2)}px`;
      link.style.top = `${Math.min(y1, y2)}px`;
      link.style.width = `${Math.abs(x2 - x1)}px`;
      link.style.height = `${Math.abs(y2 - y1)}px`;
      const url = safeExternalUrl(annotation.url ?? annotation.unsafeUrl);
      if (url) {
        link.title = url;
        link.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          callbacks.current.onLink(url);
        });
      } else if (annotation.dest) {
        link.addEventListener("click", async (event) => {
          event.preventDefault();
          event.stopPropagation();
          const target = await resolveDest(annotation.dest);
          if (target) scrollToPage(target);
        });
      } else continue;
      layer.append(link);
    }
  }

  async function resolveDest(dest: unknown): Promise<number | null> {
    const doc = docRef.current;
    if (!doc) return null;
    const explicit = typeof dest === "string" ? await doc.getDestination(dest) : dest;
    const target = Array.isArray(explicit) ? explicit[0] : null;
    if (target && typeof target === "object") return (await doc.getPageIndex(target)) + 1;
    return typeof target === "number" ? target + 1 : null;
  }

  function scrollToPage(page: number) {
    const slot = slots.current[page - 1];
    if (slot) scrollToElement(slot.element, "start");
  }

  /** Page `n` with its text layer for the current scale (null if it does not exist). */
  async function rendered(n: number): Promise<PageSlot | null> {
    const slot = slots.current[n - 1];
    if (!slot) return null;
    // A resize while waiting starts a fresh render; wait for that one too.
    for (let attempt = 0; attempt < 5; attempt++) {
      await renderPage(n - 1);
      if (slot.textLayer?.isConnected) return slot;
    }
    return null;
  }

  /** Re-attach reveal and find highlights to a freshly rendered page. */
  function decorate(page: number) {
    const slot = slots.current[page - 1];
    if (!slot?.textLayer) return;
    revealItems.current.forEach((item, i) => {
      if (!item.quote || item.page !== page) return;
      // Always re-find on the live layer: a range on a replaced layer would paint nothing.
      const current = revealRanges.current.get(i);
      if (current && slot.textLayer!.contains(current.startContainer)) return;
      const range = findTextRange(slot.textLayer!, item.quote);
      if (range) revealRanges.current.set(i, range);
      else revealRanges.current.delete(i);
    });
    if (find.current?.query)
      find.current.ranges.set(page, findAllRanges(slot.textLayer, find.current.query));
    paint();
  }

  function currentFindRange(): Range | null {
    const state = find.current;
    const match = state?.matches[state.current];
    if (!state || !match) return null;
    const ranges = state.ranges.get(match.page) ?? [];
    return ranges[Math.min(match.k, ranges.length - 1)] ?? null;
  }

  function paint() {
    paintRanges("office-reveal", [...revealRanges.current.values()]);
    const current = currentFindRange();
    paintRanges(
      "office-find",
      [...(find.current?.ranges.values() ?? [])].flat().filter((range) => range !== current),
    );
    paintRanges("office-find-current", current ? [current] : []);
  }

  function pageText(n: number): Promise<string> {
    const doc = docRef.current;
    if (!doc) return Promise.resolve("");
    return (pageTexts.current[n - 1] ??= doc
      .getPage(n)
      .then(pageTextContent)
      .then((content) => content.items.map((item) => ("str" in item ? item.str : "")).join(" "))
      .catch(() => ""));
  }

  // Visible page tracking.
  useEffect(() => {
    const container = scrollRef.current!;
    return trackTopmost(
      container,
      () => slots.current.map((slot) => slot.element),
      (element) => element.dataset.at ?? null,
      (at) => {
        callbacks.current.onLocation(at);
        callbacks.current.onPage?.({
          current: Number(at.slice(5)),
          count: docRef.current?.numPages ?? slots.current.length,
        });
      },
      1 / 3,
    );
  }, []);

  // ⌘/Ctrl + wheel zooms around the pointer, like ZCode's PDF preview.
  useEffect(() => {
    const container = scrollRef.current!;
    let accumulated = 0;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      accumulated += event.deltaY;
      if (Math.abs(accumulated) < 40) return;
      const direction = accumulated < 0 ? 1 : -1;
      accumulated = 0;
      const rect = container.getBoundingClientRect();
      zoomAnchor.current = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      stepZoom(direction);
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, []);

  function stepZoom(direction: 1 | -1) {
    const percent = Math.round((scaleRef.current / CSS_UNITS) * 100);
    setZoom({ mode: null, percent: nextZoom(percent, direction) });
  }

  // Selection: text selection inside pages, or a click on a page outside its text.
  useEffect(() => {
    const container = scrollRef.current!;
    const pageOf = (node: Node | null) =>
      (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>(".pdf-page")
        ?.dataset.at;
    const clearPage = () =>
      container
        .querySelectorAll(".pdf-page.selected")
        .forEach((element) => element.classList.remove("selected"));
    const report = (event: Event) => {
      const selected = selectionIn(container);
      if (selected) {
        const start = pageOf(selected.range.startContainer);
        const end = pageOf(selected.range.endContainer);
        if (!start) return;
        clearPage();
        const a = Number(start.slice(5));
        const b = end ? Number(end.slice(5)) : a;
        const range = selected.range.cloneRange();
        callbacks.current.onSelect(
          { at: b > a ? `page:${a}-${b}` : start, text: selected.text },
          { text: true, locate: () => boxOf(range), user: true },
        );
        return;
      }
      if (event.type !== "mouseup") return;
      // A click on one of the agent's marks brings its note back instead of selecting.
      const { clientX, clientY } = event as MouseEvent;
      for (const [i, range] of revealRanges.current)
        if (pointOn(range, clientX, clientY) && callbacks.current.onRevealHit?.(i)) {
          clearPage();
          callbacks.current.onSelect(null);
          return;
        }
      const target = event.target as Element;
      if (target.closest(".pdf-link")) return;
      const page = target.closest<HTMLElement>(".pdf-page");
      clearPage();
      // A click on text (no drag) or outside the pages clears the selection.
      if (!page?.dataset.at || target.closest(".textLayer span")) {
        callbacks.current.onSelect(null);
        return;
      }
      page.classList.add("selected");
      callbacks.current.onSelect(
        { at: page.dataset.at, text: "" },
        { text: false, locate: () => boxOf(page), user: true },
      );
    };
    const onUp = (event: Event) => setTimeout(() => report(event), 0);
    container.addEventListener("mouseup", onUp);
    container.addEventListener("keyup", onUp);
    return () => {
      container.removeEventListener("mouseup", onUp);
      container.removeEventListener("keyup", onUp);
    };
  }, []);

  useImperativeHandle(
    ref,
    (): ViewerHandle => ({
      async reveal(targets) {
        this.clearReveal();
        const items: RevealItem[] = [];
        for (const target of targets) {
          const locator = parseLocator("pdf", target.at);
          if (locator.kind !== "pdf" || !slots.current[locator.from - 1]) continue;
          items.push({
            page: locator.from,
            to: locator.to,
            ...(target.quote ? { quote: target.quote } : {}),
          });
        }
        revealItems.current = items;
        // Quotes may sit on any page of a range: find the page that has it.
        for (const [i, item] of items.entries()) {
          if (!item.quote) {
            for (let n = item.page; n <= item.to; n++)
              slots.current[n - 1]?.element.classList.add("revealed");
            continue;
          }
          for (let n = item.page; n <= item.to; n++) {
            const slot = await rendered(n);
            const range = slot?.textLayer && findTextRange(slot.textLayer, item.quote);
            if (range) {
              item.page = n;
              revealRanges.current.set(i, range);
              break;
            }
          }
        }
        paint();
        const results: RevealedTarget[] = items.map((item, i) => ({
          at:
            item.to > item.page && !item.quote
              ? `page:${item.page}-${item.to}`
              : `page:${item.page}`,
          locate: () =>
            boxOf(revealRanges.current.get(i)) ?? boxOf(slots.current[item.page - 1]?.element),
          scrollTo: () => {
            const range = revealRanges.current.get(i);
            if (range?.startContainer.isConnected) scrollToRange(range, "upper");
            else if (item.quote)
              void rendered(item.page).then(() => {
                decorate(item.page);
                const again = revealRanges.current.get(i);
                if (again) scrollToRange(again, "upper");
                else scrollToPage(item.page);
              });
            else scrollToPage(item.page);
          },
        }));
        results[0]?.scrollTo();
        return results;
      },
      goTo(at) {
        const locator = parseLocator("pdf", at);
        if (locator.kind === "pdf") scrollToPage(locator.from);
      },
      clearReveal() {
        revealItems.current = [];
        revealRanges.current.clear();
        scrollRef.current
          ?.querySelectorAll(".pdf-page.revealed")
          .forEach((element) => element.classList.remove("revealed"));
        paint();
      },
      async capture(at, maxWidth) {
        const doc = docRef.current;
        if (!doc) throw new Error("The PDF is still loading.");
        const page = at ? parseLocator("pdf", at) : null;
        const number =
          page?.kind === "pdf"
            ? page.from
            : Number(
                (
                  slots.current.find(
                    (slot) =>
                      slot.element.getBoundingClientRect().bottom >
                      scrollRef.current!.getBoundingClientRect().top + 8,
                  )?.element.dataset.at ?? "page:1"
                ).slice(5),
              );
        if (number < 1 || number > doc.numPages)
          throw new Error(`Page ${number} does not exist; the PDF has ${doc.numPages} pages.`);
        const pdfPage = await doc.getPage(number);
        const base = pdfPage.getViewport({ scale: 1 });
        const viewport = pdfPage.getViewport({ scale: Math.min(3, maxWidth / base.width) });
        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const context = canvas.getContext("2d")!;
        context.fillStyle = "#fff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        await pdfPage.render({ canvas, canvasContext: context, viewport }).promise;
        return { ...canvasToPng(canvas, maxWidth), at: `page:${number}` };
      },
      zoom(direction) {
        stepZoom(direction);
      },
      fit(mode) {
        setZoom({ mode, percent: 100 });
      },
      async find(query) {
        const doc = docRef.current;
        if (!doc || !query.trim()) {
          this.clearFind();
          return 0;
        }
        const state = {
          query,
          matches: [] as { page: number; k: number }[],
          current: -1,
          ranges: new Map<number, Range[]>(),
        };
        find.current = state;
        const counts = await Promise.all(
          Array.from({ length: doc.numPages }, (_, i) =>
            pageText(i + 1).then((text) => countMatches(text, query)),
          ),
        );
        if (find.current !== state) return 0;
        counts.forEach((count, i) => {
          for (let k = 0; k < count; k++) state.matches.push({ page: i + 1, k });
        });
        for (const [i, slot] of slots.current.entries())
          if (slot.textLayer) state.ranges.set(i + 1, findAllRanges(slot.textLayer, query));
        paint();
        return state.matches.length;
      },
      findGo(index) {
        const state = find.current;
        const match = state?.matches[index];
        if (!state || !match) return;
        state.current = index;
        void rendered(match.page).then(() => {
          if (find.current !== state || state.current !== index) return;
          if (!state.ranges.has(match.page)) decorate(match.page);
          paint();
          const range = currentFindRange();
          if (range) scrollToRange(range, "center");
          else scrollToPage(match.page);
        });
        paint();
      },
      clearFind() {
        find.current = null;
        paint();
      },
      clearSelection() {
        scrollRef.current
          ?.querySelectorAll(".pdf-page.selected")
          .forEach((element) => element.classList.remove("selected"));
        const selection = document.getSelection();
        if (selection && scrollRef.current && selectionIn(scrollRef.current))
          selection.removeAllRanges();
      },
      goToPage(page) {
        scrollToPage(Math.min(Math.max(1, page), slots.current.length));
      },
      async thumbnail(page, width) {
        const doc = docRef.current;
        if (!doc) throw new Error("The PDF is still loading.");
        const pdfPage = await doc.getPage(page);
        const base = pdfPage.getViewport({ scale: 1 });
        const ratio = window.devicePixelRatio || 1;
        const viewport = pdfPage.getViewport({ scale: (width / base.width) * ratio });
        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${width}px`;
        canvas.style.height = `${(viewport.height / viewport.width) * width}px`;
        const context = canvas.getContext("2d")!;
        context.fillStyle = "#fff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        await pdfPage.render({ canvas, canvasContext: context, viewport }).promise;
        return canvas;
      },
    }),
    [],
  );

  return <div ref={scrollRef} className={`viewer-scroll pdf-scroll${glance ? " glance" : ""}`} />;
});
