import { describe, expect, it } from "vitest";
import { PRESET_PROVIDER_SPECS } from "@/settings/model-provider-section/constants.js";

describe("model provider preset visibility", () => {
  it("预置入口不再包含已退出产品的 ZAPI", () => {
    expect(PRESET_PROVIDER_SPECS.map((preset) => preset.id)).not.toContain("builtin:zapi");
  });
});
