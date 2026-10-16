import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ISettingService } from "../src/setting/setting.js";

const originalHome = process.env.HOME;
const tempHomes: string[] = [];

function makeTempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "zcode-settings-sync-home-"));
  tempHomes.push(home);
  return home;
}

function writeSkill(rootPath: string, folder: string, body: string): void {
  const skillDir = join(rootPath, folder);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), body, "utf-8");
}

function writeCommand(rootPath: string, fileName: string, body: string): void {
  const filePath = join(rootPath, fileName);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, body, "utf-8");
}

function writePlugin(
  rootPath: string,
  folder: string,
  manifest: Record<string, unknown>,
  manifestDir = ".zcode-plugin",
): string {
  const pluginDir = join(rootPath, folder);
  mkdirSync(join(pluginDir, manifestDir), { recursive: true });
  writeFileSync(
    join(pluginDir, manifestDir, "plugin.json"),
    JSON.stringify(manifest),
    "utf-8",
  );
  return pluginDir;
}

function writeJsonConfig(filePath: string, value: Record<string, unknown>): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function writeTextConfig(filePath: string, value: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, value, "utf-8");
}

function createSettingService(): ISettingService {
  return {
    async get() {
      return {};
    },
    async update() {},
    async updateDataBaseDir() {},
    async ensureDefaultProject(path: string) {
      return { path, created: false };
    },
  };
}

