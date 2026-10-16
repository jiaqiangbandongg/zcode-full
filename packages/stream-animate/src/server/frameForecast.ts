import type { FrameBucket, FrameForecast, FrameTrendPoint } from "../shared/types.js";

const WINDOW_MS = 200;
const FORECAST_MIN_SECONDS = 1;
const FORECAST_MAX_SECONDS = 3;
const FORECAST_RATIO = 0.2;
const EMA_ALPHA = 0.32;
const TREND_DAMPING = 0.78;

export function buildFrameForecast(
  fps: 60 | 120,
  buckets: FrameBucket[],
  totalFrames: number,
): FrameForecast {
  const windowFrames = Math.max(3, Math.round((fps * WINDOW_MS) / 1000));
  const rollingSpeeds = buildRollingSpeeds(buckets, windowFrames);
  const peakLimit = resolvePeakLimit(rollingSpeeds);
  const smoothedValues = smoothValues(rollingSpeeds, peakLimit);
  const observed = smoothedValues.map((chars, index) => ({
    chars: roundChars(chars),
    frameIndex: index,
  }));
  const horizonFrames = resolveHorizonFrames(fps, totalFrames);
  const predicted = buildPredictedPoints(observed, horizonFrames);

  return {
    horizonFrames,
    observed,
    peakLimit: roundChars(peakLimit),
    predicted,
    windowFrames,
  };
}

function buildRollingSpeeds(buckets: FrameBucket[], windowFrames: number) {
  const speeds: number[] = [];
  let rollingChars = 0;
  for (let index = 0; index < buckets.length; index += 1) {
    rollingChars += buckets[index]?.chars ?? 0;
    const staleIndex = index - windowFrames;
    if (staleIndex >= 0) {
      rollingChars -= buckets[staleIndex]?.chars ?? 0;
    }
    const currentWindow = Math.min(index + 1, windowFrames);
    speeds.push(rollingChars / currentWindow);
  }
  return speeds;
}

function smoothValues(values: number[], peakLimit: number) {
  const smoothed: number[] = [];
  let level = 0;
  for (const value of values) {
    const clippedValue = Math.min(value, peakLimit);
    level = smoothed.length === 0 ? clippedValue : level + EMA_ALPHA * (clippedValue - level);
    smoothed.push(level);
  }
  return smoothed;
}

function buildPredictedPoints(observed: FrameTrendPoint[], horizonFrames: number) {
  if (observed.length === 0) {
    return [];
  }

  const recent = observed.slice(-Math.max(8, Math.min(90, Math.floor(observed.length * 0.35))));
  const recentValues = recent.map((point) => point.chars);
  const level = recentValues.at(-1) ?? 0;
  const recentAverage = average(recentValues);
  const trend = clamp(estimateSlope(recentValues), -level * 0.04, Math.max(0.04, level * 0.04));
  const predicted: FrameTrendPoint[] = [];
  let trendMultiplier = 1;

  for (let offset = 1; offset <= horizonFrames; offset += 1) {
    trendMultiplier *= TREND_DAMPING;
    const trendValue = level + trend * offset * trendMultiplier;
    const blendedValue = trendValue * 0.68 + recentAverage * 0.32;
    predicted.push({
      chars: roundChars(Math.max(0, blendedValue)),
      frameIndex: observed.length - 1 + offset,
    });
  }

  return predicted;
}

function resolvePeakLimit(values: number[]) {
  const positiveValues = values.filter((value) => value > 0).sort((a, b) => a - b);
  if (positiveValues.length === 0) {
    return 1;
  }
  const p85 = positiveValues[Math.floor((positiveValues.length - 1) * 0.85)] ?? 1;
  const median = positiveValues[Math.floor((positiveValues.length - 1) * 0.5)] ?? p85;
  return Math.max(1, p85 * 1.35, median * 1.8);
}

function resolveHorizonFrames(fps: 60 | 120, totalFrames: number) {
  const minFrames = fps * FORECAST_MIN_SECONDS;
  const maxFrames = fps * FORECAST_MAX_SECONDS;
  return Math.round(clamp(totalFrames * FORECAST_RATIO, minFrames, maxFrames));
}

function estimateSlope(values: number[]) {
  if (values.length < 2) {
    return 0;
  }

  const xMean = (values.length - 1) / 2;
  const yMean = average(values);
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < values.length; index += 1) {
    const x = index - xMean;
    numerator += x * ((values[index] ?? yMean) - yMean);
    denominator += x * x;
  }
  return denominator > 0 ? numerator / denominator : 0;
}

function average(values: number[]) {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function roundChars(value: number) {
  return Math.round(value * 100) / 100;
}
