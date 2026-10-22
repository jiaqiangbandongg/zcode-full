#!/usr/bin/env node
import {
  addedFilesFromGit,
  checkArchitecture,
  changedFilesFromGit,
  formatMarkdownReport,
  formatReport,
  generateContext,
  loadPolicy,
  resolveDiffBase,
  updateBaseline,
} from "./index.mjs";
import { adoptModule } from "./adopt.mjs";

const args = process.argv.slice(2);
const command = args[0] ?? "check";
const cwd = process.cwd();

function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
function options(name) {
  return args.flatMap((item, index) => (item === name && args[index + 1] ? [args[index + 1]] : []));
}

if (command === "context") {
  const moduleId = args[1];
  if (!moduleId) throw new Error("用法: pnpm architecture:context <module-id>");
  console.log(await generateContext({ cwd, moduleId }));
  process.exit(0);
}

if (command === "adopt") {
  const id = args[1];
  const roots = options("--root");
  if (!id || roots.length === 0) {
    throw new Error(
      "用法: pnpm architecture:adopt <module-id> --root <dir> [--root <dir2>] [--layer domain|app|adapters|ui] [--owner <group>] [--requires a,b]",
    );
  }
  const summary = await adoptModule({
    cwd,
    id,
    roots,
    layer: option("--layer") ?? "adapters",
    owner: option("--owner") ?? null,
    requires: (option("--requires") ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  });
  console.log(
    [
      `adopted: ${summary.id}${summary.registered ? "（新登记）" : "（已存在，置为 managed）"}`,
      `roots: ${summary.roots.join(", ")}`,
      `requires: ${summary.requires.join(", ") || "none"}`,
      `created: ${summary.created.join(", ") || "none"}`,
      "next: 填写 contract.ts 与 CONTRACT.md，运行 pnpm architecture:check -- --changed",
    ].join("\n"),
  );
  process.exit(0);
}

let changed = null;
let added = null;
let baseLabel = null;
if (args.includes("--changed")) {
  const { base, label } = await resolveDiffBase(cwd, { explicit: option("--base") ?? null });
  baseLabel = label;
  const { global } = await loadPolicy(cwd);
  [changed, added] = await Promise.all([
    changedFilesFromGit(cwd, { base }),
    addedFilesFromGit(cwd, {
      base,
      since: global.newFilesEnforcedSince,
      acceptedUpstreamCommits: global.acceptedUpstreamCommits,
      acceptedUpstreamSnapshot: global.acceptedUpstreamSnapshot,
    }),
  ]);
}
const result = await checkArchitecture({ cwd, changedFiles: changed, addedFiles: added });

if (command === "baseline:update") {
  const entries = await updateBaseline({
    cwd,
    violations: result.violations,
    scope: result.changedClosure,
  });
  console.log(
    `baseline updated: ${entries.length} violations${changed ? "（--changed：仅替换变更闭包内的条目）" : ""}`,
  );
  process.exit(0);
}

if (command === "report") {
  console.log(
    args.includes("--markdown") ? formatMarkdownReport(result) : JSON.stringify(result, null, 2),
  );
  process.exit(result.newViolations.length > 0 ? 1 : 0);
}

console.log(formatReport(result, { base: baseLabel }));
process.exit(result.newViolations.length > 0 ? 1 : 0);
