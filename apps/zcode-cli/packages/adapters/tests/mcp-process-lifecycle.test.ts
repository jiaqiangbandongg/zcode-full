import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpAdapter } from "../src/mcp/index.js";
import { terminateMcpStdioProcessTree } from "../src/mcp/process-tree.js";
import { createMcpTelemetryTracker } from "../src/mcp/telemetry.js";

describe("MCP stdio process lifecycle", () => {
  const cleanupPids = new Set<number>();

  afterEach(() => {
    for (const pid of cleanupPids) {
      forceKillPid(pid);
    }
    cleanupPids.clear();
  });

  it("uses taskkill to terminate stdio MCP process trees on Windows", async () => {
    const execFileMock = vi.fn(async () => createCommandResult({ status: 0 }));
    const killMock = vi.fn((pid: number, signal?: NodeJS.Signals | 0) => {
      if (signal === 0 && pid === 1234) return true;
      return true;
    }) as unknown as typeof process.kill;

    await terminateMcpStdioProcessTree(1234, {
      execFile: execFileMock,
      kill: killMock,
      platform: "win32",
    });

    expect(execFileMock).toHaveBeenCalledWith(
      "taskkill",
      ["/PID", "1234", "/T", "/F"],
      expect.objectContaining({
        windowsHide: true,
      }),
    );
  });

  it("reports Windows taskkill failures when the stdio MCP process is still alive", async () => {
    const execFileMock = vi.fn(async () =>
      createCommandResult({ error: new Error("taskkill failed"), status: 1 }),
    );
    const killMock = vi.fn((pid: number, signal?: NodeJS.Signals | 0) => {
      if (signal === 0 && pid === 4321) return true;
      return true;
    }) as unknown as typeof process.kill;

    await expect(
      terminateMcpStdioProcessTree(4321, {
        execFile: execFileMock,
        kill: killMock,
        platform: "win32",
      }),
    ).rejects.toThrow("taskkill failed");
  });

  it("treats Windows EPERM process probes as alive before taskkill", async () => {
    const execFileMock = vi.fn(async () => createCommandResult({ status: 0 }));
    const killMock = vi.fn((pid: number, signal?: NodeJS.Signals | 0) => {
      if (signal === 0 && pid === 9876) {
        throw Object.assign(new Error("permission denied"), { code: "EPERM" });
      }
      return true;
    }) as unknown as typeof process.kill;

    await terminateMcpStdioProcessTree(9876, {
      execFile: execFileMock,
      kill: killMock,
      platform: "win32",
    });

    expect(execFileMock).toHaveBeenCalledWith(
      "taskkill",
      ["/PID", "9876", "/T", "/F"],
      expect.objectContaining({
        windowsHide: true,
      }),
    );
  });

  it("signals known POSIX descendants before force killing stale stdio MCP processes", async () => {
    const alive = new Set([1000, 1001, 1002]);
    let now = 0;
    const killCalls: Array<{ pid: number; signal: NodeJS.Signals | 0 | undefined }> = [];
    const killMock = vi.fn((pid: number, signal?: NodeJS.Signals | 0) => {
      killCalls.push({ pid, signal });
      if (signal === 0) {
        if (alive.has(pid)) return true;
        throw Object.assign(new Error("missing"), { code: "ESRCH" });
      }
      if (signal === "SIGKILL" && pid > 0) {
        alive.delete(pid);
      }
      return true;
    }) as unknown as typeof process.kill;
    const execFileMock = vi.fn(async (command: string, args?: readonly string[]) => {
      if (command === "ps") return createCommandResult({ stdout: "" });
      expect(command).toBe("pgrep");
      const parentPid = args?.[1];
      if (parentPid === "1000") return createCommandResult({ stdout: "1001\n" });
      if (parentPid === "1001") return createCommandResult({ stdout: "1002\n" });
      return createCommandResult({ error: new Error("no children"), status: 1 });
    });

    await terminateMcpStdioProcessTree(1000, {
      execFile: execFileMock,
      kill: killMock,
      now: () => now,
      platform: "darwin",
      sleep: async (ms) => {
        now += ms;
      },
    });

    expect(killCalls).toEqual(
      expect.arrayContaining([
        { pid: -1000, signal: "SIGINT" },
        { pid: 1002, signal: "SIGINT" },
        { pid: 1001, signal: "SIGINT" },
        { pid: 1000, signal: "SIGINT" },
        { pid: -1000, signal: "SIGTERM" },
        { pid: 1002, signal: "SIGTERM" },
        { pid: 1001, signal: "SIGTERM" },
        { pid: 1000, signal: "SIGTERM" },
        { pid: 1002, signal: "SIGKILL" },
        { pid: 1001, signal: "SIGKILL" },
        { pid: 1000, signal: "SIGKILL" },
      ]),
    );
  });

  it("does not escalate POSIX cleanup after stdio MCP processes exit on SIGINT", async () => {
    const alive = new Set([2000, 2001]);
    let now = 0;
    const killCalls: Array<{ pid: number; signal: NodeJS.Signals | 0 | undefined }> = [];
    const killMock = vi.fn((pid: number, signal?: NodeJS.Signals | 0) => {
      killCalls.push({ pid, signal });
      if (signal === 0) {
        if (alive.has(pid)) return true;
        throw Object.assign(new Error("missing"), { code: "ESRCH" });
      }
      if (signal === "SIGINT" && pid > 0) {
        alive.delete(pid);
      }
      return true;
    }) as unknown as typeof process.kill;
    const execFileMock = vi.fn(async (_command: string, args?: readonly string[]) => {
      if (_command === "ps") return createCommandResult({ stdout: "" });
      return args?.[1] === "2000"
        ? createCommandResult({ stdout: "2001\n" })
        : createCommandResult({ error: new Error("no children"), status: 1 });
    });

    await terminateMcpStdioProcessTree(2000, {
      execFile: execFileMock,
      kill: killMock,
      now: () => now,
      platform: "linux",
      sleep: async (ms) => {
        now += ms;
      },
    });

    expect(killCalls).toEqual(
      expect.arrayContaining([
        { pid: -2000, signal: "SIGINT" },
        { pid: 2001, signal: "SIGINT" },
        { pid: 2000, signal: "SIGINT" },
      ]),
    );
    expect(killCalls).not.toEqual(
      expect.arrayContaining([
        { pid: 2001, signal: "SIGTERM" },
        { pid: 2000, signal: "SIGTERM" },
        { pid: 2001, signal: "SIGKILL" },
        { pid: 2000, signal: "SIGKILL" },
      ]),
    );
  });

  it("falls back to ps when pgrep cannot list POSIX descendants", async () => {
    const alive = new Set([3000, 3001, 3002]);
    let now = 0;
    const killCalls: Array<{ pid: number; signal: NodeJS.Signals | 0 | undefined }> = [];
    const killMock = vi.fn((pid: number, signal?: NodeJS.Signals | 0) => {
      killCalls.push({ pid, signal });
      if (signal === 0) {
        if (alive.has(pid)) return true;
        throw Object.assign(new Error("missing"), { code: "ESRCH" });
      }
      if (signal === "SIGKILL" && pid > 0) {
        alive.delete(pid);
      }
      return true;
    }) as unknown as typeof process.kill;
    const execFileMock = vi.fn(async (command: string) => {
      if (command === "pgrep") {
        return createCommandResult({
          error: Object.assign(new Error("pgrep missing"), { code: "ENOENT" }),
          status: null,
        });
      }
      expect(command).toBe("ps");
      return createCommandResult({
        stdout: ["3000 1", "3001 3000", "3002 3001"].join("\n"),
      });
    });

    await terminateMcpStdioProcessTree(3000, {
      execFile: execFileMock,
      kill: killMock,
      now: () => now,
      platform: "linux",
      sleep: async (ms) => {
        now += ms;
      },
    });

    expect(execFileMock).toHaveBeenCalledWith("ps", ["-eo", "pid=,ppid="], expect.anything());
    expect(killCalls).toEqual(
      expect.arrayContaining([
        { pid: 3002, signal: "SIGKILL" },
        { pid: 3001, signal: "SIGKILL" },
        { pid: 3000, signal: "SIGKILL" },
      ]),
    );
  });

  it("reports POSIX cleanup failures when stale stdio MCP processes survive SIGKILL", async () => {
    let now = 0;
    const killMock = vi.fn((pid: number, signal?: NodeJS.Signals | 0) => {
      if (signal === 0 && pid === 4000) return true;
      return true;
    }) as unknown as typeof process.kill;
    const execFileMock = vi.fn(async (command: string) => {
      if (command === "pgrep") {
        return createCommandResult({ error: new Error("no children"), status: 1 });
      }
      return createCommandResult({ stdout: "4000 1\n" });
    });

    await expect(
      terminateMcpStdioProcessTree(4000, {
        execFile: execFileMock,
        kill: killMock,
        now: () => now,
        platform: "darwin",
        sleep: async (ms) => {
          now += ms;
        },
      }),
    ).rejects.toThrow("SIGKILL failed");
  });

  it.runIf(process.platform !== "win32")(
    "terminates a connected stdio MCP server and its child process on adapter close",
    async () => {
      const fixture = await createMcpProcessFixture();
      const adapter = createMcpAdapter();

      await expect(
        adapter.connectServer("tree", {
          args: [fixture.serverPath],
          command: process.execPath,
          env: fixture.env,
          timeoutMs: 5_000,
          type: "stdio",
        }),
      ).resolves.toMatchObject({
        status: "connected",
      });

      const serverPid = await readPidFile(fixture.serverPidFile);
      const childPid = await readPidFile(fixture.childPidFile);
      cleanupPids.add(serverPid);
      cleanupPids.add(childPid);
      expect(isPidAlive(serverPid)).toBe(true);
      expect(isPidAlive(childPid)).toBe(true);

      await adapter.close();

      await waitForPidExit(serverPid);
      await waitForPidExit(childPid);
      cleanupPids.delete(serverPid);
      cleanupPids.delete(childPid);
      await rm(fixture.root, { force: true, recursive: true });
    },
  );

  it.runIf(process.platform !== "win32")(
    "cleans up stdio MCP server children when connection times out",
    async () => {
      const fixture = await createMcpProcessFixture({ hangDuringInitialize: true });
      const adapter = createMcpAdapter();

      const connect = adapter.connectServer("hanging", {
        args: [fixture.serverPath],
        command: process.execPath,
        env: fixture.env,
        timeoutMs: 1_000,
        type: "stdio",
      });
      const serverPid = await readPidFile(fixture.serverPidFile);
      const childPid = await readPidFile(fixture.childPidFile);
      cleanupPids.add(serverPid);
      cleanupPids.add(childPid);

      await expect(connect).resolves.toMatchObject({
        failureKind: "connection_timeout",
        status: "failed",
      });

      await waitForPidExit(serverPid);
      await waitForPidExit(childPid);
      cleanupPids.delete(serverPid);
      cleanupPids.delete(childPid);
      await rm(fixture.root, { force: true, recursive: true });
    },
  );

  it.runIf(process.platform !== "win32")(
    "reports one start and crash for the final stdio process with its exit code",
    async () => {
      const fixture = await createMcpProcessFixture({ crashAfterConnectedMs: 100 });
      const events: Array<{ exitCode?: number | null; kind: string; mcpInstanceId?: string }> = [];
      const telemetry = createMcpTelemetryTracker({
        idSalt: "device-a",
        onEvent: (event) => events.push(event),
        randomId: () => "mcp-instance-1",
      });
      telemetry.registerConnection({
        connectionId: "connection-1",
        isolation: "session",
        serverName: "crashing-server",
      });
      telemetry.acquireOwner({
        connectionId: "connection-1",
        ownerId: "lease-1",
        sessionId: "session-1",
      });
      const adapter = createMcpAdapter({
        connectionContext: {
          mcpConnectionId: "connection-1",
          mcpIsolation: "session",
          sessionId: "session-1",
        },
        telemetry,
      });

      await expect(
        adapter.connectServer("crashing-server", {
          args: [fixture.serverPath],
          command: process.execPath,
          env: fixture.env,
          timeoutMs: 5_000,
          type: "stdio",
        }),
      ).resolves.toMatchObject({ status: "connected" });
      const serverPid = await readPidFile(fixture.serverPidFile);
      const childPid = await readPidFile(fixture.childPidFile);
      cleanupPids.add(serverPid);
      cleanupPids.add(childPid);

      await waitFor(() =>
        events.some((event) => event.kind === "process_crash") ? true : undefined,
      );

      expect(events).toEqual([
        expect.objectContaining({
          kind: "process_start",
          mcpInstanceId: "mcp-instance-1",
        }),
        expect.objectContaining({
          exitCode: 23,
          kind: "process_crash",
          mcpInstanceId: "mcp-instance-1",
        }),
      ]);
      await adapter.close();
      forceKillPid(childPid);
      cleanupPids.delete(serverPid);
      cleanupPids.delete(childPid);
      await rm(fixture.root, { force: true, recursive: true });
    },
  );
});

