import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ModelConfigRules, ProviderConfigMap } from "@zcode/provider";
import {
  decodeProviderConfigFile,
  encodeProviderConfigFile,
} from "../src/provider-config-file-codec.js";
import {
  decodeZCodeBuiltinRelease,
  encodeZCodeBuiltinRelease,
} from "../src/zcode-builtin-release.js";

describe("Todo104 最终文件外壳", () => {
  it("个人配置必需三个空数组，默认选择位于 config，往返不丢失", () => {
    const config = {
      providerOrder: ["p"],
      providerConfigRules: { providerRules: [{ providerId: "p", providerName: "P", config: {} }] },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
      defaultModelSelection: { providerId: "p", modelId: "m", options: { reasoningLevel: "high" } },
    };
    const file = { schemaVersion: 1, config };
    const decoded = decodeProviderConfigFile(file);
    expect(decoded.defaultModelSelection).toEqual(config.defaultModelSelection);
    expect(encodeProviderConfigFile(decoded)).toEqual(file);
    expect(
      encodeProviderConfigFile({
        providers: ProviderConfigMap.empty(),
        models: ModelConfigRules.empty(),
      }),
    ).toEqual({
      schemaVersion: 1,
      config: {
        providerConfigRules: { providerRules: [] },
        modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
      },
    });
  });

  it("未上线旧包装/字段不兼容，不以 null 伪造可选默认选择", () => {
    expect(() =>
      decodeProviderConfigFile({
        schemaVersion: 1,
        providers: {},
        modelConfigRules: { providerModelRules: [] },
      }),
    ).toThrow();
    const config = {
      providerConfigRules: { providerRules: [] },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
    };
    expect(() =>
      decodeProviderConfigFile({
        schemaVersion: 1,
        config: { ...config, defaultModelSelection: null },
      }),
    ).toThrow();
    expect(() =>
      decodeProviderConfigFile({
        schemaVersion: 1,
        config: { ...config, configuredDefault: { providerId: "p", modelId: "m" } },
      }),
    ).toThrow();
    expect(() =>
      decodeProviderConfigFile({
        schemaVersion: 1,
        config: { ...config, providerConfigRules: undefined },
      }),
    ).toThrow();
  });

  it("实际 Builtin 用最终包装并完整往返，发布 revision 不倒退", async () => {
    const raw = JSON.parse(
      await readFile(
        new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
        "utf8",
      ),
    );
    expect(raw.schemaVersion).toBe(1);
    expect(raw.revision).toBeGreaterThanOrEqual(18);
    const parsed = decodeZCodeBuiltinRelease(raw);
    expect(encodeZCodeBuiltinRelease(parsed)).toEqual(raw);
    expect(parsed.config.providers.keys().length).toBeGreaterThan(0);
    expect(parsed.config.providerTemplates.keys().length).toBeGreaterThan(0);
    for (const rule of parsed.config.providers.toJSON()) {
      expect(rule.config).not.toHaveProperty("templateId");
      expect(rule.config).not.toHaveProperty("label");
    }
  });
});
