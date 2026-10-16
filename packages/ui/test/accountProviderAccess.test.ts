import { describe, expect, it } from "vitest";
import type { ProviderSettingsView } from "@zcode/services";
import {
  resolveEntitledAccountProviderAccess,
  resolveEntitledAccountProviderAccessFingerprint,
} from "@/lib/accountProviderAccess.js";

const view: ProviderSettingsView = {
  revision: 1,
  addableProviders: [],
  providerOrder: [],
  providers: [
    {
      providerId: "unentitled-account",
      enabled: true,
      executable: false,
      effectiveConfig: {
        access: {
          type: "zhipu-account",
          accountType: "bigmodel",
          mode: "team-coding-plan",
          entitled: false,
        },
        builtinModelIds: [],
      },
      issues: [],
      models: [],
    },
    {
      providerId: "account",
      providerName: "Account Plan",
      enabled: true,
      executable: true,
      effectiveConfig: {
        access: {
          type: "zhipu-account",
          accountType: "bigmodel",
          mode: "individual-coding-plan",
          entitled: true,
        },
        builtinModelIds: [],
      },
      issues: [],
      models: [],
    },
    {
      providerId: "api",
      enabled: true,
      executable: true,
      effectiveConfig: {
        access: { type: "api-key", apiKey: "secret" },
        personalModelIds: [],
      },
      issues: [],
      models: [],
    },
    {
      providerId: "off-peak",
      enabled: true,
      executable: true,
      effectiveConfig: {
        access: {
          type: "zhipu-account",
          accountType: "bigmodel",
          mode: "off-peak",
          entitled: true,
        },
        builtinModelIds: [],
      },
      issues: [],
      models: [],
    },
  ],
};

describe("accountProviderAccess", () => {
  it("只把 entitled=true 的 Account Provider 解析为当前账号权益", () => {
    expect(resolveEntitledAccountProviderAccess(view, "account")).toEqual({
      providerId: "account",
      access: {
        type: "zhipu-account",
        accountType: "bigmodel",
        mode: "individual-coding-plan",
        entitled: true,
      },
      label: "Account Plan",
    });
    expect(resolveEntitledAccountProviderAccess(view, "unentitled-account")).toBeNull();
    expect(resolveEntitledAccountProviderAccess(view, "api")).toBeNull();
    expect(resolveEntitledAccountProviderAccess(view, "missing")).toBeNull();
  });

  it("连接指纹由 Registry revision、Provider ID 和结构化 access 组成", () => {
    expect(resolveEntitledAccountProviderAccessFingerprint(view, "account")).toBe(
      '[1,"account",{"type":"zhipu-account","accountType":"bigmodel","mode":"individual-coding-plan","entitled":true}]',
    );
  });

  it("同一 Family 同时启用普通套餐和闲时 Provider 时仍按精确 Provider ID 解析", () => {
    expect(resolveEntitledAccountProviderAccess(view, "account")?.access.mode).toBe(
      "individual-coding-plan",
    );
    expect(resolveEntitledAccountProviderAccess(view, "off-peak")?.access.mode).toBe("off-peak");
  });
});
