export interface NumericStats {
  mean: number;
  peak: number;
  p95: number;
  sampleCount: number;
}

export const BYTES_PER_KB = 1024;
export const BYTES_PER_MB = 1024 * 1024;

export function numericStats(values: number[]): NumericStats {
  const finiteValues = values.filter((value) => Number.isFinite(value));
  if (finiteValues.length === 0) {
    return { mean: 0, peak: 0, p95: 0, sampleCount: 0 };
  }

  const sorted = [...finiteValues].sort((left, right) => left - right);
  const p95Index = Math.min(
    sorted.length - 1,
    Math.ceil(sorted.length * 0.95) - 1,
  );
  const total = finiteValues.reduce((sum, value) => sum + value, 0);
  return {
    mean: round(total / finiteValues.length),
    peak: round(sorted.at(-1) ?? 0),
    p95: round(sorted[Math.max(0, p95Index)] ?? 0),
    sampleCount: finiteValues.length,
  };
}

export function parsePercent(raw: string | undefined) {
  if (!raw) {
    return 0;
  }
  const value = Number(raw.replace("%", "").trim());
  return Number.isFinite(value) ? value : 0;
}

export function parseBytePair(raw: string | undefined) {
  const [left, right] = (raw ?? "").split("/").map((part) => part.trim());
  return {
    left: parseByteValue(left),
    right: parseByteValue(right),
  };
}

function round(value: number, digits = 2) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function parseByteValue(raw: string | undefined) {
  if (!raw) {
    return 0;
  }

  const match = /^([\d.]+)\s*([KMGT]?i?B|B)$/iu.exec(raw.trim());
  if (!match) {
    return 0;
  }

  const value = Number(match[1]);
  if (!Number.isFinite(value)) {
    return 0;
  }

  const unit = (match[2] ?? "B").toLowerCase();
  const multipliers: Record<string, number> = {
    b: 1,
    gb: 1000 ** 3,
    gib: 1024 ** 3,
    kb: 1000,
    kib: 1024,
    mb: 1000 ** 2,
    mib: 1024 ** 2,
    tb: 1000 ** 4,
    tib: 1024 ** 4,
  };
  return value * (multipliers[unit] ?? 1);
}
