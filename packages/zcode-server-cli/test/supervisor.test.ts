import { EventEmitter } from "node:events";
import { fork, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CRASH_BACKOFF_MS } from "../src/contracts.js";
import { requestControl } from "../src/ipc/controlClient.js";
import { resolveServerLayout } from "../src/runtime/paths.js";
import { ReleaseManager } from "../src/runtime/releaseManager.js";
import { Supervisor } from "../src/supervisor/supervisor.js";

class FakeCore extends EventEmitter {
  public readonly pid = 42;
  public shutdownRequested = false;
  public killRequested = false;
  public exitOnShutdown = true;
  public exitOnKill = true;

  public send(message: unknown): boolean {
    if (typeof message === "object" && message !== null && "command" in message && message.command === "shutdown") {
      this.shutdownRequested = true;
      if (this.exitOnShutdown) queueMicrotask(() => this.emit("exit", 0, null));
    }
    return true;
  }

  public kill(): boolean {
    this.killRequested = true;
    if (this.exitOnKill) this.emit("exit", null, "SIGKILL");
    return true;
  }

  public reportReady(generation: number): void {
    queueMicrotask(() => this.emit("message", {
      type: "ready",
      host: "127.0.0.1",
      port: 43123,
      version: "test",
      generation,
    }));
  }
}

