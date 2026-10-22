// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodingPlanQuotaResetStatusContent } from "@/components/coding-plan-quota-reset/CodingPlanQuotaResetStatus.js";
import { burstCodingPlanQuotaResetConfetti } from "@/lib/codingPlanQuotaResetConfetti.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "zh-CN",
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, string>) => {
        const messages: Record<string, string> = {
          "codingPlan.quotaReset.processing": "正在重置 5 小时额度…",
          "codingPlan.quotaReset.done": "5 小时额度已重置",
          "codingPlan.quotaReset.completed": "已重置",
          "codingPlan.quotaReset.completedAt": `${values?.time ?? ""} 已重置`,
        };
        return messages[id] ?? id;
      },
    },
  }),
}));

afterEach(() => {
  cleanup();
});

describe("CodingPlanQuotaResetStatusContent", () => {
  it("processing 渲染状态提示文案", () => {
    render(createElement(CodingPlanQuotaResetStatusContent, { status: "processing" }));

    expect(screen.getByRole("status").textContent).toContain("正在重置 5 小时额度…");
  });

  it("completed 渲染已重置状态文案", () => {
    render(createElement(CodingPlanQuotaResetStatusContent, { status: "completed" }));

    const status = screen.getByRole("status");
    expect(status.textContent).toContain("5 小时额度已重置");
  });
});

describe("burstCodingPlanQuotaResetConfetti", () => {
  let originalAnimate: typeof Element.prototype.animate;

  beforeEach(() => {
    originalAnimate = Element.prototype.animate;
    Element.prototype.animate = vi.fn().mockReturnValue({
      finished: Promise.resolve(),
    }) as unknown as typeof Element.prototype.animate;
  });

  afterEach(() => {
    Element.prototype.animate = originalAnimate;
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("prefers-reduced-motion 时不撒花", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    const origin = document.createElement("div");

    burstCodingPlanQuotaResetConfetti(origin);

    expect(document.body.childElementCount).toBe(0);
    expect(Element.prototype.animate).not.toHaveBeenCalled();
  });

  it("允许动效时从触发器播放粒子", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    const origin = document.createElement("div");

    burstCodingPlanQuotaResetConfetti(origin);

    expect(document.body.childElementCount).toBeGreaterThan(0);
    expect(Element.prototype.animate).toHaveBeenCalled();
  });
});
