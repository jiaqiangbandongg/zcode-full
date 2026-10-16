export interface ProcessMetricSample {
  capturedAt: string;
  workerId: string;
  specs: string[];
  mainPid: number;
  windows: Array<{
    id: number;
    title: string;
    visible: boolean;
    url: string;
    pid: number;
  }>;
  metrics: Array<{
    pid: number;
    type: string;
    name?: string;
    serviceName?: string;
    cpuPercent: number;
    idleWakeupsPerSecond: number;
    memoryWorkingSetKb: number;
    memoryPeakWorkingSetKb: number;
    memoryPrivateBytes?: number;
  }>;
}

export type ErrorCategory = "assertion" | "timeout" | "crash" | "infra" | "unknown";

export type E2ELifecyclePhase =
  | "prepare"
  | "worker"
  | "before-session"
  | "before"
  | "before-suite"
  | "after"
  | "after-session"
  | "complete";

export interface E2ELifecycleEvent {
  cid?: string;
  completedAt: string;
  durationMs: number;
  error?: string;
  phase: E2ELifecyclePhase;
  specs: string[];
  startedAt: string;
  status?: "failed" | "passed";
}

export interface E2ELifecyclePhaseSummary {
  count: number;
  p50Ms: number;
  p95Ms: number;
  totalMs: number;
}

export interface E2ELifecycleSummary {
  byPhase: Partial<Record<E2ELifecyclePhase, E2ELifecyclePhaseSummary>>;
}

export interface TestResultLine {
  capturedAt: string;
  file?: string;
  fullTitle: string;
  title: string;
  passed: boolean;
  status: string;
  durationMs: number;
  error?: string;
  retryIndex?: number;
  retryLimit?: number;
  passedOnRetry?: boolean;
  errorCategory?: ErrorCategory;
  errorStack?: string;
  collectionErrors?: string[];
  failureArtifacts?: {
    caseId: string;
    caseManifest: string;
    collectionErrors?: string[];
    logsIndex: string;
    retryIndex: number;
    video?: string;
    workerId: string;
  };
  featureArea?: string;
}

export interface CIMetadata {
  provider: "gitlab";
  pipelineId?: string;
  jobId?: string;
  jobName?: string;
  commitSha?: string;
  branch?: string;
  mrIid?: string;
  triggeredBy?: string;
  queuedAt?: string;
  startedAt?: string;
  runnerDescription?: string;
}

export interface VersionsMetadata {
  electron?: string;
  chromium?: string;
  chromedriver?: string;
  wdio?: string;
}

export interface OSMetadata {
  name?: string;
  version?: string;
  displayServer?: string;
  scaleFactor?: number;
}

export interface StabilityMetrics {
  passRate: number;
  firstTimePassRate: number;
  flakyCount: number;
  flakyRate: number;
  infraFailureCount: number;
  infraFailureRate: number;
}

export interface TimingMetrics {
  totalDurationMs: number;
  queueTimeMs?: number;
  caseDurationP50Ms: number;
  caseDurationP95Ms: number;
  slowestCases: Array<{ fullTitle: string; durationMs: number }>;
}

export interface FailureBreakdown {
  assertion: number;
  timeout: number;
  crash: number;
  infra: number;
  unknown: number;
}
