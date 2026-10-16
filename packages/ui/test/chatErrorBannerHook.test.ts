import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  TID_CHAT_ERROR_DETAILS_BUTTON,
  TID_CHAT_ERROR_HOOK_ICON,
  type IPlatformService,
} from "@zcode/shared";
import { describe, expect, it, vi } from "vitest";
import { ChatErrorBanner } from "@/ChatErrorBanner.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

vi.mock("@/components/ui/toast.js", () => ({
  toast: vi.fn(),
}));

const mockPlatform = {
  captureWindowScreenshot: vi.fn(async () => null),
} as unknown as IPlatformService;

describe("ChatErrorBanner Hook errors", () => {
  it("renders the Hook icon and details action for a blocked Hook error", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(
          PlatformProvider,
          { platform: mockPlatform },
          createElement(ChatErrorBanner, {
            error: {
              code: "fault.runtime.hookBlocked",
              message: "hooks_prompt_block: python3: missing file",
              detail: "Hook block reason: hooks_prompt_block\nHook error: python3: missing file",
            },
          }),
        ),
      ),
    );

    expect(html).toContain("hooks_prompt_block: python3: missing file");
    expect(html).toContain(`data-testid="${TID_CHAT_ERROR_DETAILS_BUTTON}"`);
    expect(html).toContain("展开详情");
    expect(html).toContain(`data-testid="${TID_CHAT_ERROR_HOOK_ICON}"`);
  });
});
