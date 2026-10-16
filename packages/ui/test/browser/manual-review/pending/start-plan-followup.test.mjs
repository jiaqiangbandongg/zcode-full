import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry = "/packages/ui/test/browser/manual-review/pending/start-plan-followup.fixture.tsx";
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
        name: "start-plan-followup-fixture",
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

const artifacts = join(tmpdir(), "zcode-start156-browser");
for (const [width, locale, theme] of [
  [390, "zh-CN", "light"],
  [390, "en-US", "dark"],
  [1200, "zh-CN", "dark"],
  [1200, "en-US", "light"],
]) {
  for (const family of ["bigmodel", "zai"]) {
    for (const state of [
      "disconnected",
      "notPurchased",
      "checking",
      "purchased",
      "pending",
      "empty",
      "unavailable",
      "expired",
    ]) {
      test(`SF-05/08/10/11 ${family}/${state}/${width}/${locale}/${theme}`, async () => {
        await mkdir(artifacts, { recursive: true });
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        const errors = [];
        page.on("pageerror", (error) => errors.push(String(error)));
        try {
          const query = new URLSearchParams({ family, state, locale, theme });
          await page.goto(`${origin}fixture?${query}`);
          const trigger = page.getByRole("combobox");
          await trigger.waitFor();
          assert.equal(await trigger.getAttribute("data-placeholder"), null);
          assert.match(await trigger.innerText(), /InternationalResearch/);
          assert.ok(
            (await page.getByTestId("model-label").innerText()).includes(
              locale === "zh-CN" ? "GLM-5.3(团队套餐)" : "GLM-5.3(Team Plan)",
            ),
          );
          if (["disconnected", "unavailable", "expired"].includes(state)) {
            const name =
              state === "unavailable"
                ? locale === "zh-CN"
                  ? "重试"
                  : "Retry"
                : state === "expired"
                  ? locale === "zh-CN"
                    ? "重新登录"
                    : "Sign in again"
                  : locale === "zh-CN"
                    ? "登录"
                    : "Log in";
            await page.getByRole("button", { name, exact: true }).click();
            assert.equal(await page.getByTestId("actions").innerText(), "1");
          }
          if (state === "notPurchased")
            assert.ok(
              (await page.locator("main").innerText()).includes(
                locale === "zh-CN" ? "暂无可用体验套餐" : "No available Start Plan",
              ),
            );
          if (state === "pending")
            assert.match(
              await page.locator("main").innerText(),
              locale === "zh-CN" ? /待生效/ : /Pending/,
            );
          if (state === "empty") assert.match(await page.locator("main").innerText(), /0%/);
          const bounds = await page.evaluate(() => ({
            width: innerWidth,
            scroll: document.documentElement.scrollWidth,
          }));
          assert.ok(bounds.scroll <= bounds.width, JSON.stringify(bounds));
          await page.screenshot({
            path: join(artifacts, `${family}-${state}-${width}-${locale}-${theme}.png`),
            fullPage: true,
          });
          assert.deepEqual(errors, []);
        } finally {
          await page.close();
        }
      });
    }
  }
}
