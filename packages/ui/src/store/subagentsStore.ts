import { create } from "zustand";
import {
  normalizeAgentProviderToZCodeAgent,
  ZCODE_AGENT_PROVIDER,
  type ZCodeProvider,
  type AgentSummary,
  type AgentsCapability,
  type SubAgentConfig,
} from "@zcode/shared";
import type { ISubagentsService } from "@zcode/services";
import { shouldExposeE2EStoreBridge } from "@/lib/e2eStoreBridge.js";
import { logger } from "@/logger.js";
import { getSubagentsContextKey, useSubagentsContextStore } from "@/store/subagentsContextStore.js";
import { getServiceAuthorityId } from "@/store/serviceAuthorityKey.js";
import {
  isLatestAgentLoadRequest,
  loadAgentsOnce,
  nextAgentLoadRequestId,
} from "@/store/subagentsStoreLoading.js";

interface SubagentsStoreState {
  workspacePath: string | null;
  workspaceIdentity: string | null;
  loadedWorkspacePath: string | null;
  loadedWorkspaceIdentity: string | null;
  provider: ZCodeProvider;
  loadedProvider: ZCodeProvider | null;
  agents: AgentSummary[];
  capability: AgentsCapability | null;
  loading: boolean;
  error: string | null;
  /** 正在操作的 agent ID（用于 UI 状态指示） */
  operatingAgentId: string | null;
  initialize: (
    workspacePath: string,
    providerOrSubagentsService: ZCodeProvider | ISubagentsService,
    maybeSubagentsService?: ISubagentsService,
    workspaceIdentity?: string,
  ) => Promise<void>;
  refresh: (subagentsService: ISubagentsService, workspaceIdentity?: string) => Promise<void>;
  setEnabled: (
    agentId: string,
    enabled: boolean,
    subagentsService: ISubagentsService,
    workspaceIdentity?: string,
  ) => Promise<void>;
  createAgent: (
    config: SubAgentConfig,
    provider: ZCodeProvider,
    subagentsService: ISubagentsService,
    workspaceIdentity?: string,
  ) => Promise<AgentSummary | null>;
  updateAgent: (
    agentId: string,
    config: SubAgentConfig,
    oldFilePath: string | undefined,
    provider: ZCodeProvider,
    subagentsService: ISubagentsService,
    workspaceIdentity?: string,
  ) => Promise<AgentSummary | null>;
  deleteAgent: (
    agentId: string,
    filePath: string,
    subagentsService: ISubagentsService,
    workspaceIdentity?: string,
  ) => Promise<boolean>;
}

let loadedSubagentsServiceAuthorityId: number | null = null;

