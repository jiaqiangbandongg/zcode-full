import { describe, expect, it } from "vitest";
import type { ZCodeConfigOption } from "@zcode/shared";
import { readCurrentZCodeMode } from "../src/hooks/chatActionHelpers.js";

function createModeOption(currentValue: string | boolean): ZCodeConfigOption {
  return {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue,
  };
}

describe("chatActionHelpers", () => {
  it("reads yolo from ZCode Agent mode config options", () => {
    expect(readCurrentZCodeMode([createModeOption("yolo")])).toBe("yolo");
  });

  it("reads edit from ZCode Agent mode config options", () => {
    expect(readCurrentZCodeMode([createModeOption("edit")])).toBe("edit");
  });

  it("keeps provider-native ZCode Agent modes", () => {
    expect(readCurrentZCodeMode([createModeOption("bypassPermissions")])).toBe("bypassPermissions");
  });

  it("does not normalize retired provider-native agent mode ids", () => {
    const readMode = readCurrentZCodeMode as (
      options: readonly ZCodeConfigOption[],
      provider?: string,
    ) => unknown;
    expect(readCurrentZCodeMode([createModeOption("agent")])).toBeUndefined();
    expect(readMode([createModeOption("agent-full-access")], "gemini")).toBeUndefined();
  });

  it("ignores invalid mode values", () => {
    expect(readCurrentZCodeMode([createModeOption("unknown")])).toBeUndefined();
    expect(readCurrentZCodeMode([createModeOption(true)])).toBeUndefined();
  });
});
