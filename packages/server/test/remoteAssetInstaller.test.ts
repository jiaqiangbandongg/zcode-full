import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { access, mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PassThrough } from "node:stream";
import type { IDisposable, Event } from "@zcode/rpc";
import type {
  IRemoteBackend,
  RemoteUploadOptions,
  StdioStream,
} from "@zcode/server/remote/backend.js";
import { ZCODE_VERSION } from "@zcode/shared";
import { describe, expect, it, vi } from "vitest";
import {
  LocalUploadAssetInstaller,
  RemoteDownloadAssetInstaller,
  buildRemoteArtifactDownloadCommand,
  buildRemoteChecksumCommand,
} from "@zcode/server/remote/remoteAssetInstaller.js";
import type { RemoteSha256Tool } from "@zcode/server/remote/remoteAssetPreflight.js";
import { extractTarGzArchive } from "@zcode/server/remote/localTarGz.js";

const execFileAsync = promisify(execFile);
const localShellCommand = resolveLocalShellCommand();
const shellBackedIt = localShellCommand ? it : it.skip;

class InstallerBackend implements IRemoteBackend {
  readonly commands: string[] = [];
  readonly uploads: Array<{
    content: Buffer;
    remotePath: string;
    signal?: AbortSignal;
  }> = [];

  constructor(
    private readonly stdoutLines: string[] = [],
    private readonly existingPaths = new Set<string>(),
  ) {}

  dispose(): void {}

  async detect() {
    return { platform: "linux", arch: "x64" };
  }

  async upload(
    localPath: string,
    remotePath: string,
    options?: RemoteUploadOptions,
  ): Promise<void> {
    this.uploads.push({
      content: await readFile(localPath),
      remotePath,
      ...(options?.signal ? { signal: options.signal } : {}),
    });
  }

  async exists(remotePath: string): Promise<boolean> {
    return this.existingPaths.has(remotePath);
  }

  async readFile(): Promise<string> {
    throw new Error("readFile should not be called in installer tests");
  }

  async exec(command: string): Promise<StdioStream> {
    this.commands.push(command);
    return createClosedStream(this.stdoutLines);
  }
}

class FailingReplaceBackend extends InstallerBackend {
  override async exec(command: string): Promise<StdioStream> {
    this.commands.push(command);
    return createClosedStream(
      [],
      command.includes("command chmod +x") ? 1 : 0,
      command.includes("command chmod +x") ? "chmod denied" : "",
    );
  }
}

function createClosedStream(
  stdoutLines: string[] = [],
  exitCode = 0,
  stderrText = "",
): StdioStream {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const closeListeners: Array<(code: number) => void> = [];
  let closeScheduled = false;
  const onClose: Event<number> = (
    listener: (code: number) => void,
  ): IDisposable => {
    closeListeners.push(listener);
    if (!closeScheduled) {
      closeScheduled = true;
      queueMicrotask(() => {
        for (const line of stdoutLines) {
          stdout.write(`${line}\n`);
        }
        if (stderrText) {
          stderr.write(`${stderrText}\n`);
        }
        stdout.end();
        stderr.end();
        for (const closeListener of closeListeners) {
          closeListener(exitCode);
        }
      });
    }
    return { dispose() {} };
  };
  return { stdin, stdout, stderr, onClose };
}

function stubManifestFetch(manifest: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(manifest), { status: 200 })),
  );
}

function stubManifestAndHeadFetch(
  manifest: unknown,
  contentLength: number,
): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: { "content-length": String(contentLength) },
        });
      }
      return new Response(JSON.stringify(manifest), { status: 200 });
    }),
  );
}

const validManifest = {
  schemaVersion: 1,
  appVersion: ZCODE_VERSION,
  platformArch: "linux-x64",
  components: [
    {
      id: "server-bundle",
      version: "1.0.0-server-bundle",
      sha256: "a".repeat(64),
      artifactPath: "components/linux-x64/server-bundle.tar.gz",
      mount: "server",
    },
  ],
};

