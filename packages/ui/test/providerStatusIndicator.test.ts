import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ProviderStatusIndicator } from "@/settings/model-provider-section/ProviderStatusIndicator.js";
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
describe("Provider status presentation", () => {
  it.each([
    [false, true, "disabled"],
    [true, false, "unavailable"],
    [true, true, "ready"],
  ] as const)("enabled=%s executable=%s", (enabled, executable, status) => {
    const html = renderToStaticMarkup(
      createElement(ProviderStatusIndicator, { provider: { enabled, executable } }),
    );
    expect(html).toContain(`data-provider-status="${status}"`);
  });
});
