import { describe, expect, it } from "vitest";
import {
  parseAccountProviderConfigMap,
  parsePersonalModelConfigRules,
  parsePersonalProviderConfigMap,
  parseZCodeBuiltinProviderConfigMap,
} from "../src/index.js";

describe("Todo 21 source contracts", () => {
  it("ZCode Built-in Provider 只接受 Account Family Provider", () => {
    const providers = parseZCodeBuiltinProviderConfigMap([
      {
        providerId: "builtin",
        config: {
          group: "zai-family",
          visibility: "visible",
          access: {
            type: "zhipu-account",
            accountType: "zai",
            mode: "individual-coding-plan",
          },
          api: { type: "anthropic-messages", baseUrl: "https://example.com" },
          builtinModelIds: ["model-a"],
        },
      },
    ]);

    expect(providers.get("builtin")?.group).toBe("zai-family");
    expect(() =>
      parseZCodeBuiltinProviderConfigMap([
        {
          providerId: "invalid",
          config: { group: "standard-personal", personalModelIds: ["model-a"] },
        },
      ]),
    ).toThrow();
    expect(() =>
      parseZCodeBuiltinProviderConfigMap([
        { providerId: "invalid", config: { access: { type: "api-key" } } },
      ]),
    ).toThrow();
  });

  it("Account Provider 只能投影账号约束字段", () => {
    const providers = parseAccountProviderConfigMap({
      account: {
        access: { type: "zhipu-account", entitled: true },
        builtinModelIds: ["model-a"],
      },
    });
    expect(providers.get("account")?.access).toMatchObject({
      type: "zhipu-account",
      entitled: true,
    });
    expect(() =>
      parseAccountProviderConfigMap({
        account: {
          access: {
            type: "zhipu-account",
            accountType: "zai",
            mode: "start-plan",
          },
        },
      }),
    ).toThrow();
    expect(() => parseAccountProviderConfigMap({ account: { label: "Account" } })).toThrow();
    expect(() => parseAccountProviderConfigMap({ account: { group: "zai-family" } })).toThrow();
  });

  it("Personal Provider 不能写 builtinModelIds，根 group 只能是 standard-personal", () => {
    const providers = parsePersonalProviderConfigMap({
      providerRules: [
        {
          providerId: "personal",
          config: {
            group: "standard-personal",
            personalModelIds: ["model-a"],
            modelOrder: ["model-a"],
          },
        },
        { providerId: "overlay", providerName: "Overlay", config: {} },
      ],
    });
    expect(providers.get("personal")?.modelOrder).toEqual(["model-a"]);
    expect(() =>
      parsePersonalProviderConfigMap({
        providerRules: [{ providerId: "personal", config: { builtinModelIds: ["model-a"] } }],
      }),
    ).toThrow();
    expect(() =>
      parsePersonalProviderConfigMap({
        providerRules: [{ providerId: "personal", config: { group: "standard-builtin" } }],
      }),
    ).toThrow();
    expect(() =>
      parsePersonalProviderConfigMap({
        providerRules: [
          {
            providerId: "account:zai-start-plan",
            config: { access: { type: "zhipu-account", accountType: "zai", mode: "start-plan" } },
          },
        ],
      }),
    ).toThrow("固定 Account Provider 的 Access 只能由 ZCode Built-in Config 声明");
  });

  it("Personal Provider 缺失 access 时保持不完整，不从 group 推断 Access", () => {
    const providers = parsePersonalProviderConfigMap({
      providerRules: [
        { providerId: "personal", config: { group: "standard-personal" } },
        { providerId: "overlay", providerName: "Overlay", config: {} },
      ],
    });

    expect(providers.get("personal")?.access).toBeUndefined();
    expect(providers.get("overlay")?.access).toBeUndefined();
  });

  it("智谱产品模式属于 Provider Access", () => {
    const providers = parseZCodeBuiltinProviderConfigMap([
      {
        providerId: "offpeak",
        config: {
          group: "zai-family",
          visibility: "hidden",
          access: {
            type: "zhipu-account",
            accountType: "zai",
            mode: "off-peak",
          },
          api: { type: "anthropic-messages", baseUrl: "https://example.com" },
          builtinModelIds: ["model-a"],
        },
      },
    ]);
    expect(providers.get("offpeak")?.access?.toJSON()).toEqual({
      type: "zhipu-account",
      accountType: "zai",
      mode: "off-peak",
    });
  });

  it("Model 没有 visibility", () => {
    expect(() =>
      parsePersonalModelConfigRules([
        {
          type: "provider-model",
          providerId: "provider-a",
          modelId: "model-a",
          config: { visibility: "hidden" },
        },
      ]),
    ).toThrow();
  });
});
