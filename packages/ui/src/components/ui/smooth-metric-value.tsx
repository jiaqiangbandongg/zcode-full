import { useEffect, useId, useRef, useState } from "react";
import { FlipMetricValue } from "@/components/ui/flip-metric-value.js";

const DEFAULT_LINES_PER_SECOND = 48;
const MIN_LINES_PER_SECOND = 24;
const MAX_LINES_PER_SECOND = 180;
const SPEED_EMA_ALPHA = 0.35;
const SAMPLE_MAX_GAP_MS = 2_000;
const INITIAL_SAMPLE_BUFFER_MS = 120;
const MAX_SMOOTH_ANIMATION_MS = 900;

interface SmoothMetricRuntimeState {
  bufferedOnce: boolean;
  displayValue: number;
  frameId: number | null;
  lastFrameAt: number;
  linesPerSecond: number;
  metricKey: string;
  targetUpdatedAt: number;
  targetValue: number;
}

export interface SmoothMetricDisplayInput {
  currentValue: number;
  elapsedMs: number;
  linesPerSecond: number;
  targetValue: number;
}

export function normalizeSmoothMetricTarget(value: number | string): number | null {
  const numericValue = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(numericValue)) {
    return null;
  }
  return Math.max(0, Math.round(numericValue));
}

export function estimateSmoothMetricLinesPerSecond(input: {
  elapsedMs: number;
  nextTargetValue: number;
  previousLinesPerSecond: number;
  previousTargetValue: number;
}): number {
  const delta = Math.abs(input.nextTargetValue - input.previousTargetValue);
  if (delta <= 0 || input.elapsedMs <= 0 || input.elapsedMs > SAMPLE_MAX_GAP_MS) {
    return input.previousLinesPerSecond;
  }

  const sampledLinesPerSecond = (delta / input.elapsedMs) * 1_000;
  const smoothed =
    input.previousLinesPerSecond * (1 - SPEED_EMA_ALPHA) +
    sampledLinesPerSecond * SPEED_EMA_ALPHA;
  return clampMetricSpeed(smoothed);
}

export function resolveNextSmoothMetricDisplay(input: SmoothMetricDisplayInput): number {
  const currentValue = Math.round(input.currentValue);
  const targetValue = Math.round(input.targetValue);
  if (currentValue === targetValue) {
    return targetValue;
  }

  const distance = Math.abs(targetValue - currentValue);
  const direction = targetValue > currentValue ? 1 : -1;
  const elapsedMs = Math.max(input.elapsedMs, 16);
  const linesPerSecond = clampMetricSpeed(input.linesPerSecond);
  const speedStep = Math.max(1, Math.floor((linesPerSecond * elapsedMs) / 1_000));
  const maxFrames = Math.max(1, Math.ceil(MAX_SMOOTH_ANIMATION_MS / elapsedMs));
  const settleStep = Math.max(1, Math.ceil(distance / maxFrames));
  const step = Math.min(distance, Math.max(speedStep, settleStep));
  return currentValue + direction * step;
}

function clampMetricSpeed(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_LINES_PER_SECOND;
  }
  return Math.min(MAX_LINES_PER_SECOND, Math.max(MIN_LINES_PER_SECOND, value));
}

function nowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function usePrefersReducedMotion() {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      setPrefersReducedMotion(query.matches);
    };
    update();

    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", update);
      return () => {
        query.removeEventListener("change", update);
      };
    }

    query.addListener(update);
    return () => {
      query.removeListener(update);
    };
  }, []);

  return prefersReducedMotion;
}

function cancelMetricFrame(state: SmoothMetricRuntimeState): void {
  if (state.frameId === null || typeof window === "undefined") {
    state.frameId = null;
    return;
  }
  window.cancelAnimationFrame(state.frameId);
  state.frameId = null;
}

