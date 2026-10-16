// 回归：v4 及通用组件中的硬编码中文/英文文案必须跟随 locale（i18n）。
// 覆盖 ConversationGoalBanner「目标」、code-block「Wrap lines/Copy code」、Spinner「Loading」。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { GoalState } from "@zcode/shared/zcode-protocol-v4";
import {
  CodeBlockCopyButton,
  CodeBlockWrapButton,
} from "@/components/ai-elements/code-block.js";
import { Spinner } from "@/components/ui/spinner.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ConversationGoalBanner } from "@/v4/ConversationGoalBanner.js";

const labels: Record<string, string> = {
  "chat.goalBanner.label": "Goal",
  "codeBlock.wrapLines": "Wrap lines",
  "codeBlock.copyCode": "Copy code",
  "common.loading": "Loading...",
};

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: (descriptor: { id: string }) => labels[descriptor.id] ?? descriptor.id,
    },
    locale: "en-US",
  }),
}));

function goal(overrides: Partial<GoalState> = {}): GoalState {
  return {
    status: "active",
    objective: "修好状态面板",
    iteration: 1,
    ...overrides,
  };
}

describe("硬编码文案 i18n 回归", () => {
  it("ConversationGoalBanner 的「目标」标签走 i18n", () => {
    const html = renderToStaticMarkup(
      createElement(ConversationGoalBanner, { goal: goal() }),
    );
    expect(html).toContain(">Goal<");
    expect(html).not.toContain("目标");
  });

  it("CodeBlockWrapButton / CodeBlockCopyButton 默认文案走 i18n", () => {
    const wrap = renderToStaticMarkup(
      createElement(TooltipProvider, null, createElement(CodeBlockWrapButton)),
    );
    expect(wrap).toContain('aria-label="Wrap lines"');
    const copy = renderToStaticMarkup(
      createElement(TooltipProvider, null, createElement(CodeBlockCopyButton)),
    );
    expect(copy).toContain('aria-label="Copy code"');
  });

  it("Spinner 的 aria-label 走 i18n", () => {
    const html = renderToStaticMarkup(createElement(Spinner));
    expect(html).toContain('aria-label="Loading..."');
    expect(html).not.toContain('aria-label="Loading"');
  });
});
