import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";
const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry = "/packages/ui/test/browser/manual-review/pending/permission-full-access.fixture.tsx";
let server, browser, origin;
const artifacts = join(root, "packages/desktop/.e2e-artifacts/permission-full-access-browser");
before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "permission-fixture",
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith("/fixture?")) return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await vite.transformIndexHtml(
                req.url,
                `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
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
  for (const theme of ["light", "dark"]) {
    test(`PA158 shared approval UI ${width}/${theme}`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      try {
        const mobile = width === 390;
        await page.goto(`${origin}fixture?theme=${theme}&locale=${mobile ? "zh-CN" : "en-US"}`);
        const options = page.getByRole("option");
        await options.first().waitFor();
        assert.equal(await options.count(), 4);
        assert.equal(
          await options.nth(1).getAttribute("aria-label"),
          mobile ? "始终允许此命令" : "Always allow this command",
        );
        assert.equal(
          await options.nth(2).getAttribute("aria-label"),
          mobile ? "完全访问" : "Full access",
        );
        await options.first().focus();
        await page.keyboard.press("5");
        // 权限选项通过 RAF 转移焦点，等待真实焦点落点，避免在同帧抢先断言。
        await page.waitForFunction(() => document.activeElement?.tagName === "TEXTAREA");
        assert.equal(
          await page.getByRole("textbox").evaluate((el) => document.activeElement === el),
          true,
        );
        assert.equal(await page.getByTestId("response").textContent(), "");
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        await page.screenshot({ path: join(artifacts, `${width}-${theme}.png`), fullPage: true });
        await options.first().focus();
        await page.keyboard.press("3");
        await page.keyboard.press("Enter");
        await page.waitForFunction(
          () => document.querySelector('[data-testid="response"]')?.textContent === "fullAccess",
        );
        assert.deepEqual(errors, []);
      } finally {
        await page.close();
      }
    });
  }

for (const width of [390, 1200])
  for (const theme of ["light", "dark"]) {
    test(`long permission command ${width}/${theme}`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      try {
        await page.goto(`${origin}fixture?theme=${theme}&command=long`);
        const command = page.getByTestId("execute-command");
        await command.waitFor();
        assert.equal(await page.getByText("没有输出。", { exact: true }).count(), 0);
        const toggle = page.getByRole("button", { name: "展开命令", exact: true });
        await toggle.waitFor();
        assert.equal(await toggle.getAttribute("aria-expanded"), "false");
        assert.equal(
          await toggle.evaluate(
            (el) => el.previousElementSibling?.getAttribute("data-testid") === "execute-command",
          ),
          true,
        );
        const alignment = await toggle.evaluate((el) => {
          const text = el.parentElement.querySelector("pre");
          const range = document.createRange();
          range.selectNodeContents(el.firstChild);
          return Math.abs(range.getBoundingClientRect().left - text.getBoundingClientRect().left);
        });
        assert.ok(alignment < 0.1, `command toggle text alignment: ${alignment}`);
        assert.equal(
          await command.evaluate(
            (el) => el.clientHeight / Number.parseFloat(getComputedStyle(el).lineHeight),
          ),
          3,
        );
        assert.match(
          await toggle.evaluate((el) => getComputedStyle(el).backgroundColor),
          /^rgba\([^,]+, [^,]+, [^,]+, 0\)$/,
        );
        assert.equal(await toggle.locator("svg").count(), 1);
        assert.deepEqual(
          await toggle.evaluate((el) => {
            const style = getComputedStyle(el);
            return [
              el.dataset.variant,
              style.paddingLeft,
              style.paddingRight,
              style.borderLeftWidth,
              style.borderRightWidth,
            ];
          }),
          ["link", "0px", "0px", "0px", "0px"],
        );
        await page.screenshot({
          path: join(artifacts, `command-collapsed-${width}-${theme}.png`),
          fullPage: true,
        });
        await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "option");
        await page.keyboard.press("Shift+Tab");
        assert.equal(await toggle.evaluate((el) => document.activeElement === el), true);
        await page.keyboard.press("Enter");
        assert.equal(
          await page
            .getByRole("button", { name: "收起", exact: true })
            .getAttribute("aria-expanded"),
          "true",
        );
        assert.equal(await page.getByTestId("response").textContent(), "");
        await page.keyboard.press("Tab");
        assert.equal(
          await page
            .getByRole("option")
            .first()
            .evaluate((el) => document.activeElement === el),
          true,
        );
        await page.keyboard.press("Shift+Tab");
        await page.keyboard.press("Shift+Tab");
        assert.equal(await command.evaluate((el) => document.activeElement === el), true);
        const collapse = page.getByRole("button", { name: "收起", exact: true });
        await page.waitForFunction(() => {
          const button = document.querySelector('button[aria-expanded="true"]');
          return (
            button &&
            /^rgba\([^,]+, [^,]+, [^,]+, 0\)$/.test(getComputedStyle(button).backgroundColor)
          );
        });
        assert.equal(await collapse.locator("svg.rotate-180").count(), 1);
        const collapseBefore = await collapse.boundingBox();
        const geometry = await command.evaluate((el) => {
          const card = el.closest('[data-testid="execute-detail"]');
          const style = getComputedStyle(card);
          const rightInset =
            card.getBoundingClientRect().right -
            Number.parseFloat(style.borderRightWidth) -
            el.getBoundingClientRect().right;
          const prompt = el.querySelector('[data-testid="execute-command-prompt"]');
          if (!prompt) throw new Error("Command prompt must be inside the viewport");
          const promptTop = prompt.getBoundingClientRect().top;
          el.scrollTop = el.scrollHeight;
          const promptScrolled =
            prompt.getBoundingClientRect().top < el.getBoundingClientRect().top;
          el.scrollTop = 0;
          const promptRestored = prompt.getBoundingClientRect().top === promptTop;
          el.scrollTop = el.scrollHeight;
          return {
            promptScrolled,
            promptRestored,
            rightInset,
            end: el.scrollTop + el.clientHeight >= el.scrollHeight - 1,
            overflow: getComputedStyle(el).overflowY,
            complete: el.textContent.endsWith('COMMAND_END"'),
          };
        });
        assert.deepEqual(geometry, {
          rightInset: 4,
          end: true,
          overflow: "auto",
          complete: true,
          promptScrolled: true,
          promptRestored: true,
        });
        assert.deepEqual(await collapse.boundingBox(), collapseBefore);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        await page.screenshot({
          path: join(artifacts, `command-${width}-${theme}.png`),
          fullPage: true,
        });
        await page.getByRole("button", { name: "收起", exact: true }).click();
        await page.getByRole("button", { name: "展开命令", exact: true }).waitFor();
        await page.getByRole("option").first().click();
        assert.equal(await page.getByTestId("response").textContent(), "allowOnce");
        await page.goto(`${origin}fixture?theme=${theme}`);
        await page.getByRole("option").first().waitFor();
        assert.equal(await page.getByRole("button", { name: "展开命令", exact: true }).count(), 0);
      } finally {
        await page.close();
      }
    });
  }
