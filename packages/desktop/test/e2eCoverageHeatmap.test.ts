import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildCoverageHeatmapData,
  writeE2ECoverageHeatmap,
} from "./e2e/reporting/e2e-coverage-heatmap";

const createdDirs: string[] = [];

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "zcode-e2e-heatmap-"));
  createdDirs.push(root);
  const repoRoot = path.join(root, "repo");
  const coverageDir = path.join(root, "coverage");
  await mkdir(path.join(coverageDir, "main"), { recursive: true });
  await writeFile(
    path.join(coverageDir, "coverage-final.json"),
    JSON.stringify({
      [path.join(repoRoot, "packages/ui/src/hot.ts")]: {
        f: { 0: 12, 1: 0 },
        fnMap: {
          0: { loc: { start: { line: 4 } }, name: "hot" },
          1: { loc: { start: { line: 8 } }, name: "cold" },
        },
      },
      [path.join(repoRoot, "packages/ui/src/warm.ts")]: {
        f: { 0: 3 },
        fnMap: { 0: { loc: { start: { line: 2 } }, name: "warm" } },
      },
    }),
    "utf-8",
  );
  await writeFile(
    path.join(coverageDir, "main/coverage-final.json"),
    JSON.stringify({
      [path.join(repoRoot, "packages/desktop/src/main/index.ts")]: {
        f: { 0: 5 },
        fnMap: { 0: { loc: { start: { line: 10 } }, name: "start" } },
      },
    }),
    "utf-8",
  );
  return { coverageDir, repoRoot };
}

describe("desktop E2E coverage heatmap", () => {
  afterEach(async () => {
    await Promise.all(
      createdDirs
        .splice(0)
        .map((dir) => rm(dir, { force: true, recursive: true })),
    );
  });

  it("aggregates function hit counters per runtime domain and file", async () => {
    const fixture = await createFixture();
    const data = buildCoverageHeatmapData(fixture);

    expect(data.domains.map((domain) => domain.domain)).toEqual([
      "renderer",
      "main",
    ]);
    expect(data.domains[0]).toMatchObject({
      coveredFunctions: 2,
      functionHits: 15,
      functions: 3,
    });
    expect(data.domains[0]?.files[0]).toMatchObject({
      coveredFunctions: 1,
      functionHits: 12,
      functions: 2,
      hottestFunction: {
        hits: 12,
        line: 4,
        name: "hot",
        path: "packages/ui/src/hot.ts",
      },
      path: "packages/ui/src/hot.ts",
    });
    expect(data.domains[1]).toMatchObject({
      coveredFunctions: 1,
      functionHits: 5,
      functions: 1,
    });
  });

  it("writes a self-contained drill-down report and machine-readable data", async () => {
    const fixture = await createFixture();
    const summary = writeE2ECoverageHeatmap(fixture);

    expect(summary).toMatchObject({
      domainCount: 2,
      fileCount: 3,
    });
    const html = await readFile(summary?.htmlIndex ?? "", "utf-8");
    const data = JSON.parse(
      await readFile(summary?.dataJson ?? "", "utf-8"),
    ) as { scale?: string };
    expect(html).toContain("coverage-heatmap-data");
    expect(html).toContain("每个等大 tile 代表一个源码文件");
    expect(html).toContain('id="heat-grid"');
    expect(html).toContain("gridTemplateColumns");
    expect(html).toContain("每函数平均命中");
    expect(html).not.toContain("binaryLayout");
    expect(html).not.toContain("面积表示函数数量");
    expect(html).not.toContain('id="granularity-select"');
    expect(html).not.toContain("父目录");
    expect(html).not.toContain('id="breadcrumbs"');
    expect(html).not.toContain("继续下钻");
    expect(html).not.toContain("fetch(");
    expect(data.scale).toBe("log1p");
  });
});
