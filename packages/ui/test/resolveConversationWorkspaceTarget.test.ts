import { describe, expect, it, vi } from "vitest";
import { resolveConversationWorkspaceTarget } from "@/conversation-workspace-target/index.js";
import { createTabStore } from "@/store/tabStore.js";

describe("RPN-11 conversation target", () => {
  it.each(["project", "conversation"] as const)(
    "rejects a remote %s even when a local conversation has the same path",
    async (workspacePurpose) => {
      const store = createTabStore();
      const path = "/home/dev/.zcode/workspace/default";
      const identity = `remote:server:source-a:${path}`;
      store.getState().addTab(path, { workspacePurpose: "conversation" });
      store.getState().addTab(path, { workspacePurpose, workspaceIdentity: identity });
      const resolveLocalConversationWorkspacePath = vi.fn(async () => path);
      await expect(
        resolveConversationWorkspaceTarget({
          getTabs: () => store.getState().tabs,
          activeWorkspacePath: path,
          activeWorkspaceIdentity: identity,
          resolveLocalConversationWorkspacePath,
        }),
      ).rejects.toThrow("Remote projects require a project workspace");
      expect(resolveLocalConversationWorkspacePath).not.toHaveBeenCalled();
    },
  );
  it("resolves local project detachment locally", async () => {
    const store = createTabStore();
    store.getState().addTab("/local/project");
    const resolveLocalConversationWorkspacePath = vi.fn(async () => "/local/conversation");
    await expect(
      resolveConversationWorkspaceTarget({
        getTabs: () => store.getState().tabs,
        activeWorkspacePath: "/local/project",
        activeWorkspaceIdentity: null,
        resolveLocalConversationWorkspacePath,
      }),
    ).resolves.toEqual({ workspacePath: "/local/conversation" });
    expect(resolveLocalConversationWorkspacePath).toHaveBeenCalledOnce();
  });
  it.each(["remote-first", "local-first"] as const)(
    "resolves the active local project when a remote tab shares its path (%s)",
    async (order) => {
      const store = createTabStore();
      const path = "/local/project";
      const identity = `remote:server:source-a:${path}`;
      const localId = store.getState().addTab(path);
      store.getState().addTab(path, { workspaceIdentity: identity });
      if (order === "local-first") store.getState().reorderWorkspaceTabs(1, 0);
      store.getState().activateTab(localId);
      const resolveLocalConversationWorkspacePath = vi.fn(async () => "/local/conversation");

      await expect(
        resolveConversationWorkspaceTarget({
          getTabs: () => store.getState().tabs,
          activeWorkspacePath: store.getState().activeWorkspacePath,
          activeWorkspaceIdentity: store.getState().activeWorkspaceIdentity,
          resolveLocalConversationWorkspacePath,
        }),
      ).resolves.toEqual({ workspacePath: "/local/conversation" });
      expect(resolveLocalConversationWorkspacePath).toHaveBeenCalledOnce();
    },
  );
  it("reuses the active local conversation when a remote tab with the same path is first", async () => {
    const store = createTabStore();
    const path = "/local/conversation";
    const localId = store.getState().addTab(path, { workspacePurpose: "conversation" });
    store.getState().addTab(path, { workspaceIdentity: `remote:server:source-a:${path}` });
    store.getState().activateTab(localId);
    const resolveLocalConversationWorkspacePath = vi.fn(async () => "/unused");

    await expect(
      resolveConversationWorkspaceTarget({
        getTabs: () => store.getState().tabs,
        activeWorkspacePath: store.getState().activeWorkspacePath,
        activeWorkspaceIdentity: store.getState().activeWorkspaceIdentity,
        resolveLocalConversationWorkspacePath,
      }),
    ).resolves.toEqual({ workspacePath: path });
    expect(resolveLocalConversationWorkspacePath).not.toHaveBeenCalled();
  });
  it("reuses the local conversation without creating another workspace", async () => {
    const store = createTabStore();
    store.getState().addTab("/local/conversation", { workspacePurpose: "conversation" });
    const resolveLocalConversationWorkspacePath = vi.fn(async () => "/unused");
    await expect(
      resolveConversationWorkspaceTarget({
        getTabs: () => store.getState().tabs,
        activeWorkspacePath: "/local/conversation",
        activeWorkspaceIdentity: null,
        resolveLocalConversationWorkspacePath,
      }),
    ).resolves.toEqual({ workspacePath: "/local/conversation" });
    expect(resolveLocalConversationWorkspacePath).not.toHaveBeenCalled();
  });
});
