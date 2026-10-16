import { EventEmitter } from "node:events";
import { rmSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { SSHBackend } from "@zcode/server/remote/ssh-backend.js";

class FakeExecChannel extends EventEmitter {
  readonly stderr = new EventEmitter();
}

class FakeUploadExecChannel extends EventEmitter {
  readonly stderr = new EventEmitter();
  readonly stdin: Writable;
  private readonly chunks: Buffer[] = [];

  constructor(onComplete: (content: string) => void) {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        callback();
      },
      final: (callback) => {
        onComplete(Buffer.concat(this.chunks).toString("utf8"));
        queueMicrotask(() => {
          this.emit("exit", 0, null);
          this.emit("close", 0, null);
        });
        callback();
      },
    });
  }
}

class FailingSftpWriteStream extends Writable {
  constructor(
    private readonly failure: Error & {
      code: number;
    },
  ) {
    super();
  }

  override _write(
    _chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    callback(this.failure);
  }
}

class SuccessfulSftpWriteStream extends Writable {
  override _write(
    _chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    callback();
  }

  override _final(callback: (error?: Error | null) => void): void {
    queueMicrotask(() => {
      this.emit("close");
    });
    callback();
  }
}

function emitExecResult(
  channel: FakeExecChannel,
  options: {
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    exitBeforeData?: boolean;
  },
): void {
  const stdout = options.stdout ?? "";
  const stderr = options.stderr ?? "";
  const exitCode = options.exitCode ?? 0;

  queueMicrotask(() => {
    const emitData = () => {
      if (stdout.length > 0) {
        channel.emit("data", Buffer.from(stdout, "utf8"));
      }
      if (stderr.length > 0) {
        channel.stderr.emit("data", Buffer.from(stderr, "utf8"));
      }
    };

    if (options.exitBeforeData) {
      channel.emit("exit", exitCode, null);
      emitData();
    } else {
      emitData();
      channel.emit("exit", exitCode, null);
    }

    channel.emit("close", exitCode, null);
  });
}

