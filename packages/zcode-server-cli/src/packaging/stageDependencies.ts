import { access, chmod, cp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { ServerTarget } from "../runtime/manifest.js";

const NODE_BUILTIN_MODULES = new Set(builtinModules);

/** 提取 bundle 的顶层裸模块引用，并过滤 Node 内置模块。 */
export function collectBareModuleSpecifiers(source: string): Set<string> {
  const names = new Set<string>();
  const specifierPattern =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["']([^"'\n]+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = specifierPattern.exec(source)) !== null) {
    const specifier = match[1];
    if (!specifier || specifier.startsWith(".") || specifier.startsWith("/")) continue;
    if (specifier.startsWith("node:")) continue;
    const segments = specifier.split("/");
    const packageName = specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
    if (!packageName || NODE_BUILTIN_MODULES.has(packageName)) continue;
    names.add(packageName);
  }
  return names;
}

async function readPackageJson(packageDir: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

async function findDependencyDir(fromDir: string, name: string): Promise<string | null> {
  let current = resolve(fromDir);
  while (true) {
    const candidate = join(current, "node_modules", ...name.split("/"));
    if ((await readPackageJson(candidate)) !== null) return await realpath(candidate);
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** 从入口包集合递归解析 production + optional dependency 闭包。 */
export async function resolveProductionPackageClosure(
  entryPackageNames: readonly string[],
  nodeModulesDir: string,
  workspacePackageDirs: ReadonlyMap<string, string> = new Map(),
): Promise<Map<string, string>> {
  const closure = new Map<string, string>();
  const queue: Array<{ name: string; fromDir: string; optional: boolean }> = entryPackageNames.map(
    (name) => ({
      name,
      fromDir: dirname(resolve(nodeModulesDir)),
      optional: true,
    }),
  );

  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) break;
    const packageDir =
      (await findDependencyDir(item.fromDir, item.name)) ??
      workspacePackageDirs.get(item.name) ??
      null;
    if (!packageDir) {
      if (item.optional) continue;
      throw new Error(
        `Missing production dependency in workspace: ${item.name} (from ${item.fromDir})`,
      );
    }
    const existing = closure.get(item.name);
    if (existing) {
      // pnpm peer 依赖可能合法地解析到多个版本。发行根保留首个版本，包自身已知
      // peer 冲突的 nested node_modules 在复制阶段保留。
      continue;
    }
    closure.set(item.name, packageDir);

    const packageJson = await readPackageJson(packageDir);
    const dependencies = (packageJson?.dependencies ?? {}) as Record<string, string>;
    const optionalDependencies = (packageJson?.optionalDependencies ?? {}) as Record<
      string,
      string
    >;
    for (const dependencyName of Object.keys(dependencies)) {
      queue.push({
        name: dependencyName,
        fromDir: packageDir,
        optional: dependencyName in optionalDependencies,
      });
    }
    for (const dependencyName of Object.keys(optionalDependencies)) {
      queue.push({ name: dependencyName, fromDir: packageDir, optional: true });
    }
  }
  return closure;
}

/** node-pty 只保留运行文件与目标平台 prebuild，拒绝宿主 build 产物。 */
export function isNodePtyRuntimePath(relativePath: string, target: ServerTarget): boolean {
  const normalized = relativePath.split(sep).join("/");
  if (normalized === "" || normalized === "package.json") return true;
  // 运行文件白名单曾漏掉包内许可；模块拆分后也必须保留发行包所需声明。
  if (/^(?:LICENSE|NOTICE|COPYING)(?:[._-].*)?$/iu.test(normalized)) return true;
  if (normalized === "lib" || normalized.startsWith("lib/")) return true;
  if (normalized === "typings" || normalized.startsWith("typings/")) return true;
  return (
    normalized === "prebuilds" ||
    normalized === `prebuilds/${target}` ||
    normalized.startsWith(`prebuilds/${target}/`)
  );
}

export function isTargetSpecificPackage(packageName: string, target: ServerTarget): boolean {
  if (!packageName.startsWith("@mbears/opentui-core-")) return true;
  return packageName === `@mbears/opentui-core-${target}`;
}

export async function copyPackageDir(
  sourceDir: string,
  targetDir: string,
  filter?: (relativePath: string) => boolean,
  includeNestedNodeModules = false,
): Promise<void> {
  await cp(sourceDir, targetDir, {
    recursive: true,
    dereference: true,
    filter: (source) => {
      const relativePath = relative(sourceDir, source);
      if (relativePath === "") return true;
      if (
        !includeNestedNodeModules &&
        (relativePath === "node_modules" || relativePath.split(sep).includes("node_modules"))
      ) {
        return false;
      }
      return filter ? filter(relativePath) : true;
    },
  });
}

export async function pruneKoffiRuntime(
  sourceDir: string,
  targetDir: string,
  target: ServerTarget,
): Promise<void> {
  const [platform, architecture] = target.split("-");
  const targetKeys =
    platform === "linux"
      ? [`linux_${architecture}`, `musl_${architecture}`]
      : [`${platform}_${architecture}`];
  const sourceBuild = join(sourceDir, "build", "koffi");
  const targetBuild = join(targetDir, "build", "koffi");
  await rm(targetBuild, { recursive: true, force: true });
  await mkdir(targetBuild, { recursive: true });
  for (const targetKey of targetKeys) {
    const sourcePath = join(sourceBuild, targetKey);
    try {
      await access(sourcePath);
    } catch {
      continue;
    }
    await cp(sourcePath, join(targetBuild, targetKey), {
      recursive: true,
      dereference: true,
    });
  }
}

export async function ensureNodePtyPrebuild(
  options: { target: ServerTarget; workspaceNodeModulesDir: string },
  nodeModulesTargetDir: string,
): Promise<void> {
  const prebuildDir = join(nodeModulesTargetDir, "node-pty", "prebuilds", options.target);
  const ptyNodePath = join(prebuildDir, "pty.node");
  let hasPtyNode = true;
  try {
    await access(ptyNodePath);
  } catch {
    hasPtyNode = false;
  }
  if (!hasPtyNode) {
    const lydellDir = await findDependencyDir(
      dirname(resolve(options.workspaceNodeModulesDir)),
      `@lydell/node-pty-${options.target}`,
    );
    const lydellPtyNode = lydellDir
      ? join(lydellDir, "prebuilds", options.target, "pty.node")
      : null;
    if (!lydellPtyNode) {
      throw new Error(
        `Missing node-pty prebuild for ${options.target}: install @lydell/node-pty-${options.target}`,
      );
    }
    await mkdir(prebuildDir, { recursive: true });
    await cp(lydellPtyNode, ptyNodePath, { dereference: true });
  }
  const spawnHelperPath = join(prebuildDir, "spawn-helper");
  try {
    await access(spawnHelperPath);
    await chmod(spawnHelperPath, 0o755);
  } catch {
    // 非 darwin 平台没有 spawn-helper。
  }
}
