import { describe, expect, it } from "vitest";
import type { ModelSelectionView } from "@zcode/services";
import { resolveProviderBaseURL, resolveProviderLabel } from "@/lib/registryProviderView.js";

const registryView: ModelSelectionView = {
  revision: 2,
  providers: [
    {
      providerId: "api-provider",
      providerName: "Registry Label",
      config: {
        access: { type: "api-key", apiKey: "secret" },
        api: {
          type: "anthropic-messages",
          baseUrl: "https://registry.example.com",
        },
        models: ["model-a"],
      },
      models: [{ modelId: "model-a", config: {} }],
    },
  ],
};

describe("registryProviderView", () => {
  it("从 Registry View 读取 Provider 静态字段", () => {
    expect(resolveProviderLabel("api-provider", registryView)).toBe("Registry Label");
    expect(resolveProviderBaseURL("api-provider", registryView)).toBe(
      "https://registry.example.com",
    );
  });

  it("Registry 尚未水合或不包含 Provider 时返回稳定 fallback", () => {
    expect(resolveProviderLabel("account-provider", null)).toBe("account-provider");
    expect(resolveProviderBaseURL("account-provider", null)).toBeUndefined();
  });
});
