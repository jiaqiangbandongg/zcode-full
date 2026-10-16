import { gitFileNames } from "./git-file-names.mjs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import {
  countPublicMethods,
  discoverFiles,
  importsOf,
  isException,
  layerForFile,
  loadPolicy,
  manifestRequires,
  moduleForFile,
  posix,
  publicEntrypointMatches,
  resolveImport,
} from "./policy.mjs";

function fingerprint(rule, file, detail = "") {
  return createHash("sha256").update(`${rule}\0${file}\0${detail}`).digest("hex").slice(0, 16);
}

function violation({ rule, file, detail, message, module, global = false }) {
  return {
    rule,
    file: posix(file),
    module: module?.id ?? null,
    detail,
    message,
    fingerprint: fingerprint(rule, posix(file), detail),
    global,
  };
}

function cycleViolations(edges, policy, modulesByFile) {
  const state = new Map();
  const stack = [];
  const cycles = [];
  function visit(node) {
    state.set(node, 1);
    stack.push(node);
    for (const next of edges.get(node) ?? []) {
      if (!modulesByFile.get(next)?.managed && policy.global.managedOnly) continue;
      if (state.get(next) === 1) {
        const index = stack.indexOf(next);
        cycles.push(stack.slice(index).concat(next));
      } else if (!state.get(next)) visit(next);
    }
    stack.pop();
    state.set(node, 2);
  }
  for (const node of edges.keys()) if (!state.get(node)) visit(node);
  const unique = new Map();
  for (const cycle of cycles) {
    const detail = [...new Set(cycle)].sort().join(" -> ");
    const file = cycle[0];
    unique.set(
      detail,
      violation({
        rule: "cycle",
        file,
        detail,
        module: modulesByFile.get(file),
        message: `检测到循环依赖：${cycle.map((item) => posix(item)).join(" -> ")}`,
        global: true,
      }),
    );
  }
  return [...unique.values()];
}

async function readBaseline(cwd) {
  try {
    return JSON.parse(await fs.readFile(path.join(cwd, ".architecture-baseline.json"), "utf8"));
  } catch {
    return { version: 1, violations: [] };
  }
}

