// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useWebRemoteControlWorkspaceSync } from "@/root/rootPlatformWorkspaceSync.js";
import type { WindowTabState } from "@/store/tabStore.js";

afterEach(cleanup);
it("本地与远端并存时发送完整快照，远控未运行也不丢失本地目标，关闭tab发送删除", () => {
  const syncWebRemoteControlWorkspaces = vi.fn();
  const platform = { syncWebRemoteControlWorkspaces };
  const tabs: WindowTabState[] = [
    { id: "local", kind: "workspace", label: "Local", workspacePath: "/local" },
    {
      id: "remote",
      kind: "workspace",
      label: "Remote",
      workspacePath: "/remote",
      workspaceIdentity: "ssh://host/remote",
      remoteSessionId: "remote-1",
    },
  ];
  const { rerender } = renderHook(
    ({ ready, currentTabs }) =>
      useWebRemoteControlWorkspaceSync({
        platform,
        tabs: currentTabs,
        isDesktop: true,
        featureEnabled: true,
        hasCompletedFullTabRestore: ready,
      }),
    { initialProps: { ready: false, currentTabs: tabs } },
  );
  expect(syncWebRemoteControlWorkspaces).not.toHaveBeenCalled();
  rerender({ ready: true, currentTabs: tabs });
  expect(syncWebRemoteControlWorkspaces).toHaveBeenLastCalledWith([
    { workspacePath: "/local", label: "Local", kind: "local" },
    {
      workspacePath: "/remote",
      label: "Remote",
      kind: "remote",
      connectionState: "connected",
      workspaceIdentity: "ssh://host/remote",
      remoteSessionId: "remote-1",
    },
  ]);
  expect(syncWebRemoteControlWorkspaces).toHaveBeenCalledOnce();
  rerender({ ready: true, currentTabs: [] });
  expect(syncWebRemoteControlWorkspaces).toHaveBeenLastCalledWith([]);
});
