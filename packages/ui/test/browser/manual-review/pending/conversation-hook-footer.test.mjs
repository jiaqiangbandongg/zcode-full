// HK08/HK11：桌面及手机展示参数下的真实组件交互；全链路另由 Hooks lifecycle Electron E2E 验证。
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry =
  "/packages/ui/test/browser/manual-review/pending/conversation-hook-footer.fixture.tsx";
const artifacts = join(root, "packages/desktop/.e2e-artifacts/conversation-hook-footer");
let server, browser, origin;
before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      {
        name: "hook-footer-fixture",
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith("/fixture?")) return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await vite.transformIndexHtml(
                req.url,
                `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
              ),
            );
          });
        },
      },
      react(),
      tailwindcss(),
    ],
    resolve: { alias: { "@": `${root}packages/ui/src` } },
    optimizeDeps: { entries: [entry.slice(1)] },
    server: {
      host: "127.0.0.1",
      port: 0,
      hmr: false,
      watch: { ignored: ["**/packages/desktop/out/**", "**/.e2e-artifacts/**"] },
    },
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

for (const mobile of [false, true])
  for (const theme of ["light", "dark"])
    for (const highspeed of [false, true]) {
      test(`HK08/HK11 ${mobile ? "mobile" : "desktop"}/${theme}/${highspeed ? "highspeed-no-text" : "normal"}`, async () => {
        const page = await browser.newPage({
          viewport: { width: mobile ? 390 : 1200, height: 800 },
          isMobile: mobile,
          hasTouch: mobile,
        });
        const errors = [];
        page.on("pageerror", (error) => errors.push(String(error)));
        const prefix = `${mobile ? "mobile" : "desktop"}-${theme}-${highspeed ? "highspeed-no-text" : "normal"}`;
        try {
          await page.goto(
            `${origin}fixture?mobile=${mobile}&theme=${theme}&highspeed=${highspeed}`,
          );
          const turn = page.locator('[data-turn-id="hook-footer"]');
          await turn.waitFor();
          const hook = turn.getByTestId("v4-hook-details-trigger-hook-footer");
          assert.equal(await hook.count(), 1, "同一轮必须恰好一个 Hook 入口");
          assert.equal(
            await turn.locator('[data-highspeed-output-footer="true"]').count(),
            Number(highspeed),
          );
          assert.equal(await turn.getByTestId("v4-copy-4").count(), Number(!highspeed));
          if (!mobile) await turn.hover();
          await hook.waitFor({ state: "visible" });
          await hook.evaluate(async (element) => {
            await Promise.all(
              element.parentElement
                .getAnimations({ subtree: true })
                .map((animation) => animation.finished),
            );
          });
          if (mobile)
            assert.equal(
              await hook.evaluate((e) => getComputedStyle(e.parentElement).opacity),
              "1",
            );
          await page.screenshot({ path: join(artifacts, `${prefix}-footer.png`) });
          await hook.click();
          const details = page.getByTestId("v4-hook-details-content-hook-footer");
          await details.waitFor({ state: "visible" });
          await details.evaluate(async (element) => {
            await Promise.all(
              element.getAnimations({ subtree: true }).map((animation) => animation.finished),
            );
          });
          assert.equal(await details.locator("li").count(), 1);
          assert.match(await details.innerText(), /UserPromptSubmit/);
          assert.match(await details.innerText(), mobile ? /User/ : /用户/);
          const bounds = await details.boundingBox();
          assert.ok(bounds.x >= 8 && bounds.y >= 8);
          assert.ok(bounds.x + bounds.width <= (mobile ? 390 : 1200) - 8);
          assert.ok(bounds.y + bounds.height <= 800 - 8);
          await page.screenshot({ path: join(artifacts, `${prefix}-details.png`) });
          await page.keyboard.press("Escape");
          await details.waitFor({ state: "hidden" });
          assert.deepEqual(errors, []);
        } finally {
          await page.close();
        }
      });
    }
