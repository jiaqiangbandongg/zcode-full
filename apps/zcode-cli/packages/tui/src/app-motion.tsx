import React, { useEffect, useMemo, useState } from "react";
import { palette } from "./app-model.js";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

const SHIMMER_FRAME_INTERVAL_MS = 80;
export const SHIMMER_SWEEP_PERIOD_MS = 1_800;
export const SPINNER_FRAME_INTERVAL_MS = 80;
export const SPINNER_WIDTH = 1;
const SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;
const SHIMMER_PADDING_COLUMNS = 10;
const SHIMMER_BAND_HALF_WIDTH = 5;
const SHIMMER_HIGHLIGHT_STRENGTH = 0.9;
const SHIMMER_HIGHLIGHT_THRESHOLD = 0.35;
const HEX_COLOR_PATTERN = /^#([0-9a-f]{6})$/i;
const HEX_RADIX = 16;
const RGB_MAX = 255;

type ShimmerTextSegment = {
  color: string;
  highlighted: boolean;
  text: string;
};

type RgbColor = {
  b: number;
  g: number;
  r: number;
};

export function ShimmerText({
  animated,
  baseColor = palette.accent,
  frameMs,
  highlightColor = palette.text,
  text,
}: {
  animated: boolean;
  baseColor?: string;
  frameMs?: number;
  highlightColor?: string;
  text: string;
}): React.ReactElement {
  const localFrameMs = useShimmerFrame(animated && frameMs === undefined);
  const effectiveFrameMs = frameMs ?? localFrameMs;
  const segments = useMemo(
    () =>
      animated
        ? shimmerTextSegments(text, effectiveFrameMs, { baseColor, highlightColor })
        : [{ color: baseColor, highlighted: false, text }],
    [animated, baseColor, effectiveFrameMs, highlightColor, text],
  );

  if (!animated) {
    return h("text", { style: { fg: baseColor } }, text);
  }

  return h(
    "box",
    {
      style: {
        flexDirection: "row",
      },
    },
    ...segments.map((segment, index) =>
      h(
        "text",
        {
          key: `shimmer-${index}`,
          style: { fg: segment.color },
        },
        segment.text,
      ),
    ),
  );
}

export function shimmerTextSegments(
  text: string,
  frameMs: number,
  options: {
    baseColor?: string;
    highlightColor?: string;
  } = {},
): ShimmerTextSegment[] {
  const chars = Array.from(text);
  if (chars.length === 0) return [];

  const baseColor = options.baseColor ?? palette.accent;
  const highlightColor = options.highlightColor ?? palette.text;
  const period = chars.length + SHIMMER_PADDING_COLUMNS * 2;
  const sweepPosition = Math.floor(
    (positiveModulo(frameMs, SHIMMER_SWEEP_PERIOD_MS) / SHIMMER_SWEEP_PERIOD_MS) * period,
  );

  return chars.map((char, index) => {
    const position = index + SHIMMER_PADDING_COLUMNS;
    const distance = Math.abs(position - sweepPosition);
    const intensity = shimmerIntensity(distance);
    return {
      color: colorForIntensity(baseColor, highlightColor, intensity),
      highlighted: intensity >= SHIMMER_HIGHLIGHT_THRESHOLD,
      text: char,
    };
  });
}

export function useShimmerFrame(animated: boolean): number {
  const [frameMs, setFrameMs] = useState(() => Date.now());

  useEffect(() => {
    if (!animated) return undefined;
    const timer = setInterval(() => {
      setFrameMs(Date.now());
    }, SHIMMER_FRAME_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [animated]);

  return frameMs;
}

export function useSpinnerFrame(animated: boolean): string {
  const [frameMs, setFrameMs] = useState(() => Date.now());

  useEffect(() => {
    if (!animated) return undefined;
    const timer = setInterval(() => {
      setFrameMs(Date.now());
    }, SPINNER_FRAME_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [animated]);

  return spinnerFrame(frameMs);
}

export function spinnerFrame(frameMs: number): string {
  const periodMs = SPINNER_FRAME_INTERVAL_MS * SPINNER_FRAMES.length;
  const frameIndex = Math.floor(positiveModulo(frameMs, periodMs) / SPINNER_FRAME_INTERVAL_MS);
  return SPINNER_FRAMES[frameIndex] ?? SPINNER_FRAMES[0];
}

function shimmerIntensity(distance: number): number {
  if (distance > SHIMMER_BAND_HALF_WIDTH) return 0;
  const x = Math.PI * (distance / SHIMMER_BAND_HALF_WIDTH);
  return 0.5 * (1 + Math.cos(x));
}

function colorForIntensity(baseColor: string, highlightColor: string, intensity: number): string {
  if (intensity <= 0) return baseColor;
  return blendHexColor(baseColor, highlightColor, intensity * SHIMMER_HIGHLIGHT_STRENGTH);
}

function blendHexColor(baseColor: string, highlightColor: string, amount: number): string {
  const base = parseHexColor(baseColor);
  const highlight = parseHexColor(highlightColor);
  if (!base || !highlight) {
    return amount >= SHIMMER_HIGHLIGHT_THRESHOLD ? highlightColor : baseColor;
  }
  return rgbToHex({
    r: blendChannel(base.r, highlight.r, amount),
    g: blendChannel(base.g, highlight.g, amount),
    b: blendChannel(base.b, highlight.b, amount),
  });
}

function parseHexColor(value: string): RgbColor | undefined {
  const match = HEX_COLOR_PATTERN.exec(value);
  if (!match) return undefined;
  const hex = match[1] ?? "";
  return {
    r: Number.parseInt(hex.slice(0, 2), HEX_RADIX),
    g: Number.parseInt(hex.slice(2, 4), HEX_RADIX),
    b: Number.parseInt(hex.slice(4, 6), HEX_RADIX),
  };
}

function rgbToHex(color: RgbColor): string {
  return `#${hexChannel(color.r)}${hexChannel(color.g)}${hexChannel(color.b)}`;
}

function hexChannel(value: number): string {
  return Math.round(clamp(value, 0, RGB_MAX)).toString(HEX_RADIX).padStart(2, "0");
}

function blendChannel(base: number, highlight: number, amount: number): number {
  const clampedAmount = clamp(amount, 0, 1);
  return base + (highlight - base) * clampedAmount;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function positiveModulo(value: number, modulo: number): number {
  return ((value % modulo) + modulo) % modulo;
}
