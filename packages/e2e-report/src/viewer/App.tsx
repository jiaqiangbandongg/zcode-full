import {
  ActivityIcon,
  CheckCircle2Icon,
  ClockIcon,
  CpuIcon,
  GaugeIcon,
  HardDriveIcon,
  MemoryStickIcon,
  XCircleIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type {
  E2EReportSummary,
  TestResultSummary,
} from "../shared/types.js";
import { TrendPanels } from "./ChartPanels.js";
import { CoveragePanel } from "./CoveragePanel.js";
import {
  formatBytes,
  formatDateTime,
  formatDuration,
  formatNumber,
} from "./format.js";
import { loadReportSummary } from "./reportData.js";
import { loadPerformanceTrends } from "./trendData.js";
import type { PerformanceTrends } from "./trendData.js";

interface ReportState {
  summary: E2EReportSummary;
  trends: PerformanceTrends | null;
  trendError: string | null;
}

export function App() {
  const [report, setReport] = useState<ReportState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadReportSummary()
      .then(async ({ summary, summaryUrl }) => {
        try {
          const trends = await loadPerformanceTrends(summary, summaryUrl);
          setReport({ summary, trendError: null, trends });
        } catch (loadError: unknown) {
          setReport({
            summary,
            trendError:
              loadError instanceof Error ? loadError.message : String(loadError),
            trends: null,
          });
        }
      })
      .catch((loadError: unknown) => {
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      });
  }, []);

  if (error) {
    return <StateScreen title="报告加载失败" detail={error} />;
  }
  if (!report) {
    return <StateScreen title="报告加载中" detail="Reading summary.json" />;
  }

  return <ReportView report={report} />;
}

function ReportView({ report }: { report: ReportState }) {
  const { summary } = report;
  const failed = summary.exitCode !== 0 || summary.tests.failed > 0;
  const uiCoverage = summary.coverage?.uiRenderer;
  return (
    <main className="shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Desktop E2E Report</p>
          <h1>{summary.runId}</h1>
          <p className="path">{summary.artifactDir}</p>
        </div>
        <div className="heroMeta">
          <span className={failed ? "status fail" : "status pass"}>
            {failed ? <XCircleIcon size={16} /> : <CheckCircle2Icon size={16} />}
            {failed ? "FAILED" : "PASSED"}
          </span>
          <span>开始 {formatDateTime(summary.startedAt)}</span>
          <span>完成 {formatDateTime(summary.completedAt)}</span>
        </div>
      </header>

      <section className="metricGrid">
        <MetricCard
          detail={`${summary.tests.failed} failed`}
          icon={<CheckCircle2Icon />}
          label="测试"
          value={`${summary.tests.passed}/${summary.tests.total}`}
        />
        <MetricCard
          detail={`exit ${summary.exitCode}`}
          icon={<ClockIcon />}
          label="总耗时"
          value={formatDuration(summary.durationMs)}
        />
        <MetricCard
          detail={
            uiCoverage
              ? `${uiCoverage.sourceFileCount ?? uiCoverage.rendererEntryCount} ${
                  uiCoverage.sourceFileCount === undefined
                    ? "renderer scripts"
                    : "source files"
                }`
              : "disabled"
          }
          icon={<GaugeIcon />}
          label="UI 覆盖率"
          value={statsValue(
            uiCoverage?.totals.lines?.pct ?? uiCoverage?.totals.percent,
            "%",
          )}
        />
        <MetricCard
          detail={sampleHint(summary.performance.processSamples)}
          icon={<CpuIcon />}
          label="Electron CPU P95"
          value={statsValue(summary.performance.processSamples?.cpuTotalPercent.p95, "%")}
        />
        <MetricCard
          detail={sampleHint(summary.performance.processSamples)}
          icon={<MemoryStickIcon />}
          label="Electron 内存峰值"
          value={statsValue(summary.performance.processSamples?.memoryWorkingSetMb.peak, "MB")}
        />
        <MetricCard
          detail={sampleHint(summary.performance.containerSamples)}
          icon={<GaugeIcon />}
          label="容器 CPU P95"
          value={statsValue(summary.performance.containerSamples?.cpuPercent.p95, "%")}
        />
        <MetricCard
          detail={summary.containerE2E ? "docker stats" : "non-container"}
          icon={<HardDriveIcon />}
          label="容器块写入峰值"
          value={statsValue(summary.performance.containerSamples?.blockWriteMb.peak, "MB")}
        />
      </section>

      <TrendPanels trends={report.trends} trendError={report.trendError} />

      <CoveragePanel coverage={uiCoverage} />

      <TestsPanel results={summary.tests.results} />

      <section className="gridTwo">
        <InfoPanel title="Specs" rows={specRows(summary)} />
        <InfoPanel title="Artifacts" rows={artifactRows(summary)} />
        <InfoPanel title="Environment" rows={environmentRows(summary)} />
      </section>
    </main>
  );
}

