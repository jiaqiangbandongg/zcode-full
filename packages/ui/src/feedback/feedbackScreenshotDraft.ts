import type { IPlatformService } from "@zcode/shared";
import type { FeedbackAttachmentDraft } from "@/feedback/feedbackStore.js";

export async function captureFeedbackScreenshotDraft(
  platform: Pick<IPlatformService, "captureWindowScreenshot">,
): Promise<FeedbackAttachmentDraft[]> {
  const screenshot = await platform.captureWindowScreenshot?.().catch(() => null);
  return screenshot ? [screenshot] : [];
}
