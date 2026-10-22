/**
 * 导入说明符解析器。
 *
 * 修复原因（2026-09 review）：首版 `resolveImport` 只解析 `./` `../` 开头的相对路径，
 * 其余全部返回 null 不建边。而本仓库主流写法是 `@zcode/<pkg>`、ui 的 `@/`、services 的 `#src/`，
 * 于是 module-dependency / deep-import / cycle / layer-direction / ui-implementation-import
 * 对跨包依赖全部失明（用 `@zcode/services/src/bots/botsService.js` 深导入实测 0 违规）。
 *
 * 这里按 Node 与 TypeScript 的真实解析顺序建边：
 *   1. 相对路径
 *   2. 最近 package.json 的 `imports`（`#src/*`）
 *   3. 最近 tsconfig.json 的 `compilerOptions.paths`（`@/*`）
 *   4. workspace 包名 + `exports`（含条件导出、通配符；`dist/` 目标回映到 `src/`）
 *      没有 exports 条目的子路径直接拼到包目录，保证深路径也能建边
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { parseConfigFileTextToJson } from "typescript";

export const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

const DEFAULT_WORKSPACE_GLOBS = ["packages/*", "apps/*", "apps/*/packages/*"];
const EXPORT_CONDITION_ORDER = ["import", "default", "node", "require", "types"];

async function readJsonLoose(file) {
  try {
    const text = await fs.readFile(file, "utf8");
    // 正则去注释会把 @/* 与后续 src/**/*.ts 串成块注释，漏掉 UI 别名甚至整个 Desktop 包。
    // 复用 TypeScript 的 JSONC 解析，只移除真正的注释，保留字符串与尾逗号语义。
    const result = parseConfigFileTextToJson(file, text);
    return result.error ? null : result.config;
  } catch {
    return null;
  }
}

async function expandGlob(cwd, pattern) {
  const segments = pattern.split("/").filter(Boolean);
  let current = [cwd];
  for (const segment of segments) {
    const next = [];
    for (const dir of current) {
      if (segment === "*") {
        let entries = [];
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (entry.isDirectory() && entry.name !== "node_modules")
            next.push(path.join(dir, entry.name));
        }
      } else {
        next.push(path.join(dir, segment));
      }
    }
    current = next;
  }
  return current;
}

async function workspaceGlobs(cwd) {
  try {
    const raw = parseYaml(await fs.readFile(path.join(cwd, "pnpm-workspace.yaml"), "utf8"));
    if (Array.isArray(raw?.packages) && raw.packages.length > 0) return raw.packages;
  } catch {
    // 没有 workspace 文件时退回默认目录约定
  }
  return DEFAULT_WORKSPACE_GLOBS;
}

export async function loadWorkspace(cwd = process.cwd()) {
  const dirs = new Set();
  for (const glob of await workspaceGlobs(cwd)) {
    for (const dir of await expandGlob(cwd, glob)) dirs.add(dir);
  }
  const packages = [];
  for (const dir of dirs) {
    const manifest = await readJsonLoose(path.join(dir, "package.json"));
    if (!manifest) continue;
    const tsconfig = await readJsonLoose(path.join(dir, "tsconfig.json"));
    const paths = tsconfig?.compilerOptions?.paths ?? null;
    const baseUrl = tsconfig?.compilerOptions?.baseUrl ?? ".";
    packages.push({
      name: typeof manifest.name === "string" ? manifest.name : null,
      dir,
      exports: manifest.exports ?? null,
      imports: manifest.imports ?? null,
      main: typeof manifest.main === "string" ? manifest.main : null,
      paths,
      pathsBase: path.resolve(dir, baseUrl),
    });
  }
  packages.sort((a, b) => b.dir.length - a.dir.length);
  const byName = new Map();
  for (const pkg of packages) if (pkg.name) byName.set(pkg.name, pkg);
  return { cwd, packages, byName };
}

function nearestPackage(file, workspace) {
  return workspace.packages.find((pkg) => file.startsWith(`${pkg.dir}${path.sep}`)) ?? null;
}

