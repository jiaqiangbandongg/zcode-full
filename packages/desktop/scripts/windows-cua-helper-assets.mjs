/* eslint-disable max-lines -- staging 与 afterPack verifier 共用同一发布契约，保持同模块避免 schema/PE 规则漂移。 */
import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  parse,
  posix,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { collectRuntimeModuleClosureEntries } from "./runtime-dependency-closure.mjs";
import { resolveSharpRuntimePackageNames } from "./sharp-package-assets.mjs";

const EXPECTED_PACKAGE_NAME = "@zcode/zcode-cua";
const RUNTIME_MANIFEST = "runtime-manifest.json";
const MODULE_TYPE_PACKAGE_JSON = "package.json";
const REMOVE_DIRECTORY_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 100,
};
const PE_MACHINE_BY_ARCH = {
  x64: 0x8664,
  arm64: 0xaa64,
};
const ELECTRON_BUILDER_ARCH = {
  1: "x64",
  3: "arm64",
};

export function resolveElectronBuilderWindowsTarget({
  electronPlatformName,
  arch,
  configuredTargetPlatform,
}) {
  if (electronPlatformName !== "win32") {
    throw new Error(
      `[windows-cua-helper-assets] electron-builder context platform is not win32: ${String(electronPlatformName)}`,
    );
  }
  const actualArch = ELECTRON_BUILDER_ARCH[arch];
  if (!actualArch) {
    throw new Error(
      `[windows-cua-helper-assets] unsupported electron-builder Windows architecture: ${String(arch)}`,
    );
  }
  const actualTarget = {
    os: "win32",
    arch: actualArch,
    key: `win32-${actualArch}`,
  };
  if (
    configuredTargetPlatform?.os !== actualTarget.os ||
    configuredTargetPlatform?.arch !== actualTarget.arch ||
    configuredTargetPlatform?.key !== actualTarget.key
  ) {
    // 根因：交叉构建时 process.env 目标可能与 electron-builder 实际 context 不同；
    // 继续使用全局目标会让 afterPack 跳过或按错误架构验收。
    throw new Error(
      `[windows-cua-helper-assets] configured target ${String(configuredTargetPlatform?.key)} does not match electron-builder target ${actualTarget.key}`,
    );
  }
  return actualTarget;
}

async function readContainedJson(
  physicalRoot,
  path,
  label,
  { lstatOperation = lstat, realpathOperation = realpath, readFileOperation = readFile } = {},
) {
  const bytes = await readRegularFileSnapshot(path, label, {
    lstatOperation,
    readFileOperation,
  });
  const physicalPath = await realpathOperation(path);
  assertPhysicalContainment(physicalRoot, physicalPath, label);
  try {
    return JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString("utf8") : String(bytes));
  } catch (error) {
    throw new Error(`[windows-cua-helper-assets] invalid ${label}: ${path}`, {
      cause: error,
    });
  }
}

export async function readRegularFileSnapshot(
  path,
  artifact,
  { lstatOperation = lstat, readFileOperation = readFile } = {},
) {
  let stats;
  try {
    stats = await lstatOperation(path);
  } catch (error) {
    throw new Error(`[windows-cua-helper-assets] missing ${artifact}: ${path}`, {
      cause: error,
    });
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(
      `[windows-cua-helper-assets] ${artifact} must be a regular file, not a symbolic link: ${path}`,
    );
  }
  try {
    // TOCTOU 根因：校验/哈希后再次按源路径复制，可能把变化后的另一组字节写入产物。
    // 这里只读取一次确定快照；后续校验、落盘和 manifest 都沿用这组字节。
    return await readFileOperation(path);
  } catch (error) {
    throw new Error(`[windows-cua-helper-assets] cannot snapshot ${artifact}: ${path}`, {
      cause: error,
    });
  }
}

function parsePeMachine(bytes, addonPath) {
  if (bytes.length < 0x40 || bytes.toString("ascii", 0, 2) !== "MZ") {
    throw new Error(`[windows-cua-helper-assets] invalid PE header: ${addonPath}`);
  }
  const peOffset = bytes.readUInt32LE(0x3c);
  if (
    peOffset > bytes.length - 6 ||
    bytes.toString("binary", peOffset, peOffset + 4) !== "PE\u0000\u0000"
  ) {
    throw new Error(`[windows-cua-helper-assets] invalid PE header: ${addonPath}`);
  }
  return bytes.readUInt16LE(peOffset + 4);
}