afterEach(() => {
  process.env.HOME = originalHome;
  vi.resetModules();
  while (tempHomes.length > 0) {
    const home = tempHomes.pop();
    if (home) {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

describe("settingsSyncService Provider 导入边界", () => {
  it("尚未实现 Provider 数据迁移时明确返回 skipped", async () => {
    const { createSettingsSyncService } = await import(
      "../src/settings-sync/settingsSyncService.js"
    );
    const service = createSettingsSyncService({ settingService: createSettingService() });

    await expect(service.importSelected({
      selections: [{ agent: "claudeCode", category: "providers" }],
    })).resolves.toEqual({
      successCount: 0,
      skippedCount: 1,
      failedCount: 0,
      taskResults: [{
        agent: "claudeCode",
        category: "providers",
        status: "skipped",
        importedCount: 0,
        skippedCount: 1,
        failedCount: 0,
      }],
    });
  });
});

describe("settingsSyncService Claude AGENTS.md migration", () => {
  it("copies Claude user memory into a fresh default ZCode AGENTS.md", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    process.env.HOME = home;
    writeTextConfig(join(home, ".claude", "CLAUDE.md"), "claude memory");
    const { createSettingsSyncService } = await import(
      "../src/settings-sync/settingsSyncService.js"
    );
    const service = createSettingsSyncService({ settingService: createSettingService() });

    await expect(service.getClaudeAgentsFileMigrationStatus({ workspacePath })).resolves.toEqual({
      sourcePath: join(home, ".claude", "CLAUDE.md"),
      targetPath: join(home, ".zcode", "AGENTS.md"),
      sourceExists: true,
      targetExists: false,
      supported: true,
    });
    await expect(service.copyClaudeAgentsFileToZcodeAgentsFile({
      workspacePath,
      overwrite: false,
    })).resolves.toEqual({
      sourcePath: join(home, ".claude", "CLAUDE.md"),
      targetPath: join(home, ".zcode", "AGENTS.md"),
      status: "copied",
      overwritten: false,
    });
    expect(readFileSync(join(home, ".zcode", "AGENTS.md"), "utf-8")).toBe("claude memory");
  });

  it("detects and overwrites default ZCode AGENTS.md from Claude user memory", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    process.env.HOME = home;
    writeTextConfig(join(home, ".claude", "CLAUDE.md"), "claude memory");
    writeTextConfig(join(home, ".zcode", "AGENTS.md"), "existing agents");
    const { createSettingsSyncService } = await import(
      "../src/settings-sync/settingsSyncService.js"
    );
    const service = createSettingsSyncService({ settingService: createSettingService() });

    const status = await service.getClaudeAgentsFileMigrationStatus({ workspacePath });

    expect(status).toEqual({
      sourcePath: join(home, ".claude", "CLAUDE.md"),
      targetPath: join(home, ".zcode", "AGENTS.md"),
      sourceExists: true,
      targetExists: true,
      supported: true,
    });

    await expect(service.copyClaudeAgentsFileToZcodeAgentsFile({
      workspacePath,
      overwrite: false,
    })).resolves.toEqual({
      sourcePath: join(home, ".claude", "CLAUDE.md"),
      targetPath: join(home, ".zcode", "AGENTS.md"),
      status: "skipped",
      overwritten: false,
      skippedReason: "targetExists",
    });
    expect(readFileSync(join(home, ".zcode", "AGENTS.md"), "utf-8")).toBe("existing agents");

    await expect(service.copyClaudeAgentsFileToZcodeAgentsFile({
      workspacePath,
      overwrite: true,
    })).resolves.toEqual({
      sourcePath: join(home, ".claude", "CLAUDE.md"),
      targetPath: join(home, ".zcode", "AGENTS.md"),
      status: "copied",
      overwritten: true,
    });
    expect(readFileSync(join(home, ".zcode", "AGENTS.md"), "utf-8")).toBe("claude memory");
  });

  it("reports missing Claude user memory as unsupported", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    process.env.HOME = home;
    const { createSettingsSyncService } = await import(
      "../src/settings-sync/settingsSyncService.js"
    );
    const service = createSettingsSyncService({ settingService: createSettingService() });

    await expect(service.getClaudeAgentsFileMigrationStatus({ workspacePath })).resolves.toEqual({
      sourcePath: join(home, ".claude", "CLAUDE.md"),
      targetPath: join(home, ".zcode", "AGENTS.md"),
      sourceExists: false,
      targetExists: false,
      supported: false,
      unavailableReason: "missingSource",
    });
    await expect(service.copyClaudeAgentsFileToZcodeAgentsFile({
      workspacePath,
      overwrite: true,
    })).resolves.toEqual({
      sourcePath: join(home, ".claude", "CLAUDE.md"),
      targetPath: join(home, ".zcode", "AGENTS.md"),
      status: "skipped",
      overwritten: false,
      skippedReason: "missingSource",
    });
  });
});

describe("settingsSyncService commands import", () => {
  it("uses file symlink type for command imports", async () => {
    const { getCommandFileSymlinkType } = await import(
      "../src/settings-sync/settingsSyncService.js"
    );

    expect(getCommandFileSymlinkType()).toBe("file");
  });

  it("does not scan external commands during first-run detection", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    process.env.HOME = home;
    writeCommand(
      join(home, ".claude", "commands"),
      "review.md",
      "---\ndescription: review\n---\nreview body",
    );
    const { createSettingsSyncService } = await import(
      "../src/settings-sync/settingsSyncService.js"
    );
    const service = createSettingsSyncService({ settingService: createSettingService() });

    await expect(service.detect({ workspacePath })).resolves.toEqual({ agents: [] });
  });

  it("scans and imports selected user commands into ZCode as symlinks by default", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    process.env.HOME = home;
    writeCommand(
      join(home, ".claude", "commands"),
      "review.md",
      "---\ndescription: review\nargument-hint: <file>\n---\nreview body",
    );
    writeCommand(
      join(home, ".claude", "commands"),
      "Git/commit.md",
      "---\ndescription: commit\n---\ncommit body",
    );
    const { createSettingsSyncService } = await import(
      "../src/settings-sync/settingsSyncService.js"
    );
    const service = createSettingsSyncService({ settingService: createSettingService() });

    const discovery = await service.detect({
      workspacePath,
      categories: ["commands"],
      intent: "manualImport",
    });

    expect(discovery.agents).toEqual([
      {
        agent: "claudeCode",
        discovered: true,
        categories: [
          {
            category: "commands",
            discoveredCount: 2,
            importableCount: 2,
            skippedCount: 0,
            sourcePaths: [join(home, ".claude", "commands")],
            sourceRoots: [{
              scope: "global",
              path: join(home, ".claude", "commands"),
              discoveredCount: 2,
              importableCount: 2,
              skippedCount: 0,
              commands: [
                {
                  name: "/Git/commit",
                  path: join(home, ".claude", "commands", "Git", "commit.md"),
                  importable: true,
                  description: "commit",
                },
                {
                  name: "/review",
                  path: join(home, ".claude", "commands", "review.md"),
                  importable: true,
                  description: "review",
                  argumentHint: "<file>",
                },
              ],
            }],
            selectedByDefault: false,
          },
        ],
      },
    ]);

    const result = await service.importSelected({
      workspacePath,
      selections: [{ agent: "claudeCode", category: "commands" }],
    });

    const importedPath = join(home, ".zcode", "commands", "review.md");
    expect(result.successCount).toBe(2);
    expect(result.skippedCount).toBe(0);
    expect(result.failedCount).toBe(0);
    expect(result.taskResults[0]?.commandResults).toEqual([
      {
        name: "/Git/commit",
        path: join(home, ".claude", "commands", "Git", "commit.md"),
        sourceScope: "global",
        status: "imported",
      },
      {
        name: "/review",
        path: join(home, ".claude", "commands", "review.md"),
        sourceScope: "global",
        status: "imported",
      },
    ]);
    expect(existsSync(importedPath)).toBe(true);
    // Windows 使用硬链接（普通文件），非 Windows 使用 symlink
    if (process.platform === "win32") {
      expect(lstatSync(importedPath).isFile()).toBe(true);
    } else {
      expect(lstatSync(importedPath).isSymbolicLink()).toBe(true);
    }
    expect(readFileSync(importedPath, "utf-8")).toContain("review body");
    expect(existsSync(join(home, ".zcode", "commands", "Git", "commit.md"))).toBe(true);
  });

  it("scans global Claude commands without an active workspace", async () => {
    const home = makeTempHome();
    process.env.HOME = home;
    writeCommand(join(home, ".claude", "commands"), "dev.md", "dev body");
    const { createSettingsSyncService } = await import(
      "../src/settings-sync/settingsSyncService.js"
    );
    const service = createSettingsSyncService({ settingService: createSettingService() });

    const discovery = await service.detect({
      categories: ["commands"],
      intent: "manualImport",
    });

    expect(discovery.agents).toEqual([
      {
        agent: "claudeCode",
        discovered: true,
        categories: [
          {
            category: "commands",
            discoveredCount: 1,
            importableCount: 1,
            skippedCount: 0,
            sourcePaths: [join(home, ".claude", "commands")],
            sourceRoots: [{
              scope: "global",
              path: join(home, ".claude", "commands"),
              discoveredCount: 1,
              importableCount: 1,
              skippedCount: 0,
              commands: [{
                name: "/dev",
                path: join(home, ".claude", "commands", "dev.md"),
                importable: true,
              }],
            }],
            selectedByDefault: false,
          },
        ],
      },
    ]);
  });

  it("imports only selected command paths from a source", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    process.env.HOME = home;
    writeCommand(join(home, ".codex", "commands"), "review.md", "review body");
    writeCommand(join(home, ".codex", "commands"), "write.md", "write body");
    const { createSettingsSyncService } = await import(
      "../src/settings-sync/settingsSyncService.js"
    );
    const service = createSettingsSyncService({ settingService: createSettingService() });

    const result = await service.importSelected({
      workspacePath,
      selections: [{
        agent: "codexCli",
        category: "commands",
        sourceScope: "global",
        commandPaths: [join(home, ".codex", "commands", "write.md")],
      }],
    });

    expect(result.successCount).toBe(1);
    expect(existsSync(join(home, ".zcode", "commands", "write.md"))).toBe(true);
    expect(existsSync(join(home, ".zcode", "commands", "review.md"))).toBe(false);
  });

  it("imports selected commands into the requested project target as copies", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    process.env.HOME = home;
    writeCommand(join(home, ".qwen", "commands"), "review/code.md", "review body");
    const { createSettingsSyncService } = await import(
      "../src/settings-sync/settingsSyncService.js"
    );
    const service = createSettingsSyncService({ settingService: createSettingService() });

    const result = await service.importSelected({
      workspacePath,
      selections: [{
        agent: "qwenCode",
        category: "commands",
        sourceScope: "global",
        targetScope: "project",
        importMode: "copy",
        commandPaths: [join(home, ".qwen", "commands", "review", "code.md")],
      }],
    });

    const importedPath = join(workspacePath, ".zcode", "commands", "review", "code.md");
    expect(result.successCount).toBe(1);
    expect(existsSync(importedPath)).toBe(true);
    expect(lstatSync(importedPath).isSymbolicLink()).toBe(false);
    expect(readFileSync(importedPath, "utf-8")).toContain("review body");
    expect(existsSync(join(home, ".zcode", "commands", "review", "code.md"))).toBe(false);
  });

  it("does not scan .agents commands for import", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    process.env.HOME = home;
    writeCommand(join(home, ".agents", "commands"), "already.md", "already");
    writeCommand(join(workspacePath, ".agents", "commands"), "project.md", "project");
    const { createSettingsSyncService } = await import(
      "../src/settings-sync/settingsSyncService.js"
    );
    const service = createSettingsSyncService({ settingService: createSettingService() });

    await expect(service.detect({
      workspacePath,
      categories: ["commands"],
      intent: "manualImport",
    })).resolves.toEqual({ agents: [] });
  });

  it("skips command imports when target file or same command name exists", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    process.env.HOME = home;
    writeCommand(join(home, ".claude", "commands"), "review.md", "source");
    writeCommand(join(home, ".codex", "commands"), "other-review.md", "source");
    writeCommand(join(home, ".zcode", "commands"), "review.md", "existing");
    const { createSettingsSyncService } = await import(
      "../src/settings-sync/settingsSyncService.js"
    );
    const service = createSettingsSyncService({ settingService: createSettingService() });

    const discovery = await service.detect({
      workspacePath,
      categories: ["commands"],
      intent: "manualImport",
    });

    expect(discovery.agents[0]?.categories[0]?.sourceRoots?.[0]?.commands).toEqual([{
      name: "/review",
      path: join(home, ".claude", "commands", "review.md"),
      importable: false,
      skipReason: "targetExists",
    }]);
    expect(discovery.agents[1]?.categories[0]?.sourceRoots?.[0]?.commands).toEqual([{
      name: "/other-review",
      path: join(home, ".codex", "commands", "other-review.md"),
      importable: true,
    }]);

    writeCommand(join(home, ".zcode", "commands"), "other-review.md", "existing");
    const result = await service.importSelected({
      workspacePath,
      selections: [{ agent: "codexCli", category: "commands" }],
    });

    expect(result.successCount).toBe(0);
    expect(result.skippedCount).toBe(1);
    expect(result.taskResults[0]?.commandResults).toEqual([{
      name: "/other-review",
      path: join(home, ".codex", "commands", "other-review.md"),
      sourceScope: "global",
      status: "skipped",
      skipReason: "targetExists",
    }]);
  });
});

