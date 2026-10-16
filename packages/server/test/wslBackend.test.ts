import { EventEmitter } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  isWSLAvailable: vi.fn(),
  listWSLDistros: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: mocks.execFile,
  spawn: mocks.spawn,
}));

vi.mock("@zcode/server/remote/wsl-detect.js", () => ({
  isWSLAvailable: mocks.isWSLAvailable,
  listWSLDistros: mocks.listWSLDistros,
}));

import { WSLBackend, buildWslArgs } from "../src/remote/wsl-backend.js";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

function createSpawnChild(options?: { closeOnStdinFinish?: boolean }) {
  const child = new EventEmitter() as EventEmitter & {
    kill: ReturnType<typeof vi.fn>;
    stderr: PassThrough;
    stdin: PassThrough;
    stdout: PassThrough;
  };
  child.kill = vi.fn(() => {
    queueMicrotask(() => child.emit("close", 1));
    return true;
  });
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin.resume();
  if (options?.closeOnStdinFinish !== false) {
    child.stdin.on("finish", () => queueMicrotask(() => child.emit("close", 0)));
  }
  queueMicrotask(() => child.emit("spawn"));
  return child;
}

beforeEach(() => {
  Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
  mocks.execFile.mockReset();
  mocks.isWSLAvailable.mockReset();
  mocks.listWSLDistros.mockReset();
  mocks.spawn.mockReset();
  mocks.isWSLAvailable.mockResolvedValue(true);
  mocks.listWSLDistros.mockResolvedValue([
    { isDefault: true, name: "Ubuntu-24.04", state: "Running", version: 2 },
  ]);
  mocks.execFile.mockImplementation(
    (
      _command: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: Buffer, stderr: Buffer) => void,
    ) => {
      const child = new EventEmitter();
      queueMicrotask(() => {
        callback(
          null,
          Buffer.from("Ubuntu-24.04\ntester\n/home/tester"),
          Buffer.alloc(0),
        );
        child.emit("close", 0);
      });
      return child as never;
    },
  );
  mocks.spawn.mockImplementation(() => createSpawnChild());
});

afterEach(() => {
  if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
});

