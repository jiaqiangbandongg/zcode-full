import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSummary } from "@zcode/shared";
import type { ISubagentsService } from "@zcode/services";
import {
  refreshLoadedSubagentsStoreForWorkspace,
  useSubagentsStore,
} from "../src/store/subagentsStore.js";

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

function createSubagentsServiceMock(overrides?: {
  list?: ISubagentsService["list"];
}): ISubagentsService {
  return {
    list:
      overrides?.list ??
      vi.fn(async () => ({
        agents: [],
        userAgents: [],
        pluginAgents: [],
        capability: { userScopeAvailable: true },
        diagnostics: [],
      })),
    getPrimaryUserAgentsDirectory: vi.fn(async () => ({ path: "/tmp/agents" })),
    createAgent: vi.fn(async () => ({ agent: createAgent("new-agent") })),
    updateAgent: vi.fn(async () => ({ agent: createAgent("updated-agent") })),
    deleteAgent: vi.fn(async () => {}),
    setEnabled: vi.fn(async () => {}),
  };
}

describe("subagentsStore", () => {
  beforeEach(() => {
    useSubagentsStore.setState({
      workspacePath: null,
      workspaceIdentity: null,
      loadedWorkspacePath: null,
      loadedWorkspaceIdentity: null,
      provider: "glm",
      loadedProvider: null,
      agents: [],
      capability: null,
      loading: false,
      error: null,
      operatingAgentId: null,
    });
  });

  it("refresh 会跳过旧的 in-flight list 请求，保证设置页变更后拿到最新 subagent", async () => {
    let resolveStaleList: ((value: Awaited<ReturnType<ISubagentsService["list"]>>) => void) | null =
      null;
    const freshAgent = createAgent("fresh-reviewer");
    const list = vi
      .fn<ISubagentsService["list"]>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveStaleList = resolve;
          }),
      )
      .mockResolvedValueOnce({
        agents: [freshAgent],
        userAgents: [freshAgent],
        pluginAgents: [],
        capability: { userScopeAvailable: true },
        diagnostics: [],
      });
    const service = createSubagentsServiceMock({ list });
    const workspacePath = "/tmp/subagents-refresh-race";

    const initializePromise = useSubagentsStore.getState().initialize(workspacePath, service);
    const refreshPromise = useSubagentsStore.getState().refresh(service);

    expect(list).toHaveBeenCalledTimes(2);

    resolveStaleList?.({
      agents: [createAgent("stale-reviewer")],
      userAgents: [createAgent("stale-reviewer")],
      pluginAgents: [],
      capability: { userScopeAvailable: true },
      diagnostics: [],
    });

    await Promise.all([initializePromise, refreshPromise]);

    expect(useSubagentsStore.getState().agents.map((agent) => agent.name)).toEqual([
      "fresh-reviewer",
    ]);
  });

  it("只刷新当前已加载工作区的 subagent store", async () => {
    const freshAgent = createAgent("settings-created-reviewer");
    const list = vi.fn<ISubagentsService["list"]>(async () => ({
      agents: [freshAgent],
      userAgents: [freshAgent],
      pluginAgents: [],
      capability: { userScopeAvailable: true },
      diagnostics: [],
    }));
    const service = createSubagentsServiceMock({ list });
    const workspacePath = "/tmp/subagents-settings-sync";

    useSubagentsStore.setState({
      workspacePath,
      workspaceIdentity: null,
      loadedWorkspacePath: workspacePath,
      loadedWorkspaceIdentity: null,
      provider: "glm",
      loadedProvider: "glm",
      agents: [createAgent("stale-reviewer")],
      capability: { userScopeAvailable: true },
      loading: false,
      error: null,
    });

    await refreshLoadedSubagentsStoreForWorkspace({
      workspacePath,
      subagentsService: service,
    });

    expect(list).toHaveBeenCalledTimes(1);
    expect(useSubagentsStore.getState().agents.map((agent) => agent.name)).toEqual([
      "settings-created-reviewer",
    ]);

    await refreshLoadedSubagentsStoreForWorkspace({
      workspacePath: "/tmp/other-workspace",
      subagentsService: service,
    });

    expect(list).toHaveBeenCalledTimes(1);
  });
});
