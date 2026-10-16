import { describe, expect, it } from "vitest";
import { updateOffPeakToolPolicy } from "../src/zcode-protocol/off-peak-tool-policy.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";

function makeContext() {
  return {
    appRuntimePreferences: {
      askUserQuestionAutoResolutionEnabled: true,
      modelIoFullRetentionEnabled: false,
      offPeakToolEnabled: false,
    },
  } as unknown as ZCodeProtocolAgentServerContext;
}

describe("workspace/updateOffPeakToolPolicy（D49 workspace 级工具面门禁）", () => {
  it("缓存 host 判定的门禁供后续 create/resume/v4 冷恢复读取，并回显结果", async () => {
    const context = makeContext();
    const workspace = { workspaceKey: "/w", workspacePath: "/w" };
    const result = await updateOffPeakToolPolicy(context, { workspace, enabled: true });
    expect(context.appRuntimePreferences.offPeakToolEnabled).toBe(true);
    expect(result).toEqual({ workspace, enabled: true });

    await updateOffPeakToolPolicy(context, { workspace, enabled: false });
    expect(context.appRuntimePreferences.offPeakToolEnabled).toBe(false);
  });

  it("strict schema 拒绝未知键（不让 host 误传 per-session 字段）", async () => {
    await expect(
      updateOffPeakToolPolicy(makeContext(), {
        workspace: { workspaceKey: "/w", workspacePath: "/w" },
        enabled: true,
        sessionId: "s1",
      }),
    ).rejects.toThrow();
  });
});
