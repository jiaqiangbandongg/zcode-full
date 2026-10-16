import { describe, expect, it } from "vitest";
import { createDefaultWorkspaceState } from "@/store/zcodeSessionStoreTypes.js";
import { resolveWorkspaceSwitchDraftProvider } from "@/lib/workspaceDraftProvider.js";

describe("workspace draft provider", () => {
  it("切换到已有状态的 workspace 时会保留目标 workspace 自己记住的 provider", () => {
    expect(
      resolveWorkspaceSwitchDraftProvider({
        currentSelectedProvider: "claude",
        targetWorkspacePath: "/tmp/workspace-b",
        workspaces: {
          "/tmp/workspace-b": createDefaultWorkspaceState("codex"),
        },
      }),
    ).toBe("codex");
  });

  it("切换到首次打开的 workspace 时会继承当前 workspace 的 provider", () => {
    expect(
      resolveWorkspaceSwitchDraftProvider({
        currentSelectedProvider: "gemini",
        targetWorkspacePath: "/tmp/workspace-c",
        workspaces: {},
      }),
    ).toBe("gemini");
  });
});
