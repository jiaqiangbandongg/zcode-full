import { describe, expect, it, beforeEach, vi } from "vitest";
import type { IServiceAccessor } from "@zcode/services";
import type { RemoteTarget } from "@zcode/shared";
import {
  resolveBaseWorkspaceServices,
  resolveWorkspaceServiceIsRemoteTarget,
  resolveWorkspaceServicesForTarget,
} from "../src/hooks/useWorkspaceServices.js";
import { createAgentSessionsIndexTransport } from "../src/v4/agentSessionsIndexTransport.js";
import { resolveRemoteWorkspaceSessionIdForTarget } from "../src/hooks/useResolvedRemoteWorkspaceSessionId.js";
import {
  useRemoteWorkspaceSessionStore,
  registerBaseWorkspaceServices,
  registerRemoteWorkspaceSession,
  unregisterRemoteWorkspaceSession,
  bindRemoteWorkspacePath,
  unbindRemoteWorkspacePath,
  bindRemoteWorkspaceIdentity,
  unbindRemoteWorkspaceIdentity,
  getRemoteWorkspaceSession,
  getRemoteWorkspaceServicesForPath,
  getRemoteWorkspaceServicesForIdentity,
} from "../src/store/remoteWorkspaceSessionStore.js";
import type { WorkspaceTabState, WindowTabState } from "../src/store/tabStore.js";
import { isWorkspaceTab, SETTINGS_TAB_ID } from "../src/store/tabStore.js";

// ============================================================================
// 测试数据构造
// ============================================================================

function makeMockServices(id: string): IServiceAccessor {
  return { __testId: id } as unknown as IServiceAccessor;
}

function makeMockTarget(): RemoteTarget {
  return {
    kind: "ssh",
    host: "remote-host",
    username: "user",
    port: 22,
  };
}

function makeMockTab(
  workspacePath: string,
  overrides: Partial<WorkspaceTabState> = {},
): WorkspaceTabState {
  return {
    id: "tab-1",
    kind: "workspace",
    workspacePath,
    label: workspacePath,
    ...overrides,
  } as WorkspaceTabState;
}

// ============================================================================
// useRemoteWorkspaceSessionStore 单元测试
// ============================================================================

