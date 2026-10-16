import { execFile, execFileSync } from "node:child_process";

const E2E_RUN_ID_ARG_NAME = "--zcode-e2e-run-id";
const E2E_HOME_ARG_NAME = "--zcode-e2e-home";
const E2E_PROCESS_SCAN_MAX_BUFFER_BYTES = 20 * 1024 * 1024;

export interface E2EProcessInfo {
  command: string;
  pid: number;
  ppid: number;
}

export interface E2EProcessCleanupIdentity {
  currentPid?: number;
  homeDir: string;
  /**
   * 完整 run 收尾需要回收遗留的 ChromeDriver；但单次 reload 必须让 driver 存活以复用
   * 同一 WDIO service。调用方可关闭该父链补齐，避免 exit barrier 误等 driver 自己退出。
   */
  includeChromeDriverAncestors?: boolean;
  rootPids?: number[];
  runId?: string | null;
}

export interface E2EProcessScanOptions {
  platform?: NodeJS.Platform;
  runCommand?: (command: string, args: string[]) => string;
}

export interface E2EAsyncProcessScanOptions {
  platform?: NodeJS.Platform;
  runCommand?: (command: string, args: string[]) => Promise<string>;
}

export function buildE2ERunIdArg(runId: string) {
  return `${E2E_RUN_ID_ARG_NAME}=${runId}`;
}

export function createWindowsE2EHomeMarkerArg(homeDir: string) {
  return `${E2E_HOME_ARG_NAME}=${homeDir}`;
}

export function buildWindowsTaskkillArgs(pids: number[]) {
  const uniquePids = [...new Set(pids)].filter(
    (pid) => Number.isInteger(pid) && pid > 0,
  );
  return [...uniquePids.flatMap((pid) => ["/PID", String(pid)]), "/T", "/F"];
}

export function collectWindowsE2EProcessTreePids(
  output: string,
  identity: E2EProcessCleanupIdentity,
) {
  return collectE2EProcessTreePids(parseWindowsProcessRows(output), identity);
}

export function listE2EProcessTreePids(
  identity: E2EProcessCleanupIdentity,
  options: E2EProcessScanOptions = {},
) {
  const platform = options.platform ?? process.platform;
  const runCommand = options.runCommand ?? runProcessScanCommand;
  if (platform === "win32") {
    return collectWindowsE2EProcessTreePids(
      runWindowsProcessScan(runCommand),
      identity,
    );
  }
  return collectE2EProcessTreePids(
    parsePosixProcessRows(runCommand("ps", ["-axo", "pid=,ppid=,command="])),
    identity,
  );
}

export async function listSystemProcesses(
  options: E2EAsyncProcessScanOptions = {},
): Promise<E2EProcessInfo[]> {
  const platform = options.platform ?? process.platform;
  const runCommand = options.runCommand ?? runProcessScanCommandAsync;
  return platform === "win32"
    ? parseWindowsProcessRows(await runWindowsProcessScanAsync(runCommand))
    : parsePosixProcessRows(
        await runCommand("ps", ["-axo", "pid=,ppid=,command="]),
      );
}

export function collectProcessTreeByRootPids(
  processes: E2EProcessInfo[],
  rootPids: number[],
): E2EProcessInfo[] {
  const processPids = new Set(processes.map((item) => item.pid));
  const targetPids = new Set(
    rootPids.filter(
      (pid) => Number.isInteger(pid) && pid > 0 && processPids.has(pid),
    ),
  );

  let changed = true;
  while (changed) {
    changed = false;
    for (const item of processes) {
      if (!targetPids.has(item.pid) && targetPids.has(item.ppid)) {
        targetPids.add(item.pid);
        changed = true;
      }
    }
  }

  return processes
    .filter((item) => targetPids.has(item.pid))
    .sort((left, right) => left.pid - right.pid);
}

