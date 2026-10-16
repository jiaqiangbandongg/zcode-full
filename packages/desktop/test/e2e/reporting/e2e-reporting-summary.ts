/* eslint-disable max-lines -- summary 聚合逻辑含 stability/timing/failureBreakdown 计算，拆分会扩大测试报告模块间耦合。 */
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, totalmem } from "node:os";
import { resolve } from "node:path";
import { createE2EReportViewerUrl } from "@zcode/e2e-report";
import {
  BYTES_PER_KB,
  BYTES_PER_MB,
  numericStats,
  parseBytePair,
  parsePercent,
} from "./e2e-reporting-stats.js";
import type {
  E2ELifecycleEvent,
  E2ELifecycleSummary,
  FailureBreakdown,
  ProcessMetricSample,
  StabilityMetrics,
  TestResultLine,
  TimingMetrics,
} from "./e2e-reporting-types.js";
import { renderUICoverageMarkdownSection } from "./e2e-reporting-coverage.js";
import type { UIRendererCoverageSummary } from "./e2e-ui-coverage.js";
import type { E2ENodeCoverageSummary } from "./e2e-node-coverage.js";

interface ContainerStatsLine {
  capturedAt?: string;
  stats?: {
    BlockIO?: string;
    CPUPerc?: string;
    MemPerc?: string;
    MemUsage?: string;
    Name?: string;
    NetIO?: string;
    PIDs?: string;
  };
}

interface WriteSummaryOptions {
  artifactDir: string;
  containerE2E: boolean;
  containerSamplesPath: string;
  coverageSummaryPath: string;
  exitCode: number;
  lifecycleEventsPath: string;
  manifestPath: string;
  perfDir: string;
  requestedSpecs: string[];
  runId: string;
  startedAt: Date;
  summaryJsonPath: string;
  summaryMdPath: string;
  testsPath: string;
}

export function appendJsonLine(path: string, value: unknown) {
  appendFileSync(path, `${JSON.stringify(value)}\n`, "utf-8");
}

export function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

export function normalizeSpecs(specs: string[]) {
  return specs.map((spec) => spec.replace(/\\/g, "/"));
}

