import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  CreateE2EReportViewerUrlOptions,
  E2EReportSummary,
} from "../shared/types.js";

export type {
  ContainerSampleSummary,
  CreateE2EReportViewerUrlOptions,
  E2EReportSummary,
  NumericStats,
  ProcessSampleSummary,
  TestResultSummary,
} from "../shared/types.js";

export const DEFAULT_E2E_REPORT_VIEWER_BASE_URL = "http://127.0.0.1:4173/";

export function readE2EReportSummary(summaryJsonPath: string) {
  return JSON.parse(
    readFileSync(summaryJsonPath, "utf-8"),
  ) as E2EReportSummary;
}

export function createE2EReportViewerUrl(
  options: CreateE2EReportViewerUrlOptions,
) {
  const baseUrl =
    options.baseUrl ??
    process.env.ZCODE_E2E_REPORT_VIEWER_BASE_URL ??
    DEFAULT_E2E_REPORT_VIEWER_BASE_URL;
  const url = new URL(baseUrl);
  url.searchParams.set("summary", toViteFsPath(options.summaryJsonPath));
  return url.toString();
}

function toViteFsPath(path: string) {
  const absolutePath = resolve(path).replace(/\\/gu, "/");
  return absolutePath.startsWith("/")
    ? `/@fs${absolutePath}`
    : `/@fs/${absolutePath}`;
}
