import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry = "/packages/ui/test/browser/manual-review/pending/plugin-installed-strip.fixture.tsx";
let server;
let browser;
let origin;

before(async () => {
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "responsive-fixture",
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith("/fixture?")) return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await vite.transformIndexHtml(
                req.url,
                `<html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
              ),
            );
          });
        },
      },
    ],
    resolve: { alias: { "@": `${root}packages/ui/src` } },
    optimizeDeps: { entries: [entry.slice(1)] },
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  origin = server.resolvedUrls.local[0];
  browser = await chromium.launch(
    process.env.CHROME_EXECUTABLE_PATH
      ? { executablePath: process.env.CHROME_EXECUTABLE_PATH }
      : { channel: "chrome" },
  );
});

after(async () => {
  await browser?.close();
  await server?.close();
});

const artifacts = join(tmpdir(), "zcode-plugin-strip-clipping");
for (const width of [390, 1200]) {
  for (const locale of ["en-US", "zh-CN"]) {
    for (const theme of ["light", "dark"]) {
      test(`PLM-CARD-ACTIONS ${width}/${locale}/${theme}`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 700 } });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        try {
          await page.goto(`${origin}fixture?locale=${locale}&theme=${theme}`);
          const badges = page.getByTestId("plugin-store-card-update");
          await badges.first().waitFor();
          assert.equal(await page.getByTestId("plugin-store-installed-strip").count(), 0);
          // 插件管理入口已移到页头操作组；列表首行只有来源分段与搜索。
          assert.equal(await page.getByTestId("plugin-store-manage-open").count(), 0);
          assert.equal(await page.getByTestId("plugin-store-search").count(), 1);
          for (const badge of [badges.first(), badges.last()]) {
            await badge.scrollIntoViewIfNeeded();
            await badge.focus();
            const bounds = await badge.boundingBox();
            assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
          }
          await badges.last().click();
          assert.equal(
            await page.getByTestId("updated").textContent(),
            await badges.last().getAttribute("data-plugin-id"),
          );
          assert.equal(await page.getByTestId("opened").textContent(), "");
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            true,
          );
          assert.deepEqual(errors, []);
          await mkdir(artifacts, { recursive: true });
          await page.screenshot({ path: join(artifacts, `${width}-${locale}-${theme}.png`) });
        } finally {
          await page.close();
        }
      });
    }
  }
}

for (const [width, locale, theme] of [
  [1200, "en-US", "light"],
  [390, "zh-CN", "dark"],
]) {
  test(`PLM-UI-PREVIEW ${width}/${locale}/${theme}`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("https://example.com/panel.png", (route) =>
      route.fulfill({
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jH+cAAAAASUVORK5CYII=",
          "base64",
        ),
      }),
    );
    try {
      await page.goto(`${origin}fixture?detail=1&locale=${locale}&theme=${theme}`);
      await page.getByTestId("plugin-store-ui-capability").waitFor();
      const preview = page.getByTestId("plugin-store-preview-open");
      await preview.click();
      await page.getByRole("dialog").waitFor();
      assert.equal(await page.getByRole("dialog").getByRole("img").getAttribute("alt"), "Panel");
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      assert.equal(await preview.evaluate((element) => element === document.activeElement), true);
      await page.getByTestId("plugin-store-open-ui").click();
      assert.equal(await page.getByTestId("opened").textContent(), "plugin-00@personal");
      assert.equal(await page.getByTestId("plugin-store-try-now").count(), 0);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });
}

for (const [width, locale, theme] of [
  [1200, "en-US", "light"],
  [390, "zh-CN", "dark"],
]) {
  test(`PLM-UI-DETAILS ${width}/${locale}/${theme}`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    try {
      await page.goto(`${origin}fixture?ui=1&paused=1&locale=${locale}&theme=${theme}`);
      // 卡片整行进入详情，不再有独立「详情」按钮；进入详情不打开也不启用 UI。
      assert.equal(await page.getByTestId("plugin-store-ui-details").count(), 0);
      const card = page.getByTestId("plugin-store-card");
      await card.focus();
      await page.keyboard.press("Enter");
      await page.getByTestId("plugin-store-detail").waitFor();
      assert.equal(await page.getByTestId("ui-opened").textContent(), "");
      await page.getByTestId("plugin-store-ui-capability").waitFor();
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
    } finally {
      await page.close();
    }
  });
}

for (const [width, locale, theme] of [
  [1200, "en-US", "light"],
  [390, "zh-CN", "dark"],
]) {
  test(`PLM-UI-MAIN-NAV ${width}/${locale}/${theme}`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    try {
      // 主导航市场：已安装 UI 插件只有更多菜单，整行进详情，详情恢复「立即试用」。
      await page.goto(`${origin}fixture?ui=1&mainNav=1&locale=${locale}&theme=${theme}`);
      await page.getByTestId("plugin-store-card").waitFor();
      assert.equal(await page.getByTestId("plugin-store-open-ui").count(), 0);
      assert.equal(await page.getByTestId("plugin-store-ui-details").count(), 0);
      await page.getByTestId("plugin-store-card").click();
      await page.getByTestId("plugin-store-detail").waitFor();
      assert.equal(await page.getByTestId("ui-opened").textContent(), "");
      assert.equal(await page.getByTestId("plugin-store-open-ui").count(), 0);
      assert.equal(await page.getByTestId("plugin-store-try-now").count(), 1);
      await mkdir(artifacts, { recursive: true });
      await page.screenshot({
        path: join(artifacts, `main-nav-detail-${width}-${locale}-${theme}.png`),
      });
    } finally {
      await page.close();
    }
  });
}
