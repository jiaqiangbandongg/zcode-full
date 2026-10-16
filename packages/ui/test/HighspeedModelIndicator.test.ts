// @vitest-environment jsdom

import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HighspeedModelIndicator } from "@/highspeed/HighspeedModelIndicator.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

afterEach(cleanup);

function renderIndicator(sweepActive = false, animateEntrance = true) {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(
        TooltipProvider,
        null,
        createElement(HighspeedModelIndicator, {
          model: "GLM-5.3",
          originalModel: "GLM-5.2",
          sweepActive,
          animateEntrance,
        }),
      ),
    ),
  );
}

/** 翻页动效挂在图标与文字外层的 motion 容器上。 */
function readFlipContainerOpacity(container: HTMLElement): string | undefined {
  const flip = container.querySelector('[data-highspeed-model-icon="true"]')?.parentElement;
  return flip?.style.opacity;
}

describe("HighspeedModelIndicator", () => {
  it("renders the draw model as a read-only Highspeed identity", () => {
    const { container, getByLabelText } = renderIndicator();
    const modelIcon = container.querySelector('[data-highspeed-model-icon="true"]');

    expect(getByLabelText("GLM-5.3 HighSpeed")).toBeTruthy();
    expect(container.textContent).toContain("GLM-5.3 HighSpeed");
    expect(modelIcon?.tagName).toBe("IMG");
    expect(decodeURIComponent(modelIcon?.getAttribute("src") ?? "")).toContain("stroke='#A888F2'");
    expect(getByLabelText("GLM-5.3 HighSpeed").className).toContain("@max-xl/composer:size-7");
    expect(container.querySelector(".highspeed-model-trigger-label-sweep")?.className).toContain(
      "@xl/composer:inline-flex",
    );
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector('[data-chat-toolbar-popover-trigger="true"]')).toBeNull();
  });

  it("在 hover 时展示加速前的原模型", async () => {
    renderIndicator();

    fireEvent.pointerMove(screen.getByLabelText("GLM-5.3 HighSpeed"), {
      pointerType: "mouse",
    });

    expect((await screen.findAllByText("原模型：GLM-5.2")).length).toBeGreaterThan(0);
    expect(screen.queryByText(/剩余时间/)).toBeNull();
  });

  it("draw 新命中从翻页起点入场；切回或恢复时直接呈现静止标识", () => {
    const activation = renderIndicator(false, true);
    expect(readFlipContainerOpacity(activation.container)).toBe("0");
    activation.unmount();

    const restore = renderIndicator(false, false);
    expect(readFlipContainerOpacity(restore.container)).toBe("1");
  });

  it("activates the one-shot label sweep without adding interaction", () => {
    const { container } = renderIndicator(true);

    expect(
      container.querySelector(".highspeed-model-trigger-label-sweep.is-sweep-active"),
    ).not.toBeNull();
    expect(container.querySelector("button")).toBeNull();
  });
});
