import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitEnvironmentProvider } from "../src/git/providers/gitEnvironmentProvider.js";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

import { createGitCommandProvider } from "../src/git/providers/gitCommandProvider.js";

function createMockChild(pid = 12345) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    unref: ReturnType<typeof vi.fn>;
    pid: number;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => true);
  child.unref = vi.fn();
  child.pid = pid;
  return child;
}

function createEnvironmentProvider(binaryPath = "git"): GitEnvironmentProvider {
  return {
    resolveGitBinary: vi.fn().mockResolvedValue(binaryPath),
    createCommandEnv: vi.fn(() => ({})),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(0));
  spawnMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("gitCommandProvider timeout cleanup", () => {
  it("returns after bounded cleanup when a timed-out child never closes", async () => {
    const child = createMockChild();
    spawnMock.mockReturnValue(child);
    const provider = createGitCommandProvider({
      environmentProvider: createEnvironmentProvider(),
      platform: "darwin",
      timeoutKillGraceMs: 5,
      timeoutForceKillGraceMs: 5,
    });

    const resultPromise = provider.run({
      cwd: "/repo",
      args: ["status"],
      timeoutMs: 10,
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(child.kill).toHaveBeenCalledWith();

    await vi.advanceTimersByTimeAsync(5);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");

    await vi.advanceTimersByTimeAsync(5);
    const result = await resultPromise;

    expect(result).toMatchObject({
      timedOut: true,
      timeoutMs: 10,
      timeoutElapsedMs: 10,
      timeoutCloseDelayMs: 10,
      forceKillAttempted: true,
      orphaned: true,
      durationMs: 20,
    });
    expect(child.unref).toHaveBeenCalledTimes(1);
  });

  it("uses taskkill to force-kill the process tree on Windows timeouts", async () => {
    const child = createMockChild(24680);
    const taskkillChild = createMockChild(13579);
    spawnMock.mockImplementation((command: string) => {
      return command === "taskkill" ? taskkillChild : child;
    });
    const provider = createGitCommandProvider({
      environmentProvider: createEnvironmentProvider(),
      platform: "win32",
      timeoutKillGraceMs: 5,
      timeoutForceKillGraceMs: 5,
    });

    const resultPromise = provider.run({
      cwd: "/repo",
      args: ["status"],
      timeoutMs: 10,
    });

    await vi.advanceTimersByTimeAsync(15);

    expect(spawnMock).toHaveBeenCalledWith(
      "taskkill",
      ["/PID", "24680", "/T", "/F"],
      {
        stdio: "ignore",
        windowsHide: true,
      },
    );

    taskkillChild.emit("close", 0, null);
    await vi.advanceTimersByTimeAsync(5);
    const result = await resultPromise;

    expect(result.timedOut).toBe(true);
    expect(result.forceKillAttempted).toBe(true);
    expect(result.orphaned).toBe(true);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("uses the child close result when the process exits during the grace period", async () => {
    const child = createMockChild();
    spawnMock.mockReturnValue(child);
    const provider = createGitCommandProvider({
      environmentProvider: createEnvironmentProvider(),
      platform: "darwin",
      timeoutKillGraceMs: 5,
      timeoutForceKillGraceMs: 5,
    });

    const resultPromise = provider.run({
      cwd: "/repo",
      args: ["status"],
      timeoutMs: 10,
    });

    await vi.advanceTimersByTimeAsync(10);
    child.emit("close", null, "SIGTERM");
    const result = await resultPromise;

    expect(result).toMatchObject({
      timedOut: true,
      timeoutMs: 10,
      timeoutElapsedMs: 10,
      timeoutCloseDelayMs: 0,
      forceKillAttempted: false,
      orphaned: false,
      signal: "SIGTERM",
      durationMs: 10,
    });
  });
});
