import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
  symlink,
  utimes,
  appendFile,
  truncate,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as yauzl from "yauzl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupLogArchive, prepareCompactLogArchive } from "#src/feedback/compactLogArchive.js";
import { createFeedbackDiagnosticArchive } from "#src/feedback/feedbackLogArchive.js";
import { getAppConfigDir, getFeedbackLogArchiveDir, setDataBaseDir } from "#src/paths.js";

const { beforeRead } = vi.hoisted(() => ({ beforeRead: vi.fn<() => Promise<void>>() }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const read = handle.read.bind(handle);
      handle.read = vi.fn(async (...readArgs: Parameters<typeof read>) => {
        await beforeRead();
        return read(...readArgs);
      }) as typeof handle.read;
      return handle;
    },
  };
});

async function withTempDir(run: (tempDir: string) => Promise<void>): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), "compact-log-archive-test-"));
  try {
    await run(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
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

afterEach(() => {
  setDataBaseDir(null);
  beforeRead.mockReset();
});

describe("compact log archive", () => {
  it("完整日志归档应排除 agent-config、certs 和非日志状态目录", async () => {
    await withTempDir(async (dataBaseDir) => {
      setDataBaseDir(dataBaseDir);
      const sourceDir = getAppConfigDir();
      await mkdir(join(sourceDir, "logs"), { recursive: true });
      await mkdir(join(sourceDir, "agent-config", "codex", "workspace-a"), {
        recursive: true,
      });
      await mkdir(join(sourceDir, "certs"), { recursive: true });
      await mkdir(join(sourceDir, "sessions", "workspace-a"), {
        recursive: true,
      });
      await mkdir(join(sourceDir, "session-bindings", "workspace-a"), {
        recursive: true,
      });
      await mkdir(join(sourceDir, "checkpoints", "workspace-a"), {
        recursive: true,
      });
      // 退役 Repo 功能的历史数据目录：升级用户数据根可能残留，必须永不进入归档。
      await mkdir(join(sourceDir, "repo-snapshots", "workspace-a", "pending"), {
        recursive: true,
      });
      await mkdir(join(sourceDir, "repo-wiki", "workspace-a"), { recursive: true });

      await writeFile(join(sourceDir, "logs", "main.log"), "main-log", "utf-8");
      await writeFile(
        join(sourceDir, "agent-config", "codex", "workspace-a", "config.toml"),
        "agent-config-state",
        "utf-8",
      );
      await writeFile(join(sourceDir, "certs", "app-ca.pem"), "certificate-state", "utf-8");
      await writeFile(
        join(sourceDir, "sessions", "workspace-a", "session.json"),
        '{"sessionId":"legacy"}',
        "utf-8",
      );
      await writeFile(
        join(sourceDir, "session-bindings", "workspace-a", "binding.json"),
        '{"sessionId":"legacy"}',
        "utf-8",
      );
      await writeFile(
        join(sourceDir, "checkpoints", "workspace-a", "checkpoint.json"),
        '{"checkpointId":"legacy"}',
        "utf-8",
      );
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

      const archive = await prepareCompactLogArchive({ full: true });
      try {
        expect(archive.path.startsWith(getFeedbackLogArchiveDir())).toBe(true);
        const entries = await readZipEntries(archive.path);
        expect(entries.get("logs/main.log")).toBe("main-log");
        expect(entries.has("agent-config/codex/workspace-a/config.toml")).toBe(false);
        expect(entries.has("certs/app-ca.pem")).toBe(false);
        expect(entries.has("sessions/workspace-a/session.json")).toBe(false);
        expect(entries.has("session-bindings/workspace-a/binding.json")).toBe(false);
        expect(entries.has("checkpoints/workspace-a/checkpoint.json")).toBe(false);
        expect(entries.has("repo-snapshots/workspace-a/pending/snapshot.tar.gz.enc")).toBe(false);
        expect(entries.has("repo-wiki/workspace-a/wiki.json")).toBe(false);
      } finally {
        await cleanupLogArchive(archive.path);
      }
    });
  });

  it("完整日志归档应排除高体积运行态诊断目录", async () => {
    await withTempDir(async (dataBaseDir) => {
      setDataBaseDir(dataBaseDir);
      const sourceDir = getAppConfigDir();
      await mkdir(join(sourceDir, "logs"), { recursive: true });
      await mkdir(join(sourceDir, "dev", "stdio-traffic", "workspace-a"), {
        recursive: true,
      });
      await mkdir(join(sourceDir, "acp-config", "codex", "workspace-a", ".tmp"), {
        recursive: true,
      });
      await mkdir(join(sourceDir, "acp-stream-diagnostics"), {
        recursive: true,
      });

      await writeFile(join(sourceDir, "logs", "main.log"), "main-log", "utf-8");
      await writeFile(
        join(sourceDir, "dev", "stdio-traffic", "workspace-a", "traffic.ndjson"),
        "raw-traffic",
        "utf-8",
      );
      await writeFile(
        join(sourceDir, "acp-config", "codex", "workspace-a", ".tmp", "plugins"),
        "plugin-cache",
        "utf-8",
      );
      await writeFile(
        join(sourceDir, "acp-stream-diagnostics", "trace.jsonl"),
        "stream-trace",
        "utf-8",
      );

      const archive = await prepareCompactLogArchive({ full: true });
      try {
        const entries = await readZipEntries(archive.path);
        expect(entries.get("logs/main.log")).toBe("main-log");
        expect(entries.has("dev/stdio-traffic/workspace-a/traffic.ndjson")).toBe(false);
        expect(entries.has("acp-config/codex/workspace-a/.tmp/plugins")).toBe(false);
        expect(entries.has("acp-stream-diagnostics/trace.jsonl")).toBe(false);
      } finally {
        await cleanupLogArchive(archive.path);
      }
    });
  });
});

describe("反馈归档隐私边界", () => {
  it("无法解析的 CLI 配置不会进入反馈归档", async () => {
    await withTempDir(async (root) => {
      const source = join(root, "cli");
      await mkdir(source);
      await writeFile(join(source, "config.json"), "{invalid-json", "utf-8");
      const archive = await createFeedbackDiagnosticArchive({
        sources: [
          {
            directory: source,
            archivePrefix: ".zcode/cli",
            includeFileNames: ["config.json"],
            onlyCurrentDay: false,
            contentPolicy: "cli-config",
          },
        ],
        outputRootDir: join(root, "archives"),
      });
      const entries = await readZipEntries(archive.path);
      expect(entries.has(".zcode/cli/config.json")).toBe(false);
      expect(entries.get("about.txt")).toContain('"invalid-config":1');
    });
  });

  it.each(["append", "truncate"] as const)(
    "读取期间 %s：保留追加日志的有界快照，跳过短读",
    async (change) => {
      await withTempDir(async (root) => {
        const source = join(root, "logs");
        await mkdir(source);
        const file = join(source, "active.log");
        await writeFile(file, '{"event":"active","apiKey":"snapshot-canary"}\n');
        beforeRead.mockImplementationOnce(async () => {
          if (change === "append") {
            await appendFile(file, '{"event":"later","apiKey":"append-canary"}\n');
          } else {
            await truncate(file, 0);
          }
        });
        const archive = await createFeedbackDiagnosticArchive({
          sources: [{ directory: source, archivePrefix: "logs" }],
          outputRootDir: join(root, "archives"),
        });
        const entries = await readZipEntries(archive.path);
        expect(beforeRead).toHaveBeenCalled();
        if (change === "append") {
          expect(entries.get("logs/active.log")).toContain("active");
          expect(entries.get("logs/active.log")).not.toContain("later");
          expect(entries.get("about.txt")).toContain("includedLogFiles: 1");
          expect(entries.get("about.txt")).toContain("skippedLogFiles: 0");
        } else {
          expect(entries.has("logs/active.log")).toBe(false);
          expect(entries.get("about.txt")).toContain("skippedLogFiles: 1");
          expect(entries.get("about.txt")).toContain('"short-read":1');
          expect(entries.get("about.txt")).not.toContain("active.log");
        }
        expect([...entries.values()].join("\n")).not.toContain("canary");
      });
    },
  );

  it.each([
    [2026, 0, 1],
    [2026, 2, 8],
    [2026, 10, 1],
  ])("%s-%s-%s 只选择本地当天修改的日志，包含零点、排除前后日期", async (year, month, day) => {
    await withTempDir(async (root) => {
      const now = new Date(year, month, day, 12);
      const start = new Date(year, month, day);
      const end = new Date(year, month, day + 1);
      const source = join(root, "logs");
      await mkdir(source);
      for (const [name, time] of [
        ["yesterday.log", new Date(start.getTime() - 1000)],
        ["midnight.log", start],
        ["today.log", now],
        ["last-second.log", new Date(end.getTime() - 1000)],
        ["tomorrow.log", end],
      ] as const) {
        const file = join(source, name);
        await writeFile(file, name);
        await utimes(file, time, time);
      }
      const archive = await createFeedbackDiagnosticArchive({
        sources: [{ directory: source, archivePrefix: "logs" }],
        outputRootDir: join(root, "archives"),
        now: () => now,
      });
      try {
        const entries = await readZipEntries(archive.path);
        expect([...entries.keys()].sort()).toEqual([
          "about.txt",
          "logs/last-second.log",
          "logs/midnight.log",
          "logs/today.log",
        ]);
      } finally {
        await cleanupLogArchive(archive.path);
      }
    });
  });

  // 普通文件的脱敏/编码/过滤规则无平台依赖，fixture 与断言跨平台共用；
  // 符号链接相关写入与逃逸断言单独拆到 POSIX 用例（见下）。
  async function writePrivacyFixtureFiles(dataBaseDir: string): Promise<string> {
    setDataBaseDir(dataBaseDir);
    const root = getAppConfigDir();
    await mkdir(join(root, "logs"), { recursive: true });
    await writeFile(join(root, "tasks-index.sqlite"), "database-canary");
    await writeFile(join(root, "config.json"), "config-canary");
    await mkdir(join(root, "cli", "rollout"), { recursive: true });
    await writeFile(join(root, "cli", "rollout", "trace.log"), "rollout-canary");
    await writeFile(
      join(root, "logs", "main.log"),
      JSON.stringify({
        event: "failed",
        config: { apiKey: "nested-canary" },
        request: { messages: ["prompt-canary"] },
        endpoint: "https://example.com/opaque-path-canary",
        webhook: "https://hooks.slack.com/services/T000/B000/webhook-path-canary",
      }),
    );
    await writeFile(join(root, "logs", "binary.log"), Buffer.from([0, 1, 2, 3]));
    await writeFile(join(root, "logs", "old.log"), "old-canary");
    await utimes(join(root, "logs", "old.log"), new Date(0), new Date(0));
    await writeFile(join(root, "logs", "large.log"), Buffer.alloc(8 * 1024 * 1024 + 1, 65));
    await writeFile(
      join(root, "logs", "native.jsonl"),
      JSON.stringify({ event: "native-error", apiKey: "jsonl-canary" }),
    );
    await writeFile(
      join(root, "logs", "mixed.log"),
      [
        "reset failed https://example.com/reset/reset-path-canary",
        "download failed https://files.example.com/object-path-canary?X-Amz-Signature=sig-canary",
        JSON.stringify({ error: 'failed config: {"apiKey":"embedded-canary"}' }),
        '[info] {"apiKey":"prefix-canary"} {"status":401}',
        '[info] details {\n "input": {"value":"multiline-canary"}\n}',
        '[info] {"privateKey": {\n "value":"truncated-canary"',
      ].join("\n"),
    );
    await writeFile(
      join(root, "logs", "utf16.log"),
      Buffer.concat([Buffer.from([255, 254]), Buffer.from("apiKey=utf16-canary", "utf16le")]),
    );
    return root;
  }

  async function createArchiveAndAssertPrivacy(full: boolean): Promise<void> {
    const archive = await prepareCompactLogArchive({ full });
    try {
      const entries = await readZipEntries(archive.path);
      expect([...entries.keys()].sort()).toEqual([
        "about.txt",
        "logs/main.log",
        "logs/mixed.log",
        "logs/native.jsonl",
        "logs/utf16.log",
      ]);
      const all = [...entries.values()].join("\n");
      for (const secret of [
        "database-canary",
        "opaque-path-canary",
        "webhook-path-canary",
        "reset-path-canary",
        "object-path-canary",
        "sig-canary",
        "config-canary",
        "rollout-canary",
        "nested-canary",
        "jsonl-canary",
        "embedded-canary",
        "prefix-canary",
        "multiline-canary",
        "truncated-canary",
        "utf16-canary",
        "prompt-canary",
        "old-canary",
        "outside-canary",
      ])
        expect(all).not.toContain(secret);
      expect(all).toContain("failed");
      expect(all).not.toContain("hostname:");
    } finally {
      await cleanupLogArchive(archive.path);
    }
  }

  it.each([false, true])("full=%s 只收集近期文本诊断并对整个 ZIP 检查敏感值", async (full) => {
    await withTempDir(async (dataBaseDir) => {
      await writePrivacyFixtureFiles(dataBaseDir);
      await createArchiveAndAssertPrivacy(full);
    });
  });

  // Windows 普通用户无 SeCreateSymbolicLinkPrivilege（开发者模式才赋予），fs.symlink 直接
  // EPERM；只有符号链接逃逸需要该能力，单独拆到本组让普通隐私规则在 Windows 真实执行，
  // skipped 在报告里可见，逃逸覆盖由 CI Linux 承担。
  describe.skipIf(process.platform === "win32")("符号链接逃逸边界", () => {
    it.each([false, true])("full=%s 指向归档根之外的链接文件不得进入 ZIP", async (full) => {
      await withTempDir(async (dataBaseDir) => {
        const root = await writePrivacyFixtureFiles(dataBaseDir);
        await writeFile(join(dataBaseDir, "outside.log"), "outside-canary");
        await symlink(join(dataBaseDir, "outside.log"), join(root, "logs", "linked.log"));
        await createArchiveAndAssertPrivacy(full);
      });
    });
  });
});
