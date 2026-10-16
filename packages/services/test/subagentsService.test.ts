import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  parseSubagentMarkdown,
  serializeSubagentMarkdown,
} from "../src/subagents/subagentMarkdown.js";
import {
  resolveSubagentStateFile,
  resolveUserSubagentRoot,
} from "../src/subagents/subagentStorage.js";
import { createSubagentsService } from "../src/subagents/subagentsService.js";

const tempRoots: string[] = [];

async function makeTempHome(prefix = "zcode-subagents-home-"): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(home);
  return home;
}

/** 在临时 HOME 下构造一个内置官方插件缓存目录（无 installed_plugins.json 记录），返回版本根目录。 */
async function writeOfficialPluginFixture(
  home: string,
  pluginName: string,
  version: string,
  agentName: string,
  frontmatter: { model?: string } = {},
): Promise<string> {
  const root = join(
    home,
    ".zcode",
    "cli",
    "plugins",
    "cache",
    "zcode-plugins-official",
    pluginName,
    version,
  );
  await mkdir(join(home, ".zcode", "cli", "plugins"), { recursive: true });
  await mkdir(join(root, ".zcode-plugin"), { recursive: true });
  await mkdir(join(root, "agents"), { recursive: true });
  await writeFile(
    join(root, ".zcode-plugin", "plugin.json"),
    JSON.stringify({ name: pluginName, version }),
    "utf8",
  );
  await writeFile(
    join(root, "agents", `${agentName}.md`),
    [
      "---",
      `name: ${agentName}`,
      `description: ${pluginName} ${agentName} @ ${version}`,
      ...(frontmatter.model ? [`model: ${frontmatter.model}`] : []),
      "---",
      `${agentName} prompt ${version}`,
    ].join("\n"),
    "utf8",
  );
  return root;
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  }
});

