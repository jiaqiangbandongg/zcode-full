import { PassThrough } from "node:stream";
import { Emitter } from "@zcode/rpc";
import type { RemoteTarget } from "@zcode/shared";
import type { IRemoteBackend, StdioStream } from "../src/remote/backend.js";
import {
  createSourceServerTransportAdapter,
  type SourceServerTransportAdapter,
} from "../src/source-server/transportAdapter.js";
import { describe, expect, it, vi } from "vitest";

function completedStream(stdoutText: string, stderrText = "", code = 0): StdioStream {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const closed = new Emitter<number>();
  setTimeout(() => {
    stdout.end(stdoutText);
    stderr.end(stderrText);
    closed.fire(code);
  }, 0);
  return { stdin, stdout, stderr, onClose: closed.event };
}

class FakeBackend implements IRemoteBackend {
  readonly commands: string[] = [];
  readonly uploads: Array<{ localPath: string; remotePath: string }> = [];
  readonly readPaths: string[] = [];

  constructor(
    private readonly versionOutput = "3.8.0\n",
    private readonly updateResult?: {
      stdout: string;
      stderr?: string;
      exitCode: number;
    },
    private readonly serveResult?: {
      stdout: string;
      stderr?: string;
      exitCode: number;
    },
    private readonly tarAvailable = true,
  ) {}

  async detect() {
    return { platform: "linux", arch: "x64" };
  }

  async upload(localPath: string, remotePath: string): Promise<void> {
    this.uploads.push({ localPath, remotePath });
  }

  async exec(command: string): Promise<StdioStream> {
    this.commands.push(command);
    if (command.includes("__ZCODE_PROBE_PLATFORM__")) {
      const releaseSection = command.includes("__ZCODE_PROBE_RELEASE__")
        ? `__ZCODE_PROBE_RELEASE__\n${JSON.stringify({ version: "3.8.0", archiveSha256: "c".repeat(64) })}\n`
        : "";
      return completedStream(
        `__ZCODE_PROBE_PLATFORM__\nLinux\n` +
          `__ZCODE_PROBE_ARCH__\nx86_64\n` +
          `__ZCODE_PROBE_KERNEL__\nLinux\n` +
          `__ZCODE_PROBE_INSTALLED__\n1\n` +
          releaseSection +
          `__ZCODE_PROBE_VERSION__\n${this.versionOutput}` +
          `__ZCODE_PROBE_STATUS__\n${JSON.stringify({
            state: "ready",
            port: 43123,
            version: "3.8.0",
            serviceRegistered: false,
          })}\n` +
          `__ZCODE_PROBE_END__\n`,
      );
    }
    if (command.includes("command -v tar") && !command.includes("command -v curl")) {
      return completedStream(this.tarAvailable ? "tar=tar\n" : "tar=\n");
    }
    if (command.includes("command -v curl")) {
      return completedStream("download=curl\ntar=tar\nsha256=sha256sum\n");
    }
    if (command.includes("curl -fL"))
      return completedStream(
        "download progress: [Source Server linux-x64] 50.0% (2.0/4.0 MB, 1.00 MB/s)\n",
      );
    if (command.includes("proxy-stdio")) {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const closed = new Emitter<number>();
      stdin.pipe(stdout);
      stdin.once("end", () => closed.fire(0));
      return { stdin, stdout, stderr, onClose: closed.event };
    }
    if (command.includes("--version")) return completedStream(this.versionOutput);
    if (command.includes("'status'")) {
      return completedStream(
        `${JSON.stringify({
          state: "ready",
          port: 43123,
          version: "3.8.0",
          serviceRegistered: false,
        })}\n`,
      );
    }
    if (command.includes("'serve' '--daemon'")) {
      if (this.serveResult) {
        return completedStream(
          this.serveResult.stdout,
          this.serveResult.stderr,
          this.serveResult.exitCode,
        );
      }
      return completedStream(
        `${JSON.stringify({
          state: "ready",
          port: 43123,
          version: "3.8.0",
          serviceRegistered: false,
        })}\n`,
      );
    }
    if (command.includes("update --from-archive")) {
      if (this.updateResult) {
        return completedStream(
          this.updateResult.stdout,
          this.updateResult.stderr,
          this.updateResult.exitCode,
        );
      }
      return completedStream(`${JSON.stringify({ ok: true, applied: true })}\n`);
    }
    return completedStream(`${JSON.stringify({ ok: true })}\n`);
  }

