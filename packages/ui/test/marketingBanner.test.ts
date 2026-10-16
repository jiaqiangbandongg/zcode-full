// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarketingBannerView } from "@/components/marketing-touch/MarketingBanner.js";
import { CLOUD_HERO_MESSAGE_CHANNEL } from "@/components/cloud-content-dialog/CloudDialogHero.js";
import type { CloudDialogHero } from "@/components/cloud-content-dialog/cloudContentDialogTypes.js";
afterEach(cleanup);
describe("marketing image banner", () => {
  const bundle: Extract<CloudDialogHero, { type: "interactive_bundle" }> = {
    type: "interactive_bundle",
    runtime: "zcode-hero-sandbox-v1",
    resolvedUrl: "http://localhost/banner/index.html",
    viewport: { aspectRatio: "4:3" },
    data: { heading: "Weekend" },
    events: { claim: "claim" },
  };
  const bundleProps = {
    bundle,
    locale: "en-US",
    hasAction: true,
    hasClose: true,
    actionLabel: "Claim",
    closeLabel: "Close",
    pendingLabel: "Working",
    pending: false,
    onClick: vi.fn(),
    onClose: vi.fn(),
  };
  it("renders background video without controls and preserves action and fallback", () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    const onClick = vi.fn();
    const { container, unmount } = render(
      createElement(MarketingBannerView, {
        ...bundleProps,
        bundle: undefined,
        onClick,
        video: {
          type: "video",
          src: "blob:video",
          poster: "blob:poster",
          autoplay: true,
          loop: true,
        },
      }),
    );
    const video = container.querySelector("video")!;
    expect(video.controls).toBe(false);
    expect(video.muted).toBe(true);
    expect(video.loop).toBe(true);
    expect(video.tabIndex).toBe(-1);
    fireEvent.click(screen.getByRole("button", { name: "Claim" }));
    expect(onClick).toHaveBeenCalledTimes(1);
    fireEvent.error(video);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:poster");
    unmount();
    expect(pause).toHaveBeenCalled();
    play.mockRestore();
    pause.mockRestore();
  });
  function message(frame: HTMLIFrameElement, type: string, instanceId = frame.dataset.instanceId) {
    act(() =>
      window.dispatchEvent(
        new MessageEvent("message", {
          source: frame.contentWindow,
          data: {
            channel: CLOUD_HERO_MESSAGE_CHANNEL,
            instanceId,
            type,
            id: "claim",
            code: "failed",
          },
        }),
      ),
    );
  }
  it("shows only after trusted ready, ignores bundle actions and keeps host controls", () => {
    const { rerender } = render(createElement(MarketingBannerView, bundleProps));
    const frame = screen.getByTitle("Claim") as HTMLIFrameElement;
    expect(screen.getByTestId("marketing-banner").style.height).toBe("0px");
    expect(frame.tabIndex).toBe(-1);
    expect(frame.classList.contains("bg-transparent")).toBe(true);
    message(frame, "ready", "stale");
    expect(screen.getByTestId("marketing-banner").style.height).toBe("0px");
    message(frame, "ready");
    expect(screen.getByTestId("marketing-banner").style.height).toBe("");
    message(frame, "action");
    expect(bundleProps.onClick).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Claim" }));
    expect(bundleProps.onClick).toHaveBeenCalledTimes(1);
    rerender(createElement(MarketingBannerView, { ...bundleProps, pending: true }));
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByTitle("Claim")).toBe(frame);
    rerender(
      createElement(MarketingBannerView, {
        ...bundleProps,
        bundle: { ...bundle, resolvedUrl: "http://localhost/new/index.html" },
      }),
    );
    expect(screen.getByTestId("marketing-banner").style.height).toBe("0px");
  });
  it("bridges hover only after ready and clears it for pending, touch, blur and hidden", () => {
    const { rerender } = render(createElement(MarketingBannerView, bundleProps));
    const frame = screen.getByTitle("Claim") as HTMLIFrameElement;
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    const host = screen.getByTestId("marketing-banner");
    const enter = (pointerType: string) => {
      const event = new MouseEvent("pointerover", { bubbles: true });
      Object.defineProperty(event, "pointerType", { value: pointerType });
      fireEvent(host, event);
    };
    const lastHover = () => post.mock.calls.filter(([m]) => m.type === "hover").at(-1)?.[0];
    enter("mouse");
    expect(lastHover()).toBeUndefined();
    message(frame, "ready");
    enter("mouse");
    expect(lastHover()).toMatchObject({
      type: "hover",
      hovered: true,
      instanceId: frame.dataset.instanceId,
    });
    fireEvent.pointerOut(host);
    expect(lastHover()).toMatchObject({ hovered: false });
    enter("touch");
    expect(lastHover()).toMatchObject({ hovered: false });
    enter("mouse");
    rerender(createElement(MarketingBannerView, { ...bundleProps, pending: true }));
    expect(lastHover()).toMatchObject({ hovered: false });
    rerender(createElement(MarketingBannerView, bundleProps));
    fireEvent(window, new Event("blur"));
    expect(lastHover()).toMatchObject({ hovered: false });
    enter("mouse");
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    fireEvent(document, new Event("visibilitychange"));
    expect(lastHover()).toMatchObject({ hovered: false });
    visibility.mockRestore();
    expect(frame.classList.contains("pointer-events-none")).toBe(true);
  });
  it("suppresses hover while reduced motion is enabled, including live changes", () => {
    const media = Object.assign(new EventTarget(), { matches: false });
    vi.stubGlobal("matchMedia", () => media);
    try {
      render(createElement(MarketingBannerView, bundleProps));
      const frame = screen.getByTitle("Claim") as HTMLIFrameElement;
      const post = vi.spyOn(frame.contentWindow!, "postMessage");
      message(frame, "ready");
      const event = new MouseEvent("pointerover", { bubbles: true });
      Object.defineProperty(event, "pointerType", { value: "mouse" });
      fireEvent(screen.getByTestId("marketing-banner"), event);
      const lastHover = () => post.mock.calls.filter(([m]) => m.type === "hover").at(-1)?.[0];
      expect(lastHover()).toMatchObject({ hovered: true });
      media.matches = true;
      act(() => media.dispatchEvent(new Event("change")));
      expect(lastHover()).toMatchObject({ hovered: false });
      media.matches = false;
      act(() => media.dispatchEvent(new Event("change")));
      expect(lastHover()).toMatchObject({ hovered: true });
    } finally {
      cleanup();
      vi.unstubAllGlobals();
    }
  });
  it.each([true, false])("uses fallback or hides on timeout (fallback=%s)", (fallback) => {
    vi.useFakeTimers();
    try {
      render(
        createElement(MarketingBannerView, {
          ...bundleProps,
          bundle: {
            ...bundle,
            ...(fallback
              ? { fallback: { type: "image", src: "data:image/png;base64,a", alt: "" } as const }
              : {}),
          },
        }),
      );
      act(() => vi.advanceTimersByTime(5001));
      expect(screen.queryByTitle("Claim")).toBeNull();
      expect(screen.getByTestId("marketing-banner").style.height).toBe(fallback ? "" : "0px");
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });
  it.each([true, false])(
    "uses action presence, not empty labels, to render controls (present=%s)",
    (present) => {
      const click = vi.fn();
      const close = vi.fn();
      const { container } = render(
        createElement(MarketingBannerView, {
          src: "data:image/png;base64,a",
          hasAction: present,
          hasClose: present,
          actionLabel: "",
          closeLabel: "",
          pendingLabel: "Working",
          pending: false,
          onClick: click,
          onClose: close,
        }),
      );
      const buttons = container.querySelectorAll("button");
      expect(buttons).toHaveLength(present ? 2 : 1);
      expect(buttons[0]!.disabled).toBe(!present);
      fireEvent.click(buttons[0]!);
      expect(click).toHaveBeenCalledTimes(present ? 1 : 0);
      if (present) {
        fireEvent.click(buttons[1]!);
        expect(close).toHaveBeenCalledTimes(1);
        expect(click).toHaveBeenCalledTimes(1);
      }
    },
  );
  it("replaces close with loading and prevents duplicate actions without changing the image", () => {
    const click = vi.fn();
    const close = vi.fn();
    const props = {
      src: "data:image/png;base64,a",
      hasAction: true,
      hasClose: true,
      actionLabel: "Claim",
      closeLabel: "Close",
      pendingLabel: "Verifying",
      pending: false,
      onClick: click,
      onClose: close,
    };
    const { rerender } = render(createElement(MarketingBannerView, props));
    const imageButton = screen.getByRole("button", { name: "Claim" });
    const closeButton = screen.getByRole("button", { name: "Close" });
    expect(closeButton.classList.contains("bg-card")).toBe(false);
    expect(closeButton.classList.contains("rounded-full")).toBe(true);
    expect(imageButton.classList.contains("border")).toBe(true);
    expect(imageButton.classList.contains("border-border")).toBe(true);
    expect(imageButton.classList.contains("h-24")).toBe(true);
    expect(imageButton.classList.contains("bg-card")).toBe(false);
    expect(imageButton.classList.contains("rounded-xl")).toBe(true);
    expect(imageButton.classList.contains("overflow-hidden")).toBe(true);
    expect(imageButton.classList.contains("focus-visible:ring-2")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(close).toHaveBeenCalledTimes(1);
    expect(click).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Claim" }));
    expect(click).toHaveBeenCalledTimes(1);
    rerender(createElement(MarketingBannerView, { ...props, pending: true }));
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Verifying");
    expect(screen.getByRole("status").classList.contains("bg-card")).toBe(false);
    expect(screen.getByRole("status").classList.contains("rounded-full")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Claim" }));
    expect(click).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("img").getAttribute("src")).toBe(props.src);
    expect(screen.getByRole("img").classList.contains("object-cover")).toBe(true);
  });
});
