// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import type {
  ZCodePluginReferenceCatalogEntry,
  ZCodePluginsReferenceCatalogResult,
} from "@zcode/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getPluginReferenceCatalog =
  vi.fn<(params: unknown) => Promise<ZCodePluginsReferenceCatalogResult>>();
let runtimeRestartListener: ((event: { workspaceKey: string }) => void) | undefined;
const runtimeRestartSubscription = { dispose: vi.fn() };
const onAgentRuntimeRestarted = vi.fn((listener: (event: { workspaceKey: string }) => void) => {
  runtimeRestartListener = listener;
  return runtimeRestartSubscription;
});
const resolution = {
  services: {
    pluginManagementService: {
      getPluginReferenceCatalog,
    },
    zcodeAgentService: {
      onAgentRuntimeRestarted,
    },
  },
  remoteSessionId: null as string | null,
  isRemoteTarget: false,
  connectionKind: "local-ready" as const,
  rpcReady: true,
};

const useWorkspaceServicesResolution = vi.fn(() => resolution);

vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useWorkspaceServicesResolution,
}));

vi.mock("@/logger.js", () => ({
  logger: {
    warn: vi.fn(),
  },
}));

function plugin(pluginId: string): ZCodePluginReferenceCatalogEntry {
  const [name = pluginId, marketplace = "market"] = pluginId.split("@");
  return {
    pluginId,
    name,
    marketplace,
    enabled: true,
    conflictingPluginIds: [],
    skillQualifiedNames: [`${name}:search`],
    mcpServerNames: [],
    subagentNames: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("usePluginReferenceCatalog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPluginReferenceCatalog.mockReset();
    runtimeRestartListener = undefined;
    resolution.remoteSessionId = null;
    resolution.rpcReady = true;
  });

  it("deduplicates only in-flight Session requests and refetches after completion", async () => {
    const firstRequest = deferred<ZCodePluginsReferenceCatalogResult>();
    getPluginReferenceCatalog.mockReturnValueOnce(firstRequest.promise).mockResolvedValueOnce({
      authority: "session",
      plugins: [plugin("fresh@market")],
    });
    const { clearPluginReferenceCatalogCacheForTest, usePluginReferenceCatalog } =
      await import("@/hooks/usePluginReferenceCatalog.js");
    clearPluginReferenceCatalogCacheForTest();

    const renderCatalog = () =>
      renderHook(() =>
        usePluginReferenceCatalog("/remote", "ssh://host/remote", "session-a", true, {
          dedupeSessionRequest: true,
          preferredRemoteSessionId: "remote-runtime-explicit",
          suppressErrorLog: true,
        }),
      );
    const first = renderCatalog();
    const concurrent = renderCatalog();
    await waitFor(() => expect(getPluginReferenceCatalog).toHaveBeenCalledTimes(1));
    await act(async () => {
      firstRequest.resolve({
        authority: "session",
        plugins: [plugin("in-flight@market")],
      });
      await firstRequest.promise;
    });
    await waitFor(() => expect(first.result.current.entries).toHaveLength(1));
    await waitFor(() => expect(concurrent.result.current.entries).toHaveLength(1));
    first.unmount();
    concurrent.unmount();

    const second = renderCatalog();
    await waitFor(() => expect(second.result.current.entries[0]?.pluginId).toBe("fresh@market"));

    expect(getPluginReferenceCatalog).toHaveBeenCalledTimes(2);
    expect(useWorkspaceServicesResolution).toHaveBeenLastCalledWith(
      "/remote",
      "remote-runtime-explicit",
      "ssh://host/remote",
    );
    second.unmount();
  });

  it("does not reuse a cached Session catalog across remote attachments", async () => {
    getPluginReferenceCatalog.mockResolvedValue({
      authority: "session",
      plugins: [plugin("remote@market")],
    });
    const { clearPluginReferenceCatalogCacheForTest, usePluginReferenceCatalog } =
      await import("@/hooks/usePluginReferenceCatalog.js");
    clearPluginReferenceCatalogCacheForTest();

    const hook = renderHook(
      (props: { remoteSessionId: string }) =>
        usePluginReferenceCatalog("/remote", "ssh://host/remote", "session-a", true, {
          dedupeSessionRequest: true,
          preferredRemoteSessionId: props.remoteSessionId,
        }),
      { initialProps: { remoteSessionId: "remote-runtime-a" } },
    );
    await waitFor(() => expect(hook.result.current.entries).toHaveLength(1));

    hook.rerender({ remoteSessionId: "remote-runtime-b" });
    await waitFor(() => expect(getPluginReferenceCatalog).toHaveBeenCalledTimes(2));
    expect(getPluginReferenceCatalog).toHaveBeenLastCalledWith({
      workspacePath: "/remote",
      workspaceIdentity: "ssh://host/remote",
      remoteSessionId: "remote-runtime-b",
      sessionId: "session-a",
    });
    hook.unmount();
  });

  it("refetches the same Session authority after its Agent runtime restarts", async () => {
    getPluginReferenceCatalog
      .mockResolvedValueOnce({
        authority: "session",
        plugins: [plugin("runtime-a@market")],
      })
      .mockResolvedValueOnce({
        authority: "session",
        plugins: [plugin("runtime-b@market")],
      });
    const { clearPluginReferenceCatalogCacheForTest, usePluginReferenceCatalog } =
      await import("@/hooks/usePluginReferenceCatalog.js");
    clearPluginReferenceCatalogCacheForTest();

    const hook = renderHook(() =>
      usePluginReferenceCatalog("/remote", "ssh://host/remote", "session-a", true, {
        dedupeSessionRequest: true,
        preferredRemoteSessionId: "remote-runtime-stable",
      }),
    );
    await waitFor(() => expect(hook.result.current.entries[0]?.pluginId).toBe("runtime-a@market"));

    act(() => {
      runtimeRestartListener?.({ workspaceKey: "ssh://host/remote" });
    });

    await waitFor(() => expect(getPluginReferenceCatalog).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(hook.result.current.entries[0]?.pluginId).toBe("runtime-b@market"));
    expect(getPluginReferenceCatalog).toHaveBeenLastCalledWith({
      workspacePath: "/remote",
      workspaceIdentity: "ssh://host/remote",
      remoteSessionId: "remote-runtime-stable",
      sessionId: "session-a",
    });
    hook.unmount();
    expect(runtimeRestartSubscription.dispose).toHaveBeenCalled();
  });

  it("drops the previous runtime result when it arrives after the restarted runtime", async () => {
    const runtimeA = deferred<ZCodePluginsReferenceCatalogResult>();
    const runtimeB = deferred<ZCodePluginsReferenceCatalogResult>();
    getPluginReferenceCatalog
      .mockReturnValueOnce(runtimeA.promise)
      .mockReturnValueOnce(runtimeB.promise);
    const { usePluginReferenceCatalog } = await import("@/hooks/usePluginReferenceCatalog.js");

    const hook = renderHook(() =>
      usePluginReferenceCatalog("/remote", "ssh://host/remote", "session-a", true, {
        dedupeSessionRequest: true,
      }),
    );
    await waitFor(() => expect(getPluginReferenceCatalog).toHaveBeenCalledTimes(1));

    act(() => {
      runtimeRestartListener?.({ workspaceKey: "ssh://host/remote" });
    });
    await waitFor(() => expect(getPluginReferenceCatalog).toHaveBeenCalledTimes(2));

    await act(async () => {
      runtimeB.resolve({
        authority: "session",
        plugins: [plugin("runtime-b@market")],
      });
      await runtimeB.promise;
    });
    await waitFor(() => expect(hook.result.current.entries[0]?.pluginId).toBe("runtime-b@market"));

    await act(async () => {
      runtimeA.resolve({
        authority: "session",
        plugins: [plugin("runtime-a-stale@market")],
      });
      await runtimeA.promise;
    });
    expect(hook.result.current.entries[0]?.pluginId).toBe("runtime-b@market");
    hook.unmount();
  });

  it("hides the previous authority immediately when workspace/session request identity changes", async () => {
    const first = deferred<ZCodePluginsReferenceCatalogResult>();
    const second = deferred<ZCodePluginsReferenceCatalogResult>();
    getPluginReferenceCatalog
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { usePluginReferenceCatalog } = await import("@/hooks/usePluginReferenceCatalog.js");

    const hook = renderHook(
      (props: { sessionId: string }) =>
        usePluginReferenceCatalog("/workspace", "ssh://host/workspace", props.sessionId, true),
      { initialProps: { sessionId: "session-a" } },
    );
    await waitFor(() => expect(getPluginReferenceCatalog).toHaveBeenCalledTimes(1));
    await act(async () => {
      first.resolve({
        authority: "session",
        plugins: [plugin("alpha@market")],
      });
      await first.promise;
    });
    await waitFor(() => expect(hook.result.current.entries[0]?.pluginId).toBe("alpha@market"));

    hook.rerender({ sessionId: "session-b" });
    // 新 effect 发请求前的首帧也必须 fail closed，不能闪现 session-a catalog。
    expect(hook.result.current.entries).toEqual([]);
    expect(hook.result.current.authority).toBeNull();
    await waitFor(() => expect(getPluginReferenceCatalog).toHaveBeenCalledTimes(2));

    await act(async () => {
      second.resolve({
        authority: "session",
        plugins: [plugin("beta@market")],
      });
      await second.promise;
    });
    await waitFor(() => expect(hook.result.current.entries[0]?.pluginId).toBe("beta@market"));
    hook.unmount();
  });

  it("drops late results and clears cached entries while a remote attachment is unavailable", async () => {
    const first = deferred<ZCodePluginsReferenceCatalogResult>();
    const second = deferred<ZCodePluginsReferenceCatalogResult>();
    getPluginReferenceCatalog
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { usePluginReferenceCatalog } = await import("@/hooks/usePluginReferenceCatalog.js");

    const hook = renderHook(
      (props: { revision: number }) => {
        void props.revision;
        return usePluginReferenceCatalog("/remote", "ssh://host/remote", "session-a", true);
      },
      { initialProps: { revision: 0 } },
    );
    await waitFor(() => expect(getPluginReferenceCatalog).toHaveBeenCalledTimes(1));

    resolution.rpcReady = false;
    hook.rerender({ revision: 1 });
    expect(hook.result.current).toMatchObject({
      entries: [],
      authority: null,
      loading: false,
      error: null,
    });

    await act(async () => {
      first.resolve({
        authority: "session",
        plugins: [plugin("stale@market")],
      });
      await first.promise;
    });
    expect(hook.result.current.entries).toEqual([]);

    resolution.rpcReady = true;
    resolution.remoteSessionId = "remote-runtime-2";
    hook.rerender({ revision: 2 });
    await waitFor(() => expect(getPluginReferenceCatalog).toHaveBeenCalledTimes(2));
    expect(getPluginReferenceCatalog).toHaveBeenLastCalledWith({
      workspacePath: "/remote",
      workspaceIdentity: "ssh://host/remote",
      remoteSessionId: "remote-runtime-2",
      sessionId: "session-a",
    });
    await act(async () => {
      second.resolve({
        authority: "session",
        plugins: [plugin("fresh@market")],
      });
      await second.promise;
    });
    await waitFor(() => expect(hook.result.current.entries[0]?.pluginId).toBe("fresh@market"));
    hook.unmount();
  });
});
