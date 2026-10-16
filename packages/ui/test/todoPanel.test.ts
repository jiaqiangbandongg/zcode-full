import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { TodoPanel } from "../src/TodoPanel.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

function renderWithTooltipProvider(element: ReactElement) {
  return renderToStaticMarkup(createElement(TooltipProvider, null, element));
}

describe("TodoPanel", () => {
  it("hides the todo panel after every step is completed", () => {
    const html = renderWithTooltipProvider(
      createElement(TodoPanel, {
        isStreaming: true,
        plan: [
          { id: "step-1", status: "completed", title: "分析问题" },
          { id: "step-2", status: "completed", title: "修复问题" },
        ],
      }),
    );

    expect(html).toBe("");
  });

  it("does not render completed items in the expanded todo list", () => {
    const html = renderWithTooltipProvider(
      createElement(TodoPanel, {
        isStreaming: false,
        plan: [
          { id: "step-1", status: "completed", title: "已经完成的事项" },
          { id: "step-2", status: "pending", title: "还要处理的事项" },
        ],
      }),
    );

    expect(html).not.toContain("已经完成的事项");
    expect(html).toContain("还要处理的事项");
  });

  it("keeps collapsed todo layout bounded on narrow remote-control viewports", () => {
    const html = renderWithTooltipProvider(
      createElement(TodoPanel, {
        isStreaming: true,
        plan: [
          {
            id: "step-1",
            status: "in_progress",
            title:
              "这是一个很长的待办标题，用来模拟手机远程控制窄屏里当前任务标题把右侧按钮挤出容器的问题",
          },
          {
            id: "step-2",
            status: "pending",
            title: "下一步",
          },
        ],
      }),
    );

    expect(html).toContain("min-w-0 flex-1");
    expect(html).toContain("truncate");
    expect(html).toContain("shrink-0");
    expect(html).toMatch(
      /<button[^>]*aria-expanded="false"[^>]*class="[^"]*\binline-flex\b[^"]*\bmax-w-full\b/,
    );
    expect(html).not.toContain('data-slot="plan-header" role="button"');
    expect(html).not.toContain("cursor-pointer items-center gap-3 px-4");
  });
});
