import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry =
  "/packages/ui/test/browser/manual-review/pending/account-provider-key-retry.fixture.tsx";
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
        name: "account-key-retry-fixture",
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
      : {},
  );
});

after(async () => {
  await browser?.close();
  await server?.close();
});

const artifacts = join(tmpdir(), "zcode-todo105-browser");
for (const family of ["zai", "bigmodel"]) {
  for (const [width, locale, theme] of [
    [390, "zh-CN", "light"],
    [1200, "en-US", "dark"],
  ]) {
    test(`T105-UI01 ${family}/${width}/${locale}/${theme}`, async () => {
      await mkdir(artifacts, { recursive: true });
      const page = await browser.newPage({ viewport: { width, height: 700 } });
      const logs = [],
        errors = [];
      page.on("console", (message) => logs.push(message.text()));
      page.on("pageerror", (error) => {
        errors.push(String(error));
        logs.push(String(error));
      });
      page.setDefaultTimeout(15000);
      let release;
      await page.route("**/retry", async (route) => {
        const status = await new Promise((resolve) => {
          release = resolve;
        });
        await route.fulfill({ status, body: "{}", contentType: "application/json" });
      });
      try {
        await page.goto(`${origin}fixture?${new URLSearchParams({ family, locale, theme })}`);
        const retry = page.getByRole("button", {
          name: locale === "zh-CN" ? "重新登录" : "Sign in again",
          exact: true,
        });
        await retry.waitFor();
        await page.screenshot({ path: join(artifacts, `${family}-${width}-failed.png`) });
        assert.match(
          await page.locator("main").innerText(),
          locale === "zh-CN" ? /获取失败/ : /Fetch failed/,
        );
        for (const [count, status] of [
          [1, 503],
          [2, 200],
        ]) {
          const requestArrived = page.waitForRequest("**/retry");
          await retry.click();
          await requestArrived;
          await page.waitForFunction(() => document.querySelector("button").disabled);
          assert.equal(await retry.isDisabled(), true);
          assert.equal(await page.getByTestId("requests").textContent(), String(count));
          assert.equal(await page.getByTestId("logins").textContent(), String(count));
          // 响应由断言后释放，不用固定等待掩盖状态竞态。
          release(status);
          if (status === 503)
            await page.waitForFunction(() => !document.querySelector("button").disabled);
        }
        await retry.waitFor({ state: "hidden" });
        await page
          .getByRole("button", { name: locale === "zh-CN" ? "订阅" : "Subscribe", exact: true })
          .waitFor();
        assert.equal(await page.getByTestId("logins").textContent(), "2");
        assert.deepEqual(errors, []);
        await page.screenshot({ path: join(artifacts, `${family}-${width}.png`) });
      } finally {
        release?.(503);
        await writeFile(join(artifacts, `${family}-${width}.log`), logs.join("\n"));
        await page.close();
      }
    });
  }
}
