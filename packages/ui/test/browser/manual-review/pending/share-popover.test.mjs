import { registerShareDisclosureTests } from "./share-disclosure-feedback.mjs";
import { registerShareBoundaryTests } from "./share-selection-boundaries.mjs";
import assert from "node:assert/strict";
import { verifySelectionSelectAll } from "./share-selection-all.mjs";
import { verifySelectionScrollMask } from "./share-selection-mask.mjs";
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
const entry = "/packages/ui/test/browser/manual-review/pending/share-popover.fixture.tsx";
const artifacts = join(tmpdir(), "share-popover-0923");
let server, browser, origin;
registerShareBoundaryTests(() => ({ browser, origin }));
registerShareDisclosureTests(() => ({ browser, origin }));
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
      test(`SHARE34 ${width} ${theme} ${locale}`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        page.setDefaultTimeout(5000);
        const errors = [];
        page.on("pageerror", (error) => errors.push(String(error)));
        await page.goto(`${origin}fixture?theme=${theme}&locale=${locale}`);
        const popover = page.getByTestId("conversation-share-popover");
        const panel = page.getByTestId("conversation-share-selection-panel");
        await page.getByTestId("conversation-share-trigger").click();
        await popover.waitFor();
        await page.evaluate(async () => {
          await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {})));
        });
        const scopeButton = page.getByTestId("conversation-share-adjust");
        const normalBounds = await popover.boundingBox();
        await page.getByTestId("conversation-share-confirm").click();
        const disclosure = page.getByTestId("conversation-share-disclosure");
        const reviewCheckbox = page.getByTestId("conversation-share-disclosure-checkbox");
        assert.equal(await reviewCheckbox.getAttribute("aria-invalid"), "true");
        assert.equal(await disclosure.evaluate((node) => node.getAnimations().length), 0);
        assert.equal(await page.getByTestId("conversation-share-publish-progress").count(), 0);
        assert.deepEqual(await popover.boundingBox(), normalBounds);
        await reviewCheckbox.check();
        assert.equal(await reviewCheckbox.getAttribute("aria-invalid"), "false");
        assert.equal(await page.getByTestId("conversation-share-publish-progress").count(), 0);
        await reviewCheckbox.uncheck();
        await page.getByTestId("conversation-share-confirm").click();
        await popover.screenshot({
          path: join(artifacts, `${width}-${theme}-${locale}-unchecked.png`),
        });
        await page.getByTestId("conversation-share-disclosure-scope-trigger").click();
        const reviewScope = page.getByTestId("conversation-share-disclosure-scope-content");
        await reviewScope.waitFor();
        await page.evaluate(async () => {
          await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {})));
        });
        await reviewScope.screenshot({
          path: join(artifacts, `${width}-${theme}-${locale}-scope.png`),
        });
        const reviewBounds = await reviewScope.boundingBox();
        assert.ok(reviewBounds.x >= 0 && reviewBounds.x + reviewBounds.width <= width + 1);
        assert.ok(reviewBounds.y >= 0 && reviewBounds.y + reviewBounds.height <= 901);
        await page.keyboard.press("Escape");
        await reviewScope.waitFor({ state: "hidden" });
        assert.equal(await popover.isVisible(), true);
        const scopeArrow = await scopeButton.locator("svg").last().boundingBox();
        const selectArrow = await popover.getByRole("combobox").locator("svg").last().boundingBox();
        assert.equal(scopeArrow.width, selectArrow.width);
        assert.ok(Math.abs(scopeArrow.x - selectArrow.x) < 1);
        await page.getByTestId("toggle-preflight").click();
        assert.equal(await scopeButton.getAttribute("aria-busy"), "true");
        assert.match(
          await scopeButton.innerText(),
          locale === "zh-CN" ? /正在检查分享内容/ : /checking/i,
        );
        assert.equal(
          await page.getByTestId("conversation-share-selection-preflight-status").count(),
          0,
        );
        assert.equal((await popover.boundingBox()).height, normalBounds.height);
        await page.getByTestId("toggle-preflight").click();
        assert.equal(await scopeButton.getAttribute("aria-busy"), "false");
        await page.getByTestId("conversation-share-adjust").click();
        await panel.waitFor();
        await page.evaluate(async () => {
          await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {})));
        });
        const rows = panel.locator("[data-conversation-share-selection-item]");
        const previews = rows.getByTestId("conversation-share-selection-toggle");
        const firstTitle = previews.nth(0).locator("span").first();
        const secondTitle = previews.nth(1).locator("span").first();
        assert.equal((await firstTitle.boundingBox()).x, (await secondTitle.boundingBox()).x);
        const titleRect = await firstTitle.boundingBox();
        const checkRect = await rows.nth(0).getByRole("checkbox").boundingBox();
        const firstMessage = previews.nth(0).locator("span").last();
        const messageRect = await firstMessage.boundingBox();
        assert.equal(messageRect.x, titleRect.x);
        assert.equal((await panel.boundingBox()).width, Math.min(320, width - 16));
        assert.equal(messageRect.height, 32);
        assert.ok(
          await firstMessage.evaluate(
            (node) =>
              node.scrollHeight > node.clientHeight &&
              getComputedStyle(node).webkitLineClamp === "2",
          ),
        );
        assert.ok(
          Math.abs(checkRect.y + checkRect.height / 2 - titleRect.y - titleRect.height / 2) < 1,
        );
        assert.deepEqual(
          await firstTitle.evaluate((node) => ({
            size: getComputedStyle(node).fontSize,
            weight: getComputedStyle(node).fontWeight,
          })),
          { size: "14px", weight: "400" },
        );
        assert.equal(
          await firstMessage.evaluate((node) => getComputedStyle(node).fontSize),
          "12px",
        );
        assert.equal(
          (await page.getByTestId("conversation-share-selection-apply").boundingBox()).height,
          32,
        );
        assert.equal(
          (await page.getByTestId("conversation-share-selection-cancel").boundingBox()).height,
          32,
        );
        await panel.screenshot({
          path: join(artifacts, `${width}-${theme}-${locale}-selector.png`),
        });
        await verifySelectionScrollMask(
          panel,
          join(artifacts, `${width}-${theme}-${locale}-mask.png`),
        );
        await verifySelectionSelectAll(panel);
        const checkbox = rows.first().getByRole("checkbox");
        await checkbox.click();
        assert.match(await page.getByTestId("conversation-share-range-summary").innerText(), /8/);
        assert.equal(await page.getByTestId("conversation-share-confirm").isDisabled(), true);
        await rows.first().getByTestId("conversation-share-selection-locate").click();
        assert.equal(await page.getByTestId("inspected").innerText(), "1");
        assert.equal(await panel.isVisible(), true);
        await page.getByTestId("conversation-share-selection-cancel").click();
        await panel.waitFor({ state: "hidden" });
        await page.getByTestId("conversation-share-adjust").click();
        await panel.waitFor();
        assert.equal(await checkbox.getAttribute("data-state"), "checked");
        await checkbox.click();
        await page.getByTestId("conversation-share-selection-apply").click();
        await panel.waitFor({ state: "hidden" });
        assert.match(await page.getByTestId("conversation-share-range-summary").innerText(), /7/);
        await page.getByTestId("conversation-share-adjust").click();
        await panel.waitFor();
        await page.keyboard.press("Escape");
        await panel.waitFor({ state: "hidden" });
        assert.equal(await popover.isVisible(), true);
        await page.keyboard.press("Escape");
        await popover.waitFor({ state: "hidden" });
        await page.getByTestId("conversation-share-trigger").click();
        await popover.waitFor();
        assert.match(await page.getByTestId("conversation-share-range-summary").innerText(), /7/);
        await page.evaluate(async () => {
          await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {})));
        });
        await page.screenshot({ path: join(artifacts, `${width}-${theme}-${locale}.png`) });
        const bounds = await popover.boundingBox();
        await page.screenshot({
          path: join(artifacts, `${width}-${theme}-${locale}-popover.png`),
          clip: {
            x: Math.max(0, bounds.x - 8),
            y: Math.max(0, bounds.y - 8),
            width: bounds.width + 16,
            height: bounds.height + 16,
          },
        });
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
        await page.getByTestId("conversation-share-adjust").click();
        await panel.waitFor();
        await page.getByRole("textbox", { name: "Composer", exact: true }).click();
        await panel.waitFor({ state: "hidden" });
        assert.equal(await popover.isVisible(), true);
        await page.getByRole("textbox", { name: "Composer", exact: true }).click();
        await popover.waitFor({ state: "hidden" });
        await page.getByTestId("conversation-share-trigger").click();
        await popover.waitFor();
        await page.getByTestId("conversation-share-adjust").click();
        await panel.waitFor();
        assert.equal(await rows.last().getByRole("checkbox").isDisabled(), true);
        const checks = rows.getByRole("checkbox");
        for (let i = 0; i < 8; i++) {
          if ((await checks.nth(i).getAttribute("data-state")) === "checked")
            await checks.nth(i).click();
        }
        assert.equal(
          await page.getByTestId("conversation-share-selection-apply").isDisabled(),
          true,
        );
        await page.evaluate(async () => {
          await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {})));
        });
        await page.screenshot({
          path: join(artifacts, `${width}-${theme}-${locale}-selection.png`),
        });
        const footer = await page.getByTestId("conversation-share-selection-footer").boundingBox();
        assert.ok(footer.y >= 0 && footer.y + footer.height <= 900);
        await page.getByTestId("conversation-share-selection-cancel").click();
        await panel.waitFor({ state: "hidden" });
        await popover.getByRole("checkbox").check();
        await page.getByTestId("conversation-share-confirm").click();
        await page.getByTestId("conversation-share-publish-progress").waitFor();
        assert.equal(await page.getByTestId("conversation-share-confirm").count(), 0);
        const readTypeSizes = () =>
          popover.evaluate((node) => {
            const size = (selector) => getComputedStyle(node.querySelector(selector)).fontSize;
            return {
              title: size('[data-testid="conversation-share-confirmation-header"] p'),
              task: size('[data-testid="conversation-share-publish-progress"] > p'),
              phase: size('[data-testid="conversation-share-publish-phase-collecting"] strong'),
              progress: size(
                '[data-testid="conversation-share-publish-phase-collecting"] strong + span',
              ),
              summary: size('[data-testid="conversation-share-confirmation-actions"] > p'),
            };
          });
        assert.deepEqual(await readTypeSizes(), {
          title: "16px",
          task: "14px",
          phase: "14px",
          progress: "14px",
          summary: "12px",
        });
        const progressIcon = page
          .getByTestId("conversation-share-publish-phase-collecting")
          .locator("svg");
        const iconSize = await progressIcon.evaluate((node) => getComputedStyle(node).width);
        await page.evaluate(() =>
          document.documentElement.style.setProperty("--ui-font-size", "18px"),
        );
        assert.deepEqual(await readTypeSizes(), {
          title: "20px",
          task: "18px",
          phase: "18px",
          progress: "18px",
          summary: "16px",
        });
        assert.equal(await progressIcon.evaluate((node) => getComputedStyle(node).width), iconSize);
        await page.evaluate(() => document.documentElement.style.removeProperty("--ui-font-size"));
        for (const phase of ["collecting", "uploading", "checking"]) {
          if (phase !== "collecting") await page.getByTestId("advance-publish").click();
          assert.equal(
            await page
              .getByTestId(`conversation-share-publish-phase-${phase}`)
              .getAttribute("data-phase-state"),
            "active",
          );
          await popover.screenshot({
            path: join(artifacts, `${width}-${theme}-${locale}-${phase}.png`),
          });
        }
        await page.keyboard.press("Escape");
        assert.equal(await popover.isVisible(), true);
        assert.equal(await page.getByTestId("conversation-share-trigger").isDisabled(), true);
        await page.getByTestId("resolve-publish").click();
        await page.getByTestId("conversation-share-success-dock").waitFor();
        await page.getByTestId("conversation-share-copy-link").click();
        assert.match(
          await page.getByTestId("conversation-share-copy-link").innerText(),
          locale === "zh-CN" ? /已复制/ : /copied/i,
        );
        assert.equal(await popover.isVisible(), true);
        await page.evaluate(async () => {
          await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {})));
        });
        await page.screenshot({ path: join(artifacts, `${width}-${theme}-${locale}-success.png`) });
        await popover.screenshot({
          path: join(artifacts, `${width}-${theme}-${locale}-success-popover.png`),
        });
        const openButton = await page.getByTestId("conversation-share-open-browser").boundingBox();
        const copyButton = await page.getByTestId("conversation-share-copy-link").boundingBox();
        assert.equal(openButton.height, 40);
        assert.equal(copyButton.height, 40);
        assert.ok(Math.abs(openButton.width - copyButton.width) < 1);
        const linkInput = popover.getByRole("textbox");
        assert.equal((await linkInput.boundingBox()).height, 32);
        await linkInput.focus();
        assert.equal(
          await linkInput.evaluate((input) => input.selectionEnd - input.selectionStart),
          (await linkInput.inputValue()).length,
        );
        await page.getByTestId("conversation-share-success-dismiss").click();
        await popover.waitFor({ state: "hidden" });
        await page.getByTestId("conversation-share-trigger").click();
        await popover.waitFor();
        assert.equal(await page.getByTestId("conversation-share-success-dock").count(), 0);
        assert.equal(await popover.getByRole("checkbox").isChecked(), false);
        assert.match(await page.getByTestId("conversation-share-range-summary").innerText(), /8/);
        await page.getByTestId("conversation-share-adjust").click();
        await panel.waitFor();
        await rows.first().getByRole("checkbox").click();
        await page.getByTestId("conversation-share-selection-apply").click();
        await panel.waitFor({ state: "hidden" });
        await popover.getByRole("checkbox").check();
        await page.getByTestId("conversation-share-confirm").click();
        await page.getByTestId("conversation-share-publish-progress").waitFor();
        await page.getByTestId("resolve-publish").click();
        await page.getByTestId("conversation-share-success-dock").waitFor();
        assert.deepEqual(errors, []);
        await page.close();
      });
