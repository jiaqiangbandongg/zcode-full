// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  adaptMarketingPopup,
  marketingLabel,
} from "@/components/marketing-touch/marketingPopupAdapter.js";

describe("marketing popup adapter", () => {
  it.each(["zh-CN", "en-US"] as const)("%s Start 设置入口明确叫查看套餐", (locale) => {
    const text = { format: "plaintext" as const, content: "立即使用" };
    const popup = adaptMarketingPopup(
      "start",
      locale,
      {
        title: text,
        description: text,
        buttons: [
          {
            text,
            action: {
              type: "navigate",
              args: {
                page: "settings",
                section: "models",
                provider_id: "account:bigmodel-start-plan",
              },
            },
          },
        ],
      },
      null,
      locale === "zh-CN" ? "查看套餐" : "View plan",
    );
    expect(popup.dialog.buttons[0]?.label).toBe(locale === "zh-CN" ? "查看套餐" : "View plan");
    expect(popup.dialog.buttons[0]?.formattedLabel?.text).toBe(popup.dialog.buttons[0]?.label);
  });
  it("preserves popup themes and uses default when omitted", () => {
    const text = { format: "plaintext" as const, content: "Close" };
    const theme = { variant: "ghost" as const, class: "rounded-lg", style: "color: red" };
    const result = adaptMarketingPopup(
      "test",
      "en-US",
      {
        title: text,
        description: text,
        buttons: [
          { text, theme, action: { type: "close" } },
          { text, action: { type: "close" } },
        ],
      },
      null,
    );
    expect(result.dialog.buttons[0]?.theme).toEqual(theme);
    expect(result.dialog.buttons[1]?.theme).toEqual({ variant: "default" });
  });
  it("keeps copy text literal and correlates navigation through stable button ids", () => {
    const text = { format: "plaintext" as const, content: "Open" };
    const payload = adaptMarketingPopup(
      "action",
      "en-US",
      {
        title: text,
        description: text,
        buttons: [
          {
            text,
            action: {
              type: "navigate",
              args: { page: "settings", section: "models", provider_id: "bigmodel" },
            },
          },
          {
            text,
            action: {
              type: "navigate",
              args: { page: "plugin_marketplace", plugin_id: "plugin@market" },
            },
          },
          { text, action: { type: "copy_text", args: { text: "<b>literal</b>\n next " } } },
        ],
      },
      null,
    );
    expect(payload.actions).toEqual({
      "button-0": { type: "navigate", destination: "settings" },
      "button-1": { type: "navigate", destination: "plugin_store" },
      "button-2": { type: "copy_text", text: "<b>literal</b>\n next " },
    });
    expect(payload.dialog.buttons.map((button) => button.actionId)).toEqual([
      "button-0",
      "button-1",
      "button-2",
    ]);
  });
  it("maps existing inline actions and strips markup from button labels", () => {
    const payload = adaptMarketingPopup(
      "193001",
      "en-US",
      {
        title: { format: "plaintext", content: "News" },
        description: { format: "html", content: "<p>Hello</p>" },
        buttons: [
          {
            text: { format: "html", content: "<b>Claim</b><script>bad()</script>" },
            action: { type: "claim_zcode_plan", args: { plan_id: "plan" } },
          },
        ],
      },
      null,
    );
    expect(payload.dialog.hero).toBeNull();
    expect(payload.dialog.buttons[0]?.label).toBe("Claim");
    expect(payload.dialog.buttons[0]?.formattedLabel).toEqual({
      format: "html",
      text: "<b>Claim</b><script>bad()</script>",
    });
    expect(payload.dialog.formattedTitle).toEqual({ format: "plain_text", text: "News" });
    expect(payload.actions["button-0"]).toEqual({ type: "claim_plan", planId: "plan" });
    expect(payload.dialog.description).toEqual({ format: "html", text: "<p>Hello</p>" });
  });
  it("keeps plaintext literal and does not attach remote styles", () => {
    expect(marketingLabel({ format: "plaintext", content: "<b>literal</b>" })).toBe(
      "<b>literal</b>",
    );
  });
});