describe("settingsSyncService plugins import", () => {
  it("does not scan external plugins during first-run detection", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    process.env.HOME = home;
    writePlugin(join(home, ".claude", "plugins"), "review-plugin", {
      name: "review-plugin",
    });
    const { createSettingsSyncService } = await import(
      "../src/settings-sync/settingsSyncService.js"
    );
    const service = createSettingsSyncService({ settingService: createSettingService() });

    await expect(service.detect({ workspacePath })).resolves.toEqual({ agents: [] });
  });

  it("scans and imports selected user plugins as symlinks by default", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    process.env.HOME = home;
    const pluginPath = writePlugin(join(home, ".claude", "plugins"), "review-plugin", {
      name: "review-plugin",
      version: "1.2.3",
      description: "review",
    });
    const { createSettingsSyncService } = await import(
      "../src/settings-sync/settingsSyncService.js"
    );
    const service = createSettingsSyncService({ settingService: createSettingService() });

    const discovery = await service.detect({
      workspacePath,
      categories: ["plugins"],
      intent: "manualImport",
    });

    expect(discovery.agents).toEqual([
      {
        agent: "claudeCode",
        discovered: true,
        categories: [
          {
            category: "plugins",
            discoveredCount: 1,
            importableCount: 1,
            skippedCount: 0,
            sourcePaths: [join(home, ".claude", "plugins")],
            sourceRoots: [{
              scope: "global",
              path: join(home, ".claude", "plugins"),
              discoveredCount: 1,
              importableCount: 1,
              skippedCount: 0,
              plugins: [{
                name: "review-plugin",
                path: pluginPath,
                importable: true,
                version: "1.2.3",
              }],
            }],
            selectedByDefault: false,
          },
        ],
      },
    ]);

    const result = await service.importSelected({
      workspacePath,
      selections: [{ agent: "claudeCode", category: "plugins" }],
    });

    const importedPath = join(home, ".zcode", "plugins", "review-plugin");
    const config = JSON.parse(
      readFileSync(join(home, ".zcode", "cli", "config.json"), "utf-8"),
    ) as { plugins?: { dirs?: string[] } };
    expect(result.successCount).toBe(1);
    expect(result.skippedCount).toBe(0);
    expect(result.failedCount).toBe(0);
    expect(result.taskResults[0]?.pluginResults).toEqual([{
      name: "review-plugin",
      path: pluginPath,
      sourceScope: "global",
      status: "imported",
      version: "1.2.3",
    }]);
    expect(existsSync(join(importedPath, ".zcode-plugin", "plugin.json"))).toBe(true);
    expect(lstatSync(importedPath).isSymbolicLink()).toBe(true);
    expect(config.plugins?.dirs).toEqual([importedPath]);
  });

  it("imports Claude-manifest plugins into the requested project target as copies", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    process.env.HOME = home;
    const pluginPath = writePlugin(
      join(home, ".codex", "plugins"),
      "writer-plugin",
      { name: "writer-plugin" },
      ".claude-plugin",
    );
    const { createSettingsSyncService } = await import(
      "../src/settings-sync/settingsSyncService.js"
    );
    const service = createSettingsSyncService({ settingService: createSettingService() });

    const result = await service.importSelected({
      workspacePath,
      selections: [{
        agent: "codexCli",
        category: "plugins",
        sourceScope: "global",
        targetScope: "project",
        importMode: "copy",
        pluginPaths: [pluginPath],
      }],
    });

    const importedPath = join(workspacePath, ".zcode", "plugins", "writer-plugin");
    const config = JSON.parse(
      readFileSync(join(workspacePath, ".zcode", "config.json"), "utf-8"),
    ) as { plugins?: { dirs?: string[] } };
    expect(result.successCount).toBe(1);
    expect(lstatSync(importedPath).isSymbolicLink()).toBe(false);
    expect(existsSync(join(importedPath, ".claude-plugin", "plugin.json"))).toBe(true);
    expect(config.plugins?.dirs).toEqual([importedPath]);
    expect(existsSync(join(home, ".zcode", "plugins", "writer-plugin"))).toBe(false);
  });

  it("skips plugin imports when target directory or same plugin id exists", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    process.env.HOME = home;
    writePlugin(join(home, ".claude", "plugins"), "review-plugin", {
      name: "review-plugin",
    });
    writePlugin(join(home, ".codex", "plugins"), "other-review", {
      name: "other-review",
    });
    writePlugin(join(home, ".zcode", "plugins"), "review-plugin", {
      name: "review-plugin",
    });
    const configuredPluginPath = writePlugin(join(home, "configured"), "other-review", {
      name: "other-review",
    });
    mkdirSync(join(home, ".zcode", "cli"), { recursive: true });
    writeFileSync(
      join(home, ".zcode", "cli", "config.json"),
      JSON.stringify({ plugins: { dirs: [configuredPluginPath] } }),
      "utf-8",
    );
    const { createSettingsSyncService } = await import(
      "../src/settings-sync/settingsSyncService.js"
    );
    const service = createSettingsSyncService({ settingService: createSettingService() });

    const discovery = await service.detect({
      workspacePath,
      categories: ["plugins"],
      intent: "manualImport",
    });

    expect(discovery.agents[0]?.categories[0]?.sourceRoots?.[0]?.plugins).toEqual([{
      name: "review-plugin",
      path: join(home, ".claude", "plugins", "review-plugin"),
      importable: false,
      skipReason: "targetExists",
    }]);
    expect(discovery.agents[1]?.categories[0]?.sourceRoots?.[0]?.plugins).toEqual([{
      name: "other-review",
      path: join(home, ".codex", "plugins", "other-review"),
      importable: false,
      skipReason: "sameNameExists",
    }]);

    const result = await service.importSelected({
      workspacePath,
      selections: [{ agent: "codexCli", category: "plugins" }],
    });

    expect(result.successCount).toBe(0);
    expect(result.skippedCount).toBe(1);
    expect(result.taskResults[0]?.pluginResults).toEqual([{
      name: "other-review",
      path: join(home, ".codex", "plugins", "other-review"),
      sourceScope: "global",
      status: "skipped",
      skipReason: "sameNameExists",
    }]);
  });
});

