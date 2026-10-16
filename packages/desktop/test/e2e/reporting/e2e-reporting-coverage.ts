import type { UIRendererCoverageSummary } from "./e2e-ui-coverage.js";

export function renderUICoverageMarkdownSection(
  coverage: UIRendererCoverageSummary,
) {
  const sourceFiles = coverage.sourceFiles ?? [];
  const lines = [
    "## Coverage",
    "",
    "### UI Renderer",
    "",
    `- Report kind: \`${coverage.reportKind ?? "bundle-byte"}\``,
    `- Pages: \`${coverage.pageCount}\``,
    `- Instrumented files: \`${coverage.rawEntryCount}\``,
    `- Source files: \`${coverage.sourceFileCount ?? sourceFiles.length}\``,
    `- Line coverage: \`${formatCoverageTotal(coverage.totals.lines)}\``,
    `- Statement coverage: \`${formatCoverageTotal(coverage.totals.statements)}\``,
    `- Function coverage: \`${formatCoverageTotal(coverage.totals.functions)}\``,
    `- Branch coverage: \`${formatCoverageTotal(coverage.totals.branches)}\``,
    ...(coverage.totals.totalBytes > 0
      ? [
          `- Bundle byte coverage: \`${coverage.totals.percent}% (${coverage.totals.coveredBytes}/${coverage.totals.totalBytes})\``,
          `- Renderer scripts: \`${coverage.rendererEntryCount}\``,
        ]
      : []),
    `- Istanbul HTML: \`${coverage.files.htmlIndex ?? "n/a"}\``,
    `- LCOV: \`${coverage.files.lcov ?? "n/a"}\``,
    `- Coverage JSON: \`${coverage.files.coverageFinalJson ?? "n/a"}\``,
    "",
  ];

  if (sourceFiles.length > 0) {
    lines.push(
      "| Lines | Statements | Functions | Branches | Uncovered lines | File |",
      "| ---: | ---: | ---: | ---: | --- | --- |",
      ...sourceFiles.map(
        (file) =>
          `| ${formatCoverageTotal(file.lines)} | ${formatCoverageTotal(file.statements)} | ${formatCoverageTotal(file.functions)} | ${formatCoverageTotal(file.branches)} | ${formatUncoveredLines(file.uncoveredLines)} | \`${escapeTableCell(file.relativePath)}\` |`,
      ),
      "",
    );
    return lines;
  }

  lines.push(
    "| Coverage | Covered bytes | Total bytes | Script |",
    "| ---: | ---: | ---: | --- |",
    ...coverage.scripts.map((script) => {
      const scriptName = script.url.split("/").at(-1) ?? script.url;
      return `| ${script.percent}% | ${script.coveredBytes} | ${script.totalBytes} | \`${escapeTableCell(scriptName)}\` |`;
    }),
    "",
  );
  return lines;
}

function formatCoverageTotal(
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
  return `${total.pct}% (${total.covered}/${total.total})`;
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

function escapeTableCell(value: string) {
  return value.replace(/\|/g, "\\|");
}
