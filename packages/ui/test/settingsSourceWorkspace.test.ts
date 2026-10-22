import { describe, expect, it } from "vitest";
import {
  buildSourceSettingsProjectionKey,
  filterWorkspaceTabsForSettingsSource,
  isSettingsSourceOnline,
  resolveSourceSettingsValue,
  resolveSettingsSourceServerSelection,
  resolveSettingsUserScopeTarget,
  resolveSourceSettingsHomeDir,
} from "@/settings/settingsSourceWorkspace.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";

function tab(id: string, workspaceIdentity?: string): WorkspaceTabState {
  return {
    id,
    kind: "workspace",
    label: id,
    workspacePath: `/work/${id}`,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
  };
}

describe("settings Source workspace filter", () => {
  it("显式本机跳转优先于上次保存的远端 Source", () => {
    expect(
      resolveSettingsSourceServerSelection({
        pendingTarget: { sourceServerId: null },
        persistedSourceServerId: "source-a",
        sourceServerIds: ["source-a"],
      }),
    ).toBeNull();

    expect(
      resolveSettingsSourceServerSelection({
        pendingTarget: undefined,
        persistedSourceServerId: "source-a",
        sourceServerIds: ["source-a"],
      }),
    ).toBe("source-a");
  });

  it("never sends Source A project scope to Source B services", () => {
    const tabs = [
      tab("local"),
      tab("a", "remote:server:source-a:/work/a"),
      tab("b", "remote:server:source-b:/work/b"),
      tab("legacy", "remote:ssh:host:22:user:/work/legacy"),
    ];

    expect(filterWorkspaceTabsForSettingsSource(tabs, "source-b").map((item) => item.id)).toEqual([
      "b",
    ]);
    expect(filterWorkspaceTabsForSettingsSource(tabs, null).map((item) => item.id)).toEqual([
      "local",
    ]);
  });

  it("keeps Source user scope unbound from project identity", () => {
    expect(
      resolveSettingsUserScopeTarget({
        sourceServerId: "source-b",
        sourceHomeDir: "/root",
        projectWorkspacePath: "/work/b",
        projectWorkspaceIdentity: "remote:server:source-b:/work/b",
      }),
    ).toEqual({
      workspacePath: "/root",
      workspaceIdentity: undefined,
      authorityKey: "source-settings:source-b",
    });
  });

  it("does not expose a previous Source home", () => {
    const home = { sourceServerId: "source-a", homedir: "/home/alice" };
    expect(resolveSourceSettingsHomeDir(home, "source-a")).toBe("/home/alice");
    expect(resolveSourceSettingsHomeDir(home, "source-b")).toBeUndefined();
  });

  it("does not expose a previous Source settings generation", () => {
    const snapshot = { sourceServerId: "source-a", value: { memoryEnabled: true } };
    expect(resolveSourceSettingsValue(snapshot, "source-a")).toEqual({ memoryEnabled: true });
    expect(resolveSourceSettingsValue(snapshot, "source-b")).toBeNull();
  });

  it("requests Source settings only while one of its active profiles is online", () => {
    const snapshot = {
      generation: 1,
      profiles: [
        { profileId: "profile-a", sourceServerId: "source-a", lifecycleState: "active" },
        { profileId: "profile-b", sourceServerId: "source-b", lifecycleState: "retired" },
      ],
      states: [
        { profileId: "profile-a", state: "online" },
        { profileId: "profile-b", state: "online" },
      ],
    };
    expect(isSettingsSourceOnline(snapshot, "source-a")).toBe(true);
    expect(isSettingsSourceOnline(snapshot, "source-b")).toBe(false);
    expect(isSettingsSourceOnline(snapshot, "source-c")).toBe(false);
  });

  it("isolates same-path Settings projections by Source authority", () => {
    expect(buildSourceSettingsProjectionKey("/root", undefined, "source-settings:a")).not.toBe(
      buildSourceSettingsProjectionKey("/root", undefined, "source-settings:b"),
    );
  });
});
