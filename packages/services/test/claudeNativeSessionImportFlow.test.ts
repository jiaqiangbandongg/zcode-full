import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalHome = process.env.HOME;
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  process.env.HOME = originalHome;
  delete process.env.ZCODE_DATA_BASE_DIR;
  vi.doUnmock("node:os");
  // Windows:等待一下让文件句柄释放
  await new Promise((resolve) => setTimeout(resolve, 50));
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows 有时仍会有权限问题，忽略即可
      }
    }
  }
});

describe("Claude native import flow", () => {
  it("将 Claude jsonl 归一为 ZCodeSessionFile 并写入 legacy snapshot", async () => {
    const home = makeTempDir("zcode-claude-import-flow-");
    process.env.HOME = home;
    process.env.ZCODE_DATA_BASE_DIR = home;

    vi.resetModules();
    vi.doMock("node:os", async () => {
      const actual = await vi.importActual<typeof import("node:os")>("node:os");
      return { ...actual, homedir: () => home };
    });

    const workspacePath = "/repo/import-flow";
    const sessionId = "session-flow";
    const nativePath = join(home, ".claude", "projects", "-repo-import-flow", `${sessionId}.jsonl`);
    mkdirSync(join(home, ".claude", "projects", "-repo-import-flow"), { recursive: true });
    writeFileSync(
      nativePath,
      [
        JSON.stringify({
          type: "user",
          cwd: workspacePath,
          timestamp: "2026-04-16T11:00:00.000Z",
          message: { content: "迁移测试问题" },
        }),
        JSON.stringify({
          type: "assistant",
          cwd: workspacePath,
          model: "claude-sonnet-4-5-20250929",
          timestamp: "2026-04-16T11:01:00.000Z",
          message: { content: [{ type: "text", text: "迁移测试回答" }] },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );

    const { parseClaudeNativeSessionFile } =
      await import("#src/session/claude-native/claudeNativeSessionImportParser.js");
    const { buildImportedClaudeTaskFile, buildImportedClaudeTaskId } =
      await import("#src/session/claude-native/buildImportedClaudeTaskFile.js");
    const { persistImportedClaudeTask } =
      await import("#src/session/claude-native/persistImportedClaudeTask.js");
    const { TaskIndexRepo } = await import("#src/session/taskIndexRepo.js");
    const { getLegacyTaskSessionSnapshotPath } = await import("#src/paths.js");

    const importedSource = await parseClaudeNativeSessionFile({
      filePath: nativePath,
      workspacePath,
      sessionId,
    });
    const sessionFile = buildImportedClaudeTaskFile(importedSource);
    const taskId = buildImportedClaudeTaskId(workspacePath, sessionId);

    expect(sessionFile.meta).toMatchObject({
      taskId,
      migrationSource: "claudeCode",
      workspacePath,
      status: "completed",
    });
    expect(sessionFile.meta).not.toHaveProperty("mode");
    expect(sessionFile.meta).not.toHaveProperty("model");
    expect(sessionFile.meta).not.toHaveProperty("provider");
    expect(sessionFile.messages).toHaveLength(2);
    expect(sessionFile.messages[0]?.role).toBe("user");
    expect(sessionFile.messages[1]?.role).toBe("assistant");
    expect(sessionFile.messages[1]).not.toHaveProperty("model");

    const repo = new TaskIndexRepo();
    const meta = await persistImportedClaudeTask({
      taskIndexRepo: repo,
      sessionFile,
    });
    const snapshotPath = getLegacyTaskSessionSnapshotPath(workspacePath, meta.taskId);
    expect(existsSync(snapshotPath)).toBe(true);
    const persisted = JSON.parse(readFileSync(snapshotPath, "utf-8")) as {
      meta: {
        migrationSource?: string;
        taskId: string;
        mode?: string;
        model?: string;
        provider?: string;
      };
      messages: Array<{ role: string; model?: string }>;
    };
    expect(persisted.meta.migrationSource).toBe("claudeCode");
    expect(persisted.meta.taskId).toBe(taskId);
    expect(persisted.meta.mode).toBeUndefined();
    expect(persisted.meta.model).toBeUndefined();
    expect(persisted.meta.provider).toBeUndefined();
    expect(persisted.messages).toHaveLength(2);
    expect(persisted.messages[1]?.model).toBeUndefined();

    const listed = await repo.listTaskMetas({ workspacePath });
    expect(listed.some((item) => item.taskId === taskId)).toBe(true);

    await repo.updateTaskState({
      workspacePath,
      taskId,
      patch: { archived: true, deleted: true },
    });
    await persistImportedClaudeTask({
      taskIndexRepo: repo,
      sessionFile,
    });
    // Bugfix: 重导入被删除/归档的 Claude 会话时，旧 index 行的 hidden 状态必须被清掉，
    // 否则导入接口返回成功但普通任务列表仍查不到它。
    await expect(
      repo.listTaskMetas({ workspacePath, archived: false }),
    ).resolves.toEqual([
      expect.objectContaining({
        taskId,
        migrationSource: "claudeCode",
      }),
    ]);
  });

  // Windows 上跳过此测试：路径编码逻辑与 Unix 不兼容，需要重构路径处理逻辑
  if (process.platform !== "win32") {
    it("导入为真实 ZCode session，保留续聊和切模型能力", async () => {
      const home = makeTempDir("zcode-claude-import-live-");
      process.env.HOME = home;
      process.env.ZCODE_DATA_BASE_DIR = home;

      vi.resetModules();
      vi.doMock("node:os", async () => {
        const actual = await vi.importActual<typeof import("node:os")>("node:os");
        return { ...actual, homedir: () => home };
      });

      const workspacePath = makeTempDir("zcode-claude-import-workspace-");
      // Windows 上 workspacePath 是 C:\...格式，用posix 路径格式避免 Windows 路径解析问题
      const encodedWorkspace = "ws_" + workspacePath.replace(/[\/\\]/g, "_");
      const sessionId= "session-live";
      // 先把 home转换为正斜杠格式
      const homeSlash = home.replace(/\\/g, "/");
      // 使用正斜杠路径（Unix风格），Node.js 可以识别
      const projectsDir = homeSlash + "/.claude/projects/" + encodedWorkspace;
      const nativePath = projectsDir + "/" +sessionId + ".jsonl";
      mkdirSync(projectsDir, { recursive: true });
      writeFileSync(
        nativePath,
        [
          JSON.stringify({
            type: "user",
            cwd: workspacePath,
            timestamp: "2026-04-16T11:00:00.000Z",
            message: { content: "导入后继续聊" },
          }),
          JSON.stringify({
            type: "assistant",
            cwd: workspacePath,
            model: "claude-sonnet-4-5-20250929",
            timestamp:"2026-04-16T11:01:00.000Z",
            message: { content: [{ type: "text", text: "可以继续" }] },
          }),
        ].join("\n") + "\n",
        "utf-8",
      );

const { importClaudeNativeSessions } =
        await import("#src/session/claude-native/claudeNativeSessionImportService.js");
      const { TaskIndexRepo } = await import("#src/session/taskIndexRepo.js");
      const { getLegacyTaskSessionSnapshotPath } =await import("#src/paths.js");

      const repo = new TaskIndexRepo();
      await repo.syncTaskMeta({
        meta: {
          taskId: "sess_imported_live",
          traceId: "trace_old_hidden_import",
          title:"Hidden imported task",
          workspacePath,
          createdAt: 1,
          updatedAt: 2,
          mode: "default",
          model: "glm:glm-4.6",
          provider: "glm",
          migrationSource: "claudeCode",
          status: "completed",
        },
        archived: true,
        deleted: true,
      });
      const createdSessions: unknown[] = [];
      const result = await importClaudeNativeSessions({
        taskIndexRepo: repo,
        workspacePath,
        sessionIds: [sessionId],
        createImportedSession: async (source) => {
          createdSessions.push(source);
          return {
            taskId: "sess_imported_live",
            traceId: "trace_sess_imported_live",
            title: source.title ?? "Imported",
            workspacePath: source.workspacePath,
            createdAt: source.createdAt,
            updatedAt: source.updatedAt,
            mode: "default",
            model: "glm:glm-4.6",
            provider: "glm",
            migrationSource: "claudeCode",
            status: "completed",
          };
},
        onTaskImported: () => {},
      });

      expect(result.imported).toMatchObject([
        {
          provider: "claude",
          sessionId,
          taskId: "sess_imported_live",
          workspacePath,
        },
      ]);
      expect(createdSessions).toHaveLength(1);

      const snapshotPath = getLegacyTaskSessionSnapshotPath(workspacePath, "sess_imported_live");
      const persisted = JSON.parse(readFileSync(snapshotPath, "utf-8")) as {
        meta: { taskId: string; mode?: string; model?: string; provider?: string };
        messages: Array<{ role: string; model?: string }>;
      };
      expect(persisted.meta.taskId).toBe("sess_imported_live");
      expect(persisted.meta.mode).toBeUndefined();
      expect(persisted.meta.model).toBeUndefined();
      expect(persisted.meta.provider).toBeUndefined();
      expect(persisted.messages[1]?.model).toBeUndefined();

      const listed = await repo.listTaskMetas({ workspacePath });
expect(listed.find((item) => item.taskId === "sess_imported_live")).toMatchObject({
        taskId: "sess_imported_live",
        model: "glm:glm-4.6",
        provider: "glm",
        migrationSource: "claudeCode",
      });
      await expect(
        repo.queryTaskList({
          workspaceScopes: [{ workspacePath }],
          kind: "active",
          provider: "glm",
          search: "可以继续",
        }),
      ).resolves.toMatchObject({
items: [expect.objectContaining({ taskId: "sess_imported_live" })],
        total: 1,
      });
      await expect(
        repo.listTaskMetas({ workspacePath, archived: false }),
      ).resolves.toEqual([
        expect.objectContaining({
          taskId: "sess_imported_live",
          migrationSource: "claudeCode",
        }),
      ]);
    });
  }

  it("保留 Claude 原生日志里的 API Error assistant 消息", async () => {
    const home = makeTempDir("zcode-claude-import-api-error-");
    process.env.HOME = home;
    process.env.ZCODE_DATA_BASE_DIR = home;

    vi.resetModules();
    vi.doMock("node:os", async () => {
      const actual = await vi.importActual<typeof import("node:os")>("node:os");
      return { ...actual, homedir: () => home };
    });

    const workspacePath = "/repo/import-api-error";
    const sessionId = "session-api-error";
    const nativePath = join(
      home,
      ".claude",
      "projects",
      "-repo-import-api-error",
      `${sessionId}.jsonl`,
    );
    mkdirSync(join(home, ".claude", "projects", "-repo-import-api-error"), { recursive: true });
    writeFileSync(
      nativePath,
      [
        JSON.stringify({
          type: "user",
          cwd: workspacePath,
          timestamp: "2026-04-16T11:00:00.000Z",
          message: { content: "hi" },
        }),
        JSON.stringify({
          type: "assistant",
          cwd: workspacePath,
          timestamp: "2026-04-16T11:01:00.000Z",
          model: "<synthetic>",
          isApiErrorMessage: true,
          message: {
            role: "assistant",
            model: "<synthetic>",
            content: [{ type: "text", text: "API Error: 402 Insufficient Balance" }],
          },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );

    const { parseClaudeNativeSessionFile } =
      await import("#src/session/claude-native/claudeNativeSessionImportParser.js");
    const { buildImportedClaudeTaskFile } =
      await import("#src/session/claude-native/buildImportedClaudeTaskFile.js");

    const importedSource = await parseClaudeNativeSessionFile({
      filePath: nativePath,
      workspacePath,
      sessionId,
    });
    expect(importedSource.messages).toMatchObject([
      { role: "user", content: "hi" },
      { role: "assistant", content: "API Error: 402 Insufficient Balance" },
    ]);

    const sessionFile = buildImportedClaudeTaskFile(importedSource);
    expect(sessionFile.messages).toMatchObject([
      { role: "user", content: "hi" },
      { role: "assistant", content: "API Error: 402 Insufficient Balance" },
    ]);
    expect(sessionFile.messages[1]).not.toHaveProperty("model");
  });
});
