/* eslint-disable max-lines -- 自包含热度图需要同时保留 coverage 聚合合同和离线报告模板。 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

export type CoverageHeatmapDomain = "renderer" | "main" | "host" | "cli";

interface IstanbulFunctionLocation {
  start?: {
    line?: number;
  };
}

interface IstanbulFunctionMapEntry {
  decl?: IstanbulFunctionLocation;
  loc?: IstanbulFunctionLocation;
  name?: string;
}

interface IstanbulFileCoverage {
  f?: Record<string, number>;
  fnMap?: Record<string, IstanbulFunctionMapEntry>;
  path?: string;
}

interface CoverageHeatmapFunction {
  hits: number;
  line?: number;
  name: string;
  path: string;
}

export interface CoverageHeatmapFile {
  coveredFunctions: number;
  functionHits: number;
  functions: number;
  hottestFunction?: CoverageHeatmapFunction;
  path: string;
}

export interface CoverageHeatmapDomainData {
  coveredFunctions: number;
  domain: CoverageHeatmapDomain;
  files: CoverageHeatmapFile[];
  functionHits: number;
  functions: number;
}

export interface CoverageHeatmapData {
  domains: CoverageHeatmapDomainData[];
  generatedAt: string;
  scale: "log1p";
}

export interface CoverageHeatmapSummary {
  dataJson: string;
  domainCount: number;
  fileCount: number;
  htmlIndex: string;
}

interface WriteCoverageHeatmapOptions {
  coverageDir: string;
  repoRoot: string;
}

const DOMAIN_COVERAGE_PATHS: Record<CoverageHeatmapDomain, string[]> = {
  renderer: ["coverage-final.json"],
  main: ["main", "coverage-final.json"],
  host: ["host", "coverage-final.json"],
  cli: ["cli", "coverage-final.json"],
};

const DOMAIN_ORDER = Object.keys(
  DOMAIN_COVERAGE_PATHS,
) as CoverageHeatmapDomain[];

export function writeE2ECoverageHeatmap(
  options: WriteCoverageHeatmapOptions,
): CoverageHeatmapSummary | undefined {
  const data = buildCoverageHeatmapData(options);
  if (data.domains.length === 0) return undefined;

  const reportDir = resolve(options.coverageDir, "heatmap");
  const dataJson = resolve(reportDir, "data.json");
  const htmlIndex = resolve(reportDir, "index.html");
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(dataJson, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
  writeFileSync(htmlIndex, renderCoverageHeatmapHtml(data), "utf-8");

  return {
    dataJson,
    domainCount: data.domains.length,
    fileCount: data.domains.reduce(
      (total, domain) => total + domain.files.length,
      0,
    ),
    htmlIndex,
  };
}

export function buildCoverageHeatmapData(
  options: WriteCoverageHeatmapOptions,
): CoverageHeatmapData {
  const domains = DOMAIN_ORDER.flatMap((domain) => {
    const coveragePath = resolve(
      options.coverageDir,
      ...DOMAIN_COVERAGE_PATHS[domain],
    );
    if (!existsSync(coveragePath)) return [];
    const coverage = readCoverageFile(coveragePath);
    if (!coverage) return [];
    return [buildDomainData(domain, coverage, options.repoRoot)];
  });

  return {
    domains,
    generatedAt: new Date().toISOString(),
    scale: "log1p",
  };
}

function readCoverageFile(path: string) {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<
      string,
      IstanbulFileCoverage
    >;
  } catch {
    return undefined;
  }
}

function buildDomainData(
  domain: CoverageHeatmapDomain,
  coverage: Record<string, IstanbulFileCoverage>,
  repoRoot: string,
): CoverageHeatmapDomainData {
  const files = Object.entries(coverage)
    .map(([coveragePath, fileCoverage]) =>
      buildFileData(coveragePath, fileCoverage, repoRoot),
    )
    .sort((left, right) => left.path.localeCompare(right.path));
  return {
    coveredFunctions: files.reduce(
      (total, file) => total + file.coveredFunctions,
      0,
    ),
    domain,
    files,
    functionHits: files.reduce((total, file) => total + file.functionHits, 0),
    functions: files.reduce((total, file) => total + file.functions, 0),
  };
}

function buildFileData(
  coveragePath: string,
  fileCoverage: IstanbulFileCoverage,
  repoRoot: string,
): CoverageHeatmapFile {
  const counters = fileCoverage.f ?? {};
  const functionMap = fileCoverage.fnMap ?? {};
  const normalizedPath = normalizeCoveragePath(
    fileCoverage.path ?? coveragePath,
    repoRoot,
  );
  const functionHits = Object.values(counters).reduce(
    (total, hits) => total + normalizeHits(hits),
    0,
  );
  const hottestEntry = Object.entries(counters).reduce<
    [string, number] | undefined
  >((hottest, entry) => {
    const normalized: [string, number] = [entry[0], normalizeHits(entry[1])];
    return !hottest || normalized[1] > hottest[1] ? normalized : hottest;
  }, undefined);
  const hottestFunction =
    hottestEntry && hottestEntry[1] > 0
      ? buildHottestFunction(
          hottestEntry,
          functionMap[hottestEntry[0]],
          normalizedPath,
        )
      : undefined;

  return {
    coveredFunctions: Object.values(counters).filter((hits) => hits > 0).length,
    functionHits,
    functions: Object.keys(counters).length,
    hottestFunction,
    path: normalizedPath,
  };
}

function buildHottestFunction(
  entry: [string, number],
  metadata: IstanbulFunctionMapEntry | undefined,
  path: string,
): CoverageHeatmapFunction {
  return {
    hits: entry[1],
    line: metadata?.loc?.start?.line ?? metadata?.decl?.start?.line,
    name: metadata?.name?.trim() || `(anonymous ${entry[0]})`,
    path,
  };
}

function normalizeHits(value: number) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function normalizeCoveragePath(path: string, repoRoot: string) {
  const normalizedPath = path.split("?")[0]?.replaceAll("\\", "/") ?? path;
  const normalizedRoot = resolve(repoRoot).replaceAll("\\", "/");
  const relativePath = normalizedPath.startsWith(`${normalizedRoot}/`)
    ? relative(normalizedRoot, normalizedPath)
    : normalizedPath.replace(/^\.\//u, "");
  return relativePath.replaceAll("\\", "/");
}

function renderCoverageHeatmapHtml(data: CoverageHeatmapData) {
  const inlineData = JSON.stringify(data)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Desktop E2E 函数执行热度图</title>
  <style>
    :root {
      color-scheme: light dark;
      --background: #f7f8fa;
      --foreground: #1b1f24;
      --muted: #656d76;
      --panel: #ffffff;
      --border: #d0d7de;
      --tile-zero: #e8ebef;
      --tile-low: #fff0c2;
      --tile-high: #ff8a00;
      --tile-hot-text: #211400;
      --focus: #0969da;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --background: #0d1117;
        --foreground: #e6edf3;
        --muted: #8b949e;
        --panel: #161b22;
        --border: #30363d;
        --tile-zero: #171b22;
        --tile-low: #3a2500;
        --tile-high: #ffd43b;
        --tile-hot-text: #17120a;
        --focus: #58a6ff;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--background);
      color: var(--foreground);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main { max-width: 1480px; margin: 0 auto; padding: 24px; }
    h1 { margin: 0 0 6px; font-size: 24px; font-weight: 600; }
    .subtitle { margin: 0 0 20px; color: var(--muted); }
    .toolbar, .domain-tabs, .legend, .summary {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
    }
    .toolbar { justify-content: space-between; margin-bottom: 14px; }
    button, select {
      border: 1px solid var(--border);
      border-radius: 7px;
      background: var(--panel);
      color: var(--foreground);
      font: inherit;
    }
    button { padding: 7px 11px; cursor: pointer; }
    button:hover { border-color: var(--focus); }
    button:focus-visible, select:focus-visible {
      outline: 2px solid var(--focus);
      outline-offset: 2px;
    }
    .domain-tab[aria-pressed="true"] {
      border-color: var(--focus);
      background: var(--focus);
      color: #ffffff;
    }
    label { color: var(--muted); }
    select { margin-left: 6px; padding: 7px 28px 7px 9px; }
    .heat-grid {
      display: grid;
      gap: 2px;
      width: 100%;
      height: min(68vh, 720px);
      min-height: 480px;
      overflow: hidden;
      padding: 2px;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: var(--border);
    }
    .heat-tile {
      width: 100%;
      height: 100%;
      min-width: 0;
      min-height: 0;
      overflow: hidden;
      border: 0;
      border-radius: 3px;
      padding: 2px;
      text-align: left;
      transition: filter 120ms ease, transform 120ms ease;
    }
    .heat-tile:hover, .heat-tile:focus-visible { z-index: 2; filter: brightness(1.08); }
    .heat-tile:focus-visible { outline-offset: -3px; }
    .heat-tile[aria-pressed="true"] { box-shadow: inset 0 0 0 3px var(--focus); z-index: 3; }
    .tile-name, .tile-meta { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tile-name { font-weight: 600; }
    .tile-meta { margin-top: 4px; font-size: 12px; opacity: 0.82; }
    .summary {
      min-height: 58px;
      margin-top: 12px;
      padding: 10px 12px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--panel);
    }
    .summary strong { overflow-wrap: anywhere; }
    .summary span { color: var(--muted); }
    .legend { justify-content: flex-end; margin-top: 10px; color: var(--muted); font-size: 13px; }
    .legend-swatch { width: 28px; height: 12px; border-radius: 3px; }
    .legend-zero { background: var(--tile-zero); }
    .legend-low { background: var(--tile-low); }
    .legend-high { background: var(--tile-high); }
    .empty { display: grid; place-items: center; height: 100%; color: var(--muted); }
    @media (max-width: 640px) {
      main { padding: 14px; }
      .toolbar { align-items: flex-start; flex-direction: column; }
      .heat-grid { height: 520px; min-height: 420px; }
      .tile-meta { display: none; }
    }
    @media (prefers-reduced-motion: reduce) {
      .heat-tile { transition: none; }
    }
  </style>
</head>
<body>
  <main>
    <h1>Desktop E2E 函数执行热度图</h1>
    <p class="subtitle">每个等大 tile 代表一个源码文件；越亮表示执行越频繁。</p>
    <div class="toolbar">
      <div id="domain-tabs" class="domain-tabs" aria-label="运行域"></div>
      <label>亮度指标
        <select id="metric-select">
          <option value="total">函数总命中</option>
          <option value="average">每函数平均命中</option>
        </select>
      </label>
    </div>
    <div id="heat-grid" class="heat-grid" role="group" aria-label="等面积文件执行热度图"></div>
    <div id="summary" class="summary" aria-live="polite"></div>
    <div class="legend" aria-label="颜色图例">
      <span>0</span><span class="legend-swatch legend-zero"></span>
      <span>低</span><span class="legend-swatch legend-low"></span>
      <span>高</span><span class="legend-swatch legend-high"></span>
      <span>对数刻度，当前运行域全局归一化</span>
    </div>
  </main>
  <script id="coverage-heatmap-data" type="application/json">${inlineData}</script>
  <script>
    (() => {
      const report = JSON.parse(document.getElementById("coverage-heatmap-data").textContent);
      const domainTabs = document.getElementById("domain-tabs");
      const metricSelect = document.getElementById("metric-select");
      const heatGrid = document.getElementById("heat-grid");
      const summary = document.getElementById("summary");
      const number = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 });
      let domain = report.domains[0];
      let selected = null;

      function buildItems() {
        return domain.files
          .map((file) => ({
            ...file,
            kind: "file",
            name: file.path.split("/").at(-1) || file.path,
          }))
          .sort((left, right) => left.path.localeCompare(right.path));
      }

      function domainNode() {
        const hottestFunction = domain.files.reduce(
          (hottest, file) => !hottest || (file.hottestFunction && file.hottestFunction.hits > hottest.hits)
            ? file.hottestFunction
            : hottest,
          undefined,
        );
        return {
          coveredFunctions: domain.coveredFunctions,
          functionHits: domain.functionHits,
          functions: domain.functions,
          hottestFunction,
          kind: "domain",
          name: domain.domain,
          path: domain.domain,
        };
      }

      function metricValue(node) {
        return metricSelect.value === "average"
          ? node.functionHits / Math.max(1, node.functions)
          : node.functionHits;
      }

      function formatPercent(node) {
        if (!node.functions) return "0%";
        return number.format((node.coveredFunctions / node.functions) * 100) + "%";
      }

      function describe(node) {
        const hottest = node.hottestFunction
          ? "最热函数 " + node.hottestFunction.name + " · " + node.hottestFunction.path + (node.hottestFunction.line ? ":" + node.hottestFunction.line : "") + " · " + number.format(node.hottestFunction.hits) + " 次"
          : "没有函数命中";
        return (node.path || domain.domain) + "；" + number.format(node.functionHits) + " 次函数命中；" + node.coveredFunctions + "/" + node.functions + " 个函数已覆盖；" + hottest;
      }

      function showSummary(node) {
        summary.replaceChildren();
        const path = document.createElement("strong");
        path.textContent = node.path || domain.domain;
        const metrics = document.createElement("span");
        metrics.textContent = number.format(node.functionHits) + " 次函数命中 · " + node.coveredFunctions + "/" + node.functions + " 函数已覆盖（" + formatPercent(node) + "）";
        const hottest = document.createElement("span");
        hottest.textContent = node.hottestFunction
          ? "最热：" + node.hottestFunction.name + " · " + node.hottestFunction.path + (node.hottestFunction.line ? ":" + node.hottestFunction.line : "") + " · " + number.format(node.hottestFunction.hits) + " 次"
          : "无命中函数";
        summary.append(path, metrics, hottest);
      }

      function renderTabs() {
        domainTabs.replaceChildren();
        for (const candidate of report.domains) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "domain-tab";
          button.textContent = candidate.domain;
          button.setAttribute("aria-pressed", String(candidate.domain === domain.domain));
          button.addEventListener("click", () => {
            domain = candidate;
            selected = null;
            render();
          });
          domainTabs.append(button);
        }
      }

      function renderHeatGrid() {
        heatGrid.replaceChildren();
        const items = buildItems();
        if (items.length === 0) {
          const empty = document.createElement("div");
          empty.className = "empty";
          empty.textContent = "当前运行域没有可展示的函数";
          heatGrid.append(empty);
          return;
        }
        const width = Math.max(1, heatGrid.clientWidth - 6);
        const height = Math.max(1, heatGrid.clientHeight - 6);
        const columns = Math.max(1, Math.ceil(Math.sqrt(items.length * width / height)));
        const rows = Math.max(1, Math.ceil(items.length / columns));
        const cellWidth = (width - Math.max(0, columns - 1) * 2) / columns;
        const cellHeight = (height - Math.max(0, rows - 1) * 2) / rows;
        heatGrid.style.gridTemplateColumns = "repeat(" + columns + ", minmax(0, 1fr))";
        heatGrid.style.gridTemplateRows = "repeat(" + rows + ", minmax(0, 1fr))";
        const maxHeat = Math.max(...items.map(metricValue), 0);
        for (const node of items) {
          const heat = metricValue(node);
          const logRatio = heat <= 0 || maxHeat <= 0 ? 0 : Math.log1p(heat) / Math.log1p(maxHeat);
          const level = Math.pow(logRatio, 3);
          const tile = document.createElement("button");
          tile.type = "button";
          tile.className = "heat-tile";
          tile.style.background = level === 0
            ? "var(--tile-zero)"
            : "color-mix(in srgb, var(--tile-low), var(--tile-high) " + Math.round(level * 100) + "%)";
          tile.style.color = level > 0.68 ? "var(--tile-hot-text)" : "var(--foreground)";
          tile.setAttribute("aria-label", describe(node));
          tile.setAttribute("aria-pressed", String(selected?.path === node.path));
          if (cellWidth >= 64 && cellHeight >= 28) {
            const name = document.createElement("span");
            name.className = "tile-name";
            name.textContent = node.name;
            tile.append(name);
          }
          if (cellWidth >= 110 && cellHeight >= 48) {
            const meta = document.createElement("span");
            meta.className = "tile-meta";
            meta.textContent = number.format(node.functionHits) + " 次 · " + node.functions + " 函数";
            tile.append(meta);
          }
          tile.addEventListener("mouseenter", () => showSummary(node));
          tile.addEventListener("focus", () => showSummary(node));
          tile.addEventListener("mouseleave", () => showSummary(selected || domainNode()));
          tile.addEventListener("click", () => {
            selected = node;
            renderHeatGrid();
            showSummary(node);
          });
          heatGrid.append(tile);
        }
      }

      function render() {
        renderTabs();
        renderHeatGrid();
        showSummary(selected || domainNode());
      }

      metricSelect.addEventListener("change", () => {
        selected = null;
        render();
      });
      let resizeFrame;
      window.addEventListener("resize", () => {
        cancelAnimationFrame(resizeFrame);
        resizeFrame = requestAnimationFrame(renderHeatGrid);
      });
      render();
    })();
  </script>
</body>
</html>
`;
}