async function copyRuntimePackage(sourceRoot, targetRoot) {
  const skippedDirectories = new Set(["test", "tests", "__tests__", "node_modules"]);
  const skippedSuffixes = [".map", ".md", ".markdown", ".ts"];
  await cp(sourceRoot, targetRoot, {
    recursive: true,
    dereference: true,
    filter(source) {
      if (source === sourceRoot) {
        return true;
      }
      const name = basename(source);
      if (skippedDirectories.has(name)) {
        return false;
      }
      return !skippedSuffixes.some((suffix) => name.endsWith(suffix));
    },
  });
}

function resolveModuleLookupRoots(sourceRoot) {
  const lookupRoots = [sourceRoot];
  const volumeRoot = parse(sourceRoot).root;
  let currentDir = dirname(sourceRoot);
  while (currentDir !== volumeRoot) {
    if (basename(currentDir) === "node_modules") {
      lookupRoots.push(dirname(currentDir));
      break;
    }
    currentDir = dirname(currentDir);
  }
  return lookupRoots;
}

export async function renameDirectoryWithRetries(
  source,
  destination,
  { renameOperation = rename, retryDelayMs = 100, maxAttempts = 5 } = {},
) {
  const transientWindowsErrors = new Set(["EACCES", "EBUSY", "EPERM"]);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await renameOperation(source, destination);
      return;
    } catch (error) {
      if (!transientWindowsErrors.has(error?.code) || attempt === maxAttempts) {
        throw error;
      }
      // Windows Defender 或索引器可能在原子目录切换的瞬间短暂持有文件句柄。
      await delay(retryDelayMs * attempt);
    }
  }
}

async function atomicallyReplaceDirectory(stagedTempRoot, outputDir) {
  const backupDir = `${outputDir}.backup-${randomUUID()}`;
  let movedExistingOutput = false;
  try {
    await renameDirectoryWithRetries(outputDir, backupDir);
    movedExistingOutput = true;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  try {
    await renameDirectoryWithRetries(stagedTempRoot, outputDir);
  } catch (error) {
    if (movedExistingOutput) {
      await renameDirectoryWithRetries(backupDir, outputDir);
    }
    throw error;
  }

  if (movedExistingOutput) {
    await rm(backupDir, REMOVE_DIRECTORY_OPTIONS);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isPlainRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value, expectedKeys) {
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return (
    actualKeys.length === sortedExpectedKeys.length &&
    actualKeys.every((key, index) => key === sortedExpectedKeys[index])
  );
}

function isNonEmptyTrimmedString(value) {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function isCanonicalRelativeArtifactPath(artifact) {
  return (
    typeof artifact === "string" &&
    artifact.length > 0 &&
    !artifact.includes("\\") &&
    !isAbsolute(artifact) &&
    !posix.isAbsolute(artifact) &&
    !win32.isAbsolute(artifact) &&
    posix.normalize(artifact) === artifact &&
    !artifact.split("/").some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        // Windows 会把冒号解释成 ADS、把 NUL 当作路径终止符，必须在进入文件系统前拒绝。
        segment.includes(":") ||
        segment.includes("\0"),
    )
  );
}

function resolveCanonicalPackagedArtifact(root, artifact, label) {
  if (!isCanonicalRelativeArtifactPath(artifact)) {
    throw new Error(
      `[windows-cua-helper-assets] invalid ${label} path in ${RUNTIME_MANIFEST}: ${String(artifact)}`,
    );
  }
  const artifactPath = resolve(root, ...artifact.split("/"));
  const relativePath = relative(root, artifactPath);
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`[windows-cua-helper-assets] ${label} path escapes packaged root: ${artifact}`);
  }
  return artifactPath;
}

