// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmbeddedBrowserWebviewChannels } from "@zcode/shared";
import { installEmbeddedBrowserWheelForwarding } from "../src/preload/embeddedBrowserWheel.js";

function setScrollGeometry(
  element: HTMLElement,
  geometry: {
    clientHeight?: number;
    clientWidth?: number;
    scrollHeight?: number;
    scrollLeft?: number;
    scrollTop?: number;
    scrollWidth?: number;
  },
): void {
  for (const [property, value] of Object.entries(geometry)) {
    Object.defineProperty(element, property, {
      configurable: true,
      value,
      writable: property === "scrollLeft" || property === "scrollTop",
    });
  }
}

function dispatchWheel(
  target: HTMLElement,
  init: WheelEventInit,
): { event: WheelEvent; settled: Promise<void> } {
  const event = new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    composed: true,
    ...init,
  });
  target.dispatchEvent(event);
  return { event, settled: Promise.resolve() };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("embedded browser wheel forwarding", () => {
  it("guest 没有滚动容器时把二维 pixel delta 转交宿主", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    const sendToHost = vi.fn();
    const dispose = installEmbeddedBrowserWheelForwarding(window, sendToHost);

    await dispatchWheel(target, { deltaX: 120, deltaY: 80 }).settled;

    expect(sendToHost).toHaveBeenCalledWith(EmbeddedBrowserWebviewChannels.WheelBoundary, {
      deltaX: 120,
      deltaY: 80,
    });
    dispose();
  });

  it("guest 内层或祖先还能消费对应方向滚动时不转交该轴", async () => {
    const outer = document.createElement("div");
    const inner = document.createElement("div");
    outer.style.overflowX = "auto";
    inner.style.overflowY = "auto";
    outer.append(inner);
    document.body.append(outer);
    setScrollGeometry(outer, {
      clientWidth: 100,
      scrollLeft: 0,
      scrollWidth: 300,
    });
    setScrollGeometry(inner, {
      clientHeight: 100,
      scrollHeight: 300,
      scrollTop: 40,
    });
    const sendToHost = vi.fn();
    const dispose = installEmbeddedBrowserWheelForwarding(window, sendToHost);

    await dispatchWheel(inner, { deltaX: 80, deltaY: 80 }).settled;

    expect(sendToHost).not.toHaveBeenCalled();
    dispose();
  });

  it("guest 对应轴到达边界后继续转交宿主", async () => {
    const target = document.createElement("div");
    target.style.overflow = "auto";
    document.body.append(target);
    setScrollGeometry(target, {
      clientHeight: 100,
      clientWidth: 100,
      scrollHeight: 300,
      scrollLeft: 200,
      scrollTop: 200,
      scrollWidth: 300,
    });
    const sendToHost = vi.fn();
    const dispose = installEmbeddedBrowserWheelForwarding(window, sendToHost);

    await dispatchWheel(target, { deltaX: 80, deltaY: 90 }).settled;

    expect(sendToHost).toHaveBeenCalledWith(EmbeddedBrowserWebviewChannels.WheelBoundary, {
      deltaX: 80,
      deltaY: 90,
    });
    dispose();
  });

  it("纵向滚动按方向判断边界", async () => {
    const target = document.createElement("div");
    target.style.overflowY = "auto";
    document.body.append(target);
    setScrollGeometry(target, {
      clientHeight: 100,
      scrollHeight: 300,
      scrollTop: 0,
    });
    const sendToHost = vi.fn();
    const dispose = installEmbeddedBrowserWheelForwarding(window, sendToHost);

    await dispatchWheel(target, { deltaY: 80 }).settled;
    expect(sendToHost).not.toHaveBeenCalled();

    await dispatchWheel(target, { deltaY: -80 }).settled;
    expect(sendToHost).toHaveBeenCalledWith(EmbeddedBrowserWebviewChannels.WheelBoundary, {
      deltaX: 0,
      deltaY: -80,
    });
    dispose();
  });

  it("尊重网页 preventDefault，并归一化 line 与 Shift+滚轮", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    const sendToHost = vi.fn();
    const dispose = installEmbeddedBrowserWheelForwarding(window, sendToHost);

    target.addEventListener("wheel", (event) => event.preventDefault(), { once: true });
    await dispatchWheel(target, { deltaY: 90 }).settled;
    await dispatchWheel(target, { deltaMode: 1, deltaY: 3, shiftKey: true }).settled;
    await dispatchWheel(target, { deltaMode: 1, deltaY: 2 }).settled;

    expect(sendToHost).toHaveBeenCalledTimes(2);
    expect(sendToHost).toHaveBeenNthCalledWith(1, EmbeddedBrowserWebviewChannels.WheelBoundary, {
      deltaX: 120,
      deltaY: 0,
    });
    expect(sendToHost).toHaveBeenNthCalledWith(2, EmbeddedBrowserWebviewChannels.WheelBoundary, {
      deltaX: 0,
      deltaY: 80,
    });
    dispose();
  });
});
