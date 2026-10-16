// 修复原因：desktop e2e tsconfig 没有直接引入 Istanbul 的 @types 包，
// 但 coverage 报表代码只需要下面这组稳定 API。这里用本地最小声明恢复 typecheck。
declare module "istanbul-lib-coverage" {
  export interface CoverageSummaryData {
    branches: Totals;
    functions: Totals;
    lines: Totals;
    statements: Totals;
  }

  export interface CoverageMapData {
    [filePath: string]: unknown;
  }

  export interface Totals {
    covered: number;
    pct: number;
    skipped: number;
    total: number;
  }

  export interface CoverageSummary {
    toJSON(): CoverageSummaryData;
  }

  export interface FileCoverage {
    getUncoveredLines(): number[];
    toSummary(): CoverageSummary;
  }

  export interface CoverageMap {
    addFileCoverage(pathOrObject: unknown): void;
    fileCoverageFor(filePath: string): FileCoverage;
    files(): string[];
    filter(callback: (filePath: string) => boolean): void;
    getCoverageSummary(): CoverageSummary;
    merge(data: CoverageMapData): void;
    toJSON(): CoverageMapData;
  }

  export function createCoverageMap(data?: CoverageMapData): CoverageMap;
}

declare module "istanbul-lib-instrument" {
  export interface Instrumenter {
    instrumentSync(code: string, filename: string): string;
    lastFileCoverage(): unknown;
  }

  export function createInstrumenter(options?: {
    coverageVariable?: string;
    parserPlugins?: string[];
    produceSourceMap?: boolean;
  }): Instrumenter;
}

declare module "istanbul-lib-report" {
  import type { CoverageMap } from "istanbul-lib-coverage";

  export interface Context {
    readonly dir: string;
  }

  export interface ContextOptions {
    coverageMap: CoverageMap;
    defaultSummarizer: string;
    dir: string;
    sourceFinder(filePath: string): string;
  }

  export function createContext(options?: Partial<ContextOptions>): Context;
}

declare module "istanbul-reports" {
  import type { Context } from "istanbul-lib-report";

  export interface IstanbulReport {
    execute(context: Context): void;
  }

  export function create(
    name: string,
    options?: Record<string, unknown>,
  ): IstanbulReport;
}
