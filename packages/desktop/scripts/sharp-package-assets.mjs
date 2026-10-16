// Sharp native module staging for the shared node_repl runtime.
//
// Why this exists: the bundled node_repl server
// (apps/zcode-cli/packages/browser-use-plugin/dist/mcp/server.js) externalizes `sharp` because it loads a native `.node`
// binary that esbuild cannot inline. In dev the workspace's hoisted
// `node_modules/sharp` resolves fine. In the installed ZCode.app the server
// runs from `<Resources>/glm/packages/browser-use-plugin/dist/mcp/server.js` and
// Node walks up looking for `node_modules/sharp`. Nothing in that walk reaches
// the Electron app.asar tree, so without staging sharp into the glm/ tree the
// server fails at top-level ESM resolution and product CUA never comes up.
//
// What we do: copy `sharp` + the per-triplet prebuild packages into each official
// plugin's `node_modules/` (including `zcode-cua-plugin`, which is CUA's native
// dependency root and is independent from Browser Use).
// macOS/Linux split the native `.node` and libvips into `@img/sharp-*` +
// `@img/sharp-libvips-*`; Windows keeps both the `.node` and libvips DLLs in
// `@img/sharp-win32-*`. Keeping dependencies beside the plugin avoids
// electron-builder's root node_modules filter and matches Node's resolution.
//
// Mirrors node-pty-package-assets.mjs in spirit (per-triplet prebuild staging
// into the packaged app) but writes into the bundled-agents tree instead of
// before afterPack because extraResources already ships the whole glm/
// directory; afterPack then verifies the final app tree.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const requireFromDesktop = createRequire(import.meta.url);

/**
 * Map a normalized target platform key (`darwin-arm64`, `linux-x64`, etc.) to
 * the platform suffix sharp uses for its native prebuild packages.
 *
 * sharp's runtimePlatformArch() (sharp/lib/libvips.js) yields
 * `${process.platform}${runtimeLibc()}-${process.arch}`, where `runtimeLibc`
 * is the empty string everywhere except non-glibc Linux. For the desktop build
 * we always target glibc Linux (matching target-platform.mjs's npmLibc), so
 * plain `linux` is the right suffix.
 */
export function resolveSharpPlatformSuffix(targetPlatform) {
  if (targetPlatform.os === "linux") {
    return `linux-${targetPlatform.arch}`;
  }
  return `${targetPlatform.os}-${targetPlatform.arch}`;
}

/**
 * Return the runtime packages that Sharp actually publishes for the target.
 *
 * Bugfix: Sharp 0.34.x does not publish `@img/sharp-libvips-win32-*`.
 * Windows ships libvips DLLs inside `@img/sharp-win32-*`, while macOS/Linux
 * keep libvips in a sibling package.
 */
export function resolveSharpRuntimePackageNames(targetPlatform) {
  const suffix = resolveSharpPlatformSuffix(targetPlatform);
  const packageNames = ["sharp", "detect-libc", "semver", "@img/colour", `@img/sharp-${suffix}`];
  if (targetPlatform.os !== "win32") {
    packageNames.push(`@img/sharp-libvips-${suffix}`);
  }
  return packageNames;
}

/**
 * Resolve a dependency package's root directory from the desktop package,
 * walking the hoisted workspace layout. Throws if the package is missing so
 * CI fails loudly instead of producing an app without sharp.
 *
 * Note: `@img/sharp-*` packages restrict their `exports` map to just
 * `./sharp.node` and `./package`, so `require.resolve('<pkg>/package.json')`
 * throws ERR_PACKAGE_PATH_NOT_EXPORTED. We use the exported `./package`
 * subpath instead — Node resolves it to the package's package.json — and
 * fall back to the bare package entry for plain packages like `sharp`.
 */