export function sanitizeFilePart(value: string) {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

export function formatRunId(date: Date) {
  const pad = (value: number, size = 2) => String(value).padStart(size, "0");
  return [
    "desktop-e2e",
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`,
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`,
    pad(date.getUTCMilliseconds(), 3),
  ].join("-");
}

function readNdjson<T>(path: string): T[] {
  if (!existsSync(path)) {
    return [];
  }

  return readFileSync(path, "utf-8")
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

function readJsonFile<T>(path: string): T | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

function processSampleFiles(perfDir: string) {
  if (!existsSync(perfDir)) {
    return [];
  }

  return readdirSync(perfDir)
    .filter((name) => name.startsWith("process-samples-") && name.endsWith(".ndjson"))
    .map((name) => resolve(perfDir, name))
    .sort();
}

function summarizeProcessSamples(perfDir: string) {
  const files = processSampleFiles(perfDir);
  const samples = files.flatMap((file) => readNdjson<ProcessMetricSample>(file));
  if (samples.length === 0) {
    return undefined;
  }

  const cpuTotals = samples.map((sample) =>
    sample.metrics.reduce((total, metric) => total + metric.cpuPercent, 0),
  );
  const memoryTotalsMb = samples.map(
    (sample) =>
      sample.metrics.reduce((total, metric) => total + metric.memoryWorkingSetKb, 0) / BYTES_PER_KB,
  );
  const byTypeValues = new Map<string, { cpu: number[]; memoryMb: number[] }>();

  for (const sample of samples) {
    const sampleTypes = new Map<string, { cpu: number; memoryKb: number }>();
    for (const metric of sample.metrics) {
      const type = metric.type || "unknown";
      const current = sampleTypes.get(type) ?? { cpu: 0, memoryKb: 0 };
      current.cpu += metric.cpuPercent;
      current.memoryKb += metric.memoryWorkingSetKb;
      sampleTypes.set(type, current);
    }

    for (const [type, value] of sampleTypes) {
      const bucket = byTypeValues.get(type) ?? { cpu: [], memoryMb: [] };
      bucket.cpu.push(value.cpu);
      bucket.memoryMb.push(value.memoryKb / BYTES_PER_KB);
      byTypeValues.set(type, bucket);
    }
  }

  return {
    byType: Object.fromEntries(
      [...byTypeValues.entries()].map(([type, value]) => [
        type,
        {
          cpuPercent: numericStats(value.cpu),
          memoryWorkingSetMb: numericStats(value.memoryMb),
        },
      ]),
    ),
    cpuTotalPercent: numericStats(cpuTotals),
    files,
    memoryWorkingSetMb: numericStats(memoryTotalsMb),
    sampleCount: samples.length,
  };
}

function summarizeContainerSamples(containerSamplesPath: string) {
  const samples = readNdjson<ContainerStatsLine>(containerSamplesPath);
  if (samples.length === 0) {
    return undefined;
  }

  const statsRows = samples.map((sample) => sample.stats ?? {});
  const memPairs = statsRows.map((stats) => parseBytePair(stats.MemUsage));
  const netPairs = statsRows.map((stats) => parseBytePair(stats.NetIO));
  const blockPairs = statsRows.map((stats) => parseBytePair(stats.BlockIO));
  return {
    blockReadMb: numericStats(blockPairs.map((pair) => pair.left / BYTES_PER_MB)),
    blockWriteMb: numericStats(blockPairs.map((pair) => pair.right / BYTES_PER_MB)),
    cpuPercent: numericStats(statsRows.map((stats) => parsePercent(stats.CPUPerc))),
    file: containerSamplesPath,
    memoryPercent: numericStats(statsRows.map((stats) => parsePercent(stats.MemPerc))),
    memoryUsageMb: numericStats(memPairs.map((pair) => pair.left / BYTES_PER_MB)),
    networkRxMb: numericStats(netPairs.map((pair) => pair.left / BYTES_PER_MB)),
    networkTxMb: numericStats(netPairs.map((pair) => pair.right / BYTES_PER_MB)),
    pids: numericStats(
      statsRows.map((stats) => {
        const value = Number(stats.PIDs ?? 0);
        return Number.isFinite(value) ? value : 0;
      }),
    ),
    sampleCount: samples.length,
  };
}

function summarizeLifecycleEvents(lifecycleEventsPath: string): E2ELifecycleSummary {
  const events = readNdjson<E2ELifecycleEvent>(lifecycleEventsPath);
  const byPhase = new Map<string, number[]>();

  for (const event of events) {
    const durations = byPhase.get(event.phase) ?? [];
    durations.push(event.durationMs);
    byPhase.set(event.phase, durations);
  }

  return {
    byPhase: Object.fromEntries(
      [...byPhase.entries()].map(([phase, durations]) => {
        const sorted = durations.filter(Number.isFinite).sort((a, b) => a - b);
        const p50Index = Math.max(0, Math.ceil(sorted.length * 0.5) - 1);
        const p95Index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
        return [
          phase,
          {
            count: sorted.length,
            p50Ms: sorted[p50Index] ?? 0,
            p95Ms: sorted[p95Index] ?? 0,
            totalMs: sorted.reduce((total, value) => total + value, 0),
          },
        ];
      }),
    ),
  };
}

function renderTestRows(results: TestResultLine[]) {
  if (results.length === 0) {
    return ["| n/a | 0ms | no test results were recorded |"];
  }

  return results.map(
    (test) =>
      `| ${test.passed ? "PASS" : isSkippedResult(test) ? "SKIP" : "FAIL"} | ${test.durationMs}ms | ${test.fullTitle.replace(/\|/g, "\\|")} |`,
  );
}

function renderSummaryMarkdown(summary: ReturnType<typeof buildSummaryPayload>) {
  const processSamples = summary.performance.processSamples;
  const containerSamples = summary.performance.containerSamples;
  const lifecyclePhases = Object.entries(summary.lifecycle.byPhase);
  const lines = [
    "# Desktop E2E Report",
    "",
    `- Run ID: \`${summary.runId}\``,
    `- Exit code: \`${summary.exitCode}\``,
    `- Duration: \`${summary.durationMs}ms\``,
    `- Container: \`${summary.containerE2E ? "yes" : "no"}\``,
    `- Artifact dir: \`${summary.artifactDir}\``,
    "",
    "## Stability",
    "",
    `- Pass rate: \`${(summary.stability.passRate * 100).toFixed(1)}%\``,
    `- First-time pass rate: \`${(summary.stability.firstTimePassRate * 100).toFixed(1)}%\``,
    `- Flaky: \`${summary.stability.flakyCount}\` cases (\`${(summary.stability.flakyRate * 100).toFixed(1)}%\`)`,
    `- Infra failures: \`${summary.stability.infraFailureCount}\` (\`${(summary.stability.infraFailureRate * 100).toFixed(1)}%\`)`,
    "",
    "## Timing",
    "",
    `- Total duration: \`${summary.timing.totalDurationMs}ms\``,
    ...(summary.timing.queueTimeMs != null
      ? [`- Queue time: \`${summary.timing.queueTimeMs}ms\``]
      : []),
    `- Case duration P50: \`${summary.timing.caseDurationP50Ms}ms\``,
    `- Case duration P95: \`${summary.timing.caseDurationP95Ms}ms\``,
    "",
    "## Lifecycle",
    "",
    ...(lifecyclePhases.length > 0
      ? lifecyclePhases.map(
          ([phase, stats]) =>
            `- ${phase}: \`${stats.count}\` runs, total \`${stats.totalMs}ms\`, p50 \`${stats.p50Ms}ms\`, p95 \`${stats.p95Ms}ms\``,
        )
      : ["- No lifecycle events were recorded."]),
    "",
    "### Slowest Cases",
    "",
    "| Duration | Test |",
    "| ---: | --- |",
    ...summary.timing.slowestCases.map(
      (c) => `| ${c.durationMs}ms | ${c.fullTitle.replace(/\|/g, "\\|")} |`,
    ),
    "",
    "## Failure Breakdown",
    "",
    `- Assertion: \`${summary.failureBreakdown.assertion}\``,
    `- Timeout: \`${summary.failureBreakdown.timeout}\``,
    `- Crash: \`${summary.failureBreakdown.crash}\``,
    `- Infra: \`${summary.failureBreakdown.infra}\``,
    `- Unknown: \`${summary.failureBreakdown.unknown}\``,
    "",
    "## Specs",
    "",
    ...(summary.requestedSpecs.length > 0
      ? summary.requestedSpecs.map((spec) => `- \`${spec}\``)
      : ["- all configured desktop e2e specs"]),
    "",
    "## Tests",
    "",
    `- Total: \`${summary.tests.total}\``,
    `- Passed: \`${summary.tests.passed}\``,
    `- Failed: \`${summary.tests.failed}\``,
    `- Skipped: \`${summary.tests.skipped}\``,
    "",
    "| Status | Duration | Test |",
    "| --- | ---: | --- |",
    ...renderTestRows(summary.tests.results),
    "",
    "## Performance",
    "",
    "### Electron Processes",
    "",
  ];

  if (processSamples) {
    lines.push(
      `- Samples: \`${processSamples.sampleCount}\``,
      `- CPU total mean / p95 / peak: \`${processSamples.cpuTotalPercent.mean}%\` / \`${processSamples.cpuTotalPercent.p95}%\` / \`${processSamples.cpuTotalPercent.peak}%\``,
      `- Memory working set mean / p95 / peak: \`${processSamples.memoryWorkingSetMb.mean}MB\` / \`${processSamples.memoryWorkingSetMb.p95}MB\` / \`${processSamples.memoryWorkingSetMb.peak}MB\``,
      "",
      "| Type | CPU Mean | CPU P95 | Memory Mean | Memory Peak |",
      "| --- | ---: | ---: | ---: | ---: |",
      ...Object.entries(processSamples.byType).map(
        ([type, stats]) =>
          `| ${type} | ${stats.cpuPercent.mean}% | ${stats.cpuPercent.p95}% | ${stats.memoryWorkingSetMb.mean}MB | ${stats.memoryWorkingSetMb.peak}MB |`,
      ),
      "",
    );
  } else {
    lines.push("- No process samples were collected.", "");
  }

  if (containerSamples) {
    lines.push(
      "### Container",
      "",
      `- Samples: \`${containerSamples.sampleCount}\``,
      `- CPU mean / p95 / peak: \`${containerSamples.cpuPercent.mean}%\` / \`${containerSamples.cpuPercent.p95}%\` / \`${containerSamples.cpuPercent.peak}%\``,
      `- Memory mean / p95 / peak: \`${containerSamples.memoryUsageMb.mean}MB\` / \`${containerSamples.memoryUsageMb.p95}MB\` / \`${containerSamples.memoryUsageMb.peak}MB\``,
      `- Network RX/TX peak: \`${containerSamples.networkRxMb.peak}MB\` / \`${containerSamples.networkTxMb.peak}MB\``,
      `- Block read/write peak: \`${containerSamples.blockReadMb.peak}MB\` / \`${containerSamples.blockWriteMb.peak}MB\``,
      "",
    );
  }

  if (summary.coverage.uiRenderer) {
    lines.push(...renderUICoverageMarkdownSection(summary.coverage.uiRenderer));
  }

  if (summary.coverage.node) {
    lines.push("## Runtime Coverage", "");
    for (const domain of ["main", "host", "cli"] as const) {
      const coverage = summary.coverage.node.domains[domain];
      const linesTotal = coverage.totals?.lines;
      lines.push(
        `- ${domain}: \`${formatCoverageMetric(linesTotal)}\`, raw \`${coverage.rawFileCount}\`, missing processes \`${coverage.missingRawProcessCount}\`, pre-entry zero \`${coverage.preEntryProcessCount ?? 0}\`, sources \`${coverage.sourceFileCount}\`, complete \`${coverage.complete ? "yes" : "no"}\``,
      );
    }
    lines.push("");
  }

  lines.push(
    "## Files",
    "",
    `- Manifest: \`${summary.files.manifest}\``,
    `- Test results: \`${summary.files.tests}\``,
    `- Viewer URL: \`${summary.files.viewerUrl}\``,
    `- Summary JSON: \`${summary.files.summaryJson}\``,
    ...(summary.files.coverageSummary
      ? [`- Coverage summary: \`${summary.files.coverageSummary}\``]
      : []),
    ...(summary.files.coverageHeatmap
      ? [`- Coverage heatmap: \`${summary.files.coverageHeatmap}\``]
      : []),
    ...(summary.files.uiRendererCoverage
      ? [`- UI renderer coverage: \`${summary.files.uiRendererCoverage}\``]
      : []),
    `- Process samples: \`${summary.files.processSamplesGlob}\``,
    `- Container samples: \`${summary.files.containerSamples}\``,
    "",
  );
  return `${lines.join("\n")}\n`;
}

function computeStabilityMetrics(results: TestResultLine[]): StabilityMetrics {
  const countedResults = results.filter((result) => !isSkippedResult(result));
  const total = countedResults.length;
  if (total === 0) {
    return {
      passRate: 0,
      firstTimePassRate: 0,
      flakyCount: 0,
      flakyRate: 0,
      infraFailureCount: 0,
      infraFailureRate: 0,
    };
  }

  const passed = countedResults.filter((r) => r.passed).length;
  const firstTimePassed = countedResults.filter((r) => r.passed && !r.passedOnRetry).length;
  const flaky = countedResults.filter((r) => r.passedOnRetry).length;
  const infraFailures = countedResults.filter(
    (r) => !r.passed && r.errorCategory === "infra",
  ).length;

  return {
    passRate: round(passed / total, 4),
    firstTimePassRate: round(firstTimePassed / total, 4),
    flakyCount: flaky,
    flakyRate: round(flaky / total, 4),
    infraFailureCount: infraFailures,
    infraFailureRate: round(infraFailures / total, 4),
  };
}

function computeTimingMetrics(
  results: TestResultLine[],
  totalDurationMs: number,
  queueTimeMs: number | undefined,
): TimingMetrics {
  const countedResults = results.filter((result) => !isSkippedResult(result));
  const durations = countedResults
    .map((r) => r.durationMs)
    .filter((d) => Number.isFinite(d))
    .sort((a, b) => a - b);

  const p50Index = Math.max(0, Math.ceil(durations.length * 0.5) - 1);
  const p95Index = Math.max(0, Math.ceil(durations.length * 0.95) - 1);

  const slowestCases = [...countedResults]
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 10)
    .map((r) => ({ fullTitle: r.fullTitle, durationMs: r.durationMs }));

  return {
    totalDurationMs,
    queueTimeMs,
    caseDurationP50Ms: durations[p50Index] ?? 0,
    caseDurationP95Ms: durations[p95Index] ?? 0,
    slowestCases,
  };
}

function computeFailureBreakdown(results: TestResultLine[]): FailureBreakdown {
  const failed = results.filter((r) => !r.passed && !isSkippedResult(r));
  return {
    assertion: failed.filter((r) => r.errorCategory === "assertion").length,
    timeout: failed.filter((r) => r.errorCategory === "timeout").length,
    crash: failed.filter((r) => r.errorCategory === "crash").length,
    infra: failed.filter((r) => r.errorCategory === "infra").length,
    unknown: failed.filter((r) => !r.errorCategory || r.errorCategory === "unknown").length,
  };
}

function isSkippedResult(
  result: Pick<TestResultLine, "error" | "errorCategory" | "errorStack" | "passed" | "status">,
): boolean {
  const status = result.status?.toLowerCase();
  // 修复原因：Mocha this.skip() 在 WDIO 结果里 passed=false，但 status=skipped/pending；
  // 只按 !passed 聚合会把 Windows 平台跳过的 case 错计为失败。
  if (status === "skipped" || status === "pending") {
    return true;
  }
  // 兼容旧报告：历史 test-results 没有写 status，skipped 只留下 passed=false 且没有错误内容。
  return (
    !result.passed &&
    !status &&
    !result.error &&
    !result.errorStack &&
    (!result.errorCategory || result.errorCategory === "unknown")
  );
}

function computeQueueTimeMs(): number | undefined {
  const startedAt = process.env.CI_JOB_STARTED_AT;
  const createdAt = process.env.CI_PIPELINE_CREATED_AT;
  if (!startedAt || !createdAt) return undefined;
  const diff = new Date(startedAt).getTime() - new Date(createdAt).getTime();
  return Number.isFinite(diff) && diff >= 0 ? diff : undefined;
}

function round(value: number, digits = 2) {
  if (!Number.isFinite(value)) return 0;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function formatCoverageMetric(
  metric: { covered: number; pct: number | string; total: number } | undefined,
) {
  if (!metric) return "n/a";
  return `${metric.pct}% (${metric.covered}/${metric.total})`;
}

function buildSummaryPayload(options: WriteSummaryOptions) {
  const completedAt = new Date();
  const testResults = readNdjson<TestResultLine>(options.testsPath);
  const uiRendererCoveragePath = resolve(options.artifactDir, "coverage/ui-renderer-summary.json");
  const uiRendererCoverage = readJsonFile<UIRendererCoverageSummary>(uiRendererCoveragePath);
  const coverageHeatmapPath = resolve(options.artifactDir, "coverage/heatmap/index.html");
  const nodeCoverage = readJsonFile<{ node?: E2ENodeCoverageSummary }>(
    options.coverageSummaryPath,
  )?.node;
  const viewerUrl = createE2EReportViewerUrl({
    summaryJsonPath: options.summaryJsonPath,
  });
  const totalDurationMs = completedAt.getTime() - options.startedAt.getTime();
  const queueTimeMs = computeQueueTimeMs();
  const skippedResults = testResults.filter(isSkippedResult);
  const countedResults = testResults.filter((result) => !isSkippedResult(result));
  return {
    artifactDir: options.artifactDir,
    completedAt: completedAt.toISOString(),
    containerE2E: options.containerE2E,
    durationMs: totalDurationMs,
    environment: {
      arch: arch(),
      cpuModel: cpus()[0]?.model ?? "unknown",
      node: process.version,
      platform: platform(),
      totalMemoryBytes: totalmem(),
    },
    exitCode: options.exitCode,
    files: {
      containerSamples: options.containerSamplesPath,
      coverageHeatmap: existsSync(coverageHeatmapPath)
        ? coverageHeatmapPath
        : undefined,
      coverageSummary: existsSync(options.coverageSummaryPath)
        ? options.coverageSummaryPath
        : undefined,
      lifecycleEvents: options.lifecycleEventsPath,
      manifest: options.manifestPath,
      processSamplesGlob: resolve(options.perfDir, "process-samples-*.ndjson"),
      summaryJson: options.summaryJsonPath,
      summaryMd: options.summaryMdPath,
      tests: options.testsPath,
      uiRendererCoverage: uiRendererCoverage ? uiRendererCoveragePath : undefined,
      viewerUrl,
    },
    coverage: {
      node: nodeCoverage,
      uiRenderer: uiRendererCoverage,
    },
    performance: {
      containerSamples: summarizeContainerSamples(options.containerSamplesPath),
      processSamples: summarizeProcessSamples(options.perfDir),
    },
    lifecycle: summarizeLifecycleEvents(options.lifecycleEventsPath),
    stability: computeStabilityMetrics(testResults),
    timing: computeTimingMetrics(testResults, totalDurationMs, queueTimeMs),
    failureBreakdown: computeFailureBreakdown(testResults),
    requestedSpecs: options.requestedSpecs,
    runId: options.runId,
    startedAt: options.startedAt.toISOString(),
    tests: {
      failed: countedResults.filter((result) => !result.passed).length,
      passed: countedResults.filter((result) => result.passed).length,
      results: testResults,
      skipped: skippedResults.length,
      total: testResults.length,
    },
  };
}

export function writeE2ESummary(options: WriteSummaryOptions) {
  const summary = buildSummaryPayload(options);
  writeJson(options.summaryJsonPath, summary);
  writeFileSync(options.summaryMdPath, renderSummaryMarkdown(summary), "utf-8");
  console.info(`[desktop-e2e-report] summary: ${options.summaryMdPath}`);
  console.info(`[desktop-e2e-report] viewer: ${summary.files.viewerUrl}`);
}
