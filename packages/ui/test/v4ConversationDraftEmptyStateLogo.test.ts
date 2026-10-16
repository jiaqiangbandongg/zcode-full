// @vitest-environment jsdom

import { createElement } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import darkEmptyStateLogoUrl from "@/assets/Z.svg";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ConversationDraftEmptyState } from "@/v4/ConversationDraftEmptyState.js";

afterEach(() => {
  cleanup();
});

describe("ConversationDraftEmptyState logo", () => {
  it("uses the supplied Z.svg asset only in dark mode", () => {
    const { container } = render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ConversationDraftEmptyState),
      ),
    );

    const lightLogo = container.querySelector("svg");
    const darkLogo = container.querySelector('[data-v4-draft-logo="dark"]');
    const logoContainer = darkLogo?.parentElement;
    const lightLogoClassName = lightLogo?.getAttribute("class") ?? "";
    const darkLogoClassName = darkLogo?.getAttribute("class") ?? "";
    const logoContainerClassName = logoContainer?.getAttribute("class") ?? "";

    expect(lightLogo).not.toBeNull();
    expect(lightLogoClassName).toContain("dark:hidden");
    expect(lightLogoClassName).toContain("opacity-70");
    expect(lightLogoClassName).toContain("mask-image:linear-gradient");
    expect(darkLogo).not.toBeNull();
    expect(darkLogo?.getAttribute("src")).toBe(darkEmptyStateLogoUrl);
    expect(darkLogoClassName).toContain("hidden");
    expect(darkLogoClassName).toContain("dark:block");
    expect(darkLogoClassName).not.toContain("opacity-70");
    expect(darkLogoClassName).not.toContain("mask-image:linear-gradient");
    expect(logoContainerClassName).not.toContain("opacity-70");
    expect(logoContainerClassName).not.toContain("mask-image:linear-gradient");
  });
});
