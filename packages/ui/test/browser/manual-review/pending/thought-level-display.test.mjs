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
const entry = "/packages/ui/test/browser/manual-review/pending/thought-level-display.fixture.tsx";
const artifacts = join(tmpdir(), "todo153-thought-level-display");
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
        name: "thought-level-display-fixture",
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

for (const width of [390, 1200]) {
  for (const theme of ["light", "dark"]) {
    for (const locale of ["zh-CN", "en-US"]) {
      test(`TL-01/02 ${width}/${theme}/${locale}`, async () => {
        const page = await browser.newPage({
          viewport: { width, height: 850 },
          hasTouch: width === 390,
        });
        const errors = [];
        page.on("pageerror", (error) => errors.push(String(error)));
        page.setDefaultTimeout(10000);
        const activate = (locator) => (width === 390 ? locator.tap() : locator.click());
        const waitValue = async (value) => {
          await page.waitForFunction(
            (expected) =>
              document.querySelector('[data-testid="committed"]').textContent === expected,
            value,
          );
          assert.equal(await page.getByTestId("value").textContent(), value);
        };
        const label =
          locale === "zh-CN"
            ? [
                "关闭",
                "极低",
                "低",
                "中",
                "高",
                "极高",
                "最高",
                "极致",
                "极高",
                "极高",
                "Provider default",
              ]
            : [
                "Off",
                "Minimal",
                "Low",
                "Medium",
                "High",
                "Extra high",
                "Max",
                "Ultra",
                "Extra high",
                "Extra high",
                "Provider default",
              ];
        try {
          await page.goto(`${origin}fixture?${new URLSearchParams({ theme, locale })}`);
          const trigger = page.getByTestId("select").getByRole("combobox");
          await trigger.waitFor();
          assert.equal(await trigger.getAttribute("aria-label"), label[1]);
          assert.equal(await page.getByTestId("committed").textContent(), "");
          await activate(trigger);
          await page.getByRole("listbox").waitFor();
          assert.deepEqual(await page.getByRole("option").allTextContents(), label);
          await page.getByRole("listbox").evaluate(async (element) => {
            await Promise.allSettled(
              element.getAnimations({ subtree: true }).map((animation) => animation.finished),
            );
          });
          const box = await page.getByRole("listbox").boundingBox();
          assert.ok(box.x >= 0 && box.x + box.width <= width, JSON.stringify(box));
          await page.screenshot({
            animations: "disabled",
            path: join(artifacts, `${width}-${theme}-${locale}-menu.png`),
          });
          await activate(page.getByTestId("chat-thought-level-select-item-ultra"));
          await waitValue("ultra");
          assert.equal(await trigger.getAttribute("aria-label"), label[7]);

          // 使用生产快捷键 hook；这里的顺序能区分配置顺序与旧名称排序。
          await page.keyboard.press("Control+t");
          await waitValue("extra-high");
          assert.equal(await trigger.getAttribute("aria-expanded"), "false");
          await activate(page.getByTestId("cycle").getByRole("button"));
          await waitValue("extra_high");
          await page.keyboard.press("Control+t");
          await waitValue("default");
          assert.equal(await trigger.getAttribute("aria-label"), "Provider default");
          await page.keyboard.press("Control+t");
          await waitValue("nothink");
          assert.equal(await trigger.getAttribute("aria-label"), label[0]);

          const subagent = page.getByTestId("subagent").getByRole("combobox");
          assert.equal(await subagent.getAttribute("aria-label"), label[0]);
          await activate(subagent);
          await page.getByRole("listbox").waitFor();
          assert.deepEqual(await page.getByRole("option").allTextContents(), label);
          await activate(page.getByTestId("chat-thought-level-select-item-minimal"));
          await waitValue("minimal");
          assert.equal(await subagent.getAttribute("aria-label"), label[1]);
          // 桌面用真实键盘选择；手机用触控，均应提交 low 原值。
          if (width === 1200) {
            await trigger.focus();
            await page.keyboard.press("ArrowDown");
            await page.getByRole("listbox").waitFor();
            // Radix 在定位完成后聚焦当前项，需等实际焦点落定再发送下一次按键。
            await page.waitForFunction(
              () =>
                document.activeElement?.getAttribute("data-testid") ===
                "chat-thought-level-select-item-minimal",
            );
            await page.keyboard.press("ArrowDown");
            await page.waitForFunction(
              () =>
                document.activeElement?.getAttribute("data-testid") ===
                "chat-thought-level-select-item-low",
            );
            await page.keyboard.press("Enter");
          } else {
            await activate(trigger);
            await activate(page.getByTestId("chat-thought-level-select-item-low"));
          }
          await waitValue("low");
          assert.equal(await trigger.getAttribute("aria-label"), label[2]);
          await page.screenshot({
            animations: "disabled",
            path: join(artifacts, `${width}-${theme}-${locale}-selected.png`),
          });
          assert.deepEqual(errors, []);
        } finally {
          await writeFile(
            join(artifacts, `${width}-${theme}-${locale}.log`),
            JSON.stringify({ errors }, null, 2),
          );
          await page.close();
        }
      });
    }
  }
}
