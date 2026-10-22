import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry =
  "/packages/ui/test/browser/manual-review/pending/tool-presentation-failures.fixture.tsx";
const artifacts = join(tmpdir(), "tool-presentation-failures");
let server, browser, origin;
before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "share-selection-fixture",
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

for (const width of [390, 1200])
  for (const theme of ["light", "dark"])
    for (const locale of ["zh-CN", "en-US"])
      for (const failure of ["result", "reject"]) {
        test(`SHARE-REVIEW ${width} ${theme} ${locale} ${failure}`, async () => {
          const page = await browser.newPage({ viewport: { width, height: 900 } });
          const errors = [],
            warnings = [];
          page.on("pageerror", (error) => errors.push(error.message));
          page.on("console", (message) => {
            if (message.type() === "warning") warnings.push(message.text());
          });
          await page.goto(`${origin}fixture?theme=${theme}&locale=${locale}&failure=${failure}`);
          const preview = page.getByTestId("image-preview");
          await preview.getByText(locale === "en-US" ? /Loading/ : /加载/).waitFor();
          await page.getByRole("button", { name: "failure", exact: true }).click();
          await preview
            .getByText(locale === "en-US" ? "Could not load preview" : "预览加载失败")
            .waitFor();
          await page.getByRole("button", { name: "empty", exact: true }).click();
          await preview
            .getByText(locale === "en-US" ? "Preview unavailable" : "预览不可用")
            .waitFor();
          await page.getByRole("button", { name: "success", exact: true }).click();
          await preview.getByRole("img").waitFor();
          const src = await preview.getByRole("img").getAttribute("src");
          await page.getByRole("button", { name: "release old", exact: true }).click();
          assert.equal(await preview.getByRole("img").getAttribute("src"), src);
          await page.locator('[data-testid="file-card"] button[aria-haspopup="menu"]').click();
          assert.equal(await page.getByRole("menuitem", { name: /Word/ }).count(), 0);
          await page.getByRole("menuitem", { name: /VS Code/ }).click();
          await page
            .getByText(locale === "en-US" ? "Could not open this file" : "无法打开此文件", {
              exact: true,
            })
            .waitFor();
          assert.equal(
            JSON.parse(await page.locator("#opened").innerText()).remoteTarget.kind,
            "ssh",
          );
          assert.ok(warnings.some((line) => line.includes("内嵌图片读取失败")));
          assert.ok(warnings.some((line) => line.includes("第三方 App 打开文件失败")));
          assert.deepEqual(errors, []);
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
            false,
          );
          await page.evaluate(async () => {
            await Promise.all(
              document.getAnimations().map((animation) => animation.finished.catch(() => {})),
            );
          });
          await page.screenshot({
            path: join(artifacts, `${width}-${theme}-${locale}-${failure}.png`),
            fullPage: true,
          });
          await page.close();
        });
      }
