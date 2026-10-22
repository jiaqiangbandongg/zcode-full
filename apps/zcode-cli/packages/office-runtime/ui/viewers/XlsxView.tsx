import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  XlsxViewer,
  setWasmSource,
  useXlsxViewerController,
  type XlsxCellRange,
  type XlsxCellStyleContext,
  type XlsxViewerController,
} from "@extend-ai/react-xlsx";
import { formatCell, formatLocator, parseLocator } from "#office/domain/anchor.ts";
import { readBinary, readText } from "#ui/assets.ts";
import { boxOf, installLinkGuard } from "#ui/dom.ts";
import { rasterize } from "#ui/raster.ts";
import type { RevealedTarget, ViewerHandle, ViewerProps } from "#ui/viewers/types.ts";

let wasm: Promise<void> | undefined;
/**
 * react-xlsx parses workbooks with wasm in a module worker. The sandbox cannot fetch, so hand it the
 * wasm bytes and a blob URL for the worker (the build points the library at `__officeXlsxWorkerUrl`).
 */
export function loadXlsxWasm(): Promise<void> {
  return (wasm ??= Promise.all([readBinary("sheets.wasm"), readText("xlsx-worker.js")]).then(
    ([bytes, worker]) => {
      (globalThis as { __officeXlsxWorkerUrl?: string }).__officeXlsxWorkerUrl =
        URL.createObjectURL(new Blob([worker], { type: "text/javascript" }));
      setWasmSource(bytes);
    },
  ));
}

/** 0-based viewer range → 1-based anchor locator. */
function anchorOf(sheet: string, range: XlsxCellRange): string {
  return formatLocator({
    kind: "xlsx",
    sheet,
    range: {
      start: {
        row: Math.min(range.start.row, range.end.row) + 1,
        col: Math.min(range.start.col, range.end.col) + 1,
      },
      end: {
        row: Math.max(range.start.row, range.end.row) + 1,
        col: Math.max(range.start.col, range.end.col) + 1,
      },
    },
  });
}

/** Display value and formula of a cell; worker-backed workbooks only answer asynchronously. */
async function cellSnapshot(controller: XlsxViewerController, row: number, col: number) {
  const sheet = controller.activeSheet;
  if (controller.getCellSnapshotAsync && sheet && controller.isWorkerBacked)
    return controller
      .getCellSnapshotAsync(sheet.workbookSheetIndex, row, col)
      .catch(() => ({ displayValue: "", formula: "" }));
  return {
    displayValue: controller.getCellDisplayValue({ row, col }),
    formula: controller.getCellFormula({ row, col }),
  };
}

/** Values of a range as tab-separated text (capped at 50 rows × 20 columns). */
async function rangeText(controller: XlsxViewerController, range: XlsxCellRange): Promise<string> {
  const top = Math.min(range.start.row, range.end.row);
  const bottom = Math.min(Math.max(range.start.row, range.end.row), top + 49);
  const left = Math.min(range.start.col, range.end.col);
  const right = Math.min(Math.max(range.start.col, range.end.col), left + 19);
  const single = top === bottom && left === right;
  const rows: Promise<string>[] = [];
  for (let row = top; row <= bottom; row++) {
    const cells: Promise<string>[] = [];
    for (let col = left; col <= right; col++)
      cells.push(
        cellSnapshot(controller, row, col).then(({ displayValue, formula }) =>
          formula && single ? `${displayValue} (=${formula.replace(/^=/, "")})` : displayValue,
        ),
      );
    rows.push(Promise.all(cells).then((values) => values.join("\t")));
  }
  return (await Promise.all(rows)).join("\n").trim();
}

interface Highlight {
  sheet: string;
  top: number;
  left: number;
  bottom: number;
  right: number;
}

const REVEAL_STYLE: CSSProperties = {
  backgroundColor: "rgba(255, 179, 0, 0.38)",
  boxShadow: "inset 0 -2px 0 #e59a00",
};
const FIND_STYLE: CSSProperties = { backgroundColor: "rgba(255, 213, 0, 0.45)" };
const FIND_CURRENT_STYLE: CSSProperties = {
  backgroundColor: "rgba(255, 140, 0, 0.6)",
  boxShadow: "inset 0 0 0 1px #e07b00",
};

