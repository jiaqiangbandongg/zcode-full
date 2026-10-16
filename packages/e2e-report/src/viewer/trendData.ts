import type { E2EReportSummary } from "../shared/types.js";

const BYTES_PER_MB = 1024 * 1024;
const KILOBYTES_PER_MB = 1024;

export interface TrendPoint {
  capturedAt: string;
  elapsedSeconds: number;
  label: string;
  value: number;
}

export interface TrendSeries {
  color: string;
  label: string;
  points: TrendPoint[];
  unit: string;
}

export interface PerformanceTrends {
  containerCpu: TrendSeries[];
  containerMemory: TrendSeries[];
  processCpu: TrendSeries[];
  processMemory: TrendSeries[];
}

interface ProcessSampleLine {
  capturedAt?: string;
  metrics?: Array<{
    cpuPercent?: number;
    memoryWorkingSetKb?: number;
    type?: string;
  }>;
}

interface ContainerSampleLine {
  capturedAt?: string;
  stats?: {
    BlockIO?: string;
    CPUPerc?: string;
    MemUsage?: string;
    NetIO?: string;
  };
}

interface ProcessTrendRow {
  capturedAt: string;
  cpuByType: Map<string, number>;
  elapsedSeconds: number;
  label: string;
  memoryByType: Map<string, number>;
  totalCpu: number;
  totalMemoryMb: number;
}

const PROCESS_COLORS = [
  "var(--chart-blue)",
  "var(--chart-amber)",
  "var(--chart-green)",
  "var(--chart-purple)",
  "var(--chart-red)",
  "var(--chart-cyan)",
];

export async function loadPerformanceTrends(
  summary: E2EReportSummary,
  summaryUrl: string,
): Promise<PerformanceTrends> {
  const [processLines, containerLines] = await Promise.all([
    loadProcessSamples(summary, summaryUrl),
    loadContainerSamples(summary, summaryUrl),
  ]);

  const runStartTime = resolveRunStartTime(summary, processLines, containerLines);
  const processRows = toProcessTrendRows(processLines, runStartTime);
  const containerRows = toContainerTrendRows(containerLines, runStartTime);
  return {
    containerCpu: [
      toSeries(
        "Container",
        "%",
        "var(--chart-cyan)",
        containerRows,
        (row) => row.cpuPercent,
      ),
    ],
    containerMemory: [
      toSeries(
        "Container Memory",
        "MB",
        "var(--chart-green)",
        containerRows,
        (row) => row.memoryUsageMb,
      ),
    ],
    processCpu: buildProcessSeries(processRows, "cpu"),
    processMemory: buildProcessSeries(processRows, "memory"),
  };
}

async function loadProcessSamples(summary: E2EReportSummary, summaryUrl: string) {
  const files = summary.performance.processSamples?.files ?? [];
  const texts = await Promise.all(
    files.map((file) =>
      fetchTextFromCandidates(
        buildArtifactCandidates(summaryUrl, file, `./perf/${basename(file)}`),
      ),
    ),
  );
  return texts.flatMap((text) => parseNdjson<ProcessSampleLine>(text ?? ""));
}

async function loadContainerSamples(summary: E2EReportSummary, summaryUrl: string) {
  const file = summary.files.containerSamples;
  const text = await fetchTextFromCandidates(
    buildArtifactCandidates(summaryUrl, file, `./perf/${basename(file)}`),
  );
  return parseNdjson<ContainerSampleLine>(text ?? "");
}

function toProcessTrendRows(lines: ProcessSampleLine[], firstTime: number) {
  const rows = lines
    .filter((line): line is ProcessSampleLine & { capturedAt: string } =>
      Boolean(line.capturedAt),
    )
    .sort((left, right) => Date.parse(left.capturedAt) - Date.parse(right.capturedAt));
  return rows.map((line) => {
    const cpuByType = new Map<string, number>();
    const memoryByType = new Map<string, number>();
    let totalCpu = 0;
    let totalMemoryMb = 0;
    for (const metric of line.metrics ?? []) {
      const type = metric.type || "unknown";
      const cpu = toFiniteNumber(metric.cpuPercent);
      const memoryMb = toFiniteNumber(metric.memoryWorkingSetKb) / KILOBYTES_PER_MB;
      totalCpu += cpu;
      totalMemoryMb += memoryMb;
      cpuByType.set(type, (cpuByType.get(type) ?? 0) + cpu);
      memoryByType.set(type, (memoryByType.get(type) ?? 0) + memoryMb);
    }
    return {
      capturedAt: line.capturedAt,
      cpuByType,
      elapsedSeconds: elapsedSeconds(firstTime, line.capturedAt),
      label: elapsedLabel(firstTime, line.capturedAt),
      memoryByType,
      totalCpu,
      totalMemoryMb,
    };
  });
}

function toContainerTrendRows(lines: ContainerSampleLine[], firstTime: number) {
  const rows = lines
    .filter((line): line is ContainerSampleLine & { capturedAt: string } =>
      Boolean(line.capturedAt),
    )
    .sort((left, right) => Date.parse(left.capturedAt) - Date.parse(right.capturedAt));
  return rows.map((line) => {
    const stats = line.stats ?? {};
    const [memoryUsageBytes] = parseBytePair(stats.MemUsage);
    return {
      capturedAt: line.capturedAt,
      cpuPercent: parsePercent(stats.CPUPerc),
      elapsedSeconds: elapsedSeconds(firstTime, line.capturedAt),
      label: elapsedLabel(firstTime, line.capturedAt),
      memoryUsageMb: memoryUsageBytes / BYTES_PER_MB,
    };
  });
}

