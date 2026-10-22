import { promises as fs } from "node:fs";
import path from "node:path";

import {
  countPublicMethods,
  discoverFiles,
  importDeclarationsOf,
  isException,
  layerForFile,
  loadPolicy,
  manifestRequires,
  moduleForFile,
  posix,
  publicEntrypointMatches,
  resolveImport,
} from "./policy.mjs";
import { loadWorkspace } from "./resolver.mjs";
import { cycleViolations, unmanagedNewFileViolations, violation } from "./violations.mjs";

async function readBaseline(cwd) {
  try {
    return JSON.parse(await fs.readFile(path.join(cwd, ".architecture-baseline.json"), "utf8"));
  } catch {
    return { version: 1, violations: [] };
  }
}

export async function checkArchitecture({
  cwd = process.cwd(),
  changedFiles = null,
  addedFiles = null,
} = {}) {
  const policy = await loadPolicy(cwd);
  const workspace = await loadWorkspace(cwd);
  const files = await discoverFiles(policy);
  const knownFiles = new Set(files);
  const modulesByFile = new Map(files.map((file) => [file, moduleForFile(file, policy)]));
  const edges = new Map(files.map((file) => [file, []]));
  const violations = [];
  const manifestRequiresByModule = new Map();
  const moduleIds = new Set(policy.modules.map((module) => module.id));

  const today = new Date().toISOString().slice(0, 10);
  for (const exception of policy.exceptions) {
    if (exception.expires && exception.expires < today) {
      violations.push(
        violation({
          cwd,
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
    if (manifest) {
      const declared = manifestRequires(await fs.readFile(manifest, "utf8"));
      if (declared) {
        manifestRequiresByModule.set(module.id, declared);
        // manifest-policy-mismatch：文档写"策略与模块声明必须互相校验"，首版只是优先读 module.ts。
        const unknown = declared.filter((id) => !moduleIds.has(id));
        const onlyInManifest = declared.filter((id) => !module.requires.includes(id));
        const onlyInPolicy = module.requires.filter((id) => !declared.includes(id));
        if (unknown.length || onlyInManifest.length || onlyInPolicy.length) {
          const parts = [];
          if (unknown.length) parts.push(`未知模块 ${unknown.join(", ")}`);
          if (onlyInManifest.length) parts.push(`仅 module.ts 声明 ${onlyInManifest.join(", ")}`);
          if (onlyInPolicy.length) parts.push(`仅 policy 声明 ${onlyInPolicy.join(", ")}`);
          violations.push(
            violation({
              cwd,
              rule: "manifest-policy-mismatch",
              file: manifest,
              detail: parts.join("; "),
              module,
              message: `module.ts 与 architecture-policy.yaml 的 requires 不一致：${parts.join("；")}`,
            }),
          );
        }
      }
    }
    const required = [
      "module.ts",
      "contract.ts",
      "contract.example.ts",
      "contract.test.ts",
      "CONTRACT.md",
    ];
    for (const artifact of required) {
      // 修复原因：discoverFiles 只收集源码扩展名，CONTRACT.md 永远不在 moduleFiles 里，
      // 首版对每个 managed 模块都会误报缺少 CONTRACT.md（--changed 下被 scope 过滤掉才没暴露）。
      const present = (
        await Promise.all(
          module.roots.map((root) =>
            fs.stat(path.join(root, artifact)).then(
              () => true,
              () => false,
            ),
          ),
        )
      ).some(Boolean);
      if (!present) {
        violations.push(
          violation({
            cwd,
            rule: "missing-module-artifact",
            file: module.roots[0],
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
    if (!module) continue;
    const source = await fs.readFile(file, "utf8");
    const declarations = importDeclarationsOf(file, source);
    // 边对所有文件建立（含 unmanaged），否则 --changed 的反向闭包与环检测都会缺边；规则只对 managed 生效。
    for (const { specifier } of declarations) {
      const target = resolveImport(file, specifier, knownFiles, workspace);
      if (target) edges.get(file).push(target);
    }
    if (policy.global.managedOnly && !module.managed) continue;

    const lines = source.split(/\r?\n/).length;
    if (lines > policy.global.maxFileLines && !isException(policy, "max-file-lines", file, cwd)) {
      violations.push(
        violation({
          cwd,
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
          cwd,
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
          cwd,
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
          cwd,
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
    for (const { specifier, typeOnly } of declarations) {
      if (
        importerLayer === "domain" &&
        !typeOnly &&
        /^(node:|fs$|path$|http$|https$|net$|child_process$|timers$|electron$|electron\/)/.test(
          specifier,
        )
      ) {
        violations.push(
          violation({
            cwd,
            rule: "domain-io",
            file,
            detail: specifier,
            module,
            message: "domain 层不能依赖 IO、进程、网络、定时器或 electron",
          }),
        );
      }
      const target = resolveImport(file, specifier, knownFiles, workspace);
      if (!target) continue;
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
              cwd,
              rule: "layer-direction",
              file,
              detail: target,
              module,
              message: `层 ${importerLayer} 不能依赖更高层 ${targetLayer}`,
            }),
          );
        }
      }
      // 修复原因：首版以 module.id === "ui" 触发，而 ui 是 unmanaged 模块，规则从未执行；改为按层触发。
      if (
        (importerLayer === "ui" || module.id === "ui") &&
        /(?:^|\/)(repo|repos|repository|runtime|services?)(?:\/|$)/i.test(
          posix(path.relative(cwd, target)),
        )
      ) {
        violations.push(
          violation({
            cwd,
            rule: "ui-implementation-import",
            file,
            detail: target,
            module,
            message:
              "UI 层不能直接依赖 Repo、Runtime 或 Service 实现；通过本模块 contract/port 访问",
          }),
        );
      }
      if (!targetModule || targetModule.id === module.id) continue;
      const declaredRequires = manifestRequiresByModule.get(module.id) ?? module.requires;
      if (!declaredRequires.includes(targetModule.id)) {
        violations.push(
          violation({
            cwd,
            rule: "module-dependency",
            file,
            detail: target,
            module,
            message: `模块 ${module.id} 未声明依赖 ${targetModule.id}（import "${specifier}"）`,
          }),
        );
      }
      if (policy.global.forbidDeepImports && targetModule.publicEntrypoints.length > 0) {
        if (!publicEntrypointMatches(target, targetModule, cwd)) {
          violations.push(
            violation({
              cwd,
              rule: "deep-import",
              file,
              detail: target,
              module,
              message: `跨模块只能通过公开入口访问 ${posix(path.relative(cwd, target))}（import "${specifier}"）`,
            }),
          );
        }
      }
    }
    if (importerLayer === "domain" && /\b(fetch|setTimeout|setInterval)\s*\(/.test(source)) {
      violations.push(
        violation({
          cwd,
          rule: "domain-io",
          file,
          detail: "runtime-call",
          module,
          message: "domain 层不能依赖 IO、进程、网络或定时器",
        }),
      );
    }
  }

  if (policy.global.forbidCycles)
    violations.push(...cycleViolations(edges, policy, modulesByFile, cwd));
  if (addedFiles) violations.push(...unmanagedNewFileViolations(addedFiles, policy, cwd));

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
  return {
    policy,
    violations: scoped,
    baselineViolations,
    newViolations,
    baseline,
    changedClosure: changed,
  };
}

/**
 * scope 为 --changed 的变更闭包。修复原因：首版直接用 scoped 结果覆盖整份 baseline，
 * `baseline:update -- --changed` 会把闭包之外的所有条目全部丢掉。
 */
export async function updateBaseline({ cwd = process.cwd(), violations, scope = null }) {
  const filename = path.join(cwd, ".architecture-baseline.json");
  const previous = scope ? (await readBaseline(cwd)).violations : [];
  const kept = scope
    ? previous.filter((item) => !item.global && !scope.has(path.resolve(cwd, item.file)))
    : [];
  const merged = new Map();
  for (const item of [...kept, ...violations]) merged.set(item.fingerprint, item);
  const entries = [...merged.values()].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
  await fs.writeFile(filename, `${JSON.stringify({ version: 1, violations: entries }, null, 2)}\n`);
  return entries;
}

export { loadPolicy };
export { addedFilesFromGit, changedFilesFromGit, resolveDiffBase } from "./git-base.mjs";
export { generateContext } from "./context.mjs";
export { formatMarkdownReport, formatReport } from "./report.mjs";
