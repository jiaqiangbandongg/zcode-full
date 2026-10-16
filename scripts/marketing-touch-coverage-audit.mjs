import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import coverageLibrary from "istanbul-lib-coverage";
import { loadGeneratedLineEvidence } from "./marketing-source-map-evidence.mjs";
import { executableSourceLines } from "./marketing-executable-lines.mjs";

const { createFileCoverage } = coverageLibrary;

const runGit = promisify(execFile);
const unzip = promisify(gunzip);
const domainPaths = {
  renderer: "coverage-final.json",
  host: "host/coverage-final.json",
  main: "main/coverage-final.json",
  cli: "cli/coverage-final.json",
};

export function verifySourceEvidence(file, sha256, domain, manifest) {
  if (
    manifest?.schemaVersion !== 1 ||
    manifest.status !== "fresh-stable" ||
    !Array.isArray(manifest.domains) ||
    !manifest.domains.includes(domain) ||
    !Array.isArray(manifest.changedFiles) ||
    manifest.changedFiles.length !== 0 ||
    !manifest.outputs ||
    Object.keys(manifest.outputs).length === 0 ||
    !Object.values(manifest.outputs).every(
      (hash) => typeof hash === "string" && /^[a-f0-9]{64}$/u.test(hash),
    )
  )
    return "unverified";
  const actual = manifest.sources?.[file];
  return actual === undefined ? "missing-source" : actual === sha256 ? "matched" : "mismatch";
}

export function changedLines(diff) {
  const result = new Set();
  for (const match of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    for (let line = start; line < start + count; line++) result.add(line);
  }
  return result;
}

export function isBusinessSource(file) {
  return (
    /^packages\/[^/]+\/src\//u.test(file) &&
    /\.[cm]?[jt]sx?$/u.test(file) &&
    !/\.d\.ts$|\.(test|spec)\.[cm]?[jt]sx?$|\/i18n\/locales\//u.test(file)
  );
}

function expectedDomains(file) {
  if (file.startsWith("packages/ui/") || file.startsWith("packages/desktop/src/renderer/"))
    return ["renderer"];
  if (file.startsWith("packages/services/")) return ["host"];
  if (file.startsWith("packages/desktop/src/main/")) return ["main"];
  // shared/client 等可在多个域使用；未定义归属不能自动判错或合并。
  return null;
}

export function analyzeCoverage(file, domain, changed, data) {
  if (!data) return { status: "unknown", warnings: ["missing-file-coverage"] };
  const fc = createFileCoverage(data);
  const lineMap = fc.getLineCoverage();
  const lines = Object.entries(lineMap).filter(([line]) => changed.has(Number(line)));
  const functions = Object.entries(data.fnMap).filter(([, value]) =>
    changed.has(value.decl?.start?.line ?? value.loc.start.line),
  );
  const branches = Object.entries(data.branchMap)
    .filter(([, value]) => changed.has(value.line ?? value.loc.start.line))
    .flatMap(([id]) => data.b[id]);
  const warnings = [];
  const expected = expectedDomains(file);
  if (expected && !expected.includes(domain)) warnings.push("unexpected-runtime-domain");
  if (domain !== "renderer") {
    const locations = Object.values(data.statementMap);
    // V8 转换器可把 import/类型/空行都标为 statement，不是统一的可执行行分母。
    if (
      locations.length &&
      locations.every((loc) => loc.start.line === loc.end.line && loc.start.column === 0)
    )
      warnings.push("node-physical-line-map");
    if (!Object.keys(data.fnMap).length) warnings.push("no-function-records");
  }
  return {
    status: "mapped",
    basis: domain === "renderer" ? "renderer-istanbul-lines" : "node-raw-mapped-lines",
    warnings,
    lines: { covered: lines.filter(([, count]) => count > 0).length, total: lines.length },
    functions: {
      covered: functions.filter(([id]) => data.f[id] > 0).length,
      total: functions.length,
    },
    branches: { covered: branches.filter((count) => count > 0).length, total: branches.length },
    uncoveredLines: lines.filter(([, count]) => count === 0).map(([line]) => Number(line)),
    unmappedChangedLines: [...changed].filter((line) => lineMap[line] === undefined),
  };
}

