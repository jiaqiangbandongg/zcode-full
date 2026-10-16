import { mkdtemp, mkdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import * as yauzl from "yauzl";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { electronMock, loggerMock } = vi.hoisted(() => ({
  electronMock: {
    app: {
      getVersion: vi.fn(() => "1.0.0-test"),
      isPackaged: false,
    },
    dialog: {
      showMessageBox: vi.fn(),
    },
    nativeImage: {
      createFromPath: vi.fn(() => ({
        isEmpty: () => false,
      })),
    },
    shell: {
      showItemInFolder: vi.fn(),
    },
  },
  loggerMock: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("electron", () => ({
  ...electronMock,
}));

vi.mock("../src/main/logger.js", () => ({
  logger: loggerMock,
}));

async function withTempDir(run: (tempDir: string) => Promise<void>): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), "export-logs-test-"));
  try {
    await run(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function createExportLogTestDirs(tempDir: string) {
  return {
    getExportLogStageDir: () => join(tempDir, "export-log-stage"),
    getExportLogDir: () => join(tempDir, "export-log"),
  };
}

function createWriteZipTestOptions(tempDir: string) {
  return {
    stageRootDir: join(tempDir, "export-log-stage"),
  };
}

async function readZipEntries(zipPath: string): Promise<Map<string, string>> {
  return await new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (error, zipFile) => {
      if (error || !zipFile) {
        reject(error ?? new Error("failed to open zip"));
        return;
      }

      const entries = new Map<string, string>();
      zipFile.readEntry();

      zipFile.on("entry", (entry) => {
        zipFile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            zipFile.close();
            reject(streamError ?? new Error("failed to open zip entry stream"));
            return;
          }

          const chunks: Buffer[] = [];
          stream.on("data", (chunk) =>
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
          );
          stream.on("error", (readError) => {
            zipFile.close();
            reject(readError);
          });
          stream.on("end", () => {
            entries.set(entry.fileName, Buffer.concat(chunks).toString("utf-8"));
            zipFile.readEntry();
          });
        });
      });

      zipFile.on("end", () => {
        zipFile.close();
        resolve(entries);
      });
      zipFile.on("error", reject);
    });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("export logs archive", () => {
  // Bugfix: pre-push 全量测试并发时 zip I/O 可能超过 Vitest 默认超时。
  // 这里给纯 Node zip 用例统一留出余量，避免功能正常但被机器负载误判失败。
  it("纯 Node zip 应排除顶层 agent-config 与 certs 并保留其他来源的同名嵌套目录", async () => {
    const { collectLogArchiveFiles, writeLogArchiveZip } =
      await import("@desktop/main/exportLogs.js");

    await withTempDir(async (tempDir) => {
      const sourceDir = join(tempDir, "source");
      await mkdir(join(sourceDir, "logs", "agent-config"), { recursive: true });
      await mkdir(join(sourceDir, "logs", "certs"), { recursive: true });
      await mkdir(join(sourceDir, "agent-config", "codex", "workspace-a"), {
        recursive: true,
      });
      await mkdir(join(sourceDir, "certs"), {
        recursive: true,
      });
      await writeFile(join(sourceDir, "logs", "main.log"), "main-log", "utf-8");
      await writeFile(
        join(sourceDir, "logs", "agent-config", "trace.log"),
        "nested-agent-config-log",
        "utf-8",
      );
      await writeFile(join(sourceDir, "logs", "certs", "trace.log"), "nested-certs-log", "utf-8");
      await writeFile(
        join(sourceDir, "agent-config", "codex", "workspace-a", "config.toml"),
        "agent-config-state",
        "utf-8",
      );
      await writeFile(join(sourceDir, "certs", "app-ca.pem"), "certificate-state", "utf-8");

      const zipPath = join(tempDir, "logs.zip");
      const files = await collectLogArchiveFiles(sourceDir);
      await writeLogArchiveZip(
        zipPath,
        {
          files,
          aboutContent: "about-contents",
        },
        createWriteZipTestOptions(tempDir),
      );

      const entries = await readZipEntries(zipPath);
      expect(entries.get("about.txt")).toBe("about-contents");
      expect(entries.get("logs/main.log")).toBe("main-log");
      expect(entries.get("logs/agent-config/trace.log")).toBe("nested-agent-config-log");
      expect(entries.get("logs/certs/trace.log")).toBe("nested-certs-log");
      expect(entries.has("agent-config/codex/workspace-a/config.toml")).toBe(false);
      expect(entries.has("certs/app-ca.pem")).toBe(false);
    });
  }, 30_000);

  it("导出日志应排除系统缓存目录", async () => {
    const { collectLogArchiveFiles } = await import("@desktop/main/exportLogs.js");

    await withTempDir(async (tempDir) => {
      const sourceDir = join(tempDir, "source");
      await mkdir(join(sourceDir, "logs"), { recursive: true });
      await mkdir(join(sourceDir, "Library", "Caches", "bun"), {
        recursive: true,
      });

      await writeFile(join(sourceDir, "logs", "main.log"), "main-log", "utf-8");
      await writeFile(
        join(sourceDir, "Library", "Caches", "bun", "cache.pile"),
        "bun-cache",
        "utf-8",
      );

      const archivePaths = (await collectLogArchiveFiles(sourceDir)).map(
        (file) => file.archivePath,
      );

      expect(archivePaths).toContain("logs/main.log");
      expect(archivePaths).not.toContain("Library/Caches/bun/cache.pile");
    });
  });

  it("导出日志应排除 docshot 相关目录", async () => {
    const { collectLogArchiveFiles } = await import("@desktop/main/exportLogs.js");

    await withTempDir(async (tempDir) => {
      const sourceDir = join(tempDir, "source");
      await mkdir(join(sourceDir, "logs"), { recursive: true });
      await mkdir(
        join(
          sourceDir,
          "docshot-backup-20260609-122121",
          "repo-snapshots",
          "workspace-a",
          "pending",
        ),
        { recursive: true },
      );
      await mkdir(join(sourceDir, "docshot-assets"), { recursive: true });

      await writeFile(join(sourceDir, "logs", "main.log"), "main-log", "utf-8");
      await writeFile(
        join(
          sourceDir,
          "docshot-backup-20260609-122121",
          "repo-snapshots",
          "workspace-a",
          "pending",
          "snapshot.tar.gz.enc",
        ),
        "large-encrypted-snapshot",
        "utf-8",
      );
      await writeFile(join(sourceDir, "docshot-assets", "preview.png"), "asset", "utf-8");

      const archivePaths = (await collectLogArchiveFiles(sourceDir)).map(
        (file) => file.archivePath,
      );

      expect(archivePaths).toContain("logs/main.log");
      expect(archivePaths).not.toContain(
        "docshot-backup-20260609-122121/repo-snapshots/workspace-a/pending/snapshot.tar.gz.enc",
      );
      expect(archivePaths).not.toContain("docshot-assets/preview.png");
    });
  });

  it("导出日志应排除退役 Repo 功能的历史数据目录", async () => {
    const { collectLogArchiveFiles } = await import("@desktop/main/exportLogs.js");

    await withTempDir(async (tempDir) => {
      const sourceDir = join(tempDir, "source");
      await mkdir(join(sourceDir, "logs"), { recursive: true });
      await mkdir(join(sourceDir, "repo-snapshots", "workspace-a", "pending"), {
        recursive: true,
      });
      await mkdir(join(sourceDir, "repo-wiki", "workspace-a"), { recursive: true });

      await writeFile(join(sourceDir, "logs", "main.log"), "main-log", "utf-8");
      await writeFile(
        join(sourceDir, "repo-snapshots", "workspace-a", "pending", "snapshot.tar.gz.enc"),
        "large-encrypted-snapshot",
        "utf-8",
      );
      await writeFile(
        join(sourceDir, "repo-wiki", "workspace-a", "wiki.json"),
        '{"node":"retired-wiki-body"}',
        "utf-8",
      );

      const archivePaths = (await collectLogArchiveFiles(sourceDir)).map(
        (file) => file.archivePath,
      );

      expect(archivePaths).toContain("logs/main.log");
      expect(archivePaths).not.toContain("repo-snapshots/workspace-a/pending/snapshot.tar.gz.enc");
      expect(archivePaths).not.toContain("repo-wiki/workspace-a/wiki.json");
    });
  });

  it("导出日志应跳过退役 ACP 运行时目录", async () => {
    const { collectLogArchiveFiles } = await import("@desktop/main/exportLogs.js");

    await withTempDir(async (tempDir) => {
      const sourceDir = join(tempDir, "source");
      await mkdir(join(sourceDir, "logs"), { recursive: true });
      await mkdir(join(sourceDir, "agent-config", "codex", "workspace-a"), {
        recursive: true,
      });
      await mkdir(join(sourceDir, "acp-traffic-proxy", "captures"), { recursive: true });
      await mkdir(join(sourceDir, "acp-config", "codex", "workspace-a"), {
        recursive: true,
      });
      await mkdir(join(sourceDir, "acp-auth"), { recursive: true });
      await mkdir(join(sourceDir, "acp-stream-diagnostics"), {
        recursive: true,
      });
      await mkdir(join(sourceDir, "dev", "stdio-traffic", "workspace-a"), {
        recursive: true,
      });

      await writeFile(join(sourceDir, "logs", "main.log"), "main-log", "utf-8");
      await writeFile(
        join(sourceDir, "agent-config", "codex", "workspace-a", "config.toml"),
        "current-agent-config",
        "utf-8",
      );
      await writeFile(
        join(sourceDir, "acp-traffic-proxy", "captures", "traffic-2026-05-28T13-49-54.717Z.ndjson"),
        "legacy-traffic-capture",
        "utf-8",
      );
      await writeFile(
        join(sourceDir, "acp-traffic-proxy", "root-ca-key.pem"),
        "legacy-root-key",
        "utf-8",
      );
      await writeFile(
        join(sourceDir, "acp-config", "codex", "workspace-a", "logs_2.sqlite"),
        "legacy-provider-log",
        "utf-8",
      );
      await writeFile(join(sourceDir, "acp-auth", "token.json"), '{"token":"legacy"}', "utf-8");
      await writeFile(
        join(sourceDir, "acp-stream-diagnostics", "stream.jsonl"),
        "legacy-stream-diagnostics",
        "utf-8",
      );
      await writeFile(
        join(sourceDir, "dev", "stdio-traffic", "workspace-a", "traffic.ndjson"),
        "high-volume-protocol-stream",
        "utf-8",
      );

      const archivePaths = (await collectLogArchiveFiles(sourceDir)).map(
        (file) => file.archivePath,
      );

      expect(archivePaths).toContain("logs/main.log");
      expect(archivePaths).not.toContain("agent-config/codex/workspace-a/config.toml");
      expect(archivePaths).not.toContain(
        "acp-traffic-proxy/captures/traffic-2026-05-28T13-49-54.717Z.ndjson",
      );
      expect(archivePaths).not.toContain("acp-traffic-proxy/root-ca-key.pem");
      expect(archivePaths).not.toContain("acp-config/codex/workspace-a/logs_2.sqlite");
      expect(archivePaths).not.toContain("acp-auth/token.json");
      expect(archivePaths).not.toContain("acp-stream-diagnostics/stream.jsonl");
      expect(archivePaths).not.toContain("dev/stdio-traffic/workspace-a/traffic.ndjson");
    });
  });

  it("导出日志应排除凭据存储文件", async () => {
    const { collectLogArchiveFiles, writeLogArchiveZip } =
      await import("@desktop/main/exportLogs.js");

    await withTempDir(async (tempDir) => {
      const sourceDir = join(tempDir, "source");
      await mkdir(join(sourceDir, "logs"), { recursive: true });
      await mkdir(join(sourceDir, "runtime-state", "claude", "workspace-a"), {
        recursive: true,
      });

      await writeFile(join(sourceDir, "logs", "main.log"), "main-log", "utf-8");
      await writeFile(
        join(sourceDir, "credentials.json"),
        '{"oauth:zai:access_token":"root-secret"}',
        "utf-8",
      );
      await writeFile(
        join(sourceDir, "runtime-state", "claude", "workspace-a", "credentials.json"),
        '{"token":"nested-secret"}',
        "utf-8",
      );
      await writeFile(
        join(sourceDir, "runtime-state", "claude", "workspace-a", ".credentials.json"),
        '{"token":"hidden-secret"}',
        "utf-8",
      );

      const files = await collectLogArchiveFiles(sourceDir);
      const archivePaths = files.map((file) => file.archivePath);
      const zipPath = join(tempDir, "logs-without-credentials.zip");
      await writeLogArchiveZip(
        zipPath,
        {
          files,
          aboutContent: "about-contents",
        },
        createWriteZipTestOptions(tempDir),
      );

      expect(archivePaths).toContain("logs/main.log");
      expect(archivePaths).not.toContain("credentials.json");
      expect(archivePaths).not.toContain("runtime-state/claude/workspace-a/credentials.json");
      expect(archivePaths).not.toContain("runtime-state/claude/workspace-a/.credentials.json");

      const entries = await readZipEntries(zipPath);
      expect(entries.get("logs/main.log")).toBe("main-log");
      expect(entries.has("credentials.json")).toBe(false);
      expect(entries.has("runtime-state/claude/workspace-a/credentials.json")).toBe(false);
      expect(entries.has("runtime-state/claude/workspace-a/.credentials.json")).toBe(false);
    });
  });

  it("导出日志时应额外带上 zcode-cli 用户日志", async () => {
    const originalHome = process.env["HOME"];
    try {
      await withTempDir(async (tempDir) => {
        const fakeHome = join(tempDir, "home");
        process.env["HOME"] = fakeHome;
        vi.resetModules();

        const { createLogArchiveArtifacts, writeLogArchiveZip } =
          await import("@desktop/main/exportLogs.js");

        const sourceDir = join(tempDir, "source");
        const zcodeCliLogDir = join(fakeHome, ".zcode", "cli", "log");
        await mkdir(join(sourceDir, "logs"), { recursive: true });
        await mkdir(zcodeCliLogDir, { recursive: true });
        await writeFile(join(sourceDir, "logs", "main.log"), "main-log", "utf-8");
        await writeFile(join(zcodeCliLogDir, "agent.log"), "zcode-cli-agent-log", "utf-8");

        const artifacts = await createLogArchiveArtifacts(sourceDir);
        const zipPath = join(tempDir, "logs-with-external-agents.zip");
        await writeLogArchiveZip(zipPath, artifacts, createWriteZipTestOptions(tempDir));

        const entries = await readZipEntries(zipPath);
        expect(entries.get("logs/main.log")).toBe("main-log");
        expect(entries.get(".zcode/cli/log/agent.log")).toBe("zcode-cli-agent-log");
      });
    } finally {
      if (originalHome == null) {
        delete process.env["HOME"];
      } else {
        process.env["HOME"] = originalHome;
      }
      vi.resetModules();
    }
  });

  it("导出日志应带上 zcode-cli 的 config.json、rollout 且排除 debug 目录", async () => {
    const originalHome = process.env["HOME"];
    try {
      await withTempDir(async (tempDir) => {
        const fakeHome = join(tempDir, "home");
        process.env["HOME"] = fakeHome;
        vi.resetModules();

        const { createLogArchiveArtifacts, writeLogArchiveZip } =
          await import("@desktop/main/exportLogs.js");

        const sourceDir = join(tempDir, "source");
        const zcodeCliDir = join(fakeHome, ".zcode", "cli");
        const rolloutDir = join(zcodeCliDir, "rollout");
        const debugDir = join(zcodeCliDir, "debug");
        await mkdir(join(sourceDir, "logs"), { recursive: true });
        await mkdir(rolloutDir, { recursive: true });
        await mkdir(debugDir, { recursive: true });
        await writeFile(join(zcodeCliDir, "config.json"), '{"model":"glm"}', "utf-8");
        await writeFile(join(rolloutDir, "model-io-recent.jsonl"), "rollout-recent", "utf-8");
        await writeFile(join(debugDir, "model-io-old.jsonl"), "debug-old", "utf-8");
        // 故意把 rollout 文件改成远超 3 天窗口的旧时间，验证 rollout 不参与时间过滤。
        const longAgo = new Date("2026-01-01T00:00:00Z");
        await utimes(join(rolloutDir, "model-io-recent.jsonl"), longAgo, longAgo);
        await utimes(join(debugDir, "model-io-old.jsonl"), longAgo, longAgo);

        const artifacts = await createLogArchiveArtifacts(sourceDir);
        const zipPath = join(tempDir, "logs-with-cli-extras.zip");
        await writeLogArchiveZip(zipPath, artifacts, createWriteZipTestOptions(tempDir));

        const entries = await readZipEntries(zipPath);
        expect(entries.get(".zcode/cli/config.json")).toBe('{"model":"glm"}');
        expect(entries.get(".zcode/cli/rollout/model-io-recent.jsonl")).toBe("rollout-recent");
        expect(entries.has(".zcode/cli/debug/model-io-old.jsonl")).toBe(false);
      });
    } finally {
      if (originalHome == null) {
        delete process.env["HOME"];
      } else {
        process.env["HOME"] = originalHome;
      }
      vi.resetModules();
    }
  });

  it("导出日志应带上 Computer Use Helper 诊断日志但绝不带 .tokens 凭据", async () => {
    // Bugfix 取证：一次真实反馈日志包里 grep "background keyboard begin rejected" 命中 0，
    // 而那次会话 begin 确实被拒两次 —— Helper 的结构化诊断写在
    // ~/.zcode/computer-use/run/*.sock.exit.log，既不在 app data 也不在 ~/.zcode/cli 下。
    const originalHome = process.env["HOME"];
    try {
      await withTempDir(async (tempDir) => {
        const fakeHome = join(tempDir, "home");
        process.env["HOME"] = fakeHome;
        vi.resetModules();

        const { createLogArchiveArtifacts, writeLogArchiveZip } =
          await import("@desktop/main/exportLogs.js");

        const sourceDir = join(tempDir, "source");
        const runDir = join(fakeHome, ".zcode", "computer-use", "run");
        const tokenDir = join(runDir, ".tokens");
        await mkdir(join(sourceDir, "logs"), { recursive: true });
        await mkdir(tokenDir, { recursive: true });
        await writeFile(
          join(runDir, "standalone-abc123.sock.exit.log"),
          '{"scope":"zcode-cua-helper","level":"warn","event":"macOS background keyboard begin rejected"}',
          "utf-8",
        );
        // 同目录下的 broker 凭据：反馈包会被用户转发出去，绝不能带。
        await writeFile(join(tokenDir, "broker.token"), "super-secret-token", "utf-8");
        // 非诊断文件不做兜底收集，避免以后目录里多出什么就跟着漏出去。
        await writeFile(join(runDir, "standalone-abc123.sock"), "not-a-log", "utf-8");
        // Helper 崩溃后可能隔很久才来反馈：诊断日志不该被近 3 天窗口筛掉。
        const longAgo = new Date("2026-01-01T00:00:00Z");
        await utimes(join(runDir, "standalone-abc123.sock.exit.log"), longAgo, longAgo);

        const artifacts = await createLogArchiveArtifacts(sourceDir);
        const zipPath = join(tempDir, "logs-with-helper-diagnostics.zip");
        await writeLogArchiveZip(zipPath, artifacts, createWriteZipTestOptions(tempDir));

        const entries = await readZipEntries(zipPath);
        expect(entries.get(".zcode/computer-use/run/standalone-abc123.sock.exit.log")).toContain(
          "begin rejected",
        );
        expect(entries.has(".zcode/computer-use/run/.tokens/broker.token")).toBe(false);
        expect(entries.has(".zcode/computer-use/run/standalone-abc123.sock")).toBe(false);
        // 防呆：凭据内容不得以任何路径出现在包里。
        expect([...entries.values()].join("\n")).not.toContain("super-secret-token");
      });
    } finally {
      if (originalHome == null) {
        delete process.env["HOME"];
      } else {
        process.env["HOME"] = originalHome;
      }
      vi.resetModules();
    }
  });

  it("反馈后台日志应只收集诊断日志并写入反馈临时目录", async () => {
    const originalHome = process.env["HOME"];
    try {
      await withTempDir(async (tempDir) => {
        const fakeHome = join(tempDir, "home");
        process.env["HOME"] = fakeHome;
        vi.resetModules();

        const { createFeedbackLogArchiveFromExportLogs } =
          await import("@desktop/main/exportLogs.js");

        const sourceDir = join(tempDir, "source");
        const feedbackLogDir = join(tempDir, "feedback-logs");
        const zcodeCliDir = join(fakeHome, ".zcode", "cli");
        await mkdir(join(sourceDir, "logs"), { recursive: true });
        await mkdir(join(sourceDir, "agent-config", "codex", "workspace-a"), {
          recursive: true,
        });
        await mkdir(join(sourceDir, "certs"), { recursive: true });
        await mkdir(join(zcodeCliDir, "log"), { recursive: true });
        await mkdir(join(zcodeCliDir, "rollout"), { recursive: true });
        await mkdir(join(zcodeCliDir, "debug"), { recursive: true });

        await writeFile(join(sourceDir, "logs", "main.log"), "main-log", "utf-8");
        await writeFile(join(sourceDir, "credentials.json"), '{"token":"app-secret"}', "utf-8");
        await writeFile(
          join(sourceDir, "agent-config", "codex", "workspace-a", "config.toml"),
          "agent-config-state",
          "utf-8",
        );
        await writeFile(join(sourceDir, "certs", "app-ca.pem"), "certificate-state", "utf-8");
        await writeFile(join(zcodeCliDir, "log", "agent.log"), "agent-log", "utf-8");
        await writeFile(
          join(zcodeCliDir, "config.json"),
          JSON.stringify({
            model: "glm",
            apiKey: "config-secret",
            plugins: {
              enabledPlugins: { "example-plugin@example": true },
              options: {
                "example-plugin@example": { license: "plugin-secret", region: "us-east" },
              },
            },
            ui: { locale: "zh-CN", theme: "dark" },
          }),
          "utf-8",
        );
        await writeFile(join(zcodeCliDir, "rollout", "trace.jsonl"), "rollout-today", "utf-8");
        await writeFile(join(zcodeCliDir, "rollout", "old-trace.jsonl"), "rollout-old", "utf-8");
        await writeFile(join(zcodeCliDir, "debug", "trace.jsonl"), "debug", "utf-8");

        const progressEvents: Array<{ processedBytes: number; totalBytes: number }> = [];
        const feedbackDate = new Date("2026-06-15T01:02:03");
        await utimes(join(sourceDir, "logs", "main.log"), feedbackDate, feedbackDate);
        await utimes(join(zcodeCliDir, "log", "agent.log"), feedbackDate, feedbackDate);
        await utimes(join(zcodeCliDir, "rollout", "trace.jsonl"), feedbackDate, feedbackDate);
        const oldRolloutDate = new Date("2026-06-14T23:59:59");
        await utimes(
          join(zcodeCliDir, "rollout", "old-trace.jsonl"),
          oldRolloutDate,
          oldRolloutDate,
        );
        const archive = await createFeedbackLogArchiveFromExportLogs(sourceDir, {
          now: () => feedbackDate,
          outputRootDir: feedbackLogDir,
          stageRootDir: join(tempDir, "stage"),
          onProgress: (event) => progressEvents.push(event),
        });

        expect(archive.path.startsWith(feedbackLogDir)).toBe(true);
        expect(archive.path.endsWith(".zip")).toBe(true);
        expect(archive.size).toBeGreaterThan(0);
        expect(progressEvents.at(-1)).toEqual({
          processedBytes: archive.size,
          totalBytes: archive.size,
        });

        const entries = await readZipEntries(archive.path);
        expect(entries.get("logs/main.log")).toBe("main-log");
        expect(entries.has("credentials.json")).toBe(false);
        expect(entries.has("agent-config/codex/workspace-a/config.toml")).toBe(false);
        expect(entries.has("certs/app-ca.pem")).toBe(false);
        expect(entries.get(".zcode/cli/log/agent.log")).toBe("agent-log");
        const configEntry = entries.get(".zcode/cli/config.json");
        expect(configEntry).toContain('"model":"glm"');
        expect(configEntry).toContain('"enabledPlugins"');
        expect(configEntry).toContain('"example-plugin@example":true');
        expect(configEntry).not.toContain("config-secret");
        expect(configEntry).not.toContain("plugin-secret");
        expect(configEntry).not.toContain('"options"');
        expect(configEntry).toContain('"locale":"zh-CN"');
        expect(entries.get(".zcode/cli/rollout/trace.jsonl")).toBe("rollout-today");
        expect(entries.has(".zcode/cli/rollout/old-trace.jsonl")).toBe(false);
        expect(entries.has(".zcode/cli/debug/trace.jsonl")).toBe(false);
      });
    } finally {
      if (originalHome == null) {
        delete process.env["HOME"];
      } else {
        process.env["HOME"] = originalHome;
      }
      vi.resetModules();
    }
  });

  it("导出日志应只对日志类目录应用近 3 天窗口并跳过旧 session 状态目录", async () => {
    const originalHome = process.env["HOME"];
    try {
      await withTempDir(async (tempDir) => {
        const fakeHome = join(tempDir, "home");
        process.env["HOME"] = fakeHome;
        vi.resetModules();

        const { createLogArchiveArtifacts } = await import("@desktop/main/exportLogs.js");

        const sourceDir = join(tempDir, "source");
        const recentTime = new Date("2026-05-28T12:00:00Z");
        const oldTime = new Date("2026-05-20T12:00:00Z");

        const writeTimedFile = async (absolutePath: string, content: string, mtime: Date) => {
          await mkdir(dirname(absolutePath), { recursive: true });
          await writeFile(absolutePath, content, "utf-8");
          await utimes(absolutePath, mtime, mtime);
        };

        await writeTimedFile(join(sourceDir, "logs", "recent.log"), "recent-app-log", recentTime);
        await writeTimedFile(join(sourceDir, "logs", "old.log"), "old-app-log", oldTime);
        await writeTimedFile(
          join(sourceDir, "sessions", "recent.json"),
          "recent-session",
          recentTime,
        );
        await writeTimedFile(join(sourceDir, "sessions", "old.json"), "old-session", oldTime);
        await writeTimedFile(
          join(sourceDir, "agent-config", "claude", "workspace-a", "debug", "recent.txt"),
          "recent-claude-debug",
          recentTime,
        );
        await writeTimedFile(
          join(sourceDir, "agent-config", "claude", "workspace-a", "debug", "old.txt"),
          "old-claude-debug",
          oldTime,
        );
        await writeTimedFile(
          join(sourceDir, "agent-config", "codex", "workspace-a", "sessions", "recent.jsonl"),
          "recent-codex-session",
          recentTime,
        );
        await writeTimedFile(
          join(sourceDir, "agent-config", "codex", "workspace-a", "sessions", "old.jsonl"),
          "old-codex-session",
          oldTime,
        );
        await writeTimedFile(
          join(fakeHome, ".zcode", "cli", "log", "recent.log"),
          "recent-zcode-cli-log",
          recentTime,
        );
        await writeTimedFile(
          join(fakeHome, ".zcode", "cli", "log", "old.log"),
          "old-zcode-cli-log",
          oldTime,
        );

        const artifacts = await createLogArchiveArtifacts(sourceDir, {
          now: () => new Date("2026-05-29T12:00:00Z"),
        });
        const archivePaths = artifacts.files.map((file) => file.archivePath);

        expect(archivePaths).toEqual(
          expect.arrayContaining(["logs/recent.log", ".zcode/cli/log/recent.log"]),
        );
        expect(archivePaths).not.toContain("logs/old.log");
        expect(archivePaths).not.toContain("agent-config/codex/workspace-a/sessions/recent.jsonl");
        expect(archivePaths).not.toContain("agent-config/codex/workspace-a/sessions/old.jsonl");
        expect(archivePaths).not.toContain("agent-config/claude/workspace-a/debug/recent.txt");
        expect(archivePaths).not.toContain("agent-config/claude/workspace-a/debug/old.txt");
        expect(archivePaths).not.toContain("sessions/recent.json");
        expect(archivePaths).not.toContain("sessions/old.json");
        expect(archivePaths).not.toContain(".zcode/cli/log/old.log");
      });
    } finally {
      if (originalHome == null) {
        delete process.env["HOME"];
      } else {
        process.env["HOME"] = originalHome;
      }
      vi.resetModules();
    }
  });

  it("导出日志应保留旧顶层配置并跳过 agent-config、旧绑定和 checkpoint 状态", async () => {
    const originalHome = process.env["HOME"];
    try {
      await withTempDir(async (tempDir) => {
        const fakeHome = join(tempDir, "home");
        process.env["HOME"] = fakeHome;
        vi.resetModules();

        const { createLogArchiveArtifacts } = await import("@desktop/main/exportLogs.js");

        const sourceDir = join(tempDir, "source");
        const oldTime = new Date("2026-05-20T12:00:00Z");
        const writeOldFile = async (absolutePath: string, content: string) => {
          await mkdir(dirname(absolutePath), { recursive: true });
          await writeFile(absolutePath, content, "utf-8");
          await utimes(absolutePath, oldTime, oldTime);
        };

        await writeOldFile(join(sourceDir, ".claude.json"), '{"theme":"dark"}');
        await writeOldFile(
          join(sourceDir, "agent-config", "claude", "workspace-a", "settings.json"),
          '{"ANTHROPIC_AUTH_TOKEN":"secret"}',
        );
        await writeOldFile(
          join(sourceDir, "session-bindings", "workspace-a", "binding.json"),
          '{"sessionId":"old-but-useful"}',
        );
        await writeOldFile(
          join(sourceDir, "checkpoints", "workspace-a", "checkpoint.json"),
          '{"checkpointId":"old-but-not-log"}',
        );
        const artifacts = await createLogArchiveArtifacts(sourceDir, {
          now: () => new Date("2026-05-29T12:00:00Z"),
        });
        const archivePaths = artifacts.files.map((file) => file.archivePath);

        expect(archivePaths).toContain(".claude.json");
        expect(archivePaths).not.toContain("agent-config/claude/workspace-a/settings.json");
        expect(archivePaths).not.toContain("session-bindings/workspace-a/binding.json");
        expect(archivePaths).not.toContain("checkpoints/workspace-a/checkpoint.json");
      });
    } finally {
      if (originalHome == null) {
        delete process.env["HOME"];
      } else {
        process.env["HOME"] = originalHome;
      }
      vi.resetModules();
    }
  });

  it("目录导出应复制文件并写入 about.txt", async () => {
    const { writeLogArchiveDirectory } = await import("@desktop/main/exportLogs.js");

    await withTempDir(async (tempDir) => {
      const sourceDir = join(tempDir, "source");
      const sourceFile = join(sourceDir, "logs", "nested.log");
      await mkdir(join(sourceDir, "logs"), { recursive: true });
      await writeFile(sourceFile, "nested-log", "utf-8");

      const outputDir = join(tempDir, "logs-dir");
      await writeLogArchiveDirectory(outputDir, {
        files: [{ absolutePath: sourceFile, archivePath: "logs/nested.log" }],
        aboutContent: "about-directory",
      });

      expect(await readFile(join(outputDir, "logs", "nested.log"), "utf-8")).toBe("nested-log");
      expect(await readFile(join(outputDir, "about.txt"), "utf-8")).toBe("about-directory");
    });
  });

  it("目录导出应脱敏敏感字段且保留原始结构", async () => {
    const { writeLogArchiveDirectory } = await import("@desktop/main/exportLogs.js");

    await withTempDir(async (tempDir) => {
      const sourceDir = join(tempDir, "source");
      const sourceFile = join(sourceDir, "logs", "sensitive.log");
      await mkdir(join(sourceDir, "logs"), { recursive: true });
      await writeFile(
        sourceFile,
        [
          '{"apiKey":"abc-123","OPENAI_API_KEY":"sk-openai","access_token":"token-a","refresh_token":"token-b"}',
          "Authorization: Bearer top-secret",
          "x-api-key: plain-secret",
          "cookie: session=abc",
          "OPENAI_API_KEY=sk-inline",
          "https://example.com/v1/models?key=inline-key&foo=bar",
        ].join("\n"),
        "utf-8",
      );

      const outputDir = join(tempDir, "logs-dir");
      await writeLogArchiveDirectory(outputDir, {
        files: [{ absolutePath: sourceFile, archivePath: "logs/sensitive.log" }],
        aboutContent: "about-directory",
      });

      const exported = await readFile(join(outputDir, "logs", "sensitive.log"), "utf-8");
      expect(exported).toContain('"apiKey":"***REDACTED***"');
      expect(exported).toContain('"OPENAI_API_KEY":"***REDACTED***"');
      expect(exported).toContain('"access_token":"***REDACTED***"');
      expect(exported).toContain('"refresh_token":"***REDACTED***"');
      expect(exported).toContain("Authorization: Bearer ***REDACTED***");
      expect(exported).toContain("x-api-key: ***REDACTED***");
      expect(exported).toContain("cookie: ***REDACTED***");
      expect(exported).toContain("OPENAI_API_KEY=***REDACTED***");
      expect(exported).toContain("https://example.com/v1/models?key=***REDACTED***&foo=bar");
      expect(exported).not.toContain("abc-123");
      expect(exported).not.toContain("top-secret");
      expect(exported).not.toContain("plain-secret");
      expect(exported).not.toContain("session=abc");
      expect(exported).not.toContain("inline-key");
    });
  });

  it("目录导出应脱敏数据库连接串与自定义敏感命名，但保留计数和预算字段", async () => {
    const { writeLogArchiveDirectory } = await import("@desktop/main/exportLogs.js");

    await withTempDir(async (tempDir) => {
      const sourceDir = join(tempDir, "source");
      const sourceFile = join(sourceDir, "logs", "db.log");
      await mkdir(join(sourceDir, "logs"), { recursive: true });
      await writeFile(
        sourceFile,
        [
          "postgres://admin:P@sszero@10.0.0.5:5432/prod",
          "mongodb://svc:m0ngoPwd@db.internal:27017/app",
          "redis://:nakedRedisPwd@cache:6379/0",
          "DATABASE_URL=mysql://root:rootPwd@127.0.0.1:3306/main",
          '{"db_password":"custom-db-pass","conn_string":"redis://:redisPwd@cache:6379"}',
          '{"my_secret":"leaked-value","prompt_tokens":1234,"completion_tokens":56,"max_tokens":64000,"thinking":{"type":"enabled","budget_tokens":32000}}',
          '{"sourceCount":18,"returnedCount":16,"importedCount":16,"skippedCount":2,"failedCount":0}',
          '{"access_tokens":"plural-access-secret","refresh_tokens":"plural-refresh-secret","session_tokens":"plural-session-secret"}',
          "?client_secret=oauth-secret&foo=bar",
        ].join("\n"),
        "utf-8",
      );

      const outputDir = join(tempDir, "logs-dir");
      await writeLogArchiveDirectory(outputDir, {
        files: [{ absolutePath: sourceFile, archivePath: "logs/db.log" }],
        aboutContent: "about-directory",
      });

      const exported = await readFile(join(outputDir, "logs", "db.log"), "utf-8");
      // 连接串：保留 scheme 与 host，脱掉 user:pass
      expect(exported).toContain("postgres://***REDACTED***:***REDACTED***@10.0.0.5:5432/prod");
      expect(exported).toContain("mongodb://***REDACTED***:***REDACTED***@db.internal:27017/app");
      expect(exported).toContain("redis://***REDACTED***:***REDACTED***@cache:6379/0");
      expect(exported).toContain("DATABASE_URL=***REDACTED***");
      expect(exported).toContain('"db_password":"***REDACTED***"');
      expect(exported).toContain('"conn_string":"***REDACTED***"');
      expect(exported).toContain('"my_secret":"***REDACTED***"');
      expect(exported).toContain('"access_tokens":"***REDACTED***"');
      expect(exported).toContain('"refresh_tokens":"***REDACTED***"');
      expect(exported).toContain('"session_tokens":"***REDACTED***"');
      expect(exported).toContain("?client_secret=***REDACTED***&foo=bar");
      // 计数/预算字段（含 token 子串）必须保留，避免脱掉排障需要的上下文
      expect(exported).toContain('"prompt_tokens":1234');
      expect(exported).toContain('"completion_tokens":56');
      expect(exported).toContain('"max_tokens":64000');
      expect(exported).toContain('"budget_tokens":32000');
      expect(exported).toContain(
        '{"sourceCount":18,"returnedCount":16,"importedCount":16,"skippedCount":2,"failedCount":0}',
      );
      // 原始密钥/口令不得出现
      expect(exported).not.toContain("P@sszero");
      expect(exported).not.toContain("sszero");
      expect(exported).not.toContain("m0ngoPwd");
      expect(exported).not.toContain("nakedRedisPwd");
      expect(exported).not.toContain("rootPwd");
      expect(exported).not.toContain("custom-db-pass");
      expect(exported).not.toContain("redisPwd");
      expect(exported).not.toContain("leaked-value");
      expect(exported).not.toContain("plural-access-secret");
      expect(exported).not.toContain("plural-refresh-secret");
      expect(exported).not.toContain("plural-session-secret");
      expect(exported).not.toContain("oauth-secret");
    });
  });

  it("目录导出应识别 UTF-16 文本并脱敏敏感字段", async () => {
    const { writeLogArchiveDirectory } = await import("@desktop/main/exportLogs.js");

    await withTempDir(async (tempDir) => {
      const sourceDir = join(tempDir, "source");
      const sourceFile = join(sourceDir, "logs", "sensitive-utf16.log");
      await mkdir(join(sourceDir, "logs"), { recursive: true });
      await writeFile(
        sourceFile,
        [
          "OPENAI_API_KEY=sk-utf16",
          "Authorization: Bearer utf16-token",
          '{"access_token":"utf16-access"}',
        ].join("\r\n"),
        "utf16le",
      );

      const outputDir = join(tempDir, "logs-dir");
      await writeLogArchiveDirectory(outputDir, {
        files: [
          {
            absolutePath: sourceFile,
            archivePath: "logs/sensitive-utf16.log",
          },
        ],
        aboutContent: "about-directory",
      });

      const exportedBuffer = await readFile(join(outputDir, "logs", "sensitive-utf16.log"));
      const exported = exportedBuffer.toString("utf16le");
      expect(exported).toContain("OPENAI_API_KEY=***REDACTED***");
      expect(exported).toContain("Authorization: Bearer ***REDACTED***");
      expect(exported).toContain('"access_token":"***REDACTED***"');
      expect(exported).not.toContain("sk-utf16");
      expect(exported).not.toContain("utf16-token");
      expect(exported).not.toContain("utf16-access");
    });
  });

  it("目录导出应识别 CJK 主体的 UTF-16 无 BOM 文本并脱敏敏感字段", async () => {
    const { writeLogArchiveDirectory } = await import("@desktop/main/exportLogs.js");

    await withTempDir(async (tempDir) => {
      const sourceDir = join(tempDir, "source");
      const sourceFile = join(sourceDir, "logs", "sensitive-cjk-utf16.log");
      await mkdir(join(sourceDir, "logs"), { recursive: true });
      await writeFile(
        sourceFile,
        [
          "这是一段用于回归测试的中文日志内容。".repeat(120),
          "OPENAI_API_KEY=sk-cjk-utf16-secret",
          "Authorization: Bearer cjk-utf16-token",
        ].join("\r\n"),
        "utf16le",
      );

      const outputDir = join(tempDir, "logs-dir");
      await writeLogArchiveDirectory(outputDir, {
        files: [
          {
            absolutePath: sourceFile,
            archivePath: "logs/sensitive-cjk-utf16.log",
          },
        ],
        aboutContent: "about-directory",
      });

      const exportedBuffer = await readFile(join(outputDir, "logs", "sensitive-cjk-utf16.log"));
      const exported = exportedBuffer.toString("utf16le");
      expect(exported).toContain("用于回归测试的中文日志内容");
      expect(exported).toContain("OPENAI_API_KEY=***REDACTED***");
      expect(exported).toContain("Authorization: Bearer ***REDACTED***");
      expect(exported).not.toContain("sk-cjk-utf16-secret");
      expect(exported).not.toContain("cjk-utf16-token");
    });
  });

  it("目录导出遇到缺失文件时应跳过并继续导出", async () => {
    const { writeLogArchiveDirectory } = await import("@desktop/main/exportLogs.js");

    await withTempDir(async (tempDir) => {
      const sourceDir = join(tempDir, "source");
      const existingFile = join(sourceDir, "logs", "nested.log");
      const missingFile = join(sourceDir, "logs", "missing.log");
      await mkdir(join(sourceDir, "logs"), { recursive: true });
      await writeFile(existingFile, "nested-log", "utf-8");

      const outputDir = join(tempDir, "logs-dir");
      await writeLogArchiveDirectory(outputDir, {
        files: [
          { absolutePath: existingFile, archivePath: "logs/nested.log" },
          { absolutePath: missingFile, archivePath: "logs/missing.log" },
        ],
        aboutContent: "about-directory",
      });

      expect(await readFile(join(outputDir, "logs", "nested.log"), "utf-8")).toBe("nested-log");
      expect(await readFile(join(outputDir, "about.txt"), "utf-8")).toBe("about-directory");
      expect(await stat(join(outputDir, "logs", "missing.log")).catch(() => null)).toBeNull();
      expect(loggerMock.warn).toHaveBeenCalledTimes(1);
      expect(loggerMock.error).not.toHaveBeenCalled();
    });
  });

  it("zip 导出遇到失效软链或瞬时消失的文件时应自动跳过", async () => {
    const { collectLogArchiveFiles, writeLogArchiveZip } =
      await import("@desktop/main/exportLogs.js");

    await withTempDir(async (tempDir) => {
      const sourceDir = join(tempDir, "source");
      await mkdir(join(sourceDir, "logs"), { recursive: true });
      await mkdir(join(sourceDir, "telemetry"), { recursive: true });
      await writeFile(join(sourceDir, "logs", "main.log"), "main-log", "utf-8");

      const volatileTarget = join(sourceDir, "telemetry", "volatile.json");
      const volatileArchivePath = "logs/volatile.json";
      const volatileLinkPath = join(sourceDir, "logs", "volatile.json");
      await writeFile(volatileTarget, "volatile-log", "utf-8");

      let deletionPath = volatileTarget;
      try {
        await symlink(volatileTarget, volatileLinkPath, "file");
      } catch {
        // Bugfix 回归测试：部分 Windows 环境没有创建软链的权限，这里退化成“收集后原文件被删掉”的同类场景。
        await writeFile(volatileLinkPath, "volatile-log", "utf-8");
        deletionPath = volatileLinkPath;
      }

      const files = await collectLogArchiveFiles(sourceDir);
      expect(files.some((file) => file.archivePath === volatileArchivePath)).toBe(true);

      await rm(deletionPath, { force: true });

      const zipPath = join(tempDir, "logs.zip");
      await writeLogArchiveZip(
        zipPath,
        {
          files,
          aboutContent: "about-contents",
        },
        createWriteZipTestOptions(tempDir),
      );

      const entries = await readZipEntries(zipPath);
      expect(entries.get("about.txt")).toBe("about-contents");
      expect(entries.get("logs/main.log")).toBe("main-log");
      expect(entries.has(volatileArchivePath)).toBe(false);
      expect(loggerMock.warn).toHaveBeenCalledTimes(1);
      expect(loggerMock.error).not.toHaveBeenCalled();
    });
  });

  it("导出期间文件消失时应跳过 ENOENT 并继续成功导出", async () => {
    const { exportLogs } = await import("@desktop/main/exportLogs.js");

    await withTempDir(async (tempDir) => {
      const sourceDir = join(tempDir, "source");
      const logsDir = join(sourceDir, "logs");
      const stableFile = join(logsDir, "stable.log");
      const transientFile = join(logsDir, "transient.log");
      await mkdir(logsDir, { recursive: true });
      await writeFile(stableFile, "stable-log", "utf-8");
      await writeFile(transientFile, "transient-log", "utf-8");

      const result = await exportLogs({
        ...createExportLogTestDirs(tempDir),
        now: () => new Date("2026-04-20T01:02:03"),
        getZCodeDataDir: () => sourceDir,
        createLogArchiveArtifacts: async () => {
          await rm(transientFile, { force: true });
          return {
            files: [
              { absolutePath: stableFile, archivePath: "logs/stable.log" },
              {
                absolutePath: transientFile,
                archivePath: "logs/transient.log",
              },
            ],
            aboutContent: "about-enoent",
          };
        },
      });

      expect(result.success).toBe(true);
      expect(result.path).toBeDefined();
      expect(result.path?.endsWith(".zip")).toBe(true);
      expect(result.path?.startsWith(join(tempDir, "export-log"))).toBe(true);

      const entries = await readZipEntries(result.path!);
      expect(entries.get("about.txt")).toBe("about-enoent");
      expect(entries.get("logs/stable.log")).toBe("stable-log");
      expect(entries.has("logs/transient.log")).toBe(false);
      expect(loggerMock.warn).toHaveBeenCalledWith(
        "[export-logs] 检测到不可读日志文件，已在导出时自动跳过",
        expect.objectContaining({
          skippedCount: 1,
          skippedFiles: expect.arrayContaining([
            expect.objectContaining({
              absolutePath: transientFile,
              archivePath: "logs/transient.log",
            }),
          ]),
        }),
      );
      expect(loggerMock.error).not.toHaveBeenCalled();
    });
  });

  it("收集日志遇到不可读目录时应跳过并继续成功导出", async () => {
    await withTempDir(async (tempDir) => {
      const originalHome = process.env["HOME"];
      const fakeHome = join(tempDir, "home");
      const sourceDir = join(tempDir, "source");
      const logsDir = join(sourceDir, "logs");
      const blockedDir = join(logsDir, "blocked");
      await mkdir(fakeHome, { recursive: true });
      await mkdir(blockedDir, { recursive: true });
      await writeFile(join(logsDir, "stable.log"), "stable-log", "utf-8");
      await writeFile(join(blockedDir, "secret.log"), "secret-log", "utf-8");

      vi.resetModules();
      vi.doMock("node:fs/promises", async () => {
        const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
        return {
          ...actual,
          readdir: async (
            ...args: Parameters<typeof actual.readdir>
          ): ReturnType<typeof actual.readdir> => {
            if (String(args[0]) === blockedDir) {
              const error = new Error(
                `EACCES: permission denied, scandir '${blockedDir}'`,
              ) as NodeJS.ErrnoException;
              error.code = "EACCES";
              throw error;
            }

            return actual.readdir(...args);
          },
        };
      });

      try {
        // Bugfix: exportLogs 会额外扫描 ~/.zcode/cli/log。
        // 这里如果沿用真实 HOME，测试耗时会被本机调试日志体积放大，full suite 下容易踩到默认 5s 超时。
        // 固定到临时 HOME 后，测试只验证“不可读目录应被跳过”这一条行为，避免环境耦合导致的随机超时。
        process.env["HOME"] = fakeHome;
        const { exportLogs } = await import("@desktop/main/exportLogs.js");
        const result = await exportLogs({
          ...createExportLogTestDirs(tempDir),
          now: () => new Date("2026-04-20T01:02:03"),
          getZCodeDataDir: () => sourceDir,
        });

        expect(result.success).toBe(true);
        expect(result.path).toBeDefined();

        const entries = await readZipEntries(result.path!);
        expect(entries.get("logs/stable.log")).toBe("stable-log");
        expect(entries.has("logs/blocked/secret.log")).toBe(false);
        expect(loggerMock.warn).toHaveBeenCalledWith(
          "[export-logs] 日志目录不可读，已在导出时自动跳过",
          expect.objectContaining({
            absolutePath: blockedDir,
            archivePath: "logs/blocked",
            error: expect.stringContaining("EACCES"),
          }),
        );
        expect(loggerMock.error).not.toHaveBeenCalled();
      } finally {
        if (originalHome == null) {
          delete process.env["HOME"];
        } else {
          process.env["HOME"] = originalHome;
        }
        vi.doUnmock("node:fs/promises");
        vi.resetModules();
      }
    });
  });

  it("导出期间文件不可读时应跳过 EACCES 并继续成功导出", async () => {
    await withTempDir(async (tempDir) => {
      const sourceDir = join(tempDir, "source");
      const logsDir = join(sourceDir, "logs");
      const stableFile = join(logsDir, "stable.log");
      const unreadableFile = join(logsDir, "unreadable.log");
      await mkdir(logsDir, { recursive: true });
      await writeFile(stableFile, "stable-log", "utf-8");
      await writeFile(unreadableFile, "unreadable-log", "utf-8");

      vi.resetModules();
      vi.doMock("node:fs/promises", async () => {
        const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
        return {
          ...actual,
          access: async (
            ...args: Parameters<typeof actual.access>
          ): ReturnType<typeof actual.access> => {
            if (String(args[0]) === unreadableFile) {
              const error = new Error(
                `EACCES: permission denied, access '${unreadableFile}'`,
              ) as NodeJS.ErrnoException;
              error.code = "EACCES";
              throw error;
            }

            return actual.access(...args);
          },
        };
      });

      try {
        const { exportLogs } = await import("@desktop/main/exportLogs.js");
        const result = await exportLogs({
          ...createExportLogTestDirs(tempDir),
          now: () => new Date("2026-04-20T01:02:03"),
          getZCodeDataDir: () => sourceDir,
          createLogArchiveArtifacts: async () => ({
            files: [
              { absolutePath: stableFile, archivePath: "logs/stable.log" },
              {
                absolutePath: unreadableFile,
                archivePath: "logs/unreadable.log",
              },
            ],
            aboutContent: "about-eacces",
          }),
        });

        expect(result.success).toBe(true);
        expect(result.path).toBeDefined();

        const entries = await readZipEntries(result.path!);
        expect(entries.get("about.txt")).toBe("about-eacces");
        expect(entries.get("logs/stable.log")).toBe("stable-log");
        expect(entries.has("logs/unreadable.log")).toBe(false);
        expect(loggerMock.warn).toHaveBeenCalledWith(
          "[export-logs] 检测到不可读日志文件，已在导出时自动跳过",
          expect.objectContaining({
            skippedCount: 1,
            skippedFiles: expect.arrayContaining([
              expect.objectContaining({
                absolutePath: unreadableFile,
                archivePath: "logs/unreadable.log",
                error: expect.stringContaining("EACCES"),
              }),
            ]),
          }),
        );
        expect(loggerMock.error).not.toHaveBeenCalled();
      } finally {
        vi.doUnmock("node:fs/promises");
        vi.resetModules();
      }
    });
  });

  it("zip 失败时应回退到目录导出", async () => {
    const { exportLogs } = await import("@desktop/main/exportLogs.js");

    await withTempDir(async (tempDir) => {
      const sourceDir = join(tempDir, "source");
      const sourceFile = join(sourceDir, "logs", "main.log");
      await mkdir(join(sourceDir, "logs"), { recursive: true });
      await writeFile(sourceFile, "fallback-log", "utf-8");

      const shownPaths: string[] = [];
      const result = await exportLogs({
        ...createExportLogTestDirs(tempDir),
        now: () => new Date("2026-04-20T01:02:03"),
        getZCodeDataDir: () => sourceDir,
        createLogArchiveArtifacts: async () => ({
          files: [{ absolutePath: sourceFile, archivePath: "logs/main.log" }],
          aboutContent: "about-fallback",
        }),
        writeLogArchiveZip: async () => {
          throw new Error("zip write failed");
        },
        showItemInFolder: (path) => {
          shownPaths.push(path);
        },
      });

      expect(result.success).toBe(true);
      expect(result.path).toBeDefined();
      expect(result.path?.endsWith(".zip")).toBe(false);
      expect(shownPaths).toEqual([result.path]);
      expect((await stat(result.path!)).isDirectory()).toBe(true);
      expect(await readFile(join(result.path!, "logs", "main.log"), "utf-8")).toBe("fallback-log");
      expect((await readFile(join(result.path!, "about.txt"), "utf-8")).length).toBeGreaterThan(0);
      expect(loggerMock.warn).toHaveBeenCalledTimes(1);
      expect(loggerMock.error).not.toHaveBeenCalled();
    });
  }, 15_000);
});
