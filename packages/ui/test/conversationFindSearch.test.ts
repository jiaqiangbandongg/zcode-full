import { describe, expect, it } from "vitest";
import {
  getConversationFindState,
  moveConversationFindSelection,
  resolveConversationFindNavigationSelection,
  resolveConversationFindNavigationDirection,
} from "@/quickpick/conversationFindSearch.js";

describe("conversationFindSearch", () => {
  it("resets to the first result when active index is outside the current matches", () => {
    expect(getConversationFindState(3, 7)).toEqual({ currentIndex: 0, total: 3 });
    expect(getConversationFindState(0, 7)).toEqual({ currentIndex: -1, total: 0 });
  });

  it("wraps result navigation", () => {
    expect(moveConversationFindSelection({ currentIndex: 2, total: 3 }, "next")).toBe(0);
    expect(moveConversationFindSelection({ currentIndex: 0, total: 3 }, "previous")).toBe(2);
    expect(moveConversationFindSelection({ currentIndex: -1, total: 0 }, "next")).toBe(-1);
  });

  it("maps buttons and Enter shortcuts to the same navigation directions", () => {
    expect(resolveConversationFindNavigationDirection("ArrowUp", false)).toBe("previous");
    expect(resolveConversationFindNavigationDirection("ArrowDown", false)).toBe("next");
    expect(resolveConversationFindNavigationDirection("Enter", false)).toBe("next");
    expect(resolveConversationFindNavigationDirection("Enter", true)).toBe("previous");
  });

  it("resolves the same selection when one match wraps", () => {
    expect(
      resolveConversationFindNavigationSelection("needle", { currentIndex: 0, total: 1 }, "next"),
    ).toEqual({ activeIndex: 0, query: "needle" });
    expect(
      resolveConversationFindNavigationSelection(
        "needle",
        { currentIndex: 0, total: 1 },
        "previous",
      ),
    ).toEqual({ activeIndex: 0, query: "needle" });
  });
});