describe("useRemoteWorkspaceSessionStore", () => {
  beforeEach(() => {
    // 重置 store 为初始状态
    useRemoteWorkspaceSessionStore.setState({
      baseServices: null,
      sessionsById: {},
      sessionIdByWorkspacePath: {},
      sessionIdByWorkspaceIdentity: {},
    });
  });

  describe("registerBaseServices", () => {
    it("注册后 baseServices 可被读取", () => {
      const services = makeMockServices("base");
      registerBaseWorkspaceServices(services);

      const state = useRemoteWorkspaceSessionStore.getState();
      expect(state.baseServices).toBe(services);
    });

    it("重复注册会覆盖 baseServices", () => {
      const first = makeMockServices("base-first");
      const second = makeMockServices("base-second");
      registerBaseWorkspaceServices(first);
      registerBaseWorkspaceServices(second);

      const state = useRemoteWorkspaceSessionStore.getState();
      expect(state.baseServices).toBe(second);
    });
  });

  describe("registerSession / unregisterSession", () => {
    it("注册后 session 可被读取", () => {
      const session = {
        sessionId: "session-1",
        target: makeMockTarget(),
        services: makeMockServices("remote-1"),
      };
      registerRemoteWorkspaceSession(session);

      expect(getRemoteWorkspaceSession("session-1")).toBe(session);
    });

    it("unregisterSession 会删除 session 并清理所有索引", () => {
      const session = {
        sessionId: "session-1",
        target: makeMockTarget(),
        services: makeMockServices("remote-1"),
      };
      registerRemoteWorkspaceSession(session);
      bindRemoteWorkspacePath("/workspace/demo", "session-1");
      bindRemoteWorkspaceIdentity("remote:ssh:host:/workspace/demo", "session-1");

      unregisterRemoteWorkspaceSession("session-1");

      const state = useRemoteWorkspaceSessionStore.getState();
      expect(state.sessionsById["session-1"]).toBeUndefined();
      expect(state.sessionIdByWorkspacePath["/workspace/demo"]).toBeUndefined();
      expect(state.sessionIdByWorkspaceIdentity["remote:ssh:host:/workspace/demo"]).toBeUndefined();
    });

    it("unregisterSession 不影响其他 session 和索引", () => {
      const session1 = {
        sessionId: "session-1",
        target: makeMockTarget(),
        services: makeMockServices("remote-1"),
      };
      const session2 = {
        sessionId: "session-2",
        target: makeMockTarget(),
        services: makeMockServices("remote-2"),
      };
      registerRemoteWorkspaceSession(session1);
      registerRemoteWorkspaceSession(session2);
      bindRemoteWorkspacePath("/workspace/a", "session-1");
      bindRemoteWorkspacePath("/workspace/b", "session-2");

      unregisterRemoteWorkspaceSession("session-1");

      const state = useRemoteWorkspaceSessionStore.getState();
      expect(state.sessionsById["session-1"]).toBeUndefined();
      expect(state.sessionsById["session-2"]).toBe(session2);
      expect(state.sessionIdByWorkspacePath["/workspace/a"]).toBeUndefined();
      expect(state.sessionIdByWorkspacePath["/workspace/b"]).toBe("session-2");
    });

    it("unregisterSession 会终结已注入的远程 transport", () => {
      const dispose = vi.fn();
      registerRemoteWorkspaceSession({
        sessionId: "session-1",
        target: makeMockTarget(),
        services: makeMockServices("remote-1"),
        dispose,
      });

      unregisterRemoteWorkspaceSession("session-1");

      expect(dispose).toHaveBeenCalledTimes(1);
      expect(dispose).toHaveBeenCalledWith(
        expect.objectContaining({ code: "ZCODE_REMOTE_WORKSPACE_DISCONNECTED" }),
      );
    });

    it("同 sessionId 换代时只终结被替换的旧 transport", () => {
      const oldDispose = vi.fn();
      const newDispose = vi.fn();
      const oldSession = {
        sessionId: "session-1",
        target: makeMockTarget(),
        services: makeMockServices("remote-old"),
        dispose: oldDispose,
      };
      const newSession = {
        sessionId: "session-1",
        target: makeMockTarget(),
        services: makeMockServices("remote-new"),
        dispose: newDispose,
      };

      registerRemoteWorkspaceSession(oldSession);
      registerRemoteWorkspaceSession(newSession);

      expect(oldDispose).toHaveBeenCalledTimes(1);
      expect(newDispose).not.toHaveBeenCalled();
      expect(getRemoteWorkspaceSession("session-1")).toBe(newSession);
    });
  });

  describe("bindWorkspacePath / unbindWorkspacePath", () => {
    it("绑定后可通过路径查到 session", () => {
      const session = {
        sessionId: "session-1",
        target: makeMockTarget(),
        services: makeMockServices("remote-1"),
      };
      registerRemoteWorkspaceSession(session);
      bindRemoteWorkspacePath("/workspace/demo", "session-1");

      expect(getRemoteWorkspaceServicesForPath("/workspace/demo")).toBe(session.services);
    });

    it("路径未绑定时返回 null", () => {
      expect(getRemoteWorkspaceServicesForPath("/workspace/unknown")).toBeNull();
    });

    it("unbindWorkspacePath 清理路径索引", () => {
      const session = {
        sessionId: "session-1",
        target: makeMockTarget(),
        services: makeMockServices("remote-1"),
      };
      registerRemoteWorkspaceSession(session);
      bindRemoteWorkspacePath("/workspace/demo", "session-1");

      unbindRemoteWorkspacePath("/workspace/demo");

      const state = useRemoteWorkspaceSessionStore.getState();
      expect(state.sessionIdByWorkspacePath["/workspace/demo"]).toBeUndefined();
    });

    it("同一路径被不同 session 绑定时，后者覆盖前者", () => {
      const session1 = {
        sessionId: "session-1",
        target: makeMockTarget(),
        services: makeMockServices("remote-1"),
      };
      const session2 = {
        sessionId: "session-2",
        target: makeMockTarget(),
        services: makeMockServices("remote-2"),
      };
      registerRemoteWorkspaceSession(session1);
      registerRemoteWorkspaceSession(session2);
      bindRemoteWorkspacePath("/workspace/demo", "session-1");
      bindRemoteWorkspacePath("/workspace/demo", "session-2");

      expect(getRemoteWorkspaceServicesForPath("/workspace/demo")).toBe(session2.services);
    });
  });

  describe("bindWorkspaceIdentity / unbindWorkspaceIdentity", () => {
    it("绑定后可通过 identity 查到 session", () => {
      const session = {
        sessionId: "session-1",
        target: makeMockTarget(),
        services: makeMockServices("remote-1"),
      };
      registerRemoteWorkspaceSession(session);
      bindRemoteWorkspaceIdentity("remote:ssh:host:/workspace/demo", "session-1");

      expect(getRemoteWorkspaceServicesForIdentity("remote:ssh:host:/workspace/demo")).toBe(
        session.services,
      );
    });

    it("identity 未绑定时返回 null", () => {
      expect(getRemoteWorkspaceServicesForIdentity("remote:ssh:host:/unknown")).toBeNull();
    });

    it("unbindWorkspaceIdentity 清理 identity 索引", () => {
      const session = {
        sessionId: "session-1",
        target: makeMockTarget(),
        services: makeMockServices("remote-1"),
      };
      registerRemoteWorkspaceSession(session);
      bindRemoteWorkspaceIdentity("remote:ssh:host:/workspace/demo", "session-1");

      unbindRemoteWorkspaceIdentity("remote:ssh:host:/workspace/demo");

      const state = useRemoteWorkspaceSessionStore.getState();
      expect(state.sessionIdByWorkspaceIdentity["remote:ssh:host:/workspace/demo"]).toBeUndefined();
    });

    it("同路径不同 identity 的 session 不互相覆盖", () => {
      const sessionA = {
        sessionId: "session-A",
        target: makeMockTarget(),
        services: makeMockServices("remote-A"),
      };
      const sessionB = {
        sessionId: "session-B",
        target: makeMockTarget(),
        services: makeMockServices("remote-B"),
      };
      registerRemoteWorkspaceSession(sessionA);
      registerRemoteWorkspaceSession(sessionB);
      bindRemoteWorkspaceIdentity("remote:ssh:host-a:/workspace/demo", "session-A");
      bindRemoteWorkspaceIdentity("remote:ssh:host-b:/workspace/demo", "session-B");

      expect(getRemoteWorkspaceServicesForIdentity("remote:ssh:host-a:/workspace/demo")).toBe(
        sessionA.services,
      );
      expect(getRemoteWorkspaceServicesForIdentity("remote:ssh:host-b:/workspace/demo")).toBe(
        sessionB.services,
      );
    });
  });

  describe("workspacePath 和 workspaceIdentity 索引共存且互不干扰", () => {
    it("同一个 session 同时绑定路径和 identity 时，两者都指向该 session", () => {
      const session = {
        sessionId: "session-1",
        target: makeMockTarget(),
        services: makeMockServices("remote-1"),
      };
      registerRemoteWorkspaceSession(session);
      bindRemoteWorkspacePath("/workspace/demo", "session-1");
      bindRemoteWorkspaceIdentity("remote:ssh:host:/workspace/demo", "session-1");

      expect(getRemoteWorkspaceServicesForPath("/workspace/demo")).toBe(session.services);
      expect(getRemoteWorkspaceServicesForIdentity("remote:ssh:host:/workspace/demo")).toBe(
        session.services,
      );
    });

    it("路径绑定和 identity 绑定的 session 不同，查询互不影响", () => {
      const sessionByPath = {
        sessionId: "session-by-path",
        target: makeMockTarget(),
        services: makeMockServices("remote-by-path"),
      };
      const sessionByIdentity = {
        sessionId: "session-by-identity",
        target: makeMockTarget(),
        services: makeMockServices("remote-by-identity"),
      };
      registerRemoteWorkspaceSession(sessionByPath);
      registerRemoteWorkspaceSession(sessionByIdentity);
      bindRemoteWorkspacePath("/workspace/demo", "session-by-path");
      bindRemoteWorkspaceIdentity("remote:ssh:host:/workspace/demo", "session-by-identity");

      expect(getRemoteWorkspaceServicesForPath("/workspace/demo")).toBe(sessionByPath.services);
      expect(getRemoteWorkspaceServicesForIdentity("remote:ssh:host:/workspace/demo")).toBe(
        sessionByIdentity.services,
      );
    });
  });

  describe("无效的 unbind 不报错", () => {
    it("unbind 不存在的 workspacePath 不报错", () => {
      expect(() => unbindRemoteWorkspacePath("/workspace/nonexistent")).not.toThrow();
    });

    it("unbind 不存在的 workspaceIdentity 不报错", () => {
      expect(() => unbindRemoteWorkspaceIdentity("remote:ssh:host:/workspace/nonexistent")).not.toThrow();
    });
  });

  describe("getRemoteWorkspaceSession 返回不存在的 session 时为 null", () => {
    it("查询未注册的 sessionId 返回 null", () => {
      expect(getRemoteWorkspaceSession("nonexistent-session")).toBeNull();
    });
  });
});

