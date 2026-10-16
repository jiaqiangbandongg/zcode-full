/* eslint-disable max-lines -- renderer coverage reporter 集中维护采集、跨 worker 合并和源码报告，避免 coverage map 合同分散。 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { relative, resolve } from "node:path";
import {
  createCoverageMap,
  type CoverageMap,
  type CoverageMapData,
  type CoverageSummaryData,
} from "istanbul-lib-coverage";
import { createContext } from "istanbul-lib-report";
import { create as createIstanbulReport } from "istanbul-reports";

interface PuppeteerBrowserLike {
  pages(): Promise<PuppeteerPageLike[]>;
}

interface PuppeteerPageLike {
  evaluate<T>(pageFunction: () => Promise<T> | T): Promise<T>;
  url(): string;
}

export interface ScriptCoverageSummary {
  coveredBytes: number;
  entryCount: number;
  percent: number;
  totalBytes: number;
  url: string;
}

export interface SourceFileCoverageSummary {
  branches: CoverageSummaryData["branches"];
  functions: CoverageSummaryData["functions"];
  lines: CoverageSummaryData["lines"];
  path: string;
  relativePath: string;
  statements: CoverageSummaryData["statements"];
  uncoveredLines: number[];
}

export interface UIRendererCoverageSummary {
  capturedAt: string;
  complete: boolean;
  enabled: boolean;
  files: {
    coverageFinalJson?: string;
    coverageSummaryJson?: string;
    htmlIndex?: string;
    lcov?: string;
    markdown: string;
    raw: string;
    rawDir: string;
    summaryJson: string;
  };
  pageCount: number;
  rawEntryCount: number;
  rawFileCount: number;
  reportKind: "istanbul-source";
  rendererEntryCount: number;
  scripts: ScriptCoverageSummary[];
  sourceFileCount: number;
  sourceFiles: SourceFileCoverageSummary[];
  totals: {
    branches?: CoverageSummaryData["branches"];
    coveredBytes: number;
    functions?: CoverageSummaryData["functions"];
    lines?: CoverageSummaryData["lines"];
    percent: number;
    statements?: CoverageSummaryData["statements"];
    totalBytes: number;
  };
}

interface UIRendererRawCoverage {
  capturedAt: string;
  coverage: CoverageMapData;
  pageUrls: string[];
}

interface E2EUICoverageCollectorOptions {
  artifactDir: string;
  repoRoot: string;
}

const COVERAGE_ENV_VALUE = "1";
const RENDERER_BASELINE_RELATIVE_PATH =
  "packages/desktop/out/renderer/e2e-coverage-baseline.json";

export function createE2EUICoverageCollector(
  options: E2EUICoverageCollectorOptions,
) {
  const enabled = process.env.ZCODE_E2E_COVERAGE === COVERAGE_ENV_VALUE;
  const coverageDir = resolve(options.artifactDir, "coverage");
  const rawDir = resolve(coverageDir, "raw", "renderer");
  const htmlDir = resolve(coverageDir, "ui-renderer-html");
  const htmlIndexPath = resolve(htmlDir, "index.html");
  const lcovPath = resolve(coverageDir, "lcov.info");
  const coverageFinalJsonPath = resolve(coverageDir, "coverage-final.json");
  const coverageSummaryJsonPath = resolve(coverageDir, "coverage-summary.json");
  const rawPath = resolve(coverageDir, "ui-renderer-istanbul-raw.json");
  const summaryJsonPath = resolve(coverageDir, "ui-renderer-summary.json");
  const summaryMdPath = resolve(coverageDir, "ui-renderer-summary.md");
  const baselinePath = resolve(options.repoRoot, RENDERER_BASELINE_RELATIVE_PATH);
  let activeBrowser: WebdriverIO.Browser | null = null;
  let started = false;

  function ensureCoverageDir() {
    mkdirSync(coverageDir, { recursive: true });
    mkdirSync(rawDir, { recursive: true });
  }

  function writeJson(path: string, value: unknown) {
    ensureCoverageDir();
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  }

  return {
    enabled,

    prepare() {
      if (!enabled) {
        return;
      }
      ensureCoverageDir();
    },

    start(sessionBrowser: WebdriverIO.Browser) {
      if (!enabled || started) {
        return;
      }
      activeBrowser = sessionBrowser;
      started = true;
    },

    async snapshot() {
      if (!enabled || !started || !activeBrowser) {
        return;
      }

      const { coverageMap, pageUrls } = await collectInstrumentedCoverage(
        activeBrowser,
        options.repoRoot,
      );
      const workerId = sanitizeCoverageFilePart(
        process.env.ZCODE_E2E_WORKER_ID ?? "worker",
      );
      const workerRawPath = resolve(rawDir, `${workerId}-${process.pid}.json`);
      const mergedCoverage = createCoverageMap({});
      const mergedPageUrls = new Set(pageUrls);
      if (existsSync(workerRawPath)) {
        const previous = JSON.parse(
          readFileSync(workerRawPath, "utf-8"),
        ) as UIRendererRawCoverage;
        mergedCoverage.merge(previous.coverage);
        for (const pageUrl of previous.pageUrls) mergedPageUrls.add(pageUrl);
      }
      mergedCoverage.merge(coverageMap.toJSON());
      writeJson(workerRawPath, {
        capturedAt: new Date().toISOString(),
        coverage: mergedCoverage.toJSON(),
        pageUrls: [...mergedPageUrls].sort(),
      } satisfies UIRendererRawCoverage);
    },

    async stop() {
      if (!enabled || !started || !activeBrowser) {
        return;
      }
      try {
        await this.snapshot();
      } finally {
        // Bug 原因：会主动退出 Electron 的 E2E 会让最后一次 CDP snapshot 抛错。
        // 若异常路径不复位，after hook 会再次访问同一断链并把已通过用例判成生命周期失败。
        activeBrowser = null;
        started = false;
      }
    },

    finalize() {
      if (!enabled) {
        return undefined;
      }
      ensureCoverageDir();
      const coverageMap = createCoverageMap({});
      if (existsSync(baselinePath)) {
        coverageMap.merge(
          JSON.parse(readFileSync(baselinePath, "utf-8")) as CoverageMapData,
        );
      }

      const rawFiles = readdirSync(rawDir)
        .filter((name) => name.endsWith(".json"))
        .sort();
      const pageUrls = new Set<string>();
      for (const rawFile of rawFiles) {
        const raw = JSON.parse(
          readFileSync(resolve(rawDir, rawFile), "utf-8"),
        ) as UIRendererRawCoverage;
        coverageMap.merge(raw.coverage);
        for (const pageUrl of raw.pageUrls) {
          pageUrls.add(pageUrl);
        }
      }
      coverageMap.filter((filePath) =>
        isFirstPartyUISource(filePath, options.repoRoot),
      );
      writeJson(rawPath, {
        capturedAt: new Date().toISOString(),
        coverage: coverageMap.toJSON(),
        pageUrls: [...pageUrls].sort(),
      } satisfies UIRendererRawCoverage);

      const summary = buildRendererCoverageSummary({
        complete: rawFiles.length > 0 && existsSync(baselinePath),
        coverageFinalJsonPath,
        coverageMap,
        coverageSummaryJsonPath,
        htmlIndexPath,
        lcovPath,
        pageCount: pageUrls.size,
        rawDir,
        rawFileCount: rawFiles.length,
        rawPath,
        repoRoot: options.repoRoot,
        summaryJsonPath,
        summaryMdPath,
      });

      if (coverageMap.files().length > 0) {
        writeIstanbulReports(coverageMap, {
          coverageDir,
          repoRoot: options.repoRoot,
        });
      }
      writeJson(summaryJsonPath, summary);
      writeFileSync(summaryMdPath, renderCoverageMarkdown(summary), "utf-8");
      return summary;
    },
  };
}

async function getPuppeteerBrowser(sessionBrowser: WebdriverIO.Browser) {
  const candidate = sessionBrowser as WebdriverIO.Browser & {
    getPuppeteer?: () => Promise<PuppeteerBrowserLike>;
  };
  if (!candidate.getPuppeteer) {
    throw new Error("browser.getPuppeteer() is not available for UI coverage");
  }
  return candidate.getPuppeteer();
}

async function collectInstrumentedCoverage(
  sessionBrowser: WebdriverIO.Browser,
  repoRoot: string,
) {
  const puppeteer = await getPuppeteerBrowser(sessionBrowser);
  const pages = (await puppeteer.pages()).filter((page) =>
    isRendererPageUrl(page.url()),
  );
  const coverageMap = createCoverageMap({});

  for (const page of pages) {
    const pageCoverage = await page.evaluate(() => {
      const coverage = (
        globalThis as typeof globalThis & { __coverage__?: unknown }
      ).__coverage__;
      return coverage ? JSON.parse(JSON.stringify(coverage)) : null;
    });
    if (pageCoverage && typeof pageCoverage === "object") {
      coverageMap.merge(pageCoverage as CoverageMapData);
    }
  }

  coverageMap.filter((filePath) => isFirstPartyUISource(filePath, repoRoot));
  return {
    coverageMap,
    pageUrls: pages.map((page) => page.url()),
  };
}

function writeIstanbulReports(
  coverageMap: CoverageMap,
  options: {
    coverageDir: string;
    repoRoot: string;
  },
) {
  const context = createContext({
    coverageMap,
    defaultSummarizer: "nested",
    dir: options.coverageDir,
    sourceFinder(filepath) {
      const sourcePath = stripQuery(filepath);
      const absolutePath = sourcePath.startsWith("/")
        ? sourcePath
        : resolve(options.repoRoot, sourcePath);
      return readFileSync(absolutePath, "utf-8");
    },
  });
  createIstanbulReport("html", {
    skipEmpty: false,
    subdir: "ui-renderer-html",
    verbose: false,
  }).execute(context);
  createIstanbulReport("lcovonly", {
    file: "lcov.info",
    projectRoot: options.repoRoot,
  }).execute(context);
  createIstanbulReport("json", {
    file: "coverage-final.json",
  }).execute(context);
  createIstanbulReport("json-summary", {
    file: "coverage-summary.json",
  }).execute(context);
}

function buildRendererCoverageSummary(params: {
  complete: boolean;
  coverageFinalJsonPath: string;
  coverageMap: CoverageMap;
  coverageSummaryJsonPath: string;
  htmlIndexPath: string;
  lcovPath: string;
  pageCount: number;
  rawDir: string;
  rawFileCount: number;
  rawPath: string;
  repoRoot: string;
  summaryJsonPath: string;
  summaryMdPath: string;
}): UIRendererCoverageSummary {
  const coverageTotals = params.coverageMap.files().length
    ? params.coverageMap.getCoverageSummary().toJSON()
    : undefined;
  const sourceFiles = params.coverageMap
    .files()
    .sort()
    .map((filePath) => {
      const fileCoverage = params.coverageMap.fileCoverageFor(filePath);
      const summary = fileCoverage.toSummary().toJSON();
      return {
        branches: summary.branches,
        functions: summary.functions,
        lines: summary.lines,
        path: filePath,
        relativePath: relative(params.repoRoot, stripQuery(filePath)),
        statements: summary.statements,
        uncoveredLines: fileCoverage.getUncoveredLines(),
      } satisfies SourceFileCoverageSummary;
    });

  return {
    capturedAt: new Date().toISOString(),
    complete: params.complete,
    enabled: true,
    files: {
      coverageFinalJson: coverageTotals ? params.coverageFinalJsonPath : undefined,
      coverageSummaryJson: coverageTotals
        ? params.coverageSummaryJsonPath
        : undefined,
      htmlIndex: coverageTotals ? params.htmlIndexPath : undefined,
      lcov: coverageTotals ? params.lcovPath : undefined,
      markdown: params.summaryMdPath,
      raw: params.rawPath,
      rawDir: params.rawDir,
      summaryJson: params.summaryJsonPath,
    },
    pageCount: params.pageCount,
    rawEntryCount: sourceFiles.length,
    rawFileCount: params.rawFileCount,
    reportKind: "istanbul-source",
    rendererEntryCount: 0,
    scripts: [],
    sourceFileCount: sourceFiles.length,
    sourceFiles,
    totals: {
      branches: coverageTotals?.branches,
      coveredBytes: 0,
      functions: coverageTotals?.functions,
      lines: coverageTotals?.lines,
      percent: coverageTotals?.lines.pct ?? 0,
      statements: coverageTotals?.statements,
      totalBytes: 0,
    },
  };
}

function renderCoverageMarkdown(summary: UIRendererCoverageSummary) {
  const lines = [
    "# UI Renderer Coverage",
    "",
    `- Enabled: \`${summary.enabled ? "yes" : "no"}\``,
    `- Complete: \`${summary.complete ? "yes" : "no"}\``,
    `- Report kind: \`${summary.reportKind}\``,
    `- Pages: \`${summary.pageCount}\``,
    `- Instrumented files: \`${summary.rawEntryCount}\``,
    `- Worker raw files: \`${summary.rawFileCount}\``,
    `- Source files: \`${summary.sourceFileCount}\``,
    `- Line coverage: \`${formatTotal(summary.totals.lines)}\``,
    `- Statement coverage: \`${formatTotal(summary.totals.statements)}\``,
    `- Function coverage: \`${formatTotal(summary.totals.functions)}\``,
    `- Branch coverage: \`${formatTotal(summary.totals.branches)}\``,
    `- HTML report: \`${summary.files.htmlIndex ?? "n/a"}\``,
    `- LCOV: \`${summary.files.lcov ?? "n/a"}\``,
    "",
    "## Source Files",
    "",
    "| Lines | Statements | Functions | Branches | Uncovered lines | File |",
    "| ---: | ---: | ---: | ---: | --- | --- |",
    ...summary.sourceFiles.map(
      (file) =>
        `| ${formatTotal(file.lines)} | ${formatTotal(file.statements)} | ${formatTotal(file.functions)} | ${formatTotal(file.branches)} | ${formatUncoveredLines(file.uncoveredLines)} | \`${file.relativePath}\` |`,
    ),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function isRendererPageUrl(url: string) {
  try {
    const parsed = new URL(url);
    return (
      parsed.pathname.endsWith("/renderer/index.html")
    );
  } catch {
    return false;
  }
}

function isFirstPartyUISource(path: string, repoRoot: string) {
  const normalized = stripQuery(path).replaceAll("\\", "/");
  const sourcePath = normalized.startsWith("/")
    ? normalized
    : resolve(repoRoot, normalized).replaceAll("\\", "/");
  return (
    isCoverageSourceFile(sourcePath) &&
    !sourcePath.includes("/node_modules/") &&
    (sourcePath.startsWith(
      resolve(repoRoot, "packages/ui/src").replaceAll("\\", "/"),
    ) ||
      sourcePath.startsWith(
        resolve(repoRoot, "packages/desktop/src/renderer").replaceAll("\\", "/"),
      ))
  );
}

function isCoverageSourceFile(path: string) {
  return /\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/u.test(path);
}

function stripQuery(path: string) {
  return path.split("?")[0] ?? path;
}

function sanitizeCoverageFilePart(value: string) {
  return value.replace(/[^a-zA-Z0-9_.-]+/gu, "-").replace(/^-+|-+$/gu, "") || "worker";
}

function formatTotal(total: CoverageSummaryData["lines"] | undefined) {
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