describe("settingsSyncService MCP server import", () => {
  it("does not scan external MCP servers during first-run detection", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    process.env.HOME = home;
    writeJsonConfig(join(home, ".claude", "settings.json"), {
      mcpServers: {
        browser: { command: "npx", args: ["-y", "browser-mcp"], timeout: 30 },
      },
    });
    const { createSettingsSyncService } = await import(
      "../src/settings-sync/settingsSyncService.js"
    );
    const service = createSettingsSyncService({ settingService: createSettingService() });

    await expect(service.detect({ workspacePath })).resolves.toEqual({ agents: [] });
  });

  it("scans and imports selected Claude MCP servers into global ZCode config", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    process.env.HOME = home;
    writeJsonConfig(join(home, ".claude", "settings.json"), {
      mcpServers: {
        browser: { command: "npx", args: ["-y", "browser-mcp"] },
      },
    });
    const { createSettingsSyncService } = await import(
      "../src/settings-sync/settingsSyncService.js"
    );
    const service = createSettingsSyncService({ settingService: createSettingService() });

    const discovery = await service.detect({
      workspacePath,
      categories: ["mcpServers"],
      intent: "manualImport",
    });

    expect(discovery.agents).toEqual([
      {
        agent: "claudeCode",
        discovered: true,
        categories: [
          {
            category: "mcpServers",
            discoveredCount: 1,
            importableCount: 1,
            skippedCount: 0,
            sourcePaths: [join(home, ".claude", "settings.json")],
            sourceRoots: [{
              scope: "global",
              path: join(home, ".claude", "settings.json"),
              discoveredCount: 1,
              importableCount: 1,
              skippedCount: 0,
              mcpServers: [{
                name: "browser",
                path: `${join(home, ".claude", "settings.json")}#browser`,
                importable: true,
              }],
            }],
            selectedByDefault: false,
          },
        ],
      },
    ]);

    const result = await service.importSelected({
      workspacePath,
      selections: [{
        agent: "claudeCode",
        category: "mcpServers",
        mcpServerPaths: [`${join(home, ".claude", "settings.json")}#browser`],
      }],
    });

    const config = JSON.parse(
      readFileSync(join(home, ".zcode", "cli", "config.json"), "utf-8"),
    ) as { mcp?: { servers?: Record<string, unknown> } };
    expect(result.successCount).toBe(1);
    expect(result.skippedCount).toBe(0);
    expect(result.taskResults[0]?.mcpServerResults).toEqual([{
      name: "browser",
      path: `${join(home, ".claude", "settings.json")}#browser`,
      sourceScope: "global",
      status: "imported",
    }]);
    expect(config.mcp?.servers?.browser).toEqual({
      command: "npx",
      args: ["-y", "browser-mcp"],
    });
  });

  it("does not migrate external MCP timeout fields", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    process.env.HOME = home;
    writeTextConfig(
      join(home, ".codex", "config.toml"),
      [
        "[mcp_servers.context7]",
        'command = "npx"',
        'args = ["-y", "@upstash/context7-mcp"]',
        "startup_timeout_sec = 120",
        "timeout = 30",
      ].join("\n"),
    );
    const { createSettingsSyncService } = await import(
      "../src/settings-sync/settingsSyncService.js"
    );
    const service = createSettingsSyncService({ settingService: createSettingService() });

    const result = await service.importSelected({
      workspacePath,
      selections: [{ agent: "codexCli", category: "mcpServers" }],
    });

    const config = JSON.parse(
      readFileSync(join(home, ".zcode", "cli", "config.json"), "utf-8"),
    ) as { mcp?: { servers?: Record<string, unknown> } };
    expect(result.successCount).toBe(1);
    expect(config.mcp?.servers?.context7).toEqual({
      command: "npx",
      args: ["-y", "@upstash/context7-mcp"],
    });
  });

  it("imports Codex TOML MCP servers into the requested project target", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    process.env.HOME = home;
    writeTextConfig(
      join(home, ".codex", "config.toml"),
      [
        "[mcp_servers.context7]",
        'command = "npx"',
        'args = ["-y", "@upstash/context7-mcp"]',
      ].join("\n"),
    );
    const { createSettingsSyncService } = await import(
      "../src/settings-sync/settingsSyncService.js"
    );
    const service = createSettingsSyncService({ settingService: createSettingService() });

    const result = await service.importSelected({
      workspacePath,
      selections: [{
        agent: "codexCli",
        category: "mcpServers",
        sourceScope: "global",
        targetScope: "project",
      }],
    });

    const config = JSON.parse(
      readFileSync(join(workspacePath, ".zcode", "config.json"), "utf-8"),
    ) as { mcp?: { servers?: Record<string, unknown> } };
    expect(result.successCount).toBe(1);
    expect(config.mcp?.servers?.context7).toEqual({
      command: "npx",
      args: ["-y", "@upstash/context7-mcp"],
    });
    expect(existsSync(join(home, ".zcode", "cli", "config.json"))).toBe(false);
  });

  it("normalizes OpenCode command arrays when importing MCP servers", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    process.env.HOME = home;
    writeJsonConfig(join(home, ".config", "opencode", "opencode.json"), {
      mcp: {
        browser: {
          type: "local",
          command: ["npx", "-y", "browser-mcp"],
          env: { DEBUG: "1" },
        },
      },
    });
    const { createSettingsSyncService } = await import(
      "../src/settings-sync/settingsSyncService.js"
    );
    const service = createSettingsSyncService({ settingService: createSettingService() });

    const result = await service.importSelected({
      workspacePath,
      selections: [{ agent: "openCode", category: "mcpServers" }],
    });

    const config = JSON.parse(
      readFileSync(join(home, ".zcode", "cli", "config.json"), "utf-8"),
    ) as { mcp?: { servers?: Record<string, unknown> } };
    expect(result.successCount).toBe(1);
    expect(config.mcp?.servers?.browser).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "browser-mcp"],
      env: { DEBUG: "1" },
    });
  });

  it("skips imported MCP servers when the target already has the same name", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    process.env.HOME = home;
    writeJsonConfig(join(home, ".claude", "settings.json"), {
      mcpServers: {
        browser: { command: "external" },
      },
    });
    writeJsonConfig(join(home, ".zcode", "cli", "config.json"), {
      mcp: {
        servers: {
          browser: { command: "existing" },
        },
      },
    });
    const { createSettingsSyncService } = await import(
      "../src/settings-sync/settingsSyncService.js"
    );
    const service = createSettingsSyncService({ settingService: createSettingService() });

    const discovery = await service.detect({
      workspacePath,
      categories: ["mcpServers"],
      intent: "manualImport",
    });

    expect(discovery.agents[0]?.categories[0]?.sourceRoots?.[0]?.mcpServers).toEqual([{
      name: "browser",
      path: `${join(home, ".claude", "settings.json")}#browser`,
      importable: false,
      skipReason: "sameNameExists",
    }]);

    const result = await service.importSelected({
      workspacePath,
      selections: [{ agent: "claudeCode", category: "mcpServers" }],
    });
    const config = JSON.parse(
      readFileSync(join(home, ".zcode", "cli", "config.json"), "utf-8"),
    ) as { mcp?: { servers?: Record<string, unknown> } };
    expect(result.successCount).toBe(0);
    expect(result.skippedCount).toBe(1);
    expect(config.mcp?.servers?.browser).toEqual({ command: "existing" });
  });
});