const inside = (item: Highlight, sheet: string, row: number, col: number) =>
  item.sheet === sheet &&
  row >= item.top &&
  row <= item.bottom &&
  col >= item.left &&
  col <= item.right;

/** The grid's drawing surface (the largest canvas); it moves as the sheet scrolls. */
function gridCanvas(root: HTMLElement | null): HTMLCanvasElement | null {
  let best: HTMLCanvasElement | null = null;
  let area = 0;
  for (const canvas of root?.querySelectorAll<HTMLCanvasElement>(".xlsx-grid canvas") ?? []) {
    const rect = canvas.getBoundingClientRect();
    if (rect.width * rect.height > area) {
      area = rect.width * rect.height;
      best = canvas;
    }
  }
  return best;
}

interface Press {
  start: { x: number; y: number };
  end: { x: number; y: number };
  /** Grid surface position when pressed, to follow later scrolling. */
  surface: DOMRect | null;
}

/**
 * The grid is drawn on canvas, so cells have no boxes; the selection bar anchors to where the
 * user pressed (or dragged), shifted by however far the sheet has scrolled since.
 */
function pressBox(root: HTMLElement | null, press: Press): DOMRect | null {
  const now = boxOf(gridCanvas(root));
  const dx = press.surface && now ? now.left - press.surface.left : 0;
  const dy = press.surface && now ? now.top - press.surface.top : 0;
  const left = Math.min(press.start.x, press.end.x) + dx;
  const top = Math.min(press.start.y, press.end.y) + dy;
  return new DOMRect(
    left,
    top - 8,
    Math.max(2, Math.abs(press.end.x - press.start.x)),
    Math.max(16, Math.abs(press.end.y - press.start.y) + 16),
  );
}

function SheetTabs({ controller }: { controller: XlsxViewerController }) {
  if (controller.tabs.length <= 1) return null;
  return (
    <div className="sheet-tabs" role="tablist">
      {controller.tabs.map((tab, index) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={index === controller.activeTabIndex}
          className={index === controller.activeTabIndex ? "active" : ""}
          onClick={() => controller.setActiveTabIndex(index)}
          title={tab.name}
        >
          {tab.name}
        </button>
      ))}
    </div>
  );
}

