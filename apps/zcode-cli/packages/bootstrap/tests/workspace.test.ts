import { describe, expect, it } from "vitest";
import { resolveWorkspaceRefFromId } from "../src/zcode-protocol/workspace.js";

describe("resolveWorkspaceRefFromId", () => {
  it("带显式 user 的 WSL identity 还原真实 working directory", () => {
    const workspaceIdentity = "remote:wsl:Ubuntu-24.04:dev:/home/dev/coding/DEMO-ERP-NEW";

    expect(resolveWorkspaceRefFromId(workspaceIdentity)).toEqual({
      workspaceIdentity,
      workspaceKey: workspaceIdentity,
      workspacePath: "/home/dev/coding/DEMO-ERP-NEW",
    });
  });

  it("本地 workspacePath 保持 fallback 语义", () => {
    expect(resolveWorkspaceRefFromId("/Users/dev/workspace")).toEqual({
      workspaceIdentity: undefined,
      workspaceKey: "/Users/dev/workspace",
      workspacePath: "/Users/dev/workspace",
    });
  });

  it("非法 remote identity 不得回退为本地路径", () => {
    expect(() => resolveWorkspaceRefFromId("remote:wsl:Ubuntu-24.04")).toThrow(
      "Invalid remote workspace identity",
    );
  });
});
