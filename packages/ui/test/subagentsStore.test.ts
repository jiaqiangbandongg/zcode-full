import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSummary } from "@zcode/shared";
import type { ISubagentsService } from "@zcode/services";
import { getSubagentsContextKey, useSubagentsContextStore } from "@/store/subagentsContextStore.js";
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
    useSubagentsContextStore.setState({ contexts: {} });
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

  it("User 保存刷新同 authority 的所有已加载上下文，不污染同路径远端", async () => {
    const local = createSubagentsServiceMock();
    const remote = createSubagentsServiceMock();
    const contexts = useSubagentsContextStore.getState();
    await useSubagentsStore.getState().initialize("/local-a", local);
    await contexts.initialize("/local-a", "glm", local);
    await contexts.initialize("/local-b", "glm", local);
    await contexts.initialize("/local-a", "glm", remote, "remote:server:source-a:/local-a");
    vi.mocked(local.list)
      .mockClear()
      .mockResolvedValue({
        agents: [createAgent("saved-user-agent")],
        userAgents: [],
        pluginAgents: [],
        capability: { userScopeAvailable: true },
        diagnostics: [],
      });
    vi.mocked(remote.list).mockClear();

    await refreshLoadedSubagentsStoreForWorkspace({ scope: "user", subagentsService: local });

    expect(local.list).toHaveBeenCalledWith(expect.objectContaining({ workspacePath: "/local-a" }));
    expect(local.list).toHaveBeenCalledWith(expect.objectContaining({ workspacePath: "/local-b" }));
    expect(remote.list).not.toHaveBeenCalled();
    expect(useSubagentsStore.getState().agents[0]?.name).toBe("saved-user-agent");
    const key = getSubagentsContextKey("/local-b", "glm", undefined, local);
    expect(useSubagentsContextStore.getState().contexts[key]?.agents[0]?.name).toBe(
      "saved-user-agent",
    );
  });

  it("User 保存不能把已切到另一 authority 的 legacy store 刷成本机", async () => {
    const local = createSubagentsServiceMock();
    const remote = createSubagentsServiceMock();
    await useSubagentsStore
      .getState()
      .initialize("/same", remote, undefined, "remote:server:b:/same");
    vi.mocked(local.list).mockClear();
    vi.mocked(remote.list).mockClear();
    await refreshLoadedSubagentsStoreForWorkspace({ scope: "user", subagentsService: local });
    expect(local.list).not.toHaveBeenCalled();
    expect(remote.list).not.toHaveBeenCalled();
  });

  it("另一远端投影仍在加载时 User 保存不能借旧 loaded authority 发错刷新", async () => {
    const local = createSubagentsServiceMock();
    let complete!: (result: Awaited<ReturnType<ISubagentsService["list"]>>) => void;
    const remote = createSubagentsServiceMock({
      list: () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    });
    await useSubagentsStore.getState().initialize("/same", local);
    const pending = useSubagentsStore
      .getState()
      .initialize("/same", remote, undefined, "remote:server:b:/same");
    vi.mocked(local.list).mockClear();
    await refreshLoadedSubagentsStoreForWorkspace({ scope: "user", subagentsService: local });
    expect(local.list).not.toHaveBeenCalled();
    complete({
      agents: [],
      userAgents: [],
      pluginAgents: [],
      capability: { userScopeAvailable: true },
      diagnostics: [],
    });
    await pending;
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

  it("相同路径的不同 Source service 不复用 in-flight 请求", async () => {
    let resolveFirst: ((value: Awaited<ReturnType<ISubagentsService["list"]>>) => void) | null =
      null;
    const firstList = vi.fn<ISubagentsService["list"]>(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const secondList = vi.fn<ISubagentsService["list"]>(async () => ({
      agents: [],
      userAgents: [],
      pluginAgents: [],
      capability: { userScopeAvailable: true },
      diagnostics: [],
    }));
    const workspacePath = "/root";

    const first = useSubagentsStore
      .getState()
      .initialize(workspacePath, createSubagentsServiceMock({ list: firstList }));
    const second = useSubagentsStore
      .getState()
      .initialize(workspacePath, createSubagentsServiceMock({ list: secondList }));

    expect(firstList).toHaveBeenCalledOnce();
    expect(secondList).toHaveBeenCalledOnce();
    resolveFirst?.({
      agents: [],
      userAgents: [],
      pluginAgents: [],
      capability: { userScopeAvailable: true },
      diagnostics: [],
    });
    await Promise.all([first, second]);
  });

  it("相同路径切换 Source authority 时不会复用上一份子智能体内容", async () => {
    const workspacePath = "/root";
    const oldAgent = createAgent("old-source");
    const firstService = createSubagentsServiceMock({
      list: vi.fn(async () => ({
        agents: [oldAgent],
        userAgents: [oldAgent],
        pluginAgents: [],
        capability: { userScopeAvailable: true },
        diagnostics: [],
      })),
    });
    await useSubagentsStore.getState().initialize(workspacePath, firstService);
    let resolveSecond!: (value: Awaited<ReturnType<ISubagentsService["list"]>>) => void;
    const secondService = createSubagentsServiceMock({
      list: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      ),
    });

    const loadingSecond = useSubagentsStore.getState().initialize(workspacePath, secondService);
    expect(useSubagentsStore.getState().agents).toEqual([]);
    resolveSecond({
      agents: [],
      userAgents: [],
      pluginAgents: [],
      capability: { userScopeAvailable: true },
      diagnostics: [],
    });
    await loadingSecond;
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
