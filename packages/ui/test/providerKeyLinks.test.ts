import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PresetProviderApiKeyBanner } from "@/settings/model-provider-section/PresetProviderApiKeyBanner.js";
import { ProviderApiKeySection } from "@/settings/model-provider-section/ProviderCardSections.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
describe("Preset API Key acquisition", () => {
  it("所有模板复用一个获取入口", () => {
    const html = renderToStaticMarkup(
      createElement(PresetProviderApiKeyBanner, { onOpenApiKey: () => {} }),
    );
    expect(html).toContain("settings.modelProvider.getApiKey");
    expect(html.match(/<button\b/g)).toHaveLength(1);
  });
  it.each(["", "fixture-key"])("Key 为 %j 时仍只有一个获取入口", (apiKeyValue) => {
    const html = renderToStaticMarkup(
      createElement(ProviderApiKeySection, {
        apiKeyValue,
        apiKeyVisible: false,
        presetApiKeyUrl: "https://example.com/keys",
        onOpenPresetApiKey: () => {},
        onApiKeyChange: () => {},
        onApiKeyBlur: () => {},
        onToggleApiKeyVisibility: () => {},
      }),
    );
    expect(html.match(/settings\.modelProvider\.getApiKey/g)).toHaveLength(1);
  });
});
