import { describe, expect, it } from "vitest";
import { sandboxCaptureSchema, scaleCaptureRect } from "./capture.js";

describe("sandbox image capture", () => {
  const request = {
    sandboxId: "page",
    initId: 1,
    viewportSize: { width: 400, height: 300 },
    captureRect: { x: 5, y: 5, width: 390, height: 290 },
  };
  it("rejects non-finite, oversized and out-of-viewport rectangles", () => {
    expect(sandboxCaptureSchema.safeParse(request).success).toBe(true);
    for (const width of [Infinity, NaN, 0, -1, 401])
      expect(
        sandboxCaptureSchema.safeParse({
          ...request,
          captureRect: { ...request.captureRect, width },
        }).success,
      ).toBe(false);
    expect(sandboxCaptureSchema.safeParse({ ...request, initId: -1 }).success).toBe(false);
  });
  it("crops content at native image scale, excluding paint gutters", () => {
    expect(scaleCaptureRect(request, { width: 800, height: 600 })).toEqual({
      x: 10,
      y: 10,
      width: 780,
      height: 580,
    });
    expect(() => scaleCaptureRect(request, { width: 0, height: 0 })).toThrow();
  });
});