describe("settingsSyncService skills import", () => {
  it("uses platform-specific directory symlink types", async () => {
    const { getSkillDirectorySymlinkType } = await import(
      "../src/settings-sync/settingsSyncService.js"
    );

    expect(getSkillDirectorySymlinkType("darwin")).toBe("dir");
    expect(getSkillDirectorySymlinkType("linux")).toBe("dir");
    expect(getSkillDirectorySymlinkType("win32")).toBe("junction");
  });

  it("does not scan external skills during first-run detection", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    process.env.HOME = home;
    writeSkill(
      join(home, ".claude", "skills"),
      "review",
      "---\nname: review\nversion: 1.2.3\ndescription: review\n---\nbody",
    );
    const { createSettingsSyncService } = await import(
      "../src/settings-sync/settingsSyncService.js"
    );
    const service = createSettingsSyncService({ settingService: createSettingService() });

    await expect(service.detect({ workspacePath })).resolves.toEqual({ agents: [] });
  });

  it("imports selected user skills into the ZCode user skills directory as symlinks by default", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    process.env.HOME = home;
    writeSkill(
      join(home, ".claude", "skills"),
      "review",
      "---\nname: review\nversion: 1.2.3\ndescription: review\n---\nbody",
    );
    const { createSettingsSyncService } = await import(
      "../src/settings-sync/settingsSyncService.js"
    );
    const service = createSettingsSyncService({ settingService: createSettingService() });

    const discovery = await service.detect({
      workspacePath,
      categories: ["skills"],
      intent: "manualImport",
    });
    expect(discovery.agents).toEqual([
      {
        agent: "claudeCode",
        discovered: true,
        categories: [
          {
            category: "skills",
            discoveredCount: 1,
            importableCount: 1,
            skippedCount: 0,
            sourcePaths: [join(home, ".claude", "skills")],
            sourceRoots: [{
              scope: "global",
              path: join(home, ".claude", "skills"),
              discoveredCount: 1,
              importableCount: 1,
              skippedCount: 0,
              skills: [{
                name: "review",
                path: join(home, ".claude", "skills", "review"),
                importable: true,
                version: "1.2.3",
              }],
            }],
            selectedByDefault: true,
          },
        ],
      },
    ]);

    const result = await service.importSelected({
      workspacePath,
      selections: [{ agent: "claudeCode", category: "skills" }],
    });

    expect(result.successCount).toBe(1);
    expect(result.skippedCount).toBe(0);
    expect(result.failedCount).toBe(0);
    expect(result.taskResults[0]?.skillResults).toEqual([{
      name: "review",
      path: join(home, ".claude", "skills", "review"),
      sourceScope: "global",
      status: "imported",
      version: "1.2.3",
    }]);
    const importedDirectoryPath = join(home, ".zcode", "skills", "review");
    const importedPath = join(importedDirectoryPath, "SKILL.md");
    expect(existsSync(importedPath)).toBe(true);
    expect(lstatSync(importedDirectoryPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(importedPath, "utf-8")).toContain("name: review");
    expect(readFileSync(importedPath, "utf-8")).toContain("version: 1.2.3");
  });

  it("imports only selected skill paths from a source", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    process.env.HOME = home;
    writeSkill(
      join(home, ".claude", "skills"),
      "review",
      "---\nname: review\ndescription: review\n---\nreview-body",
    );
    writeSkill(
      join(home, ".claude", "skills"),
      "writer",
      "---\nname: writer\ndescription: writer\n---\nwriter-body",
    );
    const { createSettingsSyncService } = await import(
      "../src/settings-sync/settingsSyncService.js"
    );
    const service = createSettingsSyncService({ settingService: createSettingService() });

    const result = await service.importSelected({
      workspacePath,
      selections: [{
        agent: "claudeCode",
        category: "skills",
        sourceScope: "global",
        skillPaths: [join(home, ".claude", "skills", "writer")],
      }],
    });

    expect(result.successCount).toBe(1);
    expect(result.skippedCount).toBe(0);
    expect(result.failedCount).toBe(0);
    expect(existsSync(join(home, ".zcode", "skills", "writer", "SKILL.md"))).toBe(true);
    expect(existsSync(join(home, ".zcode", "skills", "review", "SKILL.md"))).toBe(false);
  });

  it("imports selected skills into the requested project target", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    process.env.HOME = home;
    writeSkill(
      join(home, ".claude", "skills"),
      "review",
      "---\nname: review\ndescription: review\n---\nreview-body",
    );
    const { createSettingsSyncService } = await import(
      "../src/settings-sync/settingsSyncService.js"
    );
    const service = createSettingsSyncService({ settingService: createSettingService() });

    const result = await service.importSelected({
      workspacePath,
      selections: [{
        agent: "claudeCode",
        category: "skills",
        sourceScope: "global",
        targetScope: "project",
        skillPaths: [join(home, ".claude", "skills", "review")],
      }],
    });

    expect(result.successCount).toBe(1);
    expect(result.skippedCount).toBe(0);
    expect(result.failedCount).toBe(0);
    expect(existsSync(join(workspacePath, ".zcode", "skills", "review", "SKILL.md")))
      .toBe(true);
    expect(existsSync(join(home, ".zcode", "skills", "review", "SKILL.md"))).toBe(false);
  });

  it("can import selected skills as symlinks", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    process.env.HOME = home;
    writeSkill(
      join(home, ".claude", "skills"),
      "linked-review",
      "---\nname: linked-review\ndescription: review\n---\nreview-body",
    );
    const { createSettingsSyncService } = await import(
      "../src/settings-sync/settingsSyncService.js"
    );
    const service = createSettingsSyncService({ settingService: createSettingService() });

    const result = await service.importSelected({
      workspacePath,
      selections: [{
        agent: "claudeCode",
        category: "skills",
        sourceScope: "global",
        importMode: "symlink",
        skillPaths: [join(home, ".claude", "skills", "linked-review")],
      }],
    });

    const targetPath = join(home, ".zcode", "skills", "linked-review");
    expect(result.successCount).toBe(1);
    expect(lstatSync(targetPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(targetPath, "SKILL.md"), "utf-8")).toContain("linked-review");
  });

  it("can import selected skills as copies when requested", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    process.env.HOME = home;
    writeSkill(
      join(home, ".claude", "skills"),
      "copied-review",
      "---\nname: copied-review\ndescription: review\n---\nreview-body",
    );
    const { createSettingsSyncService } = await import(
      "../src/settings-sync/settingsSyncService.js"
    );
    const service = createSettingsSyncService({ settingService: createSettingService() });

    const result = await service.importSelected({
      workspacePath,
      selections: [{
        agent: "claudeCode",
        category: "skills",
        sourceScope: "global",
        importMode: "copy",
        skillPaths: [join(home, ".claude", "skills", "copied-review")],
      }],
    });

    const targetPath = join(home, ".zcode", "skills", "copied-review");
    expect(result.successCount).toBe(1);
    expect(lstatSync(targetPath).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(targetPath, "SKILL.md"), "utf-8")).toContain("copied-review");
  });

  it("scans and imports global skills without an active workspace", async () => {
    const home = makeTempHome();
    process.env.HOME = home;
    writeSkill(
      join(home, ".codex", "skills"),
      "commit-helper",
      "---\nname: commit-helper\ndescription: commit\n---\nbody",
    );
    const { createSettingsSyncService } = await import(
      "../src/settings-sync/settingsSyncService.js"
    );
    const service = createSettingsSyncService({ settingService: createSettingService() });

    const discovery = await service.detect({
      categories: ["skills"],
      intent: "manualImport",
    });
    expect(discovery.agents).toEqual([
      {
        agent: "codexCli",
        discovered: true,
        categories: [
          {
            category: "skills",
            discoveredCount: 1,
            importableCount: 1,
            skippedCount: 0,
            sourcePaths: [join(home, ".codex", "skills")],
            sourceRoots: [{
              scope: "global",
              path: join(home, ".codex", "skills"),
              discoveredCount: 1,
              importableCount: 1,
              skippedCount: 0,
              skills: [{
                name: "commit-helper",
                path: join(home, ".codex", "skills", "commit-helper"),
                importable: true,
              }],
            }],
            selectedByDefault: true,
          },
        ],
      },
    ]);

    const result = await service.importSelected({
      selections: [{ agent: "codexCli", category: "skills" }],
    });

    expect(result.successCount).toBe(1);
    expect(existsSync(join(home, ".zcode", "skills", "commit-helper", "SKILL.md")))
      .toBe(true);
  });

  it("does not scan .agents skills for import", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    process.env.HOME = home;
    writeSkill(
      join(home, ".agents", "skills"),
      "already-readable",
      "---\nname: already-readable\ndescription: agents\n---\nbody",
    );
    writeSkill(
      join(workspacePath, ".agents", "skills"),
      "project-readable",
      "---\nname: project-readable\ndescription: project agents\n---\nbody",
    );
    const { createSettingsSyncService } = await import(
      "../src/settings-sync/settingsSyncService.js"
    );
    const service = createSettingsSyncService({ settingService: createSettingService() });

    await expect(service.detect({
      workspacePath,
      categories: ["skills"],
      intent: "manualImport",
    })).resolves.toEqual({ agents: [] });
  });

  it("scans newly supported non-.agents skill roots", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    process.env.HOME = home;
    writeSkill(
      join(home, ".codeium", "windsurf", "skills"),
      "wave",
      "---\nname: wave\ndescription: windsurf\n---\nbody",
    );
    writeSkill(
      join(home, ".openclaw", "skills"),
      "claw",
      "---\nname: claw\ndescription: openclaw\n---\nbody",
    );
    writeSkill(
      join(home, ".qwen", "skills"),
      "qwen-skill",
      "---\nname: qwen-skill\ndescription: qwen code\n---\nbody",
    );
    writeSkill(
      join(home, ".qoder", "skills"),
      "qode-skill",
      "---\nname: qode-skill\ndescription: qode\n---\nbody",
    );
    writeSkill(
      join(home, ".qoder-cn", "skills"),
      "qode-cn-skill",
      "---\nname: qode-cn-skill\ndescription: qode cn\n---\nbody",
    );
    writeSkill(
      join(home, ".trae-cn", "skills"),
      "trae-cn-skill",
      "---\nname: trae-cn-skill\ndescription: trae cn\n---\nbody",
    );
    writeSkill(
      join(workspacePath, ".codebuddy", "skills"),
      "buddy",
      "---\nname: buddy\ndescription: codebuddy\n---\nbody",
    );
    const { createSettingsSyncService } = await import(
      "../src/settings-sync/settingsSyncService.js"
    );
    const service = createSettingsSyncService({ settingService: createSettingService() });

    const discovery = await service.detect({
      workspacePath,
      categories: ["skills"],
      intent: "manualImport",
    });

    expect(discovery.agents.map((agent) => agent.agent)).toEqual([
      "openClaw",
      "qwenCode",
      "qode",
      "qodeCn",
      "windsurf",
      "traeCn",
      "codeBuddy",
    ]);
    expect(discovery.agents[0]?.categories[0]?.sourceRoots?.[0]).toMatchObject({
      scope: "global",
      path: join(home, ".openclaw", "skills"),
      discoveredCount: 1,
      importableCount: 1,
    });
    expect(discovery.agents[1]?.categories[0]?.sourceRoots?.[0]).toMatchObject({
      scope: "global",
      path: join(home, ".qwen", "skills"),
      discoveredCount: 1,
      importableCount: 1,
    });
    expect(discovery.agents[2]?.categories[0]?.sourceRoots?.[0]).toMatchObject({
      scope: "global",
      path: join(home, ".qoder", "skills"),
      discoveredCount: 1,
      importableCount: 1,
    });
    expect(discovery.agents[3]?.categories[0]?.sourceRoots?.[0]).toMatchObject({
      scope: "global",
      path: join(home, ".qoder-cn", "skills"),
      discoveredCount: 1,
      importableCount: 1,
    });
    expect(discovery.agents[4]?.categories[0]?.sourceRoots?.[0]).toMatchObject({
      scope: "global",
      path: join(home, ".codeium", "windsurf", "skills"),
      discoveredCount: 1,
      importableCount: 1,
    });
    expect(discovery.agents[5]?.categories[0]?.sourceRoots?.[0]).toMatchObject({
      scope: "global",
      path: join(home, ".trae-cn", "skills"),
      discoveredCount: 1,
      importableCount: 1,
    });
    expect(discovery.agents[6]?.categories[0]?.sourceRoots?.[0]).toMatchObject({
      scope: "project",
      path: join(workspacePath, ".codebuddy", "skills"),
      discoveredCount: 1,
      importableCount: 1,
    });
  });

  it("imports workspace-level Codex skills but skips same-name target directories", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    process.env.HOME = home;
    writeSkill(
      join(workspacePath, ".codex", "skills"),
      "review",
      "---\nname: review\ndescription: source\n---\nsource-body",
    );
    writeSkill(
      join(workspacePath, ".zcode", "skills"),
      "review",
      "---\nname: review\ndescription: existing\n---\nexisting-body",
    );
    const { createSettingsSyncService } = await import(
      "../src/settings-sync/settingsSyncService.js"
    );
    const service = createSettingsSyncService({ settingService: createSettingService() });

    const result = await service.importSelected({
      workspacePath,
      selections: [{ agent: "codexCli", category: "skills", sourceScope: "project" }],
    });

    expect(result.successCount).toBe(0);
    expect(result.skippedCount).toBe(1);
    expect(result.failedCount).toBe(0);
    expect(result.taskResults[0]?.skillResults).toEqual([{
      name: "review",
      path: join(workspacePath, ".codex", "skills", "review"),
      sourceScope: "project",
      status: "skipped",
      skipReason: "targetExists",
    }]);
    expect(readFileSync(join(workspacePath, ".zcode", "skills", "review", "SKILL.md"), "utf-8"))
      .toContain("existing-body");
  });

  it("classifies workspace-level skill roots as project sources", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    process.env.HOME = home;
    writeSkill(
      join(workspacePath, ".claude", "skills"),
      "repo-review",
      "---\nname: repo-review\ndescription: project claude\n---\nbody",
    );
    writeSkill(
      join(workspacePath, ".codex", "skills"),
      "repo-helper",
      "---\nname: repo-helper\ndescription: project codex\n---\nbody",
    );
    writeSkill(
      join(workspacePath, ".opencode", "skills"),
      "repo-automation",
      "---\nname: repo-automation\ndescription: project opencode\n---\nbody",
    );
    const { createSettingsSyncService } = await import(
      "../src/settings-sync/settingsSyncService.js"
    );
    const service = createSettingsSyncService({ settingService: createSettingService() });

    const discovery = await service.detect({
      workspacePath,
      categories: ["skills"],
      intent: "manualImport",
    });

    expect(discovery.agents).toEqual([
      {
        agent: "claudeCode",
        discovered: true,
        categories: [
          {
            category: "skills",
            discoveredCount: 1,
            importableCount: 1,
            skippedCount: 0,
            sourcePaths: [join(workspacePath, ".claude", "skills")],
            sourceRoots: [{
              scope: "project",
              path: join(workspacePath, ".claude", "skills"),
              discoveredCount: 1,
              importableCount: 1,
              skippedCount: 0,
              skills: [{
                name: "repo-review",
                path: join(workspacePath, ".claude", "skills", "repo-review"),
                importable: true,
              }],
            }],
            selectedByDefault: true,
          },
        ],
      },
      {
        agent: "codexCli",
        discovered: true,
        categories: [
          {
            category: "skills",
            discoveredCount: 1,
            importableCount: 1,
            skippedCount: 0,
            sourcePaths: [join(workspacePath, ".codex", "skills")],
            sourceRoots: [{
              scope: "project",
              path: join(workspacePath, ".codex", "skills"),
              discoveredCount: 1,
              importableCount: 1,
              skippedCount: 0,
              skills: [{
                name: "repo-helper",
                path: join(workspacePath, ".codex", "skills", "repo-helper"),
                importable: true,
              }],
            }],
            selectedByDefault: true,
          },
        ],
      },
      {
        agent: "openCode",
        discovered: true,
        categories: [
          {
            category: "skills",
            discoveredCount: 1,
            importableCount: 1,
            skippedCount: 0,
            sourcePaths: [join(workspacePath, ".opencode", "skills")],
            sourceRoots: [{
              scope: "project",
              path: join(workspacePath, ".opencode", "skills"),
              discoveredCount: 1,
              importableCount: 1,
              skippedCount: 0,
              skills: [{
                name: "repo-automation",
                path: join(workspacePath, ".opencode", "skills", "repo-automation"),
                importable: true,
              }],
            }],
            selectedByDefault: true,
          },
        ],
      },
    ]);
  });

  it("skips imported skills when an existing ZCode skill has the same name", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    process.env.HOME = home;
    writeSkill(
      join(home, ".codex", "skills"),
      "external-review",
      "---\nname: review\ndescription: source\n---\nsource-body",
    );
    writeSkill(
      join(home, ".zcode", "skills"),
      "current-review",
      "---\nname: review\ndescription: existing\n---\nexisting-body",
    );
    const { createSettingsSyncService } = await import(
      "../src/settings-sync/settingsSyncService.js"
    );
    const service = createSettingsSyncService({ settingService: createSettingService() });

    const discovery = await service.detect({
      workspacePath,
      categories: ["skills"],
      intent: "manualImport",
    });

    expect(discovery.agents[0]?.categories[0]).toMatchObject({
      discoveredCount: 1,
      importableCount: 0,
      skippedCount: 1,
      sourcePaths: [join(home, ".codex", "skills")],
      sourceRoots: [{
        scope: "global",
        path: join(home, ".codex", "skills"),
        discoveredCount: 1,
        importableCount: 0,
        skippedCount: 1,
        skills: [{
          name: "review",
          path: join(home, ".codex", "skills", "external-review"),
          importable: false,
          skipReason: "sameNameExists",
        }],
      }],
      selectedByDefault: false,
    });

    const result = await service.importSelected({
      workspacePath,
      selections: [{ agent: "codexCli", category: "skills" }],
    });

    expect(result.successCount).toBe(0);
    expect(result.skippedCount).toBe(1);
    expect(result.failedCount).toBe(0);
    expect(result.taskResults[0]?.skillResults).toEqual([{
      name: "review",
      path: join(home, ".codex", "skills", "external-review"),
      sourceScope: "global",
      status: "skipped",
      skipReason: "sameNameExists",
    }]);
    expect(existsSync(join(home, ".zcode", "skills", "external-review"))).toBe(false);
    expect(readFileSync(join(home, ".zcode", "skills", "current-review", "SKILL.md"), "utf-8"))
      .toContain("existing-body");
  });

  it("reports target directory conflicts as skip reasons", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    process.env.HOME = home;
    writeSkill(
      join(home, ".claude", "skills"),
      "review",
      "---\nname: external-review\ndescription: source\n---\nsource-body",
    );
    writeSkill(
      join(home, ".zcode", "skills"),
      "review",
      "---\nname: existing-review\ndescription: existing\n---\nexisting-body",
    );
    const { createSettingsSyncService } = await import(
      "../src/settings-sync/settingsSyncService.js"
    );
    const service = createSettingsSyncService({ settingService: createSettingService() });

    const discovery = await service.detect({
      workspacePath,
      categories: ["skills"],
      intent: "manualImport",
    });

    expect(discovery.agents[0]?.categories[0]?.sourceRoots?.[0]?.skills).toEqual([{
      name: "external-review",
      path: join(home, ".claude", "skills", "review"),
      importable: false,
      skipReason: "targetExists",
    }]);
  });
});
