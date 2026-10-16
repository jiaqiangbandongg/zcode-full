import { useEffect, useMemo, useState } from "react";
import type { AppConfig, RunSummary } from "@/shared/types";
import { Aggregates } from "@/client/Aggregates";
import {
  DEFAULT_FORM,
  createRun,
  fetchConfig,
  fetchRawLines,
  fetchRun,
  fetchRuns,
  type RunFormState,
} from "@/client/api";
import { FrameCharts } from "@/client/FrameChart";
import { RunForm } from "@/client/RunForm";
import { RunHistory } from "@/client/RunHistory";
import { RunSummaryPanel } from "@/client/RunSummaryPanel";

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [form, setForm] = useState<RunFormState>(DEFAULT_FORM);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<RunSummary | null>(null);
  const [rawLines, setRawLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const hasRunningRun = useMemo(() => runs.some((run) => run.status === "running"), [runs]);

  useEffect(() => {
    void Promise.all([fetchConfig(), fetchRuns()])
      .then(([nextConfig, nextRuns]) => {
        setConfig(nextConfig);
        setRuns(nextRuns);
        setSelectedRunId(nextRuns[0]?.id ?? null);
      })
      .catch((loadError: unknown) => setError(toErrorMessage(loadError)));
  }, []);

  useEffect(() => {
    if (!selectedRunId) {
      setSelectedRun(null);
      setRawLines([]);
      return;
    }
    void refreshSelectedRun(selectedRunId);
  }, [selectedRunId]);

  useEffect(() => {
    if (!hasRunningRun) {
      return;
    }
    const timer = window.setInterval(() => {
      void refreshRuns();
      if (selectedRunId) {
        void refreshSelectedRun(selectedRunId);
      }
    }, 350);
    return () => window.clearInterval(timer);
  }, [hasRunningRun, selectedRunId]);

  const startRun = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const run = await createRun(form);
      setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]);
      setSelectedRunId(run.id);
    } catch (submitError) {
      setError(toErrorMessage(submitError));
    } finally {
      setSubmitting(false);
    }
  };

  const refreshRuns = async () => {
    const nextRuns = await fetchRuns();
    setRuns(nextRuns);
  };

  const refreshSelectedRun = async (runId: string) => {
    const [run, lines] = await Promise.all([
      fetchRun(runId),
      fetchRawLines(runId).catch(() => []),
    ]);
    setSelectedRun(run);
    setRawLines(lines);
    setRuns((current) => current.map((item) => (item.id === run.id ? run : item)));
  };

  return (
    <main className="appShell">
      <header className="hero">
        <div>
          <p className="eyebrow">SSE frame profiler</p>
          <h1>Stream Animate</h1>
        </div>
        <button className="ghostButton" type="button" onClick={() => void refreshRuns()}>
          刷新
        </button>
      </header>

      {error ? <div className="errorBanner">{error}</div> : null}

      <div className="layout">
        <aside className="sidebar">
          <RunForm
            config={config}
            disabled={submitting}
            form={form}
            onChange={setForm}
            onSubmit={startRun}
          />
          <RunHistory runs={runs} selectedRunId={selectedRunId} onSelect={setSelectedRunId} />
        </aside>

        <section className="mainColumn">
          <RunSummaryPanel run={selectedRun} />
          <FrameCharts run={selectedRun} />
          <Aggregates runs={runs} />
          <RawPanel lines={rawLines} />
        </section>
      </div>
    </main>
  );
}

function RawPanel({ lines }: { lines: string[] }) {
  return (
    <section className="panel rawPanel">
      <div className="panelHeader">
        <div>
          <h2>Raw NDJSON</h2>
          <p>最近 {lines.length} 行</p>
        </div>
      </div>
      <pre>{lines.join("\n") || "暂无原始数据"}</pre>
    </section>
  );
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
