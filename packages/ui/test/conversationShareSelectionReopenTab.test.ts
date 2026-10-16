// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConversationShareSelectionReopenTab } from "@/v4/ConversationShareSelectionReopenTab.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: { formatMessage: ({ id }: { id: string }) => id },
  }),
}));

afterEach(() => cleanup());

describe("ConversationShareSelectionReopenTab", () => {
  it("renders an accessible left navigation action and reopens the panel", () => {
    const onOpen = vi.fn();
    render(createElement(ConversationShareSelectionReopenTab, { onOpen }));

    const button = screen.getByRole("button", {
      name: "conversationShare.selection.reopen",
    });
    expect(button.getAttribute("data-conversation-share-left-navigation")).toBe("true");
    expect(button.getAttribute("data-testid")).toBe("conversation-share-selection-reopen");
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
