import type { RunSummary } from "@/shared/types";
import { RunStatusBadge } from "@/client/RunHistory";

export function RunSummaryPanel({ run }: { run: RunSummary | null }) {
  if (!run) {
    return (
      <section className="panel summaryPanel">
        <h2>结果摘要</h2>
        <p className="muted">还没有选择 run。</p>
      </section>
    );
  }

  const metrics = run.metrics;
  return (
    <section className="panel summaryPanel">
      <div className="panelHeader">
        <div>
          <h2>{run.model}</h2>
          <p>{run.id}</p>
        </div>
        <RunStatusBadge status={run.status} />
      </div>

      <div className="metricGrid">
        <Metric label="字符/秒" value={metrics ? metrics.charsPerSecond.toFixed(1) : "-"} />
        <Metric label="首 token" value={formatMs(metrics?.firstTokenMs)} />
        <Metric label="总耗时" value={formatMs(metrics?.durationMs)} />
      </div>

      {run.error ? <pre className="errorText">{run.error}</pre> : null}
      {run.files.raw ? (
        <dl className="fileList">
          <div>
            <dt>raw</dt>
            <dd>{run.files.raw}</dd>
          </div>
          <div>
            <dt>summary</dt>
            <dd>{run.files.summary}</dd>
          </div>
        </dl>
      ) : null}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metricCard">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function formatMs(value: number | null | undefined) {
  return typeof value === "number" ? `${value.toFixed(1)}ms` : "-";
}
