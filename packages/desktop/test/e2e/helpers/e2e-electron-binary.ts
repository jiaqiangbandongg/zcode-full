import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const DEFAULT_E2E_ELECTRON_INSTALL_TIMEOUT_MS = 5 * 60_000;
const MAX_CHILD_PROCESS_TIMEOUT_MS = 2_147_483_647;

interface ElectronPackageInstallInput {
  environment: NodeJS.ProcessEnv;
  installScriptPath: string;
  packageRoot: string;
  timeoutMs: number;
}

interface ResolveE2EElectronBinaryOptions {
  desktopDir: string;
  environment?: NodeJS.ProcessEnv;
  installTimeoutMs?: number;
  installElectronPackage?: (input: ElectronPackageInstallInput) => void;
  repoRoot: string;
}

export function resolveE2EElectronBinary({
  desktopDir,
  environment = process.env,
  installTimeoutMs = DEFAULT_E2E_ELECTRON_INSTALL_TIMEOUT_MS,
  installElectronPackage = runElectronPackageInstall,
  repoRoot,
}: ResolveE2EElectronBinaryOptions) {
  const packageRoots = [
    ...new Set([
      resolve(desktopDir, "node_modules", "electron"),
      resolve(repoRoot, "node_modules", "electron"),
    ]),
  ];
  const installedBinary = resolveInstalledElectronBinary(packageRoots);
  if (installedBinary) {
    return installedBinary;
  }

  const packageRoot = packageRoots.find(
    (candidate) =>
      existsSync(resolve(candidate, "package.json")) &&
      existsSync(resolve(candidate, "install.js")),
  );
  if (!packageRoot) {
    throw createElectronBinaryUnavailableError(packageRoots, "Electron package/install.js 不存在");
  }

  assertValidInstallTimeout(installTimeoutMs);
  const installScriptPath = resolve(packageRoot, "install.js");
  const mirrorForDiagnostics = formatElectronMirrorForDiagnostics(environment.ELECTRON_MIRROR);
  console.warn(
    `[e2e] Electron 可执行文件缺失，正在运行安装脚本: ${installScriptPath} ` +
      `(timeout=${installTimeoutMs}ms, ELECTRON_MIRROR=${mirrorForDiagnostics})`,
  );
  try {
    installElectronPackage({
      environment,
      installScriptPath,
      packageRoot,
      timeoutMs: installTimeoutMs,
    });
  } catch (error) {
    // Bug 根因：旧 WDIO 只检查 .bin/electron 包装脚本，Electron postinstall 被跳过时
    // 会继续交给 ChromeDriver；同时安装下载无超时，网络半开时会在配置加载阶段永久阻塞。
    const failureKind = isElectronInstallTimeoutError(error) ? "安装超时" : "执行失败";
    throw createElectronBinaryUnavailableError(
      packageRoots,
      `Electron install.js ${failureKind}（timeout=${installTimeoutMs}ms, ELECTRON_MIRROR=${mirrorForDiagnostics}, child=${formatElectronInstallError(error)}）`,
      error,
    );
  }

  const repairedBinary = resolveInstalledElectronBinary(packageRoots);
  if (repairedBinary) {
    console.log(`[e2e] Electron 可执行文件已就绪: ${repairedBinary}`);
    return repairedBinary;
  }

  throw createElectronBinaryUnavailableError(
    packageRoots,
    "Electron install.js 已结束，但 path.txt 或其指向的可执行文件仍然缺失；请确认未设置 ELECTRON_SKIP_BINARY_DOWNLOAD",
  );
}

function resolveInstalledElectronBinary(packageRoots: string[]) {
  for (const packageRoot of packageRoots) {
    const pathFile = resolve(packageRoot, "path.txt");
    if (!existsSync(pathFile)) {
      continue;
    }
    const executableRelativePath = readFileSync(pathFile, "utf-8").trim();
    if (!executableRelativePath) {
      continue;
    }
    const executablePath = resolve(packageRoot, "dist", executableRelativePath);
    if (existsSync(executablePath)) {
      return executablePath;
    }
  }
  return null;
}

function runElectronPackageInstall({
  environment,
  installScriptPath,
  packageRoot,
  timeoutMs,
}: ElectronPackageInstallInput) {
  execFileSync(process.execPath, [installScriptPath], {
    cwd: packageRoot,
    env: environment,
    // 安装脚本可能阻塞在 DNS、代理或镜像连接；SIGKILL 保证超时边界不被子进程忽略。
    killSignal: "SIGKILL",
    stdio: "inherit",
    timeout: timeoutMs,
  });
}

function assertValidInstallTimeout(timeoutMs: number) {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_CHILD_PROCESS_TIMEOUT_MS
  ) {
    throw new Error(
      `ZCODE_E2E_ELECTRON_INSTALL_TIMEOUT_MS must be an integer between 1 and ${MAX_CHILD_PROCESS_TIMEOUT_MS}, got: ${timeoutMs}`,
    );
  }
}

function isElectronInstallTimeoutError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }
  const processError = error as Error & {
    code?: unknown;
    killed?: unknown;
    signal?: unknown;
  };
  return (
    processError.code === "ETIMEDOUT" ||
    (processError.killed === true && processError.signal === "SIGKILL") ||
    error.message.includes("ETIMEDOUT")
  );
}

function formatElectronInstallError(error: unknown) {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const processError = error as Error & { code?: unknown; signal?: unknown };
  const details = [error.message];
  if (typeof processError.code === "string") {
    details.push(`code=${processError.code}`);
  }
  if (typeof processError.signal === "string") {
    details.push(`signal=${processError.signal}`);
  }
  return details.join(", ");
}

function formatElectronMirrorForDiagnostics(rawMirror: string | undefined) {
  const mirror = rawMirror?.trim();
  if (!mirror) {
    return "<default>";
  }
  try {
    const url = new URL(mirror);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "<configured non-URL>";
  }
}

function createElectronBinaryUnavailableError(
  packageRoots: string[],
  reason: string,
  cause?: unknown,
) {
  return new Error(
    `[e2e] Electron binary unavailable: ${reason}. Checked package roots: ${packageRoots.join(
      ", ",
    )}`,
    cause === undefined ? undefined : { cause },
  );
}