export function SmoothMetricValue({
  active = false,
  className,
  metricKey,
  value,
}: {
  active?: boolean;
  className?: string;
  metricKey?: string;
  value: number | string;
}) {
  const generatedMetricKey = useId();
  const resolvedMetricKey = metricKey ?? generatedMetricKey;
  const targetValue = normalizeSmoothMetricTarget(value);
  const prefersReducedMotion = usePrefersReducedMotion();
  const [displayValue, setDisplayValue] = useState(() => targetValue ?? value);
  const stateRef = useRef<SmoothMetricRuntimeState>({
    bufferedOnce: false,
    displayValue: targetValue ?? 0,
    frameId: null,
    lastFrameAt: nowMs(),
    linesPerSecond: DEFAULT_LINES_PER_SECOND,
    metricKey: resolvedMetricKey,
    targetUpdatedAt: nowMs(),
    targetValue: targetValue ?? 0,
  });

  useEffect(() => {
    if (targetValue === null) {
      setDisplayValue(value);
      return;
    }

    const state = stateRef.current;
    const currentTime = nowMs();
    if (state.metricKey !== resolvedMetricKey) {
      cancelMetricFrame(state);
      state.bufferedOnce = false;
      state.displayValue = targetValue;
      state.lastFrameAt = currentTime;
      state.linesPerSecond = DEFAULT_LINES_PER_SECOND;
      state.metricKey = resolvedMetricKey;
      state.targetUpdatedAt = currentTime;
      state.targetValue = targetValue;
      setDisplayValue(targetValue);
    }

    const shouldAnimate =
      active &&
      !prefersReducedMotion &&
      typeof window !== "undefined" &&
      typeof window.requestAnimationFrame === "function";

    if (!shouldAnimate) {
      cancelMetricFrame(state);
      state.displayValue = targetValue;
      state.targetValue = targetValue;
      state.targetUpdatedAt = currentTime;
      state.lastFrameAt = currentTime;
      setDisplayValue(targetValue);
      return;
    }

    if (state.targetValue !== targetValue) {
      state.linesPerSecond = estimateSmoothMetricLinesPerSecond({
        elapsedMs: currentTime - state.targetUpdatedAt,
        nextTargetValue: targetValue,
        previousLinesPerSecond: state.linesPerSecond,
        previousTargetValue: state.targetValue,
      });
      state.targetValue = targetValue;
      state.targetUpdatedAt = currentTime;
      if (!state.bufferedOnce) {
        state.bufferedOnce = true;
        state.lastFrameAt = currentTime + INITIAL_SAMPLE_BUFFER_MS;
      }
    }

    const tick = (timestamp: number) => {
      const elapsedMs = timestamp - state.lastFrameAt;
      if (elapsedMs < 0) {
        state.frameId = window.requestAnimationFrame(tick);
        return;
      }

      const nextDisplayValue = resolveNextSmoothMetricDisplay({
        currentValue: state.displayValue,
        elapsedMs,
        linesPerSecond: state.linesPerSecond,
        targetValue: state.targetValue,
      });
      state.displayValue = nextDisplayValue;
      state.lastFrameAt = timestamp;
      setDisplayValue(nextDisplayValue);

      if (nextDisplayValue !== state.targetValue) {
        state.frameId = window.requestAnimationFrame(tick);
      } else {
        state.frameId = null;
      }
    };

    if (state.displayValue !== state.targetValue && state.frameId === null) {
      // 修复原因：模型流式参数会把行数按不规则批次推到 UI。
      // 这里在展示层逐帧追赶真实目标，让 FlipMetricValue 看到连续数字而不是大跳变。
      state.frameId = window.requestAnimationFrame(tick);
    }

    return () => {
      if (stateRef.current.frameId !== null && resolvedMetricKey) {
        cancelMetricFrame(stateRef.current);
      }
    };
  }, [active, prefersReducedMotion, resolvedMetricKey, targetValue, value]);

  return <FlipMetricValue className={className} value={String(displayValue)} />;
}
