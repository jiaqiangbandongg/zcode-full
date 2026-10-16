import { describe, expect, it } from "vitest";
import {
  createWindowsCaptionControlsStyle,
  WINDOWS_CAPTION_CONTROLS_RIGHT_INSET_VAR,
  WINDOWS_CAPTION_CONTROL_CLASS,
  WINDOWS_CAPTION_CONTROL_WIDTH_VAR,
} from "@/windowCaptionControls.js";

describe("windowCaptionControls", () => {
  it("uses fixed CSS spacing independent of legacy native metrics", () => {
    const style = createWindowsCaptionControlsStyle(181);

    expect(style).toEqual({
      "--windows-caption-controls-right-inset":
        "136px",
      "--windows-caption-control-width": "calc(var(--windows-caption-controls-right-inset) / 3)",
    });
    expect(WINDOWS_CAPTION_CONTROLS_RIGHT_INSET_VAR).toBe(
      "var(--windows-caption-controls-right-inset)",
    );
    expect(WINDOWS_CAPTION_CONTROL_WIDTH_VAR).toBe("var(--windows-caption-control-width)");
  });

  it("falls back to the baseline inset and derives custom control width", () => {
    expect(createWindowsCaptionControlsStyle(Number.NaN)).toEqual(
      expect.objectContaining({
        "--windows-caption-controls-right-inset": "136px",
      }),
    );
    expect(WINDOWS_CAPTION_CONTROL_CLASS).toContain(
      "w-[var(--windows-caption-control-width,46px)]",
    );
  });
});