  async exists(): Promise<boolean> {
    return true;
  }

  async readFile(remotePath: string): Promise<string> {
    this.readPaths.push(remotePath);
    if (remotePath.endsWith("ingress-token")) return "ingress-token-value";
    if (remotePath.endsWith("current.json")) {
      return JSON.stringify({ archiveSha256: "c".repeat(64) });
    }
    return "";
  }

  dispose(): void {}
}

const targets: RemoteTarget[] = [
  { kind: "ssh", host: "example.com", username: "alice" },
  { kind: "wsl", distro: "Ubuntu-24.04", user: "alice" },
  { kind: "docker", container: "zcode-dev" },
];

it("reads the installed release identity only when development probing requests it", async () => {
  const backend = new FakeBackend();
  const target = targets[0]!;
  const adapter = createSourceServerTransportAdapter("ssh", {
    createBackend: async () => backend,
  });

  await expect(adapter.probe(target, {})).resolves.not.toHaveProperty("installedArchiveSha256");
  expect(backend.commands.at(-1)).not.toContain("__ZCODE_PROBE_RELEASE__");

  await expect(adapter.probe(target, {}, { includeReleaseIdentity: true })).resolves.toMatchObject({
    installedArchiveSha256: "c".repeat(64),
  });
  expect(backend.commands.at(-1)).toContain("__ZCODE_PROBE_RELEASE__");
});

describe("probe failure classification", () => {
  const target = targets[0]!;
  const probeWith = (exec: () => Promise<StdioStream>) => {
    const backend = new FakeBackend();
    backend.exec = async (command) => {
      backend.commands.push(command);
      return exec();
    };
    return createSourceServerTransportAdapter("ssh", { createBackend: async () => backend }).probe(
      target,
      {},
    );
  };

  it.each([
    "SSH 连接握手超时：未能在 15 秒内建立 SSH 会话，请检查网络、服务器 SSH 服务或终端 SSH 配置差异",
    "Connection lost before handshake",
  ])("does not report transport failure %s as a preflight failure", async (message) => {
    // 传输失败不是远端环境不满足；未识别时只能是未知，不能借探测阶段冒充预检失败。
    await expect(probeWith(() => Promise.reject(new Error(message)))).rejects.toMatchObject({
      code: "remote-connection-unknown",
      message,
    });
  });

  it("keeps the network classification of a reset transport", async () => {
    const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    await expect(probeWith(() => Promise.reject(reset))).rejects.toMatchObject({
      code: "remote-host-unreachable",
    });
  });

  it("reports a failed environment probe command as a preflight failure", async () => {
    await expect(
      probeWith(async () => completedStream("", "sh: uname: not found", 127)),
    ).rejects.toMatchObject({ code: "remote-preflight-failed", message: "sh: uname: not found" });
  });

  it("keeps the specific reason a failed environment probe reports", async () => {
    await expect(
      probeWith(async () => completedStream("", "mkdir: Permission denied", 1)),
    ).rejects.toMatchObject({ code: "remote-permission-denied" });
  });

  it("reports an unsupported remote platform as a preflight failure", async () => {
    await expect(
      probeWith(async () =>
        completedStream(
          "__ZCODE_PROBE_PLATFORM__\nMINGW64_NT-10.0\n__ZCODE_PROBE_ARCH__\nx86_64\n" +
            "__ZCODE_PROBE_INSTALLED__\n0\n__ZCODE_PROBE_END__\n",
        ),
      ),
    ).rejects.toMatchObject({ code: "remote-preflight-failed" });
  });

  const linuxProbeOutput = (libc: string) =>
    "__ZCODE_PROBE_PLATFORM__\nLinux\n__ZCODE_PROBE_ARCH__\nx86_64\n__ZCODE_PROBE_KERNEL__\nLinux\n" +
    `__ZCODE_PROBE_LIBC__\n${libc}\n__ZCODE_PROBE_INSTALLED__\n0\n__ZCODE_PROBE_END__\n`;

  it.each(["2.17", "2.27"])(
    "rejects Linux glibc %s before install because the bundled Node runtime needs glibc 2.28",
    async (version) => {
      // ZCT-2112008575366098944：CentOS 7 先上传 87MB archive，解压后执行 bin/zcode 才报 7 行 not found。
      await expect(
        probeWith(async () => completedStream(linuxProbeOutput(`glibc ${version}`))),
      ).rejects.toMatchObject({
        code: "remote-preflight-failed",
        message: expect.stringMatching(
          new RegExp(`glibc ${version.replace(".", "\\.")}\\b.*glibc 2\\.28`, "u"),
        ),
      });
    },
  );

  it.each(["glibc 2.28", "glibc 2.39", ""])(
    "keeps the install chain when the remote libc reports %j",
    async (libc) => {
      // 空段代表 musl、缺 getconf 或无法识别：读不到版本时不凭猜测拒绝。
      await expect(
        probeWith(async () => completedStream(linuxProbeOutput(libc))),
      ).resolves.toMatchObject({ platform: "linux", installed: false });
    },
  );
});

