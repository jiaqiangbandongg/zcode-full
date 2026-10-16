import type { TuiCopy } from "@zcode/i18n";
import React from "react";
import type { ContextUsage } from "./app-model.js";
import { DEFAULT_TUI_COPY } from "./app-locale.js";
import { palette } from "./app-model.js";
import { modelDisplayParts } from "./app-model-ref.js";
import { spinnerFrame, useSpinnerFrame } from "./app-motion.js";
import { displayWidth, truncateDisplay } from "./app-terminal-width.js";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

const ACTIVE_STATUS_HEIGHT = 1;
const ACTIVE_STATUS_HORIZONTAL_PADDING_WIDTH = 1;
const ACTIVE_STATUS_CONTEXT_SPACER_WIDTH = 1;
const COMPOSER_STATUS_HEIGHT = 1;
const COMPOSER_STATUS_HORIZONTAL_PADDING_WIDTH = 0;
const COMPOSER_STATUS_MIN_METADATA_WIDTH = 8;
const STATUS_MIN_CONTEXT_WIDTH = 4;
const COMPOSER_STATUS_FALLBACK_WIDTH = 80;
const COMPOSER_STATUS_MIN_CONTENT_WIDTH = 8;
const TOKEN_COUNT_KILO = 1_000;
const TOKEN_COUNT_MEGA = TOKEN_COUNT_KILO * TOKEN_COUNT_KILO;
const TOKEN_COUNT_DECIMAL_PLACES = 1;

type InputComposerStatusParts = {
  model: string;
  provider: string;
  thought: string;
};

export function InputActiveStatus({
  active,
  contentWidth,
  contextUsage,
  copy = DEFAULT_TUI_COPY,
  frameMs,
}: {
  active: boolean;
  contentWidth?: number;
  contextUsage?: ContextUsage;
  copy?: TuiCopy;
  frameMs?: number;
}): React.ReactElement {
  if (frameMs !== undefined || !active) {
    return inputActiveStatusRow(copy, active ? spinnerFrame(frameMs ?? 0) : undefined, {
      contentWidth,
      contextUsage,
    });
  }
  return h(InputActiveStatusContent, { contentWidth, contextUsage, copy });
}

function InputActiveStatusContent({
  contentWidth,
  contextUsage,
  copy,
}: {
  contentWidth?: number;
  contextUsage?: ContextUsage;
  copy: TuiCopy;
}): React.ReactElement {
  return inputActiveStatusRow(copy, useSpinnerFrame(true), { contentWidth, contextUsage });
}

export function InputComposerStatus({
  contentWidth,
  model,
  thoughtLevel,
}: {
  contentWidth?: number;
  model: string;
  thoughtLevel: string;
}): React.ReactElement {
  return inputComposerStatusRow({
    contentWidth,
    model,
    thoughtLevel,
  });
}

export function inputActiveStatusRow(
  copy: TuiCopy,
  frame?: string,
  options: { contentWidth?: number; contextUsage?: ContextUsage } = {},
): React.ReactElement {
  const contextBadge = fitStatusContextBadge(
    inputContextUsageBadge(options.contextUsage),
    activeStatusContextBadgeWidth({
      contentWidth: options.contentWidth,
      copy,
      frame,
    }),
  );
  return h(
    "box",
    {
      style: {
        flexDirection: "row",
        height: ACTIVE_STATUS_HEIGHT,
        paddingLeft: 1,
        width: "100%",
      },
    },
    frame
      ? h(
          "box",
          { style: { flexDirection: "row", flexShrink: 0 } },
          h(
            "text",
            { style: { fg: palette.accent, flexShrink: 0, width: displayWidth(frame) } },
            frame,
          ),
          h("text", { style: { fg: palette.muted } }, " "),
          h("text", { style: { fg: palette.muted } }, copy.input.activeStatusHint),
        )
      : null,
    contextBadge ? h("box", { style: { flexGrow: 1, minWidth: 1 } }) : null,
    contextBadge ? h("text", { style: { fg: palette.muted, flexShrink: 0 } }, contextBadge) : null,
  );
}

export function inputComposerStatusRow({
  contentWidth,
  model,
  thoughtLevel,
}: {
  contentWidth?: number;
  model: string;
  thoughtLevel: string;
}): React.ReactElement {
  const parts = inputComposerStatusParts(
    model,
    thoughtLevel,
    composerStatusMetadataWidth(contentWidth),
  );
  return h(
    "box",
    {
      style: {
        alignItems: "center",
        flexDirection: "row",
        flexShrink: 0,
        height: COMPOSER_STATUS_HEIGHT,
        width: "100%",
      },
    },
    h(
      "box",
      { style: { flexDirection: "row", flexShrink: 1, minWidth: 1 } },
      h("text", { style: { fg: palette.text, flexShrink: 1 } }, parts.model),
      h("text", { style: { fg: palette.muted } }, ` ${parts.provider} | `),
      h("text", { style: { fg: palette.warning, flexShrink: 0 } }, parts.thought),
    ),
  );
}