// 2026-08-18：把「契约不满足」拆成逐条可读的判定。原来十一个条件挤在一个 if 里、只抛一句
// "invalid zcodeCuaRuntime Windows artifact path contract"，看不出是 producer 少给了契约、
// 还是仓库读错了目录。本次审计正是被这条报错误导：node_modules 停在改 pin 之前的旧提交
// （git 依赖改 pin 不会自动重装），旧包没有 zcodeCuaRuntime，于是被误读成 producer 回归。
// 报错必须自证：谁（包名@版本）、在哪（源目录）、缺哪一条。
function describeRuntimeContractViolation(packageJson) {
  if (!isPlainRecord(packageJson)) return "source package.json is not a JSON object";
  if (packageJson.name !== EXPECTED_PACKAGE_NAME) {
    return `unexpected package name ${JSON.stringify(packageJson.name)}`;
  }
  if (!isNonEmptyTrimmedString(packageJson.version)) {
    return `invalid package version ${JSON.stringify(packageJson.version)}`;
  }
  const contract = packageJson.zcodeCuaRuntime;
  if (contract === undefined) {
    return "zcodeCuaRuntime is missing — the producer package does not publish a Windows runtime contract";
  }
  if (!isPlainRecord(contract)) return "zcodeCuaRuntime is not a JSON object";
  if (!hasExactKeys(contract, ["schema", "windows"])) {
    return `zcodeCuaRuntime must have exactly the keys {schema, windows}, got {${Object.keys(contract).join(", ")}}`;
  }
  if (contract.schema !== 1) {
    return `zcodeCuaRuntime.schema must be 1, got ${JSON.stringify(contract.schema)}`;
  }
  const windowsContract = contract.windows;
  if (!isPlainRecord(windowsContract)) return "zcodeCuaRuntime.windows is not a JSON object";
  if (!hasExactKeys(windowsContract, ["entry", "nativeAddon"])) {
    return `zcodeCuaRuntime.windows must have exactly the keys {entry, nativeAddon}, got {${Object.keys(windowsContract).join(", ")}}`;
  }
  if (!isCanonicalRelativeArtifactPath(windowsContract.entry)) {
    return `zcodeCuaRuntime.windows.entry is not a canonical relative artifact path: ${JSON.stringify(windowsContract.entry)}`;
  }
  if (!isCanonicalRelativeArtifactPath(windowsContract.nativeAddon)) {
    return `zcodeCuaRuntime.windows.nativeAddon is not a canonical relative artifact path: ${JSON.stringify(windowsContract.nativeAddon)}`;
  }
  if (windowsContract.entry === windowsContract.nativeAddon) {
    return "zcodeCuaRuntime.windows.entry and zcodeCuaRuntime.windows.nativeAddon must differ";
  }
  return undefined;
}

function readProducerRuntimeContract(packageJson, sourceRoot) {
  const violation = describeRuntimeContractViolation(packageJson);
  if (violation) {
    const identity = isPlainRecord(packageJson)
      ? `${String(packageJson.name)}@${String(packageJson.version)}`
      : "<unreadable package.json>";
    throw new Error(
      `[windows-cua-helper-assets] invalid zcodeCuaRuntime Windows artifact path contract in ${identity} (${sourceRoot}): ${violation}`,
    );
  }
  const windowsContract = packageJson.zcodeCuaRuntime.windows;
  return {
    packageVersion: packageJson.version,
    entry: windowsContract.entry,
    addon: windowsContract.nativeAddon,
  };
}

function assertPhysicalContainment(root, artifactPath, label) {
  const relativePath = relative(root, artifactPath);
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(
      `[windows-cua-helper-assets] ${label} physical path is not contained by packaged root`,
    );
  }
}

