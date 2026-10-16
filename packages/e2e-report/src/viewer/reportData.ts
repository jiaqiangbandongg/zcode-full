import type { E2EReportSummary } from "../shared/types.js";

const DEFAULT_SUMMARY_URL = "./summary.json";

export async function loadReportSummary() {
  const summaryUrl = resolveSummaryUrl();
  const response = await fetch(summaryUrl);
  if (!response.ok) {
    throw new Error(`Failed to load summary.json: ${response.status}`);
  }
  return {
    summary: (await response.json()) as E2EReportSummary,
    summaryUrl: response.url || summaryUrl,
  };
}

function resolveSummaryUrl() {
  const summary = new URLSearchParams(window.location.search)
    .get("summary")
    ?.trim();
  return summary || DEFAULT_SUMMARY_URL;
}
