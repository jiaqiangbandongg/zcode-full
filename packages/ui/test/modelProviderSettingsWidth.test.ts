import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("model provider settings width", () => {
  it("keeps the settings page on the shared 4xl width and widens only the model dialog", () => {
    const settingsPage = readFileSync(new URL("../src/SettingsPage.tsx", import.meta.url), "utf8");
    const modelDialog = readFileSync(
      new URL(
        "../src/settings/model-provider-section/ProviderModelMetadataDialog.tsx",
        import.meta.url,
      ),
      "utf8",
    );

    expect(settingsPage).not.toContain('activeSection === "modelProvider" && "max-w-6xl"');
    expect(modelDialog).toContain("max-w-2xl");
  });
});
