import { describe, expect, it } from "vitest";
import { resolveRecentRemoteProjectPreference } from "@/project-sidebar/remote-project-connection.js";
import type { RemoteProjectDirectory, RemoteProjectEntry } from "@/project-sidebar/contract.js";

const hostId = "remote:server:source-1";
const entry: RemoteProjectEntry = {
  id: "entry-1",
  hostId,
  projectId: "project-1",
  name: "project",
  roots: [{ rootPath: "/srv/project", position: 0, isPrimary: true }],
  legacyWorkspace: null,
  lastSyncedAt: null,
};
const directory: RemoteProjectDirectory = {
  hosts: [{ id: hostId, membershipId: "member-1", kind: "ssh", target: null, position: 0 }],
  entries: [entry],
};
const input = { sourceServerId: "source-1", path: "/srv/project", profileId: "profile-1" };

describe("设置最近远程项目的打开意图", () => {
  it("不依赖 renderer tab，按 Source 和路径固定已有项目入口", () => {
    expect(resolveRecentRemoteProjectPreference(directory, input)).toEqual({
      preferredProfileId: "profile-1",
      preferredDirectoryPath: "/srv/project",
      preferredProjectEntryId: "entry-1",
    });
  });
  it("其他设备的同路径项目不能命中", () => {
    const other = { ...entry, id: "other", hostId: "remote:server:source-2" };
    expect(
      resolveRecentRemoteProjectPreference({ ...directory, entries: [other, entry] }, input),
    ).toHaveProperty("preferredProjectEntryId", "entry-1");
    expect(
      resolveRecentRemoteProjectPreference({ ...directory, entries: [other] }, input),
    ).toBeNull();
  });
  it("没有指定线路时保留 Source，仍固定项目入口", () => {
    expect(
      resolveRecentRemoteProjectPreference(directory, { ...input, profileId: undefined }),
    ).toEqual({
      preferredSourceServerId: "source-1",
      preferredDirectoryPath: "/srv/project",
      preferredProjectEntryId: "entry-1",
    });
  });
  it("入口移除、Host 移除或同目录多个项目时不生成创建意图或猜选第一项", () => {
    expect(resolveRecentRemoteProjectPreference({ ...directory, entries: [] }, input)).toBeNull();
    expect(resolveRecentRemoteProjectPreference({ ...directory, hosts: [] }, input)).toBeNull();
    expect(
      resolveRecentRemoteProjectPreference(
        { ...directory, entries: [entry, { ...entry, id: "entry-2", projectId: "project-2" }] },
        input,
      ),
    ).toBeNull();
  });
  it("旧项目入口仍按保留的远程目录解析", () => {
    const legacy: RemoteProjectEntry = {
      ...entry,
      projectId: null,
      roots: [],
      legacyWorkspace: {
        kind: "remote",
        workspacePath: input.path,
        lastOpenedAt: 1,
        lastConnectionStatus: "connected",
        target: { kind: "ssh", host: "dev.example.com", username: "dev" },
      },
    };
    expect(
      resolveRecentRemoteProjectPreference({ ...directory, entries: [legacy] }, input),
    ).toHaveProperty("preferredProjectEntryId", "entry-1");
  });
});
