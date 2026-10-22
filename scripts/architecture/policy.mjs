import { promises as fs } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { parse as parseYaml } from "yaml";
import { SOURCE_EXTENSIONS, resolveSpecifier } from "./resolver.mjs";
import { isSnapshotPath } from "./upstream-snapshot.mjs";

export { SOURCE_EXTENSIONS };

export function posix(value) {
  return value.split(path.sep).join("/");
}

export function isSourceFile(file) {
  return SOURCE_EXTENSIONS.some((extension) => file.endsWith(extension));
}

async function walk(root, files) {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (["node_modules", "dist", "out", "coverage", ".git"].includes(entry.name)) continue;
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) await walk(target, files);
    // 契约文档也是必需产物；只枚举源码会把实际存在的 CONTRACT.md 误报为缺失。
    else if (entry.isFile() && (isSourceFile(target) || entry.name === "CONTRACT.md"))
      files.push(target);
  }
}

function validatePolicy(raw, cwd) {
  if (!raw || raw.version !== 1 || !Array.isArray(raw.modules)) {
    throw new Error("architecture-policy.yaml 必须包含 version: 1 和 modules 数组");
  }
  const ids = new Set();
  const modules = raw.modules.map((module) => {
    if (!module?.id || ids.has(module.id))
      throw new Error(`模块 id 重复或为空: ${module?.id ?? ""}`);
    ids.add(module.id);
    if (!Array.isArray(module.roots) || module.roots.length === 0) {
      throw new Error(`模块 ${module.id} 必须声明 roots`);
    }
    return {
      id: module.id,
      roots: module.roots.map((root) => path.resolve(cwd, root)),
      managed: module.managed === true,
      requires: [...new Set(module.requires ?? [])],
      publicEntrypoints: (module.publicEntrypoints ?? []).map((entry) => posix(entry)),
      layers: module.layers ?? {},
      layerOrder: module.layerOrder ?? Object.keys(module.layers ?? {}),
      owner: module.owner ?? null,
    };
  });
  const moduleIds = new Set(modules.map((module) => module.id));
  for (const module of modules) {
    for (const dependency of module.requires) {
      if (!moduleIds.has(dependency))
        throw new Error(`模块 ${module.id} 依赖未知模块 ${dependency}`);
    }
  }
  const global = {
    maxFileLines: raw.global?.maxFileLines ?? 800,
    maxContractLines: raw.global?.maxContractLines ?? 300,
    forbidCycles: raw.global?.forbidCycles !== false,
    forbidDeepImports: raw.global?.forbidDeepImports !== false,
    managedOnly: raw.global?.managedOnly !== false,
    maxPublicMethods: raw.global?.maxPublicMethods ?? 12,
    // 新增源码文件必须落在 managed 模块内；这是"新代码走这套约束"的唯一机械保证。
    newFilesRequireManagedModule: raw.global?.newFilesRequireManagedModule !== false,
    newFileScopes: raw.global?.newFileScopes ?? ["packages", "apps"],
    // 规则生效时间点：首次进入 git 历史早于该日期的文件不受 unmanaged-new-file 追溯。
    // 原因：长期分支相对 merge-base 有几百个提交的"新增"文件，它们写在规则存在之前；
    // 用共享 baseline 兜会让各分支互相冲突，用生效日期则各分支一致且无需登记。
    newFilesEnforcedSince: raw.global?.newFilesEnforcedSince
      ? String(raw.global.newFilesEnforcedSince)
      : null,
    acceptedUpstreamCommits: raw.global?.acceptedUpstreamCommits ?? [],
    acceptedUpstreamSnapshot: raw.global?.acceptedUpstreamSnapshot ?? null,
  };
  if (
    !Array.isArray(global.acceptedUpstreamCommits) ||
    global.acceptedUpstreamCommits.some(
      (entry) =>
        !entry ||
        !/^[a-f0-9]{40}$/.test(entry.commit ?? "") ||
        !/^[a-f0-9]{40}$/.test(entry.previousHead ?? "") ||
        typeof entry.reason !== "string" ||
        !entry.reason.trim(),
    )
  ) {
    throw new Error("acceptedUpstreamCommits 必须包含完整 commit、previousHead SHA 和非空 reason");
  }
  if (
    global.acceptedUpstreamSnapshot !== null &&
    (!isSnapshotPath(global.acceptedUpstreamSnapshot) || global.acceptedUpstreamCommits.length)
  ) {
    throw new Error(
      "acceptedUpstreamSnapshot 必须为仓库相对路径，且不能与 acceptedUpstreamCommits 混用",
    );
  }
  const exceptions = (raw.exceptions ?? []).map((exception) => ({
    ...exception,
    paths: exception.paths ?? [],
  }));
  return { version: 1, modules, global, exceptions };
}

