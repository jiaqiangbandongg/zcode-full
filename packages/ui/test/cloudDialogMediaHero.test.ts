// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudDialogHero } from "@/components/cloud-content-dialog/CloudDialogHero.js";
import { validateCloudLottieData } from "@/components/cloud-content-dialog/cloudLottieRuntime.js";

const player = vi.hoisted(() => ({
  play: vi.fn(),
  pause: vi.fn(),
  destroy: vi.fn(),
  setSpeed: vi.fn(),
  goToAndStop: vi.fn(),
  addEventListener: vi.fn(),
}));
const loadAnimation = vi.hoisted(() => vi.fn(() => player));
vi.mock("lottie-web/build/player/lottie_light_canvas.js", () => ({ default: { loadAnimation } }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.documentElement.classList.remove("dark");
  vi.clearAllMocks();
});
const base = { locale: "en-US", title: "Hero" };

describe("media Hero", () => {
  it("renders image, switches theme source and exposes load failure", async () => {
    render(
      createElement(CloudDialogHero, {
        ...base,
        hero: {
          type: "image",
          src: "https://example.com/light.png",
          darkSrc: "https://example.com/dark.png",
          alt: "Preview",
          fit: "contain",
        },
      }),
    );
    expect(screen.getByAltText("Preview").getAttribute("src")).toContain("light.png");
    act(() => {
      document.documentElement.classList.add("dark");
    });
    await waitFor(() =>
      expect(screen.getByAltText("Preview").getAttribute("src")).toContain("dark.png"),
    );
    fireEvent.error(screen.getByAltText("Preview"));
    expect(screen.getByTestId("cloud-dialog-image-hero").getAttribute("data-status")).toBe("error");
  });

  it("renders muted inline video and pauses on unmount", () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    const { unmount } = render(
      createElement(CloudDialogHero, {
        ...base,
        hero: {
          type: "video",
          src: "https://example.com/demo.mp4",
          poster: "https://example.com/poster.png",
          muted: true,
          loop: true,
        },
      }),
    );
    const video = screen.getByTestId("cloud-dialog-video-hero") as HTMLVideoElement;
    expect(video.muted).toBe(true);
    expect(video.playsInline).toBe(true);
    expect(video.loop).toBe(true);
    unmount();
    expect(pause).toHaveBeenCalled();
    pause.mockRestore();
  });

  it("loads validated Lottie data into light canvas and destroys the player", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              v: "5.13.0",
              w: 400,
              h: 300,
              fr: 30,
              ip: 0,
              op: 60,
              layers: [],
              assets: [],
            }),
          ),
      ),
    );
    const { unmount } = render(
      createElement(CloudDialogHero, {
        ...base,
        hero: { type: "lottie", src: "https://example.com/hero.json", autoplay: true, speed: 1.5 },
      }),
    );
    await waitFor(() => expect(loadAnimation).toHaveBeenCalled());
    expect(loadAnimation.mock.calls[0]?.[0]).toMatchObject({
      renderer: "canvas",
      autoplay: false,
      animationData: { w: 400 },
    });
    expect(player.setSpeed).toHaveBeenCalledWith(1.5);
    unmount();
    expect(player.destroy).toHaveBeenCalled();
  });

  it("rejects external assets, expressions and unreasonable dimensions", () => {
    const data = { w: 400, h: 300, fr: 30, ip: 0, op: 60, layers: [] };
    expect(() => validateCloudLottieData(data)).not.toThrow();
    expect(() =>
      validateCloudLottieData({ ...data, assets: [{ p: "https://evil.example/a.png" }] }),
    ).toThrow();
    expect(() => validateCloudLottieData({ ...data, layers: [{ x: "alert(1)" }] })).toThrow();
    expect(() => validateCloudLottieData({ ...data, w: 99999 })).toThrow();
  });
});
