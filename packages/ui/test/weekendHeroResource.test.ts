import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";

const html = await readFile(
  new URL("../src/assets/cloud-content/weekend-plan-hero.html", import.meta.url),
  "utf8",
);
function fixture() {
  const raf = vi.fn(() => 1);
  const cancel = vi.fn();
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.requestAnimationFrame = raf;
      window.cancelAnimationFrame = cancel;
      Object.defineProperty(window.HTMLElement.prototype, "getAnimations", { value: () => [] });
    },
  });
  const { window } = dom;
  const message = (type: string, extra = {}) =>
    window.dispatchEvent(
      new window.MessageEvent("message", {
        source: window,
        data: { channel: "zcode-cloud-hero-v1", instanceId: "hero", type, ...extra },
      }),
    );
  return { dom, window, message, raf, cancel };
}

describe("Weekend Hero resource lifecycle", () => {
  it("renders a decorative SVG for each benefit without interpreting benefit text as HTML", () => {
    const f = fixture();
    try {
      f.message("init", { data: { benefits: ["GLM tokens", "<b>benefit</b>"] } });
      const icons = f.window.document.querySelectorAll("#benefits svg.lucide-gift");
      expect(icons).toHaveLength(2);
      expect(icons[0]!.getAttribute("aria-hidden")).toBe("true");
      expect(f.window.document.querySelector("#benefits b")).toBeNull();
    } finally {
      f.dom.window.close();
    }
  });
  it("ends entry state and allows replay without leaving the native back hidden", () => {
    const f = fixture();
    try {
      f.message("init", { data: {}, reducedMotion: false });
      const surface = f.window.document.getElementById("ticket-flip")!;
      expect(surface.classList.contains("is-entering")).toBe(true);
      surface.dispatchEvent(
        Object.assign(new f.window.Event("animationend"), { animationName: "ticket-enter" }),
      );
      expect(surface.classList.contains("is-entering")).toBe(false);
      f.window.document.getElementById("replay")!.click();
      expect(surface.classList.contains("is-entering")).toBe(true);
    } finally {
      f.dom.window.close();
    }
  });
  it("does not schedule idle motion before init or under reduced motion", () => {
    const f = fixture();
    try {
      expect(f.raf).not.toHaveBeenCalled();
      f.message("init", { reducedMotion: true });
      expect(f.raf).not.toHaveBeenCalled();
      expect(
        f.window.document.getElementById("ticket-flip")!.classList.contains("is-entering"),
      ).toBe(false);
    } finally {
      f.dom.window.close();
    }
  });
  it("stops idle motion while hidden and on destroy, then resumes on visibility", () => {
    const f = fixture();
    try {
      f.message("init");
      f.raf.mockClear();
      f.message("visibility", { visible: false });
      expect(f.cancel).toHaveBeenCalled();
      expect(f.raf).not.toHaveBeenCalled();
      f.message("visibility", { visible: true });
      expect(f.raf).toHaveBeenCalledTimes(1);
      f.message("destroy");
      f.raf.mockClear();
      f.message("visibility", { visible: true });
      expect(f.raf).not.toHaveBeenCalled();
    } finally {
      f.dom.window.close();
    }
  });
  it("ignores initialization from a source other than parent", () => {
    const f = fixture();
    try {
      f.window.dispatchEvent(
        new f.window.MessageEvent("message", {
          source: null,
          data: {
            channel: "zcode-cloud-hero-v1",
            instanceId: "fake",
            type: "init",
            data: { planName: "forged" },
          },
        }),
      );
      expect(f.window.document.getElementById("plan-name")!.textContent).toBe("");
    } finally {
      f.dom.window.close();
    }
  });
});
