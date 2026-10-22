import { afterEach, expect, it, vi } from "vitest";
import { readGenUiStyleContext } from "@/gen-ui/adapters/theme.js";
import { GEN_UI_STYLE_CONTEXT_KEY } from "@zcode/shared/gen-ui";
import { McpUiHostContextSchema } from "@modelcontextprotocol/ext-apps";

afterEach(() => vi.unstubAllGlobals());

it("projects Gen UI controls separately from MCP accent and follows the host font", () => {
  const tokens: Record<string, string> = {
    "--ui-font-size": "18px",
    "--color-primary": "#111111",
    "--color-brand": "#3366ff",
    "--color-input": "#fafafa",
    "--color-input-border-focused": "#999999",
    "--radius-xl": "12px",
  };
  vi.stubGlobal("document", { documentElement: {} });
  vi.stubGlobal("getComputedStyle", () => ({
    getPropertyValue: (key: string) => tokens[key] ?? "",
  }));
  const context = readGenUiStyleContext();
  expect(McpUiHostContextSchema.safeParse(context).success).toBe(true);
  const variables = context.styles.variables;
  const controls = context[GEN_UI_STYLE_CONTEXT_KEY];
  expect(variables["--color-text-info"]).toBe("#3366ff");
  expect(controls["--gen-ui-primary"]).toBe("#111111");
  expect(controls["--gen-ui-input"]).toBe("#fafafa");
  expect(controls["--gen-ui-input-border-focused"]).toBe("#999999");
  expect(Object.keys(variables).some((key) => key.startsWith("--gen-ui-"))).toBe(false);
  expect(variables["--font-heading-xs-size"]).toBe("18px");
  expect(variables["--font-heading-sm-size"]).toBe("20px");
  expect(variables["--font-heading-md-size"]).toBe("22px");
  expect(variables["--border-radius-xl"]).toBe("12px");
  tokens["--ui-font-size"] = "14px";
  expect(readGenUiStyleContext().styles.variables["--font-heading-md-size"]).toBe("18px");
});

it("leaves standalone CSS fallbacks in charge when a Gen UI token is absent", () => {
  vi.stubGlobal("document", { documentElement: {} });
  vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "" }));
  const context = readGenUiStyleContext();
  const variables = context.styles.variables;
  expect(context[GEN_UI_STYLE_CONTEXT_KEY]["--gen-ui-input"]).toBeUndefined();
  expect(variables["--font-text-md-size"]).toBe("14px");
});
