import { describe, expect, it } from "vitest";
import {
  changeTaskFindSelection,
  createTaskFindNavigationState,
  navigateTaskFindSelection,
} from "@/quickpick/taskFindNavigationState.js";

describe("taskFindNavigationState", () => {
  it("increments the request id for consecutive navigation to the same index", () => {
    const initial = createTaskFindNavigationState();
    const first = navigateTaskFindSelection(initial, "needle", 0);
    const second = navigateTaskFindSelection(first, "needle", 0);

    expect(first).toEqual({
      activeIndex: 0,
      navigationRequestId: 1,
      query: "needle",
    });
    expect(second).toEqual({
      activeIndex: 0,
      navigationRequestId: 2,
      query: "needle",
    });
  });

  it("preserves the request id for ordinary query and selection changes", () => {
    const navigated = navigateTaskFindSelection(
      createTaskFindNavigationState(),
      "needle",
      0,
    );

    expect(changeTaskFindSelection(navigated, "other", 2)).toEqual({
      activeIndex: 2,
      navigationRequestId: 1,
      query: "other",
    });
  });
});
