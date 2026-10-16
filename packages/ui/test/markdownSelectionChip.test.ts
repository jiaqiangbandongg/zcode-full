// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ConversationSelectionReferenceChip } from "@/v4/composer/ConversationSelectionReferenceChip.js";
import {
  parsePromptConversationSelections,
  buildPromptWithConversationSelections,
} from "@/lib/conversationSelectionReference.js";

afterEach(cleanup);
it.each(["/workspace/docs/a.md", "C:\\docs\\a.md"])(
  "历史引用显示文件名和完整路径：%s",
  async (path) => {
    const { references } = parsePromptConversationSelections(
      buildPromptWithConversationSelections("Explain", [{ path, text: "excerpt" }]),
    );
    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ConversationSelectionReferenceChip, { references }),
      ),
    );
    const chip = screen.getByRole("button", { name: "a.md · 引用" });
    fireEvent.pointerEnter(chip);
    expect(await screen.findByText(path)).toBeTruthy();
    expect(await screen.findByText("excerpt")).toBeTruthy();
  },
);
it("混合引用使用通用计数", () => {
  render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(ConversationSelectionReferenceChip, {
        references: [{ path: "a.md", text: "file" }, { text: "message" }],
      }),
    ),
  );
  expect(screen.getByRole("button", { name: "2 selections" })).toBeTruthy();
});