export async function checkArchitecture({ cwd = process.cwd(), changedFiles = null } = {}) {
  const policy = await loadPolicy(cwd);
  const files = await discoverFiles(policy);
  const knownFiles = new Set(files);
  const modulesByFile = new Map(files.map((file) => [file, moduleForFile(file, policy)]));
  const edges = new Map(files.map((file) => [file, []]));
  const violations = [];
  const manifestRequiresByModule = new Map();

  const today = new Date().toISOString().slice(0, 10);
  for (const exception of policy.exceptions) {
    if (exception.expires && exception.expires < today) {
      violations.push(
        violation({
          rule: "expired-exception",
          file: path.join(cwd, "architecture-policy.yaml"),
          detail: exception.id ?? exception.rule,
          message: `例外 ${exception.id ?? exception.rule} 已于 ${exception.expires} 过期`,
          global: true,
        }),
      );
    }
  }

  for (const module of policy.modules.filter((item) => item.managed)) {
    const moduleFiles = files.filter((file) => modulesByFile.get(file)?.id === module.id);
    const manifest = moduleFiles.find((file) => path.basename(file) === "module.ts");
    if (manifest)
      manifestRequiresByModule.set(
        module.id,
        manifestRequires(await fs.readFile(manifest, "utf8")) ?? module.requires,
      );
    const required = [
      "module.ts",
      "contract.ts",
      "contract.example.ts",
      "contract.test.ts",
      "CONTRACT.md",
    ];
    for (const artifact of required) {
      if (!moduleFiles.some((file) => path.basename(file) === artifact)) {
        const file = module.roots[0];
        violations.push(
          violation({
            rule: "missing-module-artifact",
            file,
            detail: artifact,
            module,
            message: `模块 ${module.id} 缺少 ${artifact}`,
          }),
        );
      }
    }
  }

  for (const file of files) {
    // CONTRACT.md 只参与产物存在性检查，文档里的示例不能当成源码依赖或源码行数。
    if (path.extname(file) === ".md") continue;
    const module = modulesByFile.get(file);
    if (!module || (policy.global.managedOnly && !module.managed)) continue;
    const source = await fs.readFile(file, "utf8");
    const lines = source.split(/\r?\n/).length;
    if (lines > policy.global.maxFileLines && !isException(policy, "max-file-lines", file, cwd)) {
      violations.push(
        violation({
          rule: "max-file-lines",
          file,
          detail: String(lines),
          module,
          message: `文件 ${lines} 行，超过上限 ${policy.global.maxFileLines} 行`,
        }),
      );
    }
    if (path.basename(file).startsWith("contract.") && lines > policy.global.maxContractLines) {
      violations.push(
        violation({
          rule: "max-contract-lines",
          file,
          detail: String(lines),
          module,
          message: `契约 ${lines} 行，超过上限 ${policy.global.maxContractLines} 行`,
        }),
      );
    }
    const disableCount = source
      .split(/\r?\n/)
      .filter((line) => /(?:oxlint|eslint)-disable/.test(line)).length;
    if (disableCount > 0 && !isException(policy, "disable-count", file, cwd)) {
      violations.push(
        violation({
          rule: "disable-count",
          file,
          detail: String(disableCount),
          module,
          message: `文件包含 ${disableCount} 条 lint disable`,
        }),
      );
    }
    if (
      path.basename(file) === "contract.ts" &&
      countPublicMethods(source) > policy.global.maxPublicMethods
    ) {
      violations.push(
        violation({
          rule: "max-public-methods",
          file,
          detail: String(countPublicMethods(source)),
          module,
          message: `契约公开方法超过上限 ${policy.global.maxPublicMethods}`,
        }),
      );
    }
    const importerLayer = layerForFile(file, module);
    const layerOrder = module.layerOrder ?? [];
    for (const specifier of importsOf(file, source)) {
      if (
        importerLayer === "domain" &&
        /^(node:|fs$|path$|http$|https$|net$|child_process$|timers$)/.test(specifier)
      ) {
        violations.push(
          violation({
            rule: "domain-io",
            file,
            detail: specifier,
            module,
            message: "domain 层不能依赖 IO、进程、网络或定时器",
          }),
        );
      }
      const target = resolveImport(file, specifier, knownFiles);
      if (!target) continue;
      edges.get(file).push(target);
      const targetModule = modulesByFile.get(target);
      if (targetModule?.id === module.id) {
        const targetLayer = layerForFile(target, module);
        if (
          importerLayer &&
          targetLayer &&
          layerOrder.includes(importerLayer) &&
          layerOrder.includes(targetLayer) &&
          layerOrder.indexOf(importerLayer) < layerOrder.indexOf(targetLayer)
        ) {
          violations.push(
            violation({
              rule: "layer-direction",
              file,
              detail: target,
              module,
              message: `层 ${importerLayer} 不能依赖更高层 ${targetLayer}`,
            }),
          );
        }
      }
      if (module.id === "ui" && /(?:^|\/)(repo|runtime|services?)(?:\/|$)/i.test(posix(target))) {
        violations.push(
          violation({
            rule: "ui-implementation-import",
            file,
            detail: target,
            module,
            message: "UI 层不能直接依赖 Repo、Runtime 或 Service 实现",
          }),
        );
      }
      if (!targetModule || targetModule.id === module.id) {
        continue;
      }
      const declaredRequires = manifestRequiresByModule.get(module.id) ?? module.requires;
      if (!declaredRequires.includes(targetModule.id)) {
        violations.push(
          violation({
            rule: "module-dependency",
            file,
            detail: target,
            module,
            message: `模块 ${module.id} 未声明依赖 ${targetModule.id}`,
          }),
        );
      }
      if (policy.global.forbidDeepImports && targetModule.publicEntrypoints.length > 0) {
        const targetRelative = posix(path.relative(cwd, target));
        const allowed = publicEntrypointMatches(target, targetModule, cwd);
        if (!allowed) {
          violations.push(
            violation({
              rule: "deep-import",
              file,
              detail: target,
              module,
              message: `跨模块只能通过公开入口访问 ${targetRelative}`,
            }),
          );
        }
      }
    }
    if (importerLayer === "domain" && /\b(fetch|setTimeout|setInterval)\s*\(/.test(source)) {
      violations.push(
        violation({
          rule: "domain-io",
          file,
          detail: "runtime-call",
          module,
          message: "domain 层不能依赖 IO、进程、网络或定时器",
        }),
      );
    }
  }

  if (policy.global.forbidCycles) violations.push(...cycleViolations(edges, policy, modulesByFile));
  const baseline = await readBaseline(cwd);
  const baselineFingerprints = new Set(baseline.violations.map((item) => item.fingerprint));
  const changed = changedFiles
    ? new Set(changedFiles.map((file) => path.resolve(cwd, file)))
    : null;
  if (changed) {
    const reverse = new Map(files.map((file) => [file, []]));
    for (const [from, targets] of edges)
      for (const target of targets) reverse.get(target)?.push(from);
    const queue = [...changed];
    while (queue.length > 0) {
      const current = queue.shift();
      for (const dependent of reverse.get(current) ?? []) {
        if (!changed.has(dependent)) {
          changed.add(dependent);
          queue.push(dependent);
        }
      }
    }
  }
  const scoped = changed
    ? violations.filter((item) => item.global || changed.has(path.resolve(cwd, item.file)))
    : violations;
  const baselineViolations = scoped.filter((item) => baselineFingerprints.has(item.fingerprint));
  const newViolations = scoped.filter((item) => !baselineFingerprints.has(item.fingerprint));
  return { policy, violations: scoped, baselineViolations, newViolations, baseline };
}

export async function updateBaseline({ cwd = process.cwd(), violations }) {
  const entries = [...violations].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
  const filename = path.join(cwd, ".architecture-baseline.json");
  await fs.writeFile(filename, `${JSON.stringify({ version: 1, violations: entries }, null, 2)}\n`);
  return entries;
}

export async function changedFilesFromGit(cwd = process.cwd()) {
  const [diff, untracked] = await Promise.all([
    gitFileNames(cwd, ["diff", "--name-only", "-z", "HEAD"]),
    gitFileNames(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  return [...new Set([...diff, ...untracked])];
}

export async function generateContext({ cwd = process.cwd(), moduleId }) {
  const policy = await loadPolicy(cwd);
  const module = policy.modules.find((item) => item.id === moduleId);
  if (!module) throw new Error(`未知模块: ${moduleId}`);
  const files = await discoverFiles(policy);
  const moduleFiles = files.filter((file) => moduleForFile(file, policy)?.id === moduleId);
  const manifest = moduleFiles.find((file) => path.basename(file) === "module.ts");
  const contracts = moduleFiles.filter((file) => path.basename(file).startsWith("contract."));
  const dependencyContracts = module.requires.flatMap((dependencyId) => {
    const dependencyFiles = files.filter(
      (file) => moduleForFile(file, policy)?.id === dependencyId,
    );
    return dependencyFiles
      .filter((file) => path.basename(file) === "contract.ts")
      .map((file) => `- ${posix(path.relative(cwd, file))}`);
  });
  return [
    `# Architecture context: ${module.id}`,
    `owner: ${module.owner ?? "unassigned"}`,
    `managed: ${module.managed}`,
    `requires: ${module.requires.join(", ") || "none"}`,
    "",
    "## Files",
    ...(manifest ? [`- ${posix(path.relative(cwd, manifest))}`] : ["- module.ts: missing"]),
    ...contracts.map((file) => `- ${posix(path.relative(cwd, file))}`),
    ...module.publicEntrypoints.map((entry) => `- public: ${entry}`),
    "",
    "## Direct dependency contracts",
    ...(dependencyContracts.length > 0 ? dependencyContracts : ["- none discovered"]),
    "",
    "## Boundaries",
    "- Cross-module imports must use declared requirements and public entrypoints.",
    "- Add a contract example and contract test before exposing a new capability.",
  ].join("\n");
}

export function formatReport(result) {
  const lines = [
    `architecture: ${result.newViolations.length === 0 ? "OK" : "FAILED"}`,
    `violations: ${result.violations.length}`,
    `baseline: ${result.baselineViolations.length}`,
    `new: ${result.newViolations.length}`,
  ];
  for (const item of result.newViolations)
    lines.push(`- ${item.rule} ${item.file}: ${item.message}`);
  return lines.join("\n");
}

export function formatMarkdownReport(result) {
  const lines = [
    `# Architecture report`,
    "",
    `- Status: **${result.newViolations.length === 0 ? "OK" : "FAILED"}**`,
    `- Violations: ${result.violations.length}`,
    `- Baseline: ${result.baselineViolations.length}`,
    `- New: ${result.newViolations.length}`,
  ];
  if (result.newViolations.length > 0) {
    lines.push("", "## New violations", "", "| Rule | File | Message |", "| --- | --- | --- |");
    for (const item of result.newViolations)
      lines.push(`| ${item.rule} | ${item.file} | ${item.message.replaceAll("|", "\\|")} |`);
  }
  return lines.join("\n");
}

export { loadPolicy };