function resolvePackageRoot(packageName, fromDir) {
  // Prefer `/package` (resolves to package.json for both strict-exports and
  // legacy packages), fall back to the bare main entry.
  const candidateSpecifiers = [`${packageName}/package`, packageName];
  const tried = [];
  for (const specifier of candidateSpecifiers) {
    try {
      const resolved = requireFromDesktop.resolve(specifier, { paths: [fromDir] });
      // Walk up to the directory containing the package's package.json.
      let currentDir = dirname(resolved);
      while (currentDir !== dirname(currentDir)) {
        if (existsSync(resolve(currentDir, "package.json"))) {
          return currentDir;
        }
        currentDir = dirname(currentDir);
      }
      return dirname(resolved);
    } catch (error) {
      tried.push(`${specifier}: ${error.code ?? error.message}`);
    }
  }
  throw new Error(
    `[sharp-package-assets] cannot resolve ${packageName} from ${fromDir}; tried:\n${tried.map((t) => `  - ${t}`).join("\n")}`,
  );
}

/**
 * Copy a node_modules-style package directory while pruning the same
 * non-runtime files electron-builder would (maps / READMEs / tests). Source
 * tree comes from the dev workspace; target is inside the bundled agent tree
 * which is later copied verbatim into Resources/glm/.
 */
