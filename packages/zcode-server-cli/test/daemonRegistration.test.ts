import { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const serviceMocks = vi.hoisted(() => ({
  fork: vi.fn(),
  isServiceManagerAvailable: vi.fn(async () => true),
  registerService: vi.fn(async () => {
    throw new Error("service manager unavailable");
  }),
  unregisterService: vi.fn(async () => undefined),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  fork: serviceMocks.fork,
}));

vi.mock("../src/platform/serviceManager.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/platform/serviceManager.js")>()),
  isServiceManagerAvailable: serviceMocks.isServiceManagerAvailable,
  registerService: serviceMocks.registerService,
  unregisterService: serviceMocks.unregisterService,
}));

import { runServerCli } from "../src/cli.js";
import { createControlServer } from "../src/ipc/controlServer.js";
import { createServiceDescriptor } from "../src/platform/serviceManager.js";
import { resolveCanonicalServerLayout, resolveServerLayout } from "../src/runtime/paths.js";
import { DataRootLock } from "../src/runtime/lock.js";
import { Supervisor } from "../src/supervisor/supervisor.js";

async function writeStatusSnapshot(statusFile: string, status: unknown): Promise<void> {
  // Bug 原因：直接 writeFile(status.json) 会先截断再写入，waitForServerStopped 可能在中间态读到无效 JSON。
  // 使用和生产 status persister 相同的临时文件 + rename 原子替换，避免测试伪造生产不会出现的损坏快照。
  const temporary = `${statusFile}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.test.tmp`;
  await writeFile(temporary, `${JSON.stringify(status)}\n`, "utf8");
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temporary, statusFile);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const retryDelay = [25, 50, 100, 200, 400][attempt];
        if (
          retryDelay === undefined ||
          (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")
        ) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

describe("daemon service registration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("starts a detached daemon when the OS user service manager is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r2-daemon-fallback-"));
    const layout = resolveServerLayout(join(root, "server"));
    const output: string[] = [];
    await mkdir(layout.runDir, { recursive: true });
    const readyStatus = {
      protocolVersion: 1 as const,
      state: "ready" as const,
      pid: 42,
      port: 43123,
      host: "127.0.0.1",
      version: "test",
      generation: 1,
      startedAt: Date.now(),
      lastExitReason: null,
      serviceRegistered: false,
      runningTaskCount: 0,
      crashBudget: { crashCount: 0, nextRestartDelayMs: 0, exhausted: false },
      updatedAt: Date.now(),
    };
    serviceMocks.isServiceManagerAvailable.mockResolvedValueOnce(false);
    serviceMocks.fork.mockImplementationOnce(() => {
      setTimeout(() => void writeStatusSnapshot(layout.statusFile, readyStatus), 0);
      return {
        unref: vi.fn(),
        disconnect: vi.fn(),
        once: vi.fn(),
      };
    });

    const exit = await runServerCli(
      ["serve", "--daemon", "--server-root", layout.serverRoot, "--json"],
      { stdout: { write: (value) => output.push(value) } },
    );

    expect(exit, output.join("")).toBe(0);
    expect(JSON.parse(output.at(-1) ?? "{}")).toMatchObject({
      state: "ready",
      serviceRegistered: false,
    });
    expect(serviceMocks.registerService).not.toHaveBeenCalled();
    expect(serviceMocks.fork).toHaveBeenCalledOnce();
  });

  it("returns registration failure without starting a disguised fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r2-daemon-registration-"));
    const errors: string[] = [];
    vi.stubEnv("ZCODE_SERVER_SKIP_SERVICE_REGISTRATION", "0");

    const exit = await runServerCli(["serve", "--daemon", "--server-root", join(root, "server")], {
      stderr: { write: (value) => errors.push(value) },
    });

    expect(exit).toBe(1);
    expect(errors.join("")).toContain("service manager unavailable");
    expect(serviceMocks.registerService).toHaveBeenCalledOnce();
    expect(serviceMocks.fork).not.toHaveBeenCalled();
  });

  it("stops and unregisters a same-root legacy service before registering the root-scoped identity", async () => {
    const root = await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "zdr-"));
    const layout = resolveServerLayout(join(root, "server"));
    const platform =
      process.platform === "darwin" || process.platform === "linux" ? process.platform : "win32";
    const kind =
      platform === "darwin" ? "launchd" : platform === "linux" ? "systemd" : "task-scheduler";
    const legacyDescriptor = createServiceDescriptor({
      platform,
      command: join(layout.stableBinDir, platform === "win32" ? "zcode.cmd" : "zcode"),
      args: ["serve", "--supervisor", "--server-root", layout.serverRoot],
    });
    await mkdir(layout.serviceDir, { recursive: true });
    await writeFile(join(layout.serviceDir, `${kind}.service`), legacyDescriptor.content, "utf8");
    const readyStatus = {
      protocolVersion: 1 as const,
      state: "ready" as const,
      pid: 42,
      port: 43123,
      host: "127.0.0.1",
      version: "test",
      generation: 1,
      startedAt: Date.now(),
      lastExitReason: null,
      serviceRegistered: true,
      runningTaskCount: 0,
      crashBudget: { crashCount: 0, nextRestartDelayMs: 0, exhausted: false },
      updatedAt: Date.now(),
    };
    const commands: string[] = [];
    let stopCompleted: Promise<void> = Promise.resolve();
    const fallbackLock = new DataRootLock(layout.lockFile);
    await fallbackLock.acquire();
    let lockAtRegistration: Awaited<ReturnType<DataRootLock["inspect"]>> | undefined;
    serviceMocks.registerService.mockImplementationOnce(async () => {
      lockAtRegistration = await new DataRootLock(layout.lockFile).inspect();
      throw new Error("service manager unavailable");
    });
    await writeStatusSnapshot(layout.statusFile, {
      ...readyStatus,
      state: "stopped",
      pid: null,
      updatedAt: readyStatus.updatedAt,
    });
    const control = await createControlServer(layout.controlEndpoint, async (request) => {
      commands.push(request.command);
      if (request.command === "status") return readyStatus;
      if (request.command === "stop") {
        // 修复原因：旧 fixture fire-and-forget 写 status，测试 teardown 后 rename 仍可能执行，
        // 在 Windows 形成未处理 EPERM，并让 CLI 等不到 lock 释放。显式持有完整停止生命周期。
        stopCompleted = new Promise((resolve) => setTimeout(resolve, 100)).then(async () => {
          await writeStatusSnapshot(layout.statusFile, {
            ...readyStatus,
            state: "stopped",
            pid: null,
            updatedAt: Date.now() + 1,
          });
          await fallbackLock.release();
        });
        return { stopping: true };
      }
      throw new Error(`Unexpected command: ${request.command}`);
    });
    const errors: string[] = [];
    vi.stubEnv("ZCODE_SERVER_SKIP_SERVICE_REGISTRATION", "0");
    try {
      const exit = await runServerCli(["serve", "--daemon", "--server-root", layout.serverRoot], {
        stderr: { write: (value) => errors.push(value) },
      });
      expect(exit).toBe(1);
      expect(errors.join("")).toContain("service manager unavailable");
      expect(commands).toEqual(["status", "stop"]);
      const canonicalLayout = await resolveCanonicalServerLayout(layout.serverRoot);
      expect(serviceMocks.unregisterService).toHaveBeenCalledWith(
        expect.objectContaining({ name: "com.zhipu.zcode.server" }),
        join(canonicalLayout.serviceDir, `${kind}.service`),
      );
      expect(serviceMocks.registerService).toHaveBeenCalledOnce();
    } finally {
      await stopCompleted;
      await control.close();
      await fallbackLock.release();
    }
    expect(lockAtRegistration?.state).toMatch(/missing|stale/);
  });

  it("closes a stop-failed Supervisor whose Core already exited before starting a replacement", async () => {
    // Bug 原因：stop-failed 的 Supervisor 在迟到 exit 后仍持有锁与 control socket，旧实现直接拉起
    // 新 Supervisor，只能锁冲突失败；设备在有人手工 stop 前一直无法重新连接。
    const root = await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "zsf-"));
    const layout = resolveServerLayout(join(root, "server"));
    const core = Object.assign(new EventEmitter(), {
      pid: 42,
      send: () => true,
      kill: () => {
        setTimeout(() => core.emit("exit", null, "SIGKILL"), 50);
        return true;
      },
    });
    const supervisor = new Supervisor({
      layout,
      launcher: {
        launch: (generation) => {
          queueMicrotask(() =>
            core.emit("message", {
              type: "ready",
              host: "127.0.0.1",
              port: 43123,
              version: "test",
              generation,
            }),
          );
          return core as unknown as ChildProcess;
        },
      },
      version: "test",
      coreStopGraceTimeoutMs: 5,
      coreKillTimeoutMs: 5,
    });
    try {
      await supervisor.start();
      await vi.waitFor(() => expect(supervisor.status().state).toBe("ready"));
      await expect(supervisor.stop()).rejects.toThrow(/did not terminate after SIGKILL/);
      await vi.waitFor(() =>
        expect(supervisor.status()).toMatchObject({ state: "stop-failed", pid: null }),
      );

      let supervisorStateAtFork: string | undefined;
      serviceMocks.isServiceManagerAvailable.mockResolvedValueOnce(false);
      serviceMocks.fork.mockImplementationOnce(() => {
        supervisorStateAtFork = supervisor.status().state;
        setTimeout(
          () =>
            void writeStatusSnapshot(layout.statusFile, {
              ...supervisor.status(),
              state: "ready",
              pid: 43,
              port: 43124,
              host: "127.0.0.1",
              updatedAt: Date.now() + 1,
            }),
          0,
        );
        return { unref: vi.fn(), disconnect: vi.fn(), once: vi.fn() };
      });
      const output: string[] = [];
      const exit = await runServerCli(
        ["serve", "--daemon", "--server-root", layout.serverRoot, "--json"],
        { stdout: { write: (value) => output.push(value) } },
      );

      expect(exit, output.join("")).toBe(0);
      expect(supervisorStateAtFork).toBe("stopped");
      expect(serviceMocks.fork).toHaveBeenCalledOnce();
      await expect(new DataRootLock(layout.lockFile).inspect()).resolves.toEqual({
        state: "missing",
      });
    } finally {
      await supervisor.stop().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });
});