it("probes environment, installation, release identity, version and live status without starting the CLI", async () => {
  const backend = new FakeBackend();
  const adapter = createSourceServerTransportAdapter("ssh", {
    createBackend: async () => backend,
  });

  await adapter.probe(targets[0]!, {}, { includeReleaseIdentity: true });

  const probeCommands = backend.commands.filter((command) =>
    command.includes("__ZCODE_PROBE_PLATFORM__"),
  );
  expect(probeCommands).toHaveLength(1);
  expect(probeCommands[0]).toContain("current.json");
  expect(probeCommands[0]).toContain("run/status.json");
  expect(probeCommands[0]).toContain("getconf GNU_LIBC_VERSION 2>/dev/null");
  expect(probeCommands[0]).not.toContain(" status --json");
  expect(probeCommands[0]).not.toContain(" --version");
});

it("reuses a just-probed ready daemon status instead of running serve --daemon again", async () => {
  const backend = new FakeBackend();
  const adapter = createSourceServerTransportAdapter("ssh", {
    createBackend: async () => backend,
  });
  const probe = await adapter.probe(targets[0]!, {});
  const commandCountBeforeEnsure = backend.commands.length;

  await expect(
    adapter.ensureDaemon(targets[0]!, {}, { observedStatus: probe.daemonStatus }),
  ).resolves.toEqual({ port: 43123, ingressToken: "ingress-token-value" });

  expect(backend.commands.slice(commandCountBeforeEnsure)).not.toEqual(
    expect.arrayContaining([expect.stringContaining("'serve' '--daemon'")]),
  );
});

