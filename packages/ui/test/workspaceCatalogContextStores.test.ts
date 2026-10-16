import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ISubagentsService } from "@zcode/services";
import type { AgentSummary } from "@zcode/shared";
import { getSubagentsContextKey, useSubagentsContextStore } from "@/store/subagentsContextStore.js";

function createAgent(workspacePath: string, suffix = "initial"): AgentSummary {
  return {
    id: `agent:${workspacePath}:${suffix}`,
    name: `agent-${workspacePath.split("/").at(-1)}-${suffix}`,
    description: workspacePath,
    systemPrompt: suffix,
    path: `${workspacePath}/.zcode/agents/${suffix}.md`,
    scope: "workspace",
    source: "workspace",
    enabled: true,
  };
}

function createSubagentsService(list: ISubagentsService["list"]): ISubagentsService {
  return {
    list,
    getPrimaryUserAgentsDirectory: vi.fn(async () => ({ path: "/tmp/agents" })),
    createAgent: vi.fn(async () => ({ agent: createAgent("/tmp", "new") })),
    updateAgent: vi.fn(async () => ({ agent: createAgent("/tmp", "updated") })),
    deleteAgent: vi.fn(async () => {}),
    setEnabled: vi.fn(async () => {}),
  };
}

describe("workspace catalog context stores", () => {
  beforeEach(() => {
    useSubagentsContextStore.setState({ contexts: {} });
  });

  it("Subagents 同时按 workspaceIdentity 分桶，不再用全局 latest request 丢掉另一 pane", async () => {
    const workspacePath = "/workspace/shared-path";
    const identityA = "ssh://host-a/workspace/shared-path";
    const identityB = "ssh://host-b/workspace/shared-path";
    const list = vi.fn<ISubagentsService["list"]>(async ({ workspaceIdentity }) => {
      const suffix = workspaceIdentity === identityA ? "host-a" : "host-b";
      const agent = createAgent(workspacePath, suffix);
      return {
        agents: [agent],
        userAgents: [agent],
        pluginAgents: [],
        capability: { userScopeAvailable: true },
        diagnostics: [],
      };
    });
    const service = createSubagentsService(list);

    await Promise.all([
      useSubagentsContextStore.getState().initialize(workspacePath, "glm", service, identityA),
      useSubagentsContextStore.getState().initialize(workspacePath, "glm", service, identityB),
    ]);

    const keyA = getSubagentsContextKey(workspacePath, "glm", identityA);
    const keyB = getSubagentsContextKey(workspacePath, "glm", identityB);
    expect(useSubagentsContextStore.getState().contexts[keyA]?.agents[0]?.name).toBe(
      "agent-shared-path-host-a",
    );
    expect(useSubagentsContextStore.getState().contexts[keyB]?.agents[0]?.name).toBe(
      "agent-shared-path-host-b",
    );
    expect(list).toHaveBeenCalledTimes(2);
  });
});