export async function readReport(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    return JSON.parse((await unzip(await readFile(`${file}.gz`))).toString("utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return null;
}

export async function audit(baseRef, headRef, runDirectory) {
  const sourceEvidence = await readReport(join(runDirectory, "build-source-evidence.json"));
  const git = async (...args) =>
    (await runGit("git", args, { maxBuffer: 32 * 1024 * 1024 })).stdout;
  const base = (await git("rev-parse", "--verify", `${baseRef}^{commit}`)).trim();
  const head = (await git("rev-parse", "--verify", `${headRef}^{commit}`)).trim();
  const repoRoot = (await git("rev-parse", "--show-toplevel")).trim();
  const generated = Object.fromEntries(
    await Promise.all(
      ["host", "main"].map(async (domain) => [
        domain,
        await loadGeneratedLineEvidence(
          join(repoRoot, "packages/desktop/out"),
          domain,
          sourceEvidence,
        ),
      ]),
    ),
  );
  const files = (await git("diff", "--name-only", "--diff-filter=AM", base, head))
    .trim()
    .split("\n")
    .filter(isBusinessSource);
  const reports = Object.fromEntries(
    await Promise.all(
      Object.entries(domainPaths).map(async ([domain, file]) => [
        domain,
        await readReport(join(runDirectory, "coverage", file)),
      ]),
    ),
  );
  const rows = [];
  for (const file of files) {
    const source = await git("show", `${head}:${file}`);
    const sourceSha256 = createHash("sha256").update(source).digest("hex");
    const changed = changedLines(await git("diff", "--unified=0", base, head, "--", file));
    const executable = executableSourceLines(source, file);
    const canonicalExecutableLines =
      executable.status === "mapped"
        ? { ...executable, lines: executable.lines.filter((line) => changed.has(line)) }
        : executable;
    const domains = {};
    for (const [domain, report] of Object.entries(reports)) {
      const matches = Object.entries(report ?? {}).filter(
        ([key]) => key.replaceAll("\\", "/").endsWith(`/${file}`) || key === file,
      );
      if (matches.length > 1) throw new Error(`Ambiguous source mapping: ${domain} ${file}`);
      domains[domain] = analyzeCoverage(file, domain, changed, matches[0]?.[1]);
      domains[domain].sourceIdentity = verifySourceEvidence(
        file,
        sourceSha256,
        domain,
        sourceEvidence,
      );
      const evidence = generated[domain];
      const generatedLines = evidence?.sources?.[resolve(repoRoot, file)];
      const verified =
        evidence?.status === "matched" && domains[domain].sourceIdentity === "matched";
      domains[domain].generatedMapping = {
        status: verified
          ? generatedLines
            ? "matched"
            : "source-absent"
          : evidence?.status === "matched"
            ? "unverified-source"
            : (evidence?.status ?? "unverified"),
      };
      if (verified && generatedLines && matches[0]) {
        const lineMap = createFileCoverage(matches[0][1]).getLineCoverage();
        const mapped = new Set(generatedLines);
        domains[domain].generatedMapping.positiveLinesWithoutGeneratedMapping = Object.entries(
          lineMap,
        )
          .filter(
            ([line, count]) => count > 0 && changed.has(Number(line)) && !mapped.has(Number(line)),
          )
          .map(([line]) => Number(line));
      }
    }
    rows.push({
      file,
      sourceSha256,
      changedLines: changed.size,
      canonicalExecutableLines,
      expectedDomains: expectedDomains(file),
      domains,
    });
  }
  const summaries = {};
  for (const domain of Object.keys(reports)) {
    const mapped = rows
      .map((row) => row.domains[domain])
      .filter((result) => result.status === "mapped");
    summaries[domain] = {
      sourceIdentityVerified:
        mapped.length > 0 && mapped.every((result) => result.sourceIdentity === "matched"),
      reportPresent: reports[domain] !== null,
      basis: domain === "renderer" ? "renderer-istanbul-lines" : "node-raw-mapped-lines",
      ...Object.fromEntries(
        ["lines", "functions", "branches"].map((metric) => [
          metric,
          mapped.reduce(
            (sum, row) => ({
              covered: sum.covered + row[metric].covered,
              total: sum.total + row[metric].total,
            }),
            { covered: 0, total: 0 },
          ),
        ]),
      ),
    };
  }
  return {
    status: "diagnostic-only",
    base,
    head,
    runDirectory: resolve(runDirectory),
    buildSourceIdentityVerified: Object.values(summaries).every(
      (summary) => summary.sourceIdentityVerified,
    ),
    sourceEvidenceStatus: sourceEvidence?.status ?? "missing",
    // 不允许调用方将多个 instrumentation 域求和/OR 后当作整体覆盖率。
    overallCoverage: null,
    limitations: [
      "node executable-line denominator unnormalized",
      "source identity not matched to build",
      "test outcome not validated by this diagnostic",
    ],
    summaries,
    unmappedFiles: rows
      .filter((row) => Object.values(row.domains).every((result) => result.status === "unknown"))
      .map((row) => row.file),
    rows,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 5)
    throw new Error(
      "Usage: node scripts/marketing-touch-coverage-audit.mjs <base> <head> <run-dir>",
    );
  console.log(JSON.stringify(await audit(...process.argv.slice(2)), null, 2));
}