function contract(name: string, target: RemoteTarget): void {
  describe(`${name} Source Server Transport contract`, () => {
    it("implements the common probe/install/daemon/channel/exec behavior", async () => {
      const backend = new FakeBackend();
      const adapter: SourceServerTransportAdapter = createSourceServerTransportAdapter(
        target.kind as "ssh" | "wsl" | "docker",
        { createBackend: async () => backend },
      );

      await expect(adapter.probe(target, {})).resolves.toMatchObject({
        platform: "linux",
        arch: "x64",
        installed: true,
        installedVersion: "3.8.0",
        daemonStatus: { state: "ready", port: 43123 },
      });
      await adapter.installOrUpdate(
        target,
        {
          localArchivePath: "/tmp/zcode-server-linux-x64.tar.gz",
          target: "linux-x64",
          version: "3.8.0",
          sha256: "a".repeat(64),
          sizeBytes: 1024,
          urls: ["https://cdn.example.test/zcode-server-linux-x64.tar.gz"],
        },
        {},
        { force: true },
      );
      expect(backend.uploads).toHaveLength(1);
      expect(backend.uploads[0]?.remotePath).toMatch(
        /^~\/\.zcode\/server\/\.bootstrap-[^/]+\/zcode-server\.tar\.gz$/u,
      );
      expect(backend.uploads[0]?.remotePath).not.toContain("/tmp/");
      const prepareCommand = backend.commands.find(
        (command) => command.includes("mkdir -p") && command.includes(".bootstrap-"),
      );
      expect(prepareCommand).toContain('"$HOME/.zcode/server"/.bootstrap-*');
      expect(prepareCommand).toContain("1800000");
      expect(prepareCommand).toContain("date +%s");
      const updateCommand = backend.commands.find((command) =>
        command.includes("update --from-archive"),
      );
      expect(updateCommand).toContain("--force");
      if (target.kind === "ssh") {
        expect(updateCommand).not.toContain("ZCODE_SERVER_SKIP_SERVICE_REGISTRATION=1");
      } else {
        expect(updateCommand).toContain("ZCODE_SERVER_SKIP_SERVICE_REGISTRATION=1");
      }
      const daemonLogs: string[] = [];
      const ingress = await adapter.ensureDaemon(target, {
        onLog: (event) => daemonLogs.push(event.message),
      });
      expect(ingress).toEqual({
        port: 43123,
        ingressToken: "ingress-token-value",
      });
      expect(daemonLogs).toContain(
        "Source Server started in detached fallback mode for this remote environment",
      );
      const serveCommand = backend.commands.find((command) =>
        command.includes("'serve' '--daemon'"),
      );
      if (target.kind === "ssh") {
        expect(serveCommand).not.toContain("ZCODE_SERVER_SKIP_SERVICE_REGISTRATION=1");
      } else {
        expect(serveCommand).toContain("ZCODE_SERVER_SKIP_SERVICE_REGISTRATION=1");
      }

      const channel = await adapter.openChannel(target, ingress, {});
      const echoed = new Promise<Buffer>((resolve) =>
        channel.once("data", (data) => resolve(Buffer.from(data))),
      );
      channel.write(Buffer.from([0, 1, 2, 255]));
      expect(await echoed).toEqual(Buffer.from([0, 1, 2, 255]));
      channel.end();

      await expect(adapter.exec(target, ["status", "--json"], {})).resolves.toMatchObject({
        exitCode: 0,
      });
      expect(backend.commands.some((command) => command.includes("proxy-stdio"))).toBe(true);
    });
  });
}

for (const target of targets) contract(target.kind, target);

it.each(targets)("forwards $kind install progress before command completion", async (target) => {
  const backend = new FakeBackend();
  const originalExec = backend.exec.bind(backend);
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const closed = new Emitter<number>();
  const started = Promise.withResolvers<void>();
  vi.spyOn(backend, "exec").mockImplementation(async (command) => {
    if (!command.includes("update --from-archive")) return await originalExec(command);
    backend.commands.push(command);
    started.resolve();
    return { stdin: new PassThrough(), stdout, stderr, onClose: closed.event };
  });
  const adapter = createSourceServerTransportAdapter(target.kind as "ssh" | "wsl" | "docker", {
    createBackend: async () => backend,
  });
  const onLog = vi.fn();
  let complete = false;
  const install = adapter.installOrUpdate(target, {
    localArchivePath: "/tmp/release.tar.gz", target: "linux-x64", version: "3.12.1",
    sha256: "a".repeat(64), sizeBytes: 1024, urls: [],
  }, { onLog }).then(() => { complete = true; });
  await started.promise;
  expect(backend.commands.at(-1)).toContain("--progress");
  expect(onLog).toHaveBeenCalledWith(expect.objectContaining({ phase: "extract" }));
  stdout.write('shell banner\n{"type":"source-server-install-progress","phase":"ver');
  stdout.write('ify"}\n{"type":"source-server-install-progress","phase":"ready"}\n');
  await vi.waitFor(() => expect(onLog).toHaveBeenCalledWith(expect.objectContaining({ phase: "verify" })));
  expect(complete).toBe(false);
  expect(onLog).not.toHaveBeenCalledWith(expect.objectContaining({ phase: "ready" }));
  stdout.write('{"type":"source-server-install-progress","phase":"restart"}\n');
  await vi.waitFor(() => expect(onLog).toHaveBeenCalledWith(expect.objectContaining({ phase: "restart" })));
  stdout.end('{"applied":true}\n');
  stderr.end();
  closed.fire(0);
  await install;
  expect(complete).toBe(true);
});

