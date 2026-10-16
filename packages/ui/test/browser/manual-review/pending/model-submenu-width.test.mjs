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
const entry = "/packages/ui/test/browser/manual-review/pending/model-submenu-width.fixture.tsx";
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

const artifacts = join(tmpdir(), "zcode-model-submenu-width");
for (const width of [390, 1200]) {
  for (const theme of ["light", "dark"]) {
    for (const name of ["short", "long", "extreme"]) {
      test(`model submenu ${width}/${theme}/${name}`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 700 } });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        try {
          await page.goto(`${origin}fixture?theme=${theme}&name=${name}`);
          await page.getByRole("button", { name: "Models", exact: true }).click();
          const provider = page.locator("[data-model-provider-key=custom]");
          await provider.focus();
          await page.keyboard.press("ArrowRight");
          const menu = page.locator('[data-slot="dropdown-menu-sub-content"]');
          await menu.waitFor();
          await menu.evaluate(async (element) => {
            await Promise.allSettled(
              element.getAnimations().map((animation) => animation.finished),
            );
          });
          // Radix 在内容测量后更新碰撞位置；等待定位与入场动画完成再检查几何边界。
          await page.waitForFunction(() => {
            const element = document.querySelector('[data-slot="dropdown-menu-sub-content"]');
            if (!element) return false;
            const rect = element.getBoundingClientRect();
            return (
              rect.left >= 0 &&
              rect.right <= innerWidth &&
              element.getAnimations().every((animation) => animation.playState !== "running")
            );
          });
          const label = menu.locator("span[title]").filter({ hasText: "GLM" }).last();
          const metrics = await label.evaluate((element) => {
            const menu = element.closest('[data-slot="dropdown-menu-sub-content"]');
            const rect = menu.getBoundingClientRect();
            return {
              width: rect.width,
              left: rect.left,
              right: rect.right,
              clipped: element.scrollWidth > element.clientWidth,
              overflow: menu.scrollWidth > menu.clientWidth,
            };
          });
          assert.ok(metrics.left >= 0 && metrics.right <= width, JSON.stringify(metrics));
          assert.equal(metrics.overflow, false);
          if (width === 1200 && name !== "extreme") {
            assert.ok(metrics.width >= 192);
            assert.equal(metrics.clipped, false, JSON.stringify(metrics));
            if (name === "long") assert.ok(metrics.width > 192);
          }
          await mkdir(artifacts, { recursive: true });
          await page.screenshot({ path: join(artifacts, `${width}-${theme}-${name}.png`) });
          await menu.getByRole("menuitemradio").last().click();
          await page.getByTestId("selected").filter({ hasText: "vision" }).waitFor();
          assert.deepEqual(errors, []);
        } finally {
          await page.close();
        }
      });
    }
  }
}
