import { readSourceTextAsync } from "./readSourceText.js";
import { describe, expect, it } from "vitest";

describe("settings subagent row content", () => {
  it("does not repeat the scope already expressed by group headings", async () => {
    const source = await readSourceTextAsync(
      new URL("../src/settings/SubagentsSection.tsx", import.meta.url),
    );
    expect(source).not.toContain("getScopeMessageId");
    expect(source).toContain("showModelBadge ? <AgentBadge>{modelLabel}</AgentBadge>");
    expect(source).toContain("<AgentBadge>{toolsLabel}</AgentBadge>");
    expect(source).toContain(
      '"inline-flex min-h-5 items-center rounded-md bg-surface px-1.5 py-0.5 text-ui-sm text-foreground-subtle ring-1 ring-border"',
    );
    expect(source).not.toContain("rounded-md bg-secondary");
  });

  it("does not expose backing paths or built-in identifiers in list rows", async () => {
    const source = await readSourceTextAsync(
      new URL("../src/settings/SubagentsSection.tsx", import.meta.url),
    );
    expect(source).not.toContain("{agent.path}");
  });

  it("uses the shared scoped resource-list structure", async () => {
    const source = await readSourceTextAsync(
      new URL("../src/settings/SubagentsSection.tsx", import.meta.url),
    );
    expect(source).toContain("<PluginScopeMenu");
    expect(source).toContain('id: "settings.subagents.group.user"');
    // c0a58959fc 起插件 label 统一走 marketplace listing 解析（同名插件跨市场保持独立 label）。
    expect(source).toContain("resolvePluginDisplayName(");
    expect(source).toContain("<PluginSearchEmptyState");
    expect(source).not.toContain("statusFilter");
    expect(source).not.toContain("openUserAgentsFolder");
  });
});
