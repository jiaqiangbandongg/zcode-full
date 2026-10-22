import { spawn } from "node:child_process";
import { join } from "node:path";
import { createServiceLogger } from "@zcode/services/node";
import { runtimeIdentitySchema, type ReleaseManifest, type RuntimeIdentity } from "../contracts.js";
import { requestControl } from "../ipc/controlClient.js";
import { DataRootLock } from "./lock.js";
import type { ServerLayout } from "./paths.js";
import { ReleaseManager } from "./releaseManager.js";
import { waitForServerStopped } from "./shutdownWait.js";
import { readPersistedStatusDetailed } from "./statusSnapshot.js";
import type { UpdateDaemonHandoff } from "./updateCommand.js";

const DAEMON_START_TIMEOUT_MS = 45_000;
const MAX_DIAGNOSTIC_CHARS = 16_384;
const log = createServiceLogger("server-update-handoff");

interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface UpdateHandoffProcessBoundary {
  stopDaemon(layout: ServerLayout): Promise<void>;
  startDaemon(layout: ServerLayout, release: ReleaseManifest): Promise<void>;
  readRuntimeIdentity(layout: ServerLayout): Promise<RuntimeIdentity>;
}

function appendDiagnostic(current: string, chunk: unknown): string {
  return `${current}${String(chunk)}`.slice(-MAX_DIAGNOSTIC_CHARS);
}

async function runDaemonLauncher(
  layout: ServerLayout,
  release: ReleaseManifest,
): Promise<ProcessResult> {
  const runtimeRoot = join(release.releaseDir, "runtime");
  const runtimeNode = join(runtimeRoot, process.platform === "win32" ? "node.exe" : "node");
  const serverCli = join(runtimeRoot, "server-cli.js");
  const child = spawn(
    runtimeNode,
    [serverCli, "serve", "--daemon", "--server-root", layout.serverRoot, "--json"],
    {
      env: {
        ...process.env,
        ZCODE_DATA_BASE_DIR: layout.dataBaseDir,
        ZCODE_SERVER_ROOT: layout.serverRoot,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout = appendDiagnostic(stdout, chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderr = appendDiagnostic(stderr, chunk);
  });
  return await new Promise<ProcessResult>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(
        new Error(
          `Timed out starting ZCode Server daemon from ${release.releaseId ?? release.version}`,
        ),
      );
    }, DAEMON_START_TIMEOUT_MS);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ exitCode, signal, stdout, stderr });
    });
  });
}

async function stopDaemon(layout: ServerLayout): Promise<void> {
  const persisted = await readPersistedStatusDetailed(layout);
  if (persisted.state === "invalid" || persisted.state === "unreadable") {
    throw new Error("Cannot verify daemon status before update handoff");
  }
  const baselineUpdatedAt = persisted.status?.updatedAt ?? 0;
  const lock = await new DataRootLock(layout.lockFile).inspect();
  if (lock.state === "invalid" || lock.state === "unreadable") {
    throw new Error("Cannot verify daemon lock before update handoff");
  }
  if (lock.state === "missing" || lock.state === "stale") return;
  await requestControl(layout.controlEndpoint, { command: "stop" });
  await waitForServerStopped(layout, baselineUpdatedAt, true);
}

async function startDaemon(layout: ServerLayout, release: ReleaseManifest): Promise<void> {
  const result = await runDaemonLauncher(layout, release);
  if (result.exitCode === 0) return;
  const diagnostic = result.stderr.trim() || result.stdout.trim();
  throw new Error(
    diagnostic ||
      `ZCode Server daemon launcher exited code=${result.exitCode ?? "null"} signal=${result.signal ?? "none"}`,
  );
}

async function readRuntimeIdentity(layout: ServerLayout): Promise<RuntimeIdentity> {
  return runtimeIdentitySchema.parse(
    await requestControl(layout.controlEndpoint, { command: "runtime-identity" }),
  );
}

function assertTargetRuntimeIdentity(target: ReleaseManifest, identity: RuntimeIdentity): void {
  const mismatches: string[] = [];
  if (identity.supervisorVersion !== target.version) {
    mismatches.push(`Supervisor=${identity.supervisorVersion}`);
  }
  if (identity.activeReleaseVersion !== target.version) {
    mismatches.push(`active=${identity.activeReleaseVersion ?? "missing"}`);
  }
  if (identity.coreVersion !== target.version) {
    mismatches.push(`Core=${identity.coreVersion ?? "missing"}`);
  }
  if (target.releaseId) {
    if (identity.supervisorReleaseId !== target.releaseId) {
      mismatches.push(`Supervisor release=${identity.supervisorReleaseId ?? "missing"}`);
    }
    if (identity.activeReleaseId !== target.releaseId) {
      mismatches.push(`active release=${identity.activeReleaseId ?? "missing"}`);
    }
    if (identity.coreReleaseId !== target.releaseId) {
      mismatches.push(`Core release=${identity.coreReleaseId ?? "missing"}`);
    }
  }
  if (mismatches.length > 0) {
    throw new Error(
      `Updated daemon did not converge to ${target.releaseId ?? target.version}: ${mismatches.join(", ")}`,
    );
  }
}

async function rollbackHandoff(
  boundary: UpdateHandoffProcessBoundary,
  input: {
    layout: ServerLayout;
    previous: ReleaseManifest | null;
  },
  cause: unknown,
): Promise<never> {
  if (!input.previous) {
    throw new Error("Updated daemon failed to start and no previous release is available", {
      cause,
    });
  }
  try {
    log.warn("target daemon handoff failed, restoring previous release", {
      previousReleaseId: input.previous.releaseId,
    });
    await boundary.stopDaemon(input.layout);
    await new ReleaseManager(input.layout).restoreCurrent(input.previous);
    await boundary.startDaemon(input.layout, input.previous);
  } catch (rollbackError) {
    throw new AggregateError(
      [cause, rollbackError],
      "Updated daemon handoff and previous release rollback both failed",
    );
  }
  throw new Error("Updated daemon handoff failed; previous release was restored", { cause });
}

export function createUpdateDaemonHandoff(
  boundary: UpdateHandoffProcessBoundary = {
    stopDaemon,
    startDaemon,
    readRuntimeIdentity,
  },
): UpdateDaemonHandoff {
  return {
    async converge(input): Promise<void> {
      // Bug 原因：apply-update 只换代 Core，返回成功后旧 Supervisor 会长期驻留，fallback
      // 环境又没有服务管理器触发下一次进程生命周期。成功边界必须包含 Supervisor 重启和
      // release identity 校验，不能再把新 Core ready 当作整个 daemon 已完成更新。
      log.info("stopping previous daemon for update handoff", {
        previousReleaseId: input.previous?.releaseId,
        targetReleaseId: input.target.releaseId,
      });
      await boundary.stopDaemon(input.layout);
      try {
        await boundary.startDaemon(input.layout, input.target);
        assertTargetRuntimeIdentity(input.target, await boundary.readRuntimeIdentity(input.layout));
        log.info("updated daemon runtime converged", {
          targetReleaseId: input.target.releaseId,
          version: input.target.version,
        });
      } catch (error) {
        await rollbackHandoff(boundary, input, error);
      }
    },
  };
}