export function collectE2EProcessTreePids(
  processes: E2EProcessInfo[],
  identity: E2EProcessCleanupIdentity,
) {
  const excludedPids = collectCurrentProcessAncestorPids(
    processes,
    identity.currentPid ?? process.pid,
  );
  const processPids = new Set(processes.map((item) => item.pid));
  // Bug 原因：macOS Electron main 的实际命令行不保证保留 appArgs identity marker；
  // reload 已从 main bridge 取得权威 PID，必须允许它作为显式根，再递归收集全部后代。
  const targetPids = new Set([
    ...(identity.rootPids ?? []).filter(
      (pid) =>
        Number.isInteger(pid) &&
        pid > 0 &&
        processPids.has(pid) &&
        !excludedPids.has(pid),
    ),
    ...processes
      .filter(
        (item) =>
          !excludedPids.has(item.pid) &&
          isCurrentE2EProcessCleanupRoot(item.command, identity),
      )
      .map((item) => item.pid),
  ]);

  const processByPid = new Map(processes.map((item) => [item.pid, item]));
  const seedPids = Array.from(targetPids);
  for (const seedPid of seedPids) {
    let current = processByPid.get(seedPid);
    while (current && current.ppid > 1) {
      const parent = processByPid.get(current.ppid);
      if (
        !parent ||
        excludedPids.has(parent.pid) ||
        !isE2EProcessAncestorCandidate(
          parent.command,
          identity.includeChromeDriverAncestors !== false,
        )
      ) {
        break;
      }
      // Bug 根因：macOS 会把 Electron main 的命令行收敛成 `ZCode E2E`，
      // ChromeDriver 也不携带 appArgs；只有 renderer/utility 还保留当前 run 的
      // profile/HOME。精确命中后代后必须反向补齐父链，否则只能杀 renderer，
      // markerless main/ChromeDriver 会跨 worker 存活并持续重建窗口。
      targetPids.add(parent.pid);
      current = parent;
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const item of processes) {
      if (
        !targetPids.has(item.pid) &&
        targetPids.has(item.ppid) &&
        !excludedPids.has(item.pid)
      ) {
        targetPids.add(item.pid);
        changed = true;
      }
    }
  }

  return [...targetPids].sort((left, right) => right - left);
}

function isE2EProcessAncestorCandidate(
  command: string,
  includeChromeDriverAncestors: boolean,
) {
  const normalizedCommand = command.trim().replaceAll("\\", "/").toLowerCase();
  return (
    (includeChromeDriverAncestors &&
      /(?:^|\/)chromedriver(?:\.exe)?(?:\s|$)/u.test(normalizedCommand)) ||
    /(?:^|\/)electron(?:\.exe)?(?:\s|$)/u.test(normalizedCommand) ||
    /(?:^|\/)zcode e2e(?:\.exe)?(?:\s|$)/u.test(normalizedCommand)
  );
}

export function isCurrentE2EProcessCleanupRoot(
  command: string,
  identity: E2EProcessCleanupIdentity,
) {
  const normalizedCommand = command.toLowerCase();
  if (
    normalizedCommand.includes("@wdio/cli") ||
    normalizedCommand.includes("wdio.conf.ts")
  ) {
    return false;
  }

  const runId = identity.runId?.trim();
  if (runId && isCommandMarkerPresent(command, buildE2ERunIdArg(runId))) {
    return true;
  }

  const homeDir = identity.homeDir.trim();
  if (!homeDir) {
    return false;
  }

  if (
    buildE2EHomeArgMarkers(homeDir).some((marker) =>
      isCommandMarkerPresent(command, marker),
    )
  ) {
    return true;
  }

  return buildE2EHomePathMarkers(homeDir).some((marker) =>
    isCommandPathPresent(command, marker),
  );
}

function parseWindowsProcessRows(output: string): E2EProcessInfo[] {
  if (!output.trim()) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(output) as unknown;
  } catch {
    return [];
  }

  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.flatMap((row) => {
    if (!row || typeof row !== "object") {
      return [];
    }
    const record = row as Record<string, unknown>;
    const pid = Number(record.ProcessId);
    const parentPid = Number(record.ParentProcessId);
    if (!Number.isInteger(pid) || !Number.isInteger(parentPid)) {
      return [];
    }
    return [
      {
        command:
          typeof record.CommandLine === "string" ? record.CommandLine : "",
        pid,
        ppid: parentPid,
      },
    ];
  });
}

function parsePosixProcessRows(output: string): E2EProcessInfo[] {
  return output
    .split("\n")
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/u))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => ({
      command: match[3] ?? "",
      pid: Number(match[1]),
      ppid: Number(match[2]),
    }))
    .filter(
      (item) => Number.isInteger(item.pid) && Number.isInteger(item.ppid),
    );
}

