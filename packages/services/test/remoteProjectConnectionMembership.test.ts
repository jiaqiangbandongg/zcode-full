import { describe, expect, it, vi } from "vitest";
import type { ConnectionProfile } from "@zcode/shared";
import type { IRemoteProjectService, RemoteProjectHost } from "#src/remote-projects/contract.js";
import {
  createRemoteProjectConnectionAdmission,
  remoteProjectHostIdForProfile,
} from "#src/remote-projects/index.js";

const profile: ConnectionProfile = {
  profileId: "profile",
  transport: "docker",
  target: { kind: "docker", container: "test" },
  createdAt: 1,
};
function fixture() {
  const host: RemoteProjectHost = {
    id: "address",
    membershipId: "original",
    kind: "docker",
    target: profile.target,
    position: 0,
  };
  const service = {
    readDirectory: vi.fn(async () => ({ hosts: [host], entries: [] })),
    saveHost: vi.fn(async () => host),
    bindHost: vi.fn(async () => host),
  } as unknown as IRemoteProjectService;
  return { service, host, admit: createRemoteProjectConnectionAdmission(service) };
}
describe("remote connection membership admission", () => {
  it("resolves both canonical addresses and trusted Source identities using shared identity helpers", () => {
    expect(remoteProjectHostIdForProfile(profile)).toBe("remote:docker:test");
    expect(remoteProjectHostIdForProfile({ ...profile, sourceServerId: "stable" })).toBe(
      "remote:server:stable",
    );
  });
  it("captures membership before the handshake, then commits with that exact generation", async () => {
    const { service, host, admit } = fixture();
    const commit = await admit({ profile, intent: "add", confirmIdentityChange: false });
    expect(service.saveHost).toHaveBeenCalledWith({
      id: remoteProjectHostIdForProfile(profile),
      target: profile.target,
    });
    await commit("stable");
    expect(service.bindHost).toHaveBeenCalledWith({
      id: host.id,
      membershipId: "original",
      resolvedId: "remote:server:stable",
      createDistinctHost: false,
    });
    vi.mocked(service.bindHost).mockResolvedValueOnce(null);
    await expect(commit("stable")).rejects.toThrow("remote-project.host-removed");
    expect(service.saveHost).toHaveBeenCalledTimes(1);
  });
  it("never adds a removed connection on startup or automatic retry", async () => {
    const { service, admit } = fixture();
    vi.mocked(service.readDirectory).mockResolvedValue({ hosts: [], entries: [] });
    await expect(
      admit({ profile, intent: "retain", confirmIdentityChange: false }),
    ).rejects.toThrow("remote-project.host-removed");
    expect(service.saveHost).not.toHaveBeenCalled();
    expect(service.bindHost).not.toHaveBeenCalled();
  });
});
