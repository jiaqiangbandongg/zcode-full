import { createElement, forwardRef, type ForwardedRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("radix-ui", () => ({
  Select: {
    Item: forwardRef(function MockItem(
      {
        children,
        className,
      }: {
        children: unknown;
        className?: string;
      },
      ref: ForwardedRef<HTMLDivElement>,
    ) {
      return createElement(
        "div",
        {
          ref,
          className,
        },
        children,
      );
    }),
    ItemIndicator: ({ children }: { children: unknown }) =>
      createElement("span", { "data-testid": "item-indicator" }, children),
    ItemText: ({ children }: { children: unknown }) =>
      createElement("span", { "data-testid": "item-text" }, children),
  },
}));

import { SelectItem } from "@/components/ui/select.js";

describe("SelectItem layout", () => {
  it("默认样式不引入全局右侧额外留白，避免影响其它下拉布局", () => {
    const html = renderToStaticMarkup(
      createElement(SelectItem, { value: "full-access" }, "全权限模式（无需确认）"),
    );

    expect(html).toContain("px-2");
    expect(html).not.toContain("pr-8");
  });
});
