import { describe, expect, it, vi } from "vitest";
import {
  buildRemoteWorkspaceIdentity,
  buildServerRemoteWorkspaceIdentity,
  type ConnectionProfile,
} from "@zcode/shared";
import { resolveBotRemoteWorkspace } from "../src/host/botRemoteWorkspaceResolver.js";
import type { WindowRemoteLogicalSessionSnapshot } from "../src/host/windowRemoteConnectionRegistry.js";

const workspacePath = "/work/project";
const target = { kind: "ssh" as const, host: "source.test", username: "dev" };
const legacy = buildRemoteWorkspaceIdentity(workspacePath, target);
const stable = buildServerRemoteWorkspaceIdentity({ serverId: "source-a", workspacePath });
const profile: ConnectionProfile = {
  profileId: "profile-a",
  sourceServerId: "source-a",
  transport: "ssh",
  target,
  createdAt: 1,
};
function fixture() {
  const profiles = [profile];
  const servers = [
    { sourceServerId: "source-a", displayName: "A", preferredProfileId: profile.profileId },
  ];
  const sessions: WindowRemoteLogicalSessionSnapshot[] = [
    {
      sourceServerId: "source-a",
      remoteSessionId: "session-a",
      requestId: "request-a",
      target,
      workspacePath,
      workspaceIdentity: stable,
      generation: 1,
      state: "online",
      sourceAvailability: "online",
    },
  ];
  const resolveProfileTarget = vi.fn(async () => ({
    ...target,
    password: "synthetic-profile-secret",
  }));
  const directory = {
    snapshot: async () => ({ profiles, servers, workspaceHistory: [] }),
    resolveProfileTarget,
  };
  return {
    profiles,
    servers,
    sessions,
    resolveProfileTarget,
    resolve: (identity: string, purpose: "lookup" | "reconnect" = "lookup") =>
      resolveBotRemoteWorkspace({ workspacePath, workspaceIdentity: identity }, purpose, {
        directory,
        listSessions: () => sessions,
      }),
  };
}

describe("Bot Source workspace resolver", () => {
  it.each([stable, legacy])(
    "resolves %s to the existing stable route without reading credentials",
    async (identity) => {
      const f = fixture();
      expect(await f.resolve(identity)).toMatchObject({
        workspacePath,
        workspaceIdentity: stable,
        target,
        runtimeKey: JSON.stringify(["session-a", 1]),
      });
      expect(f.resolveProfileTarget).not.toHaveBeenCalled();
    },
  );
  it("uses the current route even when another profile is preferred", async () => {
    const f = fixture();
    f.profiles.push({
      ...profile,
      profileId: "profile-b",
      target: { ...target, host: "alternate.test" },
    });
    f.servers[0]!.preferredProfileId = "profile-b";
    expect((await f.resolve(stable))?.target).toEqual(target);
  });
  it("only restores current Profile credentials for explicit reconnect", async () => {
    const f = fixture();
    f.sessions.length = 0;
    expect((await f.resolve(legacy))?.runtimeKey).toBeUndefined();
    expect(f.resolveProfileTarget).not.toHaveBeenCalled();
    expect((await f.resolve(legacy, "reconnect"))?.target).toMatchObject({
      password: "synthetic-profile-secret",
    });
    expect(f.resolveProfileTarget).toHaveBeenCalledWith("profile-a");
  });
  it("rejects unknown stable identities even when the path matches", async () => {
    const f = fixture();
    expect(
      await f.resolve(
        buildServerRemoteWorkspaceIdentity({ serverId: "source-other", workspacePath }),
      ),
    ).toBeNull();
  });
  it("rejects an ambiguous legacy route after a retired profile was rebound", async () => {
    const f = fixture();
    f.profiles[0] = { ...profile, lifecycleState: "retired" };
    f.profiles.push({ ...profile, profileId: "profile-new", sourceServerId: "source-b" });
    expect(await f.resolve(legacy)).toBeNull();
  });
  it("reports a different runtime generation after reconnect", async () => {
    const f = fixture();
    const first = await f.resolve(legacy);
    f.sessions[0]!.generation += 1;
    expect((await f.resolve(stable))?.runtimeKey).not.toBe(first?.runtimeKey);
  });
});

describe("Bot non-SSH identities", () => {
  it.each([
    { kind: "wsl" as const, distro: "Ubuntu", user: "dev" },
    { kind: "docker" as const, container: "bot-e2e" },
  ])("resolves $kind legacy identity with the existing Profile", async (target) => {
    const workspaceIdentity = buildRemoteWorkspaceIdentity(workspacePath, target);
    const result = await resolveBotRemoteWorkspace({ workspacePath, workspaceIdentity }, "lookup", {
      directory: {
        snapshot: async () => ({
          profiles: [{ ...profile, transport: target.kind, target } as ConnectionProfile],
          servers: [{ sourceServerId: "source-a", displayName: "A" }],
          workspaceHistory: [],
        }),
        resolveProfileTarget: async () => target,
      },
      listSessions: () => [],
    });
    expect(result).toMatchObject({ workspaceIdentity: stable, target });
  });
});
