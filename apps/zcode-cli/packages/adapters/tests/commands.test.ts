import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createNodeCustomCommandAdapter } from "../src/commands/index.js";

describe("NodeCustomCommandAdapter", () => {
  it("discovers project custom commands with frontmatter", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-commands-"));
    const commandDir = join(dir, ".zcode", "commands", "frontend");

    try {
      await mkdir(commandDir, { recursive: true });
      await writeFile(
        join(commandDir, "review.md"),
        [
          "---",
          "description: Review frontend changes",
          "argument-hint: [scope]",
          "allowed-tools: Read, Grep",
          "skills: frontend-review",
          "---",
          "",
          "Review $ARGUMENTS.",
        ].join("\n"),
      );

      const adapter = createNodeCustomCommandAdapter({ homeDirectory: join(dir, "home") });
      const outcome = await adapter.discoverCommands({ workingDirectory: dir });

      expect(outcome.commands.map((command) => command.name)).toEqual(["frontend:review"]);
      expect(outcome.commands[0]?.description).toBe("Review frontend changes");
      expect(outcome.commands[0]?.argumentHint).toBe("[scope]");
      expect(outcome.commands[0]?.allowedTools).toEqual(["Read", "Grep"]);
      expect(outcome.commands[0]?.skills).toEqual(["frontend-review"]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("filters out commands disabled via config (enable:false path)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-commands-"));
    const commandDir = join(dir, ".zcode", "commands");
    const disabledPath = join(commandDir, "disabled.md");

    try {
      await mkdir(commandDir, { recursive: true });
      await writeFile(
        join(commandDir, "kept.md"),
        ["---", "description: Stays available", "---", "", "Body."].join("\n"),
      );
      await writeFile(
        disabledPath,
        ["---", "description: Should be filtered", "---", "", "Body."].join("\n"),
      );

      const adapter = createNodeCustomCommandAdapter({
        homeDirectory: join(dir, "home"),
        disabledPaths: [disabledPath],
      });
      const outcome = await adapter.discoverCommands({ workingDirectory: dir });

      // 仅保留未被禁用的命令；load 复用 discover 也应拒绝被禁用项
      expect(outcome.commands.map((command) => command.name)).toEqual(["kept"]);
      await expect(
        adapter.loadCommand({ name: "disabled", workingDirectory: dir }),
      ).rejects.toThrow(/not found/);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("loads custom command body without frontmatter", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-commands-"));
    const commandDir = join(dir, ".zcode", "commands");

    try {
      await mkdir(commandDir, { recursive: true });
      await writeFile(
        join(commandDir, "test.md"),
        ["---", "description: Run tests", "---", "", "Run tests for $1."].join("\n"),
      );

      const adapter = createNodeCustomCommandAdapter({ homeDirectory: join(dir, "home") });
      const loaded = await adapter.loadCommand({ name: "test", workingDirectory: dir });

      expect(loaded.content).toBe("Run tests for $1.");
      expect(loaded.metadata.source).toBe("zcode");
      expect(loaded.truncated).toBe(false);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("discovers command names with underscores", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-commands-"));
    const commandDir = join(dir, ".zcode", "commands");

    try {
      await mkdir(commandDir, { recursive: true });
      await writeCommand(commandDir, "clean_gone", "Clean gone git branches");

      const adapter = createNodeCustomCommandAdapter({ homeDirectory: join(dir, "home") });
      const outcome = await adapter.discoverCommands({ workingDirectory: dir });

      expect(outcome.commands.map((command) => command.name)).toEqual(["clean_gone"]);
      expect(outcome.diagnostics).toEqual([]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("keeps the higher-priority duplicate command", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-commands-"));
    const projectDir = join(dir, ".zcode", "commands");
    const userDir = join(dir, "home", ".zcode", "commands");

    try {
      await mkdir(projectDir, { recursive: true });
      await mkdir(userDir, { recursive: true });
      await writeCommand(projectDir, "review", "Project review");
      await writeCommand(userDir, "review", "User review");

      const adapter = createNodeCustomCommandAdapter({ homeDirectory: join(dir, "home") });
      const outcome = await adapter.discoverCommands({ workingDirectory: dir });

      expect(outcome.commands).toHaveLength(1);
      expect(outcome.commands[0]?.description).toBe("User review");
      expect(outcome.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
        "custom_command_duplicate_name",
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("discovers commands under .agents/commands", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-commands-"));
    const commandDir = join(dir, ".agents", "commands");

    try {
      await mkdir(commandDir, { recursive: true });
      await writeCommand(commandDir, "agents-cmd", "Lives under .agents/commands");

      const adapter = createNodeCustomCommandAdapter({ homeDirectory: join(dir, "home") });
      const outcome = await adapter.discoverCommands({ workingDirectory: dir });

      expect(outcome.commands.map((command) => command.name)).toEqual(["agents-cmd"]);
      expect(outcome.commands[0]?.source).toBe("agents");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("merges .zcode/commands and .agents/commands with .zcode winning duplicates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-commands-"));
    const zcodeDir = join(dir, ".zcode", "commands");
    const agentsDir = join(dir, ".agents", "commands");

    try {
      await mkdir(zcodeDir, { recursive: true });
      await mkdir(agentsDir, { recursive: true });
      await writeCommand(zcodeDir, "dup", "From .zcode");
      await writeCommand(agentsDir, "dup", "From .agents");
      await writeCommand(agentsDir, "agents-only", "Agents only");

      const adapter = createNodeCustomCommandAdapter({ homeDirectory: join(dir, "home") });
      const outcome = await adapter.discoverCommands({ workingDirectory: dir });

      expect(outcome.commands.map((command) => command.name)).toEqual(["agents-only", "dup"]);
      expect(outcome.commands.map((command) => command.description)).toEqual([
        "Agents only",
        "From .zcode",
      ]);
      expect(outcome.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
        "custom_command_duplicate_name",
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
  it("discovers commands imported as file symlinks", async () => {
    // 回归测试：外部 agent 导入默认 importMode="symlink"，命令文件是指向源文件的软链。
    // 旧逻辑只检查 entry.isFile() 会漏掉 symlink（readdir 报告为 isSymbolicLink()）。
    const dir = await mkdtemp(join(tmpdir(), "zcode-commands-"));
    const sourceDir = join(dir, "source");
    const commandDir = join(dir, ".zcode", "commands");

    try {
      await mkdir(sourceDir, { recursive: true });
      await mkdir(commandDir, { recursive: true });
      const sourceFile = join(sourceDir, "commit.md");
      await writeFile(
        sourceFile,
        ["---", "description: Commit staged changes", "---", "", "Commit $ARGUMENTS."].join("\n"),
      );
      await symlink(sourceFile, join(commandDir, "commit.md"));

      const adapter = createNodeCustomCommandAdapter({ homeDirectory: join(dir, "home") });
      const outcome = await adapter.discoverCommands({ workingDirectory: dir });

      expect(outcome.commands.map((command) => command.name)).toEqual(["commit"]);
      expect(outcome.commands[0]?.description).toBe("Commit staged changes");

      const loaded = await adapter.loadCommand({ name: "commit", workingDirectory: dir });
      expect(loaded.content).toBe("Commit $ARGUMENTS.");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("discovers commands inside a symlinked directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-commands-"));
    const sourceDir = join(dir, "source-commands");
    const commandRoot = join(dir, ".zcode", "commands");

    try {
      await mkdir(sourceDir, { recursive: true });
      await mkdir(commandRoot, { recursive: true });
      await writeCommand(sourceDir, "deploy", "Deploy the app");
      // 目录级 symlink：stat 跟随链接后应识别为目录并递归扫描
      await symlink(sourceDir, join(commandRoot, "ops"), "dir");

      const adapter = createNodeCustomCommandAdapter({ homeDirectory: join(dir, "home") });
      const outcome = await adapter.discoverCommands({ workingDirectory: dir });

      expect(outcome.commands.map((command) => command.name)).toEqual(["ops:deploy"]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("skips dangling command symlinks without failing the scan", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-commands-"));
    const commandDir = join(dir, ".zcode", "commands");

    try {
      await mkdir(commandDir, { recursive: true });
      await writeCommand(commandDir, "kept", "Real command");
      await symlink(join(dir, "does-not-exist.md"), join(commandDir, "broken.md"));

      const adapter = createNodeCustomCommandAdapter({ homeDirectory: join(dir, "home") });
      const outcome = await adapter.discoverCommands({ workingDirectory: dir });

      expect(outcome.commands.map((command) => command.name)).toEqual(["kept"]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});

async function writeCommand(dir: string, name: string, description: string): Promise<void> {
  await writeFile(
    join(dir, `${name}.md`),
    ["---", `description: ${description}`, "---", "", "# Body"].join("\n"),
  );
}
