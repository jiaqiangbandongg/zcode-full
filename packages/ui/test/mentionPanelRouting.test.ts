import { describe, expect, it } from "vitest";
import {
  getMentionPanelGroupOrder,
  getSessionMentionWorkspaceScope,
} from "../src/mentions/mentionPanelRouting.js";

describe("getMentionPanelGroupOrder", () => {
  it("routes @ through the fixed context group order", () => {
    expect(getMentionPanelGroupOrder("@")).toEqual([
      "plugins",
      "files",
      "sessions",
      "whiteboards",
    ]);
  });

  it("keeps the legacy # and $ candidate panels", () => {
    expect(getMentionPanelGroupOrder("#")).toEqual(["sessions"]);
    expect(getMentionPanelGroupOrder("$")).toEqual(["skills"]);
  });

  it("只让 # 扩展对话 workspace 范围", () => {
    expect(getSessionMentionWorkspaceScope("#")).toBe(
      "same-authority-workspaces",
    );
    expect(getSessionMentionWorkspaceScope("@")).toBe("current-workspace");
    expect(getSessionMentionWorkspaceScope("$")).toBe("current-workspace");
    expect(getSessionMentionWorkspaceScope(null)).toBe("current-workspace");
  });
});
