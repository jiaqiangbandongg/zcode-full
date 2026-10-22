import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { renderAsync } from "docx-preview";
import { parseLocator } from "#office/domain/anchor.ts";
import { cut } from "#office/domain/text.ts";
import {
  boxOf,
  findAllRanges,
  pointOn,
  findTextRange,
  installLinkGuard,
  paintRanges,
  scrollToElement,
  scrollToRange,
  selectionIn,
  trackTopmost,
  unionBox,
} from "#ui/dom.ts";
import { rasterize } from "#ui/raster.ts";
import { alignBlocks } from "#ui/viewers/align.ts";
import {
  nextZoom,
  type FitMode,
  type RevealedTarget,
  type ViewerHandle,
  type ViewerProps,
} from "#ui/viewers/types.ts";

const CLASS = "office-docx";

/** Block element for a locator: `p:N` / `t:N` map to rendered elements, `t:N/rRcC` to a cell. */
function elementsFor(root: HTMLElement, at: string): HTMLElement[] {
  const locator = parseLocator("docx", at);
  if (locator.kind !== "docx") return [];
  if (locator.type === "paragraph") {
    const out: HTMLElement[] = [];
    for (let n = locator.from; n <= locator.to; n++)
      out.push(...root.querySelectorAll<HTMLElement>(`[data-at="p:${n}"]`));
    return out;
  }
  const tables = [...root.querySelectorAll<HTMLElement>(`[data-at="t:${locator.table}"]`)];
  if (!locator.cell) return tables;
  for (const table of tables) {
    const cell = rowsOf(table)[locator.cell.row - 1]?.cells[locator.cell.col - 1];
    if (cell) return [cell as HTMLElement];
  }
  return tables;
}

/**
 * Word list bullets use private-use glyphs of the Symbol / Wingdings fonts, which the sandbox does
 * not have; map the common ones to Unicode bullets in docx-preview's generated numbering CSS.
 */
const SYMBOL_BULLETS: Record<number, string> = {
  0xf0b7: "\u2022",
  0xf0a7: "\u25aa",
  0xf06f: "\u25e6",
  0xf0a8: "\u25cb",
  0xf0d8: "\u27a2",
  0xf0e0: "\u27a2",
  0xf0fc: "\u2713",
  0xf076: "\u2756",
};
function fixSymbolBullets(styles: HTMLElement) {
  for (const style of styles.querySelectorAll("style")) {
    const text = style.textContent ?? "";
    const next = text.replace(
      /[\uf020-\uf0ff]/g,
      (char) => SYMBOL_BULLETS[char.charCodeAt(0)] ?? "\u2022",
    );
    if (next !== text) style.textContent = next;
  }
}

function rowsOf(table: HTMLElement): HTMLTableRowElement[] {
  return [...(table as HTMLTableElement).rows].filter((row) => row.closest("table") === table);
}

/** Canvas padding (CSS keeps .docx-scroll in step). */
const PADDING = 16;

