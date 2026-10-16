import { RGBA, StyledText, type TextChunk } from "@mbears/opentui-core";
import React from "react";
import type { ToolResultDisplayHunk, ToolResultDisplayLine } from "./app-model.js";
import {
  highlightShikiCodeLines,
  type ShikiHighlightSegment,
} from "./app-shiki-highlighter.js";
import { activeTuiTheme, type TuiThemeTokens } from "./theme/index.js";

const SPLIT_DIFF_WIDTH_BREAKPOINT = 120;
const LINE_NUMBER_WIDTH = 4;
const GUTTER_TRAILING_SPACE = " ";
const UNIFIED_EMPTY_MARKER = " ";
const EMPTY_LINE_NUMBER = "";
const SHIKI_FONT_STYLE_ITALIC = 1;
const SHIKI_FONT_STYLE_BOLD = 2;
const SHIKI_FONT_STYLE_UNDERLINE = 4;
const SHIKI_FONT_STYLE_STRIKETHROUGH = 8;
const OPENTUI_BOLD_ATTRIBUTE = 1;
const OPENTUI_ITALIC_ATTRIBUTE = 4;
const OPENTUI_UNDERLINE_ATTRIBUTE = 8;
const OPENTUI_STRIKETHROUGH_ATTRIBUTE = 128;

const rgbaCache = new Map<string, RGBA>();

type DiffMarker = "+" | "-" | " ";
type DiffTone = ToolResultDisplayLine["tone"];

type ShikiDiffViewMode = "split" | "unified";

type DiffDisplayRow = {
  content: string;
  id: string;
  marker: DiffMarker;
  newLine?: number;
  oldLine?: number;
  tone: DiffTone;
};

type SplitDiffRow = {
  id: string;
  left?: DiffDisplayRow;
  right?: DiffDisplayRow;
};

type HighlightState = {
  cacheKey: string;
  segmentsByRow: ShikiHighlightSegment[][];
};

export function ShikiDiffView(props: {
  filePath?: string;
  structuredPatch: ToolResultDisplayHunk[];
  terminalWidth: number;
  truncated?: boolean;
  view?: ShikiDiffViewMode;
}): React.ReactElement {
  const theme = activeTuiTheme();
  const rows = React.useMemo(() => buildDiffRows(props.structuredPatch), [props.structuredPatch]);
  const cacheKey = React.useMemo(() => diffRowsCacheKey(rows), [rows]);
  const [highlightState, setHighlightState] = React.useState<HighlightState | undefined>();
  const view = props.view ?? diffViewForWidth(props.terminalWidth);

  React.useEffect(() => {
    let disposed = false;
    setHighlightState(undefined);
    void highlightShikiCodeLines({
      filePath: props.filePath,
      lines: rows.map((row) => row.content),
      mode: theme.mode,
    }).then((segmentsByRow) => {
      if (disposed || !segmentsByRow) return;
      setHighlightState({ cacheKey, segmentsByRow });
    });
    return () => {
      disposed = true;
    };
  }, [cacheKey, props.filePath, rows, theme.mode]);

  const segmentsByRow =
    highlightState?.cacheKey === cacheKey ? highlightState.segmentsByRow : undefined;

  return h(
    "box",
    {
      style: {
        flexDirection: "column",
        paddingLeft: 2,
        width: "100%",
      },
    },
    ...(view === "split"
      ? splitRowsToNodes(buildSplitDiffRows(rows), rows, segmentsByRow, theme)
      : unifiedRowsToNodes(rows, segmentsByRow, theme)),
    ...(props.truncated ? [truncatedNode(theme)] : []),
  );
}

export function diffViewForWidth(terminalWidth: number): ShikiDiffViewMode {
  return terminalWidth > SPLIT_DIFF_WIDTH_BREAKPOINT ? "split" : "unified";
}

export function buildDiffRows(hunks: ToolResultDisplayHunk[]): DiffDisplayRow[] {
  const rows: DiffDisplayRow[] = [];

  hunks.forEach((hunk, hunkIndex) => {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;

    hunk.lines.forEach((rawLine, lineIndex) => {
      const marker = diffMarker(rawLine);
      rows.push({
        content: diffContent(rawLine, marker),
        id: `${hunkIndex}:${lineIndex}`,
        marker,
        newLine: marker === "-" ? undefined : newLine,
        oldLine: marker === "+" ? undefined : oldLine,
        tone: toneForMarker(marker),
      });

      if (marker !== "+") oldLine += 1;
      if (marker !== "-") newLine += 1;
    });
  });

  return rows;
}

