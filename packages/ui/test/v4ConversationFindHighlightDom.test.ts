import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVE_FIND_HIGHLIGHT_NAME,
  FIND_HIGHLIGHT_NAME,
  SEARCH_RESULT_HIGHLIGHT_NAME,
  clearConversationFindHighlights,
  clearSearchResultHighlight,
} from "@/v4/conversationFindHighlightDom.js";

describe("conversationFindHighlightDom", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("clears both persistent find layers and the temporary command-center layer", () => {
    const deleted: string[] = [];
    vi.stubGlobal("window", { Highlight: class TestHighlight {} });
    vi.stubGlobal("CSS", {
      highlights: {
        set: vi.fn(),
        delete: (name: string) => deleted.push(name),
      },
    });

    clearConversationFindHighlights();
    clearSearchResultHighlight();

    expect(deleted).toEqual([
      FIND_HIGHLIGHT_NAME,
      ACTIVE_FIND_HIGHLIGHT_NAME,
      SEARCH_RESULT_HIGHLIGHT_NAME,
    ]);
  });

  it("is a no-op when CSS Highlight API is unavailable", () => {
    expect(() => {
      clearConversationFindHighlights();
      clearSearchResultHighlight();
    }).not.toThrow();
  });
});