it("extracts a unique semver from legacy decorated version output", async () => {
  const backend = new FakeBackend("legacy zcode server version v3.7.4\n");
  const adapter = createSourceServerTransportAdapter("docker", {
    createBackend: async () => backend,
  });

  await expect(adapter.probe({ kind: "docker", container: "legacy" }, {})).resolves.toMatchObject({
    installedVersion: "3.7.4",
  });
});

it("extracts one pure semver line despite remote shell stdout noise", async () => {
  const backend = new FakeBackend("remote shell banner\nv3.8.0\n");
  const adapter = createSourceServerTransportAdapter("docker", {
    createBackend: async () => backend,
  });

  await expect(adapter.probe({ kind: "docker", container: "legacy" }, {})).resolves.toMatchObject({
    installedVersion: "3.8.0",
  });
});

it("does not treat an unrelated IP address as a legacy Source Server version", async () => {
  const backend = new FakeBackend("connected to 10.0.0.1\n");
  const adapter = createSourceServerTransportAdapter("docker", {
    createBackend: async () => backend,
  });

  await expect(adapter.probe({ kind: "docker", container: "legacy" }, {})).resolves.toEqual(
    expect.not.objectContaining({ installedVersion: expect.anything() }),
  );
});

it("preserves a public archive update guard from CLI JSON", async () => {
  const backend = new FakeBackend("3.8.0\n", {
    stdout: `${JSON.stringify({
      ok: false,
      code: "source-server-update-running-tasks",
      retryable: false,
      error: "Running tasks require --force for update",
    })}\n`,
    exitCode: 1,
  });
  const adapter = createSourceServerTransportAdapter("docker", {
    createBackend: async () => backend,
  });

  await expect(
    adapter.installOrUpdate(
      { kind: "docker", container: "busy" },
      {
        localArchivePath: "/tmp/zcode-server-linux-x64.tar.gz",
        target: "linux-x64",
        version: "3.9.0",
        sha256: "b".repeat(64),
        sizeBytes: 2048,
        urls: ["https://cdn.example.test/zcode-server-linux-x64.tar.gz"],
      },
      {},
    ),
  ).rejects.toMatchObject({
    code: "source-server-update-running-tasks",
    retryable: false,
    message: "Running tasks require --force for update",
  });
  const updateCommand = backend.commands.find((command) =>
    command.includes("update --from-archive"),
  );
  expect(updateCommand).toMatch(/trap .* EXIT/u);
  expect(updateCommand).toContain(".bootstrap-");
  expect(updateCommand).toContain("zcode-server.tar.gz");
  expect(updateCommand).not.toContain("/tmp/zcode-server-bootstrap-");
  expect(updateCommand).toContain('"$HOME/.zcode/server"/.bootstrap-');
});