export function buildSplitDiffRows(rows: DiffDisplayRow[]): SplitDiffRow[] {
  const splitRows: SplitDiffRow[] = [];
  let index = 0;

  while (index < rows.length) {
    const current = rows[index];
    if (!current) break;
    if (current.marker === " ") {
      splitRows.push({ id: current.id, left: current, right: current });
      index += 1;
      continue;
    }

    const deleted: DiffDisplayRow[] = [];
    const added: DiffDisplayRow[] = [];
    while (index < rows.length && rows[index]?.marker !== " ") {
      const changed = rows[index];
      if (changed?.marker === "-") deleted.push(changed);
      if (changed?.marker === "+") added.push(changed);
      index += 1;
    }

    const pairCount = Math.max(deleted.length, added.length);
    for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
      const left = deleted[pairIndex];
      const right = added[pairIndex];
      splitRows.push({
        id: `${left?.id ?? "empty"}:${right?.id ?? "empty"}`,
        left,
        right,
      });
    }
  }

  return splitRows;
}

function unifiedRowsToNodes(
  rows: DiffDisplayRow[],
  segmentsByRow: ShikiHighlightSegment[][] | undefined,
  theme: TuiThemeTokens,
): React.ReactElement[] {
  return rows.map((row, index) =>
    h("text", {
      content: rowToStyledText({
        row,
        segments: segmentsByRow?.[index],
        side: "unified",
        theme,
      }),
      key: `unified-${row.id}`,
      style: {
        bg: backgroundForTone(row.tone, theme),
        width: "100%",
      },
      wrapMode: "word",
    }),
  );
}

function splitRowsToNodes(
  rows: SplitDiffRow[],
  sourceRows: DiffDisplayRow[],
  segmentsByRow: ShikiHighlightSegment[][] | undefined,
  theme: TuiThemeTokens,
): React.ReactElement[] {
  const indexById = new Map<string, number>();
  for (const [index, row] of sourceRows.entries()) {
    indexById.set(row.id, index);
  }

  return rows.map((row) =>
    h(
      "box",
      {
        key: `split-${row.id}`,
        style: {
          flexDirection: "row",
          width: "100%",
        },
      },
      splitCellNode({
        key: `left-${row.id}`,
        row: row.left,
        segments: row.left ? segmentsByRow?.[indexById.get(row.left.id) ?? -1] : undefined,
        side: "left",
        theme,
      }),
      splitCellNode({
        key: `right-${row.id}`,
        row: row.right,
        segments: row.right ? segmentsByRow?.[indexById.get(row.right.id) ?? -1] : undefined,
        side: "right",
        theme,
      }),
    ),
  );
}

function splitCellNode(input: {
  key: string;
  row?: DiffDisplayRow;
  segments?: ShikiHighlightSegment[];
  side: "left" | "right";
  theme: TuiThemeTokens;
}): React.ReactElement {
  const tone = input.row?.tone ?? "context";
  return h("text", {
    content: rowToStyledText({
      row: input.row,
      segments: input.segments,
      side: input.side,
      theme: input.theme,
    }),
    key: input.key,
    style: {
      bg: backgroundForTone(tone, input.theme),
      width: "50%",
    },
    truncate: true,
    wrapMode: "none",
  });
}

function rowToStyledText(input: {
  row?: DiffDisplayRow;
  segments?: ShikiHighlightSegment[];
  side: "left" | "right" | "unified";
  theme: TuiThemeTokens;
}): StyledText {
  const tone = input.row?.tone ?? "context";
  const rowBackground = backgroundForTone(tone, input.theme);
  const gutterBackground = gutterBackgroundForTone(tone, input.theme);
  const fallbackText = input.row?.content ?? "";
  return new StyledText([
    styledChunk(gutterText(input.row, input.side), input.theme.diffLineNumber, gutterBackground),
    ...highlightChunks(input.segments, fallbackText, input.theme.text, rowBackground),
  ]);
}