export function layerForFile(file, module) {
  const matches = module.roots
    .flatMap((root) =>
      Object.entries(module.layers).map(([name, directory]) => ({
        name,
        directory: path.resolve(root, directory),
      })),
    )
    .filter(({ directory }) => file === directory || file.startsWith(`${directory}${path.sep}`))
    .sort((a, b) => b.directory.length - a.directory.length);
  return matches[0]?.name ?? null;
}

export function publicEntrypointMatches(target, targetModule, cwd) {
  return targetModule.publicEntrypoints.some((entry) => {
    const candidates = [
      path.resolve(cwd, entry),
      ...targetModule.roots.map((root) => path.resolve(root, entry)),
    ];
    return candidates.includes(target);
  });
}

export function manifestRequires(source) {
  const match = source.match(/requires\s*:\s*\[([^\]]*)\]/s);
  if (!match) return null;
  return [...match[1].matchAll(/["']([^"']+)["']/g)].map((item) => item[1]);
}

export function countPublicMethods(source) {
  const sourceFile = ts.createSourceFile("contract.ts", source, ts.ScriptTarget.Latest, true);
  let count = 0;
  function visit(node) {
    if (ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node)) {
      for (const member of node.members) {
        if (
          ts.isMethodSignature(member) ||
          ts.isMethodDeclaration(member) ||
          ts.isCallSignatureDeclaration(member)
        )
          count += 1;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return count;
}

export async function loadPolicy(cwd = process.cwd()) {
  const filename = path.join(cwd, "architecture-policy.yaml");
  const content = await fs.readFile(filename, "utf8");
  return validatePolicy(parseYaml(content), cwd);
}

export function moduleForFile(file, policy) {
  const candidates = policy.modules
    .filter((module) =>
      module.roots.some((root) => file === root || file.startsWith(`${root}${path.sep}`)),
    )
    .sort(
      (a, b) =>
        Math.max(...b.roots.map((root) => root.length)) -
        Math.max(...a.roots.map((root) => root.length)),
    );
  return candidates[0] ?? null;
}

export async function discoverFiles(policy) {
  const files = [];
  for (const module of policy.modules) {
    for (const root of module.roots) await walk(root, files);
  }
  return [...new Set(files)].sort();
}

export function resolveImport(from, specifier, knownFiles, workspace = null) {
  return resolveSpecifier(from, specifier, knownFiles, workspace);
}

/**
 * 返回 [{ specifier, typeOnly }]。typeOnly 覆盖 `import type {}`、`export type {}` 以及
 * 所有具名成员都是 `type` 修饰的情况；它们不产生运行时依赖，domain-io 不应把
 * `import type { Stats } from "node:fs"` 当成 IO。模块边界与深导入仍然按边计算。
 */
export function importDeclarationsOf(file, source) {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const imports = [];
  function visit(node) {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier) {
      const clause = node.importClause;
      const named = clause?.namedBindings;
      const allMembersTypeOnly =
        !!clause &&
        !clause.name &&
        !!named &&
        ts.isNamedImports(named) &&
        named.elements.length > 0 &&
        named.elements.every((element) => element.isTypeOnly);
      imports.push({
        specifier: node.moduleSpecifier.text,
        typeOnly: !!clause?.isTypeOnly || allMembersTypeOnly,
      });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      imports.push({ specifier: node.moduleSpecifier.text, typeOnly: !!node.isTypeOnly });
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      imports.push({ specifier: node.moduleReference.expression.text, typeOnly: false });
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return imports;
}

export function importsOf(file, source) {
  return importDeclarationsOf(file, source).map((item) => item.specifier);
}

export function isException(policy, rule, file, cwd) {
  const relative = posix(path.relative(cwd, file));
  return policy.exceptions.some(
    (exception) =>
      exception.rule === rule &&
      exception.paths.some(
        (pattern) => relative === pattern || relative.startsWith(pattern.replace(/\*\*$/, "")),
      ),
  );
}
