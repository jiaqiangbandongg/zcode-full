import type { RunSummary } from "@/shared/types";

export function Aggregates({ runs }: { runs: RunSummary[] }) {
  const groups = groupByModel(runs.filter((run) => run.status === "completed" && run.metrics));
  return (
    <section className="panel aggregatePanel">
      <div className="panelHeader">
        <div>
          <h2>模型聚合</h2>
          <p>按本地历史结果实时汇总</p>
        </div>
      </div>
      <div className="aggregateRows">
        {groups.map((group) => (
          <div className="aggregateRow" key={group.model}>
            <strong>{group.model}</strong>
            <span>{group.count} runs</span>
            <span>{group.avgCharsPerSecond.toFixed(1)} chars/s</span>
            <span>{group.avgFirstTokenMs.toFixed(1)}ms first token</span>
          </div>
        ))}
        {groups.length === 0 ? <p className="muted">暂无可聚合的完成结果。</p> : null}
      </div>
    </section>
  );
}

function groupByModel(runs: RunSummary[]) {
  const grouped = new Map<string, RunSummary[]>();
  for (const run of runs) {
    grouped.set(run.model, [...(grouped.get(run.model) ?? []), run]);
  }
  return [...grouped.entries()].map(([model, modelRuns]) => {
    const metrics = modelRuns.flatMap((run) => (run.metrics ? [run.metrics] : []));
    return {
      avgCharsPerSecond: average(metrics.map((metric) => metric.charsPerSecond)),
      avgFirstTokenMs: average(metrics.map((metric) => metric.firstTokenMs ?? 0)),
      count: modelRuns.length,
      model,
    };
  });
}

function average(values: number[]) {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}
