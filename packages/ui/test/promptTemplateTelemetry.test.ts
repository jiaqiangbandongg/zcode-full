import { describe, expect, it } from "vitest";
import {
  buildPromptTemplateClickTelemetryPayload,
  PROMPT_TEMPLATE_CLICK_EVENT_NAME,
} from "@/lib/promptTemplateTelemetry.js";

describe("prompt template click telemetry", () => {
  it("builds the shared click payload with a stable template id and full localized prompt", () => {
    expect(
      buildPromptTemplateClickTelemetryPayload({
        templateId: "weekly-summary",
        templateName: "周报总结",
        templatePrompt: "请总结最近一周的工作进展。",
      }),
    ).toEqual({
      elementName: PROMPT_TEMPLATE_CLICK_EVENT_NAME,
      eventRegion: "app.session",
      eventType: "ck",
      eventText: "周报总结",
      eventExtraDetail: {
        template_id: "weekly-summary",
        template_prompt: "请总结最近一周的工作进展。",
      },
    });
  });
});
