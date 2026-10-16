import { describe, expect, it } from "vitest";
import type { ZCodeSessionSettingsState } from "@zcode/shared";
import {
  getZCodeAgentAvailableModes,
  normalizeAvailableZCodeMode,
  settingsToConfigOptions,
} from "../src/zcode-agent/zcodeConfigOptions.js";

function settingsWithMode(
  mode: ZCodeSessionSettingsState["mode"]["current"],
): ZCodeSessionSettingsState {
  return {
    model: {
      current: { providerId: "glm", modelId: "glm-5" },
      available: [],
    },
    thoughtLevel: {
      enabled: false,
      available: [],
    },
    mode: { current: mode },
  };
}

describe("zcodeConfigOptions", () => {
  it("keeps persisted edit while the shared menu replaces it with guarded", () => {
    const options = settingsToConfigOptions(settingsWithMode("edit"));
    const modeOption = options.find((option) => option.category === "mode");

    expect(modeOption?.currentValue).toBe("edit");
    expect(modeOption?.options?.map((option) => option.value)).toEqual([
      "build",
      "guarded",
      "plan",
      "yolo",
    ]);
    expect(getZCodeAgentAvailableModes().map((mode) => mode.id)).toEqual([
      "build",
      "guarded",
      "plan",
      "yolo",
    ]);
    expect(normalizeAvailableZCodeMode("edit")).toBe("edit");
  });
});
