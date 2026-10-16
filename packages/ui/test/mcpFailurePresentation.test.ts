import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import {
  McpFailurePresentation,
  resolveMcpFailureMessageId,
} from "../src/settings/McpFailurePresentation.js";

describe("MCP failure presentation", () => {
  it("maps every stable failure kind to a localized message id", () => {
    expect(resolveMcpFailureMessageId("server_not_found")).toBe(
      "settings.mcp.failure.server_not_found",
    );
    expect(resolveMcpFailureMessageId("official_origin_untrusted")).toBe(
      "settings.mcp.failure.official_origin_untrusted",
    );
    expect(resolveMcpFailureMessageId(undefined)).toBe("settings.mcp.failure.connection_failed");
    expect(resolveMcpFailureMessageId("not_authenticated")).toBe(
      "settings.mcp.failure.not_authenticated",
    );
    expect(resolveMcpFailureMessageId("coding_plan_required")).toBe(
      "settings.mcp.failure.coding_plan_required",
    );
  });

  it.each([
    ["zh-CN" as const, "MCP 服务暂时不可用，请稍后重试。"],
    ["en-US" as const, "The MCP service is temporarily unavailable. Try again later."],
  ])("keeps diagnostics inside the click-only popover for %s", (locale, message) => {
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
    expect(html).not.toContain("req-1000");
    expect(html).not.toContain("Request ID");
    expect(html).not.toContain("请求 ID");
    expect(html).not.toContain("<details");
    expect(html).not.toContain("text-destructive");
    expect(html).toContain("text-foreground-subtle");
    expect(html).not.toContain("raw sdk error");
  });

  it.each([
    ["zh-CN" as const, "当前未登录，请先登录 ZCode。"],
    ["en-US" as const, "You are not signed in. Sign in to ZCode to use this MCP server."],
  ])("localizes the not-authenticated diagnosis for %s", (locale, message) => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: locale },
        createElement(McpFailurePresentation, { failureKind: "not_authenticated" }),
      ),
    );
    expect(html).toContain(message);
  });

  it.each([
    ["zh-CN" as const, "当前账号没有 Coding Plan，请先购买或配置 Coding Plan。"],
    [
      "en-US" as const,
      "This account has no Coding Plan. Purchase or configure a Coding Plan to use this MCP server.",
    ],
  ])("localizes the coding-plan diagnosis for %s", (locale, message) => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: locale },
        createElement(McpFailurePresentation, { failureKind: "coding_plan_required" }),
      ),
    );
    expect(html).toContain(message);
  });
});
