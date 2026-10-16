import { spawn, type ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  attachProcessToWindowsJobObject,
  type WindowsJobObjectApi,
} from "../src/mcp/windows-job-object.js";

describe("Windows MCP Job Object adapter", () => {
  it("attaches the transport root and terminates/closes its private job", async () => {
    const job = { id: "job-1" };
    const api: WindowsJobObjectApi = {
      create: vi.fn(() => job),
      assign: vi.fn(() => true),
      terminate: vi.fn(),
      close: vi.fn(),
    };

    const controller = await attachProcessToWindowsJobObject(4321, {
      api,
      platform: "win32",
    });

    expect(api.create).toHaveBeenCalledOnce();
    expect(api.assign).toHaveBeenCalledWith(job, 4321);
    expect(controller).toBeDefined();

    controller?.terminate();
    controller?.close();

    expect(api.terminate).toHaveBeenCalledWith(job);
    expect(api.close).toHaveBeenCalledWith(job);
  });

  it("returns no controller and closes the job when root assignment fails", async () => {
    const job = { id: "job-2" };
    const api: WindowsJobObjectApi = {
      create: vi.fn(() => job),
      assign: vi.fn(() => false),
      terminate: vi.fn(),
      close: vi.fn(),
    };

    await expect(
      attachProcessToWindowsJobObject(9876, { api, platform: "win32" }),
    ).resolves.toBeUndefined();

    expect(api.assign).toHaveBeenCalledWith(job, 9876);
    expect(api.close).toHaveBeenCalledWith(job);
    expect(api.terminate).not.toHaveBeenCalled();
  });

  it("does not load or create a Windows job on non-Windows platforms", async () => {
    const api: WindowsJobObjectApi = {
      create: vi.fn(),
      assign: vi.fn(),
      terminate: vi.fn(),
      close: vi.fn(),
    };

    await expect(
      attachProcessToWindowsJobObject(1234, { api, platform: "darwin" }),
    ).resolves.toBeUndefined();
    expect(api.create).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === "win32")(
    "terminates a root and a descendant created after Job Object attach",
    async () => {
      const root = spawn(
        process.execPath,
        [
          "-e",
          [
            "const { spawn } = require('node:child_process');",
            "process.stdin.on('data', (chunk) => {",
            "  if (!chunk.toString().includes('spawn')) return;",
            "  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });",
            "  console.log(child.pid);",
            "});",
            "setInterval(() => {}, 1000);",
          ].join("\n"),
        ],
        { stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
      );
      let childPid = 0;
      try {
        const controller = await attachProcessToWindowsJobObject(root.pid ?? 0, {
          platform: "win32",
        });

        expect(controller).toBeDefined();
        const childPidPromise = readFirstLine(root);
        root.stdin?.write("spawn\n");
        childPid = await childPidPromise;
        controller?.terminate();
        controller?.close();
        await expect(waitForExit(root.pid ?? 0)).resolves.toBeUndefined();
        await expect(waitForExit(childPid)).resolves.toBeUndefined();
      } finally {
        if (root.exitCode == null) root.kill();
        if (childPid > 0) {
          try {
            process.kill(childPid);
          } catch {
            // 子进程已被 Job 或测试主体回收。
          }
        }
      }
    },
    10_000,
  );
});

function readFirstLine(child: ChildProcess): Promise<number> {
  return new Promise((resolveLine, rejectLine) => {
    let output = "";
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const line = output.match(/\d+/u)?.[0];
      if (!line) return;
      child.stdout?.off("data", onData);
      resolveLine(Number(line));
    };
    child.once("error", rejectLine);
    child.stdout?.on("data", onData);
  });
}

async function waitForExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`process ${pid} is still alive`);
}
