import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  STARTUP_AGENT_WARMUP_LIMIT,
  createOpenWorkspaceStartupBootstrap,
  resolveStartupAgentWarmupTargets,
  resolveStartupWindowBootstrap,
  resolveStartupWorkspacePath,
} from "../src/main/startupWorkspace.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("startup workspace", () => {
  it("open-workspace 冷启动目录同时作为首窗初始 workspace 和 agent 预热目标", () => {
    expect(createOpenWorkspaceStartupBootstrap("C:\\Users\\demo\\Project A")).toEqual({
      initialWorkspacePath: "C:\\Users\\demo\\Project A",
      initialWorkspacePurpose: "project",
      agentWarmupTargets: [{ workspacePath: "C:\\Users\\demo\\Project A" }],
    });
  });

  it("启动预热只选 active workspace，recentProjects 不再补位", () => {
    const settings = {
      recentProjects: ["/repo/a", "/repo/b", "/repo/c", "/repo/d", "/repo/e"],
      locale: "zh-CN" as const,
    };

    expect(resolveStartupAgentWarmupTargets(settings, { workspacePath: "/repo/c" })).toEqual([
      { workspacePath: "/repo/c" },
    ]);
    expect(STARTUP_AGENT_WARMUP_LIMIT).toBe(1);
  });

  it("有可恢复会话时不覆盖成默认项目", async () => {
    const rootDir = makeTempDir("zcode-startup-workspace-");
    const settingsFile = join(rootDir, "setting.json");
    const conversationWorkspaceDir = join(rootDir, ".zcode", "workspace", "default");
    const workspaceDir = join(rootDir, "workspace-a");
    mkdirSync(workspaceDir);

    writeFileSync(
      settingsFile,
      JSON.stringify({
        recentProjects: [workspaceDir],
        locale: "zh-CN",
        lastWorkspaceSession: [
          {
            kind: "local",
            workspacePath: workspaceDir,
          },
        ],
        lastActiveTabIndex: 0,
      }),
      "utf-8",
    );

    await expect(
      resolveStartupWorkspacePath({
        settingsFile,
        conversationWorkspaceDir,
      }),
    ).resolves.toBeUndefined();
    expect(existsSync(conversationWorkspaceDir)).toBe(false);
  });

  it("有本地可恢复会话时返回 active workspace 作为 agent 预热目标", async () => {
    const rootDir = makeTempDir("zcode-startup-workspace-");
    const settingsFile = join(rootDir, "setting.json");
    const conversationWorkspaceDir = join(rootDir, ".zcode", "workspace", "default");
    const workspaceA = join(rootDir, "workspace-a");
    const workspaceB = join(rootDir, "workspace-b");
    mkdirSync(workspaceA);
    mkdirSync(workspaceB);

    writeFileSync(
      settingsFile,
      JSON.stringify({
        recentProjects: [workspaceA, workspaceB],
        locale: "zh-CN",
        lastWorkspaceSession: [
          {
            kind: "local",
            workspacePath: workspaceA,
          },
          {
            kind: "local",
            workspacePath: workspaceB,
          },
        ],
        lastActiveTabIndex: 1,
      }),
      "utf-8",
    );

    await expect(
      resolveStartupWindowBootstrap({
        settingsFile,
        conversationWorkspaceDir,
      }),
    ).resolves.toEqual({
      agentWarmupTargets: [{ workspacePath: workspaceB }],
    });
    expect(existsSync(conversationWorkspaceDir)).toBe(false);
  });

  it("active 会话是远端但前面有本地 workspace 时预热本地 workspace", async () => {
    const rootDir = makeTempDir("zcode-startup-workspace-");
    const settingsFile = join(rootDir, "setting.json");
    const conversationWorkspaceDir = join(rootDir, ".zcode", "workspace", "default");

    writeFileSync(
      settingsFile,
      JSON.stringify({
        recentProjects: ["/tmp/workspace-a"],
        locale: "zh-CN",
        lastWorkspaceSession: [
          {
            kind: "local",
            workspacePath: "/tmp/workspace-a",
          },
          {
            kind: "remote",
            workspacePath: "/repo/app",
            workspaceIdentity: "remote:ssh:dev:/repo/app",
            target: {
              kind: "ssh",
              host: "dev",
              username: "dev",
            },
            lastOpenedAt: 1,
            lastConnectionStatus: "connected",
          },
        ],
        lastActiveTabIndex: 1,
      }),
      "utf-8",
    );

    await expect(
      resolveStartupWindowBootstrap({
        settingsFile,
        conversationWorkspaceDir,
      }),
    ).resolves.toEqual({
      agentWarmupTargets: [{ workspacePath: "/tmp/workspace-a" }],
    });
  });

  it("active 会话是远端但后面有本地 workspace 时预热本地 workspace", async () => {
    const rootDir = makeTempDir("zcode-startup-workspace-");
    const settingsFile = join(rootDir, "setting.json");
    const conversationWorkspaceDir = join(rootDir, ".zcode", "workspace", "default");

    writeFileSync(
      settingsFile,
      JSON.stringify({
        recentProjects: ["/tmp/workspace-a"],
        locale: "zh-CN",
        lastWorkspaceSession: [
          {
            kind: "remote",
            workspacePath: "/repo/app",
            workspaceIdentity: "remote:ssh:dev:/repo/app",
            target: {
              kind: "ssh",
              host: "dev",
              username: "dev",
            },
            lastOpenedAt: 1,
            lastConnectionStatus: "connected",
          },
          {
            kind: "local",
            workspacePath: "/tmp/workspace-a",
          },
        ],
        lastActiveTabIndex: 0,
      }),
      "utf-8",
    );

    await expect(
      resolveStartupWindowBootstrap({
        settingsFile,
        conversationWorkspaceDir,
      }),
    ).resolves.toEqual({
      agentWarmupTargets: [{ workspacePath: "/tmp/workspace-a" }],
    });
  });

  it("active 本地 workspace 不存在时保留原路径并创建 agent cwd 兜底目录", async () => {
    const rootDir = makeTempDir("zcode-startup-workspace-");
    const settingsFile = join(rootDir, "setting.json");
    const conversationWorkspaceDir = join(rootDir, ".zcode", "workspace", "default");
    const missingWorkspace = join(rootDir, "moved-workspace");

    writeFileSync(
      settingsFile,
      JSON.stringify({
        lastWorkspaceSession: [{ kind: "local", workspacePath: missingWorkspace }],
        lastActiveTabIndex: 0,
      }),
      "utf-8",
    );

    await expect(
      resolveStartupWindowBootstrap({ settingsFile, conversationWorkspaceDir }),
    ).resolves.toEqual({
      unavailableWorkspacePath: missingWorkspace,
      agentWarmupTargets: [{ workspacePath: missingWorkspace }],
    });
    expect(existsSync(conversationWorkspaceDir)).toBe(true);
    expect(existsSync(missingWorkspace)).toBe(false);
  });

  it("active 本地 workspace 变成文件时按不可用目录处理", async () => {
    const rootDir = makeTempDir("zcode-startup-workspace-");
    const settingsFile = join(rootDir, "setting.json");
    const conversationWorkspaceDir = join(rootDir, ".zcode", "workspace", "default");
    const workspaceFile = join(rootDir, "workspace-file");
    writeFileSync(workspaceFile, "not-a-directory", "utf-8");
    writeFileSync(
      settingsFile,
      JSON.stringify({
        lastWorkspaceSession: [{ kind: "local", workspacePath: workspaceFile }],
        lastActiveTabIndex: 0,
      }),
      "utf-8",
    );

    await expect(
      resolveStartupWindowBootstrap({ settingsFile, conversationWorkspaceDir }),
    ).resolves.toEqual({
      unavailableWorkspacePath: workspaceFile,
      agentWarmupTargets: [{ workspacePath: workspaceFile }],
    });
    expect(existsSync(conversationWorkspaceDir)).toBe(true);
  });

  it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
    "active 本地 workspace 无法访问时按不可用目录处理",
    async () => {
      const rootDir = makeTempDir("zcode-startup-workspace-");
      const settingsFile = join(rootDir, "setting.json");
      const conversationWorkspaceDir = join(rootDir, ".zcode", "workspace", "default");
      const inaccessibleWorkspace = join(rootDir, "inaccessible-workspace");
      mkdirSync(inaccessibleWorkspace);
      chmodSync(inaccessibleWorkspace, 0o000);
      writeFileSync(
        settingsFile,
        JSON.stringify({
          lastWorkspaceSession: [{ kind: "local", workspacePath: inaccessibleWorkspace }],
          lastActiveTabIndex: 0,
        }),
        "utf-8",
      );

      try {
        await expect(
          resolveStartupWindowBootstrap({ settingsFile, conversationWorkspaceDir }),
        ).resolves.toEqual({
          unavailableWorkspacePath: inaccessibleWorkspace,
          agentWarmupTargets: [{ workspacePath: inaccessibleWorkspace }],
        });
        expect(existsSync(conversationWorkspaceDir)).toBe(true);
      } finally {
        chmodSync(inaccessibleWorkspace, 0o700);
      }
    },
  );

  it("active 为远端时不校验本地目录也不创建 conversation workspace", async () => {
    const rootDir = makeTempDir("zcode-startup-workspace-");
    const settingsFile = join(rootDir, "setting.json");
    const conversationWorkspaceDir = join(rootDir, ".zcode", "workspace", "default");
    writeFileSync(
      settingsFile,
      JSON.stringify({
        lastWorkspaceSession: [
          {
            kind: "remote",
            workspacePath: "/missing/on-local-machine",
            workspaceIdentity: "remote:ssh:dev:/missing/on-local-machine",
            target: { kind: "ssh", host: "dev", username: "dev" },
            lastOpenedAt: 1,
            lastConnectionStatus: "connected",
          },
        ],
        lastActiveTabIndex: 0,
      }),
      "utf-8",
    );

    await expect(
      resolveStartupWindowBootstrap({ settingsFile, conversationWorkspaceDir }),
    ).resolves.toEqual({});
    expect(existsSync(conversationWorkspaceDir)).toBe(false);
  });

  it("仅 active 本地 workspace 参与可用性校验", async () => {
    const rootDir = makeTempDir("zcode-startup-workspace-");
    const settingsFile = join(rootDir, "setting.json");
    const conversationWorkspaceDir = join(rootDir, ".zcode", "workspace", "default");
    const activeWorkspace = join(rootDir, "active-workspace");
    const inactiveMissingWorkspace = join(rootDir, "inactive-missing");
    mkdirSync(activeWorkspace);
    writeFileSync(
      settingsFile,
      JSON.stringify({
        lastWorkspaceSession: [
          { kind: "local", workspacePath: inactiveMissingWorkspace },
          { kind: "local", workspacePath: activeWorkspace },
        ],
        lastActiveTabIndex: 1,
      }),
      "utf-8",
    );

    await expect(
      resolveStartupWindowBootstrap({ settingsFile, conversationWorkspaceDir }),
    ).resolves.toEqual({ agentWarmupTargets: [{ workspacePath: activeWorkspace }] });
    expect(existsSync(conversationWorkspaceDir)).toBe(false);
  });

  it("没有可恢复会话时应直接兜底到 conversation backing workspace", async () => {
    const rootDir = makeTempDir("zcode-startup-workspace-");
    const settingsFile = join(rootDir, "setting.json");
    const conversationWorkspaceDir = join(rootDir, ".zcode", "workspace", "default");

    writeFileSync(
      settingsFile,
      JSON.stringify({
        recentProjects: ["/tmp/workspace-a"],
        locale: "zh-CN",
        lastWorkspaceSession: [],
        lastActiveTabIndex: 0,
      }),
      "utf-8",
    );

    await expect(
      resolveStartupWorkspacePath({
        settingsFile,
        conversationWorkspaceDir,
      }),
    ).resolves.toBe(conversationWorkspaceDir);
    expect(existsSync(conversationWorkspaceDir)).toBe(true);
  });

  it("没有可恢复会话时 conversation workspace 也是 agent 预热目标", async () => {
    const rootDir = makeTempDir("zcode-startup-workspace-");
    const settingsFile = join(rootDir, "setting.json");
    const conversationWorkspaceDir = join(rootDir, ".zcode", "workspace", "default");

    writeFileSync(
      settingsFile,
      JSON.stringify({
        recentProjects: [],
        locale: "zh-CN",
        lastWorkspaceSession: [],
        lastActiveTabIndex: 0,
      }),
      "utf-8",
    );

    await expect(
      resolveStartupWindowBootstrap({
        settingsFile,
        conversationWorkspaceDir,
      }),
    ).resolves.toEqual({
      initialWorkspacePath: conversationWorkspaceDir,
      initialWorkspacePurpose: "conversation",
      agentWarmupTargets: [{ workspacePath: conversationWorkspaceDir }],
    });
    expect(existsSync(conversationWorkspaceDir)).toBe(true);
  });
});