export const DocxView = forwardRef<ViewerHandle, ViewerProps>(function DocxView(props, ref) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const styleRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState<{ mode: FitMode | null; percent: number }>({
    mode: "width",
    percent: 100,
  });
  /** Natural (unzoomed) page size, measured once after rendering. */
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const callbacks = useRef(props);
  callbacks.current = props;
  const glance = Boolean(props.glance);

  const scale = (() => {
    if (!natural || !box.width) return 1;
    const fitWidth = Math.min(2, (box.width - PADDING * 2) / natural.width);
    if (zoom.mode === "width" || glance) return fitWidth;
    if (zoom.mode === "page")
      return Math.min(fitWidth, (box.height - PADDING * 2) / natural.height);
    if (zoom.mode === "actual") return 1;
    return zoom.percent / 100;
  })();
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const previousScale = useRef(scale);
  /** The agent's marks: painted quote ranges, and per target what a click on it hits. */
  const reveal = useRef<{ ranges: Range[]; hits: (Range | HTMLElement[])[] }>({
    ranges: [],
    hits: [],
  });
  const find = useRef<{ ranges: Range[]; current: number } | null>(null);

  const sections = () => [
    ...(bodyRef.current?.querySelectorAll<HTMLElement>(`section.${CLASS}`) ?? []),
  ];

  useEffect(() => {
    let active = true;
    const body = bodyRef.current!;
    const styles = styleRef.current!;
    body.replaceChildren();
    styles.replaceChildren();
    renderAsync(props.bytes, body, styles, {
      className: CLASS,
      inWrapper: true,
      breakPages: true,
      ignoreLastRenderedPageBreak: true,
      experimental: true,
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true,
      renderEndnotes: true,
      renderComments: false,
      renderChanges: false,
      renderAltChunks: false,
      useBase64URL: true,
    })
      .then(() => {
        if (!active) return;
        fixSymbolBullets(styles);
        annotate(body);
        const page = sections()[0];
        if (page) {
          const current = scaleRef.current || 1;
          const rect = page.getBoundingClientRect();
          setNatural({ width: rect.width / current, height: rect.height / current });
        }
        callbacks.current.onPage?.({ current: 1, count: Math.max(1, sections().length) });
        callbacks.current.onReady();
      })
      .catch((error) => active && callbacks.current.onError(error));
    return () => {
      active = false;
    };
  }, [props.bytes]);

  /** Tag rendered body elements with their locators (data-at). */
  function annotate(body: HTMLElement) {
    const elements: HTMLElement[] = [];
    for (const article of body.querySelectorAll<HTMLElement>(`section.${CLASS} > article`)) {
      const walk = (parent: Element) => {
        for (const child of parent.children) {
          const tag = child.tagName;
          if (tag === "P" || /^H[1-6]$/.test(tag)) elements.push(child as HTMLElement);
          else if (tag === "TABLE") elements.push(child as HTMLElement);
          else if (!["HEADER", "FOOTER", "OL", "UL"].includes(tag) || child.children.length)
            walk(child);
        }
      };
      walk(article);
    }
    const keys = alignBlocks(
      elements.map((element) => ({
        text: element.textContent ?? "",
        table: element.tagName === "TABLE",
      })),
      callbacks.current.blocks ?? [],
    );
    elements.forEach((element, i) => {
      if (keys[i]) element.dataset.at = keys[i]!;
    });
  }

  // Report zoom; keep the centre of the view in place when it changes.
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    const before = previousScale.current;
    previousScale.current = scale;
    if (natural) callbacks.current.onZoom?.({ mode: zoom.mode, percent: Math.round(scale * 100) });
    if (!scroll || !before || before === scale) return;
    const ratio = scale / before;
    const x = scroll.clientWidth / 2;
    const y = scroll.clientHeight / 2;
    scroll.scrollTo({
      left: Math.max(0, (scroll.scrollLeft + x - PADDING) * ratio + PADDING - x),
      top: Math.max(0, (scroll.scrollTop + y - PADDING) * ratio + PADDING - y),
    });
  }, [scale, natural, zoom.mode]);

  function paint() {
    paintRanges("office-reveal", reveal.current.ranges);
    const state = find.current;
    const current = state ? state.ranges[state.current] : undefined;
    paintRanges("office-find", state ? state.ranges.filter((range) => range !== current) : []);
    paintRanges("office-find-current", current ? [current] : []);
  }

  useEffect(() => {
    const scroll = scrollRef.current!;
    const resize = new ResizeObserver(() =>
      setBox((previous) =>
        Math.abs(previous.width - scroll.clientWidth) > 1 ||
        Math.abs(previous.height - scroll.clientHeight) > 1
          ? { width: scroll.clientWidth, height: scroll.clientHeight }
          : previous,
      ),
    );
    resize.observe(scroll);
    const unguard = installLinkGuard(
      bodyRef.current!,
      (url) => callbacks.current.onLink(url),
      (hash) => {
        const target = bodyRef.current!.querySelector(
          `[id="${CSS.escape(hash)}"], a[name="${CSS.escape(hash)}"]`,
        );
        if (target) scrollToElement(target, "start");
        return Boolean(target);
      },
    );
    const untrack = trackTopmost(
      scroll,
      () => scroll.querySelectorAll<HTMLElement>("[data-at]"),
      (element) => element.dataset.at ?? null,
      (at) => callbacks.current.onLocation(at),
    );
    const untrackPages = trackTopmost(
      scroll,
      sections,
      (element) => String(sections().indexOf(element) + 1),
      (page) =>
        callbacks.current.onPage?.({
          current: Number(page),
          count: Math.max(1, sections().length),
        }),
      1 / 3,
    );
    const clearOutline = () =>
      scroll
        .querySelectorAll(".office-selected")
        .forEach((element) => element.classList.remove("office-selected"));
    const select = (event: Event) => {
      const selected = selectionIn(bodyRef.current!);
      if (selected) {
        const start =
          selected.range.startContainer.parentElement?.closest<HTMLElement>("[data-at]")?.dataset
            .at;
        const end =
          selected.range.endContainer.parentElement?.closest<HTMLElement>("[data-at]")?.dataset.at;
        if (!start) return;
        let at = start;
        const a = /^p:(\d+)$/.exec(start);
        const b = end && /^p:(\d+)$/.exec(end);
        if (a && b && Number(b[1]) > Number(a[1])) at = `p:${a[1]}-${b[1]}`;
        clearOutline();
        const range = selected.range.cloneRange();
        callbacks.current.onSelect(
          { at, text: selected.text },
          { text: true, locate: () => boxOf(range), user: true },
        );
        return;
      }
      if (event.type !== "click") return;
      // A click on one of the agent's marks brings its note back instead of selecting.
      const { clientX, clientY } = event as MouseEvent;
      const hit = reveal.current.hits.findIndex((mark) =>
        Array.isArray(mark)
          ? mark.some((element) => pointOn(element, clientX, clientY))
          : pointOn(mark, clientX, clientY),
      );
      if (hit >= 0 && callbacks.current.onRevealHit?.(hit)) {
        clearOutline();
        callbacks.current.onSelect(null);
        return;
      }
      const target = event.target as Element;
      if (target.closest("a[href]")) return;
      const cell = target.closest("td, th");
      const block = target.closest<HTMLElement>("[data-at]");
      clearOutline();
      if (!block?.dataset.at) {
        callbacks.current.onSelect(null);
        return;
      }
      let at = block.dataset.at;
      let text = block.textContent ?? "";
      if (cell && block.tagName === "TABLE") {
        const rows = rowsOf(block);
        const row = rows.findIndex((item) => item.contains(cell));
        const col = row >= 0 ? [...rows[row].cells].indexOf(cell as HTMLTableCellElement) : -1;
        if (row >= 0 && col >= 0) {
          at = `${block.dataset.at}/r${row + 1}c${col + 1}`;
          text = cell.textContent ?? "";
        }
      }
      const outlined = (cell && at.includes("/r") ? cell : block) as HTMLElement;
      outlined.classList.add("office-selected");
      callbacks.current.onSelect(
        { at, text: cut(text.replace(/\s+/g, " ").trim(), 0, 2000) },
        { text: false, locate: () => boxOf(outlined), user: true },
      );
    };
    const deferred = (event: Event) => setTimeout(() => select(event), 0);
    scroll.addEventListener("mouseup", deferred);
    scroll.addEventListener("click", select);
    return () => {
      resize.disconnect();
      unguard();
      untrack();
      untrackPages();
      scroll.removeEventListener("mouseup", deferred);
      scroll.removeEventListener("click", select);
    };
  }, []);

  useImperativeHandle(
    ref,
    (): ViewerHandle => ({
      async reveal(targets) {
        this.clearReveal();
        const body = bodyRef.current!;
        const results: RevealedTarget[] = [];
        for (const target of targets) {
          const elements = elementsFor(body, target.at);
          if (!elements.length) continue;
          let range: Range | null = null;
          if (target.quote)
            for (const element of elements) {
              range = findTextRange(element, target.quote);
              if (range) break;
            }
          if (range) reveal.current.ranges.push(range);
          else for (const element of elements) element.classList.add("office-revealed");
          reveal.current.hits.push(range ?? elements);
          const found = range;
          results.push({
            at: target.at,
            locate: () =>
              found ? boxOf(found) : unionBox(elements.map((element) => boxOf(element))),
            scrollTo: () =>
              found ? scrollToRange(found, "upper") : scrollToElement(elements[0], "upper"),
          });
        }
        paint();
        results[0]?.scrollTo();
        return results;
      },
      goTo(at) {
        const element = elementsFor(bodyRef.current!, at)[0];
        if (element) scrollToElement(element, "start");
      },
      clearReveal() {
        reveal.current = { ranges: [], hits: [] };
        bodyRef.current
          ?.querySelectorAll(".office-revealed")
          .forEach((element) => element.classList.remove("office-revealed"));
        paint();
      },
      async capture(at, maxWidth) {
        const body = bodyRef.current!;
        const scroll = scrollRef.current!;
        let anchor: HTMLElement | null = at ? (elementsFor(body, at)[0] ?? null) : null;
        if (at && !anchor) throw new Error(`Cannot find ${at} in the rendered document.`);
        let page: HTMLElement | null = anchor?.closest<HTMLElement>(`section.${CLASS}`) ?? null;
        if (!page) {
          const top = scroll.getBoundingClientRect().top;
          page =
            sections().find((section) => section.getBoundingClientRect().bottom > top + 8) ?? null;
        }
        if (!page) throw new Error("Nothing is rendered yet.");
        anchor ??= page.querySelector<HTMLElement>("[data-at]");
        const raster = await rasterize(page, { maxWidth, context: body, background: "#fff" });
        return { ...raster, at: anchor?.dataset.at ?? `page ${sections().indexOf(page) + 1}` };
      },
      zoom(direction) {
        setZoom({ mode: null, percent: nextZoom(Math.round(scaleRef.current * 100), direction) });
      },
      fit(mode) {
        setZoom({ mode, percent: 100 });
      },
      async find(query) {
        const ranges = query.trim() ? findAllRanges(bodyRef.current!, query) : [];
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
        scrollRef.current
          ?.querySelectorAll(".office-selected")
          .forEach((element) => element.classList.remove("office-selected"));
        if (bodyRef.current && selectionIn(bodyRef.current))
          document.getSelection()?.removeAllRanges();
      },
      goToPage(page) {
        const all = sections();
        const target = all[Math.min(Math.max(1, page), all.length) - 1];
        if (target) scrollToElement(target, "start");
      },
    }),
    [],
  );

  return (
    <div ref={scrollRef} className={`viewer-scroll docx-scroll${glance ? " glance" : ""}`}>
      <div ref={styleRef} />
      <div className="docx-zoom" style={{ zoom: scale }}>
        <div ref={bodyRef} />
      </div>
    </div>
  );
});
