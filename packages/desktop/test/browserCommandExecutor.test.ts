import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  executeBrowserCommandOnView,
  isAllowedBrowserUrl,
  type ControlledView,
} from "../src/main/browserView/browserCommandExecutor.js";
import { normalizePlaywrightTimeout } from "../src/main/browserView/browserPlaywrightTimeout.js";

function makeView(
  overrides: Partial<{
    cdpSend: (m: string, p?: unknown, sessionId?: string) => Promise<unknown>;
    captureViewportScreenshot: NonNullable<ControlledView["captureViewportScreenshot"]>;
    executeJavaScript: (script: string) => Promise<unknown>;
    getURL: () => string;
    normalizeScreenshotToCssPixels: boolean;
    resizeScreenshotToCssPixels: NonNullable<ControlledView["resizeScreenshotToCssPixels"]>;
  }> = {},
): ControlledView {
  return {
    webContents: {
      loadURL: vi.fn(async () => {}),
      getURL: overrides.getURL ?? (() => "https://example.com"),
      getTitle: () => "Example",
      canGoBack: () => true,
      canGoForward: () => true,
      goBack: vi.fn(() => {}),
      goForward: vi.fn(() => {}),
      reload: vi.fn(() => {}),
      executeJavaScript:
        overrides.executeJavaScript ??
        vi.fn(async () => ({
          url: "https://x",
          title: "X",
          truncated: false,
          elements: [
            {
              ref: "e1",
              tag: "button",
              selector: "button",
              xpath: "/button",
              rect: { x: 0, y: 0, width: 10, height: 10 },
              inViewport: true,
            },
          ],
          dom: [
            { tag: "h1", depth: 1, inViewport: true, text: "Example heading" },
            {
              tag: "p",
              depth: 2,
              inViewport: true,
              text: "Readable paragraph",
            },
          ],
          domTruncated: false,
        })),
    },
    cdp: {
      send: overrides.cdpSend ?? vi.fn(async () => ({ data: "iVBORw0KGgo=" })),
    },
    normalizeScreenshotToCssPixels: overrides.normalizeScreenshotToCssPixels,
    resizeScreenshotToCssPixels: overrides.resizeScreenshotToCssPixels,
    captureViewportScreenshot: overrides.captureViewportScreenshot,
  };
}

function pngHeaderData(width: number, height: number, marker = 0): string {
  const header = Buffer.alloc(25);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "ascii");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  header[24] = marker;
  return header.toString("base64");
}

describe("isAllowedBrowserUrl", () => {
  it("allows about/http/https, blocks others", () => {
    expect(isAllowedBrowserUrl("https://x.com")).toBe(true);
    expect(isAllowedBrowserUrl("http://localhost:3000")).toBe(true);
    expect(isAllowedBrowserUrl("about:blank")).toBe(true);
    expect(isAllowedBrowserUrl("about:srcdoc")).toBe(false);
    expect(isAllowedBrowserUrl("about:config")).toBe(false);
    expect(isAllowedBrowserUrl("data:text/html,hello")).toBe(false);
    expect(isAllowedBrowserUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedBrowserUrl("file:///etc/passwd")).toBe(false);
  });
});