export const useSubagentsStore = create<SubagentsStoreState>((set, get) => ({
  workspacePath: null,
  workspaceIdentity: null,
  loadedWorkspacePath: null,
  loadedWorkspaceIdentity: null,
  provider: ZCODE_AGENT_PROVIDER,
  loadedProvider: null,
  agents: [],
  capability: null,
  loading: false,
  error: null,
  operatingAgentId: null,
  async initialize(
    workspacePath: string,
    providerOrSubagentsService: ZCodeProvider | ISubagentsService,
    maybeSubagentsService?: ISubagentsService,
    workspaceIdentity?: string,
  ) {
    const currentState = get();
    const hasProvider = typeof providerOrSubagentsService === "string";
    const provider = normalizeAgentProviderToZCodeAgent(
      hasProvider ? providerOrSubagentsService : ZCODE_AGENT_PROVIDER,
    );
    const subagentsService = hasProvider ? maybeSubagentsService : providerOrSubagentsService;
    const normalizedWorkspaceIdentity = workspaceIdentity?.trim() || null;
    if (!subagentsService) {
      set({
        workspacePath,
        workspaceIdentity: normalizedWorkspaceIdentity,
        provider,
        loading: false,
        error: "subagentsService is required",
        loadedWorkspacePath: workspacePath,
        loadedWorkspaceIdentity: normalizedWorkspaceIdentity,
        loadedProvider: provider,
      });
      return;
    }
    const serviceAuthorityId = getServiceAuthorityId(subagentsService);
    const hasCachedAgents =
      currentState.agents.length > 0 &&
      loadedSubagentsServiceAuthorityId === serviceAuthorityId &&
      currentState.loadedWorkspacePath === workspacePath &&
      currentState.loadedWorkspaceIdentity === normalizedWorkspaceIdentity &&
      currentState.loadedProvider === provider;
    set({
      workspacePath,
      workspaceIdentity: normalizedWorkspaceIdentity,
      provider,
      agents: hasCachedAgents ? currentState.agents : [],
      capability: hasCachedAgents ? currentState.capability : null,
      loading: !hasCachedAgents,
      error: null,
    });
    const requestId = nextAgentLoadRequestId();
    try {
      const result = await loadAgentsOnce(
        workspacePath,
        provider,
        subagentsService,
        normalizedWorkspaceIdentity ?? undefined,
      );
      if (!isLatestAgentLoadRequest(requestId)) {
        return;
      }
      loadedSubagentsServiceAuthorityId = serviceAuthorityId;
      set({
        agents: result.agents,
        capability: result.capability,
        loading: false,
        loadedWorkspacePath: workspacePath,
        loadedWorkspaceIdentity: normalizedWorkspaceIdentity,
        loadedProvider: provider,
      });
    } catch (error) {
      if (!isLatestAgentLoadRequest(requestId)) {
        return;
      }
      logger.error("[subagents] initialize failed", {
        workspacePath,
        provider,
        error: error instanceof Error ? error.message : String(error),
      });
      set({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
        loadedWorkspacePath: workspacePath,
        loadedWorkspaceIdentity: normalizedWorkspaceIdentity,
        loadedProvider: provider,
      });
    }
  },
  async refresh(subagentsService: ISubagentsService, workspaceIdentity?: string) {
    const workspacePath = get().workspacePath;
    if (!workspacePath) {
      return;
    }
    const workspaceIdentityFromState =
      workspaceIdentity?.trim() || get().workspaceIdentity || undefined;
    const provider = normalizeAgentProviderToZCodeAgent(get().provider);
    const serviceAuthorityId = getServiceAuthorityId(subagentsService);
    const hasCachedAgents =
      get().agents.length > 0 && loadedSubagentsServiceAuthorityId === serviceAuthorityId;
    set({
      agents: hasCachedAgents ? get().agents : [],
      capability: hasCachedAgents ? get().capability : null,
      loading: !hasCachedAgents,
      error: null,
    });
    const requestId = nextAgentLoadRequestId();
    try {
      const result = await loadAgentsOnce(
        workspacePath,
        provider,
        subagentsService,
        workspaceIdentityFromState,
        { bypassCache: true },
      );
      if (!isLatestAgentLoadRequest(requestId)) {
        return;
      }
      loadedSubagentsServiceAuthorityId = serviceAuthorityId;
      set({
        agents: result.agents,
        capability: result.capability,
        loading: false,
        loadedWorkspacePath: workspacePath,
        loadedWorkspaceIdentity: workspaceIdentityFromState ?? null,
        loadedProvider: provider,
      });
    } catch (error) {
      if (!isLatestAgentLoadRequest(requestId)) {
        return;
      }
      logger.error("[subagents] refresh failed", {
        workspacePath,
        provider,
        error: error instanceof Error ? error.message : String(error),
      });
      set({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
        loadedWorkspacePath: workspacePath,
        loadedWorkspaceIdentity: workspaceIdentityFromState ?? null,
        loadedProvider: provider,
      });
    }
  },
  async setEnabled(
    agentId: string,
    enabled: boolean,
    subagentsService: ISubagentsService,
    workspaceIdentity?: string,
  ) {
    const workspacePath = get().workspacePath;
    if (!workspacePath) {
      return;
    }
    const workspaceIdentityFromState =
      workspaceIdentity?.trim() || get().workspaceIdentity || undefined;
    set({ operatingAgentId: agentId });
    try {
      await subagentsService.setEnabled({
        agentId,
        enabled,
      });
      await get().refresh(subagentsService, workspaceIdentityFromState);
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      set({ operatingAgentId: null });
    }
  },
  async createAgent(
    config: SubAgentConfig,
    provider: ZCodeProvider,
    subagentsService: ISubagentsService,
    workspaceIdentity?: string,
  ) {
    const workspacePath = get().workspacePath;
    if (!workspacePath) {
      return null;
    }
    const workspaceIdentityFromState =
      workspaceIdentity?.trim() || get().workspaceIdentity || undefined;
    set({ operatingAgentId: `new:${config.name}` });
    try {
      const result = await subagentsService.createAgent({
        config,
        provider: normalizeAgentProviderToZCodeAgent(provider),
      });
      await get().refresh(subagentsService, workspaceIdentityFromState);
      return result.agent;
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    } finally {
      set({ operatingAgentId: null });
    }
  },
  async updateAgent(
    agentId: string,
    config: SubAgentConfig,
    oldFilePath: string | undefined,
    provider: ZCodeProvider,
    subagentsService: ISubagentsService,
    workspaceIdentity?: string,
  ) {
    const workspacePath = get().workspacePath;
    if (!workspacePath) {
      return null;
    }
    const workspaceIdentityFromState =
      workspaceIdentity?.trim() || get().workspaceIdentity || undefined;
    set({ operatingAgentId: agentId });
    try {
      const result = await subagentsService.updateAgent({
        agentId,
        config,
        oldFilePath,
        provider: normalizeAgentProviderToZCodeAgent(provider),
      });
      await get().refresh(subagentsService, workspaceIdentityFromState);
      return result.agent;
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    } finally {
      set({ operatingAgentId: null });
    }
  },
  async deleteAgent(
    agentId: string,
    filePath: string,
    subagentsService: ISubagentsService,
    workspaceIdentity?: string,
  ) {
    const workspacePath = get().workspacePath;
    if (!workspacePath) {
      return false;
    }
    const workspaceIdentityFromState =
      workspaceIdentity?.trim() || get().workspaceIdentity || undefined;
    set({ operatingAgentId: agentId });
    try {
      await subagentsService.deleteAgent({
        agentId,
        filePath,
      });
      await get().refresh(subagentsService, workspaceIdentityFromState);
      return true;
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      set({ operatingAgentId: null });
    }
  },
}));

