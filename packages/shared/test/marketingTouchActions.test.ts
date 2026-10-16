import { describe, expect, it } from "vitest";
import { marketingActionSchema } from "@zcode/shared";

describe("marketing navigation and copy contract", () => {
  it.each([
    "general",
    "appearance",
    "models",
    "browser",
    "computer_use",
    "memory",
    "subagents",
    "plugins",
    "mcp",
    "skills",
    "commands",
    "hooks",
    "usage",
  ])("accepts section %s", (section) => {
    expect(
      marketingActionSchema.safeParse({ type: "navigate", args: { page: "settings", section } })
        .success,
    ).toBe(true);
  });
  it.each([
    { page: "settings" },
    { page: "upgrade" },
    { page: "rewards" },
    { page: "settings", section: "models", provider_id: "provider" },
    { page: "plugin_marketplace" },
    { page: "plugin_marketplace", plugin_id: "plugin@market" },
  ])("accepts %j", (args) => {
    expect(marketingActionSchema.safeParse({ type: "navigate", args }).success).toBe(true);
  });
  it.each([
    { page: "settings", section: "automations" },
    { page: "upgrade", provider_id: "builtin:bigmodel" },
    { page: "upgrade", plan_id: "plan" },
    { page: "upgrade", section: "models" },
    { page: "referrals" },
    { page: "rewards", url: "https://example.com" },
    { page: "rewards", section: "models" },
    { page: "settings", provider_id: "provider" },
    { page: "settings", section: "general", provider_id: "provider" },
    { page: "settings", plugin_id: "plugin@market" },
    { page: "plugin_marketplace", section: "plugins" },
    { page: "plugin_marketplace", plugin_id: "plugin" },
    { page: "plugin_marketplace", plugin_id: "@market" },
    { page: "plugin_marketplace", query: "search" },
    { page: "settings", section: null },
    { page: "settings", section: "models", provider_id: "x".repeat(129) },
  ])("rejects %j", (args) => {
    expect(marketingActionSchema.safeParse({ type: "navigate", args }).success).toBe(false);
  });
  it("preserves plaintext exactly and enforces bounds", () => {
    const text = "  <b>hello</b>\n world  ";
    expect(marketingActionSchema.parse({ type: "copy_text", args: { text } })).toEqual({
      type: "copy_text",
      args: { text },
    });
    for (const args of [{ text: " \n" }, { text: "x".repeat(20001) }, { text, extra: true }]) {
      expect(marketingActionSchema.safeParse({ type: "copy_text", args }).success).toBe(false);
    }
    expect(
      marketingActionSchema.safeParse({ type: "copy_text", args: { text: "x".repeat(20000) } })
        .success,
    ).toBe(true);
  });
});
