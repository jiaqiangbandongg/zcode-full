import { describe, expect, it, vi } from "vitest";
import type { IPlatformService, WindowScreenshotResult } from "@zcode/shared";
import { captureFeedbackScreenshotDraft } from "@/feedback/feedbackScreenshotDraft.js";

const screenshot: WindowScreenshotResult = {
  dataBase64: "base64-image",
  filename: "zcode-error-2026-06-17.png",
  contentType: "image/png",
  size: 12,
};

describe("captureFeedbackScreenshotDraft", () => {
  it("returns a feedback attachment draft when platform screenshot succeeds", async () => {
    const platform = {
      captureWindowScreenshot: vi.fn(async () => screenshot),
    } as Pick<IPlatformService, "captureWindowScreenshot">;

    await expect(captureFeedbackScreenshotDraft(platform)).resolves.toEqual([
      screenshot,
    ]);
    expect(platform.captureWindowScreenshot).toHaveBeenCalledTimes(1);
  });

  it("returns an empty draft when platform screenshot is unavailable", async () => {
    const platform = {} as Pick<IPlatformService, "captureWindowScreenshot">;

    await expect(captureFeedbackScreenshotDraft(platform)).resolves.toEqual([]);
  });

  it("returns an empty draft when platform screenshot fails", async () => {
    const platform = {
      captureWindowScreenshot: vi.fn(async () => {
        throw new Error("capture failed");
      }),
    } as Pick<IPlatformService, "captureWindowScreenshot">;

    await expect(captureFeedbackScreenshotDraft(platform)).resolves.toEqual([]);
  });
});
