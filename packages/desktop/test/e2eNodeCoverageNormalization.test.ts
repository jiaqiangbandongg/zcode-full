import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdtemp } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  compactV8CoverageDirectory,
  createC8ConversionConfig,
  normalizeV8CoveragePayload,
} from "./e2e/reporting/e2e-node-coverage.js";

describe("E2E Node coverage normalization", () => {
  it("keeps only generated bundles that can map back to the selected first-party domain", async () => {
    const fixtureRoot = await mkdtemp(resolve(tmpdir(), "zcode-e2e-node-coverage-"));
    const sourceMapRoot = resolve(fixtureRoot, "out/main");
    const canonicalBundle = resolve(sourceMapRoot, "index.js");
    mkdirSync(sourceMapRoot, { recursive: true });
    writeFileSync(canonicalBundle, "export const covered = true;\n", "utf-8");
    writeFileSync(
      `${canonicalBundle}.map`,
      JSON.stringify({
        mappings: "AAAA",
        names: [],
        sources: ["../../../src/main/index.ts"],
        version: 3,
      }),
      "utf-8",
    );

    const runtimeBundleUrl = pathToFileURL(
      resolve(fixtureRoot, "staged/app/main/index.js"),
    ).href;
    const dependencyUrl = pathToFileURL(
      resolve(fixtureRoot, "node_modules/dependency/index.js"),
    ).href;
    const payload = {
      result: [
        { functions: [], scriptId: "1", url: runtimeBundleUrl },
        { functions: [], scriptId: "2", url: dependencyUrl },
        { functions: [], scriptId: "3", url: "node:internal/process/task_queues" },
      ],
      "source-map-cache": {
        [runtimeBundleUrl]: { data: null, lineLengths: [1], url: null },
        [dependencyUrl]: { data: null, lineLengths: [1], url: null },
      },
    };

    normalizeV8CoveragePayload(payload, sourceMapRoot);

    expect(payload.result).toEqual([
      expect.objectContaining({ scriptId: "1", url: pathToFileURL(canonicalBundle).href }),
    ]);
    expect(Object.keys(payload["source-map-cache"])).toEqual([
      pathToFileURL(canonicalBundle).href,
    ]);
    expect(
      payload["source-map-cache"][pathToFileURL(canonicalBundle).href]?.data?.sources,
    ).toEqual([pathToFileURL(resolve(sourceMapRoot, "../../../src/main/index.ts")).href]);
    expect(readFileSync(`${canonicalBundle}.map`, "utf-8")).toContain("../../../src/main/index.ts");

    normalizeV8CoveragePayload(payload, sourceMapRoot, { includeSourceMapCache: false });
    expect(payload.result).toHaveLength(1);
    expect(payload["source-map-cache"]).toBeUndefined();
  });

  it("asks c8 to merge large multi-process runs incrementally", () => {
    expect(createC8ConversionConfig("/tmp/raw", "/tmp/reports")).toMatchObject({
      "merge-async": true,
      "reports-dir": "/tmp/reports",
      "temp-directory": "/tmp/raw",
    });
  });

  it("compacts each finished worker once and retains one source map per unique bundle", async () => {
    const fixtureRoot = await mkdtemp(resolve(tmpdir(), "zcode-e2e-node-compact-"));
    const rawDir = resolve(fixtureRoot, "raw");
    const sourceMapRoot = resolve(fixtureRoot, "out/main");
    const canonicalBundle = resolve(sourceMapRoot, "index.js");
    const canonicalChunk = resolve(sourceMapRoot, "lazy-chunk.js");
    mkdirSync(rawDir, { recursive: true });
    mkdirSync(sourceMapRoot, { recursive: true });
    writeFileSync(canonicalBundle, "export const covered = true;\n", "utf-8");
    writeFileSync(canonicalChunk, "export const lazy = true;\n", "utf-8");
    for (const [bundle, source] of [
      [canonicalBundle, "../../../src/main/index.ts"],
      [canonicalChunk, "../../../src/main/lazy.ts"],
    ]) {
      writeFileSync(
        `${bundle}.map`,
        JSON.stringify({ mappings: "AAAA", names: [], sources: [source], version: 3 }),
        "utf-8",
      );
    }

    const writeRaw = (pid: number, bundleName: "index" | "lazy-chunk") => {
      const runtimeBundleUrl = pathToFileURL(
        resolve(fixtureRoot, `staged/app/main/${bundleName}.js`),
      ).href;
      const dependencyUrl = pathToFileURL(
        resolve(fixtureRoot, `node_modules/dependency-${pid}/index.js`),
      ).href;
      writeFileSync(
        resolve(rawDir, `coverage-${pid}-1-0.json`),
        JSON.stringify({
          result: [
            { functions: [], scriptId: "1", url: runtimeBundleUrl },
            { functions: [], scriptId: "2", url: dependencyUrl },
          ],
          "source-map-cache": {
            [runtimeBundleUrl]: { data: null, lineLengths: [1], url: null },
            [dependencyUrl]: { data: null, lineLengths: [1], url: null },
          },
        }),
        "utf-8",
      );
    };
    writeRaw(101, "index");
    writeRaw(102, "lazy-chunk");

    expect(compactV8CoverageDirectory({ rawDir, sourceMapRoot })).toMatchObject({
      compactedFileCount: 2,
      sourceMapCacheRetained: true,
    });
    const first = JSON.parse(
      readFileSync(resolve(rawDir, "coverage-101-1-0.json"), "utf-8"),
    ) as { result: unknown[]; "source-map-cache"?: object };
    const second = JSON.parse(
      readFileSync(resolve(rawDir, "coverage-102-1-0.json"), "utf-8"),
    ) as { result: unknown[]; "source-map-cache"?: object };
    expect(first.result).toHaveLength(1);
    expect(second.result).toHaveLength(1);
    expect(
      [first["source-map-cache"], second["source-map-cache"]]
        .flatMap((cache) => Object.keys(cache ?? {})),
    ).toHaveLength(2);
    expect(
      readFileSync(resolve(rawDir, ".zcode-compacted-coverage-files-v1.marker"), "utf-8"),
    ).toContain("coverage-101-1-0.json");

    const alreadyCompactedPath = resolve(rawDir, "coverage-101-1-0.json");
    const alreadyCompactedSentinel = JSON.stringify({
      result: [{ functions: [], scriptId: "sentinel", url: "sentinel://do-not-read-again" }],
    });
    writeFileSync(alreadyCompactedPath, alreadyCompactedSentinel, "utf-8");
    writeRaw(103, "index");
    expect(compactV8CoverageDirectory({ rawDir, sourceMapRoot })).toMatchObject({
      compactedFileCount: 1,
      sourceMapCacheRetained: true,
    });
    expect(readFileSync(alreadyCompactedPath, "utf-8")).toBe(alreadyCompactedSentinel);
    const third = JSON.parse(
      readFileSync(resolve(rawDir, "coverage-103-1-0.json"), "utf-8"),
    ) as { "source-map-cache"?: object };
    expect(third["source-map-cache"]).toBeUndefined();
    expect(compactV8CoverageDirectory({ rawDir, sourceMapRoot }).compactedFileCount).toBe(0);
  });
});