function samePhysicalPath(expected, actual) {
  const normalize = (path) => {
    const normalized = resolve(path);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  return normalize(expected) === normalize(actual);
}

function resolvePackagedRuntimePackageRoot(nodeModulesRoot, packageName) {
  if (
    typeof packageName !== "string" ||
    !/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/iu.test(packageName)
  ) {
    throw new Error(
      `[windows-cua-helper-assets] invalid runtime dependency name: ${String(packageName)}`,
    );
  }
  return resolve(nodeModulesRoot, ...packageName.split("/"));
}

async function verifyPackagedRuntimeDependencyClosure({
  root,
  physicalRoot,
  targetPlatform,
  lstatOperation,
  realpathOperation,
  readFileOperation,
}) {
  const nodeModulesRoot = resolve(root, "node_modules");
  const visited = new Set();
  const verifyPackage = async (packageName) => {
    if (visited.has(packageName)) return;
    visited.add(packageName);
    const packageRoot = resolvePackagedRuntimePackageRoot(nodeModulesRoot, packageName);
    let packageStats;
    try {
      packageStats = await lstatOperation(packageRoot);
    } catch (error) {
      throw new Error(`[windows-cua-helper-assets] missing runtime dependency: ${packageName}`, {
        cause: error,
      });
    }
    if (packageStats.isSymbolicLink() || !packageStats.isDirectory()) {
      throw new Error(
        `[windows-cua-helper-assets] runtime dependency must be a regular directory, not a symbolic link: ${packageName}`,
      );
    }
    const physicalPackageRoot = await realpathOperation(packageRoot);
    assertPhysicalContainment(
      physicalRoot,
      physicalPackageRoot,
      `runtime dependency ${packageName}`,
    );

    const packageJsonPath = resolve(packageRoot, "package.json");
    const packageJsonBytes = await readRegularFileSnapshot(
      packageJsonPath,
      `runtime dependency ${packageName}/package.json`,
      { lstatOperation, readFileOperation },
    );
    const physicalPackageJsonPath = await realpathOperation(packageJsonPath);
    assertPhysicalContainment(
      physicalRoot,
      physicalPackageJsonPath,
      `runtime dependency ${packageName}/package.json`,
    );
    let packageJson;
    try {
      packageJson = JSON.parse(
        Buffer.isBuffer(packageJsonBytes)
          ? packageJsonBytes.toString("utf8")
          : String(packageJsonBytes),
      );
    } catch (error) {
      throw new Error(
        `[windows-cua-helper-assets] invalid runtime dependency package.json: ${packageName}`,
        { cause: error },
      );
    }
    if (
      !isPlainRecord(packageJson) ||
      packageJson.name !== packageName ||
      (packageJson.dependencies !== undefined && !isPlainRecord(packageJson.dependencies))
    ) {
      throw new Error(
        `[windows-cua-helper-assets] invalid runtime dependency metadata: ${packageName}`,
      );
    }
    for (const dependencyName of Object.keys(packageJson.dependencies ?? {}).sort()) {
      await verifyPackage(dependencyName);
    }
  };

  const runtimePackageNames = ["express", ...resolveSharpRuntimePackageNames(targetPlatform)];
  for (const packageName of runtimePackageNames) {
    await verifyPackage(packageName);
  }
}

/**
 * electron-builder 完成资源复制后，按发布 manifest 重新验证最终安装目录。
 */
async function inspectPackagedWindowsCuaHelper({
  resourcesDir,
  targetPlatform,
  electronVersion,
  verifyHashes,
  lstatOperation = lstat,
  realpathOperation = realpath,
  readFileOperation = readFile,
}) {
  if (targetPlatform?.os !== "win32") {
    return { status: "skipped", reason: "unsupported-platform" };
  }
  if (!isAbsolute(resourcesDir)) {
    throw new Error("[windows-cua-helper-assets] resourcesDir must be absolute");
  }
  const expectedMachine = PE_MACHINE_BY_ARCH[targetPlatform.arch];
  if (!expectedMachine) {
    throw new Error(
      `[windows-cua-helper-assets] unsupported Windows architecture: ${targetPlatform.arch}`,
    );
  }
  const expectedElectronVersion = electronVersion?.trim();
  if (!expectedElectronVersion) {
    throw new Error("[windows-cua-helper-assets] electronVersion is required");
  }

  const root = resolve(resourcesDir, "tools", "cua-helper");
  let rootStats;
  try {
    rootStats = await lstatOperation(root);
  } catch (error) {
    throw new Error(`[windows-cua-helper-assets] packaged root is missing: ${root}`, {
      cause: error,
    });
  }
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error(
      `[windows-cua-helper-assets] packaged root must be a regular directory: ${root}`,
    );
  }
  const [physicalResourcesDir, physicalRoot] = await Promise.all([
    realpathOperation(resourcesDir),
    realpathOperation(root),
  ]);
  // 根因：root 自身不是链接并不能排除父级 tools 是 junction；整棵 Helper 树仍可能落到 resources 外。
  assertPhysicalContainment(physicalResourcesDir, physicalRoot, "packaged root");

  const manifestPath = resolve(root, RUNTIME_MANIFEST);
  const manifestBytes = await readRegularFileSnapshot(manifestPath, RUNTIME_MANIFEST, {
    lstatOperation,
    readFileOperation,
  });
  const physicalManifestPath = await realpathOperation(manifestPath);
  assertPhysicalContainment(physicalRoot, physicalManifestPath, RUNTIME_MANIFEST);

  let manifest;
  try {
    manifest = JSON.parse(
      Buffer.isBuffer(manifestBytes) ? manifestBytes.toString("utf8") : String(manifestBytes),
    );
  } catch (error) {
    throw new Error(`[windows-cua-helper-assets] invalid ${RUNTIME_MANIFEST}: ${manifestPath}`, {
      cause: error,
    });
  }
  if (
    !isPlainRecord(manifest) ||
    !isPlainRecord(manifest.sha256) ||
    !hasExactKeys(manifest, [
      "schemaVersion",
      "packageName",
      "packageVersion",
      "platform",
      "arch",
      "electronVersion",
      "entry",
      "addon",
      "sha256",
    ]) ||
    !hasExactKeys(manifest.sha256, ["entry", "addon"]) ||
    !isNonEmptyTrimmedString(manifest.packageVersion) ||
    typeof manifest.entry !== "string" ||
    typeof manifest.addon !== "string" ||
    typeof manifest.sha256.entry !== "string" ||
    typeof manifest.sha256.addon !== "string" ||
    !/^[0-9a-f]{64}$/u.test(manifest.sha256.entry) ||
    !/^[0-9a-f]{64}$/u.test(manifest.sha256.addon)
  ) {
    throw new Error(
      `[windows-cua-helper-assets] invalid ${RUNTIME_MANIFEST} shape: ${manifestPath}`,
    );
  }
  if (manifest.entry === manifest.addon) {
    throw new Error(
      `[windows-cua-helper-assets] ${RUNTIME_MANIFEST} entry and addon must be distinct artifacts`,
    );
  }

  const expectedManifestFields = {
    schemaVersion: 1,
    packageName: EXPECTED_PACKAGE_NAME,
    platform: "win32",
    arch: targetPlatform.arch,
    electronVersion: expectedElectronVersion,
  };
  for (const [field, expected] of Object.entries(expectedManifestFields)) {
    if (manifest[field] !== expected) {
      throw new Error(
        `[windows-cua-helper-assets] incompatible ${RUNTIME_MANIFEST} ${field}: expected ${String(expected)}`,
      );
    }
  }

  const moduleTypePackageJsonPath = resolve(root, MODULE_TYPE_PACKAGE_JSON);
  const moduleTypePackageJsonBytes = await readRegularFileSnapshot(
    moduleTypePackageJsonPath,
    MODULE_TYPE_PACKAGE_JSON,
    {
      lstatOperation,
      readFileOperation,
    },
  );
  const physicalModuleTypePackageJsonPath = await realpathOperation(moduleTypePackageJsonPath);
  assertPhysicalContainment(
    physicalRoot,
    physicalModuleTypePackageJsonPath,
    MODULE_TYPE_PACKAGE_JSON,
  );
  let moduleTypePackageJson;
  try {
    moduleTypePackageJson = JSON.parse(
      Buffer.isBuffer(moduleTypePackageJsonBytes)
        ? moduleTypePackageJsonBytes.toString("utf8")
        : String(moduleTypePackageJsonBytes),
    );
  } catch (error) {
    throw new Error(
      `[windows-cua-helper-assets] invalid ${MODULE_TYPE_PACKAGE_JSON}: ${moduleTypePackageJsonPath}`,
      { cause: error },
    );
  }
  if (
    !isPlainRecord(moduleTypePackageJson) ||
    moduleTypePackageJson.type !== "module" ||
    moduleTypePackageJson.version !== manifest.packageVersion
  ) {
    // 根因：entry 是 ESM；缺 module 声明或声明成 commonjs 时，模块类型只能靠 detect-module
    // 探测兜底，安装盘链上的杂散 package.json 会直接把 fork 打成 SyntaxError exit 1。
    throw new Error(
      `[windows-cua-helper-assets] ${MODULE_TYPE_PACKAGE_JSON} must declare {"type":"module"} and carry the same version as ${RUNTIME_MANIFEST}: ${moduleTypePackageJsonPath}`,
    );
  }

  const entryPath = resolveCanonicalPackagedArtifact(root, manifest.entry, "entry");
  const addonPath = resolveCanonicalPackagedArtifact(root, manifest.addon, "addon");
  const [entryBytes, addonBytes] = await Promise.all([
    readRegularFileSnapshot(entryPath, "entry", {
      lstatOperation,
      readFileOperation,
    }),
    readRegularFileSnapshot(addonPath, "addon", {
      lstatOperation,
      readFileOperation,
    }),
  ]);
  const [physicalEntryPath, physicalAddonPath] = await Promise.all([
    realpathOperation(entryPath),
    realpathOperation(addonPath),
  ]);
  // 根因：manifest 的词法路径即使位于 root 内，也可能经 junction/reparse point 指向 root 外。
  // afterPack 必须同时验证 realpath containment，不能只依赖 resolve/relative 的字符串检查。
  assertPhysicalContainment(physicalRoot, physicalEntryPath, "entry");
  assertPhysicalContainment(physicalRoot, physicalAddonPath, "addon");

  if (verifyHashes) {
    if (sha256(entryBytes) !== manifest.sha256.entry) {
      throw new Error("[windows-cua-helper-assets] entry SHA-256 hash mismatch");
    }
    if (sha256(addonBytes) !== manifest.sha256.addon) {
      throw new Error("[windows-cua-helper-assets] addon SHA-256 hash mismatch");
    }
  }
  const peMachine = parsePeMachine(addonBytes, addonPath);
  if (peMachine !== expectedMachine) {
    throw new Error(
      `[windows-cua-helper-assets] PE machine mismatch: expected 0x${expectedMachine.toString(16)}, got 0x${peMachine.toString(16)}`,
    );
  }
  // 根因：extraResources 会跳过 from 根目录下的 node_modules；仅校验 entry/addon 会让
  // “Helper 主树存在但 express/Sharp 闭包缺失”的安装包通过 afterPack。
  await verifyPackagedRuntimeDependencyClosure({
    root,
    physicalRoot,
    targetPlatform,
    lstatOperation,
    realpathOperation,
    readFileOperation,
  });

  return {
    status: "verified",
    root,
    entryPath,
    addonPath,
    peMachine,
    manifestPath,
    manifest,
    entryBytes,
    addonBytes,
  };
}

