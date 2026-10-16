import { describe, expect, it } from "vitest";
import {
  createRegistryProviderConfig,
  parseProviderConfig,
  serializeRegistryProviderConfig,
} from "../src/index.js";

describe("Manual Coding Plan access", () => {
  it("保留显式 type、管理入口和 Key，不要求账号事实", () => {
    const base = parseProviderConfig({
      group: "standard-personal",
      access: {
        type: "zhipu-coding-plan-api-key",
        apiKeyManagementUrl: "https://z.ai/manage-apikey/apikey-list",
      },
      api: { type: "anthropic-messages", baseUrl: "https://api.z.ai/api/anthropic" },
    });
    expect(createRegistryProviderConfig(base).ok).toBe(false);
    const configured = base.overlay(
      parseProviderConfig({ access: { type: "zhipu-coding-plan-api-key", apiKey: "id.secret" } }),
    );
    const result = createRegistryProviderConfig(configured);
    if (!result.ok) throw new Error("manual key should be complete without account state");
    expect(serializeRegistryProviderConfig(result.config)).toEqual(configured.toJSON());
    expect(configured.toJSON().access).toEqual({ ...base.toJSON().access, apiKey: "id.secret" });
    expect(parseProviderConfig(configured.toJSON()).toJSON()).toEqual(configured.toJSON());
    expect(() =>
      parseProviderConfig({ access: { type: "zhipu-coding-plan-api-key", entitled: true } }),
    ).toThrow();
    expect(() =>
      parseProviderConfig({
        access: { type: "zhipu-coding-plan-api-key", apiKeyManagementUrl: "invalid" },
      }),
    ).toThrow();
    expect(
      configured
        .overlay(parseProviderConfig({ access: { type: "api-key", apiKey: "ordinary" } }))
        .toJSON().access,
    ).toEqual({ type: "api-key", apiKey: "ordinary" });
  });

  it.each(["api-key", "zhipu-coding-plan-api-key"])(
    "%s 只允许单一管理入口，不接受已撤销的团队字段",
    (type) => {
      expect(() =>
        parseProviderConfig({
          access: { type, teamApiKeyManagementUrl: "https://example.com/keys" },
        }),
      ).toThrow();
      const base = parseProviderConfig({
        access: { type, apiKey: "fixture-key", apiKeyManagementUrl: "https://example.com/keys" },
      });
      const replaced = base.overlay(
        parseProviderConfig({
          access: { type, apiKeyManagementUrl: "https://example.com/console" },
        }),
      );
      expect(replaced.toJSON().access).toEqual({
        type,
        apiKey: "fixture-key",
        apiKeyManagementUrl: "https://example.com/console",
      });
      expect(
        replaced
          .overlay(parseProviderConfig({ access: { type, apiKeyManagementUrl: null } }))
          .toJSON().access,
      ).toEqual({ type, apiKey: "fixture-key", apiKeyManagementUrl: null });
    },
  );
});
