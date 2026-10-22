import { describe, expect, it, vi } from "vitest";
import type {
  ConversationWorkspaceTargetParams,
  ConversationWorkspaceTab,
} from "@/conversation-workspace-target/contract.js";
import { exampleConversationWorkspaceTarget } from "@/conversation-workspace-target/contract.example.js";
import { resolveConversationWorkspaceTarget } from "@/conversation-workspace-target/index.js";

const project: ConversationWorkspaceTab = {
  kind: "workspace",
  workspacePath: "/project",
  workspaceIdentity: "remote-project",
  remoteSessionId: "project-session",
  workspacePurpose: "project",
};

function ports(): ConversationWorkspaceTargetParams {
  return {
    getTabs: () => [project],
    activeWorkspacePath: project.workspacePath,
    activeWorkspaceIdentity: project.workspaceIdentity!,
    getRemoteSessionSourceServerId: () => undefined,
    openRemoteConversation: vi.fn(async () => {}),
    resolveLocalConversationWorkspacePath: vi.fn(async () => "/local"),
  };
}

describe("conversation-workspace-target contract", () => {
  it("设置 tab 不参与 workspace 解析", async () => {
    const input = { ...ports(), getTabs: () => [{ kind: "settings" as const }] };
    expect(
      await exampleConversationWorkspaceTarget(resolveConversationWorkspaceTarget, input),
    ).toEqual({ workspacePath: "/local" });
    expect(input.openRemoteConversation).not.toHaveBeenCalled();
  });

  it("远程不能解除项目绑定，也不能创建远程无项目目录", async () => {
    const input = ports();
    await expect(resolveConversationWorkspaceTarget(input)).rejects.toThrow(
      "Remote projects require a project workspace",
    );
    expect(input.openRemoteConversation).not.toHaveBeenCalled();
    expect(input.resolveLocalConversationWorkspacePath).not.toHaveBeenCalled();
  });
  it("已有本地无项目会话继续使用其目录", async () => {
    const input = {
      ...ports(),
      activeWorkspaceIdentity: null,
      getTabs: () => [
        {
          ...project,
          workspaceIdentity: undefined,
          remoteSessionId: undefined,
          workspacePurpose: "conversation" as const,
        },
      ],
    };
    expect(await resolveConversationWorkspaceTarget(input)).toEqual({ workspacePath: "/project" });
    expect(input.resolveLocalConversationWorkspacePath).not.toHaveBeenCalled();
  });
});
