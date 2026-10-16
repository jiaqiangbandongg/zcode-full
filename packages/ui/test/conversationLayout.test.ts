import { describe, expect, it } from "vitest";
import {
  CONVERSATION_DRAFT_CONTENT_WIDTH_CLASS_NAME,
  CONVERSATION_CONTENT_WITHOUT_STATUS_PANEL_WIDTH_CLASS_NAME,
  CONVERSATION_CONTENT_WITH_STATUS_PANEL_WIDTH_CLASS_NAME,
  getConversationContentWidthClassName,
} from "@/v4/conversationLayout.js";

describe("conversationLayout content width", () => {
  it("keeps a true draft on the compact width", () => {
    expect(
      getConversationContentWidthClassName({
        centeredEmptyLayout: true,
        statusPanelLayout: "none",
      }),
    ).toBe(CONVERSATION_DRAFT_CONTENT_WIDTH_CLASS_NAME);
  });

  it("uses 1280px as the wide breakpoint when the status panel reserves space", () => {
    expect(
      getConversationContentWidthClassName({
        centeredEmptyLayout: false,
        statusPanelLayout: "auto",
      }),
    ).toBe(CONVERSATION_CONTENT_WITH_STATUS_PANEL_WIDTH_CLASS_NAME);
    expect(CONVERSATION_CONTENT_WITH_STATUS_PANEL_WIDTH_CLASS_NAME).toBe(
      "w-full @min-[864px]/conversation:w-[calc(100%_-_6rem)] @min-[864px]/conversation:max-w-4xl @min-[1280px]/conversation:w-[calc(100%_-_24rem)] @min-[1280px]/conversation:max-w-6xl",
    );
  });

  it("delays the wide width to 1280px when the status panel is collapsed or absent", () => {
    expect(
      getConversationContentWidthClassName({
        centeredEmptyLayout: false,
        statusPanelLayout: "none",
      }),
    ).toBe(CONVERSATION_CONTENT_WITHOUT_STATUS_PANEL_WIDTH_CLASS_NAME);
    expect(CONVERSATION_CONTENT_WITHOUT_STATUS_PANEL_WIDTH_CLASS_NAME).toBe(
      "w-full @min-[864px]/conversation:w-[calc(100%_-_6rem)] @min-[864px]/conversation:max-w-4xl @min-[1280px]/conversation:w-[calc(100%_-_24rem)] @min-[1280px]/conversation:max-w-6xl",
    );
  });
});