function toPackagedVerificationResult(inspection) {
  if (inspection.status === "skipped") return inspection;
  return {
    status: inspection.status,
    root: inspection.root,
    entryPath: inspection.entryPath,
    addonPath: inspection.addonPath,
    peMachine: inspection.peMachine,
  };
}

/**
 * electron-builder 完成资源复制后，按发布 manifest 严格验证最终安装目录。
 */
export async function verifyPackagedWindowsCuaHelper(options) {
  const inspection = await inspectPackagedWindowsCuaHelper({
    ...options,
    verifyHashes: true,
  });
  return toPackagedVerificationResult(inspection);
}

/**
 * Windows extraResources 的原生文件在复制阶段完成签名；签名会改变字节，必须在 afterPack
 * 仅刷新最终产物哈希，然后用同一严格 verifier 再次闭环验证。
 */
export async function finalizePackagedWindowsCuaHelper({
  writeFileOperation = writeFile,
  ...options
}) {
  const inspection = await inspectPackagedWindowsCuaHelper({
    ...options,
    verifyHashes: false,
  });
  if (inspection.status === "skipped") return inspection;

  const finalizedManifest = {
    ...inspection.manifest,
    sha256: {
      entry: sha256(inspection.entryBytes),
      addon: sha256(inspection.addonBytes),
    },
  };
  await writeFileOperation(
    inspection.manifestPath,
    `${JSON.stringify(finalizedManifest, null, 2)}\n`,
    "utf8",
  );
  return verifyPackagedWindowsCuaHelper(options);
}