// ============================================================================
// useResolvedRemoteWorkspaceSessionId 单元测试
// 通过直接操作 store + useTabStore 模拟 hook 行为
// ============================================================================

// hook 的 tab 候选收敛后统一调用公开路由函数；这里直接验证同一行为边界。

describe("useResolvedRemoteWorkspaceSessionId 核心逻辑覆盖", () => {
  beforeEach(() => {
    useRemoteWorkspaceSessionStore.setState({
      baseServices: null,
      sessionsById: {},
      sessionIdByWorkspacePath: {},
      sessionIdByWorkspaceIdentity: {},
    });
  });

  /**
   * 优先级：有效 preferredRemoteSessionId > 有效 activeTabRemoteSessionId >
   * workspaceIdentity 精确索引；只有无 identity 的旧数据才使用 workspacePath 索引。
   */
  function resolveRemoteSessionId(
    workspacePath: string | null | undefined,
    preferredRemoteSessionId: string | null | undefined,
    workspaceIdentity: string | null | undefined,
    storeState: ReturnType<typeof useRemoteWorkspaceSessionStore.getState>,
    activeTabRemoteSessionId: string | null,
    activeTabRemoteTarget?: RemoteTarget,
  ): string | null {
    const activeTab = workspacePath
      ? makeMockTab(workspacePath, {
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          ...(activeTabRemoteSessionId ? { remoteSessionId: activeTabRemoteSessionId } : {}),
          ...(activeTabRemoteTarget ? { remoteTarget: activeTabRemoteTarget } : {}),
        })
      : null;
    return resolveRemoteWorkspaceSessionIdForTarget({
      workspacePath,
      preferredRemoteSessionId,
      workspaceIdentity,
      activeTab,
      state: storeState,
    });
  }

  it("workspacePath 为 null 时返回 null", () => {
    const state = useRemoteWorkspaceSessionStore.getState();
    expect(resolveRemoteSessionId(null, null, undefined, state, null)).toBeNull();
  });

  it("active local tab 与 remote tab 同路径时不借用 remote path session", () => {
    const remoteServices = makeMockServices("remote-root");
    const localTab = makeMockTab("/root", { id: "local-root" });
    const state = {
      sessionsById: {
        "session-remote-root": {
          sessionId: "session-remote-root",
          services: remoteServices,
        },
      },
      sessionIdByWorkspaceIdentity: {},
      sessionIdByWorkspacePath: {
        "/root": "session-remote-root",
      },
    };

    expect(
      resolveRemoteWorkspaceSessionIdForTarget({
        workspacePath: "/root",
        activeTab: localTab,
        state,
      }),
    ).toBeNull();
  });

  it("非 active 的旧 remote tab 显式携带 remoteTarget 时保留 path fallback", () => {
    const remoteServices = makeMockServices("remote-legacy");
    const state = {
      sessionsById: {
        "session-legacy": {
          sessionId: "session-legacy",
          services: remoteServices,
        },
      },
      sessionIdByWorkspaceIdentity: {},
      sessionIdByWorkspacePath: {
        "/legacy": "session-legacy",
      },
    };

    expect(
      resolveRemoteWorkspaceSessionIdForTarget({
        workspacePath: "/legacy",
        remoteTarget: makeMockTarget(),
        state,
      }),
    ).toBe("session-legacy");
  });

  it("workspacePath 为 undefined 时返回 null", () => {
    const state = useRemoteWorkspaceSessionStore.getState();
    expect(resolveRemoteSessionId(undefined, undefined, undefined, state, null)).toBeNull();
  });

  it("空 workspacePath 字符串时返回 null", () => {
    const state = useRemoteWorkspaceSessionStore.getState();
    expect(resolveRemoteSessionId("", null, undefined, state, null)).toBeNull();
  });

  it("所有候选都为空时返回 null", () => {
    const state = useRemoteWorkspaceSessionStore.getState();
    expect(resolveRemoteSessionId("/workspace/demo", null, null, state, null)).toBeNull();
  });

  it("preferredRemoteSessionId 有值且 session 存在时优先返回", () => {
    const session = {
      sessionId: "session-preferred",
      target: makeMockTarget(),
      services: makeMockServices("remote-preferred"),
    };
    registerRemoteWorkspaceSession(session);

    const state = useRemoteWorkspaceSessionStore.getState();
    expect(
      resolveRemoteSessionId("/workspace/demo", "session-preferred", null, state, null),
    ).toBe("session-preferred");
  });

  it("preferredRemoteSessionId 有值但 session 不存在时继续检查后续候选", () => {
    const session = {
      sessionId: "session-by-path",
      target: makeMockTarget(),
      services: makeMockServices("remote-by-path"),
    };
    registerRemoteWorkspaceSession(session);
    bindRemoteWorkspacePath("/workspace/demo", "session-by-path");

    const state = useRemoteWorkspaceSessionStore.getState();
    // session-preferred 不存在，但 active tab 明确是旧 remote tab，应该回退到路径索引
    expect(
      resolveRemoteSessionId(
        "/workspace/demo",
        "session-preferred",
        null,
        state,
        null,
        makeMockTarget(),
      ),
    ).toBe("session-by-path");
  });

  it("activeTabRemoteSessionId 有值时其次返回", () => {
    const session = {
      sessionId: "session-tab",
      target: makeMockTarget(),
      services: makeMockServices("remote-tab"),
    };
    registerRemoteWorkspaceSession(session);

    const state = useRemoteWorkspaceSessionStore.getState();
    expect(resolveRemoteSessionId("/workspace/demo", null, null, state, "session-tab")).toBe(
      "session-tab",
    );
  });

  it("workspaceIdentity 索引命中时在 identity 索引之后返回", () => {
    const session = {
      sessionId: "session-identity",
      target: makeMockTarget(),
      services: makeMockServices("remote-identity"),
    };
    registerRemoteWorkspaceSession(session);
    bindRemoteWorkspaceIdentity("remote:ssh:host:/workspace/demo", "session-identity");

    const state = useRemoteWorkspaceSessionStore.getState();
    expect(
      resolveRemoteSessionId("/workspace/demo", null, "remote:ssh:host:/workspace/demo", state, null),
    ).toBe("session-identity");
  });

  it("workspacePath 索引命中时作为兜底返回", () => {
    const session = {
      sessionId: "session-path",
      target: makeMockTarget(),
      services: makeMockServices("remote-path"),
    };
    registerRemoteWorkspaceSession(session);
    bindRemoteWorkspacePath("/workspace/demo", "session-path");

    const state = useRemoteWorkspaceSessionStore.getState();
    expect(
      resolveRemoteSessionId("/workspace/demo", null, null, state, null, makeMockTarget()),
    ).toBe("session-path");
  });

  it("按优先级收敛：preferred > activeTab > workspaceIdentity > workspacePath", () => {
    const sessionPreferred = {
      sessionId: "session-preferred",
      target: makeMockTarget(),
      services: makeMockServices("remote-preferred"),
    };
    const sessionTab = {
      sessionId: "session-tab",
      target: makeMockTarget(),
      services: makeMockServices("remote-tab"),
    };
    const sessionIdentity = {
      sessionId: "session-identity",
      target: makeMockTarget(),
      services: makeMockServices("remote-identity"),
    };
    const sessionPath = {
      sessionId: "session-path",
      target: makeMockTarget(),
      services: makeMockServices("remote-path"),
    };
    registerRemoteWorkspaceSession(sessionPreferred);
    registerRemoteWorkspaceSession(sessionTab);
    registerRemoteWorkspaceSession(sessionIdentity);
    registerRemoteWorkspaceSession(sessionPath);
    bindRemoteWorkspacePath("/workspace/demo", "session-path");
    bindRemoteWorkspaceIdentity("remote:ssh:host:/workspace/demo", "session-identity");

    const state = useRemoteWorkspaceSessionStore.getState();

    // 全部存在时，优先用 preferred
    expect(
      resolveRemoteSessionId(
        "/workspace/demo",
        "session-preferred",
        "remote:ssh:host:/workspace/demo",
        state,
        "session-tab",
      ),
    ).toBe("session-preferred");

    // preferred 不存在时，用 activeTab
    expect(
      resolveRemoteSessionId(
        "/workspace/demo",
        "session-nonexistent",
        "remote:ssh:host:/workspace/demo",
        state,
        "session-tab",
      ),
    ).toBe("session-tab");

    // activeTab 不存在时，用 workspaceIdentity
    expect(
      resolveRemoteSessionId(
        "/workspace/demo",
        "session-nonexistent",
        "remote:ssh:host:/workspace/demo",
        state,
        null,
      ),
    ).toBe("session-identity");

    // 所有高优先级都不存在时，用 workspacePath
    expect(
      resolveRemoteSessionId(
        "/workspace/demo",
        "session-nonexistent",
        null,
        state,
        null,
        makeMockTarget(),
      ),
    ).toBe("session-path");
  });

  it("workspaceIdentity 为空字符串时不查 identity 索引", () => {
    const session = {
      sessionId: "session-identity",
      target: makeMockTarget(),
      services: makeMockServices("remote-identity"),
    };
    registerRemoteWorkspaceSession(session);
    bindRemoteWorkspaceIdentity("remote:ssh:host:/workspace/demo", "session-identity");

    const state = useRemoteWorkspaceSessionStore.getState();
    // workspaceIdentity 为空字符串，应该跳过 identity 索引
    expect(resolveRemoteSessionId("/workspace/demo", null, "", state, null)).toBeNull();
  });

  it("workspaceIdentity 有值但索引中没有对应 session 时保持未绑定，不借用路径索引", () => {
    const session = {
      sessionId: "session-path",
      target: makeMockTarget(),
      services: makeMockServices("remote-path"),
    };
    registerRemoteWorkspaceSession(session);
    bindRemoteWorkspacePath("/workspace/demo", "session-path");

    const state = useRemoteWorkspaceSessionStore.getState();
    expect(
      resolveRemoteSessionId("/workspace/demo", null, "remote:ssh:unknown:/workspace/demo", state, null),
    ).toBeNull();
  });
});