export const XlsxView = forwardRef<ViewerHandle, ViewerProps>(function XlsxView(props, ref) {
  const rootRef = useRef<HTMLDivElement>(null);
  const callbacks = useRef(props);
  callbacks.current = props;
  const controller = useXlsxViewerController({
    file: props.bytes,
    fileName: props.info.path,
    readOnly: true,
  });
  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  const [revealed, setRevealed] = useState<Highlight[]>([]);
  /** Agent targets with a cell range, by their position in the last reveal result. */
  const revealHits = useRef<{ item: Highlight; index: number }[]>([]);
  const [found, setFound] = useState<{ items: Highlight[]; current: number }>({
    items: [],
    current: -1,
  });
  const foundRef = useRef(found);
  foundRef.current = found;
  const readyRef = useRef(false);
  /** Set by a pointer or key action in the grid; selections without one open no selection bar. */
  /** Last pointer or key action in the grid; selections long after one open no selection bar. */
  const acted = useRef<{ time: number; press: Press | null }>({ time: 0, press: null });
  /** Bumped by every press in the grid so clicking the selected cell shows the bar again. */
  const [presses, setPresses] = useState(0);

  useEffect(() => {
    if (controller.error) callbacks.current.onError(controller.error);
    else if (!controller.isLoading && controller.sheets.length && !readyRef.current) {
      readyRef.current = true;
      callbacks.current.onReady();
    }
  }, [controller.error, controller.isLoading, controller.sheets.length]);

  const sheetName = controller.activeSheet?.name ?? controller.activeTab?.name ?? "";

  // Location: active sheet and cell.
  useEffect(() => {
    if (!sheetName) return;
    const cell = controller.activeCell;
    callbacks.current.onLocation(
      cell
        ? formatLocator({
            kind: "xlsx",
            sheet: sheetName,
            range: {
              start: { row: cell.row + 1, col: cell.col + 1 },
              end: { row: cell.row + 1, col: cell.col + 1 },
            },
          })
        : formatLocator({ kind: "xlsx", sheet: sheetName }),
    );
  }, [sheetName, controller.activeCell?.row, controller.activeCell?.col]);

  // Selection: report the selected range (or active cell) with its values.
  const selectionKey = controller.selection
    ? JSON.stringify(controller.selection)
    : controller.activeCellAddress;
  useEffect(() => {
    if (!sheetName || !readyRef.current) return;
    const range =
      controller.selection ??
      (controller.activeCell ? { start: controller.activeCell, end: controller.activeCell } : null);
    if (!range) return;
    let current = true;
    const at = anchorOf(sheetName, range);
    let user = performance.now() - acted.current.time < 1500;
    const pressed = user ? acted.current.press : null;
    // A click inside one of the agent's ranges brings its note back instead of the bar.
    if (pressed) {
      const row = Math.min(range.start.row, range.end.row);
      const col = Math.min(range.start.col, range.end.col);
      const hit = revealHits.current.find(({ item }) => inside(item, sheetName, row, col));
      if (hit && callbacks.current.onRevealHit?.(hit.index)) user = false;
    }
    const detail = {
      text: false,
      locate: () => (pressed ? pressBox(rootRef.current, pressed) : null),
      user,
    };
    void rangeText(controller, range).then(
      (text) => current && callbacks.current.onSelect({ at, text }, detail),
      () => current && callbacks.current.onSelect({ at, text: "" }, detail),
    );
    return () => {
      current = false;
    };
  }, [selectionKey, sheetName, presses]);

  useEffect(() => {
    const root = rootRef.current!;
    const unguard = installLinkGuard(root, (url) => callbacks.current.onLink(url));
    const inGrid = (event: Event) => Boolean((event.target as Element).closest?.(".xlsx-grid"));
    let pressing = false;
    const act = (event: PointerEvent) => {
      if (!inGrid(event)) return;
      pressing = true;
      const point = { x: event.clientX, y: event.clientY };
      acted.current = {
        time: performance.now(),
        press: { start: point, end: point, surface: boxOf(gridCanvas(root)) },
      };
    };
    const release = (event: PointerEvent) => {
      if (!pressing || !acted.current.press) return;
      pressing = false;
      acted.current = {
        time: performance.now(),
        press: { ...acted.current.press, end: { x: event.clientX, y: event.clientY } },
      };
      setPresses((count) => count + 1);
    };
    const key = (event: KeyboardEvent) => {
      if (inGrid(event)) acted.current = { time: performance.now(), press: null };
    };
    root.addEventListener("pointerdown", act, true);
    root.addEventListener("pointerup", release, true);
    root.addEventListener("keydown", key, true);
    return () => {
      unguard();
      root.removeEventListener("pointerdown", act, true);
      root.removeEventListener("pointerup", release, true);
      root.removeEventListener("keydown", key, true);
    };
  }, []);

  const getCellStyle = useCallback(
    (context: XlsxCellStyleContext): CSSProperties | undefined => {
      const { row, col } = context.cell;
      const current = found.items[found.current];
      if (current && inside(current, context.sheetName, row, col)) return FIND_CURRENT_STYLE;
      if (found.items.some((item) => inside(item, context.sheetName, row, col))) return FIND_STYLE;
      if (revealed.some((item) => inside(item, context.sheetName, row, col))) return REVEAL_STYLE;
      return undefined;
    },
    [revealed, found],
  );

  function tabIndexFor(name: string): number {
    const tabs = controllerRef.current.tabs;
    const exact = tabs.findIndex((tab) => tab.name === name);
    return exact >= 0
      ? exact
      : tabs.findIndex((tab) => tab.name.toLowerCase() === name.toLowerCase());
  }

  const waitFrame = () =>
    new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  useImperativeHandle(
    ref,
    (): ViewerHandle => ({
      async reveal(targets) {
        const next: Highlight[] = [];
        const results: RevealedTarget[] = [];
        revealHits.current = [];
        for (const target of targets) {
          const locator = parseLocator("xlsx", target.at);
          if (locator.kind !== "xlsx") continue;
          const tab = tabIndexFor(locator.sheet);
          if (tab < 0) continue;
          const name = controllerRef.current.tabs[tab].name;
          const item: Highlight | null = locator.range
            ? {
                sheet: name,
                top: locator.range.start.row - 1,
                left: locator.range.start.col - 1,
                bottom: locator.range.end.row - 1,
                right: locator.range.end.col - 1,
              }
            : null;
          if (item) {
            next.push(item);
            revealHits.current.push({ item, index: results.length });
          }
          const show = async () => {
            if (tab !== controllerRef.current.activeTabIndex) {
              controllerRef.current.setActiveTabIndex(tab);
              await waitFrame();
            }
            if (item)
              controllerRef.current.selectRange({
                start: { row: item.top, col: item.left },
                end: { row: item.bottom, col: item.right },
              });
          };
          // Cells are drawn on canvas: the callout docks at the top of the sheet.
          results.push({ at: target.at, locate: () => null, scrollTo: () => void show() });
        }
        setRevealed(next);
        if (results[0]) {
          results[0].scrollTo();
          await waitFrame();
        }
        return results;
      },
      goTo(at) {
        const locator = parseLocator("xlsx", at);
        if (locator.kind !== "xlsx") return;
        const tab = tabIndexFor(locator.sheet);
        if (tab >= 0 && tab !== controllerRef.current.activeTabIndex)
          controllerRef.current.setActiveTabIndex(tab);
      },
      clearReveal() {
        revealHits.current = [];
        setRevealed([]);
      },
      async capture(at, maxWidth) {
        if (at) {
          await this.reveal([{ at }]);
          await waitFrame();
          await waitFrame();
        }
        const root = rootRef.current!;
        const raster = await rasterize(root, {
          maxWidth,
          background: props.dark ? "#1e1e1e" : "#fff",
        });
        const active = controllerRef.current;
        const name = active.activeSheet?.name ?? "";
        return {
          ...raster,
          at:
            at ??
            (active.activeCell
              ? `${formatLocator({ kind: "xlsx", sheet: name })}!${formatCell({ row: active.activeCell.row + 1, col: active.activeCell.col + 1 })}`
              : formatLocator({ kind: "xlsx", sheet: name })),
        };
      },
      zoom(direction) {
        if (direction > 0) controllerRef.current.zoomIn();
        else controllerRef.current.zoomOut();
      },
      fit() {
        controllerRef.current.resetZoom();
      },
      async find(query) {
        const needle = query.trim().toLowerCase();
        const active = controllerRef.current;
        const sheet = active.activeSheet;
        if (!needle || !sheet) {
          setFound({ items: [], current: -1 });
          return 0;
        }
        const items: Highlight[] = [];
        const lastRow = Math.min(sheet.maxUsedRow, sheet.minUsedRow + 2000);
        const lastCol = Math.min(sheet.maxUsedCol, sheet.minUsedCol + 100);
        for (let row = sheet.minUsedRow; row <= lastRow && items.length < 500; row++) {
          const values = await Promise.all(
            Array.from({ length: lastCol - sheet.minUsedCol + 1 }, (_, i) =>
              cellSnapshot(active, row, sheet.minUsedCol + i),
            ),
          );
          values.forEach(({ displayValue }, i) => {
            const col = sheet.minUsedCol + i;
            if (displayValue.toLowerCase().includes(needle))
              items.push({ sheet: sheet.name, top: row, left: col, bottom: row, right: col });
          });
        }
        setFound({ items, current: -1 });
        return items.length;
      },
      findGo(index) {
        const item = foundRef.current.items[index];
        if (!item) return;
        setFound((state) => ({ ...state, current: index }));
        controllerRef.current.selectCell({ row: item.top, col: item.left });
      },
      clearFind() {
        setFound({ items: [], current: -1 });
      },
      clearSelection() {},
    }),
    [props.dark],
  );

  return (
    <div ref={rootRef} className={`xlsx-root${props.glance ? " glance" : ""}`}>
      <div className="xlsx-grid">
        <XlsxViewer
          controller={controller}
          height="100%"
          isDark={props.dark}
          readOnly
          rounded={false}
          showDefaultToolbar={false}
          getCellStyle={getCellStyle}
          loadingState={<div className="viewer-pending" aria-busy="true" />}
        />
      </div>
      <SheetTabs controller={controller} />
    </div>
  );
});