export async function resolveWindowsCuaHelperSourceRoot({
  runtimePackageDir,
  devRoot,
  servicesPackageRoot,
}) {
  const explicitRuntimePackageDir = runtimePackageDir?.trim();
  const explicitDevRoot = devRoot?.trim();
  const explicitRoot = explicitRuntimePackageDir || explicitDevRoot;
  if (explicitRoot) {
    if (!isAbsolute(explicitRoot)) {
      const variableName = explicitRuntimePackageDir
        ? "ZCODE_CUA_HELPER_RUNTIME_PACKAGE_DIR"
        : "ZCODE_CUA_DEV_ROOT";
      throw new Error(`[windows-cua-helper-assets] ${variableName} must be absolute`);
    }
    return realpath(explicitRoot);
  }

  if (!isAbsolute(servicesPackageRoot)) {
    throw new Error("[windows-cua-helper-assets] servicesPackageRoot must be absolute");
  }
  // servicesPackageRoot 固定对应当前仓库的 packages/services；禁止向上扫描到用户目录
  // 或另一个仓库，否则当前 workspace 缺包时可能误用上级同名 alias。
  const workspaceRoot = resolve(servicesPackageRoot, "..", "..");
  const workspaceMarkerPath = resolve(workspaceRoot, "pnpm-workspace.yaml");
  let markerStats;
  try {
    markerStats = await lstat(workspaceMarkerPath);
  } catch (error) {
    throw new Error(
      `[windows-cua-helper-assets] pnpm-workspace.yaml is unavailable: ${workspaceMarkerPath}`,
      { cause: error },
    );
  }
  if (!markerStats.isFile() || markerStats.isSymbolicLink()) {
    throw new Error(
      `[windows-cua-helper-assets] pnpm-workspace.yaml must be a regular file: ${workspaceMarkerPath}`,
    );
  }

  const packagePathSegments = ["node_modules", "@zcode", "zcode-cua"];
  const packageCandidates = [
    resolve(servicesPackageRoot, ...packagePathSegments),
    resolve(workspaceRoot, ...packagePathSegments),
  ];
  for (const installedPackageRoot of new Set(packageCandidates)) {
    try {
      return await realpath(installedPackageRoot);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw new Error(
          `[windows-cua-helper-assets] packaged helper runtime is unavailable: ${installedPackageRoot}`,
          { cause: error },
        );
      }
    }
  }
  throw new Error(
    `[windows-cua-helper-assets] packaged helper runtime is unavailable: ${packageCandidates.join(", ")}`,
  );
}

