// @vitest-environment jsdom

import { createElement } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HighspeedComposerBackground } from "@/highspeed/HighspeedActivationVisual.js";

vi.mock("@/v4/highspeed/HighSpeedDiffusionCanvas.js", async () => {
  const React = await import("react");
  return {
    HighSpeedDiffusionCanvas: ({ onHandoffStart }: { onHandoffStart: () => void }) => {
      React.useEffect(() => onHandoffStart(), [onHandoffStart]);
      return React.createElement("canvas", { "data-testid": "mock-diffusion-canvas" });
    },
  };
});

vi.mock("@/components/ui/floating-particles.js", async () => {
  const React = await import("react");
  return {
    FloatingParticles: ({ settled }: { settled?: boolean }) =>
      React.createElement("div", {
        "data-testid": "mock-particles",
        "data-settled": String(Boolean(settled)),
      }),
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("HighspeedComposerBackground", () => {
  it("transitionend 丢失时仍会从 handoff 收敛到 stable", async () => {
    vi.useFakeTimers();
    const { getByTestId } = render(
      createElement(HighspeedComposerBackground, {
        animated: true,
        onModelTransitionStart: vi.fn(),
      }),
    );

    expect(getByTestId("highspeed-composer-background").getAttribute("data-phase")).toBe("handoff");
    expect(getByTestId("mock-particles").getAttribute("data-settled")).toBe("false");

    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });

    expect(getByTestId("highspeed-composer-background").getAttribute("data-phase")).toBe("stable");
  });

  it("恢复入场直接挂载为 stable：不挂扩散 Canvas、不触发模型翻页，粒子从稳态开始", () => {
    const onModelTransitionStart = vi.fn();
    const { getByTestId, queryByTestId } = render(
      createElement(HighspeedComposerBackground, { animated: false, onModelTransitionStart }),
    );

    expect(getByTestId("highspeed-composer-background").getAttribute("data-phase")).toBe("stable");
    expect(queryByTestId("mock-diffusion-canvas")).toBeNull();
    expect(onModelTransitionStart).not.toHaveBeenCalled();
    expect(getByTestId("mock-particles").getAttribute("data-settled")).toBe("true");
  });
});
