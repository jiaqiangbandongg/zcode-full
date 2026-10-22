/** Only http(s) and mailto links leave the document; everything else is blocked. */
export function safeExternalUrl(href: string | null | undefined): string | null {
  if (!href) return null;
  try {
    const url = new URL(href, "https://invalid.invalid/");
    if (url.hostname === "invalid.invalid") return null;
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/**
 * Route clicks on links inside rendered documents: external links go to the host, in-document
 * anchors (`#bookmark`) are handled by `internal`, anything else is cancelled.
 */
export function installLinkGuard(
  root: HTMLElement,
  external: (url: string) => void,
  internal?: (hash: string, link: Element) => boolean,
): () => void {
  const onClick = (event: MouseEvent) => {
    const link = event.target instanceof Element ? event.target.closest("a, [href]") : null;
    if (!link || !root.contains(link)) return;
    const href = link.getAttribute("href") ?? link.getAttribute("xlink:href");
    if (!href) return;
    event.preventDefault();
    if (href.startsWith("#")) {
      if (internal?.(href.slice(1), link)) event.stopPropagation();
      return;
    }
    const url = safeExternalUrl(href);
    if (url) {
      event.stopPropagation();
      external(url);
    }
  };
  root.addEventListener("click", onClick, true);
  return () => root.removeEventListener("click", onClick, true);
}

/** Text of the current DOM selection if it lies inside `root`. */
export function selectionIn(root: HTMLElement): { text: string; range: Range } | null {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;
  const text = selection.toString().replace(/\s+/g, " ").trim();
  return text ? { text, range } : null;
}

const normalise = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

interface Flat {
  text: string;
  map: { node: Text; offset: number }[];
}

/** The text under `root`, lower-cased with whitespace collapsed, mapped back to (node, offset). */
function flatten(root: Node): Flat {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
  let text = "";
  const map: { node: Text; offset: number }[] = [];
  let lastSpace = true;
  for (const node of nodes) {
    const value = node.data;
    for (let i = 0; i < value.length; i++) {
      const char = value[i];
      if (/\s/.test(char)) {
        if (lastSpace) continue;
        text += " ";
        lastSpace = true;
      } else {
        text += char.toLowerCase();
        lastSpace = false;
      }
      map.push({ node, offset: i });
    }
    // Separate text nodes from different blocks (e.g. pdf.js spans without trailing spaces).
    if (!lastSpace) {
      text += " ";
      lastSpace = true;
      map.push({ node, offset: value.length });
    }
  }
  return { text, map };
}

function toRange(flat: Flat, span: [number, number]): Range {
  const start = flat.map[span[0]];
  const end = flat.map[Math.min(flat.map.length - 1, span[1])];
  const range = document.createRange();
  range.setStart(start.node, Math.min(start.node.data.length, start.offset));
  range.setEnd(end.node, Math.min(end.node.data.length, end.offset + 1));
  return range;
}

/**
 * Find `quote` in the text of `root` (whitespace- and case-insensitive) and return a DOM Range.
 */
export function findTextRange(root: Node, quote: string): Range | null {
  const needle = normalise(quote);
  if (!needle) return null;
  const flat = flatten(root);
  const exact = flat.text.indexOf(needle);
  const span: [number, number] | null =
    exact >= 0 ? [exact, exact + needle.length - 1] : fuzzy(flat.text, needle);
  return span ? toRange(flat, span) : null;
}

/** Every occurrence of `query` under `root`, in document order (at most `limit`). */
export function findAllRanges(root: Node, query: string, limit = 1000): Range[] {
  const needle = normalise(query);
  if (!needle) return [];
  const flat = flatten(root);
  const ranges: Range[] = [];
  for (
    let at = flat.text.indexOf(needle);
    at >= 0 && ranges.length < limit;
    at = flat.text.indexOf(needle, at + needle.length)
  )
    ranges.push(toRange(flat, [at, at + needle.length - 1]));
  return ranges;
}

/** Count occurrences of `query` in plain text the same way `findAllRanges` matches the DOM. */
export function countMatches(text: string, query: string): number {
  const needle = normalise(query);
  if (!needle) return 0;
  const haystack = normalise(text);
  let count = 0;
  for (
    let at = haystack.indexOf(needle);
    at >= 0;
    at = haystack.indexOf(needle, at + needle.length)
  )
    count++;
  return count;
}

/** On-screen box of a range or element; null when it is detached or has no size. */
export function boxOf(target: Range | Element | null | undefined): DOMRect | null {
  if (!target) return null;
  if (target instanceof Element && !target.isConnected) return null;
  if (target instanceof Range && !target.startContainer.isConnected) return null;
  const rect = target.getBoundingClientRect();
  return rect.width || rect.height ? rect : null;
}

/** Whether a client point falls on the boxes of a range or element (with a little slack). */
export function pointOn(
  target: Range | Element | null | undefined,
  x: number,
  y: number,
  slack = 2,
): boolean {
  if (!target) return false;
  if (target instanceof Element ? !target.isConnected : !target.startContainer.isConnected)
    return false;
  for (const rect of target.getClientRects())
    if (
      x >= rect.left - slack &&
      x <= rect.right + slack &&
      y >= rect.top - slack &&
      y <= rect.bottom + slack
    )
      return true;
  return false;
}

/** Union of boxes, ignoring missing ones. */
export function unionBox(boxes: (DOMRect | null)[]): DOMRect | null {
  const present = boxes.filter((box): box is DOMRect => Boolean(box));
  if (!present.length) return null;
  const left = Math.min(...present.map((box) => box.left));
  const top = Math.min(...present.map((box) => box.top));
  const right = Math.max(...present.map((box) => box.right));
  const bottom = Math.max(...present.map((box) => box.bottom));
  return new DOMRect(left, top, right - left, bottom - top);
}

/** Match ignoring spaces entirely (pdf.js often splits words into spans). Returns [start, end] in `flat`. */
function fuzzy(flat: string, needle: string): [number, number] | null {
  const compactNeedle = needle.replace(/ /g, "");
  const positions: number[] = [];
  let compact = "";
  for (let i = 0; i < flat.length; i++) {
    if (flat[i] === " ") continue;
    compact += flat[i];
    positions.push(i);
  }
  const at = compactNeedle ? compact.indexOf(compactNeedle) : -1;
  return at < 0 ? null : [positions[at], positions[at + compactNeedle.length - 1]];
}

type HighlightRegistry = Map<string, unknown>;
const registry = (): HighlightRegistry | null =>
  (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS?.highlights ?? null;

/** Paint ranges with the CSS Custom Highlight API under `name` (no DOM mutation). */
export function paintRanges(name: string, ranges: Range[]) {
  const highlights = registry();
  const HighlightCtor = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown })
    .Highlight;
  if (!highlights || !HighlightCtor) return;
  if (ranges.length) highlights.set(name, new HighlightCtor(...ranges));
  else highlights.delete(name);
}

/**
 * Scroll the viewer's own scroll container so `element` is visible. Never use scrollIntoView: it
 * also scrolls every ancestor (the app shell and the host frames), which pushes the toolbar away.
 */
export function scrollToElement(element: Element, block: "start" | "center" | "upper" = "center") {
  const container = element.closest<HTMLElement>(".viewer-scroll");
  if (container) scrollToBox(container, element.getBoundingClientRect(), block);
}

/** Scroll the viewer that contains `range` so it sits 30% from the top ("upper"), as reveals do. */
export function scrollToRange(range: Range, block: "start" | "center" | "upper" = "upper") {
  const container = range.startContainer.parentElement?.closest<HTMLElement>(".viewer-scroll");
  if (container) scrollToBox(container, range.getBoundingClientRect(), block);
}

function scrollToBox(container: HTMLElement, rect: DOMRect, block: "start" | "center" | "upper") {
  const box = container.getBoundingClientRect();
  let top = container.scrollTop + rect.top - box.top;
  top -=
    block === "center"
      ? Math.max(12, (box.height - rect.height) / 2)
      : block === "upper"
        ? Math.max(12, box.height * 0.3)
        : 12;
  let left = container.scrollLeft;
  if (rect.right > box.right || rect.left < box.left) left += rect.left - box.left - 12;
  container.scrollTo({ top: Math.max(0, top), left: Math.max(0, left), behavior: "smooth" });
}

/**
 * Watch which child of `container` is current; calls back with its key. The current child is the
 * one under the probe line (`probe` × the view height from the top, e.g. 1/3 for pages), else the
 * topmost one in view.
 */
export function trackTopmost(
  container: HTMLElement,
  items: () => Iterable<HTMLElement>,
  key: (element: HTMLElement) => string | null,
  onChange: (key: string) => void,
  probe = 0,
): () => void {
  let last: string | null = null;
  let frame = 0;
  const check = () => {
    frame = 0;
    const top = container.getBoundingClientRect().top;
    const line = top + container.clientHeight * probe;
    let best: HTMLElement | null = null;
    let bestDistance = Infinity;
    for (const element of items()) {
      const rect = element.getBoundingClientRect();
      if (probe && rect.top <= line && rect.bottom >= line) {
        best = element;
        break;
      }
      if (rect.bottom < top + 8) continue;
      const distance = Math.abs(rect.top - top);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = element;
      }
      if (rect.top > top + container.clientHeight) break;
    }
    const next = best ? key(best) : null;
    if (next && next !== last) {
      last = next;
      onChange(next);
    }
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(check);
  };
  container.addEventListener("scroll", schedule, { passive: true });
  const observer = new ResizeObserver(schedule);
  observer.observe(container);
  schedule();
  return () => {
    container.removeEventListener("scroll", schedule);
    observer.disconnect();
    if (frame) cancelAnimationFrame(frame);
  };
}
