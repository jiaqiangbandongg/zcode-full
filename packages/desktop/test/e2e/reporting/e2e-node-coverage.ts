/* eslint-disable max-lines -- Node coverage reporter 需在同一文件保持 V8 归一化、源码基线与 Istanbul 输出合同。 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createCoverageMap,
  type CoverageMapData,
} from "istanbul-lib-coverage";
import { createInstrumenter } from "istanbul-lib-instrument";
import { createContext } from "istanbul-lib-report";
import { create as createIstanbulReport } from "istanbul-reports";

export type E2ENodeCoverageDomain = "main" | "host" | "cli";

interface CoverageMetricSummary {
  covered: number;
  pct: number | string;
  skipped: number;
  total: number;
}

interface C8CoverageSummary {
  total?: {
    branches: CoverageMetricSummary;
    functions: CoverageMetricSummary;
    lines: CoverageMetricSummary;
    statements: CoverageMetricSummary;
  };
}

export interface E2ENodeCoverageDomainSummary {
  baselineFailureCount: number;
  complete: boolean;
  domain: E2ENodeCoverageDomain;
  expectedProcessCount?: number;
  files: {
    coverageFinalJson: string;
    coverageSummaryJson: string;
    htmlIndex: string;
    lcov: string;
    reportDir: string;
    sourceManifest: string;
  };
  rawFileCount: number;
  missingRawProcessCount: number;
  preEntryProcessCount?: number;
  sourceFileCount: number;
  totals?: C8CoverageSummary["total"];
}

export interface E2ENodeCoverageSummary {
  complete: boolean;
  domains: Record<E2ENodeCoverageDomain, E2ENodeCoverageDomainSummary>;
  enabled: boolean;
  generatedAt: string;
}

interface E2ENodeCoverageCollectorOptions {
  artifactDir: string;
  desktopDir: string;
  repoRoot: string;
}

interface SourceMapPayload {
  mappings?: string;
  names?: string[];
  sourceRoot?: string;
  sources?: string[];
  sourcesContent?: Array<string | null>;
  version?: number;
}

interface V8CoveragePayload {
  result?: Array<{ url?: string }>;
  "source-map-cache"?: Record<
    string,
    {
      data?: SourceMapPayload | null;
      lineLengths?: number[];
      url?: string | null;
    }
  >;
  "zcode-e2e-normalized-source-map-root"?: string;
}

const COVERAGE_ENABLED_VALUE = "1";
const DOMAINS: E2ENodeCoverageDomain[] = ["main", "host", "cli"];
const SOURCE_EXTENSIONS = [".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"];
const SOURCE_MAP_CACHE_INDEX_MARKER = ".zcode-source-map-cache-index-v2.marker";
const COMPACTED_FILE_INDEX_MARKER = ".zcode-compacted-coverage-files-v1.marker";

export function createE2ENodeCoverageCollector(
  options: E2ENodeCoverageCollectorOptions,
) {
  const enabled = process.env.ZCODE_E2E_COVERAGE === COVERAGE_ENABLED_VALUE;
  const coverageDir = resolve(options.artifactDir, "coverage");
  const rawRoot = resolve(coverageDir, "raw");
  const sourceMapRoots: Record<E2ENodeCoverageDomain, string> = {
    cli: resolve(options.repoRoot, "apps/zcode-cli/packages/cli/dist"),
    host: resolve(options.desktopDir, "out/host"),
    main: resolve(options.desktopDir, "out/main"),
  };

  function rawDir(domain: E2ENodeCoverageDomain) {
    return resolve(rawRoot, domain);
  }

  function prepare() {
    if (!enabled) return;
    for (const domain of DOMAINS) {
      mkdirSync(rawDir(domain), { recursive: true });
    }
  }

  function beforeSession() {
    if (!enabled) return;
    prepare();
    // Electron main 必须从进程启动时就继承 NODE_V8_COVERAGE；host 与 CLI
    // 会在各自 spawn 边界覆盖到独立目录，避免运行域数据混写。
    process.env.NODE_V8_COVERAGE = rawDir("main");
  }

  function compactRawCoverage() {
    if (!enabled) return;
    prepare();
    for (const domain of DOMAINS) {
      compactV8CoverageDirectory({
        rawDir: rawDir(domain),
        sourceMapRoot: sourceMapRoots[domain],
      });
    }
  }

  function finalize(): E2ENodeCoverageSummary | undefined {
    if (!enabled) return undefined;
    prepare();
    compactRawCoverage();
    const domains = Object.fromEntries(
      DOMAINS.map((domain) => [
        domain,
        writeDomainReport({
          artifactDir: options.artifactDir,
          domain,
          rawDir: rawDir(domain),
          reportDir: resolve(coverageDir, domain),
          repoRoot: options.repoRoot,
          sourceMapRoot: sourceMapRoots[domain],
        }),
      ]),
    ) as Record<E2ENodeCoverageDomain, E2ENodeCoverageDomainSummary>;
    return {
      complete: DOMAINS.every((domain) => domains[domain].complete),
      domains,
      enabled: true,
      generatedAt: new Date().toISOString(),
    };
  }

  return { beforeSession, compactRawCoverage, enabled, finalize, prepare };
}

export function compactV8CoverageDirectory(params: {
  rawDir: string;
  sourceMapRoot: string;
}) {
  mkdirSync(params.rawDir, { recursive: true });
  const normalizedSourceMapRoot = normalizePath(resolve(params.sourceMapRoot));
  const sourceMapCacheMarker = resolve(params.rawDir, SOURCE_MAP_CACHE_INDEX_MARKER);
  const compactedFileMarker = resolve(params.rawDir, COMPACTED_FILE_INDEX_MARKER);
  const retainedSourceMapUrls = readRetainedSourceMapUrls(sourceMapCacheMarker);
  const compactedFileNames = readMarkerLines(compactedFileMarker);
  let compactedFileIndexChanged = false;
  let compactedFileCount = 0;

  for (const rawPath of listFiles(params.rawDir, (path) => path.endsWith(".json"))) {
    const rawFileName = basename(rawPath);
    // Bug 根因：仅在 JSON payload 内记录 normalized 标记时，后续每个 worker 仍会重新
    // 读取并 parse 此前数千个大文件，全量 after-session 因此额外耗时约一小时。
    // V8 raw 文件名在同一 domain 内唯一且落盘后不可变，sidecar 可在文件 IO 前安全跳过。
    if (compactedFileNames.has(rawFileName)) continue;

    let payload: V8CoveragePayload;
    try {
      payload = JSON.parse(readFileSync(rawPath, "utf-8")) as V8CoveragePayload;
    } catch {
      continue;
    }
    if (payload["zcode-e2e-normalized-source-map-root"] === normalizedSourceMapRoot) {
      compactedFileNames.add(rawFileName);
      compactedFileIndexChanged = true;
      continue;
    }

    normalizeV8CoveragePayload(payload, params.sourceMapRoot, {
      excludeSourceMapUrls: retainedSourceMapUrls,
    });
    payload["zcode-e2e-normalized-source-map-root"] = normalizedSourceMapRoot;
    const retainedByThisFile = Object.keys(payload["source-map-cache"] ?? {});
    // Bug 根因：V8 会为每个短生命周期 Electron/Host/CLI 进程重复落整份 bundle
    // source map，全量（含 manual-review）在 finalize 前即可超过百 GB。进程退出后立即
    // 原地剪到当前运行域，并用原子替换避免中断时留下半份 JSON；每个 bundle 的 map
    // 只保留一份，后续首次出现的动态 chunk 仍会进入索引，避免覆盖率映射缺口。
    const temporaryPath = `${rawPath}.normalized-${process.pid}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(payload), "utf-8");
    renameSync(temporaryPath, rawPath);
    compactedFileNames.add(rawFileName);
    compactedFileIndexChanged = true;
    compactedFileCount += 1;
    if (retainedByThisFile.length > 0) {
      for (const url of retainedByThisFile) retainedSourceMapUrls.add(url);
      writeFileSync(
        sourceMapCacheMarker,
        `${[...retainedSourceMapUrls].sort().join("\n")}\n`,
        "utf-8",
      );
    }
  }
  if (compactedFileIndexChanged) {
    writeMarkerLines(compactedFileMarker, compactedFileNames);
  }

  return {
    compactedFileCount,
    sourceMapCacheRetained: retainedSourceMapUrls.size > 0,
  };
}

function readRetainedSourceMapUrls(markerPath: string) {
  return readMarkerLines(markerPath);
}

function readMarkerLines(markerPath: string) {
  if (!existsSync(markerPath)) return new Set<string>();
  return new Set(
    readFileSync(markerPath, "utf-8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

function writeMarkerLines(markerPath: string, values: Set<string>) {
  const temporaryPath = `${markerPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${[...values].sort().join("\n")}\n`, "utf-8");
  renameSync(temporaryPath, markerPath);
}

function writeDomainReport(params: {
  artifactDir: string;
  domain: E2ENodeCoverageDomain;
  rawDir: string;
  reportDir: string;
  repoRoot: string;
  sourceMapRoot: string;
}): E2ENodeCoverageDomainSummary {
  mkdirSync(params.reportDir, { recursive: true });
  const rawFileCount = listFiles(params.rawDir, (path) => path.endsWith(".json")).length;
  const rawProcessPids = collectRawProcessPids(params.rawDir);
  const readyProcessPids = collectReadyProcessPids(params.rawDir);
  const expectedProcessPids = collectExpectedProcessPids(
    params.artifactDir,
    params.domain,
  );
  const missingRawProcessCount = expectedProcessPids
    ? [...expectedProcessPids].filter(
        (pid) => readyProcessPids.has(pid) && !rawProcessPids.has(pid),
      ).length
    : 0;
  const preEntryProcessCount = expectedProcessPids
    ? [...expectedProcessPids].filter(
        (pid) => !readyProcessPids.has(pid) && !rawProcessPids.has(pid),
      ).length
    : 0;
  const sourceFiles = collectFirstPartySources(
    params.domain,
    params.sourceMapRoot,
    params.repoRoot,
  );
  const sourceManifest = resolve(params.reportDir, "source-manifest.json");
  writeFileSync(sourceManifest, `${JSON.stringify(sourceFiles, null, 2)}\n`, "utf-8");

  const coverageFinalJson = resolve(params.reportDir, "coverage-final.json");
  const coverageSummaryJson = resolve(params.reportDir, "coverage-summary.json");
  const lcov = resolve(params.reportDir, "lcov.info");
  const htmlIndex = resolve(params.reportDir, "index.html");
  let baselineFailureCount = 0;
  if (rawFileCount > 0 && sourceFiles.length > 0) {
    const normalizedRawDir = writeNormalizedV8Coverage({
      rawDir: params.rawDir,
      reportDir: params.reportDir,
      sourceMapRoot: params.sourceMapRoot,
    });
    const convertedCoveragePath = runC8Conversion({
      rawDir: normalizedRawDir,
      reportDir: params.reportDir,
      repoRoot: params.repoRoot,
    });
    baselineFailureCount = writeNodeIstanbulReports({
      convertedCoveragePath,
      reportDir: params.reportDir,
      repoRoot: params.repoRoot,
      sourceFiles,
    });
  }

  return {
    baselineFailureCount,
    complete:
      rawFileCount > 0 &&
      sourceFiles.length > 0 &&
      baselineFailureCount === 0 &&
      missingRawProcessCount === 0 &&
      existsSync(coverageSummaryJson),
    domain: params.domain,
    expectedProcessCount: expectedProcessPids?.size,
    files: {
      coverageFinalJson,
      coverageSummaryJson,
      htmlIndex,
      lcov,
      reportDir: params.reportDir,
      sourceManifest,
    },
    rawFileCount,
    missingRawProcessCount,
    preEntryProcessCount,
    sourceFileCount: sourceFiles.length,
    totals: readCoverageTotals(coverageSummaryJson),
  };
}

function collectRawProcessPids(rawDir: string) {
  const pids = new Set<number>();
  for (const path of listFiles(rawDir, (candidate) => candidate.endsWith(".json"))) {
    const match = /(?:^|[\\/])coverage-(\d+)-/u.exec(path);
    if (match?.[1]) pids.add(Number(match[1]));
  }
  return pids;
}

function collectReadyProcessPids(rawDir: string) {
  const pids = new Set<number>();
  for (const path of listFiles(rawDir, (candidate) => candidate.endsWith(".marker"))) {
    const match = /(?:^|[\\/])coverage-ready-(\d+)\.marker$/u.exec(path);
    if (match?.[1]) pids.add(Number(match[1]));
  }
  return pids;
}

function collectExpectedProcessPids(
  artifactDir: string,
  domain: E2ENodeCoverageDomain,
) {
  if (domain !== "cli") return undefined;
  const pids = new Set<number>();
  const runtimeLogsDir = resolve(artifactDir, "runtime-logs");
  for (const logPath of listFiles(runtimeLogsDir, (path) => path.endsWith(".log"))) {
    const content = readFileSync(logPath, "utf-8");
    for (const line of content.split("\n")) {
      if (!line.includes("ZCode agent process exited")) continue;
      const match = /"pid":(\d+),"runtimeIdentity"/u.exec(line);
      if (match?.[1]) pids.add(Number(match[1]));
    }
  }
  return pids.size > 0 ? pids : undefined;
}

function runC8Conversion(params: {
  rawDir: string;
  reportDir: string;
  repoRoot: string;
}) {
  const convertedDir = resolve(params.reportDir, "converted");
  const configPath = resolve(params.reportDir, "c8-convert-config.json");
  writeFileSync(
    configPath,
    `${JSON.stringify(createC8ConversionConfig(params.rawDir, convertedDir), null, 2)}\n`,
    "utf-8",
  );
  const reportEnv = { ...process.env };
  // 修复原因：reporter 自身若继续继承 NODE_V8_COVERAGE，会把 c8 进程的
  // coverage 写回待消费目录，既污染运行域数据，也可能让汇总时间持续增长。
  delete reportEnv.NODE_V8_COVERAGE;
  execFileSync(
    process.execPath,
    [resolve(params.repoRoot, "node_modules/c8/bin/c8.js"), "report", "--config", configPath],
    {
      cwd: params.repoRoot,
      env: reportEnv,
      stdio: "inherit",
    },
  );
  return resolve(convertedDir, "coverage-final.json");
}

export function createC8ConversionConfig(rawDir: string, convertedDir: string) {
  return {
    all: false,
    clean: false,
    "exclude-after-remap": false,
    // Bug 根因：c8 默认先把每个 Node 进程的 coverage 全部载入数组；全量 E2E 会在
    // 合并开始前耗尽堆。增量模式逐文件读取并合并，覆盖率计数语义保持一致。
    "merge-async": true,
    reporter: ["json"],
    "reports-dir": convertedDir,
    "temp-directory": rawDir,
  };
}

function writeNodeIstanbulReports(params: {
  convertedCoveragePath: string;
  reportDir: string;
  repoRoot: string;
  sourceFiles: string[];
}) {
  const sourceSet = new Set(params.sourceFiles.map((path) => normalizePath(resolve(path))));
  const converted = existsSync(params.convertedCoveragePath)
    ? (JSON.parse(readFileSync(params.convertedCoveragePath, "utf-8")) as CoverageMapData)
    : {};
  const coverageMap = createCoverageMap(converted);
  coverageMap.filter((path) => sourceSet.has(normalizePath(resolve(path))));

  const loadedPaths = new Set(
    coverageMap.files().map((path) => normalizePath(resolve(path))),
  );
  let baselineFailureCount = 0;
  for (const sourceFile of params.sourceFiles) {
    if (loadedPaths.has(normalizePath(resolve(sourceFile)))) continue;
    try {
      const instrumenter = createInstrumenter({
        coverageVariable: "__zcode_e2e_node_baseline__",
        parserPlugins: ["typescript", "jsx"],
        produceSourceMap: false,
      });
      instrumenter.instrumentSync(readFileSync(sourceFile, "utf-8"), sourceFile);
      const baseline = instrumenter.lastFileCoverage();
      if (baseline) coverageMap.addFileCoverage(baseline);
    } catch {
      baselineFailureCount += 1;
    }
  }

  const context = createContext({
    coverageMap,
    defaultSummarizer: "nested",
    dir: params.reportDir,
    sourceFinder(path) {
      return readFileSync(path, "utf-8");
    },
  });
  createIstanbulReport("json", { file: "coverage-final.json" }).execute(context);
  createIstanbulReport("json-summary", { file: "coverage-summary.json" }).execute(context);
  createIstanbulReport("lcovonly", {
    file: "lcov.info",
    projectRoot: params.repoRoot,
  }).execute(context);
  createIstanbulReport("html", {
    skipEmpty: false,
    subdir: ".",
    verbose: false,
  }).execute(context);
  return baselineFailureCount;
}

function collectFirstPartySources(
  domain: E2ENodeCoverageDomain,
  sourceMapRoot: string,
  repoRoot: string,
) {
  const sources = new Set<string>();
  for (const mapPath of listFiles(sourceMapRoot, (path) => path.endsWith(".map"))) {
    let payload: SourceMapPayload;
    try {
      payload = JSON.parse(readFileSync(mapPath, "utf-8")) as SourceMapPayload;
    } catch {
      continue;
    }
    for (const source of payload.sources ?? []) {
      const path = resolveSourceMapSource(mapPath, payload.sourceRoot, source);
      if (path && isFirstPartyRuntimeSource(domain, path, repoRoot)) {
        sources.add(path);
      }
    }
  }
  return [...sources].sort();
}

function resolveSourceMapSource(mapPath: string, sourceRoot: string | undefined, source: string) {
  if (!source || source.startsWith("node:") || source.startsWith("<")) return undefined;
  try {
    if (source.startsWith("file://")) return fileURLToPath(source);
    if (isAbsolute(source)) return resolve(source);
    return resolve(dirname(mapPath), sourceRoot ?? "", source);
  } catch {
    return undefined;
  }
}

function isFirstPartyRuntimeSource(
  domain: E2ENodeCoverageDomain,
  path: string,
  repoRoot: string,
) {
  const normalized = normalizePath(resolve(path));
  const root = `${normalizePath(resolve(repoRoot))}/`;
  if (!normalized.startsWith(root) || normalized.includes("/node_modules/")) return false;
  if (!SOURCE_EXTENSIONS.some((extension) => normalized.endsWith(extension))) return false;
  return !(
    (domain !== "cli" && normalized.includes("/dist/")) ||
    normalized.includes("/out/") ||
    normalized.includes("/test/") ||
    normalized.includes("/tests/") ||
    normalized.includes("/fixtures/") ||
    normalized.includes("/generated/") ||
    /(?:\.d\.ts|\.(?:spec|test)\.[cm]?[jt]sx?)$/u.test(normalized)
  );
}

function writeNormalizedV8Coverage(params: {
  rawDir: string;
  reportDir: string;
  sourceMapRoot: string;
}) {
  const normalizedDir = resolve(params.reportDir, "normalized-raw");
  mkdirSync(normalizedDir, { recursive: true });
  const sourceMapUrlsWritten = new Set<string>();
  for (const rawPath of listFiles(params.rawDir, (path) => path.endsWith(".json"))) {
    let payload: V8CoveragePayload;
    try {
      payload = JSON.parse(readFileSync(rawPath, "utf-8")) as V8CoveragePayload;
    } catch {
      continue;
    }
    normalizeV8CoveragePayload(payload, params.sourceMapRoot, {
      excludeSourceMapUrls: sourceMapUrlsWritten,
    });
    for (const url of Object.keys(payload["source-map-cache"] ?? {})) {
      sourceMapUrlsWritten.add(url);
    }
    writeFileSync(
      resolve(normalizedDir, rawPath.split(/[\\/]/u).at(-1) ?? "coverage.json"),
      JSON.stringify(payload),
      "utf-8",
    );
  }
  return normalizedDir;
}

export function normalizeV8CoveragePayload(
  payload: V8CoveragePayload,
  sourceMapRoot: string,
  options: {
    excludeSourceMapUrls?: ReadonlySet<string>;
    includeSourceMapCache?: boolean;
  } = {},
) {
  // Bug 根因：V8 文件还包含 Node 内置模块和整个三方依赖图。全量 E2E 的 CLI 原始
  // coverage 可达数十 GB；若把无关条目原样复制给 c8，会在 JSON.parse 阶段耗尽堆。
  // 报告最终只消费能映射回当前运行域 source map 的 bundle，因此在归一化边界提前剪枝。
  payload.result = (payload.result ?? []).filter((entry) => {
    const canonicalUrl = resolveCanonicalGeneratedUrl(entry.url, sourceMapRoot);
    if (!canonicalUrl) return false;
    entry.url = canonicalUrl;
    return true;
  });

  const sourceMapCache = payload["source-map-cache"];
  if (!sourceMapCache) return;
  if (options.includeSourceMapCache === false) {
    // 同一运行域的每份 V8 文件都内嵌同一份 bundle source map（CLI 单份约 38MB）。
    // c8 增量合并会在整个目录处理期间复用缓存，只需保留一份，不能重复上千次落盘。
    delete payload["source-map-cache"];
    return;
  }
  const normalizedCache: NonNullable<V8CoveragePayload["source-map-cache"]> = {};
  for (const [generatedUrl, cacheEntry] of Object.entries(sourceMapCache)) {
    const canonicalUrl = resolveCanonicalGeneratedUrl(generatedUrl, sourceMapRoot);
    if (!canonicalUrl) continue;
    if (options.excludeSourceMapUrls?.has(canonicalUrl)) continue;
    const mapPath = `${fileURLToPath(canonicalUrl)}.map`;
    const map = readSourceMap(mapPath);
    normalizedCache[canonicalUrl] = map
      ? {
          ...cacheEntry,
          data: {
            ...map,
            sources: (map.sources ?? []).map((source) => {
              const resolvedSource = resolveSourceMapSource(mapPath, map.sourceRoot, source);
              return resolvedSource ? pathToFileURL(resolvedSource).href : source;
            }),
            sourceRoot: undefined,
          },
        }
      : cacheEntry;
  }
  if (Object.keys(normalizedCache).length > 0) {
    payload["source-map-cache"] = normalizedCache;
  } else {
    delete payload["source-map-cache"];
  }
}

function resolveCanonicalGeneratedUrl(url: string | undefined, sourceMapRoot: string) {
  if (!url?.startsWith("file://")) return undefined;
  try {
    const generatedPath = fileURLToPath(url);
    const generatedName = generatedPath.split(/[\\/]/u).at(-1);
    if (!generatedName) return undefined;
    const canonicalRoot = resolve(sourceMapRoot);
    // 同名的 dependency/index.js 不能映射成 out/main/index.js。桌面 staging 目录会变化，
    // 但运行域末级目录仍稳定为 main/host；CLI 则直接从 canonical dist 启动。
    if (
      dirname(resolve(generatedPath)) !== canonicalRoot &&
      basename(dirname(generatedPath)) !== basename(canonicalRoot)
    ) {
      return undefined;
    }
    const canonicalPath = resolve(canonicalRoot, generatedName);
    if (!existsSync(canonicalPath) || !existsSync(`${canonicalPath}.map`)) return undefined;
    return pathToFileURL(canonicalPath).href;
  } catch {
    return undefined;
  }
}

function readSourceMap(path: string) {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as SourceMapPayload;
  } catch {
    return undefined;
  }
}

function listFiles(root: string, accept: (path: string) => boolean): string[] {
  if (!existsSync(root)) return [];
  const result: string[] = [];
  const visit = (path: string) => {
    if (statSync(path).isDirectory()) {
      for (const name of readdirSync(path)) visit(resolve(path, name));
      return;
    }
    if (accept(path)) result.push(path);
  };
  visit(root);
  return result.sort();
}

function readCoverageTotals(path: string) {
  if (!existsSync(path)) return undefined;
  try {
    return (JSON.parse(readFileSync(path, "utf-8")) as C8CoverageSummary).total;
  } catch {
    return undefined;
  }
}

function normalizePath(path: string) {
  return path.replaceAll("\\", "/");
}