export function inputComposerStatusParts(
  modelSelection: string,
  thoughtLevel: string,
  maxWidth?: number,
): InputComposerStatusParts {
  const modelParts = modelDisplayParts(modelSelection);
  const thought = thoughtLevel.trim();
  return fitComposerStatusParts(
    {
      ...modelParts,
      thought: thought || "-",
    },
    maxWidth,
  );
}

export function inputContextUsageBadge(contextUsage?: ContextUsage): string | undefined {
  const used = contextUsage?.contextUsed;
  if (!validContextTokenCount(used)) return undefined;

  const usedLabel = formatCompactTokenCount(used);
  const window = contextUsage?.contextWindow;
  if (!validContextWindow(window)) return usedLabel;

  return `${usedLabel} (${formatComposerPercent(used / window)})`;
}

function composerStatusMetadataWidth(contentWidth?: number): number {
  const rowWidth = normalizeComposerStatusContentWidth(contentWidth);
  return Math.max(
    COMPOSER_STATUS_MIN_METADATA_WIDTH,
    rowWidth - COMPOSER_STATUS_HORIZONTAL_PADDING_WIDTH,
  );
}

function activeStatusContextBadgeWidth({
  contentWidth,
  copy,
  frame,
}: {
  contentWidth?: number;
  copy: TuiCopy;
  frame?: string;
}): number | undefined {
  const rowWidth = normalizeComposerStatusContentWidth(contentWidth);
  const activeHintWidth = frame
    ? displayWidth(frame) + 1 + displayWidth(copy.input.activeStatusHint)
    : 0;
  const activeSpacerWidth = activeHintWidth > 0 ? ACTIVE_STATUS_CONTEXT_SPACER_WIDTH : 0;
  const availableWidth =
    rowWidth - ACTIVE_STATUS_HORIZONTAL_PADDING_WIDTH - activeHintWidth - activeSpacerWidth;
  if (availableWidth < STATUS_MIN_CONTEXT_WIDTH) return undefined;
  return Math.floor(availableWidth);
}

function fitStatusContextBadge(
  contextBadge: string | undefined,
  maxWidth?: number,
): string | undefined {
  if (contextBadge === undefined) return undefined;
  if (maxWidth === undefined || !Number.isFinite(maxWidth)) return contextBadge;
  if (maxWidth < STATUS_MIN_CONTEXT_WIDTH) return undefined;
  return truncateDisplay(contextBadge, Math.floor(maxWidth));
}

function fitComposerStatusParts(
  parts: InputComposerStatusParts,
  maxWidth?: number,
): InputComposerStatusParts {
  if (maxWidth === undefined || !Number.isFinite(maxWidth)) return parts;
  const width = Math.max(1, Math.floor(maxWidth));
  const separatorWidth = displayWidth(" | ");
  const modelProviderGapWidth = 1;
  const thoughtWidth = displayWidth(parts.thought);
  const modelProviderWidth =
    displayWidth(parts.model) + modelProviderGapWidth + displayWidth(parts.provider);

  if (modelProviderWidth + separatorWidth + thoughtWidth <= width) return parts;

  const modelProviderBudget = width - separatorWidth - thoughtWidth;
  if (modelProviderBudget <= 0) {
    return {
      model: "",
      provider: "",
      thought: truncateDisplay(parts.thought, width),
    };
  }

  if (modelProviderBudget <= modelProviderGapWidth) {
    return {
      ...parts,
      model: truncateDisplay(parts.model, modelProviderBudget),
      provider: "",
    };
  }

  const providerBudget = Math.min(
    displayWidth(parts.provider),
    Math.max(1, Math.floor(modelProviderBudget * 0.4)),
  );
  const modelBudget = Math.max(1, modelProviderBudget - providerBudget - modelProviderGapWidth);

  return {
    ...parts,
    model: truncateDisplay(parts.model, modelBudget),
    provider: truncateDisplay(parts.provider, providerBudget),
  };
}

function normalizeComposerStatusContentWidth(contentWidth?: number): number {
  if (contentWidth === undefined || !Number.isFinite(contentWidth)) {
    return COMPOSER_STATUS_FALLBACK_WIDTH;
  }
  return Math.max(COMPOSER_STATUS_MIN_CONTENT_WIDTH, Math.floor(contentWidth));
}

function formatCompactTokenCount(value: number): string {
  if (value < TOKEN_COUNT_KILO) return String(Math.round(value));
  if (value < TOKEN_COUNT_MEGA) return `${formatCompactDecimal(value / TOKEN_COUNT_KILO)}K`;
  return `${formatCompactDecimal(value / TOKEN_COUNT_MEGA)}M`;
}

function formatCompactDecimal(value: number): string {
  return value.toFixed(TOKEN_COUNT_DECIMAL_PLACES).replace(/\.0$/u, "");
}

function formatComposerPercent(value: number): string {
  if (!Number.isFinite(value)) return "-";
  return `${Math.round(value * 100)}%`;
}

function validContextTokenCount(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0;
}

function validContextWindow(value: number | undefined): value is number {
  return validContextTokenCount(value) && value > 0;
}
