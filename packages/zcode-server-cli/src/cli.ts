/* eslint-disable max-lines -- Server lifecycle、首装、迁移与卸载命令共享同一 CLI 解析和安全边界。 */
import { fork } from "node:child_process";
import { access, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { isPublicZCodeErrorCode, ZCODE_VERSION } from "@zcode/shared";
import { SourceServerWorkspaceAliasRepo } from "@zcode/services/node";
import {
  CORE_KILL_TIMEOUT_MS,
  CORE_READY_TIMEOUT_MS,
  CORE_STOP_GRACE_TIMEOUT_MS,
  controlRequestSchema,
  createStoppedServerStatus,
  serverStatusSchema,
  type ServerStatus,
} from "./contracts.js";
import { requestControl } from "./ipc/controlClient.js";
import {
  resolveCanonicalServerLayout,
  resolveServerLayout,
  validateUninstallTarget,
} from "./runtime/paths.js";
import { validateServerInstallOwnership } from "./runtime/installationOwnership.js";
import { createReleaseAgentWiring, type BundledAgentWiring } from "./runtime/agentWiring.js";
import { writeStableLauncher } from "./runtime/stableLauncher.js";
import {
  runLocalArchiveUpdateCommand,
  runUpdateCommand,
  type UpdateDaemonHandoff,
} from "./runtime/updateCommand.js";
import { DataRootLock } from "./runtime/lock.js";
import { ReleaseManager } from "./runtime/releaseManager.js";
import { createUpdateDaemonHandoff } from "./runtime/updateHandoff.js";
import {
  acquireUninstallLock,
  describeLockInspection,
  removeRunContentsExceptLock,
} from "./runtime/uninstallGuard.js";
import { readPersistedStatus, readPersistedStatusDetailed } from "./runtime/statusSnapshot.js";
import { waitForServerStopped } from "./runtime/shutdownWait.js";
export { readPersistedStatus } from "./runtime/statusSnapshot.js";
import {
  hasLegacyServiceRegistration,
  unregisterInstalledService,
  unregisterLegacyServiceForRoot,
} from "./runtime/serviceInstallation.js";
import { ProxyStdioError, runProxyStdio } from "./server-core/proxyStdio.js";

export interface CliIO {
  stdout?: { write(value: string): void };
  stderr?: { write(value: string): void };
  confirm?: (prompt: string) => Promise<string>;
  legacyDelegate?: (argv: readonly string[]) => Promise<number>;
}

export interface ServerCliRuntimeOptions {
  bundledAgentWiring?: BundledAgentWiring | null;
  proxyStdioStreams?: { input: Readable; output: Writable };
  workspaceAliasRepo?: Pick<SourceServerWorkspaceAliasRepo, "retryFailedWorkspace">;
  /** process/service manager 是更新协调器的外部边界；测试可注入受控实现。 */
  updateDaemonHandoff?: UpdateDaemonHandoff;
}

const stdout = (io: CliIO, value: unknown): void =>
  io.stdout?.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`);
const stderr = (io: CliIO, value: unknown): void =>
  io.stderr?.write(`${value instanceof Error ? value.message : String(value)}\n`);

async function acquireLifecycleCommandLock(
  layout: ReturnType<typeof resolveServerLayout>,
  conflictMessage: string,
): Promise<DataRootLock> {
  const lock = new DataRootLock(layout.updateLockFile);
  try {
    await lock.acquire();
    return lock;
  } catch (error) {
    if (error instanceof Error && error.message.includes("already running")) {
      throw new Error(conflictMessage, { cause: error });
    }
    throw error;
  }
}

export function serviceRegistrationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ZCODE_SERVER_SKIP_SERVICE_REGISTRATION !== "1";
}

export function daemonStartupMode(env: NodeJS.ProcessEnv = process.env): "service" | "fallback" {
  return serviceRegistrationEnabled(env) ? "service" : "fallback";
}

export function isRegisteredServiceEntry(args: readonly string[]): boolean {
  return args.includes("--service-entry");
}

export const SERVER_SERVICE_ARGS = ["serve", "--supervisor"] as const;

export function shouldRegisterService(
  daemonRequested: boolean,
  supervisorProcess: boolean,
): boolean {
  return daemonRequested && !supervisorProcess;
}

export async function runServerCli(
  argv: readonly string[],
  io: CliIO = {},
  runtimeOptions: ServerCliRuntimeOptions = {},
): Promise<number> {
  const json = argv.includes("--json");
  try {
    const parsed = parseServerCliArguments(argv);
    const command = parsed.argv[0];
    if (command === "version" || command === "--version") {
      // Bug 原因：Server --version 过去落入 legacy delegate，实际输出取决于旁边的 Agent
      // zcode.cjs，Desktop probe 无法稳定判断 Server compatibility。
      stdout(io, json ? { product: "zcode-server", version: ZCODE_VERSION } : ZCODE_VERSION);
      return 0;
    }
    const proxyStdioRequested =
      command === "proxy-stdio" || (command === "server" && parsed.argv[1] === "proxy-stdio");
    const migrateRetryRequested = command === "migrate" && parsed.argv[1] === "retry";
    if (!command) {
      return await (io.legacyDelegate?.(parsed.argv) ?? delegateLegacyCli(parsed.argv, io));
    }
    // 同一物理 data-root 的符号链接别名会派生不同 control endpoint 和 OS service
    // identity。生命周期命令统一在 IO 前收敛 root，避免第二个 Supervisor 绕过探测重复注册。
    const layout =
      ["serve", "status", "stop", "restart", "update", "uninstall"].includes(command) ||
      proxyStdioRequested ||
      migrateRetryRequested
        ? await resolveCanonicalServerLayout(parsed.layout.serverRoot)
        : parsed.layout;
    if (proxyStdioRequested) {
      try {
        await runProxyStdio({
          layout,
          input: runtimeOptions.proxyStdioStreams?.input ?? process.stdin,
          output: runtimeOptions.proxyStdioStreams?.output ?? process.stdout,
        });
        return 0;
      } catch (error) {
        const code = error instanceof ProxyStdioError ? error.code : "proxy-stdio-failed";
        io.stderr?.write(
          `${JSON.stringify({ ok: false, code, error: error instanceof Error ? error.message : String(error) })}\n`,
        );
        return 1;
      }
    }
    if (migrateRetryRequested) {
      const pathIndex = parsed.argv.indexOf("--path");
      const workspacePath = pathIndex >= 0 ? parsed.argv[pathIndex + 1] : undefined;
      if (!workspacePath) throw new Error("migrate retry requires --path");
      if (!isAbsolute(workspacePath)) throw new Error("migrate retry --path must be absolute");
      const result = await (
        runtimeOptions.workspaceAliasRepo ?? new SourceServerWorkspaceAliasRepo()
      ).retryFailedWorkspace(workspacePath);
      stdout(io, json ? { ok: true, ...result } : `Migration recovered: ${result.canonicalKey}`);
      return 0;
    }
    switch (command) {
      case "serve":
        return await runServe(parsed.argv.slice(1), io, json, layout, runtimeOptions);
      case "status":
      case "running-tasks":
      case "stop":
      case "restart":
        return await runControl(command, io, json, {}, layout);
      case "update": {
        const updateLock = await acquireLifecycleCommandLock(
          layout,
          "Another ZCode Server update is already running",
        );
        const updateDaemonHandoff =
          runtimeOptions.updateDaemonHandoff ?? createUpdateDaemonHandoff();
        try {
          if (parsed.argv.includes("--from-archive")) {
            return await runLocalArchiveUpdateCommand(
              parsed.argv,
              io,
              json,
              layout,
              () => requestApplyUpdate(layout, parsed.argv.includes("--force")),
              updateDaemonHandoff,
            );
          }
          return await runUpdateCommand(
            parsed.argv,
            io,
            json,
            layout,
            () => requestApplyUpdate(layout, parsed.argv.includes("--force")),
            updateDaemonHandoff,
          );
        } finally {
          await updateLock.release();
        }
      }
      case "uninstall": {
        const uninstallLock = await acquireLifecycleCommandLock(
          layout,
          "A ZCode Server update is already running",
        );
        try {
          return await runUninstall(io, json, layout);
        } finally {
          await uninstallLock.release();
        }
      }
      default:
        return await (io.legacyDelegate?.(parsed.argv) ?? delegateLegacyCli(parsed.argv, io));
    }
  } catch (error: unknown) {
    if (json) {
      const structured =
        error && typeof error === "object"
          ? (error as { code?: unknown; retryable?: unknown })
          : null;
      const publicCode = isPublicZCodeErrorCode(structured?.code) ? structured.code : undefined;
      stdout(io, {
        ok: false,
        ...(publicCode ? { code: publicCode } : {}),
        ...(publicCode && typeof structured?.retryable === "boolean"
          ? { retryable: structured.retryable }
          : {}),
        error: error instanceof Error ? error.message : String(error),
      });
    } else stderr(io, error);
    return 1;
  }
}

function parseServerCliArguments(argv: readonly string[]): {
  argv: readonly string[];
  layout: ReturnType<typeof resolveServerLayout>;
} {
  const rootOptionIndexes = argv.flatMap((value, index) =>
    value === "--server-root" ? [index] : [],
  );
  if (rootOptionIndexes.length > 1) throw new Error("--server-root may only be specified once");
  const rootOptionIndex = rootOptionIndexes[0];
  if (rootOptionIndex === undefined) return { argv, layout: resolveServerLayout() };
  const serverRoot = argv[rootOptionIndex + 1];
  if (!serverRoot) throw new Error("--server-root requires an absolute path");
  if (!isAbsolute(serverRoot)) throw new Error("--server-root must be an absolute path");
  return {
    argv: argv.filter(
      (_value, index) => index !== rootOptionIndex && index !== rootOptionIndex + 1,
    ),
    layout: resolveServerLayout(serverRoot),
  };
}

async function runServe(
  args: readonly string[],
  io: CliIO,
  json: boolean,
  layout: ReturnType<typeof resolveServerLayout>,
  runtimeOptions: ServerCliRuntimeOptions,
): Promise<number> {
  const daemonRequested = args.includes("--daemon");
  const supervisorProcess = args.includes("--supervisor");
  if (shouldRegisterService(daemonRequested, supervisorProcess)) {
    let startupMode = daemonStartupMode();
    const platform =
      process.platform === "darwin" || process.platform === "linux" ? process.platform : "win32";
    if (startupMode === "service") {
      const { isServiceManagerAvailable } = await import("./platform/serviceManager.js");
      if (!(await isServiceManagerAvailable(platform))) {
        // Bug 原因：SSH 过去把 transport 类型等同于“必有 systemd --user/launchd”。
        // 容器、最小系统和无 user bus 的非交互会话因此在安装完成后必然连接失败。
        startupMode = "fallback";
      }
    }
    const legacyIdentityMigration =
      startupMode === "service" && (await hasLegacyServiceRegistration(layout));
    const existing = await readControlStatus(layout, 500);
    if (existing && (existing.state === "ready" || existing.state === "starting")) {
      if ((existing.serviceRegistered && !legacyIdentityMigration) || startupMode === "fallback") {
        if (json) stdout(io, existing);
        else
          stdout(
            io,
            `ZCode Server ${existing.state} at ${existing.host ?? ""}:${existing.port ?? ""}`,
          );
        return 0;
      }
      if (existing.runningTaskCount > 0) {
        throw new Error(
          `Cannot replace fallback daemon while ${existing.runningTaskCount} task(s) are running; stop the server first`,
        );
      }
      // 旧 fallback 会持有 data-root lock，直接注册并启动 OS service 只能
      // 拉起一个立即锁冲突的 Supervisor。空闲时先收口 fallback，再重试真实注册。
      await stopExistingSupervisor(layout, "Cannot verify fallback Server status before migration");
    } else if (existing?.state === "stop-failed" && existing.pid === null) {
      // Bug 原因：stop-failed 的 Supervisor 观察到迟到的 Core 终态后仍持有锁和 control socket，
      // 直接启动只会让新 Supervisor 锁冲突，设备在手工 stop 前无法恢复。已无存活 Core 时由
      // 原 owner 按 stop 契约收口；pid 仍存在则不发 stop，继续由锁 fail-closed。
      await stopExistingSupervisor(
        layout,
        "Cannot verify stop-failed Server status before restart",
      );
    }
    const baselineUpdatedAt = (await readPersistedStatus(layout))?.updatedAt ?? 0;
    let serviceStarted = false;
    let childEarlyExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    if (startupMode === "service") {
      const { createDaemonServiceDescriptor, registerService, serviceDescriptorPath } =
        await import("./platform/serviceManager.js");
      await writeStableLauncher(layout, platform, {
        command: process.execPath,
        entry: process.argv[1] ?? fileURLToPath(import.meta.url),
      });
      const descriptor = createDaemonServiceDescriptor({ platform, layout });
      await mkdir(layout.serviceDir, { recursive: true, mode: 0o700 });
      const descriptorPath = serviceDescriptorPath(layout, descriptor);
      await writeFile(descriptorPath, descriptor.content, "utf8");
      await unregisterLegacyServiceForRoot(layout);
      // 服务管理器已通过能力探测后，注册失败表示权限、descriptor 或真实系统异常。
      // 此时必须向调用方返回根因，不能再用 detached fallback 掩盖。
      await registerService(descriptor, descriptorPath);
      serviceStarted = true;
    }
    if (!serviceStarted) {
      // Bug 原因：archive bootstrap 协调更新时 import.meta.url 指向临时解压目录；handoff
      // 后该目录会被清理。fallback 必须复用本次目标 release 的真实 argv 入口。
      const supervisorEntry = process.argv[1] ?? fileURLToPath(import.meta.url);
      const child = fork(
        supervisorEntry,
        [...SERVER_SERVICE_ARGS, "--server-root", layout.serverRoot],
        {
          detached: true,
          stdio: "ignore",
          env: {
            ...process.env,
            ZCODE_DATA_BASE_DIR: layout.dataBaseDir,
            ZCODE_SERVER_ROOT: layout.serverRoot,
          },
        },
      );
      child.unref();
      // Supervisor 是独立 daemon，不需要保留 CLI↔Supervisor 的 IPC 通道；关闭该通道
      // 才能让一次性的 `serve --daemon` CLI 在返回 ready 后真正退出。
      child.disconnect();
      // 子 Supervisor 以 detached + stdio ignore 启动，锁冲突等启动失败时静默退出；
      // 记录早退信息让等待循环立即报告真实原因。
      child.once("exit", (code, signal) => {
        childEarlyExit = { code, signal };
      });
    }
    const started = await waitForPersistedStatus(
      layout,
      "ready",
      baselineUpdatedAt,
      () => {
        if (childEarlyExit) {
          throw new Error(
            `ZCode Server daemon exited before ready (code=${childEarlyExit.code ?? "null"} signal=${childEarlyExit.signal ?? "none"}); check ${layout.statusFile} for details`,
          );
        }
      },
      serviceStarted,
    );
    if (json) stdout(io, started);
    else stdout(io, `ZCode Server ${started.state} at ${started.host ?? ""}:${started.port ?? ""}`);
    process.stdin.pause();
    process.stdin.destroy();
    return 0;
  }
  const daemon = supervisorProcess;
  const { Supervisor } = await import("./supervisor/supervisor.js");
  const serviceRegistered = supervisorProcess && isRegisteredServiceEntry(args);
  const executingRelease = await new ReleaseManager(layout).readCurrent();
  const executingEntry = process.argv[1] ?? fileURLToPath(import.meta.url);
  const executingReleaseDir = dirname(dirname(resolve(executingEntry)));
  const supervisorReleaseId =
    executingRelease?.releaseId &&
    resolve(executingRelease.releaseDir) === resolve(executingReleaseDir)
      ? executingRelease.releaseId
      : undefined;
  let foregroundStopped: (() => void) | undefined;
  const supervisor = new Supervisor({
    layout,
    launcher: {
      launch: (generation, release) => {
        const runtimeRoot = release?.releaseDir ? join(release.releaseDir, "runtime") : null;
        const corePath = runtimeRoot
          ? join(runtimeRoot, "server-core.js")
          : fileURLToPath(new URL("./server-core.js", import.meta.url));
        const runtimeNode = runtimeRoot
          ? join(runtimeRoot, process.platform === "win32" ? "node.exe" : "node")
          : process.execPath;
        const inheritedEnv = {
          ...process.env,
          ZCODE_DATA_BASE_DIR: layout.dataBaseDir,
          ZCODE_SERVER_ROOT: layout.serverRoot,
        };
        const releaseWiring = runtimeRoot
          ? createReleaseAgentWiring(runtimeRoot, runtimeNode, inheritedEnv)
          : runtimeOptions.bundledAgentWiring;
        return fork(corePath, [String(generation)], {
          execPath: runtimeNode,
          env: {
            ...inheritedEnv,
            ...releaseWiring,
            ...(runtimeRoot ? { ZCODE_SERVER_RUNTIME_ROOT: runtimeRoot } : {}),
            ...(release?.releaseId ? { ZCODE_SERVER_RELEASE_ID: release.releaseId } : {}),
          },
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        });
      },
    },
    version: ZCODE_VERSION,
    ...(supervisorReleaseId ? { supervisorReleaseId } : {}),
    serviceRegistered,
    onStopped: () => {
      process.stdin.pause();
      foregroundStopped?.();
      if (supervisorProcess) process.disconnect?.();
    },
  });
  await supervisor.start();
  let status: ServerStatus;
  try {
    status = await waitForSupervisorReady(supervisor);
  } catch (error) {
    // Core 进入 crash-loop 时不能把错误直接抛给 CLI 顶层返回：control
    // socket 仍持有事件循环导致前台进程假死；用户 Ctrl+C（此时信号 handler 尚未注册，
    // 走默认强杀）后锁文件与 socket 残留，后续 serve 永远报 "already running"。
    // 启动失败必须先停 Supervisor 收口锁与 socket，再上抛错误。
    await supervisor.stop("startup-failed").catch(() => undefined);
    throw error;
  }
  if (json) stdout(io, status);
  else stdout(io, `ZCode Server ${status.state} at ${status.host ?? ""}:${status.port ?? ""}`);
  await new Promise<void>((resolve) => {
    foregroundStopped = resolve;
    if (!daemon) {
      const finish = () => {
        void supervisor.stop("signal").then(() => resolve());
      };
      process.once("SIGINT", finish);
      process.once("SIGTERM", finish);
    }
  });
  return 0;
}

// apply-update 服务端最坏路径包含旧 Core 停止、新 Core ready 等待、新 Core 回滚停止、
// 旧 Core ready 等待以及旧 Core ready 超时后的再次停止，即三次停止预算加两次 ready 预算，
// 另需为 current/pending 文件操作和 IPC 调度留出余量。客户端超时必须覆盖完整回滚路径，
// 否则 CLI 会在 update 仍在后台执行时误报超时（R2-CLI-08）。
export const APPLY_UPDATE_TIMEOUT_MS =
  3 * (CORE_STOP_GRACE_TIMEOUT_MS + CORE_KILL_TIMEOUT_MS) + 2 * CORE_READY_TIMEOUT_MS + 30_000;

async function stopExistingSupervisor(
  layout: ReturnType<typeof resolveServerLayout>,
  unverifiedStatusMessage: string,
): Promise<void> {
  const persistedBeforeStop = await readPersistedStatusDetailed(layout);
  if (persistedBeforeStop.state === "invalid" || persistedBeforeStop.state === "unreadable") {
    throw new Error(unverifiedStatusMessage);
  }
  const stopBaselineUpdatedAt = persistedBeforeStop.status?.updatedAt ?? 0;
  await requestControl(layout.controlEndpoint, { command: "stop" });
  await waitForServerStopped(layout, stopBaselineUpdatedAt, true);
}

async function requestApplyUpdate(
  layout: ReturnType<typeof resolveServerLayout>,
  force: boolean,
): Promise<unknown> {
  return await requestControl(
    layout.controlEndpoint,
    { command: "apply-update", ...(force ? { force: true } : {}) },
    APPLY_UPDATE_TIMEOUT_MS,
  );
}

async function runControl(
  command: string,
  io: CliIO,
  json: boolean,
  extra: Record<string, unknown> = {},
  layout = resolveServerLayout(),
): Promise<number> {
  const request = controlRequestSchema.parse({ id: "cli", command, ...extra });
  let result: unknown;
  try {
    result = await requestControl(
      layout.controlEndpoint,
      request,
      command === "apply-update" ? APPLY_UPDATE_TIMEOUT_MS : undefined,
    );
  } catch (error: unknown) {
    if (command === "status") {
      const persisted = await readPersistedStatusDetailed(layout);
      result = persisted.status ?? createStoppedServerStatus(ZCODE_VERSION);
    } else if (command === "stop" && isControlEndpointUnavailable(error)) {
      const persisted = await readPersistedStatusDetailed(layout);
      if (persisted.state === "invalid" || persisted.state === "unreadable") {
        throw error;
      }
      if (
        persisted.status &&
        persisted.status.state !== "stopped" &&
        persisted.status.state !== "uninstalled"
      ) {
        throw error;
      }
      // Supervisor 停止时会先关闭 control socket，再由 CLI 落盘 stopped 状态。
      // 重复 stop 发生在这个窗口后不应因为 socket 不存在而变成失败。
      result = persisted.status ?? createStoppedServerStatus(ZCODE_VERSION);
    } else {
      throw error;
    }
  }
  if (json) stdout(io, result);
  else stdout(io, result ?? "ok");
  return 0;
}

function isControlEndpointUnavailable(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "ENOENT" || error.code === "ECONNREFUSED" || error.code === "EINVAL";
}

async function runUninstall(
  io: CliIO,
  json: boolean,
  layout: ReturnType<typeof resolveServerLayout>,
): Promise<number> {
  const first = await (io.confirm?.("Type DELETE to uninstall ZCode Server: ") ??
    Promise.resolve(""));
  if (first !== "DELETE") throw new Error("Uninstall cancelled");
  const second = await (io.confirm?.("Type DELETE again to confirm: ") ?? Promise.resolve(""));
  if (second !== "DELETE") throw new Error("Uninstall cancelled");
  // 不能把同一个 --server-root 同时作为 allowlist 根和删除目标：包含关系
  // 恒成立，任何绝对目录都能被卸载流程递归删除。停止服务前必须先验证安装归属。
  const ownership = await validateServerInstallOwnership(layout);
  try {
    await runControl("confirm-uninstall", io, json, { confirmation: "DELETE" }, layout);
  } catch (error: unknown) {
    const persisted = await readPersistedStatusDetailed(layout);
    if (persisted.status?.state === "stopped" || persisted.status?.state === "uninstalled")
      return await finishUninstall(io, json, layout, ownership);
    const lockInspection = await new DataRootLock(layout.lockFile).inspect();
    if (lockInspection.state === "active") {
      throw new Error(`Cannot uninstall while Server lock is held by pid ${lockInspection.pid}`, {
        cause: error,
      });
    }
    if (lockInspection.state === "invalid" || lockInspection.state === "unreadable") {
      throw new Error(
        `Cannot verify Server shutdown before uninstall (${describeLockInspection(lockInspection)})`,
        { cause: error },
      );
    }
  }
  await waitForServerStopped(layout);
  return await finishUninstall(io, json, layout, ownership);
}

async function finishUninstall(
  io: CliIO,
  json: boolean,
  layout: ReturnType<typeof resolveServerLayout>,
  ownership: Awaited<ReturnType<typeof validateServerInstallOwnership>>,
): Promise<number> {
  await unregisterInstalledService(layout);
  const uninstallLock = await acquireUninstallLock(layout);
  // 根因：删除 install.json 会在数据仍保留时生成新设备身份，App 因此归档原连接并拆出新设备。
  // 正式卸载只移除运行资产；身份随用户数据保留，卸载状态仍由 uninstalled.json 保护。
  const uninstallEntries = [
    "releases",
    "run",
    "cache",
    "bin",
    "service",
    "current.json",
    "pending.json",
    "uninstalled.json",
    "update-transaction.json",
    "node",
    "zcode-server.cjs",
    "agents",
    "build",
    "tools",
  ] as const;
  try {
    for (const entry of uninstallEntries) {
      const target = validateUninstallTarget(
        ownership.canonicalServerRoot,
        join(ownership.canonicalServerRoot, entry),
      );
      if (!target.ok || !target.canonicalPath) {
        throw new Error(`Unsafe uninstall target: ${target.reason ?? "unknown"}`);
      }
      if (entry === "run") {
        await removeRunContentsExceptLock(layout);
      } else {
        await rm(target.canonicalPath, { recursive: true, force: true });
      }
    }
    const preservedPaths = (await readdir(ownership.canonicalServerRoot))
      .filter((entry) => entry !== "run")
      .sort();
    // server root 允许用户显式指定，不能递归删除未知内容。卸载只清理上面的
    // ZCode allowlist，并把保留项写入结果供用户审计。先落盘 marker，再释放 lock，
    // 让并发 Supervisor 在删除 run 目录的最后窗口也会 fail-closed。
    await writeFile(
      layout.uninstalledFile,
      `${JSON.stringify({ uninstalled: true, uninstalledAt: Date.now(), version: ZCODE_VERSION, preservedPaths }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await uninstallLock.release();
    await rm(layout.runDir, { recursive: true, force: true });
    if (json) stdout(io, { uninstalled: true, preservedPaths });
    else stdout(io, "uninstalled");
    return 0;
  } catch (error: unknown) {
    await uninstallLock.release().catch(() => undefined);
    throw error;
  }
}

async function waitForPersistedStatus(
  layout: ReturnType<typeof resolveServerLayout>,
  expectedState: "ready" | "stopped",
  minUpdatedAt = 0,
  assertStillWaiting?: () => void,
  expectedServiceRegistered?: boolean,
): Promise<ServerStatus> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const status = await readPersistedStatus(layout);
    if (
      status?.state === expectedState &&
      status.updatedAt > minUpdatedAt &&
      (expectedServiceRegistered === undefined ||
        status.serviceRegistered === expectedServiceRegistered)
    )
      return status;
    assertStillWaiting?.();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for Server ${expectedState}`);
}

async function waitForSupervisorReady(supervisor: {
  status: () => ServerStatus;
}): Promise<ServerStatus> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const status = supervisor.status();
    if (status.state === "ready") return status;
    if (status.state === "crash-loop-stopped")
      throw new Error("Server Core entered crash-loop-stopped");
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for Server Core ready");
}

async function readControlStatus(
  layout: ReturnType<typeof resolveServerLayout>,
  timeoutMs: number,
): Promise<ServerStatus | null> {
  try {
    const result = await requestControl(layout.controlEndpoint, { command: "status" }, timeoutMs);
    return serverStatusSchema.parse(result);
  } catch {
    return null;
  }
}

async function delegateLegacyCli(argv: readonly string[], io: CliIO): Promise<number> {
  const candidate =
    process.env.ZCODE_LEGACY_CLI_ENTRY?.trim() ||
    join(dirname(fileURLToPath(import.meta.url)), "zcode.cjs");
  try {
    await access(candidate);
  } catch {
    stdout(io, argv.length ? `Unknown command: ${argv[0]}` : "ZCode TUI");
    return argv.length ? 1 : 0;
  }
  const child = fork(candidate, [...argv], { stdio: "inherit" });
  return await new Promise<number>((resolve) => child.once("exit", (code) => resolve(code ?? 1)));
}
