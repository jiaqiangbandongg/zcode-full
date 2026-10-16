import { describe, expect, it } from "vitest";
import { isImeComposingKeyEvent } from "@/lib/imeComposition.js";

describe("isImeComposingKeyEvent", () => {
  it("treats local composition state as active IME input", () => {
    expect(isImeComposingKeyEvent({ compositionActive: true })).toBe(true);
  });

  it("treats React and native composing flags as active IME input", () => {
    expect(isImeComposingKeyEvent({ isComposing: true })).toBe(true);
    expect(isImeComposingKeyEvent({ nativeEvent: { isComposing: true } })).toBe(true);
  });

  it("allows normal Enter handling when no composing flag is active", () => {
    expect(
      isImeComposingKeyEvent({
        compositionActive: false,
        isComposing: false,
        nativeEvent: { isComposing: false },
      }),
    ).toBe(false);
  });
});
