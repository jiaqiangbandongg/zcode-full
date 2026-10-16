import { describe, expect, it, vi } from "vitest";
import type { ProviderSettingsView } from "@zcode/services";
import { projectProviderSettingsViewToFormProviders } from "@/lib/providerSettingsFormProjection.js";
import { getProviderFormLabel } from "@/lib/providerSettingsFormTypes.js";
import { persistPersonalProvider } from "@/lib/providerPersonalSave.js";
import { resolvePendingProviderDraftSave } from "@/settings/model-provider-section/ProviderDraftSave.js";

describe("Todo104 Provider 规则外层元数据表单", () => {
  const view: ProviderSettingsView = {
    revision: 1,
    providerOrder: ["demo"],
    providerTemplates: [],
    providers: [
      {
        providerId: "demo",
        providerName: "Demo",
        templateId: "example",
        executable: false,
        issues: [],
        models: [],
        personalConfig: { api: { headers: { "x-route": "keep" } } },
        effectiveConfig: {
          api: {
            type: "anthropic-messages",
            baseUrl: "https://example.test",
            headers: { "x-route": "keep" },
          },
        },
      },
    ],
  };
  const draft = {
    nameValue: "Demo",
    apiFormat: "anthropic-messages" as const,
    baseUrlValue: "https://example.test",
    apiKeyValue: "",
  };

  it("读取外层名称/模板；未编辑不保存", () => {
    const provider = projectProviderSettingsViewToFormProviders(view)[0]!;
    expect(getProviderFormLabel(provider)).toBe("Demo");
    expect(provider.templateId).toBe("example");
    expect(provider.config).not.toHaveProperty("label");
    expect(resolvePendingProviderDraftSave({ provider, draft, now: () => 0 })).toBeNull();
  });

  it.each(["Renamed", ""])(
    '改名 "%s" 只提交外层名称补丁，不物化模板/连接继承值',
    async (nameValue) => {
      const provider = projectProviderSettingsViewToFormProviders(view)[0]!;
      const edited = resolvePendingProviderDraftSave({
        provider,
        draft: { ...draft, nameValue },
        // Todo132：名称只在用户确认时提交，不能再依赖技术字段的 idle 保存。
        nameConfirmed: true,
        now: () => 0,
      });
      expect(edited).not.toBeNull();
      expect(getProviderFormLabel(edited!)).toBe(nameValue || "demo");
      const savePersonalProviderOverlay = vi.fn(async () => view);
      await persistPersonalProvider({
        provider: edited!,
        providerSettingsService: { savePersonalProviderOverlay },
      });
      expect(savePersonalProviderOverlay).toHaveBeenCalledWith(
        "demo",
        view.providers[0]!.personalConfig,
        { providerName: nameValue || null },
      );
      expect(edited!.config).toEqual(provider.config);
    },
  );

  it("只改地址不把继承名称写成个人名称；静态 headers 保留", async () => {
    const provider = projectProviderSettingsViewToFormProviders(view)[0]!;
    const edited = resolvePendingProviderDraftSave({
      provider,
      draft: { ...draft, baseUrlValue: "https://next.test" },
      now: () => 0,
    })!;
    const savePersonalProviderOverlay = vi.fn(async () => view);
    await persistPersonalProvider({
      provider: edited,
      providerSettingsService: { savePersonalProviderOverlay },
    });
    expect(savePersonalProviderOverlay).toHaveBeenCalledWith(
      "demo",
      { api: { baseUrl: "https://next.test", headers: { "x-route": "keep" } } },
      undefined,
    );
  });
});
