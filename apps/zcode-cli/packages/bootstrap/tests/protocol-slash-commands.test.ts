import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecutionPort, ExecutionResult, SessionId } from "@zcode/contracts";
import { resolveZCodeBuiltinPromptCommand } from "../src/builtin-prompt-command.js";
import { resolveZCodeCustomCommandPrompt } from "../src/custom-command-prompt.js";
import { listProtocolSlashCommands } from "../src/zcode-protocol/slash-commands.js";

describe("protocol slash command surface", () => {
  it("returns app-supported builtins plus agent-discovered custom commands", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-protocol-slash-"));
    const workspace = join(tempRoot, "workspace");
    const home = join(tempRoot, "home");
    const projectCommands = join(workspace, ".zcode", "commands");
    const userCommands = join(home, ".zcode", "commands");

    try {
      await mkdir(projectCommands, { recursive: true });
      await mkdir(userCommands, { recursive: true });
      await writeCommand(projectCommands, "review", "Project review", "Project body.");
      await writeCommand(userCommands, "review", "User review", "User body.");
      await writeCommand(userCommands, "ship", "Ship changes", "Ship $ARGUMENTS.", [
        "argument-hint: [target]",
      ]);
      await writeCommand(userCommands, "model", "Reserved custom model", "Should be hidden.");
      await writeCommand(userCommands, "plan", "Reserved custom plan", "Should be hidden.");
      await writeCommand(userCommands, "offline", "Noninteractive disabled", "Hidden.", [
        "disable-noninteractive: true",
      ]);
      // 同名自定义命令不得顶替内置 `/workflow`（保留名）：目录里只剩内置那一行。
      await writeCommand(userCommands, "workflow", "Shadowing workflow", "Should be hidden.");

      const commands = await listProtocolSlashCommands({
        env: { ZCODE_ENV: "test" },
        homeDirectory: home,
        skipUserConfig: true,
        workingDirectory: workspace,
      });

      expect(commands.map((command) => ({ name: command.name, source: command.source }))).toEqual([
        { name: "goal", source: "builtin" },
        // `/workflow` 是随 CLI 编译的内置 prompt 命令（builtin-workflow-command.ts）。App `/` 面板
        // 按本目录顺序展示，产品要求工作流紧随目标之后（docs/ui/chat-composer-action-menu.md
        // 「工作流入口」），顺序由 APP_PROTOCOL_VISIBLE_BUILTIN_SLASH_COMMAND_NAMES 决定。
        { name: "workflow", source: "builtin" },
        { name: "compact", source: "builtin" },
        { name: "init", source: "builtin" },
        { name: "plan", source: "builtin" },
        { name: "review", source: "custom" },
        { name: "ship", source: "custom" },
      ]);
      expect(commands.find((command) => command.name === "review")?.description).toBe(
        "User review",
      );
      expect(commands.find((command) => command.name === "ship")?.inputHint).toBe(
        "/ship [target]",
      );
      expect(commands.some((command) => command.name === "model")).toBe(false);
      expect(commands.filter((command) => command.name === "workflow")).toHaveLength(1);
      expect(commands.find((command) => command.name === "workflow")?.inputHint).toBe(
        "/workflow [what the workflow should accomplish]",
      );
      expect(commands.filter((command) => command.name === "plan")).toHaveLength(1);
      expect(commands.find((command) => command.name === "plan")?.description).toBe(
        "Switch to Plan mode and optionally send a task.",
      );
      expect(commands.some((command) => command.name === "offline")).toBe(false);
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("expands prompt custom commands without taking over reserved builtins", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-custom-command-prompt-"));
    const workspace = join(tempRoot, "workspace");
    const home = join(tempRoot, "home");
    const userCommands = join(home, ".zcode", "commands");

    try {
      await mkdir(workspace, { recursive: true });
      await mkdir(userCommands, { recursive: true });
      await writeCommand(userCommands, "review", "Review changes", "Review $ARGUMENTS.");
      await writeCommand(userCommands, "init", "Custom init", "Should not expand.");
      await writeCommand(userCommands, "model", "Reserved model", "Should not expand.");

      const options = {
        env: { ZCODE_ENV: "test" },
        homeDirectory: home,
        skipUserConfig: true,
        workingDirectory: workspace,
      };
      const prompt = await resolveZCodeCustomCommandPrompt("/review src packages", options);

      expect(prompt).toContain("Run custom command /review.");
      expect(prompt).toContain("Command source: user/zcode.");
      expect(prompt).toContain("Review src packages.");
      await expect(resolveZCodeCustomCommandPrompt("/model glm-5", options)).resolves.toBe(
        undefined,
      );
      await expect(resolveZCodeCustomCommandPrompt("/init", options)).resolves.toBe(undefined);
      await expect(resolveZCodeCustomCommandPrompt("please /review", options)).resolves.toBe(
        undefined,
      );
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  // DWG-03：灰度关闭时 `/workflow` 不得展开。目录侧已经剃掉了它，但用户仍可手打命令名，
  // 两条路径必须给出同一个结论；同时 `workflow` 是保留名，自定义命令解析对它一律不展开，
  // 用户或插件的同名命令既顶替不了内置语义，也绕不过灰度门。
  it("expands builtin /workflow through the builtin resolver only, gated by the feature flag", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-builtin-workflow-"));
    const workspace = join(tempRoot, "workspace");
    const home = join(tempRoot, "home");
    const userCommands = join(home, ".zcode", "commands");
    try {
      await mkdir(workspace, { recursive: true });
      await mkdir(userCommands, { recursive: true });
      await writeCommand(userCommands, "workflow", "Shadowing workflow", "Should not expand.");
      const options = {
        env: { ZCODE_ENV: "test" },
        homeDirectory: home,
        skipUserConfig: true,
        workingDirectory: workspace,
      };

      const expanded = resolveZCodeBuiltinPromptCommand("/workflow ship it", {
        dynamicWorkflowEnabled: true,
        workingDirectory: workspace,
      });
      expect(expanded).toContain("Required skills: `dynamic-workflows`.");
      expect(expanded).toContain("ship it");
      expect(expanded).not.toContain("Should not expand.");
      // 缺席（TUI / headless）等于开启；显式 false 才挡下。
      expect(
        resolveZCodeBuiltinPromptCommand("/workflow ship it", { workingDirectory: workspace }),
      ).toContain("ship it");
      expect(
        resolveZCodeBuiltinPromptCommand("/workflow ship it", {
          dynamicWorkflowEnabled: false,
          workingDirectory: workspace,
        }),
      ).toBe(undefined);
      await expect(resolveZCodeCustomCommandPrompt("/workflow ship it", options)).resolves.toBe(
        undefined,
      );
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("expands builtin /init into the workspace AGENTS.md prompt", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-builtin-init-"));
    const workspace = join(tempRoot, "workspace");

    try {
      await mkdir(workspace, { recursive: true });
      const prompt = resolveZCodeBuiltinPromptCommand("/init include pnpm scripts", {
        workingDirectory: workspace,
      });

      expect(prompt).toContain("built-in /init command");
      expect(prompt).toContain("AGENTS.md");
      expect(prompt).toContain(join(workspace, "AGENTS.md"));
      expect(prompt).toContain(join(workspace, ".zcode", "AGENTS.md"));
      expect(prompt).toContain(join(workspace, ".agents", "AGENTS.md"));
      expect(prompt).toContain("they already have an instructions file");
      expect(prompt).not.toContain("Do not create CLAUDE.md or AGNENTS.md");
      expect(prompt).toContain("include pnpm scripts");
      expect(resolveZCodeBuiltinPromptCommand("/review", { workingDirectory: workspace })).toBe(
        undefined,
      );
      expect(resolveZCodeBuiltinPromptCommand("please /init", { workingDirectory: workspace })).toBe(
        undefined,
      );
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("runs shell expansion for plugin commands with plugin and session variables", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-plugin-command-shell-"));
    const workspace = join(tempRoot, "workspace");
    const pluginRoot = join(tempRoot, "ralph-loop");
    const commandsRoot = join(pluginRoot, "commands");
    const pluginDataRoot = join(tempRoot, "plugins");
    const configPath = join(tempRoot, "config.json");
    const sessionId = "sess_shell_expansion" as SessionId;
    let capturedRequest: Parameters<ExecutionPort["run"]>[0] | undefined;
    const executionPort: ExecutionPort = {
      async run(request) {
        capturedRequest = request;
        return createExecutionResult("ralph setup output");
      },
    };

    try {
      await mkdir(commandsRoot, { recursive: true });
      await mkdir(join(pluginRoot, ".claude-plugin"), { recursive: true });
      await writeFile(
        join(pluginRoot, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: "ralph-loop", version: "1.0.0" }),
      );
      await writeCommand(
        commandsRoot,
        "ralph-loop",
        "Start Ralph",
        [
          "Before",
          "```!",
          'echo "${CLAUDE_PLUGIN_ROOT}/scripts/setup-ralph-loop.sh" "$ARGUMENTS"',
          "```",
          "After",
        ].join("\n"),
      );
      await writeFile(
        configPath,
        JSON.stringify({
          plugins: {
            dirs: [pluginRoot],
            enabled: true,
          },
          storage: {
            dir: pluginDataRoot,
          },
        }),
      );

      const prompt = await resolveZCodeCustomCommandPrompt("/ralph-loop build demo", {
        env: { ZCODE_ENV: "test" },
        executionPort,
        projectConfigPath: configPath,
        sessionId,
        skipUserConfig: true,
        workingDirectory: workspace,
      });

      expect(prompt).toContain("ralph setup output");
      expect(prompt).not.toContain("```!");
      expect(capturedRequest?.command).toMatchObject({
        command: 'echo "${CLAUDE_PLUGIN_ROOT}/scripts/setup-ralph-loop.sh" "build demo"',
        mode: "shell",
      });
      expect(capturedRequest?.cwd).toBe(workspace);
      expect(capturedRequest?.env?.set).toMatchObject({
        CLAUDE_CODE_SESSION_ID: sessionId,
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        CLAUDE_PROJECT_DIR: workspace,
        CLAUDE_SESSION_ID: sessionId,
        ZCODE_PLUGIN_ROOT: pluginRoot,
        ZCODE_PROJECT_DIR: workspace,
        ZCODE_SESSION_ID: sessionId,
      });
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("fails shell-expanded custom commands that request unavailable contexts", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-command-shell-missing-context-"));
    const workspace = join(tempRoot, "workspace");
    const home = join(tempRoot, "home");
    const userCommands = join(home, ".zcode", "commands");
    let executionCalled = false;
    const executionPort: ExecutionPort = {
      async run() {
        executionCalled = true;
        return createExecutionResult("should not run");
      },
    };

    try {
      await mkdir(userCommands, { recursive: true });
      await writeCommand(
        userCommands,
        "skill-context",
        "Needs skill context",
        ['```!', 'echo "${CLAUDE_SKILL_DIR}"', "```"].join("\n"),
      );
      await writeCommand(
        userCommands,
        "session-context",
        "Needs session context",
        ['```!', 'echo "${CLAUDE_SESSION_ID}"', "```"].join("\n"),
      );

      const options = {
        env: { ZCODE_ENV: "test" },
        executionPort,
        homeDirectory: home,
        skipUserConfig: true,
        workingDirectory: workspace,
      };

      await expect(resolveZCodeCustomCommandPrompt("/skill-context", options)).rejects.toThrow(
        "Custom command /skill-context variable requires a skill context: CLAUDE_SKILL_DIR",
      );
      await expect(resolveZCodeCustomCommandPrompt("/session-context", options)).rejects.toThrow(
        "Custom command /session-context variable requires a runtime session context: CLAUDE_SESSION_ID",
      );
      expect(executionCalled).toBe(false);
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });
});

async function writeCommand(
  directory: string,
  name: string,
  description: string,
  body: string,
  extraFrontmatter: string[] = [],
): Promise<void> {
  await writeFile(
    join(directory, `${name}.md`),
    ["---", `description: ${description}`, ...extraFrontmatter, "---", "", body].join("\n"),
  );
}

function createExecutionResult(stdout: string): ExecutionResult {
  const now = new Date();
  return {
    status: "completed",
    exitCode: 0,
    stdout: { text: stdout, bytes: stdout.length, truncated: false },
    stderr: { text: "", bytes: 0, truncated: false },
    durationMs: 1,
    timedOut: false,
    cancelled: false,
    startedAt: now,
    completedAt: now,
  };
}