type SubagentsStoreE2EBridge = typeof useSubagentsStore;

declare global {
  interface Window {
    __subagentsStoreE2E?: SubagentsStoreE2EBridge;
  }
}

if (shouldExposeE2EStoreBridge()) {
  // E2E 诊断入口必须由 WDIO 显式打开，不能复用 ZCODE_ENV=test，避免产品测试环境暴露可变全局 store。
  window.__subagentsStoreE2E = useSubagentsStore;
}

export async function refreshLoadedSubagentsStoreForWorkspace(params: {
  scope?: "user" | "workspace";
  workspacePath?: string | null;
  workspaceIdentity?: string | null;
  subagentsService: ISubagentsService;
}): Promise<void> {
  const userScope = params.scope === "user";
  const workspacePath = params.workspacePath?.trim();
  if (!userScope && !workspacePath) return;
  const workspaceIdentity = params.workspaceIdentity?.trim() || null;
  const state = useSubagentsStore.getState();
  const contextStore = useSubagentsContextStore.getState();
  const refreshes: Promise<void>[] = [];
  // Bug 根因：User 保存曾按 active remote workspace 刷新，空路径又跳过本机 @ 缓存。
  // 只刷新同 authority 已有的投影；新目标加载中不能借用旧 loaded authority。
  const refreshLegacy = userScope
    ? state.workspacePath === state.loadedWorkspacePath &&
      state.workspaceIdentity === state.loadedWorkspaceIdentity &&
      loadedSubagentsServiceAuthorityId === getServiceAuthorityId(params.subagentsService)
    : state.workspacePath === workspacePath && state.workspaceIdentity === workspaceIdentity;
  if (state.workspacePath && refreshLegacy) {
    refreshes.push(state.refresh(params.subagentsService, state.workspaceIdentity ?? undefined));
  }
  for (const [key, context] of Object.entries(contextStore.contexts)) {
    if (
      !userScope &&
      (context.workspacePath !== workspacePath || context.workspaceIdentity !== workspaceIdentity)
    )
      continue;
    if (
      key !==
      getSubagentsContextKey(
        context.workspacePath,
        context.provider,
        context.workspaceIdentity,
        params.subagentsService,
      )
    )
      continue;
    refreshes.push(
      contextStore.refresh(
        context.workspacePath,
        context.provider,
        params.subagentsService,
        context.workspaceIdentity ?? undefined,
      ),
    );
  }
  await Promise.all(refreshes);
}
