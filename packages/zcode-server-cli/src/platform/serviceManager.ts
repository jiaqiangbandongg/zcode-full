import { join } from "node:path";
import { stablePathId, type ServerLayout } from "../runtime/paths.js";

export type ServicePlatform = "darwin" | "linux" | "win32";

export interface ServiceDescriptor {
  kind: "launchd" | "systemd" | "task-scheduler";
  name: string;
  content: string;
}

export interface ServiceCommandExecutor {
  run(command: string, args: readonly string[]): Promise<void>;
  runResult?: (command: string, args: readonly string[]) => Promise<ServiceCommandResult>;
}

export interface ServiceCommandResult {
  exitCode: number;
  stderr: string;
}

export function createDaemonServiceDescriptor(options: {
  platform: ServicePlatform;
  layout: ServerLayout;
}): ServiceDescriptor {
  return createServiceDescriptor({
    platform: options.platform,
    command: join(options.layout.stableBinDir, options.platform === "win32" ? "zcode.cmd" : "zcode"),
    args: ["serve", "--supervisor", "--service-entry", "--server-root", options.layout.serverRoot],
    name: `com.zhipu.zcode.server.${stablePathId(options.layout.serverRoot)}`,
  });
}

export function serviceDescriptorPath(layout: ServerLayout, descriptor: ServiceDescriptor): string {
  const extension = descriptor.kind === "launchd" ? "plist" : descriptor.kind === "systemd" ? "service" : "json";
  return join(layout.serviceDir, `${descriptor.name}.${extension}`);
}

export function createServiceDescriptor(options: {
  platform: ServicePlatform;
  command: string;
  args?: string[];
  name?: string;
}): ServiceDescriptor {
  const name = options.name ?? "com.zhipu.zcode.server";
  const args = options.args ?? ["serve", "--daemon"];
  if (options.platform === "darwin") {
    return {
      kind: "launchd",
      name,
      // 正常 stop 会让 Supervisor 以 0 退出；只按异常退出重启，避免 launchd 的无条件
      // KeepAlive 把用户主动停止的 daemon 立即拉起。Supervisor 自身仍负责 Core 崩溃退避。
      content: `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Label</key><string>${name}</string><key>ProgramArguments</key><array>${[options.command, ...args].map((value) => `<string>${escapeXml(value)}</string>`).join("")}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict></dict></plist>`,
    };
  }
  if (options.platform === "linux") {
    return {
      kind: "systemd",
      name,
      content: `[Unit]\nDescription=ZCode Server\n[Service]\nExecStart=${shellQuote(options.command)} ${args.map(shellQuote).join(" ")}\nRestart=on-failure\n[Install]\nWantedBy=default.target\n`,
    };
  }
  return {
    kind: "task-scheduler",
    name,
    content: JSON.stringify({ taskName: name, command: options.command, args, trigger: "logon", runLevel: "leastPrivilege" }),
  };
}

async function defaultExecutorResult(command: string, args: readonly string[]): Promise<ServiceCommandResult> {
  const { spawn } = await import("node:child_process");
  return await new Promise<ServiceCommandResult>((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ exitCode: code ?? -1, stderr }));
  });
}

async function defaultExecutor(command: string, args: readonly string[]): Promise<void> {
  const result = await defaultExecutorResult(command, args);
  if (result.exitCode !== 0) {
    const error = new Error(`${command} ${args.join(" ")} failed (${result.exitCode}): ${result.stderr}`) as Error & { exitCode?: number };
    error.exitCode = result.exitCode;
    throw error;
  }
}

const defaultServiceCommandExecutor: ServiceCommandExecutor = {
  run: defaultExecutor,
  runResult: defaultExecutorResult,
};

export async function registerService(
  descriptor: ServiceDescriptor,
  descriptorPath: string,
  executor: ServiceCommandExecutor = defaultServiceCommandExecutor,
): Promise<void> {
  try {
    if (descriptor.kind === "launchd") {
      // Label 稳定但 plist 内容可能变化；先卸载旧 job，避免 load 失败后 start 唤醒旧参数。
      try {
        await executor.run("launchctl", ["unload", "-w", descriptorPath]);
      } catch (error: unknown) {
        if (!isServiceMissingError(error)) throw error;
      }
      await executor.run("launchctl", ["load", "-w", descriptorPath]);
      await executor.run("launchctl", ["start", descriptor.name]);
    } else if (descriptor.kind === "systemd") {
      await executor.run("systemctl", ["--user", "daemon-reload"]);
      await executor.run("systemctl", ["--user", "enable", "--now", descriptorPath]);
    } else {
      const parsed = JSON.parse(descriptor.content) as { taskName: string; command: string; args: string[] };
      await executor.run("schtasks", ["/Create", "/TN", parsed.taskName, "/TR", [parsed.command, ...parsed.args].map((value) => `"${value.replaceAll('"', '\\"')}"`).join(" "), "/SC", "ONLOGON", "/F"]);
      await executor.run("schtasks", ["/Run", "/TN", parsed.taskName]);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to register service ${descriptor.name} (${descriptorPath}): ${message}`, { cause: error });
  }
}

export async function unregisterService(
  descriptor: ServiceDescriptor,
  descriptorPath: string,
  executor: ServiceCommandExecutor = defaultServiceCommandExecutor,
): Promise<void> {
  try {
    if (descriptor.kind === "launchd") await executor.run("launchctl", ["unload", "-w", descriptorPath]);
    else if (descriptor.kind === "systemd") await executor.run("systemctl", ["--user", "disable", "--now", descriptorPath]);
    else {
      if (await isMissingWindowsTask(descriptor, executor)) return;
      await executor.run("schtasks", ["/Delete", "/TN", descriptor.name, "/F"]);
    }
  } catch (error) {
    // 注册命令可能在写 descriptor 后失败，卸载时 OS 中并不存在对应服务。
    // 仅容忍“未注册/不存在”，权限或命令执行等真实失败仍需阻止删除运行数据。
    if (!isServiceMissingError(error, descriptor.kind === "task-scheduler")) throw error;
  }
}

function isServiceMissingError(error: unknown, allowWindowsFileNotFound = false): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const exitCode = typeof error === "object" && error !== null && "exitCode" in error && typeof error.exitCode === "number"
    ? error.exitCode
    : undefined;
  const commonMissingMessage = /could not find specified service|not loaded|does not exist|specified (?:service|task).*not (?:exist|found)|unit .* not found/iu.test(message);
  const windowsMissingMessage = /cannot find the file specified/iu.test(message);
  return commonMissingMessage || (allowWindowsFileNotFound && (exitCode === 2 || windowsMissingMessage));
}

async function isMissingWindowsTask(
  descriptor: ServiceDescriptor,
  executor: ServiceCommandExecutor,
): Promise<boolean> {
  if (!executor.runResult) return false;
  const result = await executor.runResult("schtasks", ["/Query", "/TN", descriptor.name, "/HResult"]);
  if (result.exitCode === 0) return false;
  // schtasks /Query /HResult returns HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND) for a
  // missing task. Keep permission/service failures fatal instead of treating every non-zero
  // probe result as an idempotent absence.
  if (result.exitCode === 2 || result.exitCode === 0x80070002 || result.exitCode === -2147024894) return true;
  const error = new Error(`schtasks /Query /TN ${descriptor.name} failed (${result.exitCode}): ${result.stderr}`) as Error & { exitCode?: number };
  error.exitCode = result.exitCode;
  throw error;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