async function waitForState(supervisor: Supervisor, state: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (supervisor.status().state === state) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for supervisor state ${state}, got ${supervisor.status().state}`);
}

describe("Supervisor lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps lifecycle state in Supervisor and consumes Core activity snapshots", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r2-supervisor-"));
    const core = new FakeCore();
    const supervisor = new Supervisor({
      layout: resolveServerLayout(join(root, "server")),
      launcher: {
        launch: (generation) => {
          core.reportReady(generation);
          return core as unknown as ChildProcess;
        },
      },
      version: "test",
    });

    await supervisor.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(supervisor.status()).toMatchObject({ state: "ready", pid: 42, port: 43123 });
    core.emit("message", { type: "task-activity", runningTaskCount: 2 });
    expect(supervisor.status().runningTaskCount).toBe(2);
    await Promise.all([supervisor.stop(), supervisor.stop()]);
    expect(supervisor.status()).toMatchObject({
      state: "stopped",
      pid: null,
      port: null,
      host: null,
      startedAt: null,
      runningTaskCount: 0,
    });
  });

  it("does not recover an active update before a competing Supervisor acquires the lock", async () => {
    const root = await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "zsr-"));
    const layout = resolveServerLayout(join(root, "server"));
    const releases = new ReleaseManager(layout);
    await releases.ensure();
    await mkdir(join(layout.releasesDir, "old"), { recursive: true });
    await mkdir(join(layout.releasesDir, "new"), { recursive: true });
    await releases.writePending({ version: "old", releaseDir: join(layout.releasesDir, "old") });
    await releases.applyPending();
    await releases.writePending({ version: "new", releaseDir: join(layout.releasesDir, "new") });

    let candidate: FakeCore | undefined;
    let signalCandidateLaunched!: () => void;
    const candidateLaunched = new Promise<void>((resolve) => {
      signalCandidateLaunched = resolve;
    });
    const supervisor = new Supervisor({
      layout,
      launcher: {
        launch: (generation, release) => {
          const core = new FakeCore();
          if (release?.version === "new") {
            candidate = core;
            signalCandidateLaunched();
          } else core.reportReady(generation);
          return core as unknown as ChildProcess;
        },
      },
      version: "test",
      coreReadyTimeoutMs: 5_000,
    });

    await supervisor.start();
    await waitForState(supervisor, "ready");
    const apply = requestControl(layout.controlEndpoint, { command: "apply-update", force: true }, 10_000);

    // Bugfix: Windows 不允许 rename 覆盖正被 readFile 打开的 current.json；轮询文件会与
    // atomicWriteJson 争抢句柄并制造 EPERM。candidate 启动发生在 transaction/current
    // 写入完成之后，以生命周期信号等待同一个稳定观察点，不改变锁竞争语义。
    await Promise.race([
      candidateLaunched,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Timed out waiting for candidate Core launch")), 2_000),
      ),
    ]);

    const competing = new Supervisor({
      layout,
      launcher: { launch: () => new FakeCore() as unknown as ChildProcess },
      version: "test",
    });
    await expect(competing.start()).rejects.toThrow(/already running/i);
    expect(JSON.parse(await readFile(layout.currentFile, "utf8"))).toMatchObject({ version: "new" });
    await expect(readFile(layout.updateTransactionFile, "utf8")).resolves.toContain("old");

    candidate?.reportReady(2);
    await expect(apply).resolves.toMatchObject({ applied: true, version: "new" });
    await supervisor.stop();
  });

  it("does not leave the data-root lock after control server startup fails", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join("/tmp", "zcode-r2-start-failure-"));
    const layout = resolveServerLayout(join(root, "server"));
    await mkdir(layout.controlEndpoint, { recursive: true });
    await writeFile(join(layout.controlEndpoint, "occupied"), "occupied", "utf8");
    const core = new FakeCore();
    const supervisor = new Supervisor({
      layout,
      launcher: {
        launch: (generation) => {
          core.reportReady(generation);
          return core as unknown as ChildProcess;
        },
      },
      version: "test",
    });

    await expect(supervisor.start()).rejects.toThrow(/EADDRINUSE|address already in use/i);
    await expect(readFile(layout.lockFile)).rejects.toMatchObject({ code: "ENOENT" });

    await rm(layout.controlEndpoint, { recursive: true, force: true });
    await expect(supervisor.start()).resolves.toMatchObject({ state: "ready" });
    await waitForState(supervisor, "ready");
    await supervisor.stop();
  });

  it("keeps applying the update after a client timeout while rollback finishes", async () => {
    // Bugfix: Windows 上 `/tmp` 会解析到当前盘根目录且普通用户通常无写权限；
    // 使用系统临时目录，让用例只验证客户端超时后的 update 生命周期。
    // macOS AF_UNIX endpoint 有较短的路径上限；系统临时目录已经包含随机前缀，
    // 这里保持 fixture 前缀短，避免测试自身把 control.sock 路径推过上限。
    const root = await mkdtemp(join(tmpdir(), "z2-"));
    const layout = resolveServerLayout(join(root, "server"));
    const releases = new ReleaseManager(layout);
    await releases.ensure();
    await mkdir(join(layout.releasesDir, "old"), { recursive: true });
    await mkdir(join(layout.releasesDir, "new"), { recursive: true });
    await releases.writePending({ version: "old", releaseDir: join(layout.releasesDir, "old") });
    await releases.applyPending();
    await releases.writePending({ version: "new", releaseDir: join(layout.releasesDir, "new") });

    const cores: FakeCore[] = [];
    const supervisor = new Supervisor({
      layout,
      launcher: {
        launch: (generation, release) => {
          const core = new FakeCore();
          cores.push(core);
          if (release?.version !== "new" || cores.length === 3) core.reportReady(generation);
          if (release?.version === "new") core.exitOnShutdown = false;
          return core as unknown as ChildProcess;
        },
      },
      version: "test",
      // waitForUpdateReady 以 50ms 轮询；留出一个完整轮询周期，确保旧 release
      // rollback 的 ready 终态也被观察到，而不是只观察到短暂的 starting/ready 窗口。
      coreReadyTimeoutMs: 120,
      coreStopGraceTimeoutMs: 20,
      coreKillTimeoutMs: 5,
    });
    await supervisor.start();
    await waitForState(supervisor, "ready");

    await expect(
      requestControl(layout.controlEndpoint, { command: "apply-update", force: true }, 15),
    ).rejects.toThrow(/timed out/i);
    await waitForState(supervisor, "ready");
    expect(supervisor.status().pid).toBe(42);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    await supervisor.stop();
  });

  it("launches the recovered release after claiming a stale startup lock", async () => {
    const root = await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "zsr-stale-"));
    const layout = resolveServerLayout(join(root, "server"));
    const releases = new ReleaseManager(layout);
    await releases.ensure();
    await mkdir(join(layout.releasesDir, "old"), { recursive: true });
    await mkdir(join(layout.releasesDir, "new"), { recursive: true });
    await releases.writePending({ version: "old", releaseDir: join(layout.releasesDir, "old") });
    await releases.applyPending();
    const previous = await releases.readCurrent();
    await releases.writePending({ version: "new", releaseDir: join(layout.releasesDir, "new") });
    await releases.applyPendingWithTransaction(previous);
    await writeFile(layout.lockFile, JSON.stringify({ pid: Number.MAX_SAFE_INTEGER }), "utf8");

    let launchedRelease: string | undefined;
    const core = new FakeCore();
    const supervisor = new Supervisor({
      layout,
      launcher: {
        launch: (generation, release) => {
          launchedRelease = release?.version;
          core.reportReady(generation);
          return core as unknown as ChildProcess;
        },
      },
      version: "test",
    });

    await supervisor.start();
    expect(launchedRelease).toBe("old");
    expect(JSON.parse(await readFile(layout.currentFile, "utf8"))).toMatchObject({ version: "old" });
    await expect(readFile(layout.updateTransactionFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await supervisor.stop();
  });

  it("fails closed when current release points outside the managed releases directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r2-invalid-current-"));
    const layout = resolveServerLayout(join(root, "server"));
    const releaseManager = new ReleaseManager(layout);
    await releaseManager.ensure();
    await writeFile(
      layout.currentFile,
      JSON.stringify({ version: "1.0.0", releaseDir: join(root, "outside-release") }),
      "utf8",
    );
    const launch = vi.fn(() => new FakeCore() as unknown as ChildProcess);
    const supervisor = new Supervisor({
      layout,
      launcher: { launch },
      version: "test",
    });

    await expect(supervisor.start()).rejects.toThrow(/inside the server releases directory/);
    expect(launch).not.toHaveBeenCalled();
  });

  it("backs off 1/2/4/8/16s on crashes and enters crash-loop-stopped when the budget is exhausted", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r2-crashloop-"));
    vi.useFakeTimers();
    const cores: FakeCore[] = [];
    const supervisor = new Supervisor({
      layout: resolveServerLayout(join(root, "server")),
      launcher: {
        launch: () => {
          const core = new FakeCore();
          cores.push(core);
          return core as unknown as ChildProcess;
        },
      },
      version: "test",
    });
    await supervisor.start();
    expect(cores.length).toBe(1);

    for (let crashIndex = 0; crashIndex < CRASH_BACKOFF_MS.length; crashIndex++) {
      cores[crashIndex]?.emit("exit", 1, null);
      expect(supervisor.status().state).toBe("crashed");
      // 退避序列必须与 spec 的 1/2/4/8/16 秒一致：提前一毫秒不应重启。
      await vi.advanceTimersByTimeAsync((CRASH_BACKOFF_MS[crashIndex] ?? 0) - 1);
      expect(cores.length).toBe(crashIndex + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(cores.length).toBe(crashIndex + 2);
    }

    // 第六次 crash 超出 5 次/5 分钟预算，熔断且不再拉起新 Core。
    cores[CRASH_BACKOFF_MS.length]?.emit("exit", 1, null);
    expect(supervisor.status().state).toBe("crash-loop-stopped");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(cores.length).toBe(CRASH_BACKOFF_MS.length + 1);

    vi.useRealTimers();
    await supervisor.stop();
  });

  it("blocks update and uninstall while tasks are running, and allows them once idle or forced", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r2-guard-"));
    const layout = resolveServerLayout(join(root, "server"));
    const releases = new ReleaseManager(layout);
    await releases.ensure();
    await mkdir(join(layout.releasesDir, "2.0.0"), { recursive: true });
    await releases.writePending({ version: "2.0.0", releaseDir: join(layout.releasesDir, "2.0.0") });

    const cores: FakeCore[] = [];
    const supervisor = new Supervisor({
      layout,
      launcher: {
        launch: (generation) => {
          const core = new FakeCore();
          cores.push(core);
          core.reportReady(generation);
          return core as unknown as ChildProcess;
        },
      },
      version: "test",
    });
    await supervisor.start();
    await waitForState(supervisor, "ready");

    cores[0]?.emit("message", { type: "task-activity", runningTaskCount: 2 });
    await new Promise<void>((resolve) => setImmediate(resolve));

    await expect(requestControl(layout.controlEndpoint, { command: "prepare-update" })).resolves.toMatchObject({
      status: "blocked",
      runningTaskCount: 2,
    });
    await expect(requestControl(layout.controlEndpoint, { command: "apply-update" })).rejects.toThrow(/--force/);
    // guard 拒绝时不得中断 Core（R2-CLI-09）。
    expect(supervisor.status().state).toBe("ready");

    // R2-CLI-10：有运行任务时 confirm-uninstall 必须被拒绝并保持原状态。
    await expect(
      requestControl(layout.controlEndpoint, { command: "confirm-uninstall", confirmation: "DELETE" }),
    ).rejects.toThrow(/Cannot uninstall/);
    expect(supervisor.status().state).toBe("ready");

    // --force 明确允许中断运行任务后应用 release。
    await expect(requestControl(layout.controlEndpoint, { command: "apply-update", force: true })).resolves.toMatchObject({
      applied: true,
      version: "2.0.0",
    });
    expect(supervisor.status().state).toBe("ready");
    expect(cores.length).toBe(2);

    // 任务清零后 uninstall 放行并停止 Server。
    cores[1]?.emit("message", { type: "task-activity", runningTaskCount: 0 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(
      requestControl(layout.controlEndpoint, { command: "confirm-uninstall", confirmation: "DELETE" }),
    ).resolves.toMatchObject({ uninstalled: true });
    await waitForState(supervisor, "stopped");
  });

  it("rolls back the current pointer and relaunches the previous release when the new core is unhealthy", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r2-rollback-"));
    const layout = resolveServerLayout(join(root, "server"));
    const releases = new ReleaseManager(layout);
    await releases.ensure();
    await mkdir(join(layout.releasesDir, "old"), { recursive: true });
    await mkdir(join(layout.releasesDir, "new"), { recursive: true });
    await releases.writePending({ version: "old", releaseDir: join(layout.releasesDir, "old") });
    await releases.applyPending();
    await releases.writePending({ version: "new", releaseDir: join(layout.releasesDir, "new") });
    const cores: FakeCore[] = [];
    const supervisor = new Supervisor({
      layout,
      launcher: {
        launch: (generation, release) => {
          const core = new FakeCore();
          cores.push(core);
          if (release?.version === "new") queueMicrotask(() => core.emit("exit", 1, null));
          else core.reportReady(generation);
          return core as unknown as ChildProcess;
        },
      },
      version: "test",
    });
    await supervisor.start();
    await waitForState(supervisor, "ready");
    await expect(requestControl(layout.controlEndpoint, { command: "apply-update", force: true })).rejects.toThrow(/failed while applying/);
    await waitForState(supervisor, "ready");
    expect(JSON.parse(await (await import("node:fs/promises")).readFile(layout.currentFile, "utf8"))).toMatchObject({ version: "old" });
    expect(cores.length).toBe(3);
    await supervisor.stop();
  });

  it("does not restart the failed candidate while rollback pointer restore is pending", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r2-rollback-race-"));
    const layout = resolveServerLayout(join(root, "server"));
    const releases = new ReleaseManager(layout);
    await releases.ensure();
    await mkdir(join(layout.releasesDir, "old"), { recursive: true });
    await mkdir(join(layout.releasesDir, "new"), { recursive: true });
    await releases.writePending({ version: "old", releaseDir: join(layout.releasesDir, "old") });
    await releases.applyPending();
    await releases.writePending({ version: "new", releaseDir: join(layout.releasesDir, "new") });

    const cores: Array<{ release: string | undefined; core: FakeCore }> = [];
    const supervisor = new Supervisor({
      layout,
      launcher: {
        launch: (generation, release) => {
          const core = new FakeCore();
          cores.push({ release: release?.version, core });
          if (release?.version === "new") queueMicrotask(() => core.emit("exit", 1, null));
          else core.reportReady(generation);
          return core as unknown as ChildProcess;
        },
      },
      version: "test",
    });

    await supervisor.start();
    await waitForState(supervisor, "ready");

    // 回滚文件操作可能被慢盘/杀毒软件拖过首个 crash backoff；期间不得让旧的
    // crashed 状态放行自动重启，否则坏 release 会再次启动并丢失 Supervisor 所有权。
    const internal = supervisor as unknown as { releaseManager: ReleaseManager };
    const originalRestoreCurrent = internal.releaseManager.restoreCurrent.bind(internal.releaseManager);
    internal.releaseManager.restoreCurrent = async (manifest) => {
      await new Promise<void>((resolve) => setTimeout(resolve, CRASH_BACKOFF_MS[0] + 100));
      await originalRestoreCurrent(manifest);
    };

    await expect(requestControl(layout.controlEndpoint, { command: "apply-update", force: true }, 10_000)).rejects.toThrow(
      /failed while applying update/i,
    );
    await waitForState(supervisor, "ready");

    expect(cores.map(({ release }) => release)).toEqual(["old", "new", "old"]);
    expect(JSON.parse(await readFile(layout.currentFile, "utf8"))).toMatchObject({ version: "old" });
    await supervisor.stop();
  });

  it("enters stop-failed and preserves the transaction marker when the rollback pointer cannot be restored", async () => {
    const root = await mkdtemp(join(tmpdir(), "zrbf-"));
    const layout = resolveServerLayout(join(root, "server"));
    const releases = new ReleaseManager(layout);
    await releases.ensure();
    const oldDir = join(layout.releasesDir, "old");
    const newDir = join(layout.releasesDir, "new");
    await mkdir(oldDir, { recursive: true });
    await mkdir(newDir, { recursive: true });
    await releases.writePending({ version: "old", releaseDir: oldDir });
    await releases.applyPending();
    await releases.writePending({ version: "new", releaseDir: newDir });
    const cores: FakeCore[] = [];
    const supervisor = new Supervisor({
      layout,
      launcher: {
        launch: (generation, release) => {
          const core = new FakeCore();
          cores.push(core);
          if (release?.version === "new") queueMicrotask(() => core.emit("exit", 1, null));
          else core.reportReady(generation);
          return core as unknown as ChildProcess;
        },
      },
      version: "test",
    });
    await supervisor.start();
    await waitForState(supervisor, "ready");
    await import("node:fs/promises").then(({ rm }) => rm(oldDir, { recursive: true, force: true }));

    await expect(requestControl(layout.controlEndpoint, { command: "apply-update", force: true })).rejects.toThrow(
      /rollback pointer restore failed/i,
    );
    expect(supervisor.status()).toMatchObject({ state: "stop-failed", pid: null });
    expect(supervisor.status().lastExitReason).toMatch(/rollback pointer restore failed/i);
    await expect(readFile(layout.updateTransactionFile, "utf8")).resolves.toContain("old");
    expect(cores).toHaveLength(2);
    await supervisor.stop();
  });

  it("survives a real fork spawn error and rolls back to the previous release without an exit event", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r2-spawn-error-"));
    const layout = resolveServerLayout(join(root, "server"));
    const releases = new ReleaseManager(layout);
    await releases.ensure();
    await mkdir(join(layout.releasesDir, "old"), { recursive: true });
    await mkdir(join(layout.releasesDir, "new"), { recursive: true });
    await releases.writePending({ version: "old", releaseDir: join(layout.releasesDir, "old") });
    await releases.applyPending();
    await releases.writePending({ version: "new", releaseDir: join(layout.releasesDir, "new") });

    const oldCores: FakeCore[] = [];
    const supervisor = new Supervisor({
      layout,
      launcher: {
        launch: (generation, release) => {
          if (release?.version === "new") {
            // 使用真实 ChildProcess 复现 Node 的 spawn 失败序列：error + close，无 exit。
            return fork(join(root, "never-loaded.js"), [], {
              execPath: join(root, "nonexistent-node"),
              stdio: ["ignore", "ignore", "ignore", "ipc"],
            });
          }
          const core = new FakeCore();
          oldCores.push(core);
          core.reportReady(generation);
          return core as unknown as ChildProcess;
        },
      },
      version: "test",
      coreReadyTimeoutMs: 1_000,
    });

    await supervisor.start();
    await waitForState(supervisor, "ready");
    await expect(
      requestControl(layout.controlEndpoint, { command: "apply-update", force: true }, 5_000),
    ).rejects.toThrow(/failed while applying/);
    await waitForState(supervisor, "ready");

    expect(JSON.parse(await readFile(layout.currentFile, "utf8"))).toMatchObject({ version: "old" });
    expect(oldCores).toHaveLength(2);
    expect(supervisor.status().lastExitReason).toContain("spawn");
    await supervisor.stop();
  });

  it("stops a still-running Core before rolling back after the ready timeout", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r2-rbto-"));
    const layout = resolveServerLayout(join(root, "server"));
    const releases = new ReleaseManager(layout);
    await releases.ensure();
    await mkdir(join(layout.releasesDir, "old"), { recursive: true });
    await mkdir(join(layout.releasesDir, "new"), { recursive: true });
    await releases.writePending({ version: "old", releaseDir: join(layout.releasesDir, "old") });
    await releases.applyPending();
    await releases.writePending({ version: "new", releaseDir: join(layout.releasesDir, "new") });

    let hangingCore: FakeCore | undefined;
    const cores: FakeCore[] = [];
    const supervisor = new Supervisor({
      layout,
      launcher: {
        launch: (generation, release) => {
          const core = new FakeCore();
          cores.push(core);
          if (release?.version === "new") hangingCore = core;
          else core.reportReady(generation);
          return core as unknown as ChildProcess;
        },
      },
      version: "test",
      coreReadyTimeoutMs: 100,
    });
    await supervisor.start();
    await waitForState(supervisor, "ready");

    const apply = requestControl(layout.controlEndpoint, { command: "apply-update", force: true }, 30_000);
    await expect(apply).rejects.toThrow(/failed while applying|Timed out/);
    await waitForState(supervisor, "ready");
    expect(hangingCore?.shutdownRequested).toBe(true);
    expect(cores.length).toBe(3);
    await supervisor.stop();
  });

  it("stops an unready rollback Core and ignores its late ready message", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r2-rb-old-timeout-"));
    const layout = resolveServerLayout(join(root, "server"));
    const releases = new ReleaseManager(layout);
    await releases.ensure();
    await mkdir(join(layout.releasesDir, "old"), { recursive: true });
    await mkdir(join(layout.releasesDir, "new"), { recursive: true });
    await releases.writePending({ version: "old", releaseDir: join(layout.releasesDir, "old") });
    await releases.applyPending();
    await releases.writePending({ version: "new", releaseDir: join(layout.releasesDir, "new") });

    const cores: FakeCore[] = [];
    let rollbackCore: FakeCore | undefined;
    const supervisor = new Supervisor({
      layout,
      launcher: {
        launch: (generation) => {
          const core = new FakeCore();
          cores.push(core);
          if (cores.length === 1) core.reportReady(generation);
          if (cores.length === 3) rollbackCore = core;
          return core as unknown as ChildProcess;
        },
      },
      version: "test",
      coreReadyTimeoutMs: 20,
    });
    await supervisor.start();
    await waitForState(supervisor, "ready");

    await expect(
      requestControl(layout.controlEndpoint, { command: "apply-update", force: true }, 5_000),
    ).rejects.toThrow(/Timed out/);
    expect(rollbackCore?.shutdownRequested).toBe(true);
    expect(supervisor.status()).toMatchObject({
      state: "stopped",
      pid: null,
      host: null,
      port: null,
    });

    rollbackCore?.reportReady(3);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(supervisor.status()).toMatchObject({ state: "stopped", pid: null });
    await supervisor.stop();
  });

  it("enters stop-failed when an unready rollback Core cannot terminate", async () => {
    const root = await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "zrbf-"));
    const layout = resolveServerLayout(join(root, "server"));
    const releases = new ReleaseManager(layout);
    await releases.ensure();
    await mkdir(join(layout.releasesDir, "old"), { recursive: true });
    await mkdir(join(layout.releasesDir, "new"), { recursive: true });
    await releases.writePending({ version: "old", releaseDir: join(layout.releasesDir, "old") });
    await releases.applyPending();
    await releases.writePending({ version: "new", releaseDir: join(layout.releasesDir, "new") });

    const cores: FakeCore[] = [];
    let rollbackCore: FakeCore | undefined;
    const supervisor = new Supervisor({
      layout,
      launcher: {
        launch: (generation) => {
          const core = new FakeCore();
          cores.push(core);
          if (cores.length === 1) core.reportReady(generation);
          if (cores.length === 3) {
            rollbackCore = core;
            core.exitOnShutdown = false;
            core.exitOnKill = false;
          }
          return core as unknown as ChildProcess;
        },
      },
      version: "test",
      coreReadyTimeoutMs: 20,
      coreStopGraceTimeoutMs: 5,
      coreKillTimeoutMs: 5,
    });
    await supervisor.start();
    await waitForState(supervisor, "ready");

    await expect(
      requestControl(layout.controlEndpoint, { command: "apply-update", force: true }, 5_000),
    ).rejects.toThrow(/did not terminate/);
    expect(rollbackCore?.shutdownRequested).toBe(true);
    expect(rollbackCore?.killRequested).toBe(true);
    expect(supervisor.status()).toMatchObject({ state: "stop-failed", pid: 42 });

    rollbackCore?.reportReady(3);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(supervisor.status()).toMatchObject({ state: "stop-failed", pid: 42 });

    rollbackCore?.emit("exit", null, "SIGKILL");
    await new Promise<void>((resolve) => setImmediate(resolve));
    await supervisor.stop();
  });

  it("allows only one concurrent apply-update lifecycle owner", async () => {
    const root = await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "zca-"));
    const layout = resolveServerLayout(join(root, "server"));
    const releases = new ReleaseManager(layout);
    await releases.ensure();
    await mkdir(join(layout.releasesDir, "old"), { recursive: true });
    await mkdir(join(layout.releasesDir, "new"), { recursive: true });
    await releases.writePending({ version: "old", releaseDir: join(layout.releasesDir, "old") });
    await releases.applyPending();
    await releases.writePending({ version: "new", releaseDir: join(layout.releasesDir, "new") });

    const cores: FakeCore[] = [];
    const supervisor = new Supervisor({
      layout,
      launcher: {
        launch: (generation) => {
          const core = new FakeCore();
          cores.push(core);
          core.reportReady(generation);
          return core as unknown as ChildProcess;
        },
      },
      version: "test",
    });
    await supervisor.start();
    await waitForState(supervisor, "ready");

    const results = await Promise.allSettled([
      requestControl(layout.controlEndpoint, { command: "apply-update", force: true }),
      requestControl(layout.controlEndpoint, { command: "apply-update", force: true }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: expect.objectContaining({
        code: "operation-in-progress",
        message: expect.stringMatching(/operation.*progress/i),
        retryable: true,
      }),
    });
    expect(cores).toHaveLength(2);
    await supervisor.stop();
  });

  it("returns operation-in-progress before acknowledging a conflicting lifecycle request", async () => {
    const root = await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "zco-"));
    const layout = resolveServerLayout(join(root, "server"));
    const releases = new ReleaseManager(layout);
    await releases.ensure();
    await mkdir(join(layout.releasesDir, "old"), { recursive: true });
    await mkdir(join(layout.releasesDir, "new"), { recursive: true });
    await releases.writePending({ version: "old", releaseDir: join(layout.releasesDir, "old") });
    await releases.applyPending();
    await releases.writePending({ version: "new", releaseDir: join(layout.releasesDir, "new") });
    const cores: FakeCore[] = [];
    const supervisor = new Supervisor({
      layout,
      launcher: {
        launch: (generation) => {
          const core = new FakeCore();
          cores.push(core);
          if (generation !== 2) core.reportReady(generation);
          return core as unknown as ChildProcess;
        },
      },
      version: "test",
      coreReadyTimeoutMs: 100,
    });
    await supervisor.start();
    await waitForState(supervisor, "ready");

    const apply = requestControl(layout.controlEndpoint, { command: "apply-update", force: true }, 5_000);
    while (cores.length < 2) await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(requestControl(layout.controlEndpoint, { command: "restart" })).rejects.toMatchObject({
      code: "operation-in-progress",
      retryable: true,
    });
    await expect(apply).rejects.toThrow(/timed out/i);
    await waitForState(supervisor, "ready");
    await supervisor.stop();
  });

  it("keeps the lock and enters stop-failed until Core termination is observed", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r2-stop-failed-"));
    const layout = resolveServerLayout(join(root, "server"));
    const core = new FakeCore();
    core.exitOnShutdown = false;
    core.exitOnKill = false;
    const supervisor = new Supervisor({
      layout,
      launcher: {
        launch: (generation) => {
          core.reportReady(generation);
          return core as unknown as ChildProcess;
        },
      },
      version: "test",
      coreStopGraceTimeoutMs: 5,
      coreKillTimeoutMs: 5,
    });
    await supervisor.start();
    await waitForState(supervisor, "ready");

    await expect(supervisor.stop()).rejects.toThrow(/did not terminate/i);
    expect(core.shutdownRequested).toBe(true);
    expect(core.killRequested).toBe(true);
    expect(supervisor.status()).toMatchObject({ state: "stop-failed", pid: 42 });
    await expect(requestControl(layout.controlEndpoint, { command: "status" })).resolves.toMatchObject({
      state: "stop-failed",
      pid: 42,
    });

    const competing = new Supervisor({
      layout,
      launcher: { launch: () => new FakeCore() as unknown as ChildProcess },
      version: "test",
    });
    await expect(competing.start()).rejects.toThrow(/already running/i);

    core.emit("exit", null, "SIGKILL");
    expect(supervisor.status()).toMatchObject({ state: "stop-failed", pid: null });
    await expect(competing.start()).rejects.toThrow(/already running/i);

    await supervisor.stop();
    await expect(competing.start()).resolves.toMatchObject({ state: "starting" });
    await competing.stop();
  });

  it("clears Core-scoped state and ignores stale child or generation messages", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r2-generation-"));
    vi.useFakeTimers();
    const cores: FakeCore[] = [];
    const supervisor = new Supervisor({
      layout: resolveServerLayout(join(root, "server")),
      launcher: {
        launch: (generation) => {
          const core = new FakeCore();
          cores.push(core);
          if (generation === 1) core.reportReady(generation);
          return core as unknown as ChildProcess;
        },
      },
      version: "test",
    });
    await supervisor.start();
    await vi.runAllTicks();
    expect(supervisor.status().state).toBe("ready");

    cores[0]?.emit("message", { type: "task-activity", runningTaskCount: 3 });
    expect(supervisor.status().runningTaskCount).toBe(3);
    cores[0]?.emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(CRASH_BACKOFF_MS[0]);
    expect(cores).toHaveLength(2);
    expect(supervisor.status()).toMatchObject({
      state: "starting",
      generation: 2,
      runningTaskCount: 0,
      host: null,
      port: null,
      startedAt: null,
    });

    cores[0]?.emit("message", { type: "heartbeat", at: Date.now(), runningTaskCount: 7 });
    cores[0]?.reportReady(1);
    cores[1]?.reportReady(999);
    await vi.runAllTicks();
    expect(supervisor.status()).toMatchObject({ state: "starting", generation: 2, runningTaskCount: 0 });

    cores[1]?.reportReady(2);
    await vi.runAllTicks();
    expect(supervisor.status()).toMatchObject({ state: "ready", generation: 2, runningTaskCount: 0 });

    vi.useRealTimers();
    await supervisor.stop();
  });
});
