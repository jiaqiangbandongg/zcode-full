import { describe, expect, it } from "vitest";
import {
  getWorkspacePurpose,
  partitionWorkspaceTabsByPurpose,
} from "@/lib/workspacePurpose.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";

function tab(
  id: string,
  workspacePath: string,
  workspacePurpose?: "project" | "conversation",
): WorkspaceTabState {
  return {
    id,
    kind: "workspace",
    label: id,
    workspacePath,
    ...(workspacePurpose ? { workspacePurpose } : {}),
  };
}

describe("workspace purpose", () => {
  it("defaults legacy workspaces to project", () => {
    expect(getWorkspacePurpose({ workspacePath: "/tmp/legacy" })).toBe(
      "project",
    );
  });

  it("keeps conversation targets in all task scopes while excluding them from project rows", () => {
    const conversation = tab(
      "conversation",
      "/tmp/.zcode/workspace/default",
      "conversation",
    );
    const project = tab("project", "/tmp/project", "project");
    const legacyProject = tab("legacy", "/tmp/legacy");

    expect(
      partitionWorkspaceTabsByPurpose([conversation, project, legacyProject]),
    ).toEqual({
      allTaskWorkspaceTabs: [conversation, project, legacyProject],
      conversationWorkspaceTabs: [conversation],
      projectWorkspaceTabs: [project, legacyProject],
    });
  });

  it("keeps a conversation task scope when there are no project tabs", () => {
    const conversation = tab(
      "conversation",
      "/tmp/.zcode/workspace/default",
      "conversation",
    );

    expect(partitionWorkspaceTabsByPurpose([conversation])).toEqual({
      allTaskWorkspaceTabs: [conversation],
      conversationWorkspaceTabs: [conversation],
      projectWorkspaceTabs: [],
    });
  });
});
