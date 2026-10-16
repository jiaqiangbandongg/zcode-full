import { expect, it } from "vitest";
import { OFFICIAL_PLUGIN_DEFINITIONS } from "../src/app/official-plugin-definitions.js";

it("指南并入实用工具，保留插件身份与默认启用状态", () => {
  const guide = OFFICIAL_PLUGIN_DEFINITIONS.find((plugin) => plugin.name === "zcode-guide");
  expect(guide?.listing?.category).toBe("utilities");
  expect(guide?.defaultEnabled).toBe(true);
  expect(OFFICIAL_PLUGIN_DEFINITIONS.some((plugin) => plugin.listing?.category === "guides")).toBe(
    false,
  );
});