describe("buildWslArgs", () => {
  it("disposeAndWait 回收 detect 阶段由 execFile 创建的 wsl.exe", async () => {
    let child!: EventEmitter & { kill: ReturnType<typeof vi.fn>; stdin: null };
    mocks.execFile.mockImplementationOnce(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: Buffer, stderr: Buffer) => void,
      ) => {
        child = Object.assign(new EventEmitter(), {
          stdin: null,
          kill: vi.fn(() => {
            callback(new Error("killed"), Buffer.alloc(0), Buffer.alloc(0));
            child.emit("close", 1);
            return true;
          }),
        });
        return child as never;
      },
    );
    mocks.isWSLAvailable.mockImplementationOnce(
      async (executor: (args: string[]) => Promise<Buffer>) => {
        await executor(["--status"]);
        return true;
      },
    );
    const backend = new WSLBackend({ kind: "wsl", distro: "Ubuntu-24.04" });
    const detecting = backend.detect();
    const detectionError = detecting.catch((error: unknown) => error);
    await vi.waitFor(() => expect(mocks.execFile).toHaveBeenCalledTimes(1));

    vi.useFakeTimers();
    try {
      const disposing = backend.disposeAndWait({ graceTimeoutMs: 300, killWaitTimeoutMs: 100 });
      await vi.advanceTimersByTimeAsync(300);
      await disposing;

      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(mocks.execFile.mock.calls.flatMap((call) => call[1] as string[])).not.toContain(
        "--terminate",
      );
      await expect(detectionError).resolves.toMatchObject({ message: "killed" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("disposeAndWait 回收 distro list 阶段由 execFile 创建的 wsl.exe", async () => {
    let child!: EventEmitter & { kill: ReturnType<typeof vi.fn>; stdin: null };
    mocks.execFile.mockImplementationOnce(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: Buffer, stderr: Buffer) => void,
      ) => {
        child = Object.assign(new EventEmitter(), {
          stdin: null,
          kill: vi.fn(() => {
            callback(new Error("list killed"), Buffer.alloc(0), Buffer.alloc(0));
            child.emit("close", 1);
            return true;
          }),
        });
        return child as never;
      },
    );
    mocks.listWSLDistros.mockImplementationOnce(
      async (executor: (args: string[]) => Promise<Buffer>) => {
        await executor(["-l", "-v", "--all"]);
        return [];
      },
    );
    const backend = new WSLBackend({ kind: "wsl" });
    const detecting = backend.detect();
    const detectionError = detecting.catch((error: unknown) => error);
    await vi.waitFor(() => expect(mocks.execFile).toHaveBeenCalledTimes(1));

    vi.useFakeTimers();
    try {
      const disposing = backend.disposeAndWait({ graceTimeoutMs: 300, killWaitTimeoutMs: 100 });
      await vi.advanceTimersByTimeAsync(300);
      await disposing;

      expect(child.kill).toHaveBeenCalledTimes(1);
      await expect(detectionError).resolves.toMatchObject({ message: "WSL backend 已释放，无法启动新命令" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("回收开始后拒绝启动新的 WSL 子进程", async () => {
    const backend = new WSLBackend({ kind: "wsl", distro: "Ubuntu-24.04" });

    await backend.disposeAndWait();

    await expect(backend.exec("zcode-server")).rejects.toThrow("WSL backend 已释放");
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("discovery pending 时完成回收后不再启动 WSL 子进程", async () => {
    const backend = new WSLBackend({ kind: "wsl", distro: "Ubuntu-24.04" });
    await backend.resolveIdentity();
    let resumeDiscovery!: (available: boolean) => void;
    mocks.isWSLAvailable.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resumeDiscovery = resolve;
        }),
    );

    const executing = backend.exec("zcode-server");
    await vi.waitFor(() => expect(mocks.isWSLAvailable).toHaveBeenCalledTimes(2));
    await backend.disposeAndWait();
    resumeDiscovery(true);

    await expect(executing).rejects.toThrow("WSL backend 已释放");
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("disposeAndWait 只回收当前 backend 创建的 wsl.exe 子进程", async () => {
    let usingFakeTimers = false;
    try {
      let child!: ReturnType<typeof createSpawnChild>;
      mocks.spawn.mockImplementationOnce(() => {
        child = createSpawnChild({ closeOnStdinFinish: false });
        return child;
      });
      const backend = new WSLBackend({ kind: "wsl", distro: "Ubuntu-24.04" });

      await backend.exec("zcode-server");
      vi.useFakeTimers();
      usingFakeTimers = true;
      const disposing = backend.disposeAndWait({ graceTimeoutMs: 300, killWaitTimeoutMs: 100 });

      expect(child.stdin.writableEnded).toBe(true);
      expect(child.kill).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(300);
      await disposing;
      expect(child.kill).toHaveBeenCalledTimes(1);
    } finally {
      if (usingFakeTimers) {
        vi.useRealTimers();
      }
    }
  });

  it("子进程在 EOF 后正常退出时不执行 kill", async () => {
    let child!: ReturnType<typeof createSpawnChild>;
    mocks.spawn.mockImplementationOnce(() => {
      child = createSpawnChild();
      return child;
    });
    const backend = new WSLBackend({ kind: "wsl", distro: "Ubuntu-24.04" });

    await backend.exec("zcode-server");
    await backend.disposeAndWait({ graceTimeoutMs: 300, killWaitTimeoutMs: 100 });

    expect(child.kill).not.toHaveBeenCalled();
  });

  it("uses the default distro user when no WSL user is provided", () => {
    expect(buildWslArgs(["bash", "-lc", "pwd"], "Ubuntu-24.04", null)).toEqual([
      "-d",
      "Ubuntu-24.04",
      "--",
      "bash",
      "-lc",
      "pwd",
    ]);
  });

  it("resolves the canonical distro name and actual Linux user", async () => {
    const backend = new WSLBackend({ kind: "wsl", distro: "ubuntu-24.04" });

    await expect(backend.resolveIdentity()).resolves.toEqual({
      distro: "Ubuntu-24.04",
      user: "tester",
    });
    expect(mocks.execFile).toHaveBeenCalledWith(
      "wsl.exe",
      expect.arrayContaining(["-d", "Ubuntu-24.04", "bash", "-lc"]),
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("passes an explicit WSL user to wsl.exe", () => {
    expect(buildWslArgs(["bash", "-lc", "pwd"], "Ubuntu-24.04", "root")).toEqual([
      "-d",
      "Ubuntu-24.04",
      "-u",
      "root",
      "--",
      "bash",
      "-lc",
      "pwd",
    ]);
  });

  it("WSL NAT 下把不可达的 loopback 代理转换为宿主网关地址", async () => {
    mocks.execFile.mockImplementation(
      (
        _command: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: Buffer, stderr: Buffer) => void,
      ) => {
        const shellCommand = args.at(-1) ?? "";
        const stdout = shellCommand.includes("/dev/tcp/172.21.240.1/")
          ? "reachable"
          : shellCommand.includes("/dev/tcp/")
            ? "unreachable"
            : shellCommand.includes("ip route show default")
              ? "route=172.21.240.1"
              : "Ubuntu-24.04\ntester\n/home/tester";
        const child = new EventEmitter();
        queueMicrotask(() => {
          callback(null, Buffer.from(stdout), Buffer.alloc(0));
          child.emit("close", 0);
        });
        return child as never;
      },
    );
    const backend = new WSLBackend({ kind: "wsl", distro: "Ubuntu-24.04" });

    await expect(backend.resolveRuntimeProxy("http://127.0.0.1:7890")).resolves.toBe(
      "http://172.21.240.1:7890/",
    );
  });

  it("WSL mirrored 或代理可达时保留 loopback 代理地址", async () => {
    mocks.execFile.mockImplementation(
      (
        _command: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: Buffer, stderr: Buffer) => void,
      ) => {
        const shellCommand = args.at(-1) ?? "";
        const stdout = shellCommand.includes("/dev/tcp/")
          ? "reachable"
          : "Ubuntu-24.04\ntester\n/home/tester";
        const child = new EventEmitter();
        queueMicrotask(() => {
          callback(null, Buffer.from(stdout), Buffer.alloc(0));
          child.emit("close", 0);
        });
        return child as never;
      },
    );
    const backend = new WSLBackend({ kind: "wsl", distro: "Ubuntu-24.04" });

    await expect(backend.resolveRuntimeProxy("http://localhost:7890")).resolves.toBe(
      "http://localhost:7890/",
    );
  });

  it("非 loopback 代理和代理认证信息保持不变", async () => {
    const backend = new WSLBackend({ kind: "wsl", distro: "Ubuntu-24.04" });

    await expect(
      backend.resolveRuntimeProxy("http://user:pass@proxy.example.com:7890/path"),
    ).resolves.toBe("http://user:pass@proxy.example.com:7890/path");
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it("WSL 网关探测无法确认端口时保留 loopback 配置", async () => {
    mocks.execFile.mockImplementation(
      (
        _command: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: Buffer, stderr: Buffer) => void,
      ) => {
        const shellCommand = args.at(-1) ?? "";
        const stdout = shellCommand.includes("/dev/tcp/")
          ? "unreachable"
          : shellCommand.includes("ip route show default")
            ? "route=172.21.240.1"
            : "Ubuntu-24.04\ntester\n/home/tester";
        const child = new EventEmitter();
        queueMicrotask(() => {
          callback(null, Buffer.from(stdout), Buffer.alloc(0));
          child.emit("close", 0);
        });
        return child as never;
      },
    );
    const backend = new WSLBackend({ kind: "wsl", distro: "Ubuntu-24.04" });

    await expect(backend.resolveRuntimeProxy("http://127.0.0.1:7890")).resolves.toBe(
      "http://127.0.0.1:7890/",
    );
  });

  it("systemd-resolved 的 loopback stub 不会阻断 resolv.conf 回退", async () => {
    mocks.execFile.mockImplementation(
      (
        _command: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: Buffer, stderr: Buffer) => void,
      ) => {
        const shellCommand = args.at(-1) ?? "";
        const stdout = shellCommand.includes("/dev/tcp/172.21.240.1/")
          ? "reachable"
          : shellCommand.includes("/dev/tcp/")
            ? "unreachable"
            : shellCommand.includes("ip route show default")
              ? "resolv=127.0.0.53 resolv=172.21.240.1"
              : "Ubuntu-24.04\ntester\n/home/tester";
        const child = new EventEmitter();
        queueMicrotask(() => {
          callback(null, Buffer.from(stdout), Buffer.alloc(0));
          child.emit("close", 0);
        });
        return child as never;
      },
    );
    const backend = new WSLBackend({ kind: "wsl", distro: "Ubuntu-24.04" });

    await expect(backend.resolveRuntimeProxy("http://127.0.0.1:7890")).resolves.toBe(
      "http://172.21.240.1:7890/",
    );
  });

  it("自定义公网 DNS 不会被当成宿主网关探测", async () => {
    mocks.execFile.mockImplementation(
      (
        _command: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: Buffer, stderr: Buffer) => void,
      ) => {
        const shellCommand = args.at(-1) ?? "";
        const stdout = shellCommand.includes("/dev/tcp/")
          ? "unreachable"
          : shellCommand.includes("ip route show default")
            ? "resolv=8.8.8.8"
            : "Ubuntu-24.04\ntester\n/home/tester";
        const child = new EventEmitter();
        queueMicrotask(() => {
          callback(null, Buffer.from(stdout), Buffer.alloc(0));
          child.emit("close", 0);
        });
        return child as never;
      },
    );
    const backend = new WSLBackend({ kind: "wsl", distro: "Ubuntu-24.04" });

    await expect(backend.resolveRuntimeProxy("http://127.0.0.1:7890")).resolves.toBe(
      "http://127.0.0.1:7890/",
    );
    expect(
      mocks.execFile.mock.calls.some((call) =>
        (call[1] as string[]).at(-1)?.includes("/dev/tcp/8.8.8.8/"),
      ),
    ).toBe(false);
  });

  it("带 progress 选项时走 wsl exec pipe 并上报字节", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "wsl-upload-progress-"));
    const localPath = join(tempDir, "attachment.bin");
    await writeFile(localPath, Buffer.alloc(80 * 1024, "a"));
    const backend = new WSLBackend({ kind: "wsl", distro: "Ubuntu-24.04" });
    const progress: Array<{ uploadedBytes: number; totalBytes: number }> = [];

    await backend.upload(localPath, "~/.zcode/tmp/attachment.bin", {
      onProgress: (event) => progress.push(event),
    });

    expect(mocks.spawn).toHaveBeenCalledWith(
      "wsl.exe",
      [
        "-d",
        "Ubuntu-24.04",
        "-u",
        "tester",
        "--",
        "bash",
        "-lc",
        "mkdir -p '/home/tester/.zcode/tmp' && cat > '/home/tester/.zcode/tmp/attachment.bin'",
      ],
      expect.any(Object),
    );
    expect(progress.at(-1)).toEqual({
      uploadedBytes: 80 * 1024,
      totalBytes: 80 * 1024,
    });
  });

  it("预取消 signal 不启动上传进程", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "wsl-upload-abort-"));
    const localPath = join(tempDir, "attachment.bin");
    await writeFile(localPath, "attachment");
    const backend = new WSLBackend({ kind: "wsl", distro: "Ubuntu-24.04" });
    const controller = new AbortController();
    controller.abort();

    await expect(
      backend.upload(localPath, "~/.zcode/tmp/attachment.bin", {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
