import { describe, expect, it } from "vitest";
import {
  zcodeProviderUpdateAccountConfigParamsSchema,
  zcodeProviderUpdateAccountConfigResultSchema,
} from "../src/zcode-protocol/index.js";

describe("Account 快照协议", () => {
  const snapshot = {
    revision: "account-1",
    basedOnZCodeBuiltinRevision: "builtin-1",
    providers: {},
    states: {
      account: {
        availability: "pending",
        entitled: false,
        current: true,
        effectiveAt: 1_800_000_000,
        connectionKey: "opaque-connection",
      },
    },
  };

  it("完整往返 Account State，不将其当未知字段删除", () => {
    expect(zcodeProviderUpdateAccountConfigParamsSchema.parse(snapshot)).toEqual(snapshot);
  });

  it.each(["not-authenticated", "not-connected", "credential-failed", "not-entitled"])(
    "不可用原因 %s 不阻断同一快照内其他可用套餐的同步",
    (unavailableReason) => {
      const mixedSnapshot = {
        ...snapshot,
        states: {
          failed: { availability: "unavailable", entitled: false, unavailableReason },
          working: { availability: "available", entitled: true },
        },
      };
      expect(zcodeProviderUpdateAccountConfigParamsSchema.parse(mixedSnapshot)).toEqual(
        mixedSnapshot,
      );
    },
  );

  it("缺少 states 的旧信封不能冒充完整快照，空账号状态仍可传递", () => {
    const { states: _states, ...withoutStates } = snapshot;
    expect(zcodeProviderUpdateAccountConfigParamsSchema.safeParse(withoutStates).success).toBe(
      false,
    );
    expect(
      zcodeProviderUpdateAccountConfigParamsSchema.parse({ ...withoutStates, states: {} }).states,
    ).toEqual({});
  });

  it("回执只确认接收，不把收到的版本宣称为已应用", () => {
    expect(
      zcodeProviderUpdateAccountConfigResultSchema.parse({
        receivedRevision: "account-1",
        providerCount: 0,
        status: "received",
      }),
    ).toEqual({ receivedRevision: "account-1", providerCount: 0, status: "received" });
    expect(
      zcodeProviderUpdateAccountConfigResultSchema.safeParse({
        appliedRevision: "account-1",
        providerCount: 0,
        status: "applied",
      }).success,
    ).toBe(false);
  });

  it.each([
    { current: "false" },
    { entitled: "true" },
    { token: "forbidden" },
    { unavailableReason: "unexpected" },
    { unavailableReason: null },
  ])("拒绝状态的错误类型和非契约字段 %j", (invalid) => {
    expect(() =>
      zcodeProviderUpdateAccountConfigParamsSchema.parse({
        ...snapshot,
        states: { account: { ...snapshot.states.account, ...invalid } },
      }),
    ).toThrow();
  });
});
