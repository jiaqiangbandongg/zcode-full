import { execFile } from "node:child_process";
import type { ExecFileOptionsWithStringEncoding } from "node:child_process";

const PROCESS_LOOKUP_TIMEOUT_MS = 1_000;
const POSIX_PROCESS_TREE_GRACE_MS = 250;
const POSIX_PROCESS_TREE_FORCE_MS = 750;
const POSIX_PROCESS_TREE_VERIFY_MS = 250;
const POSIX_PROCESS_TREE_POLL_MS = 25;
const WINDOWS_TASKKILL_TIMEOUT_MS = 2_000;

interface CommandResult {
  error?: unknown;
  status: number | null;
  stderr: string;
  stdout: string;
}

type KillFn = typeof process.kill;
type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: ExecFileOptionsWithStringEncoding,
) => Promise<CommandResult>;

export interface McpStdioProcessTreeTerminatorOptions {
  execFile?: ExecFileFn;
  kill?: KillFn;
  now?: () => number;
  platform?: NodeJS.Platform;
  sleep?: (ms: number) => Promise<void>;
}

export async function terminateMcpStdioProcessTree(
  pid: number,
  options: McpStdioProcessTreeTerminatorOptions = {},
): Promise<void> {
  const platform = getPlatform(options);
  if (platform === "win32") {
    await terminateWindowsProcessTree(pid, options);
    return;
  }

  await terminatePosixProcessTree(pid, options);
}

function isProcessAlive(pid: number, options: McpStdioProcessTreeTerminatorOptions): boolean {
  const kill = options.kill ?? process.kill;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return isPermissionDenied(error);
  }
}

function isPermissionDenied(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EPERM"
  );
}

