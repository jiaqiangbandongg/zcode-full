import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import {
  McpFailurePresentation,
  resolveMcpFailureMessageId,
} from "../src/settings/McpFailurePresentation.js";

describe("MCP failure presentation", () => {
  it("uses the generic connection failure when no failure kind is available", () => {
    expect(resolveMcpFailureMessageId(undefined)).toBe("settings.mcp.failure.connection_failed");
  });

  it.each([
    ["zh-CN" as const, "MCP 服务暂时不可用，请稍后重试。"],
    ["en-US" as const, "The MCP service is temporarily unavailable. Try again later."],
  ])(
    "renders localized failure text with initially closed technical details for %s",
    (locale, message) => {
      const html = renderToStaticMarkup(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: locale },
          createElement(McpFailurePresentation, {
            error: "raw sdk error",
            failureKind: "server_unavailable",
          }),
        ),
      );

      expect(html).toContain(message);
      expect(html).toContain('data-slot="popover-trigger"');
      expect(html).not.toContain("raw sdk error");
    },
  );
});
