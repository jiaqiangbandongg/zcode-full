import { describe, expect, it } from "vitest";
import {
  REMOTE_WORKSPACE_RPC_CHANNELS,
  assertRemoteWorkspaceRpcContract,
} from "../src/host/remoteWorkspaceRpcContract.js";

describe("RemoteWorkspaceRpcContract v1", () => {
  it("requires the complete R3 full-forward channel set", () => {
    expect(REMOTE_WORKSPACE_RPC_CHANNELS).toContain("genUiService");
    const contract = Object.fromEntries(
      REMOTE_WORKSPACE_RPC_CHANNELS.map((channel) => [channel, {}]),
    );
    expect(() => assertRemoteWorkspaceRpcContract(contract)).not.toThrow();
    delete contract.oauthService;
    expect(() => assertRemoteWorkspaceRpcContract(contract)).toThrow(/oauthService/u);
  });
});
