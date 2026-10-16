import { describe, expect, it } from "vitest";
import { PermissionService } from "../src/permission/service.js";
import { replyToChannelToolEntry } from "../src/tool/handlers/reply-to-channel.js";
const capability = {
  ...replyToChannelToolEntry.metadata,
  permission: replyToChannelToolEntry.permission,
};
const context = {
  toolName: "ReplyToChannel",
  input: { parts: [{ type: "mention", refId: "m1" }] },
  riskLevel: "medium" as const,
  mode: "build" as const,
};
describe("channel reply permission", () => {
  it.each(["build", "edit", "plan", "yolo"] as const)("does not ask again in %s", (mode) => {
    expect(new PermissionService().checkPermission({ ...context, mode }, capability)).toMatchObject(
      { decision: "allow", sideEffectScope: "network" },
    );
  });
  it("does not exempt other network tools or an undeclared capability", () => {
    const service = new PermissionService();
    expect(
      service.checkPermission({ ...context, toolName: "OtherSender" }, capability).decision,
    ).toBe("ask");
    expect(
      service.checkPermission(context, { ...capability, permission: undefined }).decision,
    ).toBe("ask");
  });
  it.each(["deny", "ask"] as const)("preserves explicit project %s policy", (decision) => {
    expect(
      new PermissionService().checkPermission(context, capability, {
        version: 1,
        [decision]: [{ toolName: "ReplyToChannel" }],
      }).decision,
    ).toBe(decision);
  });
});
