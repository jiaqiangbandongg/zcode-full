import type { ReactNode } from "react";
import type { UIRendererCoverageSummary } from "../shared/types.js";
import { formatNumber } from "./format.js";

export function CoveragePanel({
  coverage,
}: {
  coverage?: UIRendererCoverageSummary;
}) {
  if (!coverage) {
    return (
      <Panel title="Coverage" meta="disabled" wide>
        <p className="empty">本次运行没有启用 UI coverage。</p>
      </Panel>
    );
  }

  const sourceFiles = coverage.sourceFiles ?? [];
  const sourceFileRows = [...sourceFiles].sort(
    (left, right) =>
      left.lines.pct - right.lines.pct ||
      left.relativePath.localeCompare(right.relativePath),
  );
  const lineMetric = coverage.totals.lines;
  const meta = lineMetric
    ? `${formatCoverageMetric(lineMetric)} lines · ${sourceFiles.length} files`
    : `${coverage.totals.percent}% bundle bytes · ${coverage.rendererEntryCount} scripts`;

  return (
    <Panel title="UI Renderer Coverage" meta={meta} wide>
      <div className="coverageMetricGrid">
        <CoverageMetric label="Lines" total={coverage.totals.lines} />
        <CoverageMetric label="Statements" total={coverage.totals.statements} />
        <CoverageMetric label="Functions" total={coverage.totals.functions} />
        <CoverageMetric label="Branches" total={coverage.totals.branches} />
      </div>

      <dl className="coverageArtifacts">
        <div>
          <dt>Istanbul HTML</dt>
          <dd>
            <code>{coverage.files.htmlIndex ?? "n/a"}</code>
          </dd>
        </div>
        <div>
          <dt>LCOV</dt>
          <dd>
            <code>{coverage.files.lcov ?? "n/a"}</code>
          </dd>
        </div>
        <div>
          <dt>Coverage JSON</dt>
          <dd>
            <code>{coverage.files.coverageFinalJson ?? "n/a"}</code>
          </dd>
        </div>
      </dl>

      {sourceFileRows.length > 0 ? (
        <div className="tableWrap">
          <table>
            <thead>
              <tr>
                <th>Lines</th>
                <th>Statements</th>
                <th>Functions</th>
                <th>Branches</th>
                <th>Uncovered lines</th>
                <th>File</th>
              </tr>
            </thead>
            <tbody>
              {sourceFileRows.map((file) => (
                <tr key={file.path}>
                  <td>{formatCoverageMetric(file.lines)}</td>
                  <td>{formatCoverageMetric(file.statements)}</td>
                  <td>{formatCoverageMetric(file.functions)}</td>
                  <td>{formatCoverageMetric(file.branches)}</td>
                  <td>{formatUncoveredLines(file.uncoveredLines)}</td>
                  <td>
                    <code>{file.relativePath}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="tableWrap">
          <table>
            <thead>
              <tr>
                <th>Coverage</th>
                <th>Covered bytes</th>
                <th>Total bytes</th>
                <th>Script</th>
              </tr>
            </thead>
            <tbody>
              {coverage.scripts.map((script) => (
                <tr key={script.url}>
                  <td>{formatNumber(script.percent, "%")}</td>
                  <td>{script.coveredBytes}</td>
                  <td>{script.totalBytes}</td>
                  <td>
                    <code>{scriptName(script.url)}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function CoverageMetric({
  label,
  total,
}: {
  label: string;
  total?: {
    covered: number;
    pct: number;
    total: number;
  };
}) {
  return (
    <div className="coverageMetric">
      <span>{label}</span>
      <strong>{total ? formatNumber(total.pct, "%") : "n/a"}</strong>
      <small>{total ? `${total.covered}/${total.total}` : "not mapped"}</small>
    </div>
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

function formatCoverageMetric(
  total:
    | {
        covered: number;
        pct: number;
        total: number;
      }
    | undefined,
) {
  if (!total) {
    return "n/a";
  }
  return `${formatNumber(total.pct, "%")} (${total.covered}/${total.total})`;
}

function formatUncoveredLines(lines: number[]) {
  if (lines.length === 0) {
    return "-";
  }
  if (lines.length <= 12) {
    return lines.join(", ");
  }
  return `${lines.slice(0, 12).join(", ")} ... +${lines.length - 12}`;
}

function scriptName(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.pathname.split("/").at(-1) || url;
  } catch {
    return url;
  }
}
