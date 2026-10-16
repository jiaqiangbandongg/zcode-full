import { describe, expect, it } from "vitest";
import {
  createBuiltInExploreAgentProfile,
  createBuiltInGeneralPurposeAgentProfile,
  formatAgentProfilesForPrompt,
  isBuiltInExploreAgentProfile,
  normalizeAgentProfiles,
  parseAgentProfileFromMarkdown,
} from "../src/subagent/profile.js";

describe("subagent profile Markdown parser", () => {
  it.each(['{"providerId":"wrong","modelId":"wrong"}', "null", '{"modelId":"broken"}'])(
    "中间字段不参与正式 Markdown 读取：%s",
    (value) => {
      const result = parseAgentProfileFromMarkdown({
        source: "user",
        content: `---
name: reviewer
description: Review changes
modelSelection: ${value}
model: custom-openai/legacy
thoughtLevel: high
---
Review carefully.`,
      });
      expect(result.profile?.modelSelection).toEqual({
        providerId: "custom-openai",
        modelId: "legacy",
        options: { reasoningLevel: "high" },
      });
    },
  );

  it("parses only exact persistent memory scopes", () => {
    const exact = parseAgentProfileFromMarkdown({
      source: "project",
      content: `---
name: reviewer
description: Review changes
memory: project
---
Review carefully.`,
    });
    const padded = parseAgentProfileFromMarkdown({
      source: "project",
      content: `---
name: reviewer
description: Review changes
memory: " project "
---
Review carefully.`,
    });

    expect(exact.diagnostic).toBeUndefined();
    expect(exact.profile?.memory).toBe("project");
    expect(padded.diagnostic?.code).toBe("agent_invalid_memory_scope");
    expect(padded.profile).toMatchObject({ name: "reviewer", description: "Review changes" });
    expect(padded.profile?.memory).toBeUndefined();
  });

  it("preserves an explicitly empty tools list for persistent memory projection", () => {
    const result = parseAgentProfileFromMarkdown({
      source: "project",
      content: `---
name: reviewer
description: Review changes
memory: project
tools: []
---
Review carefully.`,
    });

    expect(result.profile?.tools).toEqual([]);
  });

  it("parses the P0 custom agent fields consumed by zcode-cli", () => {
    const result = parseAgentProfileFromMarkdown({
      source: "project",
      path: "/workspace/.zcode/agents/zcode-reviewer.md",
      content: `---
name: zcode-reviewer
description: 检查实现边界\\n输出中文结论
model: custom-openai/reviewer-model
thoughtLevel: high
tools: Read, Grep Bash(ls -la)
disallowedTools:
  - Edit
  - Write
skills: code review
color: cyan
permissionMode: acceptEdits
maxTurns: "7"
background: "true"
injectAgentsMd: "false"
mcpServers:
  - local-tools
---
你是 zcode-reviewer。
只输出中文。`,
    });

    expect(result.diagnostic).toBeUndefined();
    expect(result.profile).toMatchObject({
      background: true,
      color: "cyan",
      description: "检查实现边界\n输出中文结论",
      disallowedTools: ["Edit", "Write"],
      maxTurns: 7,
      injectAgentsMd: false,
      modelSelection: {
        providerId: "custom-openai",
        modelId: "reviewer-model",
        options: { reasoningLevel: "high" },
      },
      name: "zcode-reviewer",
      path: "/workspace/.zcode/agents/zcode-reviewer.md",
      skills: ["code", "review"],
      source: "project",
      systemPrompt: "你是 zcode-reviewer。\n只输出中文。",
      tools: ["Read", "Grep", "Bash"],
    });
    expect(result.profile?.mcpServers).toEqual(["local-tools"]);
    expect(result.profile?.permissionMode).toBeUndefined();
  });

  it("preserves concrete provider and custom model values from frontmatter", () => {
    const providerModel = parseAgentProfileFromMarkdown({
      source: "user",
      path: "/home/user/.zcode/agents/reviewer.md",
      content: `---
name: reviewer
description: Use a concrete provider model
model: custom-openai/gpt-5.4
thoughtLevel: high
---
Review carefully.`,
    });
    const customModel = parseAgentProfileFromMarkdown({
      source: "user",
      path: "/home/user/.zcode/agents/reviewer-custom.md",
      content: `---
name: reviewer-custom
description: Use the UI custom model value
model: custom:custom-openai:gpt-5.4
---
Review carefully.`,
    });

    expect(providerModel.profile?.modelSelection).toEqual({
      providerId: "custom-openai",
      modelId: "gpt-5.4",
      options: { reasoningLevel: "high" },
    });
    expect(customModel.profile?.modelSelection).toEqual({
      providerId: "custom-openai",
      modelId: "gpt-5.4",
    });
  });

  it("accepts only server-name lists for mcpServers", () => {
    const invalidFrontmatterValues = [
      "mcpServers: local-tools",
      `mcpServers:
  local-tools:
    type: stdio`,
      "mcpServers: { local-tools: { type: stdio } }",
      "mcpServers: [{ type: stdio, command: local-mcp }]",
      "mcpServers: [local-tools, 42]",
      "mcpServers: [local-tools,, analytics]",
      "mcpServers: [null]",
      "mcpServers: [-1, 1.5]",
      "mcpServers: [[alpha, beta]]",
      "mcpServers:",
    ];

    for (const mcpServers of invalidFrontmatterValues) {
      const result = parseAgentProfileFromMarkdown({
        source: "user",
        content: `---
name: reviewer
description: Review code
${mcpServers}
---
Review carefully.`,
      });

      expect(result.profile).toBeUndefined();
      expect(result.diagnostic?.code).toBe("agent_invalid_mcp_servers");
    }
  });

  it("accepts an explicit empty mcpServers list and trims server names", () => {
    const empty = parseAgentProfileFromMarkdown({
      source: "user",
      content: `---
name: empty-scope
description: Use the parent MCP snapshot
mcpServers: []
---`,
    });
    const scoped = parseAgentProfileFromMarkdown({
      source: "project",
      content: `---
name: scoped
description: Use selected parent MCP servers
mcpServers: [" local-tools ", analytics, "plugin:tools:", "[alpha]"]
---`,
    });

    expect(empty.diagnostic).toBeUndefined();
    expect(empty.profile?.mcpServers).toEqual([]);
    expect(scoped.diagnostic).toBeUndefined();
    expect(scoped.profile?.mcpServers).toEqual([
      "local-tools",
      "analytics",
      "plugin:tools:",
      "[alpha]",
    ]);
  });

  it("keeps invalid nested syntax from reviving a non-MCP list", () => {
    const result = parseAgentProfileFromMarkdown({
      source: "user",
      content: `---
name: reviewer
description: Review code
tools:
  invalid: nested
  - Read
---`,
    });

    expect(result.diagnostic).toBeUndefined();
    expect(result.profile?.tools).toBeUndefined();
  });

  it("formats available profiles for Agent tool descriptions with built-in default agents", () => {
    const prompt = formatAgentProfilesForPrompt([
      {
        name: "zcode-reviewer",
        description: "检查实现边界。",
        source: "project",
        systemPrompt: "只输出中文。",
        tools: ["Read"],
        background: true,
      },
    ]);

    expect(prompt).toContain("Available agent types and the tools they have access to:");
    expect(prompt).toContain("general-purpose");
    expect(prompt).toContain("Explore");
    expect(prompt).toContain("- zcode-reviewer: 检查实现边界。 (Tools: Read)");
    expect(prompt).not.toContain("tools: Read");
    expect(prompt).not.toContain("background: true");
    expect(prompt).not.toContain("model:");
  });

  it("assigns explicit identity colors to built-in agents", () => {
    expect(createBuiltInGeneralPurposeAgentProfile().color).toBe("blue");
    expect(createBuiltInExploreAgentProfile().color).toBe("cyan");
  });

  it("uses explicit AGENTS.md injection defaults for built-in agents", () => {
    expect(createBuiltInGeneralPurposeAgentProfile().injectAgentsMd).toBe(true);
    expect(createBuiltInExploreAgentProfile().injectAgentsMd).toBe(false);
  });

  it("parses explicit AGENTS.md injection while leaving missing custom values unset", () => {
    const explicit = parseAgentProfileFromMarkdown({
      source: "user",
      content: `---
name: inheriting-reviewer
description: Review with workspace instructions
injectAgentsMd: true
---
Review carefully.`,
    });
    const missing = parseAgentProfileFromMarkdown({
      source: "user",
      content: `---
name: legacy-reviewer
description: Legacy profile without the new field
---
Review carefully.`,
    });

    expect(explicit.profile?.injectAgentsMd).toBe(true);
    expect(missing.profile?.injectAgentsMd).toBeUndefined();
  });

  it("identifies Explore by both name and loader-owned source", () => {
    expect(isBuiltInExploreAgentProfile({ name: "Explore", source: "built-in" })).toBe(true);
    expect(isBuiltInExploreAgentProfile({ name: "Explore", source: "user" })).toBe(false);
    expect(isBuiltInExploreAgentProfile({ name: "Explore", source: "project" })).toBe(false);
    expect(isBuiltInExploreAgentProfile({ name: "general-purpose", source: "built-in" })).toBe(
      false,
    );
  });

  it("keeps a custom Explore profile intact when it overrides the built-in profile", () => {
    const profiles = normalizeAgentProfiles(
      [
        {
          name: "Explore",
          description: "Custom mutable explorer",
          source: "project",
          systemPrompt: "Use the project workflow.",
          modelSelection: { providerId: "custom-openai", modelId: "gpt-5.4" },
          tools: ["Write", "mcp__local-tools__query"],
        },
      ],
      {
        builtInModelSelectionOverrides: {
          Explore: {
            providerId: "custom-openai",
            modelId: "glm-5.2",
            options: { reasoningLevel: "max" },
          },
        },
      },
    );

    expect(profiles.find((profile) => profile.name === "Explore")).toMatchObject({
      source: "project",
      modelSelection: { providerId: "custom-openai", modelId: "gpt-5.4" },
      tools: ["Write", "mcp__local-tools__query"],
    });
  });

  it("formats a custom Explore with its declared tools", () => {
    const prompt = formatAgentProfilesForPrompt([
      {
        name: "Explore",
        description: "Custom mutable explorer",
        source: "user",
        systemPrompt: "Use the user workflow.",
        tools: ["Write", "mcp__local-tools__query"],
      },
    ]);

    expect(prompt).toContain(
      "- Explore: Custom mutable explorer (Tools: Write, mcp__local-tools__query)",
    );
    expect(prompt).not.toContain("Tools: Read, Bash, WebFetch, WebSearch, TodoWrite");
  });

  it("leaves built-in Explore on inherited model by default", () => {
    expect(createBuiltInExploreAgentProfile().modelSelection).toBeUndefined();
    expect(
      normalizeAgentProfiles([]).find((profile) => profile.name === "Explore")?.modelSelection,
    ).toBeUndefined();
  });

  it("applies built-in model overrides without changing custom profile precedence", () => {
    const profiles = normalizeAgentProfiles(
      [
        {
          name: "code-reviewer",
          description: "Review code",
          source: "user",
          systemPrompt: "Review carefully.",
          modelSelection: { providerId: "custom-openai", modelId: "gpt-5.4" },
        },
      ],
      {
        builtInModelSelectionOverrides: {
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
        },
      },
    );

    expect(profiles.find((profile) => profile.name === "general-purpose")?.modelSelection).toEqual({
      providerId: "custom-openai",
      modelId: "gpt-5.4",
      options: { reasoningLevel: "high" },
    });
    expect(profiles.find((profile) => profile.name === "Explore")?.modelSelection).toEqual({
      providerId: "custom-openai",
      modelId: "glm-5.2",
      options: { reasoningLevel: "max" },
    });
    expect(profiles.find((profile) => profile.name === "code-reviewer")?.modelSelection).toEqual({
      providerId: "custom-openai",
      modelId: "gpt-5.4",
    });
  });

  it("does not materialize built-in options without a model Selection", () => {
    const profiles = normalizeAgentProfiles([]);
    expect(profiles.find((profile) => profile.name === "Explore")?.modelSelection).toBeUndefined();
  });

  it("formats built-in Explore tools for the embedded search branch", () => {
    const prompt = formatAgentProfilesForPrompt([], {
      embeddedSearchEnabled: true,
    });

    expect(prompt).toContain("Explore");
    expect(prompt).toContain("Tools: Read, Bash, WebFetch, WebSearch, TodoWrite");
    expect(prompt).not.toContain("Glob");
    expect(prompt).not.toContain("Grep");
  });
});