function copyRuntimePackage(sourceRoot, targetRoot) {
  if (!existsSync(sourceRoot)) {
    throw new Error(`[sharp-package-assets] source package missing: ${sourceRoot}`);
  }
  // Clean rebuilds of the desktop bundle should not accumulate stale sharp
  // versions from previous runs.
  rmSync(targetRoot, { recursive: true, force: true });
  mkdirSync(targetRoot, { recursive: true });

  const SKIP_DIRS = new Set(["test", "tests", "__tests__", "node_modules"]);
  const SKIP_SUFFIXES = [".map", ".md", ".markdown", ".ts"];
  // Keep package.json (runtime `exports`), LICENSE, the JS, and the .node/.dylib/.so binaries.

  function visit(from, to) {
    const entries = readdirSync(from, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        // sharp's @img/sharp-libvips-* packages ship a `versions.json` and
        // a `lib/glib-2.0/include/glibconfig.h` build header that the runtime
        // never reads; keep `lib/` (it carries the dylib/.so) but skip nested
        // build-only includes via the SKIP rules above.
        visit(resolve(from, entry.name), resolve(to, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      // Keep the .node binary, the dylib/.so, package.json, LICENSE, .js.
      if (SKIP_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) {
        // package.json must survive even though we never want .json noise —
        // it's required by Node's package resolution and by sharp's exports map.
        if (entry.name === "package.json") {
          // fall through and copy
        } else {
          continue;
        }
      }
      cpSync(resolve(from, entry.name), resolve(to, entry.name));
    }
  }
  visit(sourceRoot, targetRoot);

  if (!existsSync(targetRoot)) {
    throw new Error(`[sharp-package-assets] staging copy produced no output at ${targetRoot}`);
  }
}

/**
 * Stage Sharp's JS dependencies and target-specific native packages into
 * `<glmDir>/node_modules/...` so the shared node_repl server.js can
 * resolve the bare specifier `import sharp from "sharp"` from either official
 * plugin root. CUA passes its own root explicitly and does not depend on
 * Browser Use's staged files.
 *
 * Must be idempotent and safe to run for every desktop target platform.
 */
/**
 * sharp 只服务于 Computer Use 截图（由 @zcode/zcode-cua 声明依赖）。
 * 构建使用不声明 sharp 的 Computer Use 占位包时，不暂存也不校验 sharp，安装包不携带 sharp/libvips。
 * 这里只读当前安装的 @zcode/zcode-cua 清单，不依赖包导出（其 exports 不含 package.json）。
 */
export function isSharpRequiredByComputerUse({ desktopPackageRoot }) {
  for (let dir = resolve(desktopPackageRoot); ; dir = dirname(dir)) {
    const manifestPath = resolve(dir, "node_modules", "@zcode", "zcode-cua", "package.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      return ["dependencies", "optionalDependencies", "peerDependencies"].some(
        (field) => typeof manifest[field]?.sharp === "string",
      );
    }
    if (dirname(dir) === dir) return false;
  }
}

export function stageSharpIntoBundledAgents({ desktopPackageRoot, glmDir, targetPlatform }) {
  if (!desktopPackageRoot) {
    throw new Error("[sharp-package-assets] desktopPackageRoot is required");
  }
  if (!glmDir) {
    throw new Error("[sharp-package-assets] glmDir is required");
  }
  if (!targetPlatform?.os || !targetPlatform?.arch) {
    throw new Error(
      `[sharp-package-assets] targetPlatform.{os,arch} required (got ${JSON.stringify(targetPlatform)})`,
    );
  }

  const runtimePackageNames = resolveSharpRuntimePackageNames(targetPlatform);

  const stagedNodeModulesDir = resolve(glmDir, "node_modules");
  mkdirSync(stagedNodeModulesDir, { recursive: true });

  const staged = [];
  for (const packageName of runtimePackageNames) {
    const sourceRoot = resolvePackageRoot(packageName, desktopPackageRoot);
    const targetRoot = resolve(stagedNodeModulesDir, packageName);
    copyRuntimePackage(sourceRoot, targetRoot);
    staged.push({ name: packageName, sourceRoot, targetRoot });
    console.log(`[sharp-package-assets] staged ${packageName} -> ${targetRoot}`);
  }

  return staged;
}

/**
 * Resolve the absolute path of the staged sharp directory inside the packaged
 * app, for afterPack assertion. This is where Node's resolution walk lands
 * when the plugin's server.js does `import sharp from "sharp"` in the
 * installed ZCode.app.
 */
export function resolvePackagedSharpDir({
  resourcesDir,
  pluginRelativePath = "packages/browser-use-plugin",
}) {
  return resolve(resourcesDir, "glm", pluginRelativePath, "node_modules", "sharp");
}

/**
 * Resolve the absolute path of the staged per-platform native binary
 * (e.g. `@img/sharp-darwin-arm64`) so tests/afterPack can assert its presence.
 */
export function resolvePackagedSharpNativeDir({
  resourcesDir,
  targetPlatform,
  pluginRelativePath = "packages/browser-use-plugin",
}) {
  const suffix = resolveSharpPlatformSuffix(targetPlatform);
  return resolve(
    resourcesDir,
    "glm",
    pluginRelativePath,
    "node_modules",
    "@img",
    `sharp-${suffix}`,
  );
}

/**
 * Verify the staged sharp tree looks loadable: package.json present, the
 * native `.node` file present, and libvips present at the platform-specific
 * location used by Sharp.
 *
 * Returns a list of human-readable problems; empty array means OK.
 */
export function verifyStagedSharp({
  resourcesDir,
  targetPlatform,
  pluginRelativePath = "packages/browser-use-plugin",
}) {
  const problems = [];
  const suffix = resolveSharpPlatformSuffix(targetPlatform);

  const sharpDir = resolvePackagedSharpDir({ resourcesDir, pluginRelativePath });
  if (!existsSync(sharpDir)) {
    problems.push(`missing sharp dir: ${sharpDir}`);
    return problems; // nothing else to check
  }
  if (!existsSync(resolve(sharpDir, "package.json"))) {
    problems.push(`missing sharp package.json: ${sharpDir}/package.json`);
  }
  if (!existsSync(resolve(sharpDir, "lib"))) {
    problems.push(`missing sharp lib/ dir: ${sharpDir}/lib`);
  }

  const nativeDir = resolvePackagedSharpNativeDir({
    resourcesDir,
    targetPlatform,
    pluginRelativePath,
  });
  let nativeLibDir = null;
  if (!existsSync(nativeDir)) {
    problems.push(`missing @img/sharp-${suffix} dir: ${nativeDir}`);
  } else {
    nativeLibDir = resolve(nativeDir, "lib");
    if (!existsSync(nativeLibDir)) {
      problems.push(`missing @img/sharp-${suffix}/lib dir: ${nativeLibDir}`);
    } else {
      const nodeFile = readdirSync(nativeLibDir).find((name) => name.endsWith(".node"));
      if (!nodeFile) {
        problems.push(`missing .node binary under @img/sharp-${suffix}/lib`);
      }
    }
  }

  if (targetPlatform.os === "win32") {
    // Bugfix: Windows 没有独立的 @img/sharp-libvips-win32-* 包，libvips DLL
    // 与 sharp.node 一起位于 @img/sharp-win32-*/lib。沿用 macOS/Linux 的
    // 目录模型会在资源准备阶段要求一个上游从未发布的包。
    if (
      nativeLibDir &&
      existsSync(nativeLibDir) &&
      !readdirSync(nativeLibDir).some((name) => /\.dll$/iu.test(name))
    ) {
      problems.push(`missing libvips DLL under @img/sharp-${suffix}/lib`);
    }
    return problems;
  }

  const libvipsDir = resolve(
    resourcesDir,
    "glm",
    pluginRelativePath,
    "node_modules",
    "@img",
    `sharp-libvips-${suffix}`,
  );
  if (!existsSync(libvipsDir)) {
    problems.push(`missing @img/sharp-libvips-${suffix} dir: ${libvipsDir}`);
  } else {
    const libvipsLibDir = resolve(libvipsDir, "lib");
    if (!existsSync(libvipsLibDir)) {
      problems.push(`missing @img/sharp-libvips-${suffix}/lib dir: ${libvipsLibDir}`);
    } else {
      // Bugfix: Linux 上游产物使用 libvips-cpp.so.8.17.3 这类版本化名称，
      // 只匹配以 `.so` 结尾会把已经正确打包的动态库误判为缺失。
      const libraryPattern = targetPlatform.os === "linux" ? /\.so(?:\.\d+)*$/u : /\.dylib$/u;
      const hasBinary = readdirSync(libvipsLibDir).some((name) => libraryPattern.test(name));
      if (!hasBinary) {
        problems.push(`missing libvips binary under @img/sharp-libvips-${suffix}/lib`);
      }
    }
  }

  return problems;
}

// Allow `node sharp-package-assets.mjs --glm-dir=... --os=... --arch=...` for
// manual smoke testing outside the prepare:agent-bundle pipeline.
const entryHref =
  typeof process !== "undefined" && process.argv[1]
    ? new URL(process.argv[1], import.meta.url).href
    : null;
if (entryHref === import.meta.url) {
  const args = Object.fromEntries(
    process.argv.slice(2).map((arg) => {
      const match = arg.match(/^--([\w-]+)=(.*)$/u);
      return match ? [match[1], match[2]] : [arg, "true"];
    }),
  );
  const targetPlatform = {
    os: args.os ?? process.platform,
    arch: args.arch ?? process.arch,
    key: `${args.os ?? process.platform}-${args.arch ?? process.arch}`,
  };
  const desktopPackageRoot = import.meta.dirname
    ? resolve(import.meta.dirname, "..")
    : process.cwd();
  const glmDir =
    args["glm-dir"] ?? resolve(desktopPackageRoot, "bundled-agents", targetPlatform.key, "glm");
  stageSharpIntoBundledAgents({ desktopPackageRoot, glmDir, targetPlatform });
  // verifyStagedSharp expects resourcesDir to be the parent of `glm/`, i.e.
  // `<Resources>/` in the packaged app or `dirname(glmDir)` for ad-hoc tests.
  const problems = verifyStagedSharp({
    resourcesDir: resolve(glmDir, ".."),
    targetPlatform,
    // CLI smoke can target any staging root. The desktop product passes the
    // plugin-local relative path by default; this direct smoke stages sharp at
    // <glmDir>/node_modules, so verify that exact tree.
    pluginRelativePath: "",
  });
  if (problems.length > 0) {
    console.error("[sharp-package-assets] verification failed:");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(`[sharp-package-assets] OK at ${glmDir}/node_modules`);
  // Touch statSync to keep the import list honest for unused-symbol linters.
  void statSync;
}
