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
const entry = "/packages/ui/test/browser/manual-review/pending/channel-mention.fixture.tsx";
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

const artifacts = join(tmpdir(), "zcode-channel-mention");
for (const width of [390, 1200]) {
  for (const theme of ["light", "dark"]) {
    test(`BOT-UI-MN ${width}/${theme}`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 800 } });
      page.setDefaultTimeout(8000);
      try {
        await page.goto(`${origin}fixture?theme=${theme}`);
        await page.locator('[data-channel-mention="feishu"]').first().waitFor();
        assert.equal(await page.locator('[data-channel-mention="feishu"]').count(), 3);
        assert.equal(await page.locator('[data-testid="typed"] [data-channel-mention]').count(), 0);
        assert.equal(
          await page.locator("body").evaluate((el) => el.scrollWidth <= window.innerWidth),
          true,
        );
        const chip = page.locator('[data-channel-mention="feishu"]').first();
        assert.match(await chip.textContent(), /Ryan Bot/);
        assert.equal(await chip.evaluate((el) => getComputedStyle(el).fontStyle), "normal");
        assert.equal(
          await page
            .locator("body")
            .textContent()
            .then((text) => text.includes("ou_target")),
          false,
        );
        await mkdir(artifacts, { recursive: true });
        await page.screenshot({ path: join(artifacts, `${width}-${theme}.png`), fullPage: true });
      } finally {
        await page.close();
      }
    });
  }
}
