import { describe, expect, it } from "vitest";
import {
  clampPresentationPageNumber,
  clampPresentationZoomPercent,
} from "@/presentation/presentationPreviewControls.js";

describe("presentation preview controls", () => {
  it("clamps page numbers to the available slide range", () => {
    expect(clampPresentationPageNumber(-2, 8)).toBe(1);
    expect(clampPresentationPageNumber(3.6, 8)).toBe(4);
    expect(clampPresentationPageNumber(99, 8)).toBe(8);
    expect(clampPresentationPageNumber(Number.NaN, 8)).toBe(1);
  });

  it("clamps zoom to the supported range", () => {
    expect(clampPresentationZoomPercent(1)).toBe(25);
    expect(clampPresentationZoomPercent(137.7)).toBe(138);
    expect(clampPresentationZoomPercent(999)).toBe(300);
    expect(clampPresentationZoomPercent(Number.NaN)).toBe(100);
  });
});