function runWindowsProcessScan(
  runCommand: (command: string, args: string[]) => string,
) {
  const script = [
    "Get-CimInstance Win32_Process |",
    "Select-Object ProcessId,ParentProcessId,CommandLine |",
    "ConvertTo-Json -Compress",
  ].join(" ");
  let latestError: unknown = null;
  for (const powershell of ["powershell.exe", "pwsh"]) {
    try {
      return runCommand(powershell, ["-NoProfile", "-Command", script]);
    } catch (error) {
      latestError = error;
    }
  }
  throw latestError;
}

async function runWindowsProcessScanAsync(
  runCommand: (command: string, args: string[]) => Promise<string>,
) {
  const script = [
    "Get-CimInstance Win32_Process |",
    "Select-Object ProcessId,ParentProcessId,CommandLine |",
    "ConvertTo-Json -Compress",
  ].join(" ");
  let latestError: unknown = null;
  for (const powershell of ["powershell.exe", "pwsh"]) {
    try {
      return await runCommand(powershell, ["-NoProfile", "-Command", script]);
    } catch (error) {
      latestError = error;
    }
  }
  throw latestError;
}

function runProcessScanCommand(command: string, args: string[]) {
  return execFileSync(command, args, {
    encoding: "utf-8",
    maxBuffer: E2E_PROCESS_SCAN_MAX_BUFFER_BYTES,
    windowsHide: true,
  });
}

function runProcessScanCommandAsync(
  command: string,
  args: string[],
): Promise<string> {
  return new Promise((resolveCommand, rejectCommand) => {
    execFile(
      command,
      args,
      {
        encoding: "utf-8",
        maxBuffer: E2E_PROCESS_SCAN_MAX_BUFFER_BYTES,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          rejectCommand(error);
          return;
        }
        resolveCommand(stdout);
      },
    );
  });
}

function collectCurrentProcessAncestorPids(
  processes: E2EProcessInfo[],
  currentPid: number,
) {
  const byPid = new Map(processes.map((item) => [item.pid, item]));
  const pids = new Set<number>([currentPid]);
  let current = byPid.get(currentPid);
  while (current && current.ppid > 0 && !pids.has(current.ppid)) {
    pids.add(current.ppid);
    current = byPid.get(current.ppid);
  }
  return pids;
}

function buildE2EHomeArgMarkers(homeDir: string) {
  return buildE2EHomePathMarkers(homeDir).map(createWindowsE2EHomeMarkerArg);
}

function buildE2EHomePathMarkers(homeDir: string) {
  return uniqueStrings([
    homeDir,
    homeDir.replaceAll("\\", "/"),
    homeDir.replaceAll("/", "\\"),
  ]);
}

function isCommandMarkerPresent(command: string, marker: string) {
  if (!marker) {
    return false;
  }

  let index = command.indexOf(marker);
  while (index >= 0) {
    if (
      hasCommandBoundary(command[index - 1]) &&
      hasCommandBoundary(command[index + marker.length])
    ) {
      return true;
    }
    index = command.indexOf(marker, index + marker.length);
  }
  return false;
}

function isCommandPathPresent(command: string, marker: string) {
  const normalizedCommand = normalizePathForComparison(command);
  const normalizedMarker = normalizePathForComparison(marker);
  let index = normalizedCommand.indexOf(normalizedMarker);
  while (index >= 0) {
    const before = normalizedCommand[index - 1];
    const after = normalizedCommand[index + normalizedMarker.length];
    // 修复原因：共享 app 路径不能作为 identity；HOME 必须按完整路径边界匹配，
    // 同时允许命令行继续引用 HOME 下的配置文件，避免 current 命中 current-copy。
    if (isHomeBoundaryBefore(before) && isHomeBoundaryAfter(after)) {
      return true;
    }
    index = normalizedCommand.indexOf(
      normalizedMarker,
      index + normalizedMarker.length,
    );
  }
  return false;
}

function normalizePathForComparison(value: string) {
  return value.trim().replaceAll("\\", "/").replace(/\/+$/u, "").toLowerCase();
}

function isHomeBoundaryBefore(char: string | undefined) {
  return char === undefined || /[\s"'=]/u.test(char);
}

function isHomeBoundaryAfter(char: string | undefined) {
  return char === undefined || /[\s/"']/u.test(char);
}

function hasCommandBoundary(char: string | undefined) {
  return char === undefined || !/[A-Za-z0-9._~:/\\-]/u.test(char);
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
