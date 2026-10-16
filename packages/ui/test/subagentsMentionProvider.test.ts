import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AgentSummary } from "@zcode/shared";

const mockSubagentsState = vi.hoisted(() => ({
  agents: [] as AgentSummary[],
  loading: false,
  error: null as string | null,
}));

vi.mock("@/hooks/useSubagents.js", () => ({
  useSubagents: () => mockSubagentsState,
}));

import {
  mapSubagentsToMentionItemsForTest,
  useSubagentsMentionProvider,
} from "../src/mentions/providers/subagentsMentionProvider.js";

function createAgent(name: string): AgentSummary {
  return {
    id: `user:${name}`,
    name,
    description: `${name} description`,
    systemPrompt: `${name} prompt`,
    path: `/tmp/agents/${name}.md`,
    scope: "user",
    source: "user",
    enabled: true,
  };
}

function SubagentMentionProbe({ query }: { query: string }) {
  const result = useSubagentsMentionProvider(
    "/repo",
    "glm",
    query,
    true,
    "No subagents",
    "Subagents",
  );
  return createElement("output", null, result.items.map((item) => item.label).join(","));
}

describe("subagents mention provider", () => {
  it("only includes enabled subagents", () => {
    const items = mapSubagentsToMentionItemsForTest([
      {
        id: "agent-1",
        name: "code-review",
        description: "review code",
        path: "/repo/.claude/agents/code-review.md",
        scope: "workspace",
        source: "user",
        enabled: true,
        modelSelection: { providerId: "anthropic", modelId: "claude-sonnet" },
      },
      {
        id: "agent-2",
        name: "disabled-agent",
        description: "not available",
        path: "/home/user/.claude/agents/disabled.md",
        scope: "user",
        source: "user",
        enabled: false,
      },
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      label: "code-review",
      value: "code-review",
    });
  });

  it("dedupes same-name subagents preferring workspace > user > plugin", () => {
    const items = mapSubagentsToMentionItemsForTest([
      {
        id: "agent-plugin",
        name: "reviewer",
        description: "plugin reviewer",
        path: "/plugins/reviewer/agent.md",
        scope: "user",
        source: "plugin",
        enabled: true,
      },
      {
        id: "agent-user",
        name: "reviewer",
        description: "user reviewer",
        path: "/home/user/.claude/agents/reviewer.md",
        scope: "user",
        source: "user",
        enabled: true,
      },
      {
        id: "agent-workspace",
        name: "reviewer",
        description: "workspace reviewer",
        path: "/repo/.claude/agents/reviewer.md",
        scope: "workspace",
        source: "user",
        enabled: true,
      },
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      label: "reviewer",
      description: "Workspace · workspace reviewer",
      data: {
        scope: "workspace",
        path: "/repo/.claude/agents/reviewer.md",
      },
    });
  });

  it("builds description with source label and agent description", () => {
    const items = mapSubagentsToMentionItemsForTest([
      {
        id: "agent-1",
        name: "browser",
        description: "browse the web",
        path: "/home/user/.claude/agents/browser.md",
        scope: "user",
        source: "user",
        enabled: true,
        modelSelection: { providerId: "anthropic", modelId: "claude-sonnet" },
      },
    ]);

    expect(items[0].description).toBe("User · browse the web");
  });

  it("uses source label alone when description is empty", () => {
    const items = mapSubagentsToMentionItemsForTest([
      {
        id: "agent-1",
        name: "browser",
        description: "",
        path: "/plugins/browser/agent.md",
        scope: "user",
        source: "plugin",
        enabled: true,
      },
    ]);

    expect(items[0].description).toBe("Plugin");
  });

  it("includes name, description, scope, source, model, and path as keywords", () => {
    const items = mapSubagentsToMentionItemsForTest([
      {
        id: "agent-1",
        name: "code-review",
        description: "review code quality",
        path: "/repo/.claude/agents/review.md",
        scope: "workspace",
        source: "user",
        enabled: true,
        modelSelection: { providerId: "zai", modelId: "glm-5.2" },
      },
    ]);

    expect(items[0].keywords).toContain("code-review");
    expect(items[0].keywords).toContain("review code quality");
    expect(items[0].keywords).toContain("workspace");
    expect(items[0].keywords).toContain("user");
    expect(items[0].keywords).toContain("Workspace");
    expect(items[0].keywords).toContain("zai/glm-5.2");
    expect(items[0].keywords).toContain("/repo/.claude/agents/review.md");
  });

  it("generates markdown as @agent-name", () => {
    const items = mapSubagentsToMentionItemsForTest([
      {
        id: "agent-1",
        name: "code-review",
        description: "review code",
        path: "/repo/.claude/agents/review.md",
        scope: "workspace",
        source: "user",
        enabled: true,
      },
    ]);

    expect(items[0].markdown).toBe("@code-review");
    expect(items[0].value).toBe("code-review");
  });

  it("skips agents with empty names", () => {
    const items = mapSubagentsToMentionItemsForTest([
      {
        id: "agent-1",
        name: "  ",
        description: "empty name",
        path: "/repo/.claude/agents/empty.md",
        scope: "workspace",
        source: "user",
        enabled: true,
      },
    ]);

    expect(items).toHaveLength(0);
  });

  it("shows all enabled subagents before the user types a search query", () => {
    mockSubagentsState.agents = [
      createAgent("agent-one"),
      createAgent("agent-two"),
      createAgent("agent-three"),
      createAgent("agent-four"),
      createAgent("agent-five"),
    ];
    mockSubagentsState.loading = false;
    mockSubagentsState.error = null;

    const html = renderToStaticMarkup(createElement(SubagentMentionProbe, { query: "" }));

    expect(html).toContain("agent-one,agent-two,agent-three,agent-four,agent-five");
  });
});
