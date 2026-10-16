// @vitest-environment jsdom

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { UserInputRow } from "@zcode/shared/zcode-protocol-v4";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ConversationRowView } from "@/v4/ConversationRowView.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";

// docs/dynamic-workflow/transcript-and-notifications.md：子代理 transcript 里的 ask 消息 = 指令正文 +
// 引擎尾注；行上的 epilogueStart 说边界在哪。正文照常画，尾注折进默认收起的披露。

const context: ConversationRowRenderContext = {
  codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
  sessionId: "session-1",
  theme: "system",
  workspacePath: "/workspace",
};

const ASK = "Summarize the repo";
const EPILOGUE = "\n\n---\nStandard for this result:\n- Every finding cites what you read.";
const NUDGE = "You ended your turn without submitting a result.";

function userInputRow(overrides: Partial<UserInputRow> = {}): UserInputRow {
  return {
    rowId: 7,
    entityId: "message-user-7",
    turnId: "turn-1",
    createdAt: 1_700_000_000_000,
    createdAtSeq: 1,
    kind: "userInput",
    origin: "realUser",
    text: `${ASK}${EPILOGUE}`,
    ...overrides,
  };
}

function element(row: UserInputRow, locale: "en-US" | "zh-CN" = "en-US") {
  // 用户行的 MessageActions 挂着 Tooltip，需要 provider 在场（与真实宿主一致）。
  return createElement(
    ZCodeIntlProvider,
    { initialLocale: locale },
    createElement(TooltipProvider, null, createElement(ConversationRowView, { context, row })),
  );
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ConversationRowView userInput epilogue fold", () => {
  it("shows only the ask as the message and folds the epilogue closed by default", () => {
    const html = renderToStaticMarkup(element(userInputRow({ epilogueStart: ASK.length })));
    expect(html).toContain('data-v4-user-input-epilogue="true"');
    expect(html).toContain(ASK);
    expect(html).not.toContain("Standard for this result");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Workflow engine instructions");
  });

  it("opens the fold on click and hides the leading rule of the appended text", () => {
    const { container, getByRole } = render(element(userInputRow({ epilogueStart: ASK.length })));
    fireEvent.click(getByRole("button", { name: "Workflow engine instructions" }));
    const body = container.querySelector('[data-v4-user-input-epilogue-body="true"]');
    expect(body?.textContent).toContain("Standard for this result:");
    expect(body?.textContent?.startsWith("---")).toBe(false);
    expect(
      getByRole("button", { name: "Workflow engine instructions" }).getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("renders a bubble holding only the fold when the whole message is engine text (nudge)", () => {
    const html = renderToStaticMarkup(element(userInputRow({ text: NUDGE, epilogueStart: 0 })));
    expect(html).toContain('data-v4-user-input-bubble="true"');
    expect(html).toContain('data-v4-user-input-epilogue="true"');
    expect(html).not.toContain(NUDGE);
  });

  it("treats an out-of-range boundary as no epilogue and leaves rows without one untouched", () => {
    const outOfRange = renderToStaticMarkup(
      element(userInputRow({ epilogueStart: ASK.length + EPILOGUE.length + 5 })),
    );
    expect(outOfRange).not.toContain('data-v4-user-input-epilogue="true"');
    expect(outOfRange).toContain("Standard for this result:");

    const plain = renderToStaticMarkup(element(userInputRow()));
    expect(plain).not.toContain('data-v4-user-input-epilogue="true"');
    expect(plain).toContain("Standard for this result:");
  });

  it("localizes the fold label", () => {
    const html = renderToStaticMarkup(
      element(userInputRow({ epilogueStart: ASK.length }), "zh-CN"),
    );
    expect(html).toContain("工作流引擎附加说明");
  });
});
