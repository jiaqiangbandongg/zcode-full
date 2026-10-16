import React from "react";
import { clampIndex } from "./app-input.js";
import { palette } from "./app-model.js";
import { displayWidth, truncateDisplay } from "./app-terminal-width.js";
import type { TuiModeOption } from "./types.js";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

const MODE_OPTION_VISIBLE_COUNT = 3;
const MODE_OPTION_PANEL_CHROME_ROWS = 2;
const MODE_OPTION_ROW_HEIGHT = 1;
const MODE_ROW_SELECTOR_WIDTH = 2;
const MODE_ROW_DETAIL_GAP_WIDTH = 2;
const MODE_ROW_MIN_CONTENT_WIDTH = 12;
const MODE_ROW_MIN_LABEL_WIDTH = 6;
const MODE_ROW_FALLBACK_CONTENT_WIDTH = 80;
const MODE_ROW_MAX_DETAIL_RATIO = 0.65;

type FittedModeOptionRow = {
  detail: string;
  detailWidth: number;
  label: string;
};

export function ModeSuggestionPanel({
  contentWidth,
  currentMode,
  modes,
  selectedIndex,
}: {
  contentWidth?: number;
  currentMode: string;
  modes: readonly TuiModeOption[];
  selectedIndex: number;
}): React.ReactElement | null {
  const visible = visibleModeOptionWindow(modes, selectedIndex, MODE_OPTION_VISIBLE_COUNT);
  const rowContentWidth = normalizeModeRowContentWidth(contentWidth);
  const rows =
    visible.modes.length > 0
      ? visible.modes.map((mode, index) => ({
          fitted: fitModeOptionRow(
            {
              detail: modeDetail(mode, mode.id === currentMode),
              label: mode.label,
            },
            rowContentWidth,
          ),
          mode,
          selected: index === visible.selectedIndex,
        }))
      : [];
  const panelHeight =
    MODE_OPTION_PANEL_CHROME_ROWS + Math.max(1, rows.length) * MODE_OPTION_ROW_HEIGHT;

  return h(
    "box",
    {
      title: "Modes",
      style: {
        backgroundColor: palette.panel,
        border: true,
        borderColor: palette.border,
        flexDirection: "column",
        height: panelHeight,
        marginBottom: 1,
        paddingLeft: 1,
        paddingRight: 1,
        width: "100%",
      },
    },
    rows.length > 0
      ? rows.map((row) =>
          h(ModeSuggestionRow, {
            key: row.mode.id,
            fitted: row.fitted,
            selected: row.selected,
          }),
        )
      : h(
          "text",
          {
            style: {
              fg: palette.warning,
              height: MODE_OPTION_ROW_HEIGHT,
              width: "100%",
            },
          },
          "No matching modes.",
        ),
  );
}

export function visibleModeOptionWindow(
  modes: readonly TuiModeOption[],
  selectedIndex: number,
  maxVisible: number,
): {
  modes: readonly TuiModeOption[];
  selectedIndex: number;
  startIndex: number;
} {
  if (modes.length === 0 || maxVisible <= 0) {
    return {
      modes: [],
      selectedIndex: 0,
      startIndex: 0,
    };
  }

  const clampedSelectedIndex = clampIndex(selectedIndex, modes.length);
  const visibleCount = Math.min(maxVisible, modes.length);
  const maxStartIndex = modes.length - visibleCount;
  const startIndex = Math.min(Math.max(0, clampedSelectedIndex - visibleCount + 1), maxStartIndex);

  return {
    modes: modes.slice(startIndex, startIndex + visibleCount),
    selectedIndex: clampedSelectedIndex - startIndex,
    startIndex,
  };
}

function ModeSuggestionRow({
  fitted,
  selected,
}: {
  fitted: FittedModeOptionRow;
  selected: boolean;
}): React.ReactElement {
  return h(
    "box",
    {
      style: {
        alignItems: "center",
        flexDirection: "row",
        height: MODE_OPTION_ROW_HEIGHT,
        width: "100%",
      },
    },
    h(
      "text",
      {
        style: {
          fg: selected ? palette.accent : palette.muted,
          flexShrink: 0,
          width: MODE_ROW_SELECTOR_WIDTH,
        },
      },
      selected ? "> " : "  ",
    ),
    h(
      "text",
      {
        style: {
          fg: selected ? palette.accent : palette.text,
          flexShrink: 0,
          width: displayWidth(fitted.label),
        },
      },
      fitted.label,
    ),
    fitted.detail
      ? h("box", {
          style: {
            flexGrow: 1,
            minWidth: MODE_ROW_DETAIL_GAP_WIDTH,
          },
        })
      : null,
    fitted.detail
      ? h(
          "text",
          {
            style: {
              fg: palette.muted,
              flexShrink: 0,
              width: fitted.detailWidth,
            },
          },
          fitted.detail,
        )
      : null,
  );
}

function modeDetail(mode: TuiModeOption, current: boolean): string {
  return current ? `${mode.description}  current` : mode.description;
}

function fitModeOptionRow(
  parts: { detail: string; label: string },
  contentWidth: number,
): FittedModeOptionRow {
  const detailBudget = detailColumnBudget(parts.detail, contentWidth);
  const detail = truncateDisplay(parts.detail, detailBudget);
  const detailWidth = displayWidth(detail);
  const detailGapWidth = detail ? MODE_ROW_DETAIL_GAP_WIDTH : 0;
  const labelBudget = Math.max(
    1,
    contentWidth - MODE_ROW_SELECTOR_WIDTH - detailGapWidth - detailWidth,
  );

  return {
    detail,
    detailWidth,
    label: truncateDisplay(parts.label, labelBudget),
  };
}

function detailColumnBudget(detail: string, contentWidth: number): number {
  if (!detail) return 0;
  const detailMax = Math.floor(contentWidth * MODE_ROW_MAX_DETAIL_RATIO);
  const detailBudget =
    contentWidth - MODE_ROW_SELECTOR_WIDTH - MODE_ROW_DETAIL_GAP_WIDTH - MODE_ROW_MIN_LABEL_WIDTH;
  return Math.max(0, Math.min(detailMax, detailBudget));
}

function normalizeModeRowContentWidth(contentWidth: number | undefined): number {
  if (contentWidth === undefined || !Number.isFinite(contentWidth)) {
    return MODE_ROW_FALLBACK_CONTENT_WIDTH;
  }
  return Math.max(MODE_ROW_MIN_CONTENT_WIDTH, Math.floor(contentWidth));
}