// ============================================================================
// useWorkspaceServices 路由逻辑测试
// 通过模拟组合测试覆盖核心路由行为
// ============================================================================

describe("useWorkspaceServices 核心路由逻辑覆盖", () => {
  beforeEach(() => {
    useRemoteWorkspaceSessionStore.setState({
      baseServices: null,
      sessionsById: {},
      sessionIdByWorkspacePath: {},
      sessionIdByWorkspaceIdentity: {},
    });
  });

  function resolveWorkspaceServices(
    currentContextServices: IServiceAccessor,
    resolvedRemoteSessionId: string | null,
    baseServices: IServiceAccessor | null,
    sessionsById: Record<string, { sessionId: string; services: IServiceAccessor }>,
    isRemoteTarget = false,
  ): IServiceAccessor {
    return resolveWorkspaceServicesForTarget({
      currentContextServices,
      resolvedRemoteSessionId,
      baseServices,
      sessionsById,
      isRemoteTarget,
    });
  }

  // --------------------------------------------------------------------------
  // 核心路由场景
  // --------------------------------------------------------------------------

  describe("远程目标判定", () => {
    it("path-only 调用命中唯一远程 tab 时仍判定为远程目标", () => {
      const workspacePath =
        "/mnt/vdb/home/user/project_ebox/multi-omos-platform/core/framework/dds-wrapper";
      const workspaceIdentity =
        "remote:ssh:10.0.0.102:22:user:/mnt/vdb/home/user/project_ebox/multi-omos-platform/core/framework/dds-wrapper";

      expect(
        resolveWorkspaceServiceIsRemoteTarget({
          workspacePath,
          workspaceIdentity: null,
          preferredRemoteSessionId: null,
          activeWorkspacePath: workspacePath,
          activeWorkspaceIdentity: null,
          activeTab: {
            workspacePath,
            workspaceIdentity,
            remoteTarget: makeMockTarget(),
          },
          workspaceTabs: [
            {
              workspacePath,
              workspaceIdentity,
              remoteTarget: makeMockTarget(),
            },
          ],
        }),
      ).toBe(true);
    });
  });

  describe("远程控制未开启时的路由（核心隔离场景）", () => {
    it("resolvedRemoteSessionId = null 且 baseServices 存在时，返回 baseServices", () => {
      const context = makeMockServices("context");
      const base = makeMockServices("base");
      const state = useRemoteWorkspaceSessionStore.getState();

      const result = resolveWorkspaceServices(context, null, base, state.sessionsById);
      expect(result).toBe(base);
    });

    it("resolvedRemoteSessionId = null 且 baseServices 为 null 时，返回 currentContextServices", () => {
      const context = makeMockServices("context");
      const state = useRemoteWorkspaceSessionStore.getState();

      const result = resolveWorkspaceServices(context, null, null, state.sessionsById);
      expect(result).toBe(context);
    });

    it("远程 workspace session 丢失时不回退到 baseServices", async () => {
      const context = makeMockServices("context");
      const base = makeMockServices("base");
      const state = useRemoteWorkspaceSessionStore.getState();

      const result = resolveWorkspaceServices(
        context,
        null,
        base,
        state.sessionsById,
        true,
      );

      expect(result).not.toBe(base);
      expect(result).not.toBe(context);
      await expect(result.legacyTaskService.resumeTask({
        taskId: "task-1",
        workspacePath: "/root",
        workspaceIdentity: "remote:ssh:198.44.179.20:2222:root:/root",
      })).rejects.toThrow("ZCODE_REMOTE_WORKSPACE_DISCONNECTED");
    });

    it("resolvedRemoteSessionId 有值时，忽略 baseServices，返回远端 services", () => {
      const context = makeMockServices("context");
      const base = makeMockServices("base");
      const remote = makeMockServices("remote");
      const session = {
        sessionId: "session-1",
        target: makeMockTarget(),
        services: remote,
      };
      registerRemoteWorkspaceSession(session);

      const state = useRemoteWorkspaceSessionStore.getState();
      const result = resolveWorkspaceServices(context, "session-1", base, state.sessionsById);
      expect(result).toBe(remote);
    });

    it("远程目标的 resolvedRemoteSessionId 过期时不回退到 contextServices", async () => {
      const context = makeMockServices("context");
      const base = makeMockServices("base");

      const state = useRemoteWorkspaceSessionStore.getState();
      const result = resolveWorkspaceServices(
        context,
        "session-nonexistent",
        base,
        state.sessionsById,
        true,
      );

      expect(result).not.toBe(base);
      expect(result).not.toBe(context);
      await expect(result.legacyTaskService.resumeTask({
        taskId: "task-1",
        workspacePath: "/root",
        workspaceIdentity: "remote:ssh:198.44.179.20:2222:root:/root",
      })).rejects.toThrow("ZCODE_REMOTE_WORKSPACE_DISCONNECTED");
    });

    it("远程 workspace session 丢失时事件订阅返回 no-op disposable", () => {
      const context = makeMockServices("context");
      const base = makeMockServices("base");
      const state = useRemoteWorkspaceSessionStore.getState();

      const result = resolveWorkspaceServices(
        context,
        null,
        base,
        state.sessionsById,
        true,
      );

      const disposable = result.legacyTaskService.onDynamicWorkspaceEvent({
        workspacePath: "/root",
        workspaceIdentity: "remote:ssh:198.44.179.20:2222:root:/root",
      })(() => undefined);

      expect(() => disposable.dispose()).not.toThrow();
    });

    it("远程 workspace session 丢失时属性型事件返回 no-op disposable", () => {
      const context = makeMockServices("context");
      const base = makeMockServices("base");
      const state = useRemoteWorkspaceSessionStore.getState();

      const result = resolveWorkspaceServices(
        context,
        null,
        base,
        state.sessionsById,
        true,
      );

      const disposable = result.broadcastService.onMessage(() => undefined);

      expect(() => disposable.dispose()).not.toThrow();
    });

    it("远程 workspace session 丢失时 runtime restart 订阅可安全释放", () => {
      const context = makeMockServices("context");
      const base = makeMockServices("base");
      const state = useRemoteWorkspaceSessionStore.getState();
      const result = resolveWorkspaceServices(context, null, base, state.sessionsById, true);
      const transport = createAgentSessionsIndexTransport(result.zcodeAgentService, {
        workspacePath: "/root",
        workspaceIdentity: "remote:ssh:198.44.179.20:2222:root:/root",
      });

      const dispose = transport.onRuntimeRestart(() => undefined);

      expect(() => dispose()).not.toThrow();
    });

    it("本地目标的 resolvedRemoteSessionId 过期时仍回退到 context", () => {
      const context = makeMockServices("context");

      const state = useRemoteWorkspaceSessionStore.getState();
      const result = resolveWorkspaceServices(context, "session-nonexistent", null, state.sessionsById);
      expect(result).toBe(context);
    });
  });

  describe("完整路由场景模拟", () => {
    function setupFullScenario() {
      const context = makeMockServices("context");
      const base = makeMockServices("base");
      const remote1 = makeMockServices("remote-1");
      const remote2 = makeMockServices("remote-2");

      registerBaseWorkspaceServices(base);
      registerRemoteWorkspaceSession({
        sessionId: "session-1",
        target: makeMockTarget(),
        services: remote1,
      });
      registerRemoteWorkspaceSession({
        sessionId: "session-2",
        target: makeMockTarget(),
        services: remote2,
      });
      bindRemoteWorkspacePath("/workspace/a", "session-1");
      bindRemoteWorkspacePath("/workspace/b", "session-2");

      return { context, base, remote1, remote2 };
    }

    it("本地 workspace 走 baseServices，远端 workspace 走各自的远端 services", () => {
      const { context, base, remote1, remote2 } = setupFullScenario();
      const state = useRemoteWorkspaceSessionStore.getState();

      // 无 session 的 workspace 走 base
      expect(resolveWorkspaceServices(context, null, base, state.sessionsById)).toBe(base);

      // session-1 走 remote1
      expect(resolveWorkspaceServices(context, "session-1", base, state.sessionsById)).toBe(remote1);

      // session-2 走 remote2
      expect(resolveWorkspaceServices(context, "session-2", base, state.sessionsById)).toBe(remote2);
    });

    it("同一 workspacePath 的不同远端 session 路由到各自 services", () => {
      const { context, base, remote2 } = setupFullScenario();
      const state = useRemoteWorkspaceSessionStore.getState();

      // 同一路径绑定不同 session
      useRemoteWorkspaceSessionStore.getState().bindWorkspacePath("/workspace/shared", "session-1");
      useRemoteWorkspaceSessionStore.getState().bindWorkspacePath("/workspace/shared", "session-2");

      // 最后绑定的 session-2 生效
      expect(
        resolveWorkspaceServices(context, "session-2", base, state.sessionsById),
      ).toBe(remote2);
    });
  });

  describe("服务实例隔离验证", () => {
    it("baseServices 和各 remote services 是不同的实例", () => {
      const base = makeMockServices("base");
      const remote = makeMockServices("remote");
      registerBaseWorkspaceServices(base);
      registerRemoteWorkspaceSession({
        sessionId: "session-1",
        target: makeMockTarget(),
        services: remote,
      });

      const state = useRemoteWorkspaceSessionStore.getState();
      expect(state.baseServices).not.toBe(state.sessionsById["session-1"]?.services);
      expect(state.baseServices).toBe(base);
      expect(state.sessionsById["session-1"]?.services).toBe(remote);
    });

    it("多个 remote session 的 services 互不相同", () => {
      const remoteA = makeMockServices("remote-A");
      const remoteB = makeMockServices("remote-B");
      registerRemoteWorkspaceSession({
        sessionId: "session-A",
        target: makeMockTarget(),
        services: remoteA,
      });
      registerRemoteWorkspaceSession({
        sessionId: "session-B",
        target: makeMockTarget(),
        services: remoteB,
      });

      const state = useRemoteWorkspaceSessionStore.getState();
      expect(state.sessionsById["session-A"]?.services).not.toBe(
        state.sessionsById["session-B"]?.services,
      );
    });
  });

  describe("workspaceIdentity 路由隔离", () => {
    it("workspaceIdentity 不同 → 路由到不同 services", () => {
      const base = makeMockServices("base");
      const remoteA = makeMockServices("remote-A");
      const remoteB = makeMockServices("remote-B");
      registerBaseWorkspaceServices(base);
      registerRemoteWorkspaceSession({
        sessionId: "session-A",
        target: makeMockTarget(),
        services: remoteA,
      });
      registerRemoteWorkspaceSession({
        sessionId: "session-B",
        target: makeMockTarget(),
        services: remoteB,
      });
      bindRemoteWorkspaceIdentity("remote:ssh:host-a:/workspace/demo", "session-A");
      bindRemoteWorkspaceIdentity("remote:ssh:host-b:/workspace/demo", "session-B");

      const state = useRemoteWorkspaceSessionStore.getState();
      expect(
        resolveWorkspaceServices(
          makeMockServices("context"),
          "session-A",
          base,
          state.sessionsById,
        ),
      ).toBe(remoteA);
      expect(
        resolveWorkspaceServices(
          makeMockServices("context"),
          "session-B",
          base,
          state.sessionsById,
        ),
      ).toBe(remoteB);
    });

    it("workspaceIdentity 路由与 workspacePath 路由独立", () => {
      const base = makeMockServices("base");
      const remotePath = makeMockServices("remote-path");
      const remoteIdentity = makeMockServices("remote-identity");
      registerBaseWorkspaceServices(base);
      registerRemoteWorkspaceSession({
        sessionId: "session-path",
        target: makeMockTarget(),
        services: remotePath,
      });
      registerRemoteWorkspaceSession({
        sessionId: "session-identity",
        target: makeMockTarget(),
        services: remoteIdentity,
      });
      bindRemoteWorkspacePath("/workspace/demo", "session-path");
      bindRemoteWorkspaceIdentity("remote:ssh:host:/workspace/demo", "session-identity");

      const state = useRemoteWorkspaceSessionStore.getState();
      // 通过 identity session 路由
      expect(
        resolveWorkspaceServices(
          makeMockServices("context"),
          "session-identity",
          base,
          state.sessionsById,
        ),
      ).toBe(remoteIdentity);
    });
  });
});

