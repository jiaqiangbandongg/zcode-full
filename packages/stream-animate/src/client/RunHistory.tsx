import type { RunSummary } from "@/shared/types";

export function RunHistory(props: {
  runs: RunSummary[];
  selectedRunId: string | null;
  onSelect: (runId: string) => void;
}) {
  return (
    <section className="panel historyPanel">
      <div className="panelHeader">
        <div>
          <h2>历史结果</h2>
          <p>{props.runs.length} runs</p>
        </div>
      </div>
      <div className="historyList">
        {props.runs.map((run) => (
          <button
            className={run.id === props.selectedRunId ? "historyItem active" : "historyItem"}
            key={run.id}
            type="button"
            onClick={() => props.onSelect(run.id)}
          >
            <span>
              <strong>{run.model}</strong>
              <small>{formatDate(run.createdAt)}</small>
            </span>
            <RunStatusBadge status={run.status} />
          </button>
        ))}
      </div>
    </section>
  );
}

export function RunStatusBadge({ status }: { status: RunSummary["status"] }) {
  return <em className={`statusBadge ${status}`}>{status}</em>;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
  }).format(new Date(value));
}
