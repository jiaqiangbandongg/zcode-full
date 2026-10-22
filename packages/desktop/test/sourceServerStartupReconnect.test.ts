import { describe, expect, it, vi } from "vitest";
import { runStartupReconnectBatch } from "../src/host/sourceServerStartupReconnect.js";
import type { SourceServerReconnectCandidate } from "../src/host/sourceServerDirectory.js";

const candidate = {
  profile: {
    profileId: "17ef20b3-622d-4a53-98c1-0cdff29f3e6d",
    transport: "docker",
    target: { kind: "docker", container: "zcode-dev" },
    createdAt: 1,
  },
  target: { kind: "docker", container: "zcode-dev" },
} as unknown as SourceServerReconnectCandidate;

function createDeps(remoteStartupAutoReconnectEnabled?: boolean) {
  const listCandidates = vi.fn(async () => [candidate]);
  const reconnect = vi.fn(async (candidates: SourceServerReconnectCandidate[]) =>
    candidates.map(({ profile }) => ({
      profileId: profile.profileId,
      status: "online" as const,
    })),
  );
  return {
    deps: {
      getSettings: vi.fn(async () => ({ remoteStartupAutoReconnectEnabled })),
      listCandidates,
      reconnect,
    },
    listCandidates,
    reconnect,
  };
}

describe("runStartupReconnectBatch", () => {
  it("skips the whole startup batch when the preference is disabled", async () => {
    const { deps, listCandidates, reconnect } = createDeps(false);
    await expect(runStartupReconnectBatch(deps)).resolves.toEqual([]);
    // 合同 §8.2：关闭 = 跳过整个启动批次，候选枚举都不得执行；
    // 手动连接与断线恢复不经过本入口，因此不受该设置影响。
    expect(listCandidates).not.toHaveBeenCalled();
    expect(reconnect).not.toHaveBeenCalled();
  });

  it("runs the batch when the preference is explicitly enabled", async () => {
    const { deps, reconnect } = createDeps(true);
    await expect(runStartupReconnectBatch(deps)).resolves.toEqual([
      { profileId: candidate.profile.profileId, status: "online" },
    ]);
    expect(reconnect).toHaveBeenCalledWith([candidate]);
  });

  it("treats a missing preference as enabled to keep old settings behavior", async () => {
    const { deps, reconnect } = createDeps(undefined);
    await expect(runStartupReconnectBatch(deps)).resolves.toEqual([
      { profileId: candidate.profile.profileId, status: "online" },
    ]);
    expect(reconnect).toHaveBeenCalledWith([candidate]);
  });
});
