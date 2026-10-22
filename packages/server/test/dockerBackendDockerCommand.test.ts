import { EventEmitter } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  isDockerAvailable: vi.fn(),
  listDockerContainers: vi.fn(),
  resolveDockerCommand: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: mocks.execFile,
  spawn: mocks.spawn,
}));

vi.mock("@zcode/server/remote/docker-detect.js", () => ({
  isDockerAvailable: mocks.isDockerAvailable,
  listDockerContainers: mocks.listDockerContainers,
  resolveDockerCommand: mocks.resolveDockerCommand,
}));

import { DockerBackend } from "@zcode/server/remote/docker-backend.js";

const RESOLVED_DOCKER_COMMAND = "/resolved/bin/docker";

function createBackend(): DockerBackend {
  return new DockerBackend({
    kind: "docker",
    container: "zcode-dev",
  });
}

function createSpawnChild() {
  const child = new EventEmitter() as EventEmitter & {
    stderr: PassThrough;
    stdin: PassThrough;
    stdout: PassThrough;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  queueMicrotask(() => child.emit("spawn"));
  return child;
}

function resolveDockerExecStdout(args: string[]): string {
  const shellCommand = args.at(-1) ?? "";
  if (shellCommand === "printf %s ~") {
    return "/root";
  }
  if (shellCommand === "uname -s") {
    return "Linux\n";
  }
  if (shellCommand === "uname -m") {
    return "arm64\n";
  }
  if (shellCommand.includes("ingress-token")) {
    return "test-ingress-token\n";
  }
  if (shellCommand.includes("/proc/sys/kernel/ostype")) {
    return "Linux\n";
  }
  return "";
}

describe("DockerBackend docker command resolution", () => {
  beforeEach(() => {
    mocks.execFile.mockReset();
    mocks.spawn.mockReset();
    mocks.isDockerAvailable.mockReset();
    mocks.listDockerContainers.mockReset();
    mocks.resolveDockerCommand.mockReset();

    mocks.resolveDockerCommand.mockReturnValue(RESOLVED_DOCKER_COMMAND);
    mocks.isDockerAvailable.mockResolvedValue(true);
    mocks.listDockerContainers.mockResolvedValue([
      {
        id: "abc123",
        image: "ubuntu:24.04",
        name: "zcode-dev",
        state: "running",
        status: "Up 2 minutes",
      },
    ]);
    mocks.execFile.mockImplementation(
      (
        _command: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        queueMicrotask(() => callback(null, resolveDockerExecStdout(args), ""));
        return {} as never;
      },
    );
    mocks.spawn.mockImplementation(() => createSpawnChild());
  });

  it.each(["", " ", "-it", "--privileged", "bad name", "bad/name", "bad\nname"])(
    "直接执行与 home 文件读取在调用 CLI 前拒绝非法容器引用 %j",
    async (container) => {
      const backend = new DockerBackend({ kind: "docker", container });
      await expect(backend.exec("printf ok")).rejects.toThrow("Invalid Docker container reference");
      await expect(backend.readFile("~/.zcode/ingress-token")).rejects.toThrow(
        "Invalid Docker container reference",
      );
      expect(mocks.spawn).not.toHaveBeenCalled();
      expect(mocks.execFile).not.toHaveBeenCalled();
      expect(mocks.listDockerContainers).not.toHaveBeenCalled();
    },
  );

  it.each(["dev_1.test-name", "a".repeat(64), "abc123", " zcode-dev "])(
    "直接路径接受名称和 ID 且不增加 CLI 往返：%j",
    async (container) => {
      const backend = new DockerBackend({ kind: "docker", container });
      await backend.exec("printf ok");
      await backend.readFile("~/.zcode/ingress-token");
      expect(mocks.spawn).toHaveBeenCalledOnce();
      expect(mocks.execFile).toHaveBeenCalledOnce();
      expect(mocks.spawn.mock.calls[0]![1][2]).toBe(container.trim());
      expect(mocks.execFile.mock.calls[0]![1][2]).toBe(container.trim());
      expect(mocks.listDockerContainers).not.toHaveBeenCalled();
    },
  );

  it("exec 链路中的 docker exec 使用解析后的 Docker CLI", async () => {
    const backend = createBackend();

    await backend.exec("printf ok");

    expect(mocks.execFile).not.toHaveBeenCalled();
    expect(mocks.spawn).toHaveBeenCalledWith(
      RESOLVED_DOCKER_COMMAND,
      ["exec", "-i", "zcode-dev", "sh", "-lc", "printf ok"],
      expect.any(Object),
    );
    await backend.exec("printf again");
    expect(mocks.isDockerAvailable).not.toHaveBeenCalled();
    expect(mocks.listDockerContainers).not.toHaveBeenCalled();
  });

  it("无进度上传也应由容器用户流式写入，避免 docker cp 文件所有权错配", async () => {
    mocks.spawn.mockImplementation(() => {
      const child = createSpawnChild();
      child.stdin.resume();
      child.stdin.on("finish", () => queueMicrotask(() => child.emit("close", 0)));
      return child;
    });
    const backend = createBackend();

    await backend.upload(fileURLToPath(import.meta.url), "~/.zcode/server/server.tgz");

    expect(mocks.spawn).toHaveBeenCalledWith(
      RESOLVED_DOCKER_COMMAND,
      ["exec", "-i", "zcode-dev", "sh", "-lc", "cat > '/root/.zcode/server/server.tgz'"],
      expect.any(Object),
    );
    expect(mocks.execFile.mock.calls.some((call) => (call[1] as string[])[0] === "cp")).toBe(false);
    expect(
      [...mocks.execFile.mock.calls, ...mocks.spawn.mock.calls].every(
        (call) => call[0] === RESOLVED_DOCKER_COMMAND,
      ),
    ).toBe(true);
  });

  it("流式上传失败时应保留容器 stderr 诊断", async () => {
    mocks.spawn.mockImplementation(() => {
      const child = createSpawnChild();
      child.stdin.resume();
      child.stdin.on("finish", () =>
        queueMicrotask(() => {
          child.stderr.write("cat: /root/file: Permission denied\n");
          child.stderr.end();
          child.emit("close", 1);
        }),
      );
      return child;
    });
    const backend = createBackend();

    await expect(backend.upload(fileURLToPath(import.meta.url), "/root/file")).rejects.toThrow(
      "Permission denied",
    );
  });

  it("直接读取 home 相对文件时不预跑 Docker 可用性、容器列表或 home 探测", async () => {
    const backend = createBackend();

    await expect(backend.readFile("~/.zcode/server/run/ingress-token")).resolves.toBe(
      "test-ingress-token\n",
    );

    expect(mocks.isDockerAvailable).not.toHaveBeenCalled();
    expect(mocks.listDockerContainers).not.toHaveBeenCalled();
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
    expect(mocks.execFile).toHaveBeenCalledWith(
      RESOLVED_DOCKER_COMMAND,
      ["exec", "-i", "zcode-dev", "sh", "-lc", "cat \"$HOME\"/'.zcode/server/run/ingress-token'"],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("带 progress 选项时改走 exec 流式上传并上报字节", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "docker-upload-progress-"));
    const localPath = join(tempDir, "attachment.bin");
    await writeFile(localPath, Buffer.alloc(96 * 1024, "a"));
    mocks.spawn.mockImplementation(() => {
      const child = createSpawnChild();
      child.stdin.resume();
      child.stdin.on("finish", () => queueMicrotask(() => child.emit("close", 0)));
      return child;
    });
    const backend = createBackend();
    const progress: Array<{ uploadedBytes: number; totalBytes: number }> = [];

    await backend.upload(localPath, "~/.zcode/tmp/attachment.bin", {
      onProgress: (event) => progress.push(event),
    });

    expect(mocks.spawn).toHaveBeenCalledWith(
      RESOLVED_DOCKER_COMMAND,
      ["exec", "-i", "zcode-dev", "sh", "-lc", "cat > '/root/.zcode/tmp/attachment.bin'"],
      expect.any(Object),
    );
    expect(progress.at(-1)).toEqual({
      uploadedBytes: 96 * 1024,
      totalBytes: 96 * 1024,
    });
  });
});