describe("subagent markdown helpers", () => {
  it("lists only direct custom profiles while preserving recursive plugin discovery", async () => {
    const home = await makeTempHome();
    const workspacePath = join(home, "workspace");
    for (const [scope, root] of [
      ["user", join(home, ".zcode", "agents")],
      ["project", join(workspacePath, ".zcode", "agents")],
    ] as const) {
      await mkdir(join(root, "nested"), { recursive: true });
      for (const nested of [false, true]) {
        const name = `${scope}-${nested ? "nested" : "direct"}`;
        await writeFile(
          join(root, ...(nested ? ["nested"] : []), `${name}.MARKDOWN`),
          serializeSubagentMarkdown({ name, description: name, systemPrompt: name }),
        );
      }
    }
    const pluginRoot = await writeOfficialPluginFixture(home, "documents", "0.1.4", "direct");
    await mkdir(join(pluginRoot, "agents", "nested"));
    await writeFile(
      join(pluginRoot, "agents", "nested", "deep.md"),
      serializeSubagentMarkdown({ name: "deep", description: "Deep", systemPrompt: "Deep" }),
    );
    const service = createSubagentsService({ homeDir: home, isDesktopRuntime: true });
    for (const mode of ["settingsUserOnly", "allRuntimeScopes"] as const) {
      const result = await service.list({ workspacePath, mode });
      expect(
        result.agents.filter((agent) => agent.source === "user").map((agent) => agent.name),
      ).toEqual(mode === "settingsUserOnly" ? ["user-direct"] : ["user-direct", "project-direct"]);
      expect(result.pluginAgents.map((agent) => agent.name).sort()).toEqual([
        "documents:deep",
        "documents:direct",
      ]);
      expect(result.pluginAgents.find((agent) => agent.name === "documents:deep")?.path).toBe(
        join(pluginRoot, "agents", "nested", "deep.md"),
      );
      expect(result.diagnostics).toEqual([]);
    }
  });

  it("lists built-in official plugin agents from the official cache without an install record", async () => {
    // Bug 根因：discoverPluginAgents 只读 installed_plugins.json，内置官方插件由 CLI seed 到
    // cache/zcode-plugins-official 且没有安装记录，documents:visual-judge 在 Settings 永远不可见。
    const home = await makeTempHome();
    const workspacePath = join(home, "workspace");
    const oldRoot = await writeOfficialPluginFixture(home, "documents", "0.1.9", "visual-judge");
    const newRoot = await writeOfficialPluginFixture(home, "documents", "0.1.10", "visual-judge");
    const invalidRoot = await writeOfficialPluginFixture(home, "documents", "99.0", "visual-judge");
    await writeFile(
      join(invalidRoot, ".zcode-plugin", "plugin.json"),
      JSON.stringify({ name: "wrong" }),
    );
    await writeOfficialPluginFixture(home, "documents", "99.0.backup-1", "visual-judge");
    await mkdir(join(newRoot, "..", "0.1.4.backup-1"), { recursive: true });
    await mkdir(join(newRoot, "..", ".seed-lock"), { recursive: true });
    // ios-simulator 不在默认启用集合里，且 config 没有显式启用，必须被忽略。
    await writeOfficialPluginFixture(home, "ios-simulator", "0.2.0", "simulator-runner");
    // browser-use 默认启用，但被用户「卸载」进入 suppressedBuiltins，同样不能贡献 agent。
    await writeOfficialPluginFixture(home, "browser-use", "0.5.0", "browser-auditor");
    await writeFile(
      join(home, ".zcode", "cli", "config.json"),
      JSON.stringify({
        plugins: {
          suppressedBuiltins: ["browser-use@zcode-plugins-official"],
        },
      }),
      "utf8",
    );
    const service = createSubagentsService({ homeDir: home, isDesktopRuntime: true });

    const result = await service.list({ workspacePath, provider: "glm" });

    expect(result.pluginAgents.map((agent) => agent.name)).toEqual(["documents:visual-judge"]);
    expect(result.pluginAgents[0]).toMatchObject({
      id: "plugin:documents@zcode-plugins-official:visual-judge",
      pluginId: "documents@zcode-plugins-official",
      pluginName: "documents",
      // 多版本缓存共存时取数字感知最新的版本目录，而不是字典序首项。
      path: join(newRoot, "agents", "visual-judge.md"),
      scope: "user",
      source: "plugin",
    });
    expect(result.pluginAgents[0]?.path).not.toBe(join(oldRoot, "agents", "visual-judge.md"));
    expect(
      result.agents.filter((agent) => agent.source === "plugin").map((agent) => agent.name),
    ).toEqual(["documents:visual-judge", "visual-judge"]);
    await writeFile(
      join(home, ".zcode", "cli", "config.json"),
      JSON.stringify({
        plugins: {
          enabledPlugins: { "documents@zcode-plugins-official": false },
          suppressedBuiltins: ["browser-use@zcode-plugins-official"],
        },
      }),
    );
    expect((await service.list({ workspacePath, provider: "glm" })).pluginAgents).toEqual([]);
  });

  it("settingsUserOnly 仍返回本地插件资源，不引入运行时别名或项目文件", async () => {
    const home = await makeTempHome();
    const workspacePath = join(home, "workspace");
    await writeOfficialPluginFixture(home, "documents", "0.1.4", "visual-judge");
    const projectPath = join(workspacePath, ".zcode", "agents", "project.md");
    await mkdir(join(workspacePath, ".zcode", "agents"), { recursive: true });
    const projectContent =
      "---\nname: project\nmodel: builtin:zai-coding-plan/GLM-5.3\n---\nProject.";
    await writeFile(projectPath, projectContent);
    const service = createSubagentsService({ homeDir: home, isDesktopRuntime: true });
    const result = await service.list({ workspacePath, mode: "settingsUserOnly" });
    expect(result.pluginAgents.map((agent) => agent.name)).toEqual(["documents:visual-judge"]);
    expect(result.pluginAgents[0]?.readOnly).toBe(true);
    expect(
      result.agents.some((agent) => agent.source === "plugin" || agent.scope === "workspace"),
    ).toBe(false);
    expect(await readFile(projectPath, "utf8")).toBe(projectContent);
  });

  it("prefers the install record over the official cache for the same plugin id", async () => {
    const home = await makeTempHome();
    const workspacePath = join(home, "workspace");
    await writeOfficialPluginFixture(home, "documents", "0.1.4", "visual-judge");
    const installedRoot = join(home, "installed", "documents");
    await mkdir(join(installedRoot, ".zcode-plugin"), { recursive: true });
    await mkdir(join(installedRoot, "agents"), { recursive: true });
    await writeFile(
      join(installedRoot, ".zcode-plugin", "plugin.json"),
      JSON.stringify({ name: "documents" }),
      "utf8",
    );
    await writeFile(
      join(installedRoot, "agents", "visual-judge.md"),
      "---\nname: visual-judge\ndescription: installed visual-judge\n---\ninstalled prompt",
      "utf8",
    );
    await writeFile(
      join(home, ".zcode", "cli", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "documents@zcode-plugins-official",
            name: "documents",
            marketplace: "zcode-plugins-official",
            version: "9.9.9",
            installPath: installedRoot,
            scope: "user",
          },
        ],
      }),
      "utf8",
    );
    await writeFile(
      join(home, ".zcode", "cli", "config.json"),
      JSON.stringify({
        plugins: { enabledPlugins: { "documents@zcode-plugins-official": true } },
      }),
      "utf8",
    );
    const service = createSubagentsService({ homeDir: home, isDesktopRuntime: true });

    const result = await service.list({ workspacePath, provider: "glm" });

    expect(result.pluginAgents.map((agent) => agent.path)).toEqual([
      join(installedRoot, "agents", "visual-judge.md"),
    ]);
    await writeFile(
      join(home, ".zcode", "cli", "config.json"),
      JSON.stringify({
        plugins: {
          enabledPlugins: { "documents@zcode-plugins-official": true },
          suppressedBuiltins: ["documents@zcode-plugins-official"],
        },
      }),
    );
    expect((await service.list({ workspacePath, provider: "glm" })).pluginAgents).toEqual([]);
    await writeFile(
      join(home, ".zcode", "cli", "config.json"),
      JSON.stringify({
        plugins: { enabledPlugins: { "documents@zcode-plugins-official": false } },
      }),
    );
    expect((await service.list({ workspacePath, provider: "glm" })).pluginAgents).toEqual([]);
  });

  it("插件覆盖按稳定身份原子保存，别名一致，清除后回到未修改的插件默认", async () => {
    const home = await makeTempHome();
    const pluginRoot = join(home, "installed", "fixture");
    const pluginStorage = join(home, ".zcode", "cli", "plugins");
    const pluginId = "fixture@personal";
    const agentId = "plugin:fixture@personal:visual-judge";
    const path = join(pluginRoot, "agents", "visual-judge.md");
    await mkdir(join(pluginRoot, "agents"), { recursive: true });
    await mkdir(join(pluginRoot, ".zcode-plugin"), { recursive: true });
    await mkdir(pluginStorage, { recursive: true });
    await writeFile(
      join(pluginRoot, ".zcode-plugin", "plugin.json"),
      JSON.stringify({ name: "fixture" }),
    );
    const markdown =
      "---\nname: visual-judge\ndescription: visual-judge\nmodel: custom:p:old\nthoughtLevel: low\n---\nKeep prompt";
    await writeFile(path, markdown);
    await writeFile(
      join(pluginStorage, "installed_plugins.json"),
      JSON.stringify({
        version: 1,
        plugins: [{ id: pluginId, name: "fixture", installPath: pluginRoot, scope: "user" }],
      }),
    );
    await writeFile(
      join(home, ".zcode", "cli", "config.json"),
      JSON.stringify({
        plugins: { enabledPlugins: { [pluginId]: true } },
      }),
    );
    const service = createSubagentsService({ homeDir: home, isDesktopRuntime: true });
    const selection = { providerId: "p", modelId: "new", options: { reasoningLevel: "high" } };
    await Promise.all([
      service.setPluginAgentModelOverride({ agentId, modelSelection: selection }),
      service.setBuiltInModelOverride({ agentName: "Explore", modelSelection: selection }),
      service.setEnabled({ agentId: "user:user:disabled", enabled: false }),
    ]);
    const statePath = await resolveSubagentStateFile({ homeDir: home });
    const state = JSON.parse(await readFile(statePath, "utf8"));
    expect(state).toMatchObject({
      pluginAgentModelSelectionOverrides: { [agentId]: selection },
      builtInModelSelectionOverrides: { Explore: selection },
      disabledAgentIds: ["user:user:disabled"],
    });
    expect(state.pluginAgentModelOverrides).toBeUndefined();
    const result = await service.list({ workspacePath: join(home, "workspace"), provider: "glm" });
    expect(result.pluginAgents[0]).toMatchObject({
      modelSelection: selection,
      modelSelectionOverride: selection,
      defaultModelSelection: {
        providerId: "p",
        modelId: "old",
        options: { reasoningLevel: "low" },
      },
    });
    expect(result.agents.filter((a) => a.source === "plugin").map((a) => a.modelSelection)).toEqual(
      [selection, selection],
    );
    await service.setPluginAgentModelOverride({
      agentId,
      modelSelection: { providerId: "p", modelId: "no-effort" },
    });
    const modelOnly = await service.list({
      workspacePath: join(home, "workspace"),
      provider: "glm",
    });
    expect(modelOnly.pluginAgents[0]?.modelSelection).toEqual({
      providerId: "p",
      modelId: "no-effort",
    });
    await service.setPluginAgentModelOverride({ agentId });
    const cleared = await service.list({ workspacePath: join(home, "workspace"), provider: "glm" });
    expect(cleared.pluginAgents[0]?.modelSelectionOverride).toBeUndefined();
    expect(cleared.pluginAgents[0]?.modelSelection).toEqual({
      providerId: "p",
      modelId: "old",
      options: { reasoningLevel: "low" },
    });
    expect(
      JSON.parse(await readFile(statePath, "utf8")).pluginAgentModelSelectionOverrides,
    ).toEqual({});
    expect(await readFile(path, "utf8")).toBe(markdown);
  });

  it("serializes user subagent markdown with runtime profile fields", () => {
    const markdown = serializeSubagentMarkdown({
      name: "code-reviewer",
      description: "提交前审查代码",
      systemPrompt: "你是严格的代码审查员。",
      color: "cyan",
      modelSelection: {
        providerId: "provider-a",
        modelId: "lite",
        options: { reasoningLevel: "high" },
      },
      tools: ["Read", "Grep", "Bash(git diff *)"],
      disallowedTools: ["Write"],
      skills: ["code-review"],
      permissionMode: "acceptEdits",
      maxTurns: 7,
      background: true,
      injectAgentsMd: false,
    });

    expect(markdown).toContain('name: "code-reviewer"');
    expect(markdown).toContain('description: "提交前审查代码"');
    expect(markdown).toContain("tools:");
    expect(markdown).toContain("- Read");
    expect(markdown).toContain("- Bash(git diff *)");
    expect(markdown).toContain("permissionMode: acceptEdits");
    expect(markdown).toContain("model: provider-a/lite");
    expect(markdown).toContain("thoughtLevel: high");
    expect(markdown).not.toContain("modelSelection:");
    expect(markdown).toContain("maxTurns: 7");
    expect(markdown).toContain("background: true");
    expect(markdown).toContain("injectAgentsMd: false");
    expect(markdown).toContain("你是严格的代码审查员。");
  });

  it("parses user subagent markdown into the settings summary shape", () => {
    const parsed = parseSubagentMarkdown({
      content: `---
name: code-reviewer
description: 提交前审查代码
model: custom:custom-openai:lite
thoughtLevel: high
tools:
  - Read
  - Bash(git diff *)
disallowedTools:
  - Write
skills:
  - code-review
permissionMode: acceptEdits
maxTurns: 7
background: true
injectAgentsMd: true
color: cyan
---
你是严格的代码审查员。`,
      path: "/tmp/code-reviewer.md",
      scope: "user",
    });

    expect(parsed.diagnostic).toBeUndefined();
    expect(parsed.agent).toMatchObject({
      id: "user:user:code-reviewer",
      name: "code-reviewer",
      description: "提交前审查代码",
      modelSelection: {
        providerId: "custom-openai",
        modelId: "lite",
        options: { reasoningLevel: "high" },
      },
      tools: ["Read", "Bash(git diff *)"],
      disallowedTools: ["Write"],
      skills: ["code-review"],
      permissionMode: "acceptEdits",
      maxTurns: 7,
      background: true,
      injectAgentsMd: true,
      color: "cyan",
      enabled: true,
      readOnly: false,
      systemPrompt: "你是严格的代码审查员。",
    });
  });

  it("preserves concrete model select values from subagent markdown", () => {
    const markdown = serializeSubagentMarkdown({
      name: "custom-model-reviewer",
      description: "Use selected model",
      systemPrompt: "Review carefully.",
      modelSelection: {
        providerId: "custom-openai",
        modelId: "gpt-5.4",
        options: { reasoningLevel: "high" },
      },
    });
    const parsed = parseSubagentMarkdown({
      content: markdown,
      path: "/tmp/custom-model-reviewer.md",
      scope: "user",
    });

    expect(markdown).toContain("model: custom-openai/gpt-5.4");
    expect(parsed.agent?.modelSelection).toEqual({
      providerId: "custom-openai",
      modelId: "gpt-5.4",
      options: { reasoningLevel: "high" },
    });
  });

  it.each([true, false])(
    "round-trips injectAgentsMd=%s through subagent markdown",
    (injectAgentsMd) => {
      const markdown = serializeSubagentMarkdown({
        name: "instruction-aware-reviewer",
        description: "Controls AGENTS.md injection",
        systemPrompt: "Review carefully.",
        injectAgentsMd,
      });
      const parsed = parseSubagentMarkdown({
        content: markdown,
        path: "/tmp/instruction-aware-reviewer.md",
        scope: "user",
      });

      expect(parsed.agent?.injectAgentsMd).toBe(injectAgentsMd);
    },
  );

  it("keeps missing injectAgentsMd unset for legacy markdown", () => {
    const parsed = parseSubagentMarkdown({
      content: `---
name: legacy-reviewer
description: Legacy profile
---
Review carefully.`,
      path: "/tmp/legacy-reviewer.md",
      scope: "user",
    });

    expect(parsed.agent?.injectAgentsMd).toBeUndefined();
  });

  it("parses runtime-compatible loose frontmatter that is not strict YAML", () => {
    const parsed = parseSubagentMarkdown({
      content: `---
name: reviewer
description: foo: bar
tools:
  - Read
  - Bash(git commit -m foo: bar)
---
prompt`,
      path: "/tmp/reviewer.md",
      scope: "user",
    });

    expect(parsed.diagnostic).toBeUndefined();
    expect(parsed.agent).toMatchObject({
      name: "reviewer",
      description: "foo: bar",
      tools: ["Read", "Bash(git commit -m foo: bar)"],
    });
  });

  it("round-trips structured mcpServers entries through markdown serialization", () => {
    const mcpServers = [
      {
        name: "github",
        command: "gh",
        args: ["repo", "view"],
        env: {
          GITHUB_TOKEN: "${GITHUB_TOKEN}",
        },
      },
      {
        name: "linear",
        type: "sse",
        url: "https://mcp.linear.app/sse",
      },
    ];

    const markdown = serializeSubagentMarkdown({
      name: "mcp-reviewer",
      description: "checks changes with MCP context",
      systemPrompt: "Use MCP context when available.",
      mcpServers,
    });
    const parsed = parseSubagentMarkdown({
      content: markdown,
      path: "/tmp/mcp-reviewer.md",
      scope: "user",
    });

    expect(parsed.diagnostic).toBeUndefined();
    expect(parsed.agent?.mcpServers).toEqual(mcpServers);
  });
});

