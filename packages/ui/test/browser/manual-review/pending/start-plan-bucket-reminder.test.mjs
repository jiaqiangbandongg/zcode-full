import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry =
  "/packages/ui/test/browser/manual-review/pending/start-plan-bucket-reminder.fixture.tsx";
const artifacts = process.env.START_PLAN_ARTIFACTS ?? join(tmpdir(), "zcode-start-plan-reminder");
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
        name: "start-plan-fixture",
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

for (const width of [390, 1200])
  for (const locale of ["zh-CN", "en-US"])
    for (const theme of ["light", "dark"]) {
      test(`SPB01/02/03 ${width}/${locale}/${theme}`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 700 } });
        const logs = [],
          errors = [];
        page.on("console", (message) => logs.push(message.text()));
        page.on("pageerror", (error) => {
          errors.push(String(error));
          logs.push(error.stack ?? String(error));
        });
        page.setDefaultTimeout(15000);
        try {
          await page.goto(`${origin}fixture?locale=${locale}&theme=${theme}`);
          await page.getByTestId("pane").waitFor();
          const banner = page.getByTestId("v4-session-quota-banner");
          const closeName = locale === "zh-CN" ? "关闭" : "Close";
          async function update(bucket, value) {
            const prior = await page.getByTestId("revision").textContent();
            await page.getByTestId(bucket).selectOption(String(value));
            await page.waitForFunction(
              (previous) =>
                document.querySelector('[data-testid="revision"]').textContent !== previous,
              prior,
            );
          }
          for (const value of [50, 48, 47, 20, 10.1]) {
            await update("event", value);
            assert.equal(await banner.count(), 0);
          }
          await update("event", 10);
          await banner.waitFor();
          assert.match(
            await banner.innerText(),
            locale === "zh-CN" ? /活动额度剩余 10%/ : /promotional quota remaining/,
          );
          await page.screenshot({ path: join(artifacts, `${width}-${locale}-${theme}.png`) });
          await update("event", 9);
          assert.equal(await banner.count(), 1);
          await banner.getByRole("button", { name: closeName, exact: true }).click();
          await banner.waitFor({ state: "hidden" });
          await update("event", 10);
          assert.equal(await banner.count(), 0);
          await page.getByRole("button", { name: "Switch task", exact: true }).click();
          await page.getByRole("button", { name: "Toggle pane", exact: true }).click();
          await page.getByRole("button", { name: "Toggle pane", exact: true }).click();
          assert.equal(await banner.count(), 0);
          await page.reload();
          await page.getByTestId("pane").waitFor();
          await update("event", 9);
          assert.equal(await banner.count(), 0);
          await update("event", 0);
          assert.equal(await banner.count(), 0);
          await update("daily", 10);
          await banner.waitFor();
          assert.match(
            await banner.innerText(),
            locale === "zh-CN" ? /今日额度剩余 10%/ : /daily quota remaining/,
          );
          await page.getByRole("button", { name: "Switch task", exact: true }).click();
          await banner.waitFor({ state: "hidden" });
          await page.getByRole("button", { name: "New cycle", exact: true }).click();
          await banner.waitFor();
          await banner
            .getByRole("button", { name: locale === "zh-CN" ? "升级" : "Upgrade", exact: true })
            .click();
          assert.equal(await page.locator("body").getAttribute("data-upgraded"), "true");
          await update("daily", 100);
          await banner.waitFor({ state: "hidden" });
          await update("daily", 10);
          assert.equal(await banner.count(), 0, "同一周期恢复后再次降低不能重复提醒");
          await update("daily", 0);
          assert.equal(await page.getByTestId("kind").textContent(), "model-exhausted");
          await update("other", 0);
          assert.equal(await page.getByTestId("kind").textContent(), "daily-exhausted");
          assert.deepEqual(errors, []);
        } finally {
          await writeFile(join(artifacts, `${width}-${locale}-${theme}.log`), logs.join("\n"));
          await page.close();
        }
      });
    }

// CR-01：真实 hook + Banner 使用快照时钟；Renderer 重载保留 localStorage。
for (const deviceTime of [4102444900000, 4102444600000]) {
  test(`SPB04 clock skew ${deviceTime}`, async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 700 } });
    const logs = [];
    page.on("console", (message) => logs.push(message.text()));
    try {
      await page.addInitScript((value) => {
        Date.now = () => value;
      }, deviceTime);
      await page.goto(`${origin}fixture?locale=en-US&theme=dark&serverTime=4102444700000`);
      const banner = page.getByTestId("v4-session-quota-banner");
      await page.getByTestId("event").selectOption("10");
      await banner.waitFor();
      await banner.getByRole("button", { name: "Close", exact: true }).click();
      await banner.waitFor({ state: "hidden" });
      assert.ok(
        await page.evaluate(() =>
          Object.keys(localStorage).some((key) => key.includes("fixture-event")),
        ),
      );
      await page.getByRole("button", { name: "Switch task", exact: true }).click();
      assert.equal(await banner.count(), 0);
      await page.reload();
      await page.getByTestId("event").selectOption("9");
      await page.waitForFunction(
        () => document.querySelector('[data-testid="revision"]').textContent === "1",
      );
      assert.equal(await banner.count(), 0);
      await page.getByTestId("daily").selectOption("10");
      await banner.waitFor();
      await page.evaluate(() => {
        Date.now = () => 4102445900000;
      });
      await banner.getByRole("button", { name: "Close", exact: true }).click();
      await banner.waitFor({ state: "hidden" });
      await page.getByRole("button", { name: "New cycle", exact: true }).click();
      await banner.waitFor();
      await page.screenshot({ path: join(artifacts, `clock-${deviceTime}.png`) });
    } finally {
      await writeFile(join(artifacts, `clock-${deviceTime}.log`), logs.join("\n"));
      await page.close();
    }
  });
}