function hashRemoteCacheSegment(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function resolveLocalShellCommand(): string | null {
  if (process.platform !== "win32") {
    return "sh";
  }

  const gitShellCandidates = [
    join(
      process.env.ProgramFiles ?? "C:\\Program Files",
      "Git",
      "bin",
      "sh.exe",
    ),
    join(
      process.env.ProgramFiles ?? "C:\\Program Files",
      "Git",
      "usr",
      "bin",
      "sh.exe",
    ),
  ];
  return gitShellCandidates.find((candidate) => existsSync(candidate)) ?? null;
}

function toLocalShellPath(filePath: string): string {
  if (process.platform !== "win32") {
    return filePath;
  }

  // Bugfix: Git Bash 的 sha256sum 读取 C:\... 这类反斜杠路径时，会为了转义文件名在校验值前输出反斜杠，
  // 导致测试误判为 sha mismatch。远端真实路径是 POSIX 风格，这里把 Windows 临时路径转成 /c/... 来贴近远端形态。
  const normalized = filePath.replaceAll("\\", "/");
  return normalized.replace(
    /^([A-Za-z]):\//u,
    (_match, drive: string) => `/${drive.toLowerCase()}/`,
  );
}

async function detectLocalShellSha256Tool(
  shellCommand: string,
): Promise<RemoteSha256Tool> {
  // Bugfix: Windows Git Bash 环境常有 sha256sum/openssl 但没有 shasum；测试硬编码 shasum
  // 会让“备用 URL 校验失败后重试”的用例在真正执行到重试逻辑前就失败。
  const { stdout } = await execFileAsync(shellCommand, [
    "-c",
    "if command -v sha256sum >/dev/null 2>&1; then printf sha256sum; elif command -v shasum >/dev/null 2>&1; then printf shasum; elif command -v openssl >/dev/null 2>&1; then printf openssl; else exit 1; fi",
  ]);
  const tool = stdout.trim();
  if (tool === "sha256sum" || tool === "shasum" || tool === "openssl") {
    return tool;
  }
  throw new Error(`unsupported local sha256 tool: ${tool}`);
}

describe("remote asset installer command builders", () => {
  it("quotes remote paths and URLs in download commands", () => {
    const command = buildRemoteArtifactDownloadCommand({
      tool: "curl",
      urls: ["https://cdn.example.test/a b/component.tar.gz"],
      outputPath: "~/.zcode/server/asset-cache/staging/a b/component.tar.gz",
      progressLabel: "server-bundle@1.0.0-server-bundle",
    });

    expect(command).toContain("curl");
    expect(command).toContain(
      "'https://cdn.example.test/a b/component.tar.gz'",
    );
    expect(command).toContain(
      "\"$HOME\"'/.zcode/server/asset-cache/staging/a b/component.tar.gz'",
    );
  });

  it("emits remote download progress lines while downloading artifacts", () => {
    const command = buildRemoteArtifactDownloadCommand({
      tool: "wget",
      urls: ["https://cdn.example.test/component.tar.gz"],
      outputPath: "~/.zcode/server/asset-cache/staging/component.tar.gz",
      progressLabel: "server-bundle@1.0.0-server-bundle",
    });

    expect(command).toContain("download progress: [%s]");
    expect(command).toContain("label='server-bundle@1.0.0-server-bundle'");
    expect(command).toContain("total unknown");
    expect(command).toContain("progress_pid=");
    expect(command).toContain('kill "$progress_pid"');
  });

  it("emits remote download percent when artifact size is known", () => {
    const command = buildRemoteArtifactDownloadCommand({
      tool: "wget",
      urls: ["https://cdn.example.test/component.tar.gz"],
      outputPath: "~/.zcode/server/asset-cache/staging/component.tar.gz",
      progressLabel: "server-bundle@1.0.0-server-bundle",
      totalBytes: 2 * 1024 * 1024,
    });

    expect(command).toContain("total=2097152");
    expect(command).toContain("download progress: [%s] %.1f%%");
    expect(command).toContain("%.1f/%.1f MB");
    expect(command).not.toContain("total unknown");
  });

  shellBackedIt(
    "tries the next artifact URL when a downloaded candidate fails sha256 validation",
    async () => {
      const shellCommand = localShellCommand ?? "sh";
      const dir = await mkdtemp(join(tmpdir(), "zcode-installer-download-"));
      const badArchive = join(dir, "bad.tar.gz");
      const goodArchive = join(dir, "good.tar.gz");
      const outputPath = join(dir, "component.tar.gz");
      const shellOutputPath = toLocalShellPath(outputPath);
      await writeFile(badArchive, "stale artifact");
      await writeFile(goodArchive, "current artifact");
      const expectedSha256 = createHash("sha256")
        .update("current artifact")
        .digest("hex");

      const command = buildRemoteArtifactDownloadCommand({
        tool: "curl",
        urls: [pathToFileURL(badArchive).href, pathToFileURL(goodArchive).href],
        outputPath: shellOutputPath,
        progressLabel: "node-runtime@v22.16.0",
        expectedSha256,
        sha256Tool: await detectLocalShellSha256Tool(shellCommand),
      });

      await execFileAsync(shellCommand, ["-c", command]);

      await expect(readFile(outputPath, "utf8")).resolves.toBe(
        "current artifact",
      );
    },
  );

  it("builds sha256 commands for openssl", () => {
    expect(
      buildRemoteChecksumCommand({
        tool: "openssl",
        filePath: "~/.zcode/server/component.tar.gz",
      }),
    ).toContain("openssl dgst -sha256");
  });
});

describe("LocalUploadAssetInstaller", () => {
  it("已取消连接不得开始写入远端 staging", async () => {
    const releaseDir = await mkdtemp(join(tmpdir(), "zcode-installer-pre-cancel-test-"));
    await mkdir(join(releaseDir, "server"), { recursive: true });
    await writeFile(join(releaseDir, "server", "zcode-server.cjs"), "server", "utf8");
    const controller = new AbortController();
    controller.abort();
    const backend = new InstallerBackend();
    const upload = vi.spyOn(backend, "upload").mockImplementation(
      async (_localPath, _remotePath, options) => {
        if (options?.signal?.aborted) {
          const error = new Error("Remote upload canceled");
          error.name = "AbortError";
          throw error;
        }
      },
    );
    const installer = new LocalUploadAssetInstaller(
      backend,
      {
        releaseDir,
        platformArch: "linux-x64",
        signal: controller.signal,
      },
      { log: () => undefined, logWarn: () => undefined },
    );

    await expect(
      installer.installFile({
        componentId: "server-bundle",
        sourceRelativePath: "server/zcode-server.cjs",
        remotePath: "~/.zcode/server/zcode-server.cjs",
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(backend.commands).toEqual([]);
    expect(upload).not.toHaveBeenCalled();
  });

  it("把连接取消信号传给远端文件上传", async () => {
    const releaseDir = await mkdtemp(join(tmpdir(), "zcode-installer-abort-test-"));
    await mkdir(join(releaseDir, "server"), { recursive: true });
    await writeFile(
      join(releaseDir, "server", "zcode-server.cjs"),
      "server",
      "utf8",
    );
    const controller = new AbortController();
    const backend = new InstallerBackend();
    const installer = new LocalUploadAssetInstaller(
      backend,
      {
        releaseDir,
        platformArch: "linux-x64",
        signal: controller.signal,
      },
      { log: () => undefined, logWarn: () => undefined },
    );

    await installer.installFile({
      componentId: "server-bundle",
      sourceRelativePath: "server/zcode-server.cjs",
      remotePath: "~/.zcode/server/zcode-server.cjs",
    });

    expect(backend.uploads[0]?.signal).toBe(controller.signal);
  });

  it("新的 SSH 文件上传会先清理超过 24 小时的同路径 owner staging", async () => {
    const releaseDir = await mkdtemp(join(tmpdir(), "zcode-installer-stale-file-test-"));
    await mkdir(join(releaseDir, "server"), { recursive: true });
    await writeFile(join(releaseDir, "server", "zcode-server.cjs"), "server", "utf8");
    const controller = new AbortController();
    const backend = new InstallerBackend();
    const installer = new LocalUploadAssetInstaller(
      backend,
      {
        releaseDir,
        platformArch: "linux-x64",
        signal: controller.signal,
      },
      { log: () => undefined, logWarn: () => undefined },
    );

    await installer.installFile({
      componentId: "server-bundle",
      sourceRelativePath: "server/zcode-server.cjs",
      remotePath: "~/.zcode/server/zcode-server.cjs",
    });

    expect(backend.commands[0]).toContain("find");
    expect(backend.commands[0]).toContain("zcode-server.cjs.new-");
    expect(backend.commands[0]).toContain("-mtime +0");
    expect(backend.commands[0]).toContain("-exec rm -rf");
  });

  shellBackedIt("SSH staging janitor 只删除超过 24 小时的 owner 文件", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-installer-stale-shell-test-"));
    try {
      const releaseDir = join(rootDir, "release");
      const remoteDir = join(rootDir, "remote");
      await mkdir(join(releaseDir, "server"), { recursive: true });
      await mkdir(remoteDir, { recursive: true });
      await writeFile(join(releaseDir, "server", "zcode-server.cjs"), "server", "utf8");
      const targetPath = join(remoteDir, "zcode-server.cjs");
      const stalePath = `${targetPath}.new-stale`;
      const freshPath = `${targetPath}.new-fresh`;
      await writeFile(targetPath, "final", "utf8");
      await writeFile(stalePath, "stale", "utf8");
      await writeFile(freshPath, "fresh", "utf8");
      const staleTime = new Date(Date.now() - 48 * 60 * 60 * 1_000);
      await utimes(stalePath, staleTime, staleTime);
      const controller = new AbortController();
      const backend = new InstallerBackend();
      const installer = new LocalUploadAssetInstaller(
        backend,
        {
          releaseDir,
          platformArch: "linux-x64",
          signal: controller.signal,
        },
        { log: () => undefined, logWarn: () => undefined },
      );

      await installer.installFile({
        componentId: "server-bundle",
        sourceRelativePath: "server/zcode-server.cjs",
        remotePath: toLocalShellPath(targetPath),
      });
      await execFileAsync(localShellCommand!, ["-c", backend.commands[0]!]);

      await expect(access(stalePath)).rejects.toThrow();
      await expect(access(freshPath)).resolves.toBeUndefined();
      await expect(readFile(targetPath, "utf8")).resolves.toBe("final");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("文件上传取消后不再执行正式文件替换", async () => {
    const releaseDir = await mkdtemp(join(tmpdir(), "zcode-installer-cancel-test-"));
    await mkdir(join(releaseDir, "server"), { recursive: true });
    await writeFile(join(releaseDir, "server", "zcode-server.cjs"), "server", "utf8");
    const controller = new AbortController();
    const backend = new InstallerBackend();
    let markUploadStarted!: () => void;
    const uploadStarted = new Promise<void>((resolve) => {
      markUploadStarted = resolve;
    });
    vi.spyOn(backend, "upload").mockImplementation(
      async (_localPath, _remotePath, options) => {
        markUploadStarted();
        await new Promise<never>((_resolve, reject) => {
          const rejectAbort = () => {
            const error = new Error("Remote upload canceled");
            error.name = "AbortError";
            reject(error);
          };
          if (options?.signal?.aborted) {
            rejectAbort();
            return;
          }
          options?.signal?.addEventListener("abort", rejectAbort, { once: true });
        });
      },
    );
    const installer = new LocalUploadAssetInstaller(
      backend,
      {
        releaseDir,
        platformArch: "linux-x64",
        signal: controller.signal,
      },
      { log: () => undefined, logWarn: () => undefined },
    );

    const installing = installer.installFile({
      componentId: "server-bundle",
      sourceRelativePath: "server/zcode-server.cjs",
      remotePath: "~/.zcode/server/zcode-server.cjs",
    });
    await uploadStarted;
    controller.abort();

    await expect(installing).rejects.toMatchObject({ name: "AbortError" });
    expect(backend.commands).toHaveLength(1);
    expect(backend.commands[0]).toContain("mkdir -p");
  });

  it("目录上传取消后不再通过已释放连接执行远端清理", async () => {
    const releaseDir = await mkdtemp(join(tmpdir(), "zcode-installer-dir-cancel-test-"));
    const sourceDir = join(releaseDir, "tools", "linux-x64", "ripgrep");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "rg"), "ripgrep", "utf8");
    const controller = new AbortController();
    const backend = new InstallerBackend();
    let markUploadStarted!: () => void;
    const uploadStarted = new Promise<void>((resolve) => {
      markUploadStarted = resolve;
    });
    vi.spyOn(backend, "upload").mockImplementation(
      async (_localPath, _remotePath, options) => {
        markUploadStarted();
        await new Promise<never>((_resolve, reject) => {
          const rejectAbort = () => {
            const error = new Error("Remote upload canceled");
            error.name = "AbortError";
            reject(error);
          };
          if (options?.signal?.aborted) {
            rejectAbort();
            return;
          }
          options?.signal?.addEventListener("abort", rejectAbort, { once: true });
        });
      },
    );
    const installer = new LocalUploadAssetInstaller(
      backend,
      {
        releaseDir,
        platformArch: "linux-x64",
        signal: controller.signal,
      },
      { log: () => undefined, logWarn: () => undefined },
    );

    const installing = installer.installDirectory({
      componentId: "ripgrep",
      sourceRelativePath: "tools/linux-x64/ripgrep",
      remoteDir: "~/.zcode/server/tools/ripgrep",
    });
    await uploadStarted;
    controller.abort();

    await expect(installing).rejects.toMatchObject({ name: "AbortError" });
    expect(backend.commands).toHaveLength(1);
    expect(backend.commands[0]).toContain("mkdir -p");
  });

  it("新的 SSH 目录上传会先清理超过 24 小时的归档和解压 staging", async () => {
    const releaseDir = await mkdtemp(join(tmpdir(), "zcode-installer-stale-dir-test-"));
    const sourceDir = join(releaseDir, "tools", "linux-x64", "ripgrep");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "rg"), "ripgrep", "utf8");
    const controller = new AbortController();
    const backend = new InstallerBackend();
    const installer = new LocalUploadAssetInstaller(
      backend,
      {
        releaseDir,
        platformArch: "linux-x64",
        signal: controller.signal,
      },
      { log: () => undefined, logWarn: () => undefined },
    );

    await installer.installDirectory({
      componentId: "ripgrep",
      sourceRelativePath: "tools/linux-x64/ripgrep",
      remoteDir: "~/.zcode/server/tools/ripgrep",
    });

    expect(backend.commands[0]).toContain("find");
    expect(backend.commands[0]).toContain("ripgrep.tar.gz-");
    expect(backend.commands[0]).toContain("ripgrep.extract-");
    expect(backend.commands[0]).toContain("-mtime +0");
  });

  it("把连接取消信号传给远端目录归档上传", async () => {
    const releaseDir = await mkdtemp(join(tmpdir(), "zcode-installer-dir-abort-test-"));
    const sourceDir = join(releaseDir, "tools", "linux-x64", "ripgrep");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "rg"), "ripgrep", "utf8");
    const controller = new AbortController();
    const backend = new InstallerBackend();
    const installer = new LocalUploadAssetInstaller(
      backend,
      {
        releaseDir,
        platformArch: "linux-x64",
        signal: controller.signal,
      },
      { log: () => undefined, logWarn: () => undefined },
    );

    await installer.installDirectory({
      componentId: "ripgrep",
      sourceRelativePath: "tools/linux-x64/ripgrep",
      remoteDir: "~/.zcode/server/tools/ripgrep",
    });

    expect(backend.uploads[0]?.signal).toBe(controller.signal);
  });

  it("uses a unique staging path for each uploaded file replacement", async () => {
    const releaseDir = await mkdtemp(join(tmpdir(), "zcode-installer-test-"));
    await mkdir(join(releaseDir, "server"), { recursive: true });
    await writeFile(
      join(releaseDir, "server", "zcode-server.cjs"),
      "server",
      "utf8",
    );
    const backend = new InstallerBackend();
    const installer = new LocalUploadAssetInstaller(
      backend,
      { releaseDir, platformArch: "linux-x64" },
      { log: () => undefined, logWarn: () => undefined },
    );

    await installer.installFile({
      componentId: "server-bundle",
      sourceRelativePath: "server/zcode-server.cjs",
      remotePath: "~/.zcode/server/zcode-server.cjs",
    });

    expect(backend.uploads[0]?.remotePath).toMatch(
      /^~\/\.zcode\/server\/zcode-server\.cjs\.new-[\w-]+$/u,
    );
    expect(backend.commands.join("\n")).toContain(
      backend.uploads[0]!.remotePath.split("/").at(-1),
    );
    expect(backend.commands[0]).not.toContain("find");
  });

  it("非取消文件替换失败时清理当前 owner staging", async () => {
    const releaseDir = await mkdtemp(join(tmpdir(), "zcode-installer-cleanup-test-"));
    await mkdir(join(releaseDir, "node"), { recursive: true });
    await writeFile(join(releaseDir, "node", "node"), "node", "utf8");
    const backend = new FailingReplaceBackend();
    const installer = new LocalUploadAssetInstaller(
      backend,
      { releaseDir, platformArch: "linux-x64" },
      { log: () => undefined, logWarn: () => undefined },
    );

    await expect(
      installer.installFile({
        componentId: "node-runtime",
        sourceRelativePath: "node/node",
        remotePath: "~/.zcode/server/node",
        executable: true,
      }),
    ).rejects.toThrow("chmod denied");

    const stagingPath = backend.uploads[0]?.remotePath;
    expect(stagingPath).toBeDefined();
    expect(backend.commands.at(-1)).toContain("rm -f");
    expect(backend.commands.at(-1)).toContain(stagingPath!.split("/").at(-1)!);
  });

  it("resolves component versions from per-component release dirs", async () => {
    const releaseDir = await mkdtemp(join(tmpdir(), "zcode-installer-test-"));
    await writeFile(
      join(releaseDir, "manifest-linux-x64.json"),
      JSON.stringify({
        schemaVersion: 1,
        appVersion: ZCODE_VERSION,
        platformArch: "linux-x64",
        components: [
          {
            id: "node-runtime",
            version: "24.10.0-node-runtime",
            sha256: "a".repeat(64),
            artifactPath: "components/linux-x64/node-runtime.tar.gz",
            mount: "node/linux-x64",
          },
        ],
      }),
      "utf8",
    );
    const requestedComponents: Array<string[] | undefined> = [];
    const installer = new LocalUploadAssetInstaller(
      new InstallerBackend(),
      {
        platformArch: "linux-x64",
        resolveReleaseDir: async (componentIds) => {
          requestedComponents.push(componentIds);
          return releaseDir;
        },
      },
      { log: () => undefined, logWarn: () => undefined },
    );

    await expect(
      installer.resolveComponentVersion("node-runtime"),
    ).resolves.toBe("24.10.0-node-runtime");
    expect(requestedComponents).toEqual([["node-runtime"]]);
  });

  it("allows callers to probe optional local assets without throwing", async () => {
    const releaseDir = await mkdtemp(join(tmpdir(), "zcode-installer-test-"));
    const installer = new LocalUploadAssetInstaller(
      new InstallerBackend(),
      { releaseDir, platformArch: "linux-x64" },
      { log: () => undefined, logWarn: () => undefined },
    );

    await expect(
      installer.tryResolveLocalPath(
        ["node-pty"],
        "node-pty/linux-x64/missing.node",
      ),
    ).resolves.toBeNull();

    await mkdir(join(releaseDir, "server"), { recursive: true });
    await writeFile(join(releaseDir, "server", "zcode-server.cjs"), "server");
    await expect(
      installer.tryResolveLocalPath(
        ["server-bundle"],
        "server/zcode-server.cjs",
      ),
    ).resolves.toBe(join(releaseDir, "server", "zcode-server.cjs"));
  });

  it("creates directory upload archives without relying on local system tar", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-installer-test-"));
    const releaseDir = join(rootDir, "release");
    const sourceDir = join(releaseDir, "tools", "linux-x64", "ripgrep");
    const backend = new InstallerBackend();
    const installer = new LocalUploadAssetInstaller(
      backend,
      { releaseDir, platformArch: "linux-x64" },
      { log: () => undefined, logWarn: () => undefined },
    );

    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "rg"), "ripgrep binary", "utf8");

    const installParams = {
      componentId: "ripgrep",
      sourceRelativePath: "tools/linux-x64/ripgrep",
      remoteDir: "~/.zcode/server/tools/ripgrep",
    };
    await Promise.all([
      installer.installDirectory(installParams),
      installer.installDirectory(installParams),
    ]);

    expect(backend.uploads).toHaveLength(2);
    const remoteTarPaths = backend.uploads.map((upload) => upload.remotePath);
    expect(new Set(remoteTarPaths)).toHaveLength(2);
    for (const remoteTarPath of remoteTarPaths) {
      expect(remoteTarPath).toMatch(
        /^~\/.zcode\/server\/tools\/ripgrep\.tar\.gz-[\w-]+$/u,
      );
    }
    expect(backend.commands.join("\n")).toContain("ripgrep.extract-");
    expect(backend.commands.join("\n")).toContain("trap cleanup_staging EXIT");
    expect(backend.commands[0]).not.toContain("find");

    const uploadedArchive = join(rootDir, "uploaded.tar.gz");
    const extractDir = join(rootDir, "extract");
    await writeFile(uploadedArchive, backend.uploads[0]!.content);
    await extractTarGzArchive(uploadedArchive, extractDir);

    await expect(
      readFile(join(extractDir, "ripgrep", "rg"), "utf8"),
    ).resolves.toBe("ripgrep binary");
  });

  it("falls back to CDN cache when local directory exists but required child paths are missing", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-installer-test-"));
    const staleReleaseDir = join(rootDir, "stale-release");
    const cdnReleaseDir = join(rootDir, "cdn-release");
    const sourceRelativePath = "glm/linux-x64/packages";
    await mkdir(join(staleReleaseDir, sourceRelativePath), { recursive: true });
    await mkdir(
      join(
        cdnReleaseDir,
        sourceRelativePath,
        "skill-creator-plugin",
        ".zcode-plugin",
      ),
      { recursive: true },
    );
    await writeFile(
      join(
        cdnReleaseDir,
        sourceRelativePath,
        "skill-creator-plugin",
        ".zcode-plugin",
        "plugin.json",
      ),
      '{"name":"skill-creator-plugin"}',
      "utf8",
    );
    const installer = new LocalUploadAssetInstaller(
      new InstallerBackend(),
      {
        releaseDir: staleReleaseDir,
        platformArch: "linux-x64",
        version: ZCODE_VERSION,
        remoteCacheDir: rootDir,
        remoteCdnBaseUrl: "https://cdn.example.test/releases",
      },
      { log: () => undefined, logWarn: () => undefined },
    );
    vi.spyOn(
      installer as unknown as {
        tryResolveCdnReleaseDir(
          componentIds: string[],
          requiredReleasePaths?: string[],
        ): Promise<string | null>;
      },
      "tryResolveCdnReleaseDir",
    ).mockResolvedValue(cdnReleaseDir);

    await expect(
      installer.tryResolveLocalPath(["glm"], sourceRelativePath, [
        `${sourceRelativePath}/skill-creator-plugin/.zcode-plugin/plugin.json`,
      ]),
    ).resolves.toBe(join(cdnReleaseDir, sourceRelativePath));
  });

  it("bounds the internal CDN fallback with the configured manifest deadline", async () => {
    const releaseDir = await mkdtemp(join(tmpdir(), "zcode-installer-test-"));
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const installer = new LocalUploadAssetInstaller(
      new InstallerBackend(),
      {
        releaseDir,
        platformArch: "linux-x64",
        version: ZCODE_VERSION,
        remoteCacheDir: join(releaseDir, "cache"),
        remoteCdnBaseUrl: "https://cdn.example.test/releases",
        manifestRequestTimeoutMs: 25,
      },
      { log: () => undefined, logWarn: () => undefined },
    );

    const startedAt = Date.now();
    await expect(
      installer.tryResolveLocalPath(["glm"], "glm/linux-x64/missing-zcode.cjs"),
    ).resolves.toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(fetchMock).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe("RemoteDownloadAssetInstaller", () => {
  it("已取消连接不得启动远端下载或 staging 命令", async () => {
    stubManifestFetch(validManifest);
    const controller = new AbortController();
    controller.abort();
    const backend = new InstallerBackend();
    const installer = new RemoteDownloadAssetInstaller(
      backend,
      {
        version: ZCODE_VERSION,
        platformArch: "linux-x64",
        remoteCdnBaseUrls: ["https://cdn.example.test/releases"],
        signal: controller.signal,
      },
      { download: "curl", tar: "tar", sha256: "sha256sum" },
      { log: () => undefined, logWarn: () => undefined },
    );

    await expect(
      installer.installFile({
        componentId: "server-bundle",
        sourceRelativePath: "server/zcode-server.cjs",
        remotePath: "~/.zcode/server/zcode-server.cjs",
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(backend.commands).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("远端下载模式的本地 manifest 和 HEAD 使用注入网络出口", async () => {
    const remoteAssetFetch = vi.fn<typeof fetch>(
      async (_input, init) =>
        init?.method === "HEAD"
          ? new Response(null, {
              status: 200,
              headers: { "content-length": "1024" },
            })
          : new Response(JSON.stringify(validManifest), { status: 200 }),
    );
    const directFetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("remote asset direct fetch is forbidden"));
    const backend = new InstallerBackend();
    const installer = new RemoteDownloadAssetInstaller(
      backend,
      {
        version: ZCODE_VERSION,
        platformArch: "linux-x64",
        remoteCdnBaseUrls: ["https://cdn.example.test/releases"],
        remoteAssetNetwork: { fetch: remoteAssetFetch },
      },
      { download: "curl", tar: "tar", sha256: "sha256sum" },
      { log: () => undefined, logWarn: () => undefined },
    );

    try {
      await installer.installFile({
        componentId: "server-bundle",
        sourceRelativePath: "server/zcode-server.cjs",
        remotePath: "~/.zcode/server/zcode-server.cjs",
      });

      expect(directFetch).not.toHaveBeenCalled();
      expect(
        remoteAssetFetch.mock.calls.some(([, init]) => init?.method === "HEAD"),
      ).toBe(true);
      expect(
        remoteAssetFetch.mock.calls.some(([, init]) => init?.method !== "HEAD"),
      ).toBe(true);
    } finally {
      directFetch.mockRestore();
    }
  });

  it("本地 HEAD 请求迟到完成后不得启动已取消的远端下载", async () => {
    let markHeadStarted!: () => void;
    const headStarted = new Promise<void>((resolve) => {
      markHeadStarted = resolve;
    });
    let resolveHead!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "HEAD") {
          markHeadStarted();
          return await new Promise<Response>((resolve) => {
            resolveHead = resolve;
          });
        }
        return new Response(JSON.stringify(validManifest), { status: 200 });
      }),
    );
    const controller = new AbortController();
    const backend = new InstallerBackend();
    const installer = new RemoteDownloadAssetInstaller(
      backend,
      {
        version: ZCODE_VERSION,
        platformArch: "linux-x64",
        remoteCdnBaseUrls: ["https://cdn.example.test/releases"],
        signal: controller.signal,
      },
      { download: "curl", tar: "tar", sha256: "sha256sum" },
      { log: () => undefined, logWarn: () => undefined },
    );

    const installing = installer.installFile({
      componentId: "server-bundle",
      sourceRelativePath: "server/zcode-server.cjs",
      remotePath: "~/.zcode/server/zcode-server.cjs",
    });
    await headStarted;
    controller.abort();
    resolveHead(
      new Response(null, {
        status: 200,
        headers: { "content-length": "1024" },
      }),
    );

    await expect(installing).rejects.toMatchObject({ name: "AbortError" });
    expect(backend.commands).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("uses a remote lock and unique staging path when populating component cache", async () => {
    stubManifestFetch(validManifest);
    const backend = new InstallerBackend();
    const installer = new RemoteDownloadAssetInstaller(
      backend,
      {
        version: ZCODE_VERSION,
        platformArch: "linux-x64",
        remoteCdnBaseUrls: ["https://cdn.example.test/releases"],
      },
      { download: "curl", tar: "tar", sha256: "sha256sum" },
      { log: () => undefined, logWarn: () => undefined },
    );

    await installer.installFile({
      componentId: "server-bundle",
      sourceRelativePath: "server/zcode-server.cjs",
      remotePath: "~/.zcode/server/zcode-server.cjs",
    });

    const command = backend.commands.join("\n");
    expect(command).toContain(".lock");
    expect(command).toContain("while ! mkdir");
    expect(command).toContain("stat -c %Y");
    expect(command).toContain("stat -f %m");
    expect(command).toContain(
      "stale lock for server-bundle@1.0.0-server-bundle",
    );
    expect(command).toContain(
      'touch "$HOME"\'/.zcode/server/asset-cache/components/linux-x64/server-bundle/',
    );
    expect(command).toContain('kill "$lock_heartbeat_pid"');
    expect(command).toMatch(/\.new-[^\s']+/u);
    expect(command).toMatch(/zcode-server\.cjs\.new-[\w-]+/u);
    expect(command).toContain("curl -fL");
    expect(command).toContain("sha256sum");
    vi.unstubAllGlobals();
  });

  it("forwards remote stdout download progress into deploy logs", async () => {
    stubManifestFetch(validManifest);
    const backend = new InstallerBackend([
      "download progress: [server-bundle@1.0.0-server-bundle] 1.0 MB (total unknown, 0.50 MB/s)",
      "wget diagnostic noise",
    ]);
    const logs: string[] = [];
    const installer = new RemoteDownloadAssetInstaller(
      backend,
      {
        version: ZCODE_VERSION,
        platformArch: "linux-x64",
        remoteCdnBaseUrls: ["https://cdn.example.test/releases"],
      },
      { download: "curl", tar: "tar", sha256: "sha256sum" },
      {
        log: (message) => logs.push(String(message)),
        logWarn: () => undefined,
      },
    );

    await installer.installFile({
      componentId: "server-bundle",
      sourceRelativePath: "server/zcode-server.cjs",
      remotePath: "~/.zcode/server/zcode-server.cjs",
    });

    expect(logs).toContain(
      "download progress: [server-bundle@1.0.0-server-bundle] 1.0 MB (total unknown, 0.50 MB/s)",
    );
    expect(logs).not.toContain("wget diagnostic noise");
    vi.unstubAllGlobals();
  });

  it("uses artifact content length for remote download progress totals", async () => {
    stubManifestAndHeadFetch(validManifest, 2 * 1024 * 1024);
    const backend = new InstallerBackend();
    const installer = new RemoteDownloadAssetInstaller(
      backend,
      {
        version: ZCODE_VERSION,
        platformArch: "linux-x64",
        remoteCdnBaseUrls: ["https://cdn.example.test/releases"],
      },
      { download: "curl", tar: "tar", sha256: "sha256sum" },
      { log: () => undefined, logWarn: () => undefined },
    );

    await installer.installFile({
      componentId: "server-bundle",
      sourceRelativePath: "server/zcode-server.cjs",
      remotePath: "~/.zcode/server/zcode-server.cjs",
    });

    expect(backend.commands.join("\n")).toContain("total=2097152");
    vi.unstubAllGlobals();
  });

  it("uses manifest SHA for server-bundle remote cache hits", async () => {
    const semanticVersion = "1.0.0-server-bundle";
    const hashedVersion = `${semanticVersion}+aaaaaaaaaaaa`;
    stubManifestFetch({
      ...validManifest,
      components: [
        {
          ...validManifest.components[0],
          version: hashedVersion,
        },
      ],
    });
    const expectedCacheSegment = validManifest.components[0].sha256;
    const backend = new InstallerBackend(
      [],
      new Set([
        `~/.zcode/server/asset-cache/components/linux-x64/server-bundle/${expectedCacheSegment}/.ready`,
      ]),
    );
    const logs: string[] = [];
    const installer = new RemoteDownloadAssetInstaller(
      backend,
      {
        version: ZCODE_VERSION,
        platformArch: "linux-x64",
        remoteCdnBaseUrls: ["https://cdn.example.test/releases"],
      },
      { download: "curl", tar: "tar", sha256: "sha256sum" },
      {
        log: (message) => logs.push(String(message)),
        logWarn: () => undefined,
      },
    );

    await installer.installFile({
      componentId: "server-bundle",
      sourceRelativePath: "server/zcode-server.cjs",
      remotePath: "~/.zcode/server/zcode-server.cjs",
    });

    const commands = backend.commands.join("\n");
    expect(commands).not.toContain("curl -fL");
    expect(commands).toContain(
      `asset-cache/components/linux-x64/server-bundle/${expectedCacheSegment}`,
    );
    expect(logs).toContain(
      `[remote-assets] remote component cache hit: server-bundle@${hashedVersion}`,
    );
    vi.unstubAllGlobals();
  });

  it("uses manifest SHA for the glm cache while leaving the old semantic cache untouched", async () => {
    const semanticVersion = "v0.13.3";
    const hashedVersion = `${semanticVersion}+bbbbbbbbbbbb`;
    stubManifestFetch({
      ...validManifest,
      components: [
        {
          id: "glm",
          version: hashedVersion,
          sha256: "b".repeat(64),
          artifactPath: "components/linux-x64/glm/v0.13.3+bbbbbbbbbbbb.tar.gz",
          mount: "glm/linux-x64",
        },
      ],
    });
    const oldCacheSegment = hashRemoteCacheSegment(semanticVersion);
    const expectedCacheSegment = "b".repeat(64);
    const backend = new InstallerBackend(
      [],
      new Set([
        `~/.zcode/server/asset-cache/components/linux-x64/glm/${oldCacheSegment}/.ready`,
      ]),
    );
    const logs: string[] = [];
    const warnings: string[] = [];
    const installer = new RemoteDownloadAssetInstaller(
      backend,
      {
        version: ZCODE_VERSION,
        platformArch: "linux-x64",
        remoteCdnBaseUrls: ["https://cdn.example.test/releases"],
      },
      { download: "curl", tar: "tar", sha256: "sha256sum" },
      {
        log: (message) => logs.push(String(message)),
        logWarn: (message) => warnings.push(String(message)),
      },
    );

    await installer.installFile({
      componentId: "glm",
      sourceRelativePath: "glm/linux-x64/zcode.cjs",
      remotePath: "~/.zcode/server/agents/glm/zcode.cjs",
    });

    const commands = backend.commands.join("\n");
    expect(commands).toContain("curl -fL");
    expect(commands).toContain(
      `asset-cache/components/linux-x64/glm/${expectedCacheSegment}`,
    );
    expect(commands).not.toContain(
      `rm -rf "$HOME"'/.zcode/server/asset-cache/components/linux-x64/glm/${oldCacheSegment}'`,
    );
    expect(logs).not.toContain(
      `[remote-assets] remote component cache hit: glm@${hashedVersion}`,
    );
    expect(warnings).toContain(
      `[remote-assets] download required: component=glm reason=remote component cache missing path=~/.zcode/server/asset-cache/components/linux-x64/glm/${expectedCacheSegment}/.ready`,
    );
    vi.unstubAllGlobals();
  });

  it("rejects manifests that local cache validation would reject", async () => {
    stubManifestFetch({
      ...validManifest,
      components: [{ ...validManifest.components[0], sha256: "not-a-sha" }],
    });
    const installer = new RemoteDownloadAssetInstaller(
      new InstallerBackend(),
      {
        version: ZCODE_VERSION,
        platformArch: "linux-x64",
        remoteCdnBaseUrls: ["https://cdn.example.test/releases"],
      },
      { download: "curl", tar: "tar", sha256: "sha256sum" },
      { log: () => undefined, logWarn: () => undefined },
    );

    await expect(
      installer.installFile({
        componentId: "server-bundle",
        sourceRelativePath: "server/zcode-server.cjs",
        remotePath: "~/.zcode/server/zcode-server.cjs",
      }),
    ).rejects.toThrow("sha256 is invalid");
    vi.unstubAllGlobals();
  });
});
