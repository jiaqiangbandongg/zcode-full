import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { SettingsResourceGroupHeader } from "@/settings/SettingsResourceGroupHeader.js";

function renderHeader(count: number) {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(SettingsResourceGroupHeader, {
        count,
        title: "Resources",
      }),
    ),
  );
}

describe("SettingsResourceGroupHeader", () => {
  it("formats pluralized item counts with numeric values", () => {
    expect(renderHeader(1)).toContain("1 item");
    expect(renderHeader(2)).toContain("2 items");
    expect(renderHeader(2)).not.toContain("{count, plural");
  });
});
