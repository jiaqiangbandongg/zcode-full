import { execFile } from "node:child_process";
import {
  existsSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const WINDOWS_PROCESS_QUERY_TIMEOUT_MS = 3_000;
const WINDOWS_PACKAGED_RESOURCE_DIRS = ["glm", "tools"];
// taskkill 返回不代表 Windows 已完成文件句柄释放；沿用已验证的 750ms
// 交接窗口。
export const WINDOWS_UPDATE_LOCK_RELEASE_GRACE_MS = 750;

export interface WindowsInstallResourceLockProcess {
  pid: number;
  commandLine?: string;
  executablePath?: string;
}

export interface WindowsUpdateProcessCleanupResult<TTerminationResult> {
  initialLockProcesses: WindowsInstallResourceLockProcess[];
  terminationPids: number[];
  terminationResults: TTerminationResult[];
  remainingLockProcesses: WindowsInstallResourceLockProcess[];
  errors: string[];
}

interface WindowsUpdateProcessCleanupOptions<TTerminationResult> {
  resourceLockMarkers: readonly string[];
  lockReleaseGraceMs: number;
  scan: (
    markers: readonly string[],
  ) => Promise<WindowsInstallResourceLockProcess[]>;
  terminate: (pids: number[]) => Promise<TTerminationResult[]>;
  delay: (ms: number) => Promise<void>;
}

function stringifyCleanupError(stage: string, error: unknown): string {
  return `${stage}: ${error instanceof Error ? error.message : String(error)}`;
}

export async function runWindowsUpdateProcessCleanup<TTerminationResult>(
  options: WindowsUpdateProcessCleanupOptions<TTerminationResult>,
): Promise<WindowsUpdateProcessCleanupResult<TTerminationResult>> {
  const errors: string[] = [];
  let initialLockProcesses: WindowsInstallResourceLockProcess[] = [];
  try {
    const scannedProcesses = await options.scan(options.resourceLockMarkers);
    // PID 会在退出屏障与专项清理之间被 Windows 复用，历史 Host/Agent PID
    // 不能作为进程身份。即使扫描实现异常返回了额外行，也只保留清理时刻仍引用随包
    // 资源的进程，避免 taskkill /T /F 终止无关进程树。
    initialLockProcesses = scannedProcesses.filter((processInfo) =>
      isWindowsProcessReferencingResourceMarkers(
        processInfo,
        options.resourceLockMarkers,
      ),
    );
  } catch (error) {
    // 辅助扫描不可用不能阻断升级，错误返回给 main 记录后继续 NSIS 交接。
    errors.push(stringifyCleanupError("initial-scan", error));
  }

  const terminationPids = [
    ...new Set(
      initialLockProcesses
        .map((processInfo) => processInfo.pid)
        .filter((pid) => Number.isSafeInteger(pid) && pid > 0),
    ),
  ];
  if (terminationPids.length === 0) {
    return {
      initialLockProcesses,
      terminationPids,
      terminationResults: [],
      remainingLockProcesses: [],
      errors,
    };
  }

  let terminationResults: TTerminationResult[] = [];
  try {
    terminationResults = await options.terminate(terminationPids);
  } catch (error) {
    errors.push(stringifyCleanupError("terminate", error));
  }
  try {
    await options.delay(options.lockReleaseGraceMs);
  } catch (error) {
    errors.push(stringifyCleanupError("release-grace", error));
  }

  let remainingLockProcesses: WindowsInstallResourceLockProcess[] = [];
  try {
    remainingLockProcesses = await options.scan(options.resourceLockMarkers);
  } catch (error) {
    errors.push(stringifyCleanupError("rescan", error));
  }

  return {
    initialLockProcesses,
    terminationPids,
    terminationResults,
    remainingLockProcesses,
    errors,
  };
}

interface WindowsPackagedResourceSnapshotEntry {
  dir: string;
  path: string;
  exists: boolean;
  entries: string[];
}

interface WindowsPackagedResourceWritableProbe {
  dir: string;
  path: string;
  exists: boolean;
  writable: boolean;
  error?: string;
}

interface WindowsProcessRow {
  ProcessId?: number;
  CommandLine?: string | null;
  ExecutablePath?: string | null;
}

function normalizeForWindowsCommandLineMatch(value: string): string {
  return value.trim().replaceAll("/", "\\").toLowerCase();
}

export function resolveWindowsPackagedResourceLockMarkers(
  resourcesPath: string,
): string[] {
  return WINDOWS_PACKAGED_RESOURCE_DIRS.map((dir) => join(resourcesPath, dir));
}

function listResourceEntries(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .slice(0, 20)
      .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`);
  } catch {
    return [];
  }
}

function removeResourceProbeSentinel(path: string) {
  try {
    rmSync(path, { force: true });
  } catch {
    // sentinel 只是安装前诊断探针，清理失败不应覆盖原始可写性错误。
  }
}

export function snapshotWindowsPackagedResources(
  resourcesPath: string,
): WindowsPackagedResourceSnapshotEntry[] {
  return WINDOWS_PACKAGED_RESOURCE_DIRS.map((dir) => {
    const path = join(resourcesPath, dir);
    const exists = existsSync(path);
    return {
      dir,
      path,
      exists,
      entries: exists ? listResourceEntries(path) : [],
    };
  });
}

export function probeWindowsPackagedResourceWritable(
  resourcesPath: string,
): WindowsPackagedResourceWritableProbe[] {
  return WINDOWS_PACKAGED_RESOURCE_DIRS.map((dir) => {
    const path = join(resourcesPath, dir);
    const exists = existsSync(path);
    if (!exists) {
      return { dir, path, exists, writable: false };
    }
    const sentinelPath = join(
      path,
      `.zcode_resource_probe_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    );
    const renamedSentinelPath = `${sentinelPath}.renamed`;
    try {
      writeFileSync(sentinelPath, "probe\n", "utf8");
      renameSync(sentinelPath, renamedSentinelPath);
      renameSync(renamedSentinelPath, sentinelPath);
      removeResourceProbeSentinel(sentinelPath);
      removeResourceProbeSentinel(renamedSentinelPath);
      return { dir, path, exists, writable: true };
    } catch (error) {
      removeResourceProbeSentinel(sentinelPath);
      removeResourceProbeSentinel(renamedSentinelPath);
      return {
        dir,
        path,
        exists,
        writable: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

export function isWindowsProcessReferencingResourceMarkers(
  processInfo: WindowsInstallResourceLockProcess,
  markers: readonly string[],
): boolean {
  const normalizedMarkers = markers
    .map((marker) => normalizeForWindowsCommandLineMatch(marker))
    .filter(Boolean);
  if (normalizedMarkers.length === 0) {
    return false;
  }

  const searchable = normalizeForWindowsCommandLineMatch(
    `${processInfo.commandLine ?? ""} ${processInfo.executablePath ?? ""}`,
  );
  return normalizedMarkers.some((marker) => searchable.includes(marker));
}

function parseWindowsProcessRows(raw: string): WindowsProcessRow[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }

  const parsed = JSON.parse(trimmed) as WindowsProcessRow | WindowsProcessRow[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

function toPowerShellSingleQuotedString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function buildWindowsProcessQueryScript(markers: readonly string[]): string {
  const markerLiterals = markers.map(toPowerShellSingleQuotedString).join(", ");
  return `
$ErrorActionPreference = 'SilentlyContinue'
$markers = @(${markerLiterals})
$ownPid = $PID
$rows = Get-CimInstance Win32_Process | Select-Object ProcessId, CommandLine, ExecutablePath
$matches = @()
foreach ($row in $rows) {
  if ($row.ProcessId -eq $ownPid) { continue }
  $haystack = (([string]$row.CommandLine) + ' ' + ([string]$row.ExecutablePath)).Replace('/', '\\').ToLowerInvariant()
  foreach ($marker in $markers) {
    $needle = ([string]$marker).Replace('/', '\\').ToLowerInvariant()
    if ($needle.Length -gt 0 -and $haystack.Contains($needle)) {
      $matches += $row
      break
    }
  }
}
$matches | ConvertTo-Json -Compress
`;
}

export async function findWindowsProcessesReferencingResourceMarkers(
  markers: readonly string[],
  queryTimeoutMs = WINDOWS_PROCESS_QUERY_TIMEOUT_MS,
): Promise<WindowsInstallResourceLockProcess[]> {
  if (markers.length === 0) {
    return [];
  }

  const { stdout } = await execFileAsync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      buildWindowsProcessQueryScript(markers),
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: queryTimeoutMs,
      maxBuffer: 2 * 1024 * 1024,
    },
  );

  return parseWindowsProcessRows(stdout)
    .map((row) => ({
      pid: row.ProcessId ?? 0,
      commandLine: row.CommandLine ?? undefined,
      executablePath: row.ExecutablePath ?? undefined,
    }))
    .filter((row) => Number.isInteger(row.pid) && row.pid > 0);
}
