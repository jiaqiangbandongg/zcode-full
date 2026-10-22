import { describe, expect, it } from "vitest";
import { webRemoteControlAuthStateChangeSchema } from "@zcode/shared";

describe("renderer 远控登录通知契约", () => {
  it.each(["signed-in", "signed-out"])("接受 %s 事件", (state) => {
    expect(webRemoteControlAuthStateChangeSchema.parse({ state })).toEqual({ state });
  });
  it.each([
    null,
    {},
    [],
    { state: true },
    { state: "login" },
    { state: "signed-in", jwt: "secret" },
    { state: "signed-out", windowId: 2 },
  ])("拒绝非法类型与额外字段 %j", (payload) => {
    expect(webRemoteControlAuthStateChangeSchema.safeParse(payload).success).toBe(false);
  });
});