it.each(targets)(
  "surfaces the structured $kind archive error before stderr runtime warnings",
  async (target) => {
    const error = "Server Core pid 6011 did not terminate after SIGKILL";
    const backend = new FakeBackend("3.8.0\n", {
      stdout: `${JSON.stringify({ type: "source-server-install-progress", phase: "restart" })}\n${JSON.stringify({ ok: false, error })}\n`,
      stderr: "(node:6011) ExperimentalWarning: SQLite is an experimental feature\n",
      exitCode: 1,
    });
    const adapter = createSourceServerTransportAdapter(target.kind, {
      createBackend: async () => backend,
    });

    await expect(
      adapter.installOrUpdate(
        target,
        {
          localArchivePath: "/tmp/zcode-server-linux-x64.tar.gz",
          target: "linux-x64",
          version: "3.9.0",
          sha256: "b".repeat(64),
          sizeBytes: 2048,
          urls: [],
        },
        {},
      ),
    ).rejects.toThrow(error);
  },
);

it("surfaces the structured daemon error before stderr runtime warnings", async () => {
  const backend = new FakeBackend("3.8.1\n", undefined, {
    stdout: `${JSON.stringify({
      ok: false,
      error: "Failed to register Source Server service: user service manager unavailable",
    })}\n`,
    stderr:
      "(node:4823) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n",
    exitCode: 1,
  });
  const adapter = createSourceServerTransportAdapter("ssh", {
    createBackend: async () => backend,
  });

  await expect(
    adapter.ensureDaemon({ kind: "ssh", host: "example.com", username: "alice" }, {}),
  ).rejects.toThrow("Failed to register Source Server service: user service manager unavailable");
});

describe("SSH gateway that merges remote stderr into stdout", () => {
  // 部分 SSH 堡垒机把远端 stderr 合并进 stdout，并在 stdout 结束后才投递，warning 排在结果行之后。
  const mergedWarning =
    "(node:4823) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n" +
    "(Use `node --trace-warnings ...` to show where the warning was created)\n";
  const target: RemoteTarget = { kind: "ssh", host: "example.com", username: "alice" };

  it("reads the daemon status before the merged warning", async () => {
    const backend = new FakeBackend("3.8.1\n", undefined, {
      stdout: `${JSON.stringify({ state: "ready", port: 43123, serviceRegistered: true })}\n${mergedWarning}`,
      exitCode: 0,
    });
    const adapter = createSourceServerTransportAdapter("ssh", {
      createBackend: async () => backend,
    });

    await expect(adapter.ensureDaemon(target, {})).resolves.toEqual({
      port: 43123,
      ingressToken: "ingress-token-value",
    });
  });

  it("surfaces the structured daemon error before the merged warning", async () => {
    const backend = new FakeBackend("3.8.1\n", undefined, {
      stdout: `${JSON.stringify({ ok: false, error: "Source Server daemon crashed" })}\n${mergedWarning}`,
      exitCode: 1,
    });
    const adapter = createSourceServerTransportAdapter("ssh", {
      createBackend: async () => backend,
    });

    await expect(adapter.ensureDaemon(target, {})).rejects.toThrow("Source Server daemon crashed");
  });

  it("reads the archive update result before the merged warning", async () => {
    const backend = new FakeBackend("3.8.0\n", {
      stdout:
        `${JSON.stringify({ type: "source-server-install-progress", phase: "restart" })}\n` +
        `${JSON.stringify({ ok: true, applied: true })}\n${mergedWarning}`,
      exitCode: 0,
    });
    const adapter = createSourceServerTransportAdapter("ssh", {
      createBackend: async () => backend,
    });

    await expect(
      adapter.installOrUpdate(
        target,
        {
          localArchivePath: "/tmp/zcode-server-linux-x64.tar.gz",
          target: "linux-x64",
          version: "3.9.0",
          sha256: "b".repeat(64),
          sizeBytes: 2048,
          urls: [],
        },
        {},
      ),
    ).resolves.toBeUndefined();
  });
});