function getPlatform(options: McpStdioProcessTreeTerminatorOptions): NodeJS.Platform {
  return options.platform ?? process.platform;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function parsePidList(stdout: string): number[] {
  return stdout
    .split(/\s+/)
    .map((value) => Number(value))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

function getPosixProcessListArgs(platform: NodeJS.Platform): string[] {
  return platform === "darwin" ? ["-axo", "pid=,ppid="] : ["-eo", "pid=,ppid="];
}

function parseChildPidsFromProcessList(stdout: string, parentPid: number): number[] {
  const children: number[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const [pidText, ppidText] = line.trim().split(/\s+/);
    const pid = Number(pidText);
    const ppid = Number(ppidText);
    if (Number.isInteger(pid) && pid > 0 && ppid === parentPid) {
      children.push(pid);
    }
  }
  return children;
}

async function collectChildPids(
  pid: number,
  options: McpStdioProcessTreeTerminatorOptions,
): Promise<number[]> {
  const pgrepResult = await runCommand(
    "pgrep",
    ["-P", String(pid)],
    {
      encoding: "utf8",
      timeout: PROCESS_LOOKUP_TIMEOUT_MS,
    },
    options,
  );
  if (!pgrepResult.error && pgrepResult.status === 0 && pgrepResult.stdout) {
    return parsePidList(String(pgrepResult.stdout));
  }

  const psResult = await runCommand(
    "ps",
    getPosixProcessListArgs(getPlatform(options)),
    {
      encoding: "utf8",
      timeout: PROCESS_LOOKUP_TIMEOUT_MS,
    },
    options,
  );
  if (psResult.error || psResult.status !== 0 || !psResult.stdout) return [];

  return parseChildPidsFromProcessList(String(psResult.stdout), pid);
}

async function collectDescendantPids(
  pid: number,
  options: McpStdioProcessTreeTerminatorOptions,
  seen = new Set<number>(),
): Promise<number[]> {
  if (seen.has(pid)) return [];
  seen.add(pid);

  const descendants: number[] = [];
  for (const childPid of await collectChildPids(pid, options)) {
    descendants.push(childPid, ...(await collectDescendantPids(childPid, options, seen)));
  }
  return descendants;
}

function uniquePids(pids: number[]): number[] {
  return [...new Set(pids.filter((pid) => pid > 0))];
}

function killPid(
  pid: number,
  signal: NodeJS.Signals,
  options: McpStdioProcessTreeTerminatorOptions,
): void {
  const kill = options.kill ?? process.kill;
  try {
    kill(pid, signal);
  } catch {
    // 进程可能已经被 SDK close 或前一轮信号回收；关闭路径要求幂等。
  }
}

function killProcessGroup(
  pid: number,
  signal: NodeJS.Signals,
  options: McpStdioProcessTreeTerminatorOptions,
): void {
  const kill = options.kill ?? process.kill;
  try {
    kill(-pid, signal);
  } catch {
    // SDK 当前没有 detached spawn，进程组可能不存在；保留兼容未来 launcher 的能力。
  }
}

async function terminateWindowsProcessTree(
  pid: number,
  options: McpStdioProcessTreeTerminatorOptions,
): Promise<void> {
  if (!isProcessAlive(pid, options)) return;

  const result = await runCommand(
    "taskkill",
    ["/PID", String(pid), "/T", "/F"],
    {
      encoding: "utf8",
      timeout: WINDOWS_TASKKILL_TIMEOUT_MS,
      windowsHide: true,
    },
    options,
  );
  if (didTerminationFail(result) && isProcessAlive(pid, options)) {
    throw new Error(
      `taskkill failed for MCP stdio process tree pid=${pid} status=${result.status ?? "unknown"}`,
    );
  }
}

async function terminatePosixProcessTree(
  pid: number,
  options: McpStdioProcessTreeTerminatorOptions,
): Promise<void> {
  if (!isProcessAlive(pid, options)) return;

  const descendants = uniquePids(await collectDescendantPids(pid, options)).reverse();
  const treePids = uniquePids([...descendants, pid]);

  killProcessGroup(pid, "SIGINT", options);
  for (const treePid of treePids) killPid(treePid, "SIGINT", options);
  await waitUntilAllExited(treePids, POSIX_PROCESS_TREE_GRACE_MS, options);
  if (!treePids.some((treePid) => isProcessAlive(treePid, options))) return;

  killProcessGroup(pid, "SIGTERM", options);
  for (const treePid of treePids) killPid(treePid, "SIGTERM", options);
  await waitUntilAllExited(treePids, POSIX_PROCESS_TREE_FORCE_MS, options);
  if (!treePids.some((treePid) => isProcessAlive(treePid, options))) return;

  const latestDescendants = uniquePids(await collectDescendantPids(pid, options)).reverse();
  const finalPids = uniquePids([...latestDescendants, ...treePids]);
  for (const treePid of finalPids) {
    if (isProcessAlive(treePid, options)) killPid(treePid, "SIGKILL", options);
  }
  killProcessGroup(pid, "SIGKILL", options);
  await waitUntilAllExited(finalPids, POSIX_PROCESS_TREE_VERIFY_MS, options);
  const remainingPids = finalPids.filter((treePid) => isProcessAlive(treePid, options));
  if (remainingPids.length > 0) {
    throw new Error(
      `SIGKILL failed for MCP stdio process tree pid=${pid} remaining=${remainingPids.join(",")}`,
    );
  }
}

async function waitUntilAllExited(
  pids: number[],
  timeoutMs: number,
  options: McpStdioProcessTreeTerminatorOptions,
): Promise<void> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const startedAt = now();
  while (now() - startedAt < timeoutMs) {
    if (!pids.some((pid) => isProcessAlive(pid, options))) return;
    await sleep(POSIX_PROCESS_TREE_POLL_MS);
  }
}

function runCommand(
  file: string,
  args: readonly string[],
  options: ExecFileOptionsWithStringEncoding,
  terminatorOptions: McpStdioProcessTreeTerminatorOptions,
): Promise<CommandResult> {
  const execFileFn = terminatorOptions.execFile ?? defaultExecFile;
  return execFileFn(file, args, options);
}

function defaultExecFile(
  file: string,
  args: readonly string[],
  options: ExecFileOptionsWithStringEncoding,
): Promise<CommandResult> {
  return new Promise((resolveCommand) => {
    execFile(file, [...args], options, (error, stdout, stderr) => {
      resolveCommand({
        error,
        status: getExitStatus(error),
        stderr,
        stdout,
      });
    });
  });
}

function getExitStatus(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("code" in error)) return 0;
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" ? code : null;
}

function didTerminationFail(result: CommandResult): boolean {
  return Boolean(result.error) || (result.status !== null && result.status !== 0);
}