function createCommandResult(input: {
  error?: Error;
  status?: number | null;
  stdout?: string;
  stderr?: string;
}) {
  return {
    error: input.error,
    status: input.status ?? 0,
    stderr: input.stderr ?? "",
    stdout: input.stdout ?? "",
  };
}

async function createMcpProcessFixture(
  options: { crashAfterConnectedMs?: number; hangDuringInitialize?: boolean } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "zcode-mcp-process-"));
  const childPath = join(root, "child.mjs");
  const serverPath = join(root, "server.mjs");
  const serverPidFile = join(root, "server.pid");
  const childPidFile = join(root, "child.pid");
  const mcpServerModule = import.meta.resolve("@modelcontextprotocol/server");
  const stdioServerTransportModule = import.meta.resolve("@modelcontextprotocol/server/stdio");

  await writeFile(
    childPath,
    [
      "process.on('SIGINT', () => {});",
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );
  await writeFile(
    serverPath,
    [
      "import { spawn } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      `import { McpServer } from ${JSON.stringify(mcpServerModule)};`,
      `import { StdioServerTransport } from ${JSON.stringify(stdioServerTransportModule)};`,
      "writeFileSync(process.env.SERVER_PID_FILE, String(process.pid));",
      "const child = spawn(process.execPath, [process.env.CHILD_SCRIPT], { stdio: 'ignore' });",
      "writeFileSync(process.env.CHILD_PID_FILE, String(child.pid));",
      "process.on('SIGINT', () => {});",
      "process.on('SIGTERM', () => {});",
      options.hangDuringInitialize
        ? "setInterval(() => {}, 1000);"
        : [
            "const server = new McpServer({ name: 'process-tree-test', version: '1.0.0' });",
            "server.registerTool('ping', { description: 'ping', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'pong' }] }));",
            "await server.connect(new StdioServerTransport());",
            ...(options.crashAfterConnectedMs
              ? [`setTimeout(() => process.exit(23), ${options.crashAfterConnectedMs});`]
              : []),
          ].join("\n"),
    ].join("\n"),
  );

  return {
    childPidFile,
    env: {
      CHILD_PID_FILE: childPidFile,
      CHILD_SCRIPT: childPath,
      SERVER_PID_FILE: serverPidFile,
    },
    root,
    serverPath,
    serverPidFile,
  };
}

async function readPidFile(path: string): Promise<number> {
  await waitFor(async () => {
    try {
      const value = Number(await readFile(path, "utf8"));
      return Number.isInteger(value) && value > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  });
  return Number(await readFile(path, "utf8"));
}

async function waitForPidExit(pid: number): Promise<void> {
  await waitFor(() => (!isPidAlive(pid) ? true : undefined), 5_000);
}

async function waitFor<T>(
  callback: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 2_000,
): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await callback();
    if (value !== undefined) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function forceKillPid(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // best effort cleanup
  }
}
