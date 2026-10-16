import { describe, expect, it } from "vitest";
import {
  isRemoteWorkspaceRpcTarget,
  shouldEnableWorkspaceRpc,
} from "@/lib/workspaceRpcAvailability.js";

describe("workspaceRpcAvailability", () => {
  it("本地 workspace 允许主动 RPC", () => {
    const target = {};

    expect(isRemoteWorkspaceRpcTarget(target)).toBe(false);
    expect(shouldEnableWorkspaceRpc(target)).toBe(true);
  });

  it("已连接远端 workspace 允许主动 RPC", () => {
    const target = {
      workspaceIdentity: "remote:ssh:198.44.179.20:2222:root:/root",
      remoteSessionId: "remote-session-1",
    };

    expect(isRemoteWorkspaceRpcTarget(target)).toBe(true);
    expect(shouldEnableWorkspaceRpc(target)).toBe(true);
  });

  it("断连远端占位 workspace 禁止主动 RPC", () => {
    const target = {
      workspaceIdentity: "remote:ssh:198.44.179.20:2222:root:/root",
    };

    expect(isRemoteWorkspaceRpcTarget(target)).toBe(true);
    expect(shouldEnableWorkspaceRpc(target)).toBe(false);
  });
});