export async function prepareWindowsCuaHelperAssets({
  sourceRoot,
  outputRoot,
  targetPlatform,
  electronVersion,
  afterArtifactSnapshot,
  lstatOperation = lstat,
  realpathOperation = realpath,
  readFileOperation = readFile,
}) {
  if (targetPlatform?.os !== "win32") {
    return { status: "skipped", reason: "unsupported-platform" };
  }
  if (!isAbsolute(sourceRoot) || !isAbsolute(outputRoot)) {
    throw new Error("[windows-cua-helper-assets] sourceRoot and outputRoot must be absolute");
  }
  const expectedMachine = PE_MACHINE_BY_ARCH[targetPlatform.arch];
  if (!expectedMachine) {
    throw new Error(
      `[windows-cua-helper-assets] unsupported Windows architecture: ${targetPlatform.arch}`,
    );
  }
  if (!electronVersion?.trim()) {
    throw new Error("[windows-cua-helper-assets] electronVersion is required");
  }

  let sourceRootStats;
  try {
    sourceRootStats = await lstatOperation(sourceRoot);
  } catch (error) {
    throw new Error(`[windows-cua-helper-assets] source root is unavailable: ${sourceRoot}`, {
      cause: error,
    });
  }
  if (sourceRootStats.isSymbolicLink() || !sourceRootStats.isDirectory()) {
    throw new Error(
      `[windows-cua-helper-assets] source root must be a regular directory, not a symbolic link: ${sourceRoot}`,
    );
  }
  const physicalSourceRoot = await realpathOperation(sourceRoot);
  // 根因：只检查 sourceRoot 叶子会漏掉父级 junction；显式构建根必须已经解析到物理目录。
  if (!samePhysicalPath(sourceRoot, physicalSourceRoot)) {
    throw new Error(
      `[windows-cua-helper-assets] source root physical path does not match its configured location: ${sourceRoot}`,
    );
  }

  const packageJsonPath = resolve(sourceRoot, "package.json");
  const packageJson = await readContainedJson(
    physicalSourceRoot,
    packageJsonPath,
    "source package",
    { lstatOperation, realpathOperation, readFileOperation },
  );
  if (packageJson.name !== EXPECTED_PACKAGE_NAME) {
    throw new Error(
      `[windows-cua-helper-assets] unexpected package name: ${String(packageJson.name)}`,
    );
  }
  if (!isNonEmptyTrimmedString(packageJson.version)) {
    throw new Error(
      `[windows-cua-helper-assets] invalid package version: ${String(packageJson.version)}`,
    );
  }
  // 根因：消费端固定版本号和 artifact 目录会让生产者每次独立发版都必须同步改 ZCode。
  // package.json 的严格契约才是兼容边界；version 只作为安装产物的来源追踪信息。
  const producerContract = readProducerRuntimeContract(packageJson, sourceRoot);

  const entryPath = resolveCanonicalPackagedArtifact(
    sourceRoot,
    producerContract.entry,
    "zcodeCuaRuntime.windows.entry",
  );
  const addonPath = resolveCanonicalPackagedArtifact(
    sourceRoot,
    producerContract.addon,
    "zcodeCuaRuntime.windows.nativeAddon",
  );
  const [entryBytes, addonBytes] = await Promise.all([
    readRegularFileSnapshot(entryPath, "entry", {
      lstatOperation,
      readFileOperation,
    }),
    readRegularFileSnapshot(addonPath, "addon", {
      lstatOperation,
      readFileOperation,
    }),
  ]);
  const [physicalEntryPath, physicalAddonPath] = await Promise.all([
    realpathOperation(entryPath),
    realpathOperation(addonPath),
  ]);
  // 根因：规范相对路径仍可穿过中间 junction，必须在读取快照后核对最终物理位置。
  assertPhysicalContainment(physicalSourceRoot, physicalEntryPath, "entry");
  assertPhysicalContainment(physicalSourceRoot, physicalAddonPath, "addon");
  const actualMachine = parsePeMachine(addonBytes, addonPath);
  if (actualMachine !== expectedMachine) {
    throw new Error(
      `[windows-cua-helper-assets] PE machine mismatch: expected 0x${expectedMachine.toString(16)}, got 0x${actualMachine.toString(16)}`,
    );
  }
  await afterArtifactSnapshot?.();

  const targetKey = `win32-${targetPlatform.arch}`;
  const outputDir = resolve(outputRoot, targetKey, "cua-helper");
  const outputParent = dirname(outputDir);
  await mkdir(outputParent, { recursive: true });
  const stagedTempRoot = resolve(outputParent, `.cua-helper.tmp-${randomUUID()}`);
  await mkdir(stagedTempRoot, { recursive: true });

  try {
    const stagedEntryPath = resolveCanonicalPackagedArtifact(
      stagedTempRoot,
      producerContract.entry,
      "entry",
    );
    const stagedAddonPath = resolveCanonicalPackagedArtifact(
      stagedTempRoot,
      producerContract.addon,
      "addon",
    );
    await Promise.all([
      mkdir(dirname(stagedEntryPath), { recursive: true }),
      mkdir(dirname(stagedAddonPath), { recursive: true }),
      mkdir(resolve(stagedTempRoot, "node_modules"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(stagedEntryPath, entryBytes),
      writeFile(stagedAddonPath, addonBytes),
    ]);

    const moduleLookupRoots = resolveModuleLookupRoots(sourceRoot);
    const expressEntries = collectRuntimeModuleClosureEntries(["express"], moduleLookupRoots);
    const sharpModuleNames = resolveSharpRuntimePackageNames({
      os: "win32",
      arch: targetPlatform.arch,
    });
    const sharpModuleNameSet = new Set(sharpModuleNames);
    // Sharp 声明了所有平台的 optionalDependencies；这里只保留当前目标集合，
    // 避免把其他架构的原生包带进安装包和签名面。
    const sharpEntries = collectRuntimeModuleClosureEntries(
      sharpModuleNames,
      moduleLookupRoots,
    ).filter((entry) => sharpModuleNameSet.has(entry.moduleName));
    const runtimeEntries = [
      ...new Map(
        [...expressEntries, ...sharpEntries].map((entry) => [entry.moduleName, entry]),
      ).values(),
    ];
    for (const entry of runtimeEntries) {
      if (!entry.sourceModulePath) {
        throw new Error(
          `[windows-cua-helper-assets] missing runtime dependency: ${entry.moduleName}`,
        );
      }
      await copyRuntimePackage(
        entry.sourceModulePath,
        resolve(stagedTempRoot, "node_modules", entry.moduleName),
      );
    }

    const [stagedEntryBytes, stagedAddonBytes] = await Promise.all([
      readFile(stagedEntryPath),
      readFile(stagedAddonPath),
    ]);
    const manifest = {
      schemaVersion: 1,
      packageName: EXPECTED_PACKAGE_NAME,
      packageVersion: producerContract.packageVersion,
      platform: "win32",
      arch: targetPlatform.arch,
      electronVersion: electronVersion.trim(),
      entry: producerContract.entry,
      addon: producerContract.addon,
      sha256: {
        entry: sha256(stagedEntryBytes),
        addon: sha256(stagedAddonBytes),
      },
    };
    await writeFile(
      resolve(stagedTempRoot, RUNTIME_MANIFEST),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    // 根因（ZCT-2093176018262081536）：entry 是含裸 import 的 ESM，staging 只拷 entry/addon
    // 时把 producer 的 package.json 留在了源目录，安装目录的模块类型解析只能退到盘符根。
    // Node ≥22.7 的 detect-module 兜底了默认场景，但安装盘链上任何带 "type" 的杂散
    // package.json 都会禁用探测，fork 将以 SyntaxError exit 1 变成 broker_unavailable。
    // 在运行时根落一份显式 module 声明，让 entry 的模块类型不依赖探测、不受外部目录影响。
    const moduleTypePackageJson = {
      name: "@zcode/zcode-cua-helper-runtime",
      version: producerContract.packageVersion,
      type: "module",
      private: true,
      main: producerContract.entry,
    };
    await writeFile(
      resolve(stagedTempRoot, MODULE_TYPE_PACKAGE_JSON),
      `${JSON.stringify(moduleTypePackageJson, null, 2)}\n`,
      "utf8",
    );
    await atomicallyReplaceDirectory(stagedTempRoot, outputDir);
    return { status: "staged", outputDir, manifest, peMachine: actualMachine };
  } catch (error) {
    await rm(stagedTempRoot, REMOVE_DIRECTORY_OPTIONS);
    throw error;
  }
}
