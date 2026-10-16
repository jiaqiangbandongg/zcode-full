import { describe, expect, it } from "vitest";
import {
  ApiKeyAccessConfig,
  ProviderApiConfig,
  ProviderConfig,
  ZhipuAccountAccessConfig,
  createRegistryProviderConfig,
  parseProviderConfig,
  serializeRegistryProviderConfig,
  type ProviderApiType,
  type ProviderGroup,
} from "../src/index.js";
import { completeProviderConfigDataSchema } from "../src/config/provider-data-schema.js";

const api = new ProviderApiConfig({
  type: "anthropic-messages",
  baseUrl: "https://api.example/v1",
});
const access = new ApiKeyAccessConfig({ apiKey: "test-key" });
const cases = [
  { name: "key", access: access.toJSON(), paths: [["access", "apiKey"]] },
  {
    name: "account",
    access: { type: "zhipu-account", accountType: "zai", mode: "off-peak", entitled: false },
    paths: [
      ["access", "accountType"],
      ["access", "mode"],
      ["access", "entitled"],
    ],
  },
];

describe("Provider 数据校验与完整性使用同一合同", () => {
  it("Todo104：新成员/endpoint字段唯一，null清除保留，旧未发布拼写拒绝", () => {
    const config = parseProviderConfig({
      group: "standard-personal",
      access: access.toJSON(),
      api: {
        type: "anthropic-messages",
        baseUrl: "https://example.test/anthropic",
        headers: { "X-Client": "test" },
      },
      builtinModelIds: ["builtin"],
      personalModelIds: ["custom"],
      modelOrder: ["custom", "builtin"],
    });
    expect(createRegistryProviderConfig(config).ok).toBe(true);
    expect(config.toJSON()).toMatchObject({
      api: { baseUrl: "https://example.test/anthropic", headers: { "X-Client": "test" } },
      personalModelIds: ["custom"],
    });
    const cleared = config.overlay(
      parseProviderConfig({ api: { baseUrl: null }, personalModelIds: null }),
    );
    expect(cleared.toJSON()).toMatchObject({
      api: { baseUrl: null },
      personalModelIds: null,
      builtinModelIds: ["builtin"],
    });
    expect(createRegistryProviderConfig(cleared).ok).toBe(false);
    expect(parseProviderConfig(cleared.toJSON()).toJSON()).toEqual(cleared.toJSON());
    expect(() => parseProviderConfig({ api: { baseURL: "https://old.invalid" } })).toThrow();
    expect(() => parseProviderConfig({ modelIds: ["old"] })).toThrow();
  });
  for (const scenario of cases) {
    const complete = { group: "zai-family", access: scenario.access, api: api.toJSON() };
    it.each(
      [...scenario.paths, ["group"], ["access"], ["api"], ["api", "type"], ["api", "baseUrl"]].map(
        (path) => ({ path, label: path.join(".") }),
      ),
    )(`${scenario.name} 的 $label 缺省/null 可保存，但不完整`, ({ path }) => {
      for (const replacement of [undefined, null]) {
        const value: Record<string, unknown> = structuredClone(complete);
        let parent = value;
        for (const key of path.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
        if (replacement === undefined) delete parent[path.at(-1)!];
        else parent[path.at(-1)!] = replacement;
        const result = createRegistryProviderConfig(parseProviderConfig(value));
        expect(result.ok).toBe(false);
        if (!result.ok)
          expect(result.issues).toContainEqual(
            expect.objectContaining({
              code: "required-field-missing",
              path: ["provider", ...path],
            }),
          );
      }
    });
    it(`${scenario.name} 的 Registry 序列化保留完整合同`, () => {
      const result = createRegistryProviderConfig(parseProviderConfig(complete));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("fixture 应为完整配置");
      const serialized = serializeRegistryProviderConfig(result.config);
      expect(completeProviderConfigDataSchema.parse(serialized)).toEqual(complete);
      expect(Object.isFrozen(result.config)).toBe(true);
    });
  }
  it("未知 API type 不能凭借非空绕过 Registry 准入", () => {
    // 模拟不可信 JS 调用；不能把 TS 静态类型当作运行时校验。
    const config = new ProviderConfig({
      group: "standard-personal",
      access,
      api: new ProviderApiConfig({ type: "unknown" as ProviderApiType, baseUrl: api.baseUrl }),
    });
    expect(() => parseProviderConfig(config.toJSON())).toThrow();
    expect(createRegistryProviderConfig(config).ok).toBe(false);
  });

  it("未知 group 不能凭借非空绕过 Registry 准入", () => {
    const config = new ProviderConfig({ group: "unknown" as ProviderGroup, access, api });
    expect(() => parseProviderConfig(config.toJSON())).toThrow();
    expect(createRegistryProviderConfig(config).ok).toBe(false);
  });

  it("可选管理 URL 填写后也遵守 schema 的合法 URL 约束", () => {
    const config = new ProviderConfig({
      group: "standard-personal",
      api,
      access: new ApiKeyAccessConfig({ apiKey: "test-key", apiKeyManagementUrl: "not-url" }),
    });
    expect(() => parseProviderConfig(config.toJSON())).toThrow();
    expect(createRegistryProviderConfig(config).ok).toBe(false);
  });

  it("未声明可选展示/成员字段和显式 null 不影响完整性", () => {
    const config = parseProviderConfig({
      group: "standard-personal",
      api: { ...api.toJSON(), headers: null },
      access: { ...access.toJSON(), apiKeyManagementUrl: null },
      logo: null,
      visibility: null,
      personalModelIds: null,
      builtinModelIds: null,
      modelOrder: null,
    });
    expect(createRegistryProviderConfig(config).ok).toBe(true);
    expect(parseProviderConfig(config.toJSON()).toJSON()).toEqual(config.toJSON());
  });

  it("Account 的 false 权益完整，清空必填值不完整，切换 Access 不保留旧 Key", () => {
    const original = new ProviderConfig({ group: "zai-family", access, api });
    const replaced = original.overlay(
      new ProviderConfig({
        access: new ZhipuAccountAccessConfig({
          accountType: "zai",
          mode: "off-peak",
          entitled: false,
        }),
      }),
    );
    expect(createRegistryProviderConfig(replaced).ok).toBe(true);
    expect(replaced.access?.toJSON()).toEqual({
      type: "zhipu-account",
      accountType: "zai",
      mode: "off-peak",
      entitled: false,
    });
    const cleared = replaced.overlay(
      new ProviderConfig({ access: new ZhipuAccountAccessConfig({ mode: null }) }),
    );
    expect(createRegistryProviderConfig(cleared).ok).toBe(false);
    expect(original.access?.toJSON()).toEqual(access.toJSON());
  });
});
