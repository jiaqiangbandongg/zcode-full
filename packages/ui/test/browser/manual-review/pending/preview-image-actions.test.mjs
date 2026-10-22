import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry = "/packages/ui/test/browser/manual-review/pending/preview-image-actions.fixture.tsx";
const artifacts = join(root, "packages/desktop/.e2e-artifacts/preview-image-actions-browser");
let server, browser, origin;
before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      {
        name: "image-actions-fixture",
        enforce: "pre",
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith("/fixture?")) return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await vite.transformIndexHtml(
                req.url,
                `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"/></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
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

test("PIA03 outside image keeps its absolute target through the composer event", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 844 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  try {
    await page.goto(`${origin}fixture?source=outside&locale=zh-CN`);
    await page
      .waitForFunction(() => document.querySelector("img")?.naturalWidth > 0)
      .catch((error) => {
        throw new Error(`${error}; page errors: ${errors.join("; ")}`);
      });
    await page.locator("img").click({ button: "right" });
    await page.locator('[role="menuitem"][data-image-preview-add]').click();
    await page.waitForFunction(() =>
      document.querySelector("textarea")?.value.includes("drawing.svg"),
    );
    assert.equal(
      await page.getByRole("textbox", { name: "Draft" }).inputValue(),
      "existing draft [drawing.svg](/outside/drawing.svg)",
    );
    await page.screenshot({ path: join(artifacts, "outside-image-reference.png") });
  } finally {
    await page.close();
  }
});

for (const width of [390, 1100])
  for (const theme of ["light", "dark"])
    for (const locale of ["zh-CN", "en-US"]) {
      test(`PIA04 image actions ${width}/${theme}/${locale}`, async () => {
        const context = await browser.newContext({
          viewport: { width, height: 844 },
          hasTouch: width === 390,
          isMobile: width === 390,
          permissions: ["clipboard-read", "clipboard-write"],
          acceptDownloads: true,
        });
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(String(error)));
        try {
          await page.goto(`${origin}fixture?theme=${theme}&locale=${locale}`);
          await page.waitForFunction(() => document.querySelector("img")?.naturalWidth > 0);
          const openMenu = async () => {
            if (width === 390)
              await page
                .getByRole("button", { name: locale === "zh-CN" ? "图片操作" : "Image actions" })
                .click();
            else await page.locator("img").click({ button: "right" });
            await page.locator('[role="menuitem"][data-image-preview-copy]').waitFor();
          };
          await openMenu();
          assert.equal(await page.locator('[role="menuitem"]').count(), 3);
          await page.screenshot({ path: join(artifacts, `${width}-${theme}-${locale}.png`) });
          await page.locator('[role="menuitem"][data-image-preview-copy]').click();
          await page
            .getByText(locale === "zh-CN" ? "图片已复制" : "Image copied", { exact: true })
            .waitFor();
          assert.deepEqual(
            await page.evaluate(async () => {
              const item = (await navigator.clipboard.read())[0];
              const image = await createImageBitmap(await item.getType("image/png"));
              return [image.width, image.height];
            }),
            [480, 300],
          );
          await openMenu();
          const downloaded = page.waitForEvent("download");
          await page.locator('[role="menuitem"][data-image-preview-download]').click();
          const file = await downloaded;
          assert.equal(file.suggestedFilename(), "drawing.svg");
          const source = decodeURIComponent(
            (await page.locator("img").getAttribute("src")).split(",").slice(1).join(","),
          );
          assert.equal(await readFile(await file.path(), "utf8"), source);
          await openMenu();
          await page.locator('[role="menuitem"][data-image-preview-add]').click();
          assert.match(
            await page.getByRole("textbox", { name: "Draft" }).inputValue(),
            /^existing draft .*drawing\.svg/,
          );
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
            false,
          );
          assert.deepEqual(errors, []);
        } finally {
          await context.close();
        }
      });
    }