/** 在 exports/imports/paths 这类映射里匹配 key，支持单个 `*` 通配。 */
function matchMap(map, key) {
  if (!map || typeof map !== "object") return null;
  if (Object.hasOwn(map, key)) return { value: map[key], wildcard: null };
  for (const [pattern, value] of Object.entries(map)) {
    const star = pattern.indexOf("*");
    if (star < 0) continue;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (key.startsWith(prefix) && key.endsWith(suffix) && key.length >= pattern.length - 1) {
      return { value, wildcard: key.slice(prefix.length, key.length - suffix.length) };
    }
  }
  return null;
}

function targetsOf(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(targetsOf);
  if (value && typeof value === "object") {
    const ordered = EXPORT_CONDITION_ORDER.filter((key) => key in value).map((key) => value[key]);
    const rest = Object.entries(value)
      .filter(([key]) => !EXPORT_CONDITION_ORDER.includes(key))
      .map(([, item]) => item);
    return [...ordered, ...rest].flatMap(targetsOf);
  }
  return [];
}

function substitute(target, wildcard) {
  return wildcard === null ? target : target.replace("*", wildcard);
}

function stripExtension(base) {
  if (base.endsWith(".d.ts")) return base.slice(0, -".d.ts".length);
  const extension = SOURCE_EXTENSIONS.find((item) => base.endsWith(item));
  return extension ? base.slice(0, -extension.length) : base;
}

function probe(absolute, knownFiles) {
  const base = stripExtension(absolute);
  const candidates = [];
  for (const extension of SOURCE_EXTENSIONS) candidates.push(`${base}${extension}`);
  for (const extension of SOURCE_EXTENSIONS) candidates.push(path.join(base, `index${extension}`));
  const found = candidates.find((candidate) => knownFiles.has(candidate));
  if (found) return found;
  // CLI 侧包的 exports 指向 dist/，源码在 src/；按同名路径回映。
  const distIndex = base.split(path.sep).lastIndexOf("dist");
  if (distIndex >= 0) {
    const parts = base.split(path.sep);
    parts[distIndex] = "src";
    return probe(parts.join(path.sep), knownFiles);
  }
  return null;
}

export function resolveSpecifier(from, specifier, knownFiles, workspace = null) {
  if (specifier.startsWith(".")) {
    return probe(path.resolve(path.dirname(from), specifier), knownFiles);
  }
  if (!workspace) return null;
  const pkg = nearestPackage(from, workspace);

  if (specifier.startsWith("#") && pkg?.imports) {
    const hit = matchMap(pkg.imports, specifier);
    if (hit) {
      for (const target of targetsOf(hit.value)) {
        const found = probe(path.resolve(pkg.dir, substitute(target, hit.wildcard)), knownFiles);
        if (found) return found;
      }
    }
  }

  if (pkg?.paths) {
    const hit = matchMap(pkg.paths, specifier);
    if (hit) {
      for (const target of targetsOf(hit.value)) {
        const found = probe(
          path.resolve(pkg.pathsBase, substitute(target, hit.wildcard)),
          knownFiles,
        );
        if (found) return found;
      }
    }
  }

  let owner = null;
  for (const [name, candidate] of workspace.byName) {
    if (specifier === name || specifier.startsWith(`${name}/`)) {
      if (!owner || name.length > owner.name.length) owner = candidate;
    }
  }
  if (!owner) return null;
  const subpath = specifier === owner.name ? "." : `./${specifier.slice(owner.name.length + 1)}`;
  const candidates = [];
  const hit = matchMap(owner.exports, subpath);
  if (hit)
    candidates.push(...targetsOf(hit.value).map((target) => substitute(target, hit.wildcard)));
  if (subpath === ".") {
    if (owner.main) candidates.push(owner.main);
    candidates.push("./src/index", "./index");
  } else {
    // 没有 exports 条目（或 exports 缺失）的深路径直接拼到包目录，再试 src/ 前缀：这类导入正是要拦的对象。
    candidates.push(subpath, `./src/${subpath.slice(2)}`);
  }
  for (const candidate of candidates) {
    const found = probe(path.resolve(owner.dir, candidate), knownFiles);
    if (found) return found;
  }
  return null;
}
