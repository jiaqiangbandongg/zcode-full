import { describe, expect, it } from "vitest";
import type { IServiceAccessor } from "@zcode/services";
import {
  LEGACY_REMOTE_WORKSPACE_RPC_CHANNELS,
  assertLegacyRemoteWorkspaceRpcContract,
} from "../src/host/legacyRemoteWorkspaceRpcContract.js";

function completeContract(): Partial<IServiceAccessor> {
  return Object.fromEntries(
    LEGACY_REMOTE_WORKSPACE_RPC_CHANNELS.map((channel) => [channel, {}]),
  ) as Partial<IServiceAccessor>;
}

describe("LegacyRemoteWorkspaceRpcContract", () => {
  it("接受现有远端 workspace wire 的完整 channel 集合", () => {
    expect(() => assertLegacyRemoteWorkspaceRpcContract(completeContract())).not.toThrow();
  });

  it("在构造 mixed service collection 前拒绝缺失的远端 channel", () => {
    const contract = completeContract();
    delete contract.terminalService;
    delete contract.zcodeTaskService;

    expect(() => assertLegacyRemoteWorkspaceRpcContract(contract)).toThrow(
      "terminalService, zcodeTaskService",
    );
  });
});
