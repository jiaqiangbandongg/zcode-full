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
const entry = "/packages/ui/test/browser/manual-review/pending/share-failure.fixture.tsx";
const artifacts = join(tmpdir(), "share-failure-0917");
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

for (const kind of ["invalid_contract", "network"])
  for (const width of [390, 1200])
    for (const theme of ["light", "dark"])
      for (const locale of ["zh-CN", "en-US"])
        test(`SHARE33 ${kind} ${width} ${theme} ${locale}`, async () => {
          const page = await browser.newPage({ viewport: { width, height: 900 } });
          const errors = [];
          page.on("pageerror", (error) => errors.push(String(error)));
          await page.goto(`${origin}fixture?kind=${kind}&theme=${theme}&locale=${locale}`);
          const message = page.getByTestId("conversation-share-error-message");
          await message.waitFor();
          assert.match(
            await message.innerText(),
            locale === "zh-CN"
              ? kind === "network"
                ? /中断或超时/
                : /接口异常（HTTP 405）/
              : kind === "network"
                ? /interrupted or timed out/
                : /returned HTTP 405/,
          );
          assert.doesNotMatch(
            await page.locator("body").innerText(),
            /安全检查失败|Safety checks failed|包含内嵌图片|内容需要调整/,
          );
          await page.getByTestId("conversation-share-request-id-trigger").click();
          const details = page.getByTestId("conversation-share-request-id-content");
          await details.waitFor();
          const text = await details.innerText();
          for (const id of ["server-request-33", "client-request-33", "share-operation-33"])
            assert.ok(text.includes(id));
          assert.ok(text.includes(kind === "invalid_contract" ? "405" : "200"));
          await page.evaluate(async () => {
            await Promise.all(
              document.getAnimations().map((animation) => animation.finished.catch(() => {})),
            );
          });
          await page.screenshot({
            path: join(artifacts, `${kind}-${width}-${theme}-${locale}.png`),
            fullPage: true,
          });
          await page.keyboard.press("Escape");
          await page.getByTestId("conversation-share-confirm").click();
          assert.equal(await page.getByTestId("attempts").innerText(), "1");
          assert.ok((await page.getByText("9 / 9", { exact: false }).count()) > 0);
          assert.deepEqual(errors, []);
          await page.close();
        });
