/* eslint-disable max-lines -- 发行包 staging 流程按步骤线性组装，oxfmt 换行后略超 400 行，拆分会增加跨步骤状态同步。 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, cp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createRuntimeManifest, type ServerTarget } from "../runtime/manifest.js";
import { isTarCommand, resolveHostTarCommand } from "./tarCommand.js";

const NODE_BUILTIN_MODULES = new Set(builtinModules);

/**
 * 从 bundle 产物中提取顶层裸模块引用（`from "x"` / `import("x")` / `require("x")`）。
 * 结果只做语法归一化（scoped 包取前两段），是否为真实 npm 包由调用方与
 * workspace node_modules 求交集决定；node 内置模块在这里直接过滤。
 */
export function collectBareModuleSpecifiers(source: string): Set<string> {
  const names = new Set<string>();
  const specifierPattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["']([^"'\n]+)["']/g;
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
    return JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * 按 Node 解析规则的简化版，从依赖者真实目录逐级向上定位 `node_modules/<name>`。
 * 不走 main/exports 入口解析，因此对 exports 收紧或 types-only 的包同样适用；
 * pnpm（依赖在 `.pnpm/<pkg>/node_modules` 同级）与 npm 扁平布局都能命中。
 */
async function findDependencyDir(fromDir: string, name: string): Promise<string | null> {
  let current = resolve(fromDir);
  while (true) {
    const candidate = join(current, "node_modules", ...name.split("/"));
    if ((await readPackageJson(candidate)) !== null) {
      return await realpath(candidate);
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * 从入口包集合出发递归收集生产依赖闭包（dependencies + optionalDependencies）。
 * 返回 包名 → 真实目录。同名包解析到不同真实目录时报错：扁平发行布局放不下两个版本，
 * 静默选一个会把版本漂移带进发行包。optional 依赖缺失时跳过。
 */
export async function resolveProductionPackageClosure(
  entryPackageNames: readonly string[],
  nodeModulesDir: string,
  workspacePackageDirs: ReadonlyMap<string, string> = new Map(),
): Promise<Map<string, string>> {
  const closure = new Map<string, string>();
  const queue: Array<{ name: string; fromDir: string; optional: boolean }> = entryPackageNames.map(
    (name) => ({ name, fromDir: dirname(resolve(nodeModulesDir)), optional: true }),
  );

  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) break;
    const packageDir = (await findDependencyDir(item.fromDir, item.name)) ?? workspacePackageDirs.get(item.name) ?? null;
    if (!packageDir) {
      if (item.optional) continue;
      throw new Error(`Missing production dependency in workspace: ${item.name} (from ${item.fromDir})`);
    }
    const existing = closure.get(item.name);
    if (existing) {
      if (existing !== packageDir) {
        // pnpm peer 依赖可能合法地同时存在多个版本（典型是 ajv6 + ajv8）。
        // 顶层保留最先解析的版本，包自身 nested node_modules 在复制阶段保留，
        // 让 Node 的局部解析规则选择正确 peer；不能把合法的 Agent bundle 拒绝 staging。
        continue;
      }
      continue;
    }
    closure.set(item.name, packageDir);

    const packageJson = await readPackageJson(packageDir);
    const dependencies = (packageJson?.dependencies ?? {}) as Record<string, string>;
    const optionalDependencies = (packageJson?.optionalDependencies ?? {}) as Record<string, string>;
    for (const dependencyName of Object.keys(dependencies)) {
      queue.push({ name: dependencyName, fromDir: packageDir, optional: dependencyName in optionalDependencies });
    }
    for (const dependencyName of Object.keys(optionalDependencies)) {
      queue.push({ name: dependencyName, fromDir: packageDir, optional: true });
    }
  }
  return closure;
}

/**
 * node-pty 运行时白名单。必须剔除 `build/`：那是宿主平台的编译产物，而 node-pty 的
 * loadNativeModule 按 build/Release → build/Debug → prebuilds/<platform>-<arch> 顺序加载，
 * 交叉打包时留下 build/ 会让目标机优先载入错误架构的 pty.node 直接崩溃。
 * 非目标平台的 prebuilds 一并剔除，控制发行包体积。
 */
export function isNodePtyRuntimePath(relativePath: string, target: ServerTarget): boolean {
  const normalized = relativePath.split(sep).join("/");
  if (normalized === "" || normalized === "package.json") return true;
  // 修复：node-pty 的运行时白名单曾漏掉包内许可文件，发行包里只有代码没有声明。
  if (/^(?:LICENSE|NOTICE|COPYING)(?:[._-].*)?$/iu.test(normalized)) return true;
  if (normalized === "lib" || normalized.startsWith("lib/")) return true;
  if (normalized === "typings" || normalized.startsWith("typings/")) return true;
  if (normalized === "prebuilds" || normalized === `prebuilds/${target}` || normalized.startsWith(`prebuilds/${target}/`)) {
    return true;
  }
  return false;
}

function isTargetSpecificPackage(packageName: string, target: ServerTarget): boolean {
  if (!packageName.startsWith("@mbears/opentui-core-")) return true;
  return packageName === `@mbears/opentui-core-${target}`;
}

export interface StageOptions {
  target: ServerTarget;
  appVersion: string;
  /** tsup 产物目录（server-cli.js / server-core.js） */
  distDir: string;
  /** 既有 CLI/Agent bundle（zcode.cjs，自包含 CJS） */
  agentBundlePath: string;
  /** 已准备好的目标平台 Node 二进制 */
  nodeBinaryPath: string;
  /** 构建入口从统一合规 owner（scripts/third-party-notices.mjs）读取后传入；组件组装不能自行拼凑许可。 */
  notices: { thirdParty: string; node: string; nodeSource: string };
  /** 依赖闭包解析与复制的来源 node_modules */
  workspaceNodeModulesDir: string;
  /** 未被 pnpm 链接到 node_modules 的 workspace 包（例如 @zcode/tui）。 */
  workspacePackageDirs?: ReadonlyMap<string, string>;
  /** 发行目录的输出父目录 */
  outputDir: string;
  /** 已准备好的 native search tools 根目录（tools/<id>/<binary>）。 */
  nativeToolsDir?: string;
  /** 官方插件源码或已 seed 的 packages 目录。 */
  officialPluginsDir?: string;
  /** 是否同时产出 tar.gz（默认 true） */
  archive?: boolean;
}

export interface StagedRelease {
  releaseDir: string;
  archivePath: string | null;
  componentArchivePaths: string[];
  packagedDependencies: string[];
}

const POSIX_LAUNCHER = `#!/bin/sh
# 由 zcode-server staging 生成：定位发行根后用随包 Node 启动 Server CLI。
DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec "$DIR/runtime/node" "$DIR/runtime/server-cli.js" "$@"
`;

const WINDOWS_LAUNCHER = [
  "@echo off",
  "set \"DIR=%~dp0..\"",
  "\"%DIR%\\runtime\\node.exe\" \"%DIR%\\runtime\\server-cli.js\" %*",
  "",
].join("\r\n");

async function copyPackageDir(sourceDir: string, targetDir: string, filter?: (relativePath: string) => boolean, includeNestedNodeModules = false): Promise<void> {
  await cp(sourceDir, targetDir, {
    recursive: true,
    dereference: true,
    filter: (source) => {
      const relativePath = relative(sourceDir, source);
      if (relativePath === "") return true;
      // 包内嵌套 node_modules 不复制：闭包解析已把传递依赖平铺到发行 node_modules。
      if (!includeNestedNodeModules && (relativePath === "node_modules" || relativePath.split(sep).includes("node_modules"))) return false;
      return filter ? filter(relativePath) : true;
    },
  });
}

async function runCommand(command: string, args: readonly string[], cwd: string): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    // macOS 自带 tar 默认把 Finder extended attributes 写成 AppleDouble `._*` 条目。
    // 发行包会在 Linux/Windows 解压时把这些宿主元数据落成真实文件，既污染文件树，
    // 也会让组件 hash 在下载端与目标机不一致；关闭 copyfile 元数据后再生成归档。
    // Windows 侧传入的是 System32 tar.exe 绝对路径，同样命中该判断。
    const env = isTarCommand(command) ? { ...process.env, COPYFILE_DISABLE: "1" } : process.env;
    const child = spawn(command, [...args], { cwd, env, stdio: ["ignore", "inherit", "inherit"] });
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "null"}`));
    });
  });
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await (await import("node:fs/promises")).readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = entry.name;
    const absolutePath = join(root, relativePath);
    if (entry.isDirectory()) {
      for (const nested of await listFiles(absolutePath)) files.push(join(relativePath, nested));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files.sort();
}

async function hashPaths(root: string, paths: readonly string[]): Promise<{ sha256: string; sizeBytes: number }> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for (const relativePath of [...paths].sort()) {
    const absolutePath = join(root, relativePath);
    const stat = await (await import("node:fs/promises")).stat(absolutePath);
    const files = stat.isDirectory() ? (await listFiles(absolutePath)).map((file) => join(relativePath, file)) : [relativePath];
    for (const file of files.sort()) {
      const contents = await readFile(join(root, file));
      hash.update(`${file}\0`);
      hash.update(contents);
      sizeBytes += contents.byteLength;
    }
  }
  return { sha256: hash.digest("hex"), sizeBytes };
}

async function copyDirectoryIfPresent(sourceDir: string | undefined, targetDir: string): Promise<string[]> {
  if (!sourceDir) return [];
  try {
    await access(sourceDir);
  } catch {
    return [];
  }
  const names = (await (await import("node:fs/promises")).readdir(sourceDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.endsWith("-plugin"))
    .map((entry) => entry.name)
    .filter((name) => name !== "superpowers-plugin")
    .sort();
  for (const name of names) {
    await copyPackageDir(join(sourceDir, name), join(targetDir, name));
  }
  return names.map((name) => name.replace(/-plugin$/u, ""));
}

async function copyNativeTools(sourceDir: string | undefined, targetDir: string, target: ServerTarget): Promise<string[]> {
  if (!sourceDir) return [];
  try {
    await access(sourceDir);
  } catch {
    return [];
  }
  const ids = target.startsWith("win32-") ? ["ripgrep", "ugrep"] : ["bfs", "ripgrep", "ugrep"];
  const copied: string[] = [];
  for (const id of ids) {
    const source = join(sourceDir, id, id === "ripgrep" ? (target.startsWith("win32-") ? "rg.exe" : "rg") : id + (target.startsWith("win32-") ? ".exe" : ""));
    try {
      await access(source);
    } catch {
      continue;
    }
    const targetPath = join(targetDir, id, source.split(sep).pop() ?? id);
    await mkdir(dirname(targetPath), { recursive: true });
    await cp(source, targetPath, { dereference: true });
    // 修复：只复制可执行文件会让独立 native-search-tools 组件丢失已准备的声明。
    for (const notice of ["THIRD-PARTY-NOTICES.txt", "SOURCES.json"]) {
      const bytes = await readFile(join(dirname(source), notice));
      if (!bytes.length) throw new Error(`Empty native notice: ${notice}`);
      await writeFile(join(dirname(targetPath), notice), bytes);
    }
    if (!target.startsWith("win32-")) await chmod(targetPath, 0o755);
    copied.push(id);
  }
  return copied;
}

async function createComponentArchive(
  releaseDir: string,
  outputDir: string,
  target: ServerTarget,
  id: string,
  paths: readonly string[],
): Promise<{ archivePath: string; sha256: string; sizeBytes: number }> {
  const info = await hashPaths(releaseDir, paths);
  const componentRoot = join(outputDir, ".components", `${id}-${info.sha256.slice(0, 12)}`);
  await rm(componentRoot, { force: true, recursive: true });
  await mkdir(componentRoot, { recursive: true });
  for (const relativePath of paths) {
    const source = join(releaseDir, relativePath);
    try {
      await access(source);
    } catch {
      continue;
    }
    const targetPath = join(componentRoot, relativePath);
    await mkdir(dirname(targetPath), { recursive: true });
    await cp(source, targetPath, { recursive: true, dereference: true });
  }
  const extension = target.startsWith("win32-") ? "zip" : "tar.gz";
  const archivePath = join(outputDir, "components", target, `${id}-${info.sha256}.${extension}`);
  await mkdir(dirname(archivePath), { recursive: true });
  await rm(archivePath, { force: true });
  // Windows 宿主无 zip 命令且 Git Bash 的 GNU tar 不可用（详见
  // tarCommand.ts）；所有 tar 调用显式 System32 bsdtar。POSIX 宿主打 zip 继续用 zip 命令。
  const tarCommand = resolveHostTarCommand();
  if (extension === "zip") {
    if (process.platform === "win32") await runCommand(tarCommand, ["-acf", archivePath, "."], componentRoot);
    else await runCommand("zip", ["-qr", archivePath, "."], componentRoot);
  } else if (process.platform === "win32") {
    await runCommand(tarCommand, ["-czf", archivePath, "."], componentRoot);
  } else await runCommand("tar", ["-czf", archivePath, "."], componentRoot);
  await rm(componentRoot, { force: true, recursive: true });
  return { archivePath, ...info };
}

/** 组装 `zcode-server-<os>-<arch>/` 发行目录；只做本地组装，不上传、不发布。 */
export async function stageRelease(options: StageOptions): Promise<StagedRelease> {
  for (const [name, value] of Object.entries(options.notices)) {
    if (!value.trim()) throw new Error(`Missing distribution notice: ${name}`);
  }
  const releaseName = `zcode-server-${options.target}`;
  const outputRoot = resolve(options.outputDir);
  const releaseDir = join(outputRoot, releaseName);
  const runtimeDir = join(releaseDir, "runtime");
  await rm(releaseDir, { force: true, recursive: true });
  // staging 是发布目录的重建操作：删除同 target 的旧组件归档，避免上一次构建的
  // hash 仍被误上传到 CDN，导致 catalog 暴露无法与本次 manifest 对齐的组件。
  await rm(join(outputRoot, "components", options.target), { force: true, recursive: true });
  await rm(join(outputRoot, ".components"), { force: true, recursive: true });
  await mkdir(join(releaseDir, "bin"), { recursive: true });
  await mkdir(runtimeDir, { recursive: true });
  // 每个可独立下载的组件都要带适用声明，并在计算组件哈希前写入。
  await writeFile(join(runtimeDir, "THIRD-PARTY-NOTICES.md"), options.notices.thirdParty);
  await writeFile(join(runtimeDir, "LICENSE.node.txt"), options.notices.node);
  await writeFile(join(runtimeDir, "NODE-SOURCES.json"), options.notices.nodeSource);
  for (const component of ["agent", "official-plugins"]) {
    await mkdir(join(runtimeDir, "licenses", component), { recursive: true });
    await writeFile(join(runtimeDir, "licenses", component, "THIRD-PARTY-NOTICES.md"), options.notices.thirdParty);
  }

  // 入口 bundle 与 sourcemap 同名复制，文件名必须与 cli.ts 的相对路径解析保持一致。
  const bundleSources: string[] = [];
  for (const entryName of ["server-cli.js", "server-core.js"]) {
    const sourcePath = join(options.distDir, entryName);
    const contents = await readFile(sourcePath, "utf8");
    bundleSources.push(contents);
    await writeFile(join(runtimeDir, entryName), contents, "utf8");
  }
  await writeFile(
    join(runtimeDir, "package.json"),
    `${JSON.stringify({ name: releaseName, private: true, type: "module" }, null, 2)}\n`,
    "utf8",
  );
  await cp(options.agentBundlePath, join(runtimeDir, "zcode.cjs"), { dereference: true });
  // Agent bundle 是第三个实际运行入口；只扫描 Server bundle 会漏掉外置的 TUI/Playwright。
  bundleSources.push(await readFile(options.agentBundlePath, "utf8"));

  const nodeTargetPath = join(runtimeDir, options.target.startsWith("win32-") ? "node.exe" : "node");
  await cp(options.nodeBinaryPath, nodeTargetPath, { dereference: true });
  if (!options.target.startsWith("win32-")) await chmod(nodeTargetPath, 0o755);

  // runtime/node_modules 以产物扫描为事实源：bundle 引用什么就装什么（含传递依赖），
  // 不使用 tsup external 声明列表，避免声明与实际引用漂移。
  const referencedPackages = new Set<string>();
  for (const source of bundleSources) {
    for (const name of collectBareModuleSpecifiers(source)) referencedPackages.add(name);
  }
  const rawClosure = await resolveProductionPackageClosure([...referencedPackages], options.workspaceNodeModulesDir, options.workspacePackageDirs);
  const closure = new Map([...rawClosure].filter(([packageName]) => isTargetSpecificPackage(packageName, options.target)));
  const nodeModulesTargetDir = join(runtimeDir, "node_modules");
  for (const [packageName, packageDir] of closure) {
    const targetDir = join(nodeModulesTargetDir, ...packageName.split("/"));
    await mkdir(dirname(targetDir), { recursive: true });
    if (packageName === "node-pty") {
      await copyPackageDir(packageDir, targetDir, (relativePath) => isNodePtyRuntimePath(relativePath, options.target));
    } else {
      // Agent 的外置依赖存在 peer 版本并存（例如 ajv6 + ajv8）。只为已知 peer
      // 冲突包保留 nested node_modules，避免把 pnpm 的整棵开发依赖树复制进发行包。
      await copyPackageDir(packageDir, targetDir, undefined, packageName === "ajv-formats" || packageName === "ajv-keywords");
      if (packageName === "koffi") await pruneKoffiRuntime(packageDir, targetDir, options.target);
    }
  }

  if (closure.has("node-pty")) {
    await ensureNodePtyPrebuild(options, nodeModulesTargetDir);
  }

  const tools = await copyNativeTools(options.nativeToolsDir, join(runtimeDir, "tools"), options.target);
  const plugins = await copyDirectoryIfPresent(options.officialPluginsDir, join(runtimeDir, "packages"));

  const launcherPath = join(releaseDir, "bin", options.target.startsWith("win32-") ? "zcode.cmd" : "zcode");
  await writeFile(launcherPath, POSIX_LAUNCHER, "utf8");
  if (options.target.startsWith("win32-")) {
    await writeFile(launcherPath, WINDOWS_LAUNCHER, "utf8");
  } else {
    await chmod(launcherPath, 0o755);
  }

  const componentSpecs = [
    {
      id: "node-runtime",
      paths: [options.target.startsWith("win32-") ? "runtime/node.exe" : "runtime/node", "runtime/LICENSE.node.txt", "runtime/NODE-SOURCES.json"],
    },
    {
      id: "server-runtime",
      paths: ["runtime/server-cli.js", "runtime/server-core.js", "runtime/package.json", "runtime/node_modules", "runtime/THIRD-PARTY-NOTICES.md"],
    },
    { id: "agent-runtime", paths: ["runtime/zcode.cjs", "runtime/licenses/agent"] },
    ...(plugins.length > 0 ? [{ id: "official-plugins", paths: ["runtime/packages", "runtime/licenses/official-plugins"] }] : []),
    ...(tools.length > 0 ? [{ id: "native-search-tools", paths: ["runtime/tools"] }] : []),
  ];
  const componentMeta: Array<{ id: string; sha256: string; paths: string[]; sizeBytes: number; archivePath?: string }> = [];
  const componentArchivePaths: string[] = [];
  for (const component of componentSpecs) {
    const info = await hashPaths(releaseDir, component.paths);
    componentMeta.push({ ...component, ...info });
  }
  const manifest = createRuntimeManifest(options.target, options.appVersion, {
    tools,
    plugins,
    components: componentMeta,
  });
  await writeFile(join(releaseDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  for (const component of componentMeta) {
    const archive = await createComponentArchive(releaseDir, outputRoot, options.target, component.id, component.paths);
    component.archivePath = relative(outputRoot, archive.archivePath).split(sep).join("/");
    componentArchivePaths.push(archive.archivePath);
  }
  await writeFile(join(releaseDir, "manifest.json"), `${JSON.stringify({ ...manifest, components: componentMeta }, null, 2)}\n`, "utf8");

  let archivePath: string | null = null;
  if (options.archive !== false) {
    const extension = options.target.startsWith("win32-") ? "zip" : "tar.gz";
    archivePath = join(outputRoot, `${releaseName}.${extension}`);
    await rm(archivePath, { force: true });
    // Windows 宿主显式 System32 bsdtar，不依赖调用方 PATH（原因同 tarCommand.ts）。
    const tarCommand = resolveHostTarCommand();
    if (extension === "zip") {
      if (process.platform === "win32") await runCommand(tarCommand, ["-acf", archivePath, releaseName], outputRoot);
      else await runCommand("zip", ["-qr", archivePath, releaseName], outputRoot);
    } else if (process.platform === "win32") {
      await runCommand(tarCommand, ["-czf", archivePath, releaseName], outputRoot);
    } else await runCommand("tar", ["-czf", archivePath, releaseName], outputRoot);
  }

  return {
    releaseDir,
    archivePath,
    componentArchivePaths,
    packagedDependencies: [...closure.keys()].sort(),
  };
}

async function pruneKoffiRuntime(sourceDir: string, targetDir: string, target: ServerTarget): Promise<void> {
  const [platform, architecture] = target.split("-");
  const targetKeys = platform === "linux" ? [`linux_${architecture}`, `musl_${architecture}`] : [`${platform}_${architecture}`];
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
    await cp(sourcePath, join(targetBuild, targetKey), { recursive: true, dereference: true });
  }
}

/**
 * 确保发行包内 node-pty 有目标平台的 pty.node。官方 node-pty npm 包只带
 * darwin/win32 prebuilds，linux 平台从 workspace 的 `@lydell/node-pty-<target>`
 * 补齐（与老远端资产链同一来源）；缺失时直接报错，避免发行包的终端能力必然损坏。
 */
async function ensureNodePtyPrebuild(options: StageOptions, nodeModulesTargetDir: string): Promise<void> {
  const prebuildDir = join(nodeModulesTargetDir, "node-pty", "prebuilds", options.target);
  const ptyNodePath = join(prebuildDir, "pty.node");
  let hasPtyNode = true;
  try {
    await access(ptyNodePath);
  } catch {
    hasPtyNode = false;
  }
  if (!hasPtyNode) {
    // 官方包无该平台 prebuild（linux），从 @lydell 平台包补齐。
    const lydellDir = await findDependencyDir(
      dirname(resolve(options.workspaceNodeModulesDir)),
      `@lydell/node-pty-${options.target}`,
    );
    const lydellPtyNode = lydellDir ? join(lydellDir, "prebuilds", options.target, "pty.node") : null;
    if (!lydellPtyNode) {
      throw new Error(`Missing node-pty prebuild for ${options.target}: install @lydell/node-pty-${options.target}`);
    }
    await mkdir(prebuildDir, { recursive: true });
    await cp(lydellPtyNode, ptyNodePath, { dereference: true });
  }
  // darwin 的 spawn-helper 必须可执行；npm 发布/解压不保证权限位，丢失时 node-pty
  // 会在 posix_spawn 阶段报错（老远端资产链踩过同一坑，见 prepare-prebuilds.mjs）。
  const spawnHelperPath = join(prebuildDir, "spawn-helper");
  try {
    await access(spawnHelperPath);
    await chmod(spawnHelperPath, 0o755);
  } catch {
    // 非 darwin 平台没有 spawn-helper，忽略。
  }
}
