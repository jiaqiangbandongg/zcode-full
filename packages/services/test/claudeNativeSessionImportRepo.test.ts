import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalHome = process.env.HOME;
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeClaudeJsonl(path: string, records: unknown[]): void {
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf-8");
}

afterEach(() => {
  process.env.HOME = originalHome;
  // Bugfix: 并发单测时若恢复到文件加载时捕获的 originalDataBaseDir，
  // 可能把别的用例临时注入的值带回去，最终污染真实数据目录。
  delete process.env.ZCODE_DATA_BASE_DIR;
  vi.doUnmock("node:os");
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("ClaudeNativeSessionImportRepo", () => {
  it("会从真实 HOME 扫描原生 Claude session，并复制到 zcode Claude 目录", async () => {
    const home = makeTempDir("zcode-claude-native-home-");
    const dataBaseDir = makeTempDir("zcode-claude-native-db-");
    process.env.HOME = home;
    process.env.ZCODE_DATA_BASE_DIR = dataBaseDir;

    vi.resetModules();
    vi.doMock("node:os", async () => {
      const actual = await vi.importActual<typeof import("node:os")>("node:os");
      return {
        ...actual,
        homedir: () => home,
      };
    });

    const workspacePath = "/repo/import-demo";
    const nativeProjectsDir = join(home, ".claude", "projects", "-repo-import-demo");
    mkdirSync(nativeProjectsDir, { recursive: true });

    const recentSessionPath = join(nativeProjectsDir, "session-recent.jsonl");
    writeFileSync(
      recentSessionPath,
      [
        JSON.stringify({ type: "queue-operation", cwd: `${workspacePath}/nested` }),
        JSON.stringify({
          type: "user",
          cwd: workspacePath,
          timestamp: "2026-04-16T11:00:00.000Z",
          message: { content: "最近的导入任务" },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );

    const oldSessionPath = join(nativeProjectsDir, "session-old.jsonl");
    writeFileSync(
      oldSessionPath,
      JSON.stringify({
        type: "user",
        cwd: workspacePath,
        timestamp: "2026-04-01T09:00:00.000Z",
        message: { content: "旧任务" },
      }) + "\n",
      "utf-8",
    );
    const oldDate = new Date("2026-04-01T09:00:00.000Z");
    utimesSync(oldSessionPath, oldDate, oldDate);

    const otherWorkspaceDir = join(home, ".claude", "projects", "-repo-other-demo");
    mkdirSync(otherWorkspaceDir, { recursive: true });
    writeFileSync(
      join(otherWorkspaceDir, "session-other.jsonl"),
      JSON.stringify({
        type: "user",
        cwd: "/repo/other-demo",
        timestamp: "2026-04-16T11:05:00.000Z",
        message: { content: "别的 workspace" },
      }) + "\n",
      "utf-8",
    );

    const { ClaudeNativeSessionImportRepo } = await import(
      "#src/session/claude-native/claudeNativeSessionImportRepo.js"
    );
    const { getWorkspaceHash } = await import("#src/paths.js");

    const repo = new ClaudeNativeSessionImportRepo();
    const candidates = await repo.scanImportableSessions({
      workspacePath,
      modifiedSince: Date.parse("2026-04-15T00:00:00.000Z"),
    });

    expect(candidates).toEqual([
      {
        provider: "claude",
        sessionId: "session-recent",
        workspacePath,
        sourcePath: recentSessionPath,
        updatedAt: expect.any(Number),
        createdAt: Date.parse("2026-04-16T11:00:00.000Z"),
        previewTitle: "最近的导入任务",
      },
    ]);

    const workspaceIdentity =
      "remote:ssh:demo-host:22:demo:/repo/import-demo";
    const copied = await repo.copySessionFileToWorkspace({
      workspacePath,
      workspaceIdentity,
      sourcePath: recentSessionPath,
    });

    const workspaceHash = getWorkspaceHash(workspacePath, workspaceIdentity);
    const expectedOutputPath = join(
      dataBaseDir,
      ".zcode",
      "v2",
      "agent-config",
      "claude",
      workspaceHash,
      "projects",
      "-repo-import-demo",
      "session-recent.jsonl",
    );

    expect(copied).toEqual({
      outputPath: expectedOutputPath,

      createdOutputPaths: [expectedOutputPath],
    });
    expect(existsSync(expectedOutputPath)).toBe(true);
    expect(readFileSync(expectedOutputPath, "utf-8")).toBe(readFileSync(recentSessionPath, "utf-8"));
  });

  it("不传 workspacePath 时会返回多个 workspace 的候选 session", async () => {
    const home = makeTempDir("zcode-claude-native-home-all-");
    process.env.HOME = home;

    vi.resetModules();
    vi.doMock("node:os", async () => {
      const actual = await vi.importActual<typeof import("node:os")>("node:os");
      return {
        ...actual,
        homedir: () => home,
      };
    });

    const workspacePathA = "/repo/import-demo-a";
    const workspacePathB = "/repo/import-demo-b";
    const workspaceDirA = join(home, ".claude", "projects", "-repo-import-demo-a");
    const workspaceDirB = join(home, ".claude", "projects", "-repo-import-demo-b");
    mkdirSync(workspaceDirA, { recursive: true });
    mkdirSync(workspaceDirB, { recursive: true });

    const sessionPathA = join(workspaceDirA, "session-a.jsonl");
    writeFileSync(
      sessionPathA,
      JSON.stringify({
        type: "user",
        cwd: workspacePathA,
        timestamp: "2026-04-16T11:00:00.000Z",
        message: { content: "A" },
      }) + "\n",
      "utf-8",
    );
    const sessionDateA = new Date("2026-04-16T11:00:00.000Z");
    utimesSync(sessionPathA, sessionDateA, sessionDateA);

    const sessionPathB = join(workspaceDirB, "session-b.jsonl");
    writeFileSync(
      sessionPathB,
      JSON.stringify({
        type: "user",
        cwd: workspacePathB,
        timestamp: "2026-04-16T10:00:00.000Z",
        message: { content: "B" },
      }) + "\n",
      "utf-8",
    );
    const sessionDateB = new Date("2026-04-16T10:00:00.000Z");
    utimesSync(sessionPathB, sessionDateB, sessionDateB);

    const { ClaudeNativeSessionImportRepo } = await import(
      "#src/session/claude-native/claudeNativeSessionImportRepo.js"
    );

    const repo = new ClaudeNativeSessionImportRepo();
    const candidates = await repo.scanImportableSessions({
      modifiedSince: Date.parse("2026-04-15T00:00:00.000Z"),
    });

    expect(candidates).toEqual([
      {
        provider: "claude",
        sessionId: "session-a",
        workspacePath: workspacePathA,
        sourcePath: sessionPathA,
        updatedAt: Date.parse("2026-04-16T11:00:00.000Z"),
        createdAt: Date.parse("2026-04-16T11:00:00.000Z"),
        previewTitle: "A",
      },
      {
        provider: "claude",
        sessionId: "session-b",
        workspacePath: workspacePathB,
        sourcePath: sessionPathB,
        updatedAt: Date.parse("2026-04-16T10:00:00.000Z"),
        createdAt: Date.parse("2026-04-16T10:00:00.000Z"),
        previewTitle: "B",
      },
    ]);
  });

  it("扫描和查找导入候选时会过滤 Claude 临时 worktree workspace", async () => {
    const home = makeTempDir("zcode-claude-native-home-worktree-");
    process.env.HOME = home;

    vi.resetModules();
    vi.doMock("node:os", async () => {
      const actual = await vi.importActual<typeof import("node:os")>("node:os");
      return {
        ...actual,
        homedir: () => home,
      };
    });

    const workspacePath = "/repo/import-main";
    const worktreeWorkspacePath = join(home, ".claude", "worktrees", "import-main-feature");
    const mainProjectDir = join(home, ".claude", "projects", "-repo-import-main");
    const worktreeProjectDir = join(
      home,
      ".claude",
      "projects",
      "-home-user--claude-worktrees-import-main-feature",
    );
    mkdirSync(mainProjectDir, { recursive: true });
    mkdirSync(worktreeProjectDir, { recursive: true });

    writeClaudeJsonl(join(mainProjectDir, "session-main.jsonl"), [
      {
        type: "user",
        cwd: workspacePath,
        timestamp: "2026-04-16T11:00:00.000Z",
        message: { content: "主工作区" },
      },
    ]);
    writeClaudeJsonl(join(worktreeProjectDir, "session-worktree.jsonl"), [
      {
        type: "user",
        cwd: worktreeWorkspacePath,
        timestamp: "2026-04-16T11:05:00.000Z",
        message: { content: "临时 worktree" },
      },
    ]);

    const { ClaudeNativeSessionImportRepo } = await import(
      "#src/session/claude-native/claudeNativeSessionImportRepo.js"
    );
    const repo = new ClaudeNativeSessionImportRepo();

    await expect(repo.scanImportableSessions({})).resolves.toEqual([
      expect.objectContaining({
        sessionId: "session-main",
        workspacePath,
      }),
    ]);
    await expect(
      repo.findImportableSession({
        sessionId: "session-worktree",
      }),
    ).resolves.toBeNull();
  });

  it("扫描和查找 Claude 原生历史时会跳过 subagents sidechain transcript", async () => {
    const home = makeTempDir("zcode-claude-import-home-");
    process.env.HOME = home;
    vi.resetModules();
    vi.doMock("node:os", async () => {
      const actual = await vi.importActual<typeof import("node:os")>("node:os");
      return {
        ...actual,
        homedir: () => home,
      };
    });

    const workspacePath = "/repo/claude-import";
    const mainSessionId = "006f0b85-a943-4a84-a727-9951ddc1fbf5";
    const sidechainSessionId = "agent-a70cd7b1f0a1bd3e8";
    const projectDir = join(home, ".claude", "projects", "-repo-claude-import");
    const subagentsDir = join(projectDir, mainSessionId, "subagents");
    const copiedSidechainDir = join(projectDir, "copied-sidechains");
    mkdirSync(subagentsDir, { recursive: true });
    mkdirSync(copiedSidechainDir, { recursive: true });

    writeClaudeJsonl(join(projectDir, `${mainSessionId}.jsonl`), [
      {
        type: "user",
        cwd: workspacePath,
        timestamp: "2026-05-25T10:00:00.000Z",
        message: { content: "主会话" },
      },
    ]);
    writeClaudeJsonl(join(subagentsDir, `${sidechainSessionId}.jsonl`), [
      {
        type: "user",
        cwd: workspacePath,
        isSidechain: true,
        timestamp: "2026-05-25T10:01:00.000Z",
        message: { content: "子代理会话" },
      },
    ]);
    writeClaudeJsonl(join(copiedSidechainDir, "agent-copiedsidechain.jsonl"), [
      {
        type: "user",
        cwd: workspacePath,
        isSidechain: true,
        timestamp: "2026-05-25T10:02:00.000Z",
        message: { content: "被复制到普通目录的子代理会话" },
      },
    ]);

    const { ClaudeNativeSessionImportRepo } = await import(
      "#src/session/claude-native/claudeNativeSessionImportRepo.js"
    );
    const repo = new ClaudeNativeSessionImportRepo();

    await expect(repo.scanImportableSessions({ workspacePath })).resolves.toEqual([
      expect.objectContaining({
        sessionId: mainSessionId,
        workspacePath,
      }),
    ]);
    await expect(
      repo.findImportableSession({
        workspacePath,
        sessionId: "agent-copiedsidechain",
      }),
    ).resolves.toBeNull();
    await expect(
      repo.findImportableSession({
        workspacePath,
        sessionId: sidechainSessionId,
      }),
    ).resolves.toBeNull();
  });
});
