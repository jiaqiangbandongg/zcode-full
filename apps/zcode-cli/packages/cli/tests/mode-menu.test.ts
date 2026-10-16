import { describe, expect, it } from "vitest";
import {
  formatAvailableCommandCenterModes,
  isSwitchableCommandCenterMode,
} from "../src/command-center/modes.js";

describe("mode menu compatibility", () => {
  it("advertises guarded instead of edit while accepting explicit legacy commands", () => {
    expect(formatAvailableCommandCenterModes()).toBe("plan, build, guarded, yolo");
    for (const mode of ["plan", "build", "edit", "guarded", "yolo"]) {
      expect(isSwitchableCommandCenterMode(mode)).toBe(true);
    }
    expect(isSwitchableCommandCenterMode("unknown")).toBe(false);
  });
});
