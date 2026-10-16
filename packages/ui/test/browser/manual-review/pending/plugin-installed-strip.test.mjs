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
      test(`PLM-STRIP-CLIP ${width}/${locale}/${theme}`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 700 } });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        try {
          await page.goto(`${origin}fixture?locale=${locale}&theme=${theme}`);
          const badges = page.getByTestId("plugin-store-installed-item-update");
          await badges.first().waitFor();
          async function assertUnclipped(locator, inset = 0) {
            const bounds = await locator.evaluate((element, margin) => {
              const viewport = element.closest(
                "[data-testid=plugin-store-installed-strip]",
              ).lastElementChild;
              const r = element.getBoundingClientRect();
              const v = viewport.getBoundingClientRect();
              const point = document.elementFromPoint(r.left + r.width / 2, r.top + 1);
              return {
                top: r.top - margin >= v.top,
                bottom: r.bottom + margin <= v.top + viewport.clientHeight,
                left: r.left - margin >= v.left,
                right: r.right + margin <= v.left + viewport.clientWidth,
                hit: element.contains(point),
                verticalScroll: viewport.scrollHeight > viewport.clientHeight,
              };
            }, inset);
            assert.deepEqual(bounds, {
              top: true,
              bottom: true,
              left: true,
              right: true,
              hit: true,
              verticalScroll: false,
            });
          }
          // 回归：旧 overflow-x-auto 容器会裁去 -top-1 角标的顶部 4px。
          await assertUnclipped(badges.first());
          for (const badge of [badges.first(), badges.last()]) {
            await badge.scrollIntoViewIfNeeded();
            await badge.hover();
            await page.waitForFunction(() =>
              document.getAnimations().every((animation) => animation.playState !== "running"),
            );
            await assertUnclipped(badge, 2);
            await badge.focus();
            await assertUnclipped(badge, 2);
          }
          const icons = page.getByTestId("plugin-store-installed-item");
          for (const icon of [icons.first(), icons.last()]) {
            await icon.scrollIntoViewIfNeeded();
            await icon.hover();
            await page.waitForFunction(() =>
              document.getAnimations().every((animation) => animation.playState !== "running"),
            );
            await assertUnclipped(icon, 2);
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