function quotePosixShellArgForTest(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function expectSSHExecCommand(command: string, rawCommand: string): void {
  expect(command).toBe(`/bin/sh -c ${quotePosixShellArgForTest(rawCommand)}`);
}

describe("SSHBackend", () => {
  it("ready 后 SSH client error 应触发一次断连事件", () => {
    const backend = new SSHBackend({
      host: "example.com",
      username: "root",
      password: "secret",
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const events: Array<{ reason: string; error?: Error }> = [];
    const disposable = backend.onDidDisconnect((event) => {
      events.push(event);
    });

    const mutableBackend = backend as unknown as {
      client: EventEmitter;
      connected: boolean;
    };
    mutableBackend.connected = true;

    const error = new Error("socket reset");
    mutableBackend.client.emit("error", error);
    mutableBackend.client.emit("close");

    expect(events).toHaveLength(1);
    expect(events[0]?.reason).toBe("error");
    expect(events[0]?.error).toBe(error);

    disposable.dispose();
    backend.dispose();
    errorSpy.mockRestore();
  });

  it("ready 后 SSH client error 应先记录错误详情再触发断连事件", () => {
    const backend = new SSHBackend({
      host: "example.com",
      username: "root",
      password: "secret",
    });
    const events: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {
      events.push("log-error");
    });
    const disposable = backend.onDidDisconnect(() => {
      events.push("disconnect");
    });

    const mutableBackend = backend as unknown as {
      client: EventEmitter;
      connected: boolean;
    };
    mutableBackend.connected = true;

    try {
      mutableBackend.client.emit("error", new Error("socket reset"));

      expect(events).toEqual(["log-error", "disconnect"]);
    } finally {
      disposable.dispose();
      backend.dispose();
      errorSpy.mockRestore();
    }
  });

  it("ready 后 SSH client close 应触发断连事件", () => {
    const backend = new SSHBackend({
      host: "example.com",
      username: "root",
      password: "secret",
    });
    const events: Array<{ reason: string }> = [];
    const disposable = backend.onDidDisconnect((event) => {
      events.push(event);
    });

    const mutableBackend = backend as unknown as {
      client: EventEmitter;
      connected: boolean;
    };
    mutableBackend.connected = true;

    mutableBackend.client.emit("close");

    expect(events).toEqual([{ reason: "close" }]);

    disposable.dispose();
    backend.dispose();
  });

  it("释放后不得使用旧凭据重新建立 SSH 连接", async () => {
    const backend = new SSHBackend({
      host: "example.com",
      username: "root",
      password: "old-password",
    });
    const fakeClient = {
      off: vi.fn(),
      end: vi.fn(),
      once: vi.fn(),
      connect: vi.fn(() => {
        throw new Error("unexpected reconnect");
      }),
    };
    const mutableBackend = backend as unknown as {
      client: typeof fakeClient;
      connected: boolean;
    };
    mutableBackend.client = fakeClient;
    mutableBackend.connected = false;

    backend.dispose();

    await expect(backend.exec("true")).rejects.toThrow("SSH backend 已释放");
    expect(fakeClient.connect).not.toHaveBeenCalled();
  });

  it("连接 ready 晚于释放屏障时不得继续执行远端命令", async () => {
    const backend = new SSHBackend({
      host: "example.com",
      username: "root",
      password: "old-password",
    });
    const fakeClient = Object.assign(new EventEmitter(), {
      connect: vi.fn(),
      end: vi.fn(),
      exec: vi.fn(() => {
        throw new Error("unexpected remote command");
      }),
    });
    const mutableBackend = backend as unknown as {
      client: typeof fakeClient;
      connected: boolean;
    };
    mutableBackend.client = fakeClient;
    mutableBackend.connected = false;

    const detecting = backend.detect();
    expect(fakeClient.connect).toHaveBeenCalledTimes(1);
    backend.dispose();
    fakeClient.emit("ready");

    await expect(detecting).rejects.toThrow("SSH backend 已释放");
    expect(fakeClient.exec).not.toHaveBeenCalled();
  });

  it("释放期间 end 之后的迟到 SSH error 不得逃逸为未捕获异常", () => {
    const backend = new SSHBackend({
      host: "example.com",
      username: "root",
      password: "old-password",
    });
    const fakeClient = Object.assign(new EventEmitter(), {
      connect: vi.fn(),
      end: vi.fn(),
      exec: vi.fn(),
    });
    const mutableBackend = backend as unknown as {
      client: typeof fakeClient;
      onClientError: (error: unknown) => void;
    };
    mutableBackend.client = fakeClient;
    fakeClient.on("error", mutableBackend.onClientError);

    backend.dispose();
    fakeClient.emit("end");

    expect(() => fakeClient.emit("error", new Error("late after end"))).not.toThrow();
  });

  it("握手超时后的迟到 SSH error 不得逃逸为未捕获异常", async () => {
    const backend = new SSHBackend({
      host: "example.com",
      username: "root",
      password: "old-password",
    });
    const fakeClient = Object.assign(new EventEmitter(), {
      connect: vi.fn(),
      end: vi.fn(),
      exec: vi.fn(() => {
        throw new Error("unexpected remote command");
      }),
    });
    const mutableBackend = backend as unknown as {
      client: typeof fakeClient;
      onClientError: (error: unknown) => void;
    };
    mutableBackend.client = fakeClient;
    // 构造 ssh2 的两次 error 顺序：第一次由 ready timeout 触发，第二次由 socket close 触发。
    fakeClient.on("error", mutableBackend.onClientError);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const detecting = backend.detect();
      fakeClient.emit(
        "error",
        Object.assign(new Error("Timed out while waiting for handshake"), {
          level: "client-timeout",
        }),
      );
      await expect(detecting).rejects.toThrow("SSH 连接握手超时");

      backend.dispose();

      // ssh2 在 timeout 后销毁 socket，close/end 阶段仍可能再发出 error；该迟到事件必须被吞掉。
      expect(() =>
        fakeClient.emit("error", new Error("Connection lost before handshake")),
      ).not.toThrow();
      fakeClient.emit("close");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("连接检查完成后插入释放屏障时不得继续执行远端命令", async () => {
    const backend = new SSHBackend({
      host: "example.com",
      username: "root",
      password: "old-password",
    });
    const fakeClient = Object.assign(new EventEmitter(), {
      end: vi.fn(),
      exec: vi.fn(() => {
        throw new Error("unexpected remote command");
      }),
    });
    const mutableBackend = backend as unknown as {
      client: typeof fakeClient;
      connected: boolean;
    };
    mutableBackend.client = fakeClient;
    mutableBackend.connected = true;

    const executing = backend.exec("true");
    backend.dispose();

    await expect(executing).rejects.toThrow("SSH backend 已释放");
    expect(fakeClient.exec).not.toHaveBeenCalled();
  });

  it("detect 在 exit 先于 data 时不应丢失 platform 输出", async () => {
    const backend = new SSHBackend({
      host: "example.com",
      username: "root",
      password: "secret",
    });

    const fakeClient = {
      exec: (
        command: string,
        callback: (error: Error | null, channel: FakeExecChannel) => void,
      ) => {
        const channel = new FakeExecChannel();
        callback(null, channel);

        if (command === `/bin/sh -c ${quotePosixShellArgForTest("uname -s")}`) {
          emitExecResult(channel, {
            stdout: "Darwin\n",
            exitCode: 0,
            exitBeforeData: true,
          });
          return;
        }
        if (command === `/bin/sh -c ${quotePosixShellArgForTest("uname -m")}`) {
          emitExecResult(channel, {
            stdout: "arm64\n",
            exitCode: 0,
          });
          return;
        }
        emitExecResult(channel, { stdout: "", exitCode: 0 });
      },
    };

    const mutableBackend = backend as unknown as {
      client: typeof fakeClient;
      connected: boolean;
    };
    mutableBackend.client = fakeClient;
    mutableBackend.connected = true;

    await expect(backend.detect()).resolves.toEqual({
      platform: "darwin",
      arch: "arm64",
    });
  });

  it("exec 成功完成时不应输出无意义的完成日志", async () => {
    const backend = new SSHBackend({
      host: "example.com",
      username: "root",
      password: "secret",
    });
    const infoSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const fakeClient = {
      exec: (
        command: string,
        callback: (error: Error | null, channel: FakeExecChannel) => void,
      ) => {
        expectSSHExecCommand(command, "set -eu && echo very-long-command");
        const channel = new FakeExecChannel();
        callback(null, channel);
        emitExecResult(channel, { exitCode: 0 });
      },
    };

    const mutableBackend = backend as unknown as {
      client: typeof fakeClient;
      connected: boolean;
    };
    mutableBackend.client = fakeClient;
    mutableBackend.connected = true;

    const stream = await backend.exec("set -eu && echo very-long-command");
    await new Promise<void>((resolve) => stream.onClose(() => resolve()));

    expect(infoSpy).not.toHaveBeenCalledWith(expect.stringContaining("exec channel"));
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("exec channel"));
    expect(infoSpy).not.toHaveBeenCalledWith(expect.stringContaining("very-long-command"));
    infoSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("exec 应通过 POSIX shell 执行远端命令，避免 fish 默认 shell 解析部署脚本", async () => {
    const backend = new SSHBackend({
      host: "example.com",
      username: "root",
      password: "secret",
    });
    const rawCommand = "download=; if command -v curl >/dev/null 2>&1; then download=curl; fi";
    const executedCommands: string[] = [];

    const fakeClient = {
      exec: (
        command: string,
        callback: (error: Error | null, channel: FakeExecChannel) => void,
      ) => {
        executedCommands.push(command);
        expectSSHExecCommand(command, rawCommand);
        const channel = new FakeExecChannel();
        callback(null, channel);
        emitExecResult(channel, { exitCode: 0 });
      },
    };

    const mutableBackend = backend as unknown as {
      client: typeof fakeClient;
      connected: boolean;
    };
    mutableBackend.client = fakeClient;
    mutableBackend.connected = true;

    const stream = await backend.exec(rawCommand);
    await new Promise<void>((resolve) => stream.onClose(() => resolve()));

    expect(executedCommands).toHaveLength(1);
  });

  it("exec 失败完成时应保留退出码日志但不输出完整远端命令", async () => {
    const backend = new SSHBackend({
      host: "example.com",
      username: "root",
      password: "secret",
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const fakeClient = {
      exec: (
        command: string,
        callback: (error: Error | null, channel: FakeExecChannel) => void,
      ) => {
        expectSSHExecCommand(command, "set -eu && echo very-long-command && exit 7");
        const channel = new FakeExecChannel();
        callback(null, channel);
        emitExecResult(channel, { exitCode: 7 });
      },
    };

    const mutableBackend = backend as unknown as {
      client: typeof fakeClient;
      connected: boolean;
    };
    mutableBackend.client = fakeClient;
    mutableBackend.connected = true;

    const stream = await backend.exec("set -eu && echo very-long-command && exit 7");
    await new Promise<void>((resolve) => stream.onClose(() => resolve()));

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[ssh] exec channel failed: code=7"),
    );
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("very-long-command"));
    warnSpy.mockRestore();
  });

  it("ssh2 debug 不应输出下载阶段的高频 channel 数据包", () => {
    const backend = new SSHBackend({
      host: "example.com",
      username: "root",
      password: "secret",
    });
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const debug = (
      backend as unknown as {
        config: {
          debug?: (message: string) => void;
        };
      }
    ).config.debug;

    try {
      if (!debug) {
        return;
      }

      debug("Inbound: CHANNEL_EXTENDED_DATA (r:27, 1)");
      debug("Inbound: CHANNEL_DATA (r:27, 1024)");
      debug("Outbound: CHANNEL_WINDOW_ADJUST (r:27, 2097152)");
      debug("DEBUG: Client: Trying password auth");

      const debugLines = debugSpy.mock.calls.map((call) => String(call[0] ?? ""));
      expect(debugLines.some((line) => line.includes("CHANNEL_EXTENDED_DATA"))).toBe(false);
      expect(debugLines.some((line) => line.includes("CHANNEL_DATA"))).toBe(false);
      expect(debugLines.some((line) => line.includes("CHANNEL_WINDOW_ADJUST"))).toBe(false);
      expect(debugLines.some((line) => line.includes("Trying password auth"))).toBe(true);
    } finally {
      debugSpy.mockRestore();
    }
  });

  it("首次 SFTP 写入失败后，同 backend 的后续上传应直接使用 exec pipe", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ssh-backend-upload-"));
    const localFilePath = join(tempDir, "node");
    const localContent = "hello ssh fallback";
    await writeFile(localFilePath, localContent, "utf8");

    const backend = new SSHBackend({
      host: "example.com",
      username: "root",
      password: "secret",
    });

    const attemptedSftpPaths: string[] = [];
    const execUploadedContents: string[] = [];
    const executedCommands: string[] = [];
    const secondUploadProgress: Array<{ uploadedBytes: number; totalBytes: number }> = [];
    const failingSftpError = Object.assign(new Error("No such file or directory"), {
      code: 2,
    });

    const fakeClient = {
      exec: (
        command: string,
        callback: (error: Error | null, channel: FakeExecChannel | FakeUploadExecChannel) => void,
      ) => {
        executedCommands.push(command);

        if (command === `/bin/sh -c ${quotePosixShellArgForTest('printf %s "$HOME"')}`) {
          const channel = new FakeExecChannel();
          callback(null, channel);
          emitExecResult(channel, {
            stdout: "/root",
            exitCode: 0,
          });
          return;
        }

        if (
          command === `/bin/sh -c ${quotePosixShellArgForTest("mkdir -p '/root/.zcode/server'")}`
        ) {
          const channel = new FakeExecChannel();
          callback(null, channel);
          emitExecResult(channel, { exitCode: 0 });
          return;
        }

        if (
          command ===
          `/bin/sh -c ${quotePosixShellArgForTest("mkdir -p '/root/.zcode/server' && cat > '/root/.zcode/server/node.new'")}`
        ) {
          callback(
            null,
            new FakeUploadExecChannel((content) => {
              execUploadedContents.push(content);
            }),
          );
          return;
        }

        throw new Error(`Unexpected command: ${command}`);
      },
      sftp: (
        callback: (
          error: Error | null,
          sftp: {
            createWriteStream: (remotePath: string) => Writable;
            end: () => void;
          },
        ) => void,
      ) => {
        callback(null, {
          createWriteStream: (remotePath) => {
            attemptedSftpPaths.push(remotePath);
            return new FailingSftpWriteStream(failingSftpError);
          },
          end: () => {},
        });
      },
    };

    const mutableBackend = backend as unknown as {
      client: typeof fakeClient;
      connected: boolean;
    };
    mutableBackend.client = fakeClient;
    mutableBackend.connected = true;

    await expect(
      backend.upload(localFilePath, "~/.zcode/server/node.new"),
    ).resolves.toBeUndefined();
    await expect(
      backend.upload(localFilePath, "~/.zcode/server/node.new", {
        onProgress: (event) => secondUploadProgress.push(event),
      }),
    ).resolves.toBeUndefined();
    expect(attemptedSftpPaths).toEqual(["/root/.zcode/server/node.new"]);
    expect(execUploadedContents).toEqual([localContent, localContent]);
    expect(secondUploadProgress.at(-1)).toEqual({
      uploadedBytes: Buffer.byteLength(localContent),
      totalBytes: Buffer.byteLength(localContent),
    });
    const abortedUpload = new AbortController();
    abortedUpload.abort();
    await expect(
      backend.upload(localFilePath, "~/.zcode/server/node.new", {
        signal: abortedUpload.signal,
      }),
    ).rejects.toThrow("Remote upload canceled");
    expect(execUploadedContents).toEqual([localContent, localContent]);
    expect(
      executedCommands.includes(
        `/bin/sh -c ${quotePosixShellArgForTest("mkdir -p '/root/.zcode/server' && cat > '/root/.zcode/server/node.new'")}`,
      ),
    ).toBe(true);
  });

  it("首次 SFTP session 失败后，同 backend 的后续上传应直接使用 exec pipe", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ssh-backend-sftp-session-"));
    const localFilePath = join(tempDir, "node");
    const localContent = "hello ssh session fallback";
    await writeFile(localFilePath, localContent, "utf8");

    const backend = new SSHBackend({
      host: "example.com",
      username: "root",
      password: "secret",
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const execUploadedContents: string[] = [];
    let sftpAttempts = 0;
    const fakeClient = {
      exec: (
        command: string,
        callback: (error: Error | null, channel: FakeExecChannel | FakeUploadExecChannel) => void,
      ) => {
        if (command === `/bin/sh -c ${quotePosixShellArgForTest('printf %s "$HOME"')}`) {
          const channel = new FakeExecChannel();
          callback(null, channel);
          emitExecResult(channel, { stdout: "/root", exitCode: 0 });
          return;
        }
        if (
          command === `/bin/sh -c ${quotePosixShellArgForTest("mkdir -p '/root/.zcode/server'")}`
        ) {
          const channel = new FakeExecChannel();
          callback(null, channel);
          emitExecResult(channel, { exitCode: 0 });
          return;
        }
        if (
          command ===
          `/bin/sh -c ${quotePosixShellArgForTest("mkdir -p '/root/.zcode/server' && cat > '/root/.zcode/server/node.new'")}`
        ) {
          callback(
            null,
            new FakeUploadExecChannel((content) => execUploadedContents.push(content)),
          );
          return;
        }
        throw new Error(`Unexpected command: ${command}`);
      },
      sftp: (callback: (error: Error | null, sftp: never) => void) => {
        sftpAttempts += 1;
        callback(
          Object.assign(new Error("SFTP subsystem unavailable"), { code: 4 }),
          undefined as never,
        );
      },
    };
    const mutableBackend = backend as unknown as {
      client: typeof fakeClient;
      connected: boolean;
    };
    mutableBackend.client = fakeClient;
    mutableBackend.connected = true;

    try {
      await expect(
        backend.upload(localFilePath, "~/.zcode/server/node.new"),
      ).resolves.toBeUndefined();
      await expect(
        backend.upload(localFilePath, "~/.zcode/server/node.new"),
      ).resolves.toBeUndefined();

      expect(sftpAttempts).toBe(1);
      expect(execUploadedContents).toEqual([localContent, localContent]);
      expect(
        warnSpy.mock.calls.filter((call) =>
          String(call[0] ?? "").includes(
            "switching node.new from sftp to exec pipe after sftp-session failure (FAILURE(code=4))",
          ),
        ),
      ).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("本地文件读取失败不应把 backend 标记为 exec-upload-only", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ssh-backend-local-read-"));
    const localFilePath = join(tempDir, "node");
    await writeFile(localFilePath, "first", "utf8");

    const backend = new SSHBackend({
      host: "example.com",
      username: "root",
      password: "secret",
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let sftpAttempts = 0;
    const fakeClient = {
      exec: (
        command: string,
        callback: (error: Error | null, channel: FakeExecChannel) => void,
      ) => {
        const channel = new FakeExecChannel();
        callback(null, channel);
        if (command === `/bin/sh -c ${quotePosixShellArgForTest('printf %s "$HOME"')}`) {
          emitExecResult(channel, { stdout: "/root", exitCode: 0 });
          return;
        }
        if (
          command === `/bin/sh -c ${quotePosixShellArgForTest("mkdir -p '/root/.zcode/server'")}`
        ) {
          emitExecResult(channel, { exitCode: 0 });
          return;
        }
        throw new Error(`Unexpected command: ${command}`);
      },
      sftp: (
        callback: (
          error: Error | null,
          sftp: { createWriteStream: () => Writable; end: () => void },
        ) => void,
      ) => {
        sftpAttempts += 1;
        if (sftpAttempts === 1) {
          rmSync(localFilePath);
        }
        callback(null, {
          createWriteStream: () => new SuccessfulSftpWriteStream(),
          end: () => {},
        });
      },
    };
    const mutableBackend = backend as unknown as {
      client: typeof fakeClient;
      connected: boolean;
    };
    mutableBackend.client = fakeClient;
    mutableBackend.connected = true;

    try {
      await expect(backend.upload(localFilePath, "~/.zcode/server/node.new")).rejects.toThrow();
      await writeFile(localFilePath, "second", "utf8");
      await expect(
        backend.upload(localFilePath, "~/.zcode/server/node.new"),
      ).resolves.toBeUndefined();

      expect(sftpAttempts).toBe(2);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("upload 成功时应输出上传进度日志", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ssh-backend-progress-"));
    const localFilePath = join(tempDir, "node");
    await writeFile(localFilePath, Buffer.alloc(96 * 1024, "a"));

    const backend = new SSHBackend({
      host: "example.com",
      username: "root",
      password: "secret",
    });

    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const fakeClient = {
      exec: (
        command: string,
        callback: (error: Error | null, channel: FakeExecChannel) => void,
      ) => {
        const channel = new FakeExecChannel();
        callback(null, channel);

        if (command === `/bin/sh -c ${quotePosixShellArgForTest('printf %s "$HOME"')}`) {
          emitExecResult(channel, {
            stdout: "/root",
            exitCode: 0,
          });
          return;
        }

        if (
          command === `/bin/sh -c ${quotePosixShellArgForTest("mkdir -p '/root/.zcode/server'")}`
        ) {
          emitExecResult(channel, { exitCode: 0 });
          return;
        }

        throw new Error(`Unexpected command: ${command}`);
      },
      sftp: (
        callback: (
          error: Error | null,
          sftp: {
            createWriteStream: (remotePath: string) => Writable;
            end: () => void;
          },
        ) => void,
      ) => {
        callback(null, {
          createWriteStream: (remotePath) => {
            expect(remotePath).toBe("/root/.zcode/server/node.new");
            return new SuccessfulSftpWriteStream();
          },
          end: () => {},
        });
      },
    };

    const mutableBackend = backend as unknown as {
      client: typeof fakeClient;
      connected: boolean;
    };
    mutableBackend.client = fakeClient;
    mutableBackend.connected = true;

    try {
      const progress: Array<{ uploadedBytes: number; totalBytes: number }> = [];
      await expect(
        backend.upload(localFilePath, "~/.zcode/server/node.new", {
          onProgress: (event) => progress.push(event),
        }),
      ).resolves.toBeUndefined();
      const progressLogs = consoleLogSpy.mock.calls
        .map((call) => String(call[0] ?? ""))
        .filter((line) => line.startsWith("[ssh] upload progress [sftp] (node.new):"));
      expect(progressLogs.length).toBeGreaterThan(0);
      expect(progressLogs.at(-1)).toContain("100.0%");
      expect(progressLogs.at(-1)).toContain("MB/s");
      expect(progress.at(-1)).toEqual({
        uploadedBytes: 96 * 1024,
        totalBytes: 96 * 1024,
      });
    } finally {
      consoleLogSpy.mockRestore();
    }
  });

  it("upload fallback 时应明确记录切换到 exec pipe", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ssh-backend-fallback-log-"));
    const localFilePath = join(tempDir, "node");
    await writeFile(localFilePath, Buffer.alloc(96 * 1024, "a"));

    const backend = new SSHBackend({
      host: "example.com",
      username: "root",
      password: "secret",
    });

    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const failingSftpError = Object.assign(new Error("Failure"), {
      code: 4,
    });

    const fakeClient = {
      exec: (
        command: string,
        callback: (error: Error | null, channel: FakeExecChannel | FakeUploadExecChannel) => void,
      ) => {
        if (command === `/bin/sh -c ${quotePosixShellArgForTest('printf %s "$HOME"')}`) {
          const channel = new FakeExecChannel();
          callback(null, channel);
          emitExecResult(channel, {
            stdout: "/root",
            exitCode: 0,
          });
          return;
        }

        if (
          command === `/bin/sh -c ${quotePosixShellArgForTest("mkdir -p '/root/.zcode/server'")}`
        ) {
          const channel = new FakeExecChannel();
          callback(null, channel);
          emitExecResult(channel, { exitCode: 0 });
          return;
        }

        if (
          command ===
          `/bin/sh -c ${quotePosixShellArgForTest("mkdir -p '/root/.zcode/server' && cat > '/root/.zcode/server/node.new'")}`
        ) {
          callback(null, new FakeUploadExecChannel((_content) => {}));
          return;
        }

        throw new Error(`Unexpected command: ${command}`);
      },
      sftp: (
        callback: (
          error: Error | null,
          sftp: {
            createWriteStream: (remotePath: string) => Writable;
            end: () => void;
          },
        ) => void,
      ) => {
        callback(null, {
          createWriteStream: (_remotePath) => new FailingSftpWriteStream(failingSftpError),
          end: () => {},
        });
      },
    };

    const mutableBackend = backend as unknown as {
      client: typeof fakeClient;
      connected: boolean;
    };
    mutableBackend.client = fakeClient;
    mutableBackend.connected = true;

    try {
      await expect(
        backend.upload(localFilePath, "~/.zcode/server/node.new"),
      ).resolves.toBeUndefined();
      const warnLines = consoleWarnSpy.mock.calls.map((call) => String(call[0] ?? ""));
      const logLines = consoleLogSpy.mock.calls.map((call) => String(call[0] ?? ""));
      const errorLines = consoleErrorSpy.mock.calls.map((call) => String(call[0] ?? ""));

      expect(
        warnLines.some((line) =>
          line.includes(
            "switching node.new from sftp to exec pipe after sftp-write failure (FAILURE(code=4))",
          ),
        ),
      ).toBe(true);
      expect(
        logLines.some((line) => line.includes("upload: started via exec pipe for node.new")),
      ).toBe(true);
      expect(
        logLines.some((line) => line.startsWith("[ssh] upload progress [exec] (node.new):")),
      ).toBe(true);
      expect(
        logLines.some((line) => line.includes("upload progress [sftp] (node.new): 100.0%")),
      ).toBe(false);
      expect(
        errorLines.filter((line) =>
          line.includes("upload: sftp write failed for node.new: FAILURE(code=4)"),
        ).length,
      ).toBe(0);
      expect(
        errorLines.some((line) => line.includes("upload: local read failed for node.new")),
      ).toBe(false);
    } finally {
      consoleLogSpy.mockRestore();
      consoleWarnSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    }
  });
});
