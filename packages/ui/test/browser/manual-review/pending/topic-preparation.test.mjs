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
const entry = "/packages/ui/test/browser/manual-review/pending/topic-preparation.fixture.tsx";
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

const artifacts = join(tmpdir(), "zcode-topic-preparation");
for (const width of [390, 1200]) {
  for (const locale of ["en-US", "zh-CN"]) {
    for (const theme of ["light", "dark"]) {
      test(`BOT-UI-TP-PREPARATION ${width}/${locale}/${theme}`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 1000 } });
        page.setDefaultTimeout(5000);
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        try {
          await page.goto(`${origin}fixture?locale=${locale}&theme=${theme}`);
          const first = page.locator('[data-topic-preparation="first"]');
          const bubble = first.locator("[data-v4-user-input-bubble]");
          await bubble.waitFor();
          const formal = page.getByTestId("formal").locator("[data-v4-user-input-bubble]");
          const style = (locator) =>
            locator.evaluate((el) => {
              const s = getComputedStyle(el);
              const r = el.getBoundingClientRect();
              return {
                width: r.width,
                background: s.backgroundColor,
                radius: s.borderRadius,
                padding: s.padding,
                font: s.fontSize,
              };
            });
          assert.deepEqual(await style(bubble), await style(formal));
          const sourceBounds = await first.locator("[data-topic-preparation-source]").boundingBox();
          const bubbleBounds = await bubble.boundingBox();
          assert.ok(sourceBounds.y + sourceBounds.height <= bubbleBounds.y);
          const loading = first.locator("[data-topic-preparation-loading]");
          assert.equal(
            await loading.evaluate((el) => Boolean(el.closest("[data-topic-preparation-source]"))),
            true,
          );
          assert.equal(await bubble.locator("[data-topic-preparation-loading]").count(), 0);
          assert.equal(
            await bubble.textContent(),
            locale === "zh-CN" ? "北京今天天气如何？" : "What is the weather in Beijing today?",
          );
          assert.ok(
            (await first.locator("[data-topic-preparation-source]").textContent()).includes(
              locale === "zh-CN" ? "飞书 · 莫汝舰" : "Feishu · 莫汝舰",
            ),
          );
          const label = locale === "zh-CN" ? "正在准备材料" : "Preparing materials";
          await loading.hover();
          await page.getByRole("tooltip", { name: label, exact: true }).waitFor();
          await page.mouse.move(0, 0);
          await loading.focus();
          await page.getByRole("tooltip", { name: label, exact: true }).waitFor();
          await loading.evaluate((el) => el.blur());
          await page.getByRole("tooltip").waitFor({ state: "hidden" });
          assert.equal(
            await page
              .locator('[data-topic-preparation="empty"] [data-v4-user-input-bubble]')
              .count(),
            0,
          );
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            true,
          );
          for (const el of await page
            .locator("[data-topic-preparation] [data-v4-user-input-bubble]")
            .all()) {
            const bounds = await el.boundingBox();
            assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
            assert.equal(await el.evaluate((node) => node.scrollWidth <= node.clientWidth), true);
          }
          const waiting = page.locator('[data-topic-preparation="waiting"]');
          const expand = waiting.getByRole("button", {
            name: locale === "zh-CN" ? "展开" : "Expand",
            exact: true,
          });
          await expand.waitFor();
          await expand.click();
          await page.waitForFunction(() => {
            const content = document.querySelector(
              '[data-topic-preparation="waiting"] [data-v4-user-input-collapsible-content]',
            );
            return content && content.clientHeight >= content.scrollHeight - 1;
          });
          assert.equal(await waiting.getByRole("button").getAttribute("aria-expanded"), "true");
          await mkdir(artifacts, { recursive: true });
          await page.screenshot({
            path: join(artifacts, `${width}-${locale}-${theme}.png`),
            fullPage: true,
          });
          assert.equal(await page.locator('[data-topic-preparation="failed"]').count(), 0);
          assert.equal(await page.locator("[data-topic-preparation-status]").count(), 0);
          await page.getByRole("button", { name: "Fail waiting" }).click();
          await waiting.waitFor({ state: "detached" });
          assert.equal(await page.getByText("failed after preparing").count(), 0);
          await page.getByRole("button", { name: "Accept first" }).click();
          await first.waitFor({ state: "detached" });
          assert.equal(await page.locator("[data-topic-preparation]").count(), 1);
          assert.deepEqual(errors, []);
        } finally {
          await page.close();
        }
      });
    }
  }
}
