import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ICommandsService } from "../src/commands/commands.js";

const originalHome = process.env.HOME;
const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "zcode-commands-"));
  tempRoots.push(root);
  return root;
}

function officialPluginRoot(
  home: string,
  pluginName: string,
  version = "0.1.0",
): string {
  return join(
    home,
    ".zcode",
    "cli",
    "plugins",
    "cache",
    "zcode-plugins-official",
    pluginName,
    version,
  );
}

function marketplacePluginRoot(
  home: string,
  marketplace: string,
  pluginName: string,
  version = "0.0.0",
): string {
  return join(
    home,
    ".zcode",
    "cli",
    "plugins",
    "cache",
    marketplace,
    pluginName,
    version,
  );
}

function writePluginManifest(
  pluginRoot: string,
  manifest: Record<string, unknown>,
): void {
  mkdirSync(join(pluginRoot, ".zcode-plugin"), { recursive: true });
  writeFileSync(
    join(pluginRoot, ".zcode-plugin", "plugin.json"),
    JSON.stringify(manifest, null, 2),
    "utf-8",
  );
}

function writeClaudePluginManifest(
  pluginRoot: string,
  manifest: Record<string, unknown>,
): void {
  mkdirSync(join(pluginRoot, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(pluginRoot, ".claude-plugin", "plugin.json"),
    JSON.stringify(manifest, null, 2),
    "utf-8",
  );
}

function writeInstalledPluginRecord(
  home: string,
  record: {
    marketplace: string;
    name: string;
    installPath: string;
    version?: string;
  },
): void {
  const pluginsRoot = join(home, ".zcode", "cli", "plugins");
  mkdirSync(pluginsRoot, { recursive: true });
  writeFileSync(
    join(pluginsRoot, "installed_plugins.json"),
    JSON.stringify(
      {
        version: 1,
        plugins: [
          {
            id: `${record.name}@${record.marketplace}`,
            name: record.name,
            marketplace: record.marketplace,
            version: record.version ?? "0.0.0",
            installPath: record.installPath,
            installedAt: "2026-06-25T00:00:00.000Z",
            updatedAt: "2026-06-25T00:00:00.000Z",
            scope: "user",
            source: "./plugins/demo",
          },
        ],
      },
      null,
      2,
    ),
    "utf-8",
  );
}

function writeCliConfig(home: string, config: Record<string, unknown>): void {
  const configPath = join(home, ".zcode", "cli", "config.json");
  mkdirSync(join(home, ".zcode", "cli"), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}

async function createCommandsServiceInEnv(
  home: string,
): Promise<ICommandsService> {
  process.env.HOME = home;
  vi.resetModules();
  const mod = await import("../src/commands/commandsService.js");
  return mod.createCommandsService({ isDesktopRuntime: true });
}

afterEach(() => {
  process.env.HOME = originalHome;
  vi.resetModules();
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("commandsService", () => {
  it("lists user commands and workspace project commands", async () => {
    const home = makeTempRoot();
    const workspacePath = join(makeTempRoot(), "workspace");
    mkdirSync(join(home, ".zcode", "commands"), { recursive: true });
    mkdirSync(join(workspacePath, ".zcode", "commands", "ops"), {
      recursive: true,
    });
    writeFileSync(
      join(home, ".zcode", "commands", "global.md"),
      "---\ndescription: Global command\n---\n\nRun globally",
      "utf-8",
    );
    writeFileSync(
      join(workspacePath, ".zcode", "commands", "ops", "deploy.md"),
      "---\ndescription: Deploy command\nargument-hint: <env>\n---\n\nDeploy project",
      "utf-8",
    );

    const service = await createCommandsServiceInEnv(home);
    const result = await service.list({
      workspacePath,
      workspaceIdentity: "remote:ssh:host:/workspace",
    });

    expect(result.userCommands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentSource: "zcodeAgent",
          id: "zcodeAgent:zcode:global:/global",
          name: "/global",
          scope: "global",
          description: "Global command",
          location: expect.objectContaining({
            source: "zcode",
            scope: "user",
            directoryPath: join(home, ".zcode", "commands"),
          }),
        }),
        expect.objectContaining({
          agentSource: "zcodeAgent",
          id: "zcodeAgent:zcode:project:/ops/deploy",
          name: "/ops/deploy",
          scope: "project",
          projectPath: workspacePath,
          argumentHint: "<env>",
          location: expect.objectContaining({
            source: "zcode",
            scope: "project",
            directoryPath: join(workspacePath, ".zcode", "commands"),
          }),
        }),
      ]),
    );
    expect(result.commands.map((command) => command.name)).toEqual(
      expect.arrayContaining(["/global", "/ops/deploy"]),
    );
  });

  it("returns project commands even when the user commands directory is missing", async () => {
    const home = makeTempRoot();
    const workspacePath = join(makeTempRoot(), "workspace");
    mkdirSync(join(workspacePath, ".zcode", "commands"), { recursive: true });
    mkdirSync(join(workspacePath, ".agents", "commands"), { recursive: true });
    writeFileSync(
      join(workspacePath, ".zcode", "commands", "project-only.md"),
      "Project command",
      "utf-8",
    );

    const service = await createCommandsServiceInEnv(home);
    const result = await service.list({ workspacePath });

    expect(result.userCommands).toEqual([
      expect.objectContaining({
        agentSource: "zcodeAgent",
        id: "zcodeAgent:zcode:project:/project-only",
        name: "/project-only",
        scope: "project",
        location: expect.objectContaining({
          source: "zcode",
          scope: "project",
          directoryPath: join(workspacePath, ".zcode", "commands"),
        }),
      }),
    ]);
  });

  it("reads .zcode command directories first and skips .agents/.claude when zcode has commands", async () => {
    const home = makeTempRoot();
    const workspacePath = join(makeTempRoot(), "workspace");
    mkdirSync(join(home, ".zcode", "commands"), { recursive: true });
    mkdirSync(join(home, ".agents", "commands"), { recursive: true });
    mkdirSync(join(home, ".claude", "commands"), { recursive: true });
    mkdirSync(join(workspacePath, ".zcode", "commands"), { recursive: true });
    mkdirSync(join(workspacePath, ".agents", "commands"), { recursive: true });
    mkdirSync(join(workspacePath, ".claude", "commands"), { recursive: true });
    writeFileSync(
      join(home, ".zcode", "commands", "review.md"),
      "ZCode review",
      "utf-8",
    );
    writeFileSync(
      join(home, ".agents", "commands", "agent.md"),
      "Agents command",
      "utf-8",
    );
    writeFileSync(
      join(home, ".claude", "commands", "review.md"),
      "Claude review",
      "utf-8",
    );
    writeFileSync(
      join(home, ".claude", "commands", "claude.md"),
      "Claude command",
      "utf-8",
    );
    writeFileSync(
      join(workspacePath, ".agents", "commands", "agent.md"),
      "Workspace agents command",
      "utf-8",
    );
    writeFileSync(
      join(workspacePath, ".claude", "commands", "claude-project.md"),
      "Workspace claude command",
      "utf-8",
    );
    writeFileSync(
      join(workspacePath, ".zcode", "commands", "project.md"),
      "ZCode project",
      "utf-8",
    );

    const service = await createCommandsServiceInEnv(home);
    const all = await service.list({ workspacePath });
    const zcodeOnly = await service.list({
      agentSource: "zcodeAgent",
      workspacePath,
    });

    expect(all.userCommands.map((command) => command.id)).toEqual([
      "zcodeAgent:zcode:project:/project",
      "zcodeAgent:zcode:global:/review",
    ]);
    expect(zcodeOnly.userCommands.map((command) => command.id)).toEqual([
      "zcodeAgent:zcode:project:/project",
      "zcodeAgent:zcode:global:/review",
    ]);
  });

  it("writes and opens command files for the selected agent source", async () => {
    const home = makeTempRoot();
    const service = await createCommandsServiceInEnv(home);

    const created = await service.writeCommandFile({
      agentSource: "zcodeAgent",
      config: {
        name: "ship-it",
        prompt: "Ship it",
        description: "Ship command",
      },
    });
    const directory = await service.getPrimaryUserCommandsDirectory({
      agentSource: "zcodeAgent",
    });

    expect(directory.path).toBe(join(home, ".zcode", "commands"));
    expect(created.command).toMatchObject({
      agentSource: "zcodeAgent",
      filePath: join(home, ".zcode", "commands", "ship-it.md"),
      id: "zcodeAgent:zcode:global:/ship-it",
      name: "/ship-it",
      location: expect.objectContaining({
        source: "zcode",
        scope: "user",
        directoryPath: join(home, ".zcode", "commands"),
      }),
    });
    expect(readFileSync(created.command.filePath, "utf-8")).toContain(
      "Ship it",
    );
  });

  it("creates the target commands directory before returning it", async () => {
    const home = makeTempRoot();
    const service = await createCommandsServiceInEnv(home);

    const directory = await service.getPrimaryUserCommandsDirectory();

    expect(directory.path).toBe(join(home, ".zcode", "commands"));
    expect(statSync(directory.path).isDirectory()).toBe(true);
  });

  it("skips .agents/commands when .zcode/commands has any valid command", async () => {
    const home = makeTempRoot();
    const workspacePath = join(makeTempRoot(), "workspace");
    mkdirSync(join(workspacePath, ".zcode", "commands"), { recursive: true });
    mkdirSync(join(workspacePath, ".agents", "commands"), { recursive: true });
    // 同一 scope 中 .zcode 读到命令后，.agents 不再参与，即便包含不同命令名。
    writeFileSync(
      join(workspacePath, ".zcode", "commands", "dup.md"),
      "---\ndescription: from zcode\n---\n\nzcode body",
      "utf-8",
    );
    writeFileSync(
      join(workspacePath, ".agents", "commands", "dup.md"),
      "---\ndescription: from agents\n---\n\nagents body",
      "utf-8",
    );
    writeFileSync(
      join(workspacePath, ".agents", "commands", "agents-only.md"),
      "---\ndescription: agents only\n---\n\nagents only body",
      "utf-8",
    );

    const service = await createCommandsServiceInEnv(home);
    const result = await service.list({ workspacePath });

    const dup = result.userCommands.filter(
      (command) => command.name === "/dup",
    );
    expect(dup).toHaveLength(1);
    expect(dup[0]?.description).toBe("from zcode");
    expect(result.userCommands.map((command) => command.name)).not.toContain(
      "/agents-only",
    );
  });

  it("falls back to .agents/commands when .zcode/commands has no valid command", async () => {
    const home = makeTempRoot();
    const workspacePath = join(makeTempRoot(), "workspace");
    mkdirSync(join(workspacePath, ".zcode", "commands"), { recursive: true });
    mkdirSync(join(workspacePath, ".agents", "commands"), { recursive: true });
    writeFileSync(
      join(workspacePath, ".agents", "commands", "agents-only.md"),
      "---\ndescription: agents only\n---\n\nagents only body",
      "utf-8",
    );

    const service = await createCommandsServiceInEnv(home);
    const result = await service.list({ workspacePath });

    expect(result.userCommands).toEqual([
      expect.objectContaining({
        id: "zcodeAgent:agents:project:/agents-only",
        name: "/agents-only",
        description: "agents only",
        location: expect.objectContaining({
          source: "agents",
          scope: "project",
          directoryPath: join(workspacePath, ".agents", "commands"),
        }),
      }),
    ]);
  });

  it("lists enabled plugin commands separately from user commands", async () => {
    const home = makeTempRoot();
    const workspacePath = join(makeTempRoot(), "workspace");
    const pluginRoot = officialPluginRoot(home, "ios-simulator");
    mkdirSync(join(home, ".zcode", "commands"), { recursive: true });
    mkdirSync(join(pluginRoot, "commands", "ios"), { recursive: true });
    writeFileSync(
      join(home, ".zcode", "commands", "local-review.md"),
      "---\ndescription: Local review\n---\n\nReview locally",
      "utf-8",
    );
    writePluginManifest(pluginRoot, {
      commands: "commands",
      name: "ios-simulator",
      version: "0.1.0",
    });
    writeFileSync(
      join(pluginRoot, "commands", "ios", "dev.md"),
      "---\ndescription: iOS plugin command\nargument-hint: <target>\n---\n\nRun iOS flow",
      "utf-8",
    );
    writeCliConfig(home, {
      plugins: {
        enabledPlugins: {
          "ios-simulator@zcode-plugins-official": true,
        },
      },
    });

    const service = await createCommandsServiceInEnv(home);
    const result = await service.list({ workspacePath });

    expect(result.userCommands.map((command) => command.name)).toEqual([
      "/local-review",
    ]);
    expect(result.pluginCommands).toEqual([
      expect.objectContaining({
        argumentHint: "<target>",
        description: "iOS plugin command",
        enabled: true,
        name: "/ios/dev",
        pluginEnabled: true,
        pluginMarketplace: "zcode-plugins-official",
        pluginName: "ios-simulator",
        source: "plugin",
      }),
    ]);
    expect(result.commands.map((command) => command.name)).toEqual([
      "/local-review",
      "/ios/dev",
    ]);
  });

  it("suppressed 内置插件不贡献任何命令", async () => {
    const home = makeTempRoot();
    const workspacePath = join(makeTempRoot(), "workspace");
    const documentPluginRoot = officialPluginRoot(home, "document-skills");
    const skillCreatorPluginRoot = officialPluginRoot(home, "skill-creator");
    mkdirSync(join(documentPluginRoot, "commands", "doc"), { recursive: true });
    mkdirSync(join(skillCreatorPluginRoot, "commands", "create"), {
      recursive: true,
    });
    writePluginManifest(documentPluginRoot, {
      commands: "commands",
      name: "document-skills",
      version: "0.1.0",
    });
    writePluginManifest(skillCreatorPluginRoot, {
      commands: "commands",
      name: "skill-creator",
      version: "0.1.0",
    });
    writeFileSync(
      join(documentPluginRoot, "commands", "doc", "convert.md"),
      "---\ndescription: Convert doc\n---\n\nConvert document",
      "utf-8",
    );
    writeFileSync(
      join(skillCreatorPluginRoot, "commands", "create", "new.md"),
      "---\ndescription: Create skill\n---\n\nCreate a skill",
      "utf-8",
    );
    // document-skills 被卸载（suppressed），skill-creator 保持默认启用。
    writeCliConfig(home, {
      plugins: {
        suppressedBuiltins: ["document-skills@zcode-plugins-official"],
      },
    });

    const service = await createCommandsServiceInEnv(home);
    const result = await service.list({ workspacePath });

    expect(result.pluginCommands.map((command) => command.name)).toEqual([
      "/create/new",
    ]);
    expect(
      result.pluginCommands.find(
        (command) => command.pluginName === "document-skills",
      ),
    ).toBeUndefined();
  });

  it("lists commands from installed marketplace plugins", async () => {
    const home = makeTempRoot();
    const workspacePath = join(makeTempRoot(), "workspace");
    const pluginRoot = marketplacePluginRoot(
      home,
      "claude-plugins-official",
      "commit-commands",
    );
    mkdirSync(join(pluginRoot, "commands", "git"), { recursive: true });
    writeClaudePluginManifest(pluginRoot, {
      commands: "commands",
      name: "commit-commands",
      version: "1.0.0",
    });
    writeFileSync(
      join(pluginRoot, "commands", "git", "commit.md"),
      "---\ndescription: Commit through plugin\nargument-hint: <message>\n---\n\nCommit changes",
      "utf-8",
    );
    writeInstalledPluginRecord(home, {
      installPath: pluginRoot,
      marketplace: "claude-plugins-official",
      name: "commit-commands",
    });
    writeCliConfig(home, {
      plugins: {
        enabledPlugins: {
          "commit-commands@claude-plugins-official": true,
        },
      },
    });

    const service = await createCommandsServiceInEnv(home);
    const result = await service.list({ workspacePath });

    expect(result.pluginCommands).toEqual([
      expect.objectContaining({
        argumentHint: "<message>",
        description: "Commit through plugin",
        enabled: true,
        name: "/git/commit",
        pluginEnabled: true,
        pluginMarketplace: "claude-plugins-official",
        pluginName: "commit-commands",
        source: "plugin",
      }),
    ]);
  });

  it("stores command disabled overrides in the user zcode config", async () => {
    const home = makeTempRoot();
    const service = await createCommandsServiceInEnv(home);
    const created = await service.writeCommandFile({
      config: {
        name: "review",
        prompt: "Review code",
      },
    });

    await service.setCommandEnabled({
      commandId: created.command.id,
      filePath: created.command.filePath,
      enabled: false,
    });

    const saved = JSON.parse(
      readFileSync(join(home, ".zcode", "cli", "config.json"), "utf-8"),
    );
    expect(saved.command[created.command.filePath]).toEqual({ enable: false });

    const disabled = await service.list({});
    expect(disabled.userCommands[0]).toEqual(
      expect.objectContaining({ enabled: false }),
    );

    await service.setCommandEnabled({
      commandId: created.command.id,
      filePath: created.command.filePath,
      enabled: true,
    });
    const enabled = await service.list({});
    const reenabledConfig = JSON.parse(
      readFileSync(join(home, ".zcode", "cli", "config.json"), "utf-8"),
    ) as { command?: Record<string, { enable?: boolean }> };
    expect(enabled.userCommands[0]).toEqual(
      expect.objectContaining({ enabled: true }),
    );
    expect(reenabledConfig.command?.[created.command.filePath]).toBeUndefined();
  });
});