describe("subagent storage roots", () => {
  it("uses runtime storage.dir agents root for user subagents", async () => {
    const home = await makeTempHome();
    const storageRoot = join(home, "custom-storage");
    await mkdir(join(home, ".zcode", "cli"), { recursive: true });
    await writeFile(
      join(home, ".zcode", "cli", "config.json"),
      JSON.stringify({ storage: { dir: storageRoot } }),
      "utf8",
    );

    await expect(resolveUserSubagentRoot({ homeDir: home })).resolves.toBe(
      join(storageRoot, "agents"),
    );
    await expect(resolveSubagentStateFile({ homeDir: home })).resolves.toBe(
      join(storageRoot, "v2", "agents-state.json"),
    );
  });
});

describe("createSubagentsService", () => {
  it("用户 Markdown 先原地迁移后正式读取，项目文件和中间格式不自动迁", async () => {
    const home = await makeTempHome();
    const userRoot = await resolveUserSubagentRoot({ homeDir: home });
    const workspacePath = join(home, "workspace");
    const projectRoot = join(workspacePath, ".zcode", "agents");
    await mkdir(userRoot, { recursive: true });
    await mkdir(projectRoot, { recursive: true });
    const content =
      "---\nname: helper\ndescription: review\nmodel: builtin:zai-coding-plan/m\nthoughtLevel: high\n# comment\nextra: user-data\n---\n正文 builtin:zai-coding-plan/m\n";
    const userFile = join(userRoot, "helper.md");
    const projectFile = join(projectRoot, "project.md");
    await writeFile(userFile, content);
    await writeFile(projectFile, content.replace("name: helper", "name: project-helper"));
    const service = createSubagentsService({ homeDir: home, isDesktopRuntime: true });
    const result = await service.list({ workspacePath });
    expect(result.agents.find((agent) => agent.name === "helper")?.modelSelection?.providerId).toBe(
      "account:zai-individual-coding-plan",
    );
    expect(
      result.agents.find((agent) => agent.name === "project-helper")?.modelSelection?.providerId,
    ).toBe("builtin:zai-coding-plan");
    expect(await readFile(userFile, "utf8")).toBe(
      content.replace(
        "model: builtin:zai-coding-plan",
        "model: account:zai-individual-coding-plan",
      ),
    );
    expect(await readFile(projectFile, "utf8")).toBe(
      content.replace("name: helper", "name: project-helper"),
    );
    expect(
      (
        await createSubagentsService({ homeDir: home, isDesktopRuntime: true }).list({
          workspacePath,
        })
      ).agents.find((agent) => agent.name === "helper")?.modelSelection,
    ).toEqual(result.agents.find((agent) => agent.name === "helper")?.modelSelection);
  });
  it("损坏的 Subagent state 不阻塞整个会话启动，也不覆盖原文件", async () => {
    const home = await makeTempHome();
    const path = await resolveSubagentStateFile({ homeDir: home });
    await mkdir(join(home, ".zcode", "v2"), { recursive: true });
    const original = '{"builtInModelOverrides":';
    await writeFile(path, original);
    await expect(
      createSubagentsService({ homeDir: home }).prepareRuntimeState(),
    ).resolves.toBeUndefined();
    expect(await readFile(path, "utf8")).toBe(original);
  });

  it("启动准备将旧内置选择落盘，让独立 Agent loader 不必等待用户编辑", async () => {
    const home = await makeTempHome();
    const statePath = await resolveSubagentStateFile({ homeDir: home });
    await mkdir(join(home, ".zcode", "v2"), { recursive: true });
    const legacy = {
      builtInModelOverrides: { Explore: "custom:builtin%3Azai-coding-plan:GLM-5.3-Flash" },
      builtInThoughtLevelOverrides: { Explore: "high" },
      disabledAgentIds: ["disabled-profile"],
    };
    await writeFile(statePath, JSON.stringify(legacy));
    const service = createSubagentsService({
      homeDir: home,
    });
    await service.prepareRuntimeState();
    const saved = JSON.parse(await readFile(statePath, "utf8"));
    expect(saved).toMatchObject(legacy);
    expect(saved.builtInModelSelectionOverrides.Explore).toEqual({
      providerId: "account:zai-individual-coding-plan",
      modelId: "GLM-5.3-Flash",
      options: { reasoningLevel: "high" },
    });
    await service.setBuiltInModelOverride({ agentName: "Explore", modelSelection: undefined });
    await service.prepareRuntimeState();
    expect(JSON.parse(await readFile(statePath, "utf8")).builtInModelSelectionOverrides).toEqual(
      {},
    );
  });

  it("并发启动导入与新版手动清空，写队列保留用户结果", async () => {
    const home = await makeTempHome();
    const statePath = await resolveSubagentStateFile({ homeDir: home });
    await mkdir(join(home, ".zcode", "v2"), { recursive: true });
    await writeFile(
      statePath,
      JSON.stringify({ builtInModelOverrides: { Explore: "custom:builtin%3Azai-coding-plan:m" } }),
    );
    const service = createSubagentsService({ homeDir: home });
    await Promise.all([
      service.prepareRuntimeState(),
      service.setBuiltInModelOverride({ agentName: "Explore", modelSelection: undefined }),
    ]);
    await service.prepareRuntimeState();
    expect(JSON.parse(await readFile(statePath, "utf8")).builtInModelSelectionOverrides).toEqual(
      {},
    );
  });

  it("旧内置模型覆盖导入并随正常保存固定；旧字段仅保留供回滚", async () => {
    const home = await makeTempHome();
    const statePath = await resolveSubagentStateFile({ homeDir: home });
    await mkdir(join(home, ".zcode", "v2"), { recursive: true });
    const legacy = {
      builtInModelOverrides: { Explore: "custom:builtin%3Azai-coding-plan:GLM-5.3-Flash" },
      builtInThoughtLevelOverrides: { Explore: "high" },
      disabledAgentIds: [],
    };
    await writeFile(statePath, JSON.stringify(legacy));
    const service = createSubagentsService({
      homeDir: home,
      isDesktopRuntime: true,
    });
    const params = { workspacePath: join(home, "workspace"), mode: "settingsUserOnly" as const };
    const listed = await service.list(params);
    const explore = listed.agents.find((agent) => agent.name === "Explore")!;
    expect(explore.modelSelection).toEqual({
      providerId: "account:zai-individual-coding-plan",
      modelId: "GLM-5.3-Flash",
      options: { reasoningLevel: "high" },
    });
    await service.setEnabled({ agentId: explore.id, enabled: false });
    const saved = JSON.parse(await readFile(statePath, "utf8"));
    expect(saved).toMatchObject({
      builtInModelOverrides: legacy.builtInModelOverrides,
      builtInThoughtLevelOverrides: legacy.builtInThoughtLevelOverrides,
    });
    expect(saved.builtInModelSelectionOverrides.Explore).toEqual(explore.modelSelection);
    await service.setBuiltInModelOverride({ agentName: "Explore", modelSelection: undefined });
    expect(
      (await service.list(params)).agents.find((agent) => agent.name === "Explore")?.modelSelection,
    ).toBeUndefined();
  });

  it("persists model overrides for built-in subagents without making them editable", async () => {
    const home = await makeTempHome();
    const workspacePath = join(home, "workspace");
    const service = createSubagentsService({
      homeDir: home,
      isDesktopRuntime: true,
    });

    await service.setBuiltInModelOverride({
      agentName: "general-purpose",
      modelSelection: {
        providerId: "custom-openai",
        modelId: "gpt-5.4",
        options: { reasoningLevel: "high" },
      },
    });
    await service.setBuiltInModelOverride({
      agentName: "Explore",
      modelSelection: {
        providerId: "custom-openai",
        modelId: "glm-5.2",
        options: { reasoningLevel: "max" },
      },
    });

    const result = await service.list({
      workspacePath,
      provider: "glm",
      mode: "settingsUserOnly",
    });
    const state = JSON.parse(
      await readFile(await resolveSubagentStateFile({ homeDir: home }), "utf8"),
    ) as {
      builtInModelSelectionOverrides: Record<string, unknown>;
      disabledAgentIds: string[];
    };

    expect(result.agents.find((agent) => agent.name === "general-purpose")).toMatchObject({
      modelSelection: {
        providerId: "custom-openai",
        modelId: "gpt-5.4",
        options: { reasoningLevel: "high" },
      },
      modelSelectionOverride: {
        providerId: "custom-openai",
        modelId: "gpt-5.4",
        options: { reasoningLevel: "high" },
      },
      readOnly: true,
    });
    expect(result.agents.find((agent) => agent.name === "Explore")).toMatchObject({
      modelSelection: {
        providerId: "custom-openai",
        modelId: "glm-5.2",
        options: { reasoningLevel: "max" },
      },
      modelSelectionOverride: {
        providerId: "custom-openai",
        modelId: "glm-5.2",
        options: { reasoningLevel: "max" },
      },
      readOnly: true,
    });
    expect(state.builtInModelSelectionOverrides).toEqual({
      Explore: {
        providerId: "custom-openai",
        modelId: "glm-5.2",
        options: { reasoningLevel: "max" },
      },
      "general-purpose": {
        providerId: "custom-openai",
        modelId: "gpt-5.4",
        options: { reasoningLevel: "high" },
      },
    });
  });

  it("clears a built-in subagent model override and restores inheritance", async () => {
    const home = await makeTempHome();
    const workspacePath = join(home, "workspace");
    const service = createSubagentsService({
      homeDir: home,
      isDesktopRuntime: true,
    });

    await service.setBuiltInModelOverride({
      agentName: "Explore",
      modelSelection: {
        providerId: "custom-openai",
        modelId: "glm-5.2",
        options: { reasoningLevel: "max" },
      },
    });
    await service.setBuiltInModelOverride({
      agentName: "Explore",
      modelSelection: undefined,
    });

    const result = await service.list({
      workspacePath,
      provider: "glm",
      mode: "settingsUserOnly",
    });

    expect(result.agents.find((agent) => agent.name === "Explore")).toMatchObject({
      modelSelection: undefined,
      modelSelectionOverride: undefined,
      readOnly: true,
    });
    const state = JSON.parse(
      await readFile(await resolveSubagentStateFile({ homeDir: home }), "utf8"),
    ) as {
      builtInModelSelectionOverrides: Record<string, unknown>;
    };
    expect(state.builtInModelSelectionOverrides).toEqual({});
  });

  it("settings user-only list hides workspace agents but keeps built-ins and user agents", async () => {
    const home = await makeTempHome();
    const workspacePath = join(home, "workspace");
    await mkdir(join(home, ".zcode", "agents"), { recursive: true });
    await mkdir(join(workspacePath, ".zcode", "agents"), { recursive: true });
    await writeFile(
      join(home, ".zcode", "agents", "code-reviewer.md"),
      serializeSubagentMarkdown({
        name: "code-reviewer",
        description: "提交前审查代码",
        systemPrompt: "你是严格的代码审查员。",
      }),
      "utf8",
    );
    await writeFile(
      join(workspacePath, ".zcode", "agents", "workspace-reviewer.md"),
      serializeSubagentMarkdown({
        name: "workspace-reviewer",
        description: "工作区审查",
        systemPrompt: "workspace prompt",
      }),
      "utf8",
    );
    const service = createSubagentsService({
      homeDir: home,
      isDesktopRuntime: true,
    });

    const result = await service.list({
      workspacePath,
      provider: "glm",
      mode: "settingsUserOnly",
    });

    expect(result.agents.map((agent) => agent.name)).toEqual([
      "general-purpose",
      "Explore",
      "code-reviewer",
    ]);
    expect(result.agents.every((agent) => agent.scope !== "workspace")).toBe(true);

    // Bugfix 回归：workspace profile 曾被 parser 标为 readOnly，于是在设置页既不可编辑
    // 也不可删除，还被归入“内置”分组。只有内置 agent 才是真正只读的。
    const allScopes = await service.list({
      workspacePath,
      provider: "glm",
    });
    expect(allScopes.agents.find((agent) => agent.name === "workspace-reviewer")).toMatchObject({
      scope: "workspace",
      source: "user",
      readOnly: false,
    });
    expect(result.agents.find((agent) => agent.name === "general-purpose")?.readOnly).toBe(true);
    expect(result.agents.find((agent) => agent.name === "general-purpose")?.color).toBe("blue");
    expect(result.agents.find((agent) => agent.name === "Explore")?.color).toBe("cyan");
    expect(result.agents.find((agent) => agent.name === "code-reviewer")?.readOnly).toBe(false);
  });

  it("lists enabled plugin agents from installed plugin cache", async () => {
    const home = await makeTempHome();
    const workspacePath = join(home, "workspace");
    const pluginRoot = join(
      home,
      ".zcode",
      "cli",
      "plugins",
      "cache",
      "claude-plugins-official",
      "feature-dev",
      "0.0.0",
    );
    await mkdir(join(home, ".zcode", "cli", "plugins"), { recursive: true });
    await mkdir(join(pluginRoot, ".claude-plugin"), { recursive: true });
    await mkdir(join(pluginRoot, "agents"), { recursive: true });
    await writeFile(
      join(home, ".zcode", "cli", "config.json"),
      JSON.stringify({
        plugins: {
          enabledPlugins: {
            "feature-dev@claude-plugins-official": true,
          },
        },
      }),
      "utf8",
    );
    await writeFile(
      join(home, ".zcode", "cli", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "feature-dev@claude-plugins-official",
            name: "feature-dev",
            marketplace: "claude-plugins-official",
            version: "0.0.0",
            installPath: pluginRoot,
            installedAt: "2026-06-27T00:00:00.000Z",
            scope: "user",
          },
        ],
      }),
      "utf8",
    );
    await writeFile(
      join(pluginRoot, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "feature-dev", description: "Feature workflow" }),
      "utf8",
    );
    await writeFile(
      join(pluginRoot, "agents", "code-architect.md"),
      `---
name: code-architect
description: 设计功能架构
tools:
  - Read
---
架构 prompt`,
      "utf8",
    );
    const service = createSubagentsService({
      homeDir: home,
      isDesktopRuntime: true,
    });

    const result = await service.list({ workspacePath, provider: "glm" });

    expect(
      result.agents.filter((agent) => agent.source === "plugin").map((agent) => agent.name),
    ).toEqual(["code-architect", "feature-dev:code-architect"]);
    expect(result.pluginAgents.map((agent) => agent.name)).toEqual(["feature-dev:code-architect"]);
    expect(new Set(result.pluginAgents.map((agent) => agent.path))).toEqual(
      new Set([join(pluginRoot, "agents", "code-architect.md")]),
    );
    expect(result.pluginAgents.every((agent) => agent.source === "plugin")).toBe(true);
    expect(result.pluginAgents.every((agent) => agent.readOnly)).toBe(true);
  });

  it("lists built-in official plugin agents from the official cache without an install record", async () => {
    // Bug 根因：discoverPluginAgents 只读 installed_plugins.json，内置官方插件由 CLI seed 到
    // cache/zcode-plugins-official 且没有安装记录，documents:visual-judge 在 Settings 永远不可见。
    const home = await makeTempHome();
    const workspacePath = join(home, "workspace");
    const oldRoot = await writeOfficialPluginFixture(home, "documents", "0.1.2", "visual-judge");
    const newRoot = await writeOfficialPluginFixture(home, "documents", "0.1.4", "visual-judge");
    await mkdir(join(newRoot, "..", "0.1.4.backup-1"), { recursive: true });
    await mkdir(join(newRoot, "..", ".seed-lock"), { recursive: true });
    // ios-simulator 不在默认启用集合里，且 config 没有显式启用，必须被忽略。
    await writeOfficialPluginFixture(home, "ios-simulator", "0.2.0", "simulator-runner");
    // browser-use 默认启用，但被用户「卸载」进入 suppressedBuiltins，同样不能贡献 agent。
    await writeOfficialPluginFixture(home, "browser-use", "0.5.0", "browser-auditor");
    await writeFile(
      join(home, ".zcode", "cli", "config.json"),
      JSON.stringify({
        plugins: {
          suppressedBuiltins: ["browser-use@zcode-plugins-official"],
        },
      }),
      "utf8",
    );
    const service = createSubagentsService({ homeDir: home, isDesktopRuntime: true });

    const result = await service.list({ workspacePath, provider: "glm" });

    expect(result.pluginAgents.map((agent) => agent.name)).toEqual(["documents:visual-judge"]);
    expect(result.pluginAgents[0]).toMatchObject({
      id: "plugin:documents@zcode-plugins-official:visual-judge",
      pluginId: "documents@zcode-plugins-official",
      pluginName: "documents",
      // 多版本缓存共存时取数字感知最新的版本目录，而不是字典序首项。
      path: join(newRoot, "agents", "visual-judge.md"),
      scope: "user",
      source: "plugin",
    });
    expect(result.pluginAgents[0]?.path).not.toBe(join(oldRoot, "agents", "visual-judge.md"));
    expect(
      result.agents.filter((agent) => agent.source === "plugin").map((agent) => agent.name),
    ).toEqual(["documents:visual-judge", "visual-judge"]);
  });

  it("prefers the install record over the official cache for the same plugin id", async () => {
    const home = await makeTempHome();
    const workspacePath = join(home, "workspace");
    await writeOfficialPluginFixture(home, "documents", "0.1.4", "visual-judge");
    const installedRoot = join(home, "installed", "documents");
    await mkdir(join(installedRoot, ".zcode-plugin"), { recursive: true });
    await mkdir(join(installedRoot, "agents"), { recursive: true });
    await writeFile(
      join(installedRoot, ".zcode-plugin", "plugin.json"),
      JSON.stringify({ name: "documents" }),
      "utf8",
    );
    await writeFile(
      join(installedRoot, "agents", "visual-judge.md"),
      "---\nname: visual-judge\ndescription: installed visual-judge\n---\ninstalled prompt",
      "utf8",
    );
    await writeFile(
      join(home, ".zcode", "cli", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "documents@zcode-plugins-official",
            name: "documents",
            marketplace: "zcode-plugins-official",
            version: "9.9.9",
            installPath: installedRoot,
            scope: "user",
          },
        ],
      }),
      "utf8",
    );
    await writeFile(
      join(home, ".zcode", "cli", "config.json"),
      JSON.stringify({
        plugins: { enabledPlugins: { "documents@zcode-plugins-official": true } },
      }),
      "utf8",
    );
    const service = createSubagentsService({ homeDir: home, isDesktopRuntime: true });

    const result = await service.list({ workspacePath, provider: "glm" });

    expect(result.pluginAgents.map((agent) => agent.path)).toEqual([
      join(installedRoot, "agents", "visual-judge.md"),
    ]);
  });

  it("persists plugin agent model overrides by agent id and echoes them in list", async () => {
    const home = await makeTempHome();
    const workspacePath = join(home, "workspace");
    const pluginRoot = await writeOfficialPluginFixture(home, "documents", "0.1.4", "visual-judge", {
      model: "custom:custom-openai:gpt-5.4",
    });
    const agentId = "plugin:documents@zcode-plugins-official:visual-judge";
    const service = createSubagentsService({ homeDir: home, isDesktopRuntime: true });

    const before = await service.list({ workspacePath, provider: "glm" });
    expect(before.pluginAgents[0]).toMatchObject({
      defaultModelSelection: { providerId: "custom-openai", modelId: "gpt-5.4" },
      modelSelection: { providerId: "custom-openai", modelId: "gpt-5.4" },
      path: join(pluginRoot, "agents", "visual-judge.md"),
    });
    expect(before.pluginAgents[0]?.modelSelectionOverride).toBeUndefined();

    const selection = {
      providerId: "custom-openai",
      modelId: "glm-5.2",
      options: { reasoningLevel: "high" },
    };
    await service.setPluginAgentModelOverride({
      agentId,
      modelSelection: selection,
    });

    const stateFile = await resolveSubagentStateFile({ homeDir: home });
    expect(JSON.parse(await readFile(stateFile, "utf8"))).toMatchObject({
      pluginAgentModelSelectionOverrides: { [agentId]: selection },
    });
    const overridden = await service.list({ workspacePath, provider: "glm" });
    expect(overridden.pluginAgents[0]).toMatchObject({
      defaultModelSelection: { providerId: "custom-openai", modelId: "gpt-5.4" },
      modelSelection: selection,
      modelSelectionOverride: selection,
    });
    // 运行时投影（规范名 + 裸名别名）与设置页资源投影必须回显同一覆盖，否则 @ 提及与设置页不一致。
    expect(
      overridden.agents.filter((agent) => agent.source === "plugin").map((agent) => agent.modelSelection),
    ).toEqual([selection, selection]);

    // 清除完整选择时一并清掉档位，回落到 md 声明；不恢复旧双 map 保存入口。
    await service.setPluginAgentModelOverride({ agentId });
    const cleared = await service.list({ workspacePath, provider: "glm" });
    expect(cleared.pluginAgents[0]).toMatchObject({
      modelSelection: { providerId: "custom-openai", modelId: "gpt-5.4" },
    });
    expect(cleared.pluginAgents[0]?.modelSelectionOverride).toBeUndefined();
    expect(JSON.parse(await readFile(stateFile, "utf8"))).toMatchObject({
      pluginAgentModelSelectionOverrides: {},
    });
  });

  it("creates user agents in the runtime-consumed user agents root", async () => {
    const home = await makeTempHome();
    const service = createSubagentsService({
      homeDir: home,
      isDesktopRuntime: true,
    });

    const result = await service.createAgent({
      provider: "glm",
      config: {
        name: "code-reviewer",
        description: "提交前审查代码",
        systemPrompt: "你是严格的代码审查员。",
        tools: ["Read", "Grep"],
      },
    });

    expect(result.agent.path).toBe(join(home, ".zcode", "agents", "code-reviewer.md"));
    await expect(readFile(result.agent.path, "utf8")).resolves.toContain("你是严格的代码审查员。");
  });

  it("creates and updates workspace agents in the selected workspace root", async () => {
    const home = await makeTempHome();
    const workspacePath = join(home, "workspace");
    const service = createSubagentsService({
      homeDir: home,
      isDesktopRuntime: true,
    });
    const created = await service.createAgent({
      provider: "glm",
      scope: "workspace",
      workspacePath,
      workspaceIdentity: "ssh://dev/workspace",
      config: {
        name: "workspace-reviewer",
        description: "reviews this workspace",
        systemPrompt: "Review workspace changes.",
      },
    });

    expect(created.agent).toMatchObject({
      scope: "workspace",
      projectPath: workspacePath,
      path: join(workspacePath, ".zcode", "agents", "workspace-reviewer.md"),
    });

    const updated = await service.updateAgent({
      agentId: created.agent.id,
      oldFilePath: created.agent.path,
      provider: "glm",
      scope: "workspace",
      workspacePath,
      workspaceIdentity: "ssh://dev/workspace",
      config: {
        name: "workspace-reviewer-v2",
        description: "reviews this workspace",
        systemPrompt: "Review workspace changes carefully.",
      },
    });
    expect(updated.agent.scope).toBe("workspace");
    expect(updated.agent.path).toBe(
      join(workspacePath, ".zcode", "agents", "workspace-reviewer-v2.md"),
    );
    await expect(readFile(updated.agent.path, "utf8")).resolves.toContain(
      "Review workspace changes carefully.",
    );
  });

  it("removes a custom thoughtLevel when the updated config omits it", async () => {
    const home = await makeTempHome();
    const service = createSubagentsService({
      homeDir: home,
      isDesktopRuntime: true,
    });
    const created = await service.createAgent({
      provider: "glm",
      config: {
        name: "effort-reviewer",
        description: "Review with explicit effort",
        systemPrompt: "Review carefully.",
        modelSelection: {
          providerId: "custom-openai",
          modelId: "gpt-5.4",
          options: { reasoningLevel: "high" },
        },
      },
    });

    await service.updateAgent({
      agentId: created.agent.id,
      oldFilePath: created.agent.path,
      provider: "glm",
      config: {
        name: "effort-reviewer",
        description: "Review with model default effort",
        systemPrompt: "Review carefully.",
        modelSelection: { providerId: "custom-openai", modelId: "gpt-5.4" },
      },
    });

    const markdown = await readFile(created.agent.path, "utf8");
    expect(markdown).toContain("model: custom-openai/gpt-5.4");
    expect(markdown).not.toContain("thoughtLevel:");
  });

  it("creates agents with wildcard and colon tool patterns as valid markdown", async () => {
    const home = await makeTempHome();
    const service = createSubagentsService({
      homeDir: home,
      isDesktopRuntime: true,
    });

    const result = await service.createAgent({
      provider: "glm",
      config: {
        name: "wildcard-runner",
        description: "runs broad tools",
        systemPrompt: "Use the selected tools.",
        tools: ["*", "Bash(git commit -m foo: bar)"],
      },
    });

    expect(result.agent.tools).toEqual(["*", "Bash(git commit -m foo: bar)"]);
    const raw = await readFile(result.agent.path, "utf8");
    expect(raw).toContain('  - "*"');
    expect(raw).toContain('  - "Bash(git commit -m foo: bar)"');
    expect(
      parseSubagentMarkdown({
        content: raw,
        path: result.agent.path,
        scope: "user",
      }).diagnostic,
    ).toBeUndefined();
  });

  it("preserves disabled state when a user agent is renamed", async () => {
    const home = await makeTempHome();
    const service = createSubagentsService({
      homeDir: home,
      isDesktopRuntime: true,
    });
    const created = await service.createAgent({
      provider: "glm",
      config: {
        name: "code-reviewer",
        description: "reviews code",
        systemPrompt: "Review the code.",
      },
    });
    await service.setEnabled({
      agentId: created.agent.id,
      enabled: false,
    });
    await service.setBuiltInModelOverride({
      agentName: "Explore",
      modelSelection: { providerId: "custom-openai", modelId: "glm-5.2" },
    });

    const renamed = await service.updateAgent({
      agentId: created.agent.id,
      oldFilePath: created.agent.path,
      provider: "glm",
      config: {
        name: "code-reviewer-v2",
        description: "reviews code",
        systemPrompt: "Review the code.",
      },
    });
    const listed = await service.list({
      workspacePath: join(home, "workspace"),
      provider: "glm",
      mode: "settingsUserOnly",
    });
    const state = JSON.parse(
      await readFile(await resolveSubagentStateFile({ homeDir: home }), "utf8"),
    ) as {
      builtInModelSelectionOverrides: Record<string, unknown>;
      disabledAgentIds: string[];
    };

    expect(listed.agents.find((agent) => agent.name === "code-reviewer-v2")?.enabled).toBe(false);
    expect(state.builtInModelSelectionOverrides).toEqual({
      Explore: { providerId: "custom-openai", modelId: "glm-5.2" },
    });
    expect(state.disabledAgentIds).toContain(renamed.agent.id);
    expect(state.disabledAgentIds).not.toContain(created.agent.id);
  });
});
