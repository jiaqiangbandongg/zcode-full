import { access, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  APPLY_UPDATE_TIMEOUT_MS,
  daemonStartupMode,
  isRegisteredServiceEntry,
  runServerCli,
  SERVER_SERVICE_ARGS,
  serviceRegistrationEnabled,
  shouldRegisterService,
} from "../src/cli.js";
import { createControlServer } from "../src/ipc/controlServer.js";
import { currentServerTarget } from "../src/runtime/manifest.js";
import { resolveServerLayout } from "../src/runtime/paths.js";
import { ReleaseManager } from "../src/runtime/releaseManager.js";
import { DataRootLock } from "../src/runtime/lock.js";

async function createTestReleaseArchive(root: string, version: string): Promise<{ archivePath: string; archiveSha256: string }> {
  const archiveRoot = join(root, `zcode-server-${currentServerTarget()}`);
  await mkdir(join(archiveRoot, "runtime"), { recursive: true });
  await writeFile(join(archiveRoot, "runtime", "node"), "node", "utf8");
  await writeFile(join(archiveRoot, "runtime", "server-cli.js"), "", "utf8");
  await writeFile(join(archiveRoot, "runtime", "server-core.js"), "", "utf8");
  await writeFile(join(archiveRoot, "runtime", "zcode.cjs"), "", "utf8");
  await writeFile(join(archiveRoot, "runtime", "package.json"), JSON.stringify({ type: "module" }), "utf8");
  await writeFile(
    join(archiveRoot, "manifest.json"),
    JSON.stringify({
      product: "zcode-server",
      target: currentServerTarget(),
      appVersion: version,
      nodeVersion: "22.16.0",
      entrypoints: { cli: "runtime/server-cli.js", core: "runtime/server-core.js", agent: "runtime/zcode.cjs" },
      native: [],
    }),
    "utf8",
  );
  const archivePath = join(root, "release.tar.gz");
  const { execFile } = await import("node:child_process");
  await new Promise<void>((resolve, reject) => {
    // Bugfix：绝对路径 `C:\...\release.tar.gz` 会被 GNU tar 当成 `host:path` 远程规格，
    // 在 Windows 上报 `Cannot connect to C: resolve failed`。cwd 已经是 root，改传相对
    // 归档名即可绕开盘符解析；不用 --force-local，因为那是 GNU 独有选项，Windows 自带
    // 的 bsdtar（System32\tar.exe）不认。
    execFile("tar", ["-czf", "release.tar.gz", archiveRoot.slice(root.length + 1)], { cwd: root }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  const archiveSha256 = createHash("sha256").update(await readFile(archivePath)).digest("hex");
  return { archivePath, archiveSha256 };
}

describe("Server CLI routing", () => {
  it("budgets apply-update timeout for the complete bounded rollback path", () => {
    expect(APPLY_UPDATE_TIMEOUT_MS).toBeGreaterThanOrEqual(51_000);
  });

  it("honors the explicit service-registration opt-out", () => {
    vi.stubEnv("ZCODE_SERVER_SKIP_SERVICE_REGISTRATION", "1");
    try {
      expect(serviceRegistrationEnabled()).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps OS service registration in the outer daemon invocation", () => {
    expect(SERVER_SERVICE_ARGS).toEqual(["serve", "--supervisor"]);
    expect(isRegisteredServiceEntry(SERVER_SERVICE_ARGS.slice(1))).toBe(false);
    expect(isRegisteredServiceEntry(["--supervisor", "--service-entry"])).toBe(true);
    expect(daemonStartupMode({ ZCODE_SERVER_SKIP_SERVICE_REGISTRATION: "1" })).toBe("fallback");
    expect(daemonStartupMode({})).toBe("service");
    expect(shouldRegisterService(true, false)).toBe(true);
    expect(shouldRegisterService(true, true)).toBe(false);
    expect(shouldRegisterService(false, true)).toBe(false);
  });

  it("delegates no-argument and unknown commands without loading Core", async () => {
    const calls: string[][] = [];
    const exit = await runServerCli([], { legacyDelegate: async (argv) => { calls.push([...argv]); return 7; } });
    expect(exit).toBe(7);
    expect(calls).toEqual([[]]);
  });

  it("supports an injected legacy delegate for non-server commands", async () => {
    const calls: string[][] = [];
    const exit = await runServerCli(["login"], { legacyDelegate: async (argv) => { calls.push([...argv]); return 0; } });
    expect(exit).toBe(0);
    expect(calls).toEqual([["login"]]);
  });

  it("treats stop as an idempotent no-op after the supervisor socket is gone", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r2-cli-stop-"));
    vi.stubEnv("ZCODE_DATA_BASE_DIR", root);
    const layout = resolveServerLayout();
    await mkdir(layout.runDir, { recursive: true });
    await writeFile(layout.statusFile, `${JSON.stringify({
      protocolVersion: 1,
      state: "stopped",
      pid: null,
      port: 43123,
      host: "127.0.0.1",
      version: "test",
      generation: 1,
      startedAt: null,
      lastExitReason: "requested",
      serviceRegistered: true,
      runningTaskCount: 0,
      crashBudget: { crashCount: 0, nextRestartDelayMs: 1000, exhausted: false },
      updatedAt: Date.now(),
    })}\n`, "utf8");
    const output: string[] = [];

    try {
      const exit = await runServerCli(["stop", "--json"], { stdout: { write: (value) => output.push(value) } });

      expect(exit).toBe(0);
      expect(JSON.parse(output.join(""))).toMatchObject({ state: "stopped" });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("uses an explicit absolute --server-root for status instead of the process default", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r2-cli-explicit-root-"));
    const serverRoot = join(root, ".zcode", "server");
    const layout = resolveServerLayout(serverRoot);
    await mkdir(layout.runDir, { recursive: true });
    await writeFile(layout.statusFile, `${JSON.stringify({
      protocolVersion: 1,
      state: "ready",
      pid: 123,
      port: 43124,
      host: "127.0.0.1",
      version: "root-test",
      generation: 1,
      startedAt: Date.now(),
      lastExitReason: null,
      serviceRegistered: true,
      runningTaskCount: 0,
      crashBudget: { crashCount: 0, nextRestartDelayMs: 1_000, exhausted: false },
      updatedAt: Date.now(),
    })}\n`, "utf8");
    const output: string[] = [];

    const exit = await runServerCli(["status", "--server-root", serverRoot, "--json"], {
      stdout: { write: (value) => output.push(value) },
    });

    expect(exit).toBe(0);
    expect(JSON.parse(output.join(""))).toMatchObject({ state: "ready", version: "root-test" });
  });

  it("rejects a relative --server-root before performing lifecycle IO", async () => {
    const errors: string[] = [];
    const exit = await runServerCli(["status", "--server-root", "relative/server"], {
      stderr: { write: (value) => errors.push(value) },
    });
    expect(exit).toBe(1);
    expect(errors.join("")).toContain("--server-root must be an absolute path");
  });

  it("rejects update before fetching or installing when tasks are running", async () => {
    const root = await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "zcode-r2-cli-update-guard-"));
    const layout = resolveServerLayout(join(root, ".zcode", "server"));
    const commands: string[] = [];
    const control = await createControlServer(layout.controlEndpoint, async (request) => {
      commands.push(request.command);
      if (request.command === "prepare-update") return { status: "blocked", runningTaskCount: 1 };
      throw new Error(`Unexpected control command: ${request.command}`);
    });
    let catalogRequests = 0;
    const catalogServer = createServer((_request, response) => {
      catalogRequests += 1;
      const address = catalogServer.address();
      if (!address || typeof address === "string") throw new Error("catalog server is not listening");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        schemaVersion: 1,
        releases: [{
          version: "4.0.0",
          target: currentServerTarget(),
          archiveUrl: `http://127.0.0.1:${address.port}/unused.tar.gz`,
          archiveSha256: "b".repeat(64),
        }],
      }));
    });
    await new Promise<void>((resolve) => catalogServer.listen(0, "127.0.0.1", resolve));
    const address = catalogServer.address();
    if (!address || typeof address === "string") throw new Error("catalog server is not listening");
    vi.stubEnv("ZCODE_SERVER_RELEASE_MANIFEST_URL", `http://127.0.0.1:${address.port}/catalog.json`);
    const errors: string[] = [];
    try {
      const exit = await runServerCli(["update", "--server-root", layout.serverRoot], {
        stderr: { write: (value) => errors.push(value) },
      });

      expect(exit).toBe(1);
      expect(errors.join("")).toContain("Running tasks require --force for update");
      expect(commands).toEqual(["prepare-update"]);
      expect(catalogRequests).toBe(0);
      await expect(access(layout.pendingFile)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(layout.releasesDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      vi.unstubAllEnvs();
      await control.close();
      await new Promise<void>((resolve) => catalogServer.close(() => resolve()));
    }
  });

  it("discards a prepared release when a task starts during preparation", async () => {
    const root = await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "zcode-r2-cli-update-race-"));
    const layout = resolveServerLayout(join(root, "server"));
    const release = await createTestReleaseArchive(root, "4.0.0");
    const commands: string[] = [];
    let prepareCalls = 0;
    const control = await createControlServer(layout.controlEndpoint, async (request) => {
      commands.push(request.command);
      if (request.command !== "prepare-update") throw new Error(`Unexpected control command: ${request.command}`);
      prepareCalls += 1;
      return prepareCalls === 1
        ? { status: "ready", runningTaskCount: 0 }
        : { status: "blocked", runningTaskCount: 1 };
    });
    const catalogServer = createServer(async (request, response) => {
      const address = catalogServer.address();
      if (!address || typeof address === "string") throw new Error("catalog server is not listening");
      response.setHeader("content-type", request.url === "/catalog.json" ? "application/json" : "application/gzip");
      if (request.url === "/catalog.json") {
        response.end(JSON.stringify({
          schemaVersion: 1,
          releases: [{
            version: "4.0.0",
            target: currentServerTarget(),
            archiveUrl: `http://127.0.0.1:${address.port}/release.tar.gz`,
            archiveSha256: release.archiveSha256,
          }],
        }));
      } else {
        response.end(await readFile(release.archivePath));
      }
    });
    await new Promise<void>((resolve) => catalogServer.listen(0, "127.0.0.1", resolve));
    const address = catalogServer.address();
    if (!address || typeof address === "string") throw new Error("catalog server is not listening");
    vi.stubEnv("ZCODE_SERVER_RELEASE_MANIFEST_URL", `http://127.0.0.1:${address.port}/catalog.json`);
    const errors: string[] = [];
    try {
      const exit = await runServerCli(["update", "--server-root", layout.serverRoot], {
        stderr: { write: (value) => errors.push(value) },
      });

      expect(exit).toBe(1);
      expect(errors.join("")).toContain("Running tasks require --force for update");
      expect(commands).toEqual(["prepare-update", "prepare-update"]);
      await expect(access(layout.pendingFile)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readdir(layout.releasesDir)).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      await control.close();
      await new Promise<void>((resolve) => catalogServer.close(() => resolve()));
    }
  });

  it("discards a prepared release when apply-update observes a late task", async () => {
    const root = await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "zcode-r2-cli-update-late-guard-"));
    const layout = resolveServerLayout(join(root, "server"));
    const release = await createTestReleaseArchive(root, "4.0.1");
    const commands: string[] = [];
    const control = await createControlServer(layout.controlEndpoint, async (request) => {
      commands.push(request.command);
      if (request.command === "prepare-update") return { status: "ready", runningTaskCount: 0 };
      if (request.command === "apply-update") throw new Error("Running tasks require --force for update");
      throw new Error(`Unexpected control command: ${request.command}`);
    });
    const catalogServer = createServer(async (request, response) => {
      const address = catalogServer.address();
      if (!address || typeof address === "string") throw new Error("catalog server is not listening");
      response.setHeader("content-type", request.url === "/catalog.json" ? "application/json" : "application/gzip");
      if (request.url === "/catalog.json") {
        response.end(JSON.stringify({
          schemaVersion: 1,
          releases: [{
            version: "4.0.1",
            target: currentServerTarget(),
            archiveUrl: `http://127.0.0.1:${address.port}/release.tar.gz`,
            archiveSha256: release.archiveSha256,
          }],
        }));
      } else {
        response.end(await readFile(release.archivePath));
      }
    });
    await new Promise<void>((resolve) => catalogServer.listen(0, "127.0.0.1", resolve));
    const address = catalogServer.address();
    if (!address || typeof address === "string") throw new Error("catalog server is not listening");
    vi.stubEnv("ZCODE_SERVER_RELEASE_MANIFEST_URL", `http://127.0.0.1:${address.port}/catalog.json`);
    const errors: string[] = [];
    try {
      const exit = await runServerCli(["update", "--server-root", layout.serverRoot], {
        stderr: { write: (value) => errors.push(value) },
      });

      expect(exit).toBe(1);
      expect(errors.join("")).toContain("Running tasks require --force for update");
      expect(commands).toEqual(["prepare-update", "prepare-update", "apply-update"]);
      await expect(access(layout.pendingFile)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readdir(layout.releasesDir)).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      await control.close();
      await new Promise<void>((resolve) => catalogServer.close(() => resolve()));
    }
  });

  it("returns a successful up-to-date outcome without sending apply-update", async () => {
    const root = await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "zcode-r2-cli-up-to-date-"));
    const layout = resolveServerLayout(join(root, ".zcode", "server"));
    const releases = new ReleaseManager(layout);
    await releases.ensure();
    const releaseDir = join(layout.releasesDir, "current");
    await mkdir(releaseDir, { recursive: true });
    await releases.writePending({
      version: "3.0.0",
      releaseDir,
      target: currentServerTarget(),
      archiveSha256: "a".repeat(64),
    });
    await releases.applyPending();
    const staleReleaseDir = join(layout.releasesDir, "stale");
    await mkdir(staleReleaseDir, { recursive: true });
    await releases.writePending({
      version: "2.0.0",
      releaseDir: staleReleaseDir,
      target: currentServerTarget(),
      archiveSha256: "b".repeat(64),
    });
    const catalogServer = createServer((_request, response) => {
      const address = catalogServer.address();
      if (!address || typeof address === "string") throw new Error("catalog server is not listening");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        schemaVersion: 1,
        releases: [{
          version: "3.0.0",
          target: currentServerTarget(),
          archiveUrl: `http://127.0.0.1:${address.port}/unused.tar.gz`,
          archiveSha256: "a".repeat(64),
        }],
      }));
    });
    await new Promise<void>((resolve) => catalogServer.listen(0, "127.0.0.1", resolve));
    const address = catalogServer.address();
    if (!address || typeof address === "string") throw new Error("catalog server is not listening");
    vi.stubEnv("ZCODE_SERVER_RELEASE_MANIFEST_URL", `http://127.0.0.1:${address.port}/catalog.json`);
    const commands: string[] = [];
    const control = await createControlServer(layout.controlEndpoint, async (request) => {
      commands.push(request.command);
      return { status: "ready", runningTaskCount: 0 };
    });
    const output: string[] = [];
    try {
      const exit = await runServerCli(["update", "--server-root", layout.serverRoot, "--json"], {
        stdout: { write: (value) => output.push(value) },
      });
      expect(exit).toBe(0);
      expect(JSON.parse(output.join(""))).toMatchObject({ status: "up-to-date", version: "3.0.0" });
      expect(commands).toEqual(["prepare-update"]);
      await expect(access(layout.pendingFile)).rejects.toMatchObject({ code: "ENOENT" });

      const futureReleaseDir = join(layout.releasesDir, "future");
      await mkdir(futureReleaseDir, { recursive: true });
      await releases.writePending({
        version: "4.0.0",
        releaseDir: futureReleaseDir,
        target: currentServerTarget(),
        archiveSha256: "c".repeat(64),
      });
      output.length = 0;
      await expect(runServerCli(["update", "--server-root", layout.serverRoot, "--json"], {
        stdout: { write: (value) => output.push(value) },
      })).resolves.toBe(0);
      await expect(access(layout.pendingFile)).resolves.toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
      await control.close();
      await new Promise<void>((resolve) => catalogServer.close(() => resolve()));
    }
  });

  it("reports a clear source error when neither catalog nor pending release exists", async () => {
    const root = await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "zcode-r2-cli-no-source-"));
    const layout = resolveServerLayout(join(root, ".zcode", "server"));
    const errors: string[] = [];
    vi.stubEnv("ZCODE_SERVER_RELEASE_MANIFEST_URL", "");
    const control = await createControlServer(layout.controlEndpoint, async (request) => {
      if (request.command === "prepare-update") return { status: "ready", runningTaskCount: 0 };
      throw new Error(`Unexpected control command: ${request.command}`);
    });
    try {
      const exit = await runServerCli(["update", "--server-root", layout.serverRoot], {
        stderr: { write: (value) => errors.push(value) },
      });
      expect(exit).toBe(1);
      expect(errors.join("")).toContain("release source is not configured");
    } finally {
      vi.unstubAllEnvs();
      await control.close();
    }
  });

  it("applies an offline pending release when no catalog is configured", async () => {
    const root = await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "zcode-r2-offline-"));
    const layout = resolveServerLayout(join(root, ".zcode", "server"));
    const releases = new ReleaseManager(layout);
    await releases.ensure();
    const releaseDir = join(layout.releasesDir, "offline");
    await mkdir(releaseDir, { recursive: true });
    await releases.writePending({ version: "3.1.0", releaseDir });
    const commands: string[] = [];
    const control = await createControlServer(layout.controlEndpoint, async (request) => {
      commands.push(request.command);
      if (request.command === "prepare-update") return { status: "ready", runningTaskCount: 0 };
      return { applied: true, version: "3.1.0" };
    });
    const output: string[] = [];
    vi.stubEnv("ZCODE_SERVER_RELEASE_MANIFEST_URL", "");
    try {
      const exit = await runServerCli(["update", "--server-root", layout.serverRoot, "--json"], {
        stdout: { write: (value) => output.push(value) },
      });
      expect(exit).toBe(0);
      expect(commands).toEqual(["prepare-update", "apply-update"]);
      expect(JSON.parse(output.join(""))).toMatchObject({ applied: true, version: "3.1.0" });

      commands.length = 0;
      const forcedOutput: string[] = [];
      const forcedExit = await runServerCli(["update", "--server-root", layout.serverRoot, "--json", "--force"], {
        stdout: { write: (value) => forcedOutput.push(value) },
      });
      expect(forcedExit).toBe(0);
      expect(commands).toEqual(["apply-update"]);
      expect(JSON.parse(forcedOutput.join(""))).toMatchObject({ applied: true, version: "3.1.0" });
    } finally {
      vi.unstubAllEnvs();
      await control.close();
    }
  });

  it("cancels uninstall unless both confirmations are exactly DELETE (R2-CLI-10)", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r2-cli-uninstall-cancel-"));
    vi.stubEnv("ZCODE_DATA_BASE_DIR", root);
    const errors: string[] = [];
    try {
      const layout = resolveServerLayout();
      await mkdir(layout.serverRoot, { recursive: true });
      await writeFile(join(layout.serverRoot, "current.json"), "{}", "utf8");
      const answers = ["DELETE", "delete"];
      const exit = await runServerCli(["uninstall"], {
        stderr: { write: (value) => errors.push(value) },
        confirm: async () => answers.shift() ?? "",
      });
      expect(exit).toBe(1);
      expect(errors.join("")).toContain("Uninstall cancelled");
      // 第二次确认失败时不得触碰任何数据。
      await expect(readFile(join(layout.serverRoot, "current.json"), "utf8")).resolves.toBe("{}");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refuses to uninstall a directory without ZCode Server ownership", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r2-cli-uninstall-unowned-"));
    const serverRoot = join(root, "Documents");
    await mkdir(serverRoot, { recursive: true });
    await writeFile(join(serverRoot, "taxes.pdf"), "user data", "utf8");
    const errors: string[] = [];

    const exit = await runServerCli(["uninstall", "--server-root", serverRoot], {
      stderr: { write: (value) => errors.push(value) },
      confirm: async () => "DELETE",
    });

    expect(exit).toBe(1);
    expect(errors.join("")).toContain("ownership");
    await expect(readFile(join(serverRoot, "taxes.pdf"), "utf8")).resolves.toBe("user data");
  });

  it("uninstalls offline data, writes the uninstalled marker and keeps user files (R2-CLI-11)", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r2-cli-uninstall-"));
    vi.stubEnv("ZCODE_DATA_BASE_DIR", root);
    try {
      const layout = resolveServerLayout();
      await new ReleaseManager(layout).ensure();
      await writeFile(join(layout.serverRoot, "current.json"), "{}", "utf8");
      await writeFile(join(layout.serverRoot, "taxes.pdf"), "user data inside custom root", "utf8");
      // serverRoot 之外的目录代表 Workspace/用户文件，卸载后必须原样保留。
      const workspaceDir = join(root, "workspace");
      await mkdir(workspaceDir, { recursive: true });
      await writeFile(join(workspaceDir, "keep.txt"), "user data", "utf8");

      const output: string[] = [];
      const exit = await runServerCli(["uninstall", "--json"], {
        stdout: { write: (value) => output.push(value) },
        confirm: async () => "DELETE",
      });

      expect(exit).toBe(0);
      expect(JSON.parse(output.join(""))).toMatchObject({
        uninstalled: true,
        preservedPaths: ["taxes.pdf"],
      });
      // spec §8：卸载后写出 uninstalled 标记，供后续 Controller/Transport 读取。
      const marker = JSON.parse(await readFile(join(layout.serverRoot, "uninstalled.json"), "utf8")) as {
        uninstalled: boolean;
      };
      expect(marker.uninstalled).toBe(true);
      await expect(access(join(layout.serverRoot, "current.json"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(layout.installFile)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(layout.releasesDir)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(layout.serverRoot, "taxes.pdf"), "utf8")).resolves.toBe("user data inside custom root");
      await expect(readFile(join(workspaceDir, "keep.txt"), "utf8")).resolves.toBe("user data");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("fails closed when control is unavailable and the lock is malformed", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r2-cli-uninstall-corrupt-lock-"));
    vi.stubEnv("ZCODE_DATA_BASE_DIR", root);
    try {
      const layout = resolveServerLayout();
      await new ReleaseManager(layout).ensure();
      await writeFile(layout.lockFile, "not-json", "utf8");
      await writeFile(join(layout.serverRoot, "keep.txt"), "must remain", "utf8");
      const errors: string[] = [];
      const exit = await runServerCli(["uninstall"], {
        stderr: { write: (value) => errors.push(value) },
        confirm: async () => "DELETE",
      });
      expect(exit).toBe(1);
      expect(errors.join("")).toMatch(/lock|running|unable|stopped/i);
      await expect(readFile(join(layout.serverRoot, "keep.txt"), "utf8")).resolves.toBe("must remain");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("fails closed when a live lock owner is present even if status is corrupt", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r2-cli-uninstall-live-lock-"));
    vi.stubEnv("ZCODE_DATA_BASE_DIR", root);
    const layout = resolveServerLayout();
    const lock = new DataRootLock(layout.lockFile);
    try {
      await new ReleaseManager(layout).ensure();
      await lock.acquire();
      await writeFile(layout.statusFile, "{broken", "utf8");
      await writeFile(join(layout.serverRoot, "keep.txt"), "must remain", "utf8");
      const errors: string[] = [];
      const exit = await runServerCli(["uninstall"], {
        stderr: { write: (value) => errors.push(value) },
        confirm: async () => "DELETE",
      });
      expect(exit).toBe(1);
      expect(errors.join("")).toMatch(/held by pid/);
      await expect(readFile(join(layout.serverRoot, "keep.txt"), "utf8")).resolves.toBe("must remain");
    } finally {
      await lock.release();
      vi.unstubAllEnvs();
    }
  });

  it("returns a complete stopped status when the endpoint and snapshot are absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r2-cli-status-fallback-"));
    const serverRoot = join(root, "server");
    const output: string[] = [];
    const exit = await runServerCli(["status", "--server-root", serverRoot, "--json"], {
      stdout: { write: (value) => output.push(value) },
    });
    expect(exit).toBe(0);
    const parsed = JSON.parse(output.join(""));
    expect(parsed).toMatchObject({ state: "stopped", serviceRegistered: false });
    expect(parsed).toHaveProperty("pid", null);
    expect(parsed).toHaveProperty("crashBudget");
  });
});
