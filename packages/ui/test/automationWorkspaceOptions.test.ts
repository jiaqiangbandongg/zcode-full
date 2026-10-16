import { describe, expect, it } from "vitest";
import type { WindowTabState } from "@/store/tabStore.js";
import {
  buildAutomationWorkspaceOptions,
  findAutomationWorkspaceOptionByKey,
  reconcileAutomationWorkspaceSelectionKey,
  resolveAutomationWorkspaceSelectionKey,
} from "@/settings/automationWorkspaceOptions.js";

describe("automation workspace options", () => {
  it("只保留当前打开且可用的项目 tab", () => {
    const tabs: WindowTabState[] = [
      { id: "settings", kind: "settings", label: "settings" } as never,
      {
        id: "project-open",
        kind: "workspace",
        workspacePath: "/repo/open",
        label: "open",
        workspacePurpose: "project",
      },
      {
        id: "conversation-default",
        kind: "workspace",
        workspacePath: "/app/default",
        label: "default",
        workspacePurpose: "conversation",
      },
      {
        id: "project-deleted",
        kind: "workspace",
        workspacePath: "/repo/deleted",
        label: "deleted",
        availability: "unavailable-local-directory",
        workspacePurpose: "project",
      },
    ] as WindowTabState[];

    expect(buildAutomationWorkspaceOptions(tabs)).toEqual([
      {
        workspacePath: "/repo/open",
        label: "open",
      },
    ]);
  });

  it("远程同路径项目按 workspaceIdentity 隔离并保留会话信息", () => {
    const tabs = [
      {
        id: "remote-a",
        kind: "workspace",
        workspacePath: "/repo",
        label: "remote-a",
        workspaceIdentity: "remote:ssh:a:/repo",
        remoteSessionId: "session-a",
      },
      {
        id: "remote-b",
        kind: "workspace",
        workspacePath: "/repo",
        label: "remote-b",
        workspaceIdentity: "remote:ssh:b:/repo",
        remoteSessionId: "session-b",
      },
    ] as WindowTabState[];

    expect(buildAutomationWorkspaceOptions(tabs)).toMatchObject([
      {
        label: "remote-a",
        workspaceIdentity: "remote:ssh:a:/repo",
        remoteSessionId: "session-a",
      },
      {
        label: "remote-b",
        workspaceIdentity: "remote:ssh:b:/repo",
        remoteSessionId: "session-b",
      },
    ]);

    const options = buildAutomationWorkspaceOptions(tabs);
    const selectedKey = resolveAutomationWorkspaceSelectionKey(options[1]!);
    expect(selectedKey).toBe("remote:ssh:b:/repo");
    expect(findAutomationWorkspaceOptionByKey(options, selectedKey)).toMatchObject({
      workspacePath: "/repo",
      workspaceIdentity: "remote:ssh:b:/repo",
      remoteSessionId: "session-b",
    });
  });

  it("无有效项目时选择收敛为 null，不回退到默认或 conversation workspace", () => {
    expect(
      reconcileAutomationWorkspaceSelectionKey([], "/app/default", {
        workspacePath: "/app/default",
      }),
    ).toBeNull();
  });

  it("候选恢复后优先选择有效默认项目，并保留仍有效的当前项目", () => {
    const options = [
      { workspacePath: "/repo/first", label: "first" },
      {
        workspacePath: "/repo",
        workspaceIdentity: "remote:ssh:b:/repo",
        label: "remote-b",
      },
    ];

    expect(
      reconcileAutomationWorkspaceSelectionKey(options, null, {
        workspacePath: "/repo",
        workspaceIdentity: "remote:ssh:b:/repo",
      }),
    ).toBe("remote:ssh:b:/repo");
    expect(
      reconcileAutomationWorkspaceSelectionKey(
        options,
        "/repo/first",
        {
          workspacePath: "/repo",
          workspaceIdentity: "remote:ssh:b:/repo",
        },
      ),
    ).toBe("/repo/first");
  });
});
