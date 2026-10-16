export interface NumericStats {
  mean: number;
  peak: number;
  p95: number;
  sampleCount: number;
}

export interface TestResultSummary {
  capturedAt: string;
  durationMs: number;
  error?: string;
  file?: string;
  fullTitle: string;
  passed: boolean;
  status: string;
  title: string;
}

export interface ProcessSampleSummary {
  byType: Record<
    string,
    {
      cpuPercent: NumericStats;
      memoryWorkingSetMb: NumericStats;
    }
  >;
  cpuTotalPercent: NumericStats;
  files: string[];
  memoryWorkingSetMb: NumericStats;
  sampleCount: number;
}

export interface ContainerSampleSummary {
  blockReadMb: NumericStats;
  blockWriteMb: NumericStats;
  cpuPercent: NumericStats;
  file: string;
  memoryPercent: NumericStats;
  memoryUsageMb: NumericStats;
  networkRxMb: NumericStats;
  networkTxMb: NumericStats;
  pids: NumericStats;
  sampleCount: number;
}

export interface ScriptCoverageSummary {
  coveredBytes: number;
  entryCount: number;
  percent: number;
  totalBytes: number;
  url: string;
}

export interface CoverageMetricSummary {
  covered: number;
  pct: number;
  skipped: number;
  total: number;
}

export interface SourceFileCoverageSummary {
  branches: CoverageMetricSummary;
  functions: CoverageMetricSummary;
  lines: CoverageMetricSummary;
  path: string;
  relativePath: string;
  statements: CoverageMetricSummary;
  uncoveredLines: number[];
}

export interface UIRendererCoverageSummary {
  capturedAt: string;
  complete?: boolean;
  enabled: boolean;
  files: {
    coverageFinalJson?: string;
    coverageSummaryJson?: string;
    htmlIndex?: string;
    lcov?: string;
    markdown: string;
    raw: string;
    rawDir?: string;
    summaryJson: string;
  };
  pageCount: number;
  rawEntryCount: number;
  rawFileCount?: number;
  reportKind?: "istanbul-instrumented" | "istanbul-source";
  rendererEntryCount: number;
  scripts: ScriptCoverageSummary[];
  sourceFileCount?: number;
  sourceFiles?: SourceFileCoverageSummary[];
  totals: {
    branches?: CoverageMetricSummary;
    coveredBytes: number;
    functions?: CoverageMetricSummary;
    lines?: CoverageMetricSummary;
    percent: number;
    statements?: CoverageMetricSummary;
    totalBytes: number;
  };
}

export interface E2EReportSummary {
  artifactDir: string;
  completedAt: string;
  containerE2E: boolean;
  durationMs: number;
  environment: {
    arch: string;
    cpuModel: string;
    node: string;
    platform: string;
    totalMemoryBytes: number;
  };
  exitCode: number;
  files: {
    containerSamples: string;
    coverageHeatmap?: string;
    manifest: string;
    processSamplesGlob: string;
    summaryJson: string;
    summaryMd: string;
    tests: string;
    uiRendererCoverage?: string;
    viewerUrl?: string;
  };
  coverage?: {
    uiRenderer?: UIRendererCoverageSummary;
  };
  performance: {
    containerSamples?: ContainerSampleSummary;
    processSamples?: ProcessSampleSummary;
  };
  requestedSpecs: string[];
  runId: string;
  startedAt: string;
  tests: {
    failed: number;
    passed: number;
    results: TestResultSummary[];
    total: number;
  };
}

export interface CreateE2EReportViewerUrlOptions {
  baseUrl?: string;
  summaryJsonPath: string;
}