it("fails before uploading when the remote host cannot extract the archive", async () => {
  const backend = new FakeBackend("3.8.1\n", undefined, undefined, false);
  const adapter = createSourceServerTransportAdapter("ssh", {
    createBackend: async () => backend,
  });

  await expect(
    adapter.installOrUpdate(
      { kind: "ssh", host: "example.com", username: "alice" },
      {
        localArchivePath: "/tmp/zcode-server-linux-x64.tar.gz",
        target: "linux-x64",
        version: "3.8.1",
        sha256: "d".repeat(64),
        sizeBytes: 4096,
        urls: ["https://cdn.example.test/zcode-server-linux-x64.tar.gz"],
      },
      {},
    ),
  ).rejects.toThrow("远端服务器缺少 tar");
  expect(backend.uploads).toEqual([]);
});

it("downloads and verifies the Source Server archive on the SSH target when requested", async () => {
  const backend = new FakeBackend();
  const adapter = createSourceServerTransportAdapter("ssh", {
    createBackend: async () => backend,
  });

  const onLog = vi.fn();
  await adapter.installOrUpdate(
    {
      kind: "ssh",
      host: "example.com",
      username: "alice",
      assetInstallMode: "remote-download",
    },
    {
      target: "linux-x64",
      version: "3.9.0",
      sha256: "c".repeat(64),
      sizeBytes: 4096,
      urls: ["https://cdn.example.test/zcode-server-linux-x64.tar.gz"],
    },
    { onLog },
  );

  expect(onLog).toHaveBeenCalledWith(
    expect.objectContaining({ phase: "download", message: expect.stringContaining("1.00 MB/s") }),
  );
  expect(backend.uploads).toEqual([]);
  expect(backend.commands).toEqual(
    expect.arrayContaining([
      expect.stringContaining("curl -fL"),
      expect.stringContaining("sha256sum"),
      expect.stringContaining("update --from-archive"),
    ]),
  );
});

it("uploads an explicitly resolved local development archive despite the SSH download preference", async () => {
  const backend = new FakeBackend();
  const adapter = createSourceServerTransportAdapter("ssh", {
    createBackend: async () => backend,
  });

  await adapter.installOrUpdate(
    {
      kind: "ssh",
      host: "example.com",
      username: "alice",
      assetInstallMode: "remote-download",
    },
    {
      localArchivePath: "/tmp/current-development-source-server.tar.gz",
      target: "linux-x64",
      version: "3.8.1",
      sha256: "d".repeat(64),
      sizeBytes: 4096,
      urls: ["https://cdn.example.test/zcode-server-linux-x64.tar.gz"],
    },
    {},
  );

  expect(backend.uploads).toEqual([
    {
      localPath: "/tmp/current-development-source-server.tar.gz",
      remotePath: expect.stringMatching(
        /^~\/\.zcode\/server\/\.bootstrap-[^/]+\/zcode-server\.tar\.gz$/u,
      ),
    },
  ]);
  expect(backend.commands).not.toEqual(
    expect.arrayContaining([expect.stringContaining("curl -fL")]),
  );
});

it.each(targets)("附件文件传输复用 $kind 已有 backend 且保留取消/进度参数", async (target) => {
  const backend = new FakeBackend();
  const upload = vi.spyOn(backend, "upload");
  const createBackend = vi.fn(async () => backend);
  const adapter = createSourceServerTransportAdapter(target.kind as "ssh" | "wsl" | "docker", {
    createBackend,
  });
  await adapter.probe(target, {});
  const transfer = adapter.createFileTransfer(target);
  const options = { signal: new AbortController().signal, onProgress: vi.fn() };
  await transfer.upload("/local/attachment.txt", "/remote/private/attachment.txt", options);
  await transfer.exec("printf attachment");
  expect(createBackend).toHaveBeenCalledTimes(1);
  expect(upload).toHaveBeenCalledWith(
    "/local/attachment.txt",
    "/remote/private/attachment.txt",
    options,
  );
  expect(backend.commands.at(-1)).toBe("printf attachment");
  adapter.dispose?.();
});