// ============================================================================
// resolveBaseWorkspaceServices 测试
// ============================================================================

describe("resolveBaseWorkspaceServices", () => {
  it("有 registeredBaseServices 时返回它，忽略 contextServices", () => {
    const context = makeMockServices("context");
    const base = makeMockServices("base");
    expect(resolveBaseWorkspaceServices(context, base)).toBe(base);
  });

  it("没有 registeredBaseServices 时返回 contextServices", () => {
    const context = makeMockServices("context");
    expect(resolveBaseWorkspaceServices(context, null)).toBe(context);
  });

  it("registeredBaseServices 为 null 时返回 contextServices", () => {
    const context = makeMockServices("context");
    expect(resolveBaseWorkspaceServices(context, null)).toBe(context);
  });
});

// ============================================================================
// isWorkspaceTab 类型守卫测试
// ============================================================================

describe("isWorkspaceTab", () => {
  it("workspace tab 返回 true", () => {
    const tab = makeMockTab("/workspace/demo");
    expect(isWorkspaceTab(tab)).toBe(true);
  });

  it("settings tab 返回 false", () => {
    const tab: WindowTabState = {
      id: SETTINGS_TAB_ID,
      kind: "settings",
      label: "settings",
    };
    expect(isWorkspaceTab(tab)).toBe(false);
  });

  it("带 remoteSessionId 的 workspace tab 仍返回 true", () => {
    const tab = makeMockTab("/workspace/demo", {
      remoteSessionId: "session-1",
      workspaceIdentity: "remote:ssh:host:/workspace/demo",
    });
    expect(isWorkspaceTab(tab)).toBe(true);
  });
});
