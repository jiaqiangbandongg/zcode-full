// SPT02：真实工具栏 hook、样式、ResizeObserver 和菜单焦点；不以耗时作为断言。
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry = "/packages/ui/test/browser/manual-review/pending/composer-toolbar-fit.fixture.tsx";
const artifacts = join(root, "packages/desktop/.e2e-artifacts/composer-toolbar-fit");
let server, browser, origin;
before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      {
        name: "toolbar-fixture",
        enforce: "pre",
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

for (const width of [430, 1250])
  for (const theme of ["light", "dark"])
    for (const locale of ["en-US", "zh-CN"]) {
      test(`SPT02 toolbar ${width}/${theme}/${locale}`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 800 } });
        const errors = [];
        page.on("pageerror", (error) => errors.push(String(error)));
        try {
          await page.addInitScript(() => {
            window.__toolbarClones = 0;
            const clone = Node.prototype.cloneNode;
            Node.prototype.cloneNode = function (...args) {
              if (this instanceof HTMLElement && this.dataset.testid === "fit-toolbar")
                window.__toolbarClones++;
              return clone.apply(this, args);
            };
          });
          await page.goto(`${origin}fixture?theme=${theme}&locale=${locale}`);
          const toolbar = page.getByTestId("fit-toolbar");
          const container = page.getByTestId("fit-container");
          const model = page.getByTestId("fit-model");
          await toolbar.waitFor();
          await page.evaluate(() => document.fonts.ready);
          await page.waitForTimeout(100);
          assert.equal(
            await page.evaluate(() => window.__toolbarClones),
            0,
            "完整布局放得下时不应克隆",
          );
          await model.click();
          const option = page.getByRole("menuitem", { name: "Model option" });
          await option.focus();
          await model.evaluate((element) => {
            window.__toolbarModel = element;
          });
          await container.evaluate((element) => {
            element.style.width = "150px";
          });
          await page.waitForFunction(
            () =>
              document.querySelector('[data-testid="fit-toolbar"]').dataset.composerModelIcon ===
              "true",
          );
          assert.equal(await model.getAttribute("aria-expanded"), "true");
          assert.ok(await option.evaluate((element) => element === document.activeElement));
          await container.evaluate((element) => {
            element.style.width = "100%";
          });
          await page.waitForFunction(
            () => !document.querySelector('[data-testid="fit-toolbar"]').dataset.composerModelIcon,
          );
          assert.ok(await model.evaluate((element) => element === window.__toolbarModel));
          assert.equal(await model.getAttribute("aria-expanded"), "true");
          await page.keyboard.press("Escape");
          await page.getByRole("button", { name: "Change label" }).click();
          await page.waitForFunction(
            () =>
              document.querySelector('[data-testid="fit-toolbar"]').dataset.composerModelIcon ===
              "true",
          );
          await page.getByRole("button", { name: "Change label" }).click();
          await page.waitForFunction(
            () => !document.querySelector('[data-testid="fit-toolbar"]').dataset.composerModelIcon,
          );
          assert.deepEqual(errors, []);
          await page.screenshot({ path: join(artifacts, `${width}-${theme}-${locale}.png`) });
        } finally {
          await page.close();
        }
      });
    }
