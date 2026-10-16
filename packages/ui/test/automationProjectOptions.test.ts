import { describe, expect, it } from "vitest";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import {
  isRemoteAutomationWorkspace,
  resolveAutomationProjectOptions,
} from "@/hooks/useAutomationProjectOptions.js";

function workspaceTab(
  overrides: Partial<WorkspaceTabState> & Pick<WorkspaceTabState, "id" | "workspacePath">,
): WorkspaceTabState {
  return {
    kind: "workspace",
    label: "",
    ...overrides,
  };
}

describe("automation project boundaries", () => {
  it("只保留可用项目并使用路径 basename 作为缺省名称", () => {
    expect(
      resolveAutomationProjectOptions([
        workspaceTab({ id: "local-a", workspacePath: "/repo/local-a", label: "Local A" }),
        workspaceTab({
          id: "missing",
          workspacePath: "/repo/missing",
          availability: "unavailable-local-directory",
        }),
      ]),
    ).toEqual([{ workspacePath: "/repo/local-a", label: "Local A" }]);

    expect(
      resolveAutomationProjectOptions([
        workspaceTab({ id: "windows", workspacePath: "C:\\repo\\local-b" }),
      ]),
    ).toEqual([{ workspacePath: "C:\\repo\\local-b", label: "local-b" }]);
  });

  it("定时任务把多个 conversation backing workspace 合并为一个逻辑无项目选项", () => {
    const tabs = [
      workspaceTab({
        id: "conversation-default",
        workspacePath: "/Users/test/.zcode/workspace/default",
        workspacePurpose: "conversation",
      }),
      workspaceTab({
        id: "conversation-test-default",
        workspacePath: "/private/tmp/test/.zcode/workspace/default",
        workspacePurpose: "conversation",
      }),
      workspaceTab({
        id: "project",
        workspacePath: "/repo/project",
        workspacePurpose: "project",
      }),
    ];

    expect(resolveAutomationProjectOptions(tabs)).toEqual([
      { workspacePath: "/repo/project", label: "project" },
    ]);
    expect(
      resolveAutomationProjectOptions(tabs, {
        includeConversationWorkspace: true,
      }),
    ).toEqual([
      {
        workspacePath: "/Users/test/.zcode/workspace/default",
        label: "default",
        workspacePurpose: "conversation",
      },
      { workspacePath: "/repo/project", label: "project" },
    ]);
  });

  it("识别所有远端 workspace 身份信号", () => {
    expect(
      isRemoteAutomationWorkspace(
        workspaceTab({
          id: "ssh",
          workspacePath: "/repo",
          remoteSessionId: "remote-session",
        }),
      ),
    ).toBe(true);
    expect(
      isRemoteAutomationWorkspace(
        workspaceTab({
          id: "identity",
          workspacePath: "/repo",
          workspaceIdentity: "ssh://host/repo",
        }),
      ),
    ).toBe(true);
    expect(
      isRemoteAutomationWorkspace(
        workspaceTab({ id: "local", workspacePath: "/repo/local" }),
      ),
    ).toBe(false);
  });
});