function MetricCard(props: {
  detail: string;
  icon: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <article className="metric">
      <div className="metricIcon">{props.icon}</div>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
      <small>{props.detail}</small>
    </article>
  );
}

function TestsPanel({ results }: { results: TestResultSummary[] }) {
  return (
    <Panel title="Tests" meta={`${results.length} recorded`} wide>
      <div className="tableWrap">
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>Duration</th>
              <th>Test</th>
              <th>File</th>
            </tr>
          </thead>
          <tbody>
            {(results.length > 0 ? results : [emptyResult()]).map((result) => (
              <tr key={`${result.fullTitle}-${result.capturedAt}`}>
                <td>
                  <span className={result.passed ? "pill pass" : "pill fail"}>
                    {result.passed ? "PASS" : "FAIL"}
                  </span>
                </td>
                <td>{formatDuration(result.durationMs)}</td>
                <td>
                  {result.fullTitle}
                  {result.error ? <pre>{result.error}</pre> : null}
                </td>
                <td>
                  <code>{result.file ?? "n/a"}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function InfoPanel({ rows, title }: { rows: Array<[string, string]>; title: string }) {
  return (
    <Panel title={title}>
      <dl className="infoList">
        {rows.map(([label, value]) => (
          <div key={`${label}-${value}`}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}

function Panel(props: {
  children: ReactNode;
  meta?: string;
  title: string;
  wide?: boolean;
}) {
  return (
    <section className={props.wide ? "panel wide" : "panel"}>
      <div className="panelHeader">
        <h2>{props.title}</h2>
        {props.meta ? <span>{props.meta}</span> : null}
      </div>
      {props.children}
    </section>
  );
}

function StateScreen({ detail, title }: { detail: string; title: string }) {
  return (
    <main className="stateScreen">
      <ActivityIcon size={28} />
      <h1>{title}</h1>
      <p>{detail}</p>
    </main>
  );
}

function specRows(summary: E2EReportSummary): Array<[string, string]> {
  const specs =
    summary.requestedSpecs.length > 0
      ? summary.requestedSpecs
      : ["all configured desktop e2e specs"];
  return specs.map((spec, index) => [`Spec ${index + 1}`, spec]);
}

function artifactRows(summary: E2EReportSummary): Array<[string, string]> {
  return [
    ["Viewer URL", summary.files.viewerUrl ?? window.location.href],
    ["Summary JSON", summary.files.summaryJson],
    ["Summary Markdown", summary.files.summaryMd],
    ["Coverage heatmap", summary.files.coverageHeatmap ?? "n/a"],
    ["UI renderer coverage", summary.files.uiRendererCoverage ?? "n/a"],
    ["Manifest", summary.files.manifest],
    ["Test results", summary.files.tests],
    ["Process samples", summary.files.processSamplesGlob],
    ["Container samples", summary.files.containerSamples],
  ];
}

function environmentRows(summary: E2EReportSummary): Array<[string, string]> {
  return [
    ["Platform", `${summary.environment.platform} / ${summary.environment.arch}`],
    ["Node", summary.environment.node],
    ["CPU", summary.environment.cpuModel],
    ["Memory", formatBytes(summary.environment.totalMemoryBytes)],
    ["Container", summary.containerE2E ? "yes" : "no"],
  ];
}

function emptyResult(): TestResultSummary {
  return {
    capturedAt: "",
    durationMs: 0,
    fullTitle: "No test results were recorded",
    passed: true,
    status: "unknown",
    title: "No test results",
  };
}

function sampleHint(summary: { sampleCount: number } | undefined) {
  return summary ? `${summary.sampleCount} samples` : "no samples";
}

function statsValue(value: number | undefined, suffix: string) {
  return value === undefined ? "n/a" : formatNumber(value, suffix);
}