function highlightChunks(
  segments: ShikiHighlightSegment[] | undefined,
  fallbackText: string,
  fallbackColor: string,
  background: string,
): TextChunk[] {
  if (!segments?.length) return [styledChunk(fallbackText, fallbackColor, background)];
  return segments.map((segment) =>
    styledChunk(
      segment.text,
      segment.color ?? fallbackColor,
      background,
      opentuiAttributesFromShiki(segment.fontStyle),
    ),
  );
}

function truncatedNode(theme: TuiThemeTokens): React.ReactElement {
  return h("text", {
    key: "diff-truncated",
    style: {
      fg: theme.diffLineNumber,
      width: "100%",
    },
  }, "    ... diff truncated");
}

function gutterText(row: DiffDisplayRow | undefined, side: "left" | "right" | "unified"): string {
  if (!row) return `${EMPTY_LINE_NUMBER.padStart(LINE_NUMBER_WIDTH)}   `;
  const lineNumber = side === "left" ? row.oldLine : side === "right" ? row.newLine : displayLine(row);
  const marker = side === "unified" ? row.marker : markerForSplitSide(row, side);
  return `${String(lineNumber ?? "").padStart(LINE_NUMBER_WIDTH)} ${marker}${GUTTER_TRAILING_SPACE}`;
}

function markerForSplitSide(row: DiffDisplayRow, side: "left" | "right"): string {
  if (row.marker === " ") return UNIFIED_EMPTY_MARKER;
  if (side === "left") return row.marker === "-" ? "-" : UNIFIED_EMPTY_MARKER;
  return row.marker === "+" ? "+" : UNIFIED_EMPTY_MARKER;
}

function displayLine(row: DiffDisplayRow): number | undefined {
  return row.marker === "+" ? row.newLine : row.oldLine;
}

function diffRowsCacheKey(rows: DiffDisplayRow[]): string {
  return rows.map((row) => `${row.id}\0${row.content}`).join("\n");
}

function diffMarker(rawLine: string): DiffMarker {
  if (rawLine.startsWith("+")) return "+";
  if (rawLine.startsWith("-")) return "-";
  return " ";
}

function diffContent(rawLine: string, marker: DiffMarker): string {
  if (marker === "+" || marker === "-") return rawLine.slice(1);
  return rawLine.startsWith(" ") ? rawLine.slice(1) : rawLine;
}

function toneForMarker(marker: DiffMarker): DiffTone {
  if (marker === "+") return "addition";
  if (marker === "-") return "deletion";
  return "context";
}

function backgroundForTone(tone: DiffTone, theme: TuiThemeTokens): string {
  if (tone === "addition") return theme.diffAddedBg;
  if (tone === "deletion") return theme.diffRemovedBg;
  return theme.diffContextBg;
}

function gutterBackgroundForTone(tone: DiffTone, theme: TuiThemeTokens): string {
  if (tone === "addition") return theme.diffAddedLineNumberBg;
  if (tone === "deletion") return theme.diffRemovedLineNumberBg;
  return theme.diffContextBg;
}

function styledChunk(text: string, fg: string, bg: string, attributes = 0): TextChunk {
  return {
    __isChunk: true,
    attributes,
    bg: rgba(bg),
    fg: rgba(fg),
    text,
  };
}

function rgba(color: string): RGBA {
  const cached = rgbaCache.get(color);
  if (cached) return cached;
  const parsed = RGBA.fromHex(color);
  rgbaCache.set(color, parsed);
  return parsed;
}

function opentuiAttributesFromShiki(fontStyle: number | undefined): number {
  if (!fontStyle) return 0;
  let attributes = 0;
  if ((fontStyle & SHIKI_FONT_STYLE_BOLD) !== 0) attributes |= OPENTUI_BOLD_ATTRIBUTE;
  if ((fontStyle & SHIKI_FONT_STYLE_ITALIC) !== 0) attributes |= OPENTUI_ITALIC_ATTRIBUTE;
  if ((fontStyle & SHIKI_FONT_STYLE_UNDERLINE) !== 0) attributes |= OPENTUI_UNDERLINE_ATTRIBUTE;
  if ((fontStyle & SHIKI_FONT_STYLE_STRIKETHROUGH) !== 0) {
    attributes |= OPENTUI_STRIKETHROUGH_ATTRIBUTE;
  }
  return attributes;
}

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;
