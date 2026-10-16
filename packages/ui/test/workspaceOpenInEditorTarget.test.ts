import { describe, expect, it } from "vitest";
import type { WindowTabState } from "@/store/tabStore.js";
import { resolveWorkspaceOpenInEditorTarget } from "@/hooks/useWorkspaceOpenInEditorTarget.js";

const tabs: WindowTabState[] = [
  {
    id: "host-a",
    kind: "workspace",
    label: "repo-a",
    workspacePath: "/workspace/repo",
    workspaceIdentity: "remote:ssh:host-a:/workspace/repo",
    remoteSessionId: "session-a",
    remoteTarget: { kind: "ssh", host: "host-a", username: "dev" },
  },
  {
    id: "host-b",
    kind: "workspace",
    label: "repo-b",
    workspacePath: "/workspace/repo",
    workspaceIdentity: "remote:ssh:host-b:/workspace/repo",
    remoteSessionId: "session-b",
    remoteTarget: { kind: "ssh", host: "host-b", username: "dev" },
  },
];

describe("resolveWorkspaceOpenInEditorTarget", () => {
  it("同路径多远端且没有 identity 时失败关闭", () => {
    expect(
      resolveWorkspaceOpenInEditorTarget(tabs, {
        workspacePath: "/workspace/repo",
      }),
    ).toEqual({ isRemoteWorkspace: true, remoteTarget: undefined });
  });

  it("按 workspace identity 和 remote session 精确选择远端目标", () => {
    expect(
      resolveWorkspaceOpenInEditorTarget(tabs, {
        workspacePath: "/workspace/repo",
        workspaceIdentity: "remote:ssh:host-b:/workspace/repo",
        workspaceRemoteSessionId: "session-b",
      }),
    ).toEqual({
      isRemoteWorkspace: true,
      remoteTarget: { kind: "ssh", host: "host-b", username: "dev" },
    });
  });

  it("匹配前规范化 workspace identity 和 remote session 空白", () => {
    const tabsWithLegacyWhitespace: WindowTabState[] = tabs.map((tab) =>
      tab.id === "host-b"
        ? {
            ...tab,
            workspaceIdentity: `  ${tab.workspaceIdentity}  `,
            remoteSessionId: `  ${tab.remoteSessionId}  `,
          }
        : tab,
    );

    expect(
      resolveWorkspaceOpenInEditorTarget(tabsWithLegacyWhitespace, {
        workspacePath: "/workspace/repo",
        workspaceIdentity: "  remote:ssh:host-b:/workspace/repo  ",
        workspaceRemoteSessionId: "  session-b  ",
      }),
    ).toEqual({
      isRemoteWorkspace: true,
      remoteTarget: { kind: "ssh", host: "host-b", username: "dev" },
    });
  });
});
