import { describe, expect, it } from "vitest";
import {
  projectTaskSourceDisplayName,
  resolveTaskSourceLabel,
} from "@/lib/taskSourceAttribution.js";

describe("task Source attribution", () => {
  it("uses the projected Source display name without leaking a stable ID", () => {
    expect(
      resolveTaskSourceLabel({
        workspacePath: "/work/demo",
        workspaceIdentity: "remote:server:source-a:/work/demo",
        sourceServerId: "source-a",
        serverDisplayName: "Dev Server",
      }),
    ).toBe("Dev Server");
    expect(
      resolveTaskSourceLabel({
        workspacePath: "/work/demo",
        workspaceIdentity: "remote:server:source-a:/work/demo",
      }),
    ).toBeNull();
    expect(resolveTaskSourceLabel({ workspacePath: "/work/local" })).toBeNull();
  });

  it("projects the Source directory display name onto legacy remote-store rows", () => {
    const task = {
      workspacePath: "/repo",
      workspaceIdentity: "remote:server:source-a:/repo",
    };
    expect(projectTaskSourceDisplayName(task, new Map([["source-a", "Build Server"]]))).toEqual({
      ...task,
      serverDisplayName: "Build Server",
    });
  });
});