function buildProcessSeries(rows: ProcessTrendRow[], metric: "cpu" | "memory") {
  const typeNames = [
    ...new Set(
      rows.flatMap((row) =>
        [...(metric === "cpu" ? row.cpuByType : row.memoryByType).keys()],
      ),
    ),
  ].sort();
  const unit = metric === "cpu" ? "%" : "MB";
  const totalSeries = toSeries(
    "Total",
    unit,
    processColorAt(0),
    rows,
    (row) => (metric === "cpu" ? row.totalCpu : row.totalMemoryMb),
  );
  const typeSeries = typeNames.map((type, index) =>
    toSeries(
      type,
      unit,
      processColorAt(index + 1),
      rows,
      (row) =>
        (metric === "cpu" ? row.cpuByType : row.memoryByType).get(type) ?? 0,
    ),
  );
  return [totalSeries, ...typeSeries];
}

function processColorAt(index: number) {
  return PROCESS_COLORS[index % PROCESS_COLORS.length] ?? "var(--chart-blue)";
}

function toSeries<
  T extends { capturedAt: string; elapsedSeconds: number; label: string },
>(
  label: string,
  unit: string,
  color: string,
  rows: T[],
  readValue: (row: T) => number,
): TrendSeries {
  return {
    color,
    label,
    points: rows.map((row) => ({
      capturedAt: row.capturedAt,
      elapsedSeconds: row.elapsedSeconds,
      label: row.label,
      value: roundMetric(readValue(row)),
    })),
    unit,
  };
}

function buildArtifactCandidates(
  summaryUrl: string,
  artifactPath: string | undefined,
  relativeToSummary: string,
) {
  return [
    resolveRelativeToSummary(summaryUrl, relativeToSummary),
    artifactPath ? toViteFsUrl(artifactPath) : null,
  ].filter((url): url is string => Boolean(url));
}

async function fetchTextFromCandidates(candidates: string[]) {
  for (const url of unique(candidates)) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return await response.text();
      }
    } catch {
      // 读趋势数据允许 fallback：容器产物里的 /workspace 路径在宿主机查看时
      // 不存在，需要回退到 summary.json 旁边的 perf 目录。
    }
  }
  return null;
}

function resolveRelativeToSummary(summaryUrl: string, relativePath: string) {
  return new URL(relativePath, new URL(summaryUrl, window.location.href)).toString();
}

function toViteFsUrl(rawPath: string) {
  const normalized = rawPath.replace(/\\/gu, "/");
  if (normalized.startsWith("/@fs/")) {
    return new URL(normalized, window.location.origin).toString();
  }
  if (normalized.startsWith("/")) {
    return new URL(`/@fs${normalized}`, window.location.origin).toString();
  }
  if (/^[a-zA-Z]:\//u.test(normalized)) {
    return new URL(`/@fs/${normalized}`, window.location.origin).toString();
  }
  return null;
}

function parseNdjson<T>(text: string) {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as T];
      } catch {
        return [];
      }
    });
}

function parsePercent(value: string | undefined) {
  return toFiniteNumber(value?.replace("%", ""));
}

function parseBytePair(value: string | undefined): [number, number] {
  const parts = (value ?? "").split("/");
  return [parseBytes(parts[0]), parseBytes(parts[1])];
}

function parseBytes(value: string | undefined) {
  const match = value?.trim().match(/^([\d.]+)\s*([kmgt]?i?b)?$/iu);
  if (!match) {
    return 0;
  }
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) {
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
  return amount * (multipliers[unit] ?? 1);
}

function resolveRunStartTime(
  summary: E2EReportSummary,
  processLines: ProcessSampleLine[],
  containerLines: ContainerSampleLine[],
) {
  const candidates = [
    summary.startedAt,
    processLines.find((line) => line.capturedAt)?.capturedAt,
    containerLines.find((line) => line.capturedAt)?.capturedAt,
  ];
  for (const candidate of candidates) {
    const time = Date.parse(candidate ?? "");
    if (Number.isFinite(time)) {
      return time;
    }
  }
  return 0;
}

function elapsedSeconds(firstTime: number, capturedAt: string) {
  const elapsedMs = Math.max(0, Date.parse(capturedAt) - firstTime);
  if (!Number.isFinite(elapsedMs)) {
    return 0;
  }
  return Math.round(elapsedMs / 1000);
}

function elapsedLabel(firstTime: number, capturedAt: string) {
  const seconds = elapsedSeconds(firstTime, capturedAt);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function basename(path: string) {
  return path.replace(/\\/gu, "/").split("/").at(-1) ?? path;
}

function roundMetric(value: number) {
  return Math.round(toFiniteNumber(value) * 100) / 100;
}

function toFiniteNumber(value: number | string | undefined) {
  const numberValue = Number(value ?? 0);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function unique(values: string[]) {
  return [...new Set(values)];
}