describe("executeBrowserCommandOnView", () => {
  it("navigate calls loadURL for allowed urls and returns state", async () => {
    const view = makeView();
    const r = await executeBrowserCommandOnView(view, {
      method: "navigate",
      url: "https://example.com",
    });
    expect(view.webContents.loadURL).toHaveBeenCalledWith(
      "https://example.com",
    );
    expect(r.ok).toBe(true);
    expect(r.state?.url).toBe("https://example.com");
  });

  it("navigate blocks javascript: without calling loadURL", async () => {
    const view = makeView();
    const r = await executeBrowserCommandOnView(view, {
      method: "navigate",
      url: "javascript:alert(1)",
    });
    expect(view.webContents.loadURL).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("navigation_blocked");
  });

  it("navigate 在 loadURL 永不 resolve 时返回结构化 timeout，不能伪造成功", async () => {
    const view = makeView();
    view.webContents.loadURL = vi.fn(() => new Promise<void>(() => {})); // 永不 resolve
    const r = await executeBrowserCommandOnView(
      view,
      { method: "navigate", url: "https://example.com" },
      { navigateSettleMs: 10 },
    );
    expect(view.webContents.loadURL).toHaveBeenCalledWith(
      "https://example.com",
    );
    expect(r).toMatchObject({
      ok: false,
      error: { code: "timeout", sideEffect: "uncertain" },
    });
  });

  it("navigate 透传 loadURL reject 为结构化 execution_error", async () => {
    const view = makeView();
    view.webContents.loadURL = vi.fn(async () => {
      throw Object.assign(new Error("ERR_CONNECTION_RESET"), {
        code: "ERR_CONNECTION_RESET",
      });
    });
    const r = await executeBrowserCommandOnView(
      view,
      { method: "navigate", url: "https://example.com" },
      { navigateSettleMs: 5_000 },
    );
    expect(r).toMatchObject({
      ok: false,
      error: {
        code: "execution_error",
        message: "ERR_CONNECTION_RESET",
        sideEffect: "uncertain",
      },
    });
  });

  it("navigate 将已提交到等价移动域名的 ERR_ABORTED 识别为成功", async () => {
    let currentUrl = "https://www.ituring.com.cn/";
    const view = makeView({
      getURL: () => currentUrl,
      executeJavaScript: vi.fn(async () => ({
        href: currentUrl,
        readyState: "complete",
      })),
    });
    view.webContents.loadURL = vi.fn(async () => {
      currentUrl = "https://m.ituring.com.cn/search?q=Skill";
      throw Object.assign(
        new Error(
          "ERR_ABORTED (-3) loading 'https://m.ituring.com.cn/search?q=Skill'",
        ),
        { code: "ERR_ABORTED", errno: -3 },
      );
    });

    const result = await executeBrowserCommandOnView(view, {
      method: "navigate",
      url: "https://www.ituring.com.cn/search?q=Skill",
    });

    expect(result).toMatchObject({
      ok: true,
      state: { url: "https://m.ituring.com.cn/search?q=Skill" },
    });
  });

  it("navigate 不吞掉仍停在旧 document 的 ERR_ABORTED", async () => {
    vi.useFakeTimers();
    try {
      const view = makeView({
        getURL: () => "https://example.com/old",
        executeJavaScript: vi.fn(async () => ({
          href: "https://example.com/old",
          readyState: "complete",
        })),
      });
      view.webContents.loadURL = vi.fn(async () => {
        throw Object.assign(new Error("ERR_ABORTED"), { code: "ERR_ABORTED" });
      });

      const pending = executeBrowserCommandOnView(view, {
        method: "navigate",
        url: "https://example.com/new",
      });
      await vi.advanceTimersByTimeAsync(525);

      await expect(pending).resolves.toMatchObject({
        ok: false,
        error: { code: "execution_error", sideEffect: "uncertain" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("screenshot uses CDP Page.captureScreenshot and returns base64", async () => {
    const send = vi.fn(async () => ({ data: "PNGDATA" }));
    const view = makeView({ cdpSend: send });
    const r = await executeBrowserCommandOnView(view, { method: "screenshot" });
    expect(send).toHaveBeenCalledWith("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    expect(r.ok).toBe(true);
    expect(r.image?.base64).toBe("PNGDATA");
    expect(r.image?.mimeType).toBe("image/png");
  });

  it("viewport screenshot 优先使用宿主已合成的 guest surface", async () => {
    const send = vi.fn(async () => ({ data: "CDP_TILED" }));
    const captureViewportScreenshot = vi.fn(async () => "SURFACE_OK");
    const view = makeView({ cdpSend: send, captureViewportScreenshot });

    const result = await executeBrowserCommandOnView(view, { method: "screenshot" });

    expect(result).toMatchObject({
      ok: true,
      image: { base64: "SURFACE_OK", mimeType: "image/png" },
    });
    expect(captureViewportScreenshot).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });

  it("clip screenshot 不复用仅覆盖 viewport 的 guest surface", async () => {
    const send = vi.fn(async () => ({ data: "CLIP_OK" }));
    const captureViewportScreenshot = vi.fn(async () => "SURFACE_ONLY");
    const view = makeView({ cdpSend: send, captureViewportScreenshot });

    const result = await executeBrowserCommandOnView(view, {
      method: "screenshot",
      clip: { x: 10, y: 20, width: 30, height: 40 },
    });

    expect(result.image?.base64).toBe("CLIP_OK");
    expect(captureViewportScreenshot).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: { x: 10, y: 20, width: 30, height: 40, scale: 1 },
    });
  });

  it("responsive screenshot starts at CSS 1x instead of pre-scaling from Retina metrics", async () => {
    const expectedImage = pngHeaderData(1440, 900);
    const send = vi.fn(async (method: string) => {
      if (method === "Page.getLayoutMetrics") {
        return {
          visualViewport: { pageX: 0, pageY: 0, clientWidth: 2880, clientHeight: 1800 },
          cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 1440, clientHeight: 900 },
        };
      }
      return { data: expectedImage };
    });
    const view = makeView({ cdpSend: send, normalizeScreenshotToCssPixels: true });
    const r = await executeBrowserCommandOnView(view, { method: "screenshot" });
    expect(r.ok).toBe(true);
    expect(r.image?.base64).toBe(expectedImage);
    expect(send).toHaveBeenNthCalledWith(1, "Page.getLayoutMetrics");
    expect(send).toHaveBeenNthCalledWith(2, "Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
      clip: { x: 0, y: 0, width: 1440, height: 900, scale: 1 },
    });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("supersamples a size-correct low-detail raster using the dynamic CSS target", async () => {
    const lowDetailImage = pngHeaderData(1280, 720, 1);
    const highResolutionImage = pngHeaderData(2560, 1440, 2);
    const sharpCssImage = pngHeaderData(1280, 720, 3);
    let captureCount = 0;
    const send = vi.fn(async (method: string) => {
      if (method === "Page.getLayoutMetrics") {
        return {
          cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 1280, clientHeight: 720 },
        };
      }
      captureCount += 1;
      return { data: captureCount === 1 ? lowDetailImage : highResolutionImage };
    });
    const resizeScreenshotToCssPixels = vi.fn(() => sharpCssImage);
    const view = makeView({
      cdpSend: send,
      normalizeScreenshotToCssPixels: true,
      resizeScreenshotToCssPixels,
    });

    const result = await executeBrowserCommandOnView(view, { method: "screenshot" });

    expect(result).toMatchObject({
      ok: true,
      image: { base64: sharpCssImage, mimeType: "image/png" },
    });
    expect(send).toHaveBeenNthCalledWith(2, "Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
      clip: { x: 0, y: 0, width: 1280, height: 720, scale: 1 },
    });
    expect(send).toHaveBeenNthCalledWith(3, "Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
      clip: { x: 0, y: 0, width: 1280, height: 720, scale: 2 },
    });
    expect(resizeScreenshotToCssPixels).toHaveBeenCalledWith(highResolutionImage, {
      width: 1280,
      height: 720,
    });
  });

  it("does not supersample a large dynamic target when the bounded quality gain is too small", async () => {
    const expectedImage = pngHeaderData(3840, 2160, 1);
    const send = vi.fn(async (method: string) => {
      if (method === "Page.getLayoutMetrics") {
        return {
          cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 3840, clientHeight: 2160 },
        };
      }
      return { data: expectedImage };
    });
    const view = makeView({
      cdpSend: send,
      normalizeScreenshotToCssPixels: true,
      resizeScreenshotToCssPixels: vi.fn(),
    });

    const result = await executeBrowserCommandOnView(view, { method: "screenshot" });

    expect(result).toMatchObject({
      ok: true,
      image: { base64: expectedImage, mimeType: "image/png" },
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(view.resizeScreenshotToCssPixels).not.toHaveBeenCalled();
  });

  it("derives a non-integer supersample scale from the current target instead of fixed dimensions", async () => {
    const lowDetailImage = pngHeaderData(3000, 1000, 1);
    const highResolutionImage = pngHeaderData(4096, 1365, 2);
    const sharpCssImage = pngHeaderData(3000, 1000, 3);
    let captureCount = 0;
    const send = vi.fn(async (method: string) => {
      if (method === "Page.getLayoutMetrics") {
        return {
          cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 3000, clientHeight: 1000 },
        };
      }
      captureCount += 1;
      return { data: captureCount === 1 ? lowDetailImage : highResolutionImage };
    });
    const resizeScreenshotToCssPixels = vi.fn(() => sharpCssImage);
    const view = makeView({
      cdpSend: send,
      normalizeScreenshotToCssPixels: true,
      resizeScreenshotToCssPixels,
    });

    const result = await executeBrowserCommandOnView(view, { method: "screenshot" });

    expect(result.image?.base64).toBe(sharpCssImage);
    const secondCapture = send.mock.calls[2];
    expect(secondCapture?.[0]).toBe("Page.captureScreenshot");
    expect((secondCapture![1] as { clip: { scale: number } }).clip.scale).toBeCloseTo(
      4096 / 3000,
    );
    expect(resizeScreenshotToCssPixels).toHaveBeenCalledWith(highResolutionImage, {
      width: 3000,
      height: 1000,
    });
  });

  it("corrects an undersized Retina screenshot only after observing its PNG dimensions", async () => {
    const undersizedImage = pngHeaderData(640, 360, 1);
    const correctedImage = pngHeaderData(1280, 720, 2);
    let captureCount = 0;
    const send = vi.fn(async (method: string) => {
      if (method === "Page.getLayoutMetrics") {
        return {
          visualViewport: { pageX: 0, pageY: 0, clientWidth: 2560, clientHeight: 1440 },
          cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 1280, clientHeight: 720 },
        };
      }
      captureCount += 1;
      return { data: captureCount === 1 ? undersizedImage : correctedImage };
    });
    const view = makeView({ cdpSend: send, normalizeScreenshotToCssPixels: true });

    const result = await executeBrowserCommandOnView(view, { method: "screenshot" });

    expect(result).toMatchObject({
      ok: true,
      image: { base64: correctedImage, mimeType: "image/png" },
    });
    expect(send).toHaveBeenNthCalledWith(2, "Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
      clip: { x: 0, y: 0, width: 1280, height: 720, scale: 1 },
    });
    expect(send).toHaveBeenNthCalledWith(3, "Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
      clip: { x: 0, y: 0, width: 1280, height: 720, scale: 2 },
    });
  });

  it("downsamples an oversized raster to the dynamic CSS target without fractional CDP capture", async () => {
    const oversizedImage = pngHeaderData(2057, 1370, 1);
    const resizedImage = pngHeaderData(1371, 913, 2);
    const send = vi.fn(async (method: string) => {
      if (method === "Page.getLayoutMetrics") {
        return {
          visualViewport: { pageX: 0, pageY: 0, clientWidth: 2057, clientHeight: 1370 },
          cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 1371, clientHeight: 913 },
        };
      }
      return { data: oversizedImage };
    });
    const resizeScreenshotToCssPixels = vi.fn(() => resizedImage);
    const view = makeView({
      cdpSend: send,
      normalizeScreenshotToCssPixels: true,
      resizeScreenshotToCssPixels,
    });

    const result = await executeBrowserCommandOnView(view, { method: "screenshot" });

    expect(result).toMatchObject({
      ok: true,
      image: { base64: resizedImage, mimeType: "image/png" },
    });
    expect(send).toHaveBeenNthCalledWith(2, "Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
      clip: { x: 0, y: 0, width: 1371, height: 913, scale: 1 },
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(resizeScreenshotToCssPixels).toHaveBeenCalledWith(oversizedImage, {
      width: 1371,
      height: 913,
    });
  });

  it("keeps the high-resolution first raster when host downsampling fails", async () => {
    const oversizedImage = pngHeaderData(1800, 1200, 1);
    const send = vi.fn(async (method: string) => {
      if (method === "Page.getLayoutMetrics") {
        return {
          cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 900, clientHeight: 600 },
        };
      }
      return { data: oversizedImage };
    });
    const view = makeView({
      cdpSend: send,
      normalizeScreenshotToCssPixels: true,
      resizeScreenshotToCssPixels: vi.fn(() => undefined),
    });

    const result = await executeBrowserCommandOnView(view, { method: "screenshot" });

    expect(result).toMatchObject({
      ok: true,
      image: { base64: oversizedImage, mimeType: "image/png" },
    });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("screenshot fails structured when CDP returns no data", async () => {
    const view = makeView({ cdpSend: vi.fn(async () => ({})) });
    const r = await executeBrowserCommandOnView(view, { method: "screenshot" });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("execution_error");
  });

  it("getState reads webContents getters", async () => {
    const view = makeView();
    const r = await executeBrowserCommandOnView(view, { method: "getState" });
    expect(r.ok).toBe(true);
    expect(r.state?.title).toBe("Example");
  });

  it("unimplemented method returns capability_unsupported", async () => {
    const view = makeView();
    // fill 仍未实现（click/type/press/scroll 已在 T-B/T-C 实现）。
    const r = await executeBrowserCommandOnView(view, {
      method: "fill",
      ref: "e1",
      value: "x",
    });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("capability_unsupported");
  });

  it("snapshot 注入脚本并返回 ok + result.snapshot（ref=e1）", async () => {
    const view = makeView();
    const r = await executeBrowserCommandOnView(view, { method: "snapshot" });
    expect(view.webContents.executeJavaScript).toHaveBeenCalledTimes(1);
    // 传入的应是包含 __zcodeRefs 的注入脚本字符串。
    const script = (
      view.webContents.executeJavaScript as ReturnType<typeof vi.fn>
    ).mock.calls[0][0];
    expect(typeof script).toBe("string");
    expect(script).toContain("__zcodeRefs");
    expect(script).toContain("DOM_SEL");
    expect(script).toContain("domTruncated");
    expect(r.ok).toBe(true);
    expect(r.snapshot?.elements[0]?.ref).toBe("e1");
    expect(r.snapshot?.dom?.[0]).toMatchObject({
      tag: "h1",
      text: "Example heading",
    });
    expect(r.snapshot?.url).toBe("https://x");
  });

  it("snapshot 在 executeJavaScript 抛错时结构化为 execution_error", async () => {
    const view = makeView({
      executeJavaScript: vi.fn(async () => {
        throw new Error("script boom");
      }),
    });
    const r = await executeBrowserCommandOnView(view, { method: "snapshot" });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("execution_error");
    expect(r.error?.message).toContain("script boom");
  });

  it("playwright locator query 使用 isolated Playwright runtime，不执行页面 main-world JS", async () => {
    const executeJavaScript = vi.fn();
    const cdpSend = vi.fn(async (method: string, params?: unknown) => {
      if (method === "Page.getFrameTree")
        return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.createIsolatedWorld")
        return { executionContextId: 1 };
      if (method === "Runtime.evaluate") {
        const expression = String(
          (params as { expression?: unknown }).expression ?? "",
        );
        if (expression.startsWith("Boolean(globalThis."))
          return { result: { value: true } };
        expect(expression).toContain("injected.querySelectorAll");
        expect(expression).toContain("internal:role=button");
        expect(expression).not.toContain(
          "querySelectorStrictWithVisibleFallback",
        );
        return { result: { value: 2 } };
      }
      return {};
    });
    const r = await executeBrowserCommandOnView(
      makeView({ executeJavaScript, cdpSend }),
      {
        method: "playwright",
        action: {
          name: "locator",
          selector: 'internal:role=button[name="Save"i]',
          operation: "count",
        },
      },
    );
    expect(r).toMatchObject({ ok: true, value: 2 });
    expect(executeJavaScript).not.toHaveBeenCalled();
  });

  it("playwright locator click 通过 CDP Input 产生可信输入", async () => {
    let actionabilityExpression = "";
    const cdpSend = vi.fn(async (method: string, params?: unknown) => {
      if (method === "Page.getFrameTree")
        return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.createIsolatedWorld")
        return { executionContextId: 1 };
      if (method === "Runtime.evaluate") {
        const expression = String(
          (params as { expression?: unknown }).expression ?? "",
        );
        if (expression.startsWith("Boolean(globalThis."))
          return { result: { value: true } };
        if (expression.includes("const checkStates"))
          actionabilityExpression = expression;
        return {
          result: { value: { count: 1, actionable: true, x: 10, y: 20 } },
        };
      }
      return {};
    });
    const view = makeView({ cdpSend });
    const r = await executeBrowserCommandOnView(view, {
      method: "playwright",
      action: {
        name: "locator",
        selector: "button",
        operation: "click",
        timeoutMs: 100,
      },
    });
    expect(r.ok).toBe(true);
    expect(actionabilityExpression).toContain("requestAnimationFrame");
    expect(actionabilityExpression).toContain("stableFrames < 2");
    expect(actionabilityExpression).toContain("injected.expectHitTarget");
    expect(cdpSend).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: 10,
      y: 20,
      button: "left",
      clickCount: 1,
    });
  });

  it("locator.downloadMedia 在 isolated world 提取 URL，不降级为普通 click", async () => {
    const expressions: string[] = [];
    const cdpSend = vi.fn(async (method: string, params?: unknown) => {
      if (method === "Page.getFrameTree")
        return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.createIsolatedWorld")
        return { executionContextId: 1 };
      if (method === "Runtime.evaluate") {
        const expression = String(
          (params as { expression?: unknown }).expression ?? "",
        );
        expressions.push(expression);
        if (expression.startsWith("Boolean(globalThis."))
          return { result: { value: true } };
        if (expression.includes("actionability")) {
          return {
            result: { value: { count: 1, actionable: true, x: 10, y: 20 } },
          };
        }
        if (
          expression.includes(
            "Matched element does not expose a downloadable URL",
          )
        ) {
          return { result: { value: true } };
        }
        return {
          result: { value: { count: 1, actionable: true, x: 10, y: 20 } },
        };
      }
      return {};
    });
    const result = await executeBrowserCommandOnView(makeView({ cdpSend }), {
      method: "playwright",
      action: { name: "locator", selector: "img", operation: "downloadMedia" },
    });
    expect(result.ok).toBe(true);
    expect(
      expressions.some((expression) =>
        expression.includes('document.createElement("a")'),
      ),
    ).toBe(true);
    expect(cdpSend).not.toHaveBeenCalledWith(
      "Input.dispatchMouseEvent",
      expect.objectContaining({ type: "mousePressed" }),
    );
  });

  it("playwright locator 缺失时把超长显式 timeout 截断到 3000ms", async () => {
    vi.useFakeTimers();
    try {
      const cdpSend = vi.fn(async (method: string, params?: unknown) => {
        if (method === "Page.getFrameTree")
          return { frameTree: { frame: { id: "main" } } };
        if (method === "Page.createIsolatedWorld")
          return { executionContextId: 1 };
        if (method === "Runtime.evaluate") {
          const expression = String(
            (params as { expression?: unknown }).expression ?? "",
          );
          if (expression.startsWith("Boolean(globalThis."))
            return { result: { value: true } };
          return { result: { value: { count: 0, actionable: false } } };
        }
        return {};
      });
      const pending = executeBrowserCommandOnView(makeView({ cdpSend }), {
        method: "playwright",
        action: {
          name: "locator",
          selector: "#missing",
          operation: "fill",
          timeoutMs: 30_000,
        },
      });

      await vi.advanceTimersByTimeAsync(3_000);
      await expect(pending).resolves.toMatchObject({
        ok: false,
        elapsedMs: 3_000,
        error: {
          code: "timeout",
          message: expect.stringContaining("Do not retry the same locator"),
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("playwright fill 不等待 stable 且不检查 hit-target", async () => {
    let actionabilityExpression = "";
    let fillExpression = "";
    const cdpSend = vi.fn(async (method: string, params?: unknown) => {
      if (method === "Page.getFrameTree")
        return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.createIsolatedWorld")
        return { executionContextId: 1 };
      if (method === "Runtime.evaluate") {
        const expression = String(
          (params as { expression?: unknown }).expression ?? "",
        );
        if (expression.startsWith("Boolean(globalThis."))
          return { result: { value: true } };
        if (expression.includes("const checkStates")) {
          actionabilityExpression = expression;
          return { result: { value: { count: 1, actionable: true } } };
        }
        if (expression.includes("injected.fill")) {
          fillExpression = expression;
          return { result: { value: "done" } };
        }
      }
      return {};
    });

    await expect(
      executeBrowserCommandOnView(makeView({ cdpSend }), {
        method: "playwright",
        action: {
          name: "locator",
          selector: "textarea",
          operation: "fill",
          value: "hello",
        },
      }),
    ).resolves.toMatchObject({ ok: true });

    expect(actionabilityExpression).toContain("if (false) {");
    expect(actionabilityExpression).toContain('stateNames.push("editable")');
    expect(actionabilityExpression).toContain(
      "if (!false) return { count: 1, actionable: true, checked }",
    );
    for (const expression of [actionabilityExpression, fillExpression]) {
      expect(expression).toContain("querySelectorStrictWithVisibleFallback");
      expect(expression).toContain(
        "if (visibleMatches.length === 1) return visibleMatches[0]",
      );
      expect(expression).toContain(
        "throw injected.strictModeViolationError(parsedSelector, matches)",
      );
    }
  });

  it("playwright fill needsinput 使用同一 locator token 的 virtual paste", async () => {
    const expressions: string[] = [];
    const cdpSend = vi.fn(async (method: string, params?: unknown) => {
      if (method === "Page.getFrameTree")
        return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
      if (method === "Runtime.evaluate") {
        const options = params as { expression?: string; returnByValue?: boolean };
        const expression = options.expression ?? "";
        expressions.push(expression);
        if (expression.startsWith("Boolean(globalThis."))
          return { result: { value: true } };
        if (expression.includes("const checkStates"))
          return { result: { value: { count: 1, actionable: true } } };
        if (expression.includes("injected.fill"))
          return { result: { value: "needsinput" } };
        if (options.returnByValue === false) return { result: { value: null } };
        if (expression.includes("const pageFunction = async"))
          return { result: { value: { ok: true, data: {} } } };
      }
      return {};
    });

    const result = await executeBrowserCommandOnView(makeView({ cdpSend }), {
      method: "playwright",
      action: {
        name: "locator",
        selector: "textarea",
        operation: "fill",
        value: "hello",
      },
    });

    expect(result.ok).toBe(true);
    const fillExpression = expressions.find((expression) => expression.includes("injected.fill"));
    const pasteExpression = expressions.find((expression) =>
      expression.includes("const pageFunction = async"),
    );
    expect(fillExpression).toContain("__zcodeIabInputTargetToken");
    expect(pasteExpression).toContain("__zcodeIabInputTargetToken");
    expect(cdpSend).not.toHaveBeenCalledWith("Input.insertText", expect.anything());
  });

  it("playwright fill 在 locator token 漂移后明确失败且不回退 Input.insertText", async () => {
    const cdpSend = vi.fn(async (method: string, params?: unknown) => {
      if (method === "Page.getFrameTree")
        return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
      if (method === "Runtime.evaluate") {
        const options = params as { expression?: string; returnByValue?: boolean };
        const expression = options.expression ?? "";
        if (expression.startsWith("Boolean(globalThis."))
          return { result: { value: true } };
        if (expression.includes("const checkStates"))
          return { result: { value: { count: 1, actionable: true } } };
        if (expression.includes("injected.fill"))
          return { result: { value: "needsinput" } };
        if (options.returnByValue === false) return { result: { value: null } };
        if (expression.includes("const pageFunction = async")) {
          return {
            result: {
              value: {
                ok: false,
                error: "Active element is no longer the expected input target",
              },
            },
          };
        }
      }
      return {};
    });

    const result = await executeBrowserCommandOnView(makeView({ cdpSend }), {
      method: "playwright",
      action: {
        name: "locator",
        selector: "textarea",
        operation: "fill",
        value: "must-not-leak",
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "execution_error",
        message: expect.stringContaining("Active element is no longer the expected input target"),
      },
    });
    expect(cdpSend).not.toHaveBeenCalledWith("Input.insertText", expect.anything());
  });

  it("playwright press 在下发 CDP key 前校验 locator input token", async () => {
    const expressions: string[] = [];
    const cdpSend = vi.fn(async (method: string, params?: unknown) => {
      if (method === "Page.getFrameTree")
        return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
      if (method === "Runtime.evaluate") {
        const expression = String((params as { expression?: unknown }).expression ?? "");
        expressions.push(expression);
        if (expression.startsWith("Boolean(globalThis."))
          return { result: { value: true } };
        if (expression.includes("const checkStates"))
          return { result: { value: { count: 1, actionable: true } } };
        if (expression.includes("Object.defineProperty(element"))
          return { result: { value: "done" } };
        if (expression.includes("deepestActiveElement(document)"))
          return { result: { value: true } };
      }
      return {};
    });

    const result = await executeBrowserCommandOnView(makeView({ cdpSend }), {
      method: "playwright",
      action: { name: "locator", selector: "textarea", operation: "press", value: "Enter" },
    });

    expect(result.ok).toBe(true);
    expect(expressions.some((expression) => expression.includes("__zcodeIabInputTargetToken"))).toBe(
      true,
    );
    expect(cdpSend).toHaveBeenCalledWith("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
    });
  });

  it("playwright 单元素 action 在多匹配时选择唯一 visible 元素", async () => {
    const fillTargets: string[] = [];
    const element = (id: string, visible: boolean) => ({
      id,
      isConnected: true,
      visible,
      scrollIntoView: vi.fn(),
      getBoundingClientRect: () => ({
        bottom: 20,
        height: 10,
        left: 10,
        right: 30,
        top: 10,
        width: 20,
      }),
      ownerDocument: {
        defaultView: {
          requestAnimationFrame: (callback: () => void) => callback(),
        },
      },
    });
    const hidden = element("mobile-hidden", false);
    const visible = element("desktop-visible", true);
    const injected = {
      checkDeprecatedSelectorUsage: vi.fn(),
      elementState: (
        candidate: typeof hidden,
        state: "editable" | "enabled" | "visible",
      ) => ({
        matches: state === "visible" ? candidate.visible : true,
      }),
      fill: (candidate: typeof hidden) => {
        fillTargets.push(candidate.id);
        return "done";
      },
      parseSelector: (selector: string) => selector,
      querySelectorAll: () => [hidden, visible],
      strictModeViolationError: () =>
        new Error(
          "strict mode violation: resolved to 2 elements:\n" +
            '  1) <input data-testid="mobile-search"> aka getByTestId("mobile-search")\n' +
            '  2) <input data-testid="desktop-search"> aka getByTestId("desktop-search")',
        ),
    };
    const runtime = createContext({
      __zcodePlaywrightInjected: injected,
      document: {},
      innerHeight: 800,
      innerWidth: 1200,
      setTimeout,
    });
    const cdpSend = vi.fn(async (method: string, params?: unknown) => {
      if (method === "Page.getFrameTree")
        return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.createIsolatedWorld")
        return { executionContextId: 1 };
      if (method === "Runtime.evaluate") {
        const expression = String(
          (params as { expression?: unknown }).expression ?? "",
        );
        try {
          return { result: { value: await runInContext(expression, runtime) } };
        } catch (error) {
          return {
            exceptionDetails: {
              exception: {
                description: error instanceof Error ? error.message : String(error),
              },
            },
          };
        }
      }
      return {};
    });

    const result = await executeBrowserCommandOnView(makeView({ cdpSend }), {
      method: "playwright",
      action: {
        name: "locator",
        selector: 'internal:role=textbox[name="搜索"i]',
        operation: "fill",
        value: "世界杯",
      },
    });

    expect(result).toMatchObject({ ok: true });
    expect(fillTargets).toEqual(["desktop-visible"]);

    hidden.visible = true;
    const ambiguous = await executeBrowserCommandOnView(makeView({ cdpSend }), {
      method: "playwright",
      action: {
        name: "locator",
        selector: 'internal:role=textbox[name="搜索"i]',
        operation: "fill",
        value: "世界杯决赛",
      },
    });

    expect(ambiguous).toMatchObject({
      ok: false,
      error: {
        code: "execution_error",
        message: expect.stringContaining('getByTestId("mobile-search")'),
      },
    });
    expect(ambiguous.error?.message).toContain(
      'getByTestId("desktop-search")',
    );
    expect(fillTargets).toEqual(["desktop-visible"]);
  });

  it("playwright pointer probe 空 payload 返回结构化错误，不泄漏 undefined.count", async () => {
    const cdpSend = vi.fn(async (method: string, params?: unknown) => {
      if (method === "Page.getFrameTree")
        return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.createIsolatedWorld")
        return { executionContextId: 1 };
      if (method === "Runtime.evaluate") {
        const expression = String(
          (params as { expression?: unknown }).expression ?? "",
        );
        if (expression.startsWith("Boolean(globalThis."))
          return { result: { value: true } };
        if (expression.includes("const checkStates"))
          return { result: { value: {} } };
      }
      return {};
    });

    const result = await executeBrowserCommandOnView(makeView({ cdpSend }), {
      method: "playwright",
      action: { name: "locator", selector: "button", operation: "click" },
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "execution_error",
        message: expect.stringContaining(
          "pointer probe returned an invalid payload",
        ),
      },
    });
    expect(result.error?.message).not.toContain("undefined");
  });

  it("playwright force click 跳过 visible/enabled 与 receives-events，但仍等待稳定矩形", async () => {
    let actionabilityExpression = "";
    const cdpSend = vi.fn(async (method: string, params?: unknown) => {
      if (method === "Page.getFrameTree")
        return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.createIsolatedWorld")
        return { executionContextId: 1 };
      if (method === "Runtime.evaluate") {
        const expression = String(
          (params as { expression?: unknown }).expression ?? "",
        );
        if (expression.startsWith("Boolean(globalThis."))
          return { result: { value: true } };
        if (expression.includes("const checkStates")) {
          actionabilityExpression = expression;
          return {
            result: { value: { count: 1, actionable: true, x: 10, y: 20 } },
          };
        }
      }
      return {};
    });

    const result = await executeBrowserCommandOnView(makeView({ cdpSend }), {
      method: "playwright",
      action: {
        force: true,
        name: "locator",
        selector: "button",
        operation: "click",
      },
    });

    expect(result.ok).toBe(true);
    expect(actionabilityExpression).toContain("if (!true)");
    expect(actionabilityExpression).toContain(
      'if (false) stateNames.push("enabled")',
    );
    expect(actionabilityExpression).toContain("if (true) {");
  });

  it("playwright click 在 execution context navigation race 后重新解析 locator", async () => {
    let actionabilityCalls = 0;
    let nextContextId = 0;
    const cdpSend = vi.fn(async (method: string, params?: unknown) => {
      if (method === "Page.getFrameTree")
        return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.createIsolatedWorld") {
        nextContextId += 1;
        return { executionContextId: nextContextId };
      }
      if (method === "Runtime.evaluate") {
        const expression = String(
          (params as { expression?: unknown }).expression ?? "",
        );
        if (expression.startsWith("Boolean(globalThis."))
          return { result: { value: true } };
        if (expression.includes("const checkStates")) {
          actionabilityCalls += 1;
          if (actionabilityCalls === 1) {
            return {
              exceptionDetails: { text: "Execution context was destroyed." },
            };
          }
          return {
            result: { value: { count: 1, actionable: true, x: 10, y: 20 } },
          };
        }
      }
      return {};
    });

    const result = await executeBrowserCommandOnView(makeView({ cdpSend }), {
      method: "playwright",
      action: { name: "locator", selector: "button", operation: "click" },
    });

    expect(result.ok).toBe(true);
    expect(actionabilityCalls).toBe(2);
    expect(
      cdpSend.mock.calls.filter(([method]) => method === "Page.getFrameTree"),
    ).toHaveLength(2);
  });

  it("playwright click 允许等位新节点跨帧保持几何稳定并派发可信输入", async () => {
    let actionabilityExpression = "";
    let currentNode: { isConnected: boolean };
    const makeNode = (id: string) => ({
      id,
      isConnected: true,
      scrollIntoView: vi.fn(),
      getBoundingClientRect: () => ({
        bottom: 30,
        height: 20,
        left: 10,
        right: 30,
        top: 10,
        width: 20,
      }),
      ownerDocument: {
        defaultView: {
          requestAnimationFrame: (callback: () => void) => {
            if (currentNode === originalNode) {
              originalNode.isConnected = false;
              currentNode = replacementNode;
            }
            callback();
          },
        },
      },
    });
    const originalNode = makeNode("old");
    const replacementNode = makeNode("replacement");
    currentNode = originalNode;
    const injected = {
      checkDeprecatedSelectorUsage: vi.fn(),
      elementState: () => ({ matches: true }),
      expectHitTarget: () => "done",
      parseSelector: (selector: string) => selector,
      querySelectorAll: () => [currentNode],
      strictModeViolationError: () => new Error("strict violation"),
    };
    const runtime = createContext({
      __zcodePlaywrightInjected: injected,
      document: {},
      innerHeight: 800,
      innerWidth: 1200,
      setTimeout,
    });
    const cdpSend = vi.fn(async (method: string, params?: unknown) => {
      if (method === "Page.getFrameTree")
        return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.createIsolatedWorld")
        return { executionContextId: 1 };
      if (method === "Runtime.evaluate") {
        const expression = String(
          (params as { expression?: unknown }).expression ?? "",
        );
        if (expression.startsWith("Boolean(globalThis."))
          return { result: { value: true } };
        if (expression.includes("const checkStates")) {
          actionabilityExpression = expression;
          return { result: { value: await runInContext(expression, runtime) } };
        }
      }
      return {};
    });

    const result = await executeBrowserCommandOnView(makeView({ cdpSend }), {
      method: "playwright",
      action: { name: "locator", selector: "button", operation: "click" },
    });

    expect(result.ok).toBe(true);
    // el-table 等页面会在 rAF 间用同 selector 的新节点替换旧节点；稳定性应比较当前目标几何，
    // 不能把旧 node identity 的 detach 永久折算成 count=0。
    expect(actionabilityExpression).toContain("resolveCurrentElement");
    expect(actionabilityExpression).not.toContain(
      "if (!element.isConnected) return { count: 0, actionable: false }",
    );
    expect(originalNode.isConnected).toBe(false);
    expect(currentNode).toBe(replacementNode);
    expect(cdpSend).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: 20,
      y: 20,
      button: "left",
      clickCount: 1,
    });
  });

  it("playwright transformed iframe click 通过 content quad 换算并校验 frame owner", async () => {
    let nextContextId = 0;
    let frameSelectorExpression = "";
    const cdpSend = vi.fn(async (method: string, params?: unknown) => {
      if (method === "Page.getFrameTree")
        return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.createIsolatedWorld") {
        nextContextId += 1;
        return { executionContextId: nextContextId };
      }
      if (method === "Runtime.evaluate") {
        const expression = String(
          (params as { expression?: unknown }).expression ?? "",
        );
        if (expression.startsWith("Boolean(globalThis."))
          return { result: { value: true } };
        if (
          expression.includes("frame locator resolved to no elements") &&
          expression.includes("return resolvedElement")
        ) {
          frameSelectorExpression = expression;
          return { result: { objectId: "iframe-object" } };
        }
        if (expression.includes("const checkStates")) {
          return {
            result: { value: { count: 1, actionable: true, x: 10, y: 20 } },
          };
        }
        if (expression.includes("globalThis.innerWidth")) {
          return { result: { value: { width: 200, height: 100 } } };
        }
        if (expression.includes("elements.length"))
          return { result: { value: 1 } };
      }
      if (method === "DOM.describeNode") {
        if ((params as { objectId?: string }).objectId === "iframe-object") {
          return { node: { backendNodeId: 7, frameId: "child" } };
        }
        return { node: { localName: "iframe" } };
      }
      if (method === "DOM.getContentQuads") {
        return { quads: [[100, 50, 300, 70, 290, 170, 90, 150]] };
      }
      if (method === "DOM.getNodeForLocation") return { backendNodeId: 7 };
      return {};
    });

    const result = await executeBrowserCommandOnView(makeView({ cdpSend }), {
      method: "playwright",
      action: {
        name: "locator",
        selector: "iframe >> internal:control=enter-frame >> button",
        operation: "click",
      },
    });

    expect(result.ok).toBe(true);
    expect(frameSelectorExpression).toContain(
      "querySelectorStrictWithVisibleFallback",
    );
    expect(cdpSend).toHaveBeenCalledWith(
      "DOM.getNodeForLocation",
      {
        includeUserAgentShadowDOM: true,
        x: 108,
        y: 71,
      },
      undefined,
    );
    expect(cdpSend).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: 108,
      y: 71,
      button: "left",
      clickCount: 1,
    });
  });

  it("playwright locator 单次 actionability probe 卡住也在 3000ms 内返回 timeout", async () => {
    vi.useFakeTimers();
    try {
      const cdpSend = vi.fn(async (method: string, params?: unknown) => {
        if (method === "Page.getFrameTree")
          return { frameTree: { frame: { id: "main" } } };
        if (method === "Page.createIsolatedWorld")
          return { executionContextId: 1 };
        if (method === "Runtime.evaluate") {
          const expression = String(
            (params as { expression?: unknown }).expression ?? "",
          );
          if (expression.startsWith("Boolean(globalThis."))
            return { result: { value: true } };
          return await new Promise<never>(() => undefined);
        }
        return {};
      });
      const pending = executeBrowserCommandOnView(makeView({ cdpSend }), {
        method: "playwright",
        action: {
          name: "locator",
          selector: "textarea",
          operation: "fill",
          value: "hello",
        },
      });

      await vi.advanceTimersByTimeAsync(3_000);
      await expect(pending).resolves.toMatchObject({
        ok: false,
        elapsedMs: 3_000,
        error: { code: "timeout" },
      });
      expect(cdpSend).toHaveBeenCalledWith(
        "Runtime.terminateExecution",
        undefined,
        undefined,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("playwright locator strict violation 保留 injected runtime 的候选详情", async () => {
    let actionabilityExpression = "";
    const cdpSend = vi.fn(async (method: string, params?: unknown) => {
      if (method === "Page.getFrameTree")
        return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.createIsolatedWorld")
        return { executionContextId: 1 };
      if (method === "Runtime.evaluate") {
        const expression = String(
          (params as { expression?: unknown }).expression ?? "",
        );
        if (expression.startsWith("Boolean(globalThis."))
          return { result: { value: true } };
        if (expression.includes("const checkStates")) {
          actionabilityExpression = expression;
          return {
            exceptionDetails: {
              exception: {
                description:
                  "strict mode violation: getByText('购买') resolved to 2 elements:\n" +
                  '  1) <button data-testid="header-buy">购买</button> aka getByTestId("header-buy")\n' +
                  '  2) <button data-testid="card-buy">购买</button> aka getByTestId("card-buy")',
              },
            },
          };
        }
      }
      return {};
    });

    const result = await executeBrowserCommandOnView(makeView({ cdpSend }), {
      method: "playwright",
      action: { name: "locator", selector: "text=购买", operation: "click" },
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "execution_error",
        message: expect.stringContaining(
          'getByTestId("header-buy")',
        ),
      },
    });
    expect(result.error?.message).toContain('getByTestId("card-buy")');
    expect(actionabilityExpression).toContain(
      "throw injected.strictModeViolationError(parsedSelector, matches)",
    );
  });

  it("playwright domSnapshot 与 elementScreenshot 走 DOM-first/按需视觉两条独立通道", async () => {
    const cdpSend = vi.fn(async (method: string, params?: unknown) => {
      if (method === "Page.getLayoutMetrics") {
        return {
          visualViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 1200 },
          cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 400, clientHeight: 600 },
        };
      }
      if (method === "Page.getFrameTree")
        return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.createIsolatedWorld")
        return { executionContextId: 1 };
      if (method === "Runtime.evaluate") {
        const expression = String(
          (params as { expression?: unknown }).expression ?? "",
        );
        if (expression.startsWith("Boolean(globalThis."))
          return { result: { value: false } };
        if (expression.includes("globalThis.__zcodePlaywrightInjected = new")) {
          return { result: { value: true } };
        }
        if (expression.includes("elementsFromPoint(options.x, options.y)")) {
          return {
            result: {
              value: [
                {
                  tagName: "button",
                  preview: "<button>Save</button>",
                  selector: { primary: "button", candidates: ["button"] },
                },
              ],
            },
          };
        }
        return {
          result: {
            value: {
              full: '- heading "Example" [level=1] [ref=e1]',
              iframeDepths: {},
              iframeRefs: [],
            },
          },
        };
      }
      if (method === "Page.captureScreenshot") return { data: "PNGDATA" };
      return {};
    });
    const view = makeView({ cdpSend, normalizeScreenshotToCssPixels: true });
    await expect(
      executeBrowserCommandOnView(view, {
        method: "playwright",
        action: { name: "domSnapshot" },
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: '- heading "Example" [level=1]',
    });
    await expect(
      executeBrowserCommandOnView(view, {
        method: "playwright",
        action: { name: "elementInfo", x: 1, y: 2 },
      }),
    ).resolves.toMatchObject({ ok: true, value: [{ tagName: "button" }] });
    await expect(
      executeBrowserCommandOnView(view, {
        method: "playwright",
        action: { name: "elementScreenshot", x: 1, y: 2 },
      }),
    ).resolves.toMatchObject({ ok: true, image: { base64: "PNGDATA" } });
    expect(cdpSend).toHaveBeenCalledWith("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
      clip: { x: 0, y: 0, width: 400, height: 600, scale: 1 },
    });
    expect(view.webContents.executeJavaScript).not.toHaveBeenCalled();
    expect(cdpSend).toHaveBeenCalledWith(
      "Runtime.evaluate",
      expect.objectContaining({ contextId: 1, returnByValue: true }),
    );
  });

  it("playwright domSnapshot 顶层 3000ms 预算耗尽后返回结构化 timeout", async () => {
    const cdpSend = vi.fn(async (method: string) => {
      if (method === "Page.getFrameTree")
        return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.createIsolatedWorld")
        return { executionContextId: 1 };
      if (method === "Runtime.evaluate")
        throw new Error("Script execution timed out");
      return {};
    });
    await expect(
      executeBrowserCommandOnView(makeView({ cdpSend }), {
        method: "playwright",
        action: { name: "domSnapshot" },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "timeout", message: "Script execution timed out" },
    });
  });

  it("playwright evaluate 允许页面副作用并走 CDP 硬 timeout", async () => {
    const cdpSend = vi.fn(async (_method: string, params?: unknown) => {
      const expression = (params as { expression: string }).expression;
      expect(expression).toContain("document.body.append");
      return { result: { value: "Example" } };
    });
    const r = await executeBrowserCommandOnView(makeView({ cdpSend }), {
      method: "playwright",
      action: {
        name: "evaluate",
        expression: "document.body.append(document.createElement('div'))",
        expressionKind: "string",
        timeoutMs: 1234,
      },
    });
    expect(r).toMatchObject({ ok: true, value: "Example" });
    expect(cdpSend).toHaveBeenCalledWith(
      "Runtime.evaluate",
      expect.objectContaining({
        awaitPromise: true,
        returnByValue: true,
        timeout: 1234,
      }),
    );
  });

  it("playwright evaluate 页面异常只返回执行错误，不附加只读限制提示", async () => {
    const cdpSend = vi.fn(async () => ({
      exceptionDetails: {
        exception: {
          description: "Error: page script failed",
        },
      },
    }));
    const result = await executeBrowserCommandOnView(makeView({ cdpSend }), {
      method: "playwright",
      action: {
        name: "evaluate",
        expression: "document.body.getBoundingClientRect()",
        expressionKind: "string",
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "execution_error" },
    });
    expect(result.error?.message).toContain("page script failed");
    expect(result.error?.message).not.toContain("read-only");
    expect(result.error?.message).not.toContain("Possible side-effect");
  });

  it("Playwright routine timeout 默认并截断为 3000ms", async () => {
    expect(normalizePlaywrightTimeout(undefined)).toBe(3_000);
    expect(normalizePlaywrightTimeout(250)).toBe(250);
    expect(normalizePlaywrightTimeout(30_000)).toBe(3_000);
    expect(normalizePlaywrightTimeout(30_000, 120_000)).toBe(30_000);

    const timeouts: unknown[] = [];
    const cdpSend = vi.fn(async (_method: string, params?: unknown) => {
      timeouts.push((params as { timeout?: unknown }).timeout);
      return { result: { value: "Example" } };
    });
    const view = makeView({ cdpSend });
    await executeBrowserCommandOnView(view, {
      method: "playwright",
      action: {
        name: "evaluate",
        expression: "document.title",
        expressionKind: "string",
      },
    });
    await executeBrowserCommandOnView(view, {
      method: "playwright",
      action: {
        name: "evaluate",
        expression: "document.title",
        expressionKind: "string",
        timeoutMs: 30_000,
      },
    });
    expect(timeouts).toEqual([3_000, 3_000]);
  });

  it("waitForLoadState 明确拒绝 networkidle", async () => {
    const result = await executeBrowserCommandOnView(makeView(), {
      method: "playwright",
      action: {
        name: "waitForLoadState",
        state: "networkidle",
        timeoutMs: 100,
      },
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "execution_error",
        message: "playwright_wait_for_load_state does not support networkidle",
      },
    });
  });

  it("wraps CDP throw into execution_error", async () => {
    const view = makeView({
      cdpSend: vi.fn(async () => {
        throw new Error("cdp boom");
      }),
    });
    const r = await executeBrowserCommandOnView(view, { method: "screenshot" });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("execution_error");
    expect(r.error?.message).toContain("cdp boom");
  });

  it("把 generation abort 映射成 cancelled，而不是页面执行错误", async () => {
    const controller = new AbortController();
    controller.abort();
    const r = await executeBrowserCommandOnView(
      makeView(),
      { method: "playwright", action: { name: "domSnapshot" } },
      { signal: controller.signal },
    );
    expect(r).toMatchObject({
      ok: false,
      error: { code: "cancelled", message: "Browser command cancelled" },
    });
  });

  it("back 调 goBack 并返回 state", async () => {
    const view = makeView();
    const r = await executeBrowserCommandOnView(view, { method: "back" });
    expect(view.webContents.goBack).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(true);
    expect(r.state?.url).toBe("https://example.com");
  });

  it("forward 调 goForward 并返回 state", async () => {
    const view = makeView();
    const r = await executeBrowserCommandOnView(view, { method: "forward" });
    expect(view.webContents.goForward).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(true);
  });

  it("reload 调 reload 并返回 state", async () => {
    const view = makeView();
    const r = await executeBrowserCommandOnView(view, { method: "reload" });
    expect(view.webContents.reload).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(true);
  });

  it("click 解析 ref 中心点并发 CDP mousePressed/mouseReleased（ok:true）", async () => {
    const send = vi.fn(async () => ({}));
    const view = makeView({
      cdpSend: send,
      executeJavaScript: vi.fn(async () => ({ cx: 50, cy: 60 })),
    });
    const r = await executeBrowserCommandOnView(view, {
      method: "click",
      ref: "e1",
    });
    expect(r.ok).toBe(true);
    expect(send).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: 50,
      y: 60,
      button: "left",
      clickCount: 1,
    });
    expect(send).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: 50,
      y: 60,
      button: "left",
      clickCount: 1,
    });
  });

  it("click ref 未找到（resolve 返回 null）→ ok:false ref_not_found", async () => {
    const send = vi.fn(async () => ({}));
    const view = makeView({
      cdpSend: send,
      executeJavaScript: vi.fn(async () => null),
    });
    const r = await executeBrowserCommandOnView(view, {
      method: "click",
      ref: "e404",
    });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("ref_not_found");
    // 未找到时不应发鼠标事件。
    expect(send).not.toHaveBeenCalled();
  });

  it("type 在 guest focused target 执行 virtual paste，不调用 Input.insertText", async () => {
    const expressions: string[] = [];
    const send = vi.fn(async (method: string, params?: unknown) => {
      if (method !== "Runtime.evaluate") return {};
      const options = params as { expression?: string; returnByValue?: boolean };
      expressions.push(options.expression ?? "");
      return options.returnByValue === false
        ? { result: { value: null } }
        : { result: { value: { ok: true, data: {} } } };
    });
    const view = makeView({ cdpSend: send });
    const r = await executeBrowserCommandOnView(view, {
      method: "type",
      text: "hi",
    });
    expect(r.ok).toBe(true);
    expect(send).not.toHaveBeenCalledWith("Input.insertText", expect.anything());
    expect(expressions[0]).toContain("focusedFrameElementInRoot");
    expect(expressions[1]).toContain('new view.ClipboardEvent("paste"');
    expect(expressions[1]).toContain('mime_type":"text/plain","text":"hi"');
  });

  it("type 在 OOPIF target 延迟注册时等待 child session，paste 后释放 attach", async () => {
    let attachAttempts = 0;
    const send = vi.fn(
      async (method: string, params?: unknown, sessionId?: string) => {
        if (method === "Runtime.evaluate") {
          const options = params as { expression?: string; returnByValue?: boolean };
          if (options.returnByValue === false) {
            return sessionId == null
              ? { result: { objectId: "focused-frame" } }
              : { result: { value: null } };
          }
          return { result: { value: { ok: true, data: {} } } };
        }
        if (method === "DOM.describeNode") return { node: { frameId: "oopif-frame" } };
        if (method === "Target.attachToTarget") {
          attachAttempts += 1;
          if (attachAttempts === 1) throw new Error("No target with given id found");
          return { sessionId: "oopif-session" };
        }
        if (method === "Page.createIsolatedWorld")
          throw new Error("No frame for given id found");
        if (method === "Target.getTargets") {
          return { targetInfos: [{ targetId: "oopif-frame", type: "iframe" }] };
        }
        return {};
      },
    );
    const result = await executeBrowserCommandOnView(makeView({ cdpSend: send }), {
      method: "type",
      text: "guest-only",
    });

    expect(result.ok).toBe(true);
    expect(send).toHaveBeenCalledWith(
      "Runtime.evaluate",
      expect.objectContaining({
        expression: expect.stringContaining("guest-only"),
        returnByValue: true,
      }),
      "oopif-session",
    );
    expect(send).toHaveBeenCalledWith("Target.detachFromTarget", {
      sessionId: "oopif-session",
    });
    expect(send).not.toHaveBeenCalledWith("Input.insertText", expect.anything());
  });

  it("press Enter 映射为 windowsVirtualKeyCode:13 的 keyDown+keyUp", async () => {
    const send = vi.fn(async () => ({}));
    const view = makeView({ cdpSend: send });
    const r = await executeBrowserCommandOnView(view, {
      method: "press",
      key: "Enter",
    });
    expect(r.ok).toBe(true);
    expect(send).toHaveBeenCalledWith("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
    });
    expect(send).toHaveBeenCalledWith("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
    });
  });

  it("scroll {y:300} 发 CDP mouseWheel deltaY:300", async () => {
    const send = vi.fn(async () => ({}));
    const view = makeView({ cdpSend: send });
    const r = await executeBrowserCommandOnView(view, {
      method: "scroll",
      y: 300,
    });
    expect(r.ok).toBe(true);
    expect(send).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: 0,
      y: 0,
      deltaX: 0,
      deltaY: 300,
    });
  });

  it("click 用坐标 (x,y) 直接点（不经 resolveRefCenter/executeJavaScript）", async () => {
    const send = vi.fn(async () => ({}));
    const exec = vi.fn(async () => null);
    const view = makeView({ cdpSend: send, executeJavaScript: exec });
    const r = await executeBrowserCommandOnView(view, {
      method: "click",
      x: 120,
      y: 240,
    });
    expect(r.ok).toBe(true);
    // 坐标路不解析 ref。
    expect(exec).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: 120,
      y: 240,
      button: "left",
      clickCount: 1,
    });
  });

  it("click 带 modifiers(Control+Shift) 映射位掩码 2|8=10 传给 dispatchMouseEvent", async () => {
    const send = vi.fn(async () => ({}));
    const view = makeView({ cdpSend: send });
    const r = await executeBrowserCommandOnView(view, {
      method: "click",
      x: 10,
      y: 20,
      modifiers: ["Control", "Shift"],
    });
    expect(r.ok).toBe(true);
    expect(send).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: 10,
      y: 20,
      button: "left",
      clickCount: 1,
      modifiers: 10,
    });
  });

  it("click ref 与 (x,y) 都缺 → execution_error（不发鼠标事件）", async () => {
    const send = vi.fn(async () => ({}));
    const view = makeView({ cdpSend: send });
    const r = await executeBrowserCommandOnView(view, { method: "click" });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("execution_error");
    expect(send).not.toHaveBeenCalled();
  });

  it("press 带 modifiers(Meta) 映射位掩码 4 传给 dispatchKeyEvent", async () => {
    const send = vi.fn(async () => ({}));
    const view = makeView({ cdpSend: send });
    const r = await executeBrowserCommandOnView(view, {
      method: "press",
      key: "Enter",
      modifiers: ["Meta"],
    });
    expect(r.ok).toBe(true);
    expect(send).toHaveBeenCalledWith("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      modifiers: 4,
    });
  });

  it("CUA keypress 按顺序按下组合键并逆序释放", async () => {
    const send = vi.fn(async () => ({}));
    const result = await executeBrowserCommandOnView(
      makeView({ cdpSend: send }),
      {
        method: "cuaKeypress",
        keys: ["Control", "Shift", "A"],
      },
    );
    expect(result.ok).toBe(true);
    const keyEvents = send.mock.calls
      .filter((call) => call[0] === "Input.dispatchKeyEvent")
      .map((call) => call[1]);
    expect(keyEvents).toEqual([
      expect.objectContaining({
        type: "keyDown",
        key: "Control",
        modifiers: 2,
      }),
      expect.objectContaining({ type: "keyDown", key: "Shift", modifiers: 10 }),
      expect.objectContaining({ type: "keyDown", key: "A", modifiers: 10 }),
      expect.objectContaining({ type: "keyUp", key: "A", modifiers: 10 }),
      expect.objectContaining({ type: "keyUp", key: "Shift", modifiers: 2 }),
      expect.objectContaining({ type: "keyUp", key: "Control" }),
    ]);
  });

  it("CUA scroll 在 Electron guest 中用 mouseWheel 保留锚点、delta 和 modifiers", async () => {
    const send = vi.fn(async () => ({}));
    const result = await executeBrowserCommandOnView(
      makeView({ cdpSend: send }),
      {
        method: "cuaScroll",
        x: 120,
        y: 240,
        scrollX: 30,
        scrollY: -80,
        modifiers: ["Shift"],
      },
    );
    expect(result.ok).toBe(true);
    expect(send).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 120,
      y: 240,
      modifiers: 8,
    });
    expect(send).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: 120,
      y: 240,
      deltaX: 30,
      deltaY: -80,
      modifiers: 8,
    });
    expect(send).not.toHaveBeenCalledWith("Input.synthesizeScrollGesture", expect.anything());
  });

  it("DOM CUA scroll 使用 node 中心或 viewport 中心作为锚点", async () => {
    const nodeSend = vi.fn(async () => ({}));
    const nodeResult = await executeBrowserCommandOnView(
      makeView({
        cdpSend: nodeSend,
        executeJavaScript: vi.fn(async () => ({ cx: 20, cy: 40 })),
      }),
      { method: "domCuaScroll", nodeId: "e1", scrollX: 0, scrollY: 50 },
    );
    expect(nodeResult.ok).toBe(true);
    expect(nodeSend).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: 20,
      y: 40,
      deltaX: 0,
      deltaY: 50,
    });

    const pageSend = vi.fn(async (method: string) =>
      method === "Page.getLayoutMetrics"
        ? { cssVisualViewport: { clientWidth: 800, clientHeight: 600 } }
        : {},
    );
    const pageResult = await executeBrowserCommandOnView(
      makeView({ cdpSend: pageSend }),
      {
        method: "domCuaScroll",
        scrollX: 10,
        scrollY: 20,
      },
    );
    expect(pageResult.ok).toBe(true);
    expect(pageSend).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: 400,
      y: 300,
      deltaX: 10,
      deltaY: 20,
    });
  });

  it("hover 用坐标发 CDP mouseMoved", async () => {
    const send = vi.fn(async () => ({}));
    const view = makeView({ cdpSend: send });
    const r = await executeBrowserCommandOnView(view, {
      method: "hover",
      x: 33,
      y: 44,
    });
    expect(r.ok).toBe(true);
    expect(send).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 33,
      y: 44,
    });
  });

  it("hover 用 ref 经 resolveRefCenter 再 mouseMoved", async () => {
    const send = vi.fn(async () => ({}));
    const view = makeView({
      cdpSend: send,
      executeJavaScript: vi.fn(async () => ({ cx: 7, cy: 8 })),
    });
    const r = await executeBrowserCommandOnView(view, {
      method: "hover",
      ref: "e1",
    });
    expect(r.ok).toBe(true);
    expect(send).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 7,
      y: 8,
    });
  });

  it("hover ref 与坐标都缺 → execution_error", async () => {
    const view = makeView();
    const r = await executeBrowserCommandOnView(view, { method: "hover" });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("execution_error");
  });

  it("select 注入脚本(含 __zcodeRefs)，脚本回 ok → ok:true", async () => {
    const exec = vi.fn(async () => ({ ok: true }));
    const view = makeView({ executeJavaScript: exec });
    const r = await executeBrowserCommandOnView(view, {
      method: "select",
      ref: "e1",
      values: ["opt-a"],
    });
    expect(r.ok).toBe(true);
    const script = exec.mock.calls[0][0] as string;
    expect(script).toContain("__zcodeRefs");
    // values 经 JSON.stringify 内插。
    expect(script).toContain('["opt-a"]');
  });

  it("select 脚本回 ref_not_found → ref_not_found", async () => {
    const view = makeView({
      executeJavaScript: vi.fn(async () => ({ error: "ref_not_found" })),
    });
    const r = await executeBrowserCommandOnView(view, {
      method: "select",
      ref: "e404",
      values: ["x"],
    });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("ref_not_found");
  });

  it("select 非 select 元素 / 无匹配 → execution_error", async () => {
    const notSelect = makeView({
      executeJavaScript: vi.fn(async () => ({ error: "not_select" })),
    });
    const r1 = await executeBrowserCommandOnView(notSelect, {
      method: "select",
      ref: "e1",
      values: ["x"],
    });
    expect(r1.ok).toBe(false);
    expect(r1.error?.code).toBe("execution_error");

    const noMatch = makeView({
      executeJavaScript: vi.fn(async () => ({ error: "no_match" })),
    });
    const r2 = await executeBrowserCommandOnView(noMatch, {
      method: "select",
      ref: "e1",
      values: ["x"],
    });
    expect(r2.ok).toBe(false);
    expect(r2.error?.code).toBe("execution_error");
  });

  it("check 注入脚本(含 checked 目标)，脚本回 ok → ok:true", async () => {
    const exec = vi.fn(async () => ({ ok: true, checked: true }));
    const view = makeView({ executeJavaScript: exec });
    const r = await executeBrowserCommandOnView(view, {
      method: "check",
      ref: "e1",
      checked: true,
    });
    expect(r.ok).toBe(true);
    const script = exec.mock.calls[0][0] as string;
    expect(script).toContain("__zcodeRefs");
    expect(script).toContain("var want=true");
  });

  it("check 非 checkbox/radio → execution_error；ref 未找到 → ref_not_found", async () => {
    const notCheck = makeView({
      executeJavaScript: vi.fn(async () => ({ error: "not_checkable" })),
    });
    const r1 = await executeBrowserCommandOnView(notCheck, {
      method: "check",
      ref: "e1",
    });
    expect(r1.ok).toBe(false);
    expect(r1.error?.code).toBe("execution_error");

    const gone = makeView({
      executeJavaScript: vi.fn(async () => ({ error: "ref_not_found" })),
    });
    const r2 = await executeBrowserCommandOnView(gone, {
      method: "check",
      ref: "e9",
    });
    expect(r2.ok).toBe(false);
    expect(r2.error?.code).toBe("ref_not_found");
  });

  it("drag from/to 坐标发 mousePressed@from → mouseReleased@to（含插值 mouseMoved）", async () => {
    const send = vi.fn(async () => ({}));
    const view = makeView({ cdpSend: send });
    const r = await executeBrowserCommandOnView(view, {
      method: "drag",
      from: { x: 0, y: 0 },
      to: { x: 100, y: 50 },
    });
    expect(r.ok).toBe(true);
    expect(send).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: 0,
      y: 0,
      button: "left",
      clickCount: 1,
    });
    expect(send).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: 100,
      y: 50,
      button: "left",
      clickCount: 1,
    });
    // 至少发过若干插值 mouseMoved（buttons:1）。
    const moves = send.mock.calls.filter(
      (c) =>
        c[0] === "Input.dispatchMouseEvent" &&
        (c[1] as { type?: string }).type === "mouseMoved",
    );
    expect(moves.length).toBeGreaterThanOrEqual(10);
  });

  it("CUA drag 保留调用方完整 path，不重建为首尾直线", async () => {
    const send = vi.fn(async () => ({}));
    const path = [
      { x: 1, y: 2 },
      { x: 8, y: 30 },
      { x: 21, y: 13 },
    ];
    const result = await executeBrowserCommandOnView(
      makeView({ cdpSend: send }),
      {
        method: "cuaDrag",
        path,
        modifiers: ["Alt"],
      },
    );
    expect(result.ok).toBe(true);
    const movedPoints = send.mock.calls
      .filter(
        (call) =>
          call[0] === "Input.dispatchMouseEvent" &&
          (call[1] as { type?: string; buttons?: number }).type ===
            "mouseMoved" &&
          (call[1] as { buttons?: number }).buttons === 1,
      )
      .map((call) => ({
        x: (call[1] as { x: number }).x,
        y: (call[1] as { y: number }).y,
      }));
    expect(movedPoints).toEqual(path.slice(1));
    expect(send).toHaveBeenCalledWith(
      "Input.dispatchMouseEvent",
      expect.objectContaining({
        type: "mouseReleased",
        x: 21,
        y: 13,
        modifiers: 1,
      }),
    );
  });

  it("drag fromRef 解析失败 → ref_not_found（不发鼠标事件）", async () => {
    const send = vi.fn(async () => ({}));
    const view = makeView({
      cdpSend: send,
      executeJavaScript: vi.fn(async () => null),
    });
    const r = await executeBrowserCommandOnView(view, {
      method: "drag",
      fromRef: "e404",
      to: { x: 1, y: 1 },
    });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("ref_not_found");
    expect(send).not.toHaveBeenCalled();
  });

  it("drag 缺终点 → execution_error", async () => {
    const view = makeView();
    const r = await executeBrowserCommandOnView(view, {
      method: "drag",
      from: { x: 0, y: 0 },
    });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("execution_error");
  });

  it("screenshot clip → Page.captureScreenshot 带 clip{...,scale:1}", async () => {
    const send = vi.fn(async () => ({ data: "PNG" }));
    const view = makeView({ cdpSend: send });
    const r = await executeBrowserCommandOnView(view, {
      method: "screenshot",
      clip: { x: 1, y: 2, width: 30, height: 40 },
    });
    expect(r.ok).toBe(true);
    expect(send).toHaveBeenCalledWith("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: { x: 1, y: 2, width: 30, height: 40, scale: 1 },
    });
  });

  it("screenshot fullPage → 先 getLayoutMetrics 再用 contentSize 作 clip", async () => {
    const send = vi.fn(async (method: string) => {
      if (method === "Page.getLayoutMetrics") {
        return { cssContentSize: { x: 0, y: 0, width: 800, height: 2000 } };
      }
      return { data: "FULLPNG" };
    });
    const view = makeView({ cdpSend: send });
    const r = await executeBrowserCommandOnView(view, {
      method: "screenshot",
      fullPage: true,
    });
    expect(r.ok).toBe(true);
    expect(r.image?.base64).toBe("FULLPNG");
    expect(send).toHaveBeenCalledWith("Page.getLayoutMetrics");
    expect(send).toHaveBeenCalledWith("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: 800, height: 2000, scale: 1 },
    });
  });

  it("getState 补 scroll/viewport 字段（executeJavaScript 读窗口信息）", async () => {
    const view = makeView({
      executeJavaScript: vi.fn(async () => ({
        scrollX: 5,
        scrollY: 600,
        innerWidth: 1280,
        innerHeight: 720,
      })),
    });
    const r = await executeBrowserCommandOnView(view, { method: "getState" });
    expect(r.ok).toBe(true);
    expect(r.state?.scrollX).toBe(5);
    expect(r.state?.scrollY).toBe(600);
    expect(r.state?.viewportWidth).toBe(1280);
    expect(r.state?.viewportHeight).toBe(720);
  });

  it("elementInfo 命中元素 → result.element（复用快照元素结构）", async () => {
    const view = makeView({
      executeJavaScript: vi.fn(async () => ({
        ref: "p1",
        tag: "a",
        role: "link",
        name: "Home",
        selector: "#home",
        xpath: "//*[@id='home']",
        rect: { x: 10, y: 20, width: 40, height: 12 },
        inViewport: true,
      })),
    });
    const r = await executeBrowserCommandOnView(view, {
      method: "elementInfo",
      x: 15,
      y: 25,
    });
    expect(r.ok).toBe(true);
    expect(r.element?.ref).toBe("p1");
    expect(r.element?.role).toBe("link");
  });

  it("elementInfo 未命中(null) → ok:true 且无 element", async () => {
    const view = makeView({ executeJavaScript: vi.fn(async () => null) });
    const r = await executeBrowserCommandOnView(view, {
      method: "elementInfo",
      x: 0,
      y: 0,
    });
    expect(r.ok).toBe(true);
    expect(r.element).toBeUndefined();
  });

  it("evaluate JSON 结果 → result.value 反序列化", async () => {
    const exec = vi.fn(async () => ({
      ok: true,
      kind: "json",
      data: '{"a":1,"b":[2,3]}',
    }));
    const view = makeView({ executeJavaScript: exec });
    const r = await executeBrowserCommandOnView(view, {
      method: "evaluate",
      expression: "({a:1,b:[2,3]})",
    });
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ a: 1, b: [2, 3] });
    // 表达式被包进只读 IIFE。
    const script = exec.mock.calls[0][0] as string;
    expect(script).toContain("return (({a:1,b:[2,3]})");
  });

  it("evaluate 不可序列化 → 返回 String() 结果", async () => {
    const view = makeView({
      executeJavaScript: vi.fn(async () => ({
        ok: true,
        kind: "str",
        data: "function foo(){}",
      })),
    });
    const r = await executeBrowserCommandOnView(view, {
      method: "evaluate",
      expression: "foo",
    });
    expect(r.ok).toBe(true);
    expect(r.value).toBe("function foo(){}");
  });

  it("evaluate 页面抛错 → execution_error", async () => {
    const view = makeView({
      executeJavaScript: vi.fn(async () => ({
        ok: false,
        message: "x is not defined",
      })),
    });
    const r = await executeBrowserCommandOnView(view, {
      method: "evaluate",
      expression: "x.y",
    });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("execution_error");
    expect(r.error?.message).toContain("x is not defined");
  });
});
