import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";

interface LocalChromiumPage extends Page {
  _connection?: {
    toImpl?(page: Page): {
      delegate?: {
        _mainFrameSession?: {
          _client?: {
            send(method: string, params: { enabled: boolean }): Promise<void>;
          };
        };
      };
    };
  };
}

async function useNativeVisibility(page: Page) {
  // Playwright在主CDP session强制focus emulation，使后台tab也永远visible。
  // 新CDP session不能撤销原session的覆盖；只关闭本地driver原始session的测试仿真，
  // 后续完全使用Chrome真实tab切换，不修改document getter或派发visibility事件。
  const local = page as LocalChromiumPage;
  const client = local._connection?.toImpl?.(page)?.delegate?._mainFrameSession?._client;
  if (typeof client?.send !== "function")
    throw new Error(
      "MRO03: Playwright local Chromium visibility ABI changed; native visibility is required",
    );
  await client.send("Emulation.setFocusEmulationEnabled", { enabled: false });
}

/** 使用成熟导航与清理流程，仅撤销测试框架强制前台；浏览器仍是真实headed Chrome。 */
export async function createWebRemoteVisibilityBrowser(artifactDir: string) {
  const executablePath =
    process.env.ZCODE_E2E_MOBILE_BROWSER_EXECUTABLE || process.env.R3_MOBILE_CHROME;
  const chrome = await chromium.launch({
    ...(executablePath ? { executablePath } : { channel: "chrome" }),
    headless: false,
  });
  const context = await chrome.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: "zh-CN",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  let logFlight = Promise.resolve();
  const recordEvent = (stage: string, detail?: unknown) => {
    logFlight = logFlight.then(() =>
      appendFile(
        join(artifactDir, "MRO03-native-stages.jsonl"),
        JSON.stringify({ stage, detail }) + "\n",
      ),
    );
    return logFlight;
  };
  const record = async (stage: string) =>
    recordEvent(stage, {
      visibility: await page.evaluate(() => document.visibilityState),
    });
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame())
      void recordEvent("main-frame-navigated", { path: new URL(frame.url()).pathname });
  });
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame())
      void recordEvent("document-request", { path: new URL(request.url()).pathname });
  });
  page.on("console", (message) => {
    if (message.text().startsWith("[vite]"))
      void recordEvent("vite-client", {
        text: message.text().replace(/https?:\/\/[^\s]+/gu, "<url>"),
      });
  });
  page.on("crash", () => {
    void recordEvent("page-crashed");
  });
  page.on("close", () => {
    void recordEvent("page-closed");
  });
  let cover: Page | undefined;
  return {
    evaluate: <T>(expression: string) => page.evaluate<T, void>(expression, undefined),
    async navigate(url: string, credentials: Record<string, string>) {
      await context.addInitScript((values) => {
        if (!location.protocol.startsWith("http")) return;
        for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value);
      }, credentials);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await useNativeVisibility(page);
      await page.bringToFront();
      await record("native-navigation");
    },
    async click(selector: string) {
      await page.locator(selector).first().click();
    },
    async hide() {
      cover ??= await context.newPage();
      await useNativeVisibility(cover);
      await cover.bringToFront();
      await page.waitForFunction(() => document.visibilityState === "hidden");
      await record("native-background");
    },
    async show() {
      await page.bringToFront();
      await page.waitForFunction(() => document.visibilityState === "visible");
      await record("native-foreground");
    },
    async escape() {
      await page.keyboard.press("Escape");
    },
    async screenshot(name: string) {
      await page.screenshot({ path: join(artifactDir, name) });
    },
    async close() {
      await context.close();
      await chrome.close();
      await logFlight;
    },
  };
}
