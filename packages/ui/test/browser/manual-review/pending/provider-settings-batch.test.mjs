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
import { registerProviderPresentationCases } from "./provider-settings-presentation-cases.mjs";
import { registerProviderModelEditorCases } from "./provider-model-editor-cases.mjs";
import { registerProgressiveModelEditorCases } from "./provider-model-editor-progressive-cases.mjs";
import { registerOffPeakEligibilityCases } from "./offpeak-eligibility-cases.mjs";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry = "/packages/ui/test/browser/manual-review/pending/provider-settings-batch.fixture.tsx";
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
        name: "provider-settings-batch-fixture",
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

const artifacts = join(tmpdir(), "zcode-provider-settings-batch");
registerOffPeakEligibilityCases(() => ({ browser, origin }));
registerProviderPresentationCases(() => ({ browser, origin, artifacts }));
registerProviderModelEditorCases(() => ({ browser, origin, artifacts }));
registerProgressiveModelEditorCases(() => ({ browser, origin, artifacts }));
for (const [width, locale, theme] of [
  [390, "zh-CN", "light"],
  [1200, "en-US", "dark"],
]) {
  test(`header name and option feedback ${width}/${theme}`, async () => {
    await mkdir(artifacts, { recursive: true });
    const page = await browser.newPage({ viewport: { width, height: 1100 } });
    const mutations = [],
      errors = [],
      visualEvidence = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.route("**/mutation", async (route) => {
      mutations.push(route.request().postDataJSON());
      await route.fulfill({ status: 200, body: "{}" });
    });
    try {
      await page.goto(
        `${origin}fixture?${new URLSearchParams({ locale, theme, access: "manual", tiles: "1" })}`,
      );
      const menu = page.getByTestId("model-provider-actions-button");
      const toggle = page.getByTestId("model-provider-enabled-switch");
      await menu.waitFor();
      const toggleBox = await toggle.boundingBox(),
        menuBox = await menu.boundingBox();
      assert.ok(toggleBox.x + toggleBox.width <= menuBox.x);
      assert.equal(
        await toggle.getAttribute("data-state"),
        "checked",
        "tooltip must not replace switch state",
      );
      assert.notEqual(
        await toggle.evaluate((node) => getComputedStyle(node).backgroundColor),
        "rgba(0, 0, 0, 0)",
      );
      const expansion = await toggle.evaluate((node) =>
        Number.parseFloat(getComputedStyle(node, "::after").right),
      );
      assert.ok(
        toggleBox.x + toggleBox.width - expansion < menuBox.x,
        "switch expanded hit area must not reach menu",
      );
      assert.equal(
        await toggle.getAttribute("aria-label"),
        locale === "zh-CN" ? "禁用供应商" : "Disable provider",
      );
      const rename = async () => {
        await menu.click();
        await page.getByTestId("model-provider-name-edit-button").click();
        const input = page.getByTestId("model-provider-name-input");
        await page.waitForFunction(
          () => document.activeElement?.dataset.testid === "model-provider-name-input",
        );
        return input;
      };
      let input = await rename();
      await input.fill("Cancelled name");
      await page.waitForTimeout(1600);
      assert.equal(mutations.length, 0, "name idle must not save");
      await input.press("Escape");
      await page.waitForTimeout(1300);
      assert.equal(mutations.length, 0, "cancel must not save later");
      input = await rename();
      await input.fill("Confirmed Provider with a deliberately long name");
      await input.press("Enter");
      await page
        .getByTestId("model-provider-header")
        .getByText("Confirmed Provider with a deliberately long name", { exact: true })
        .waitFor();
      assert.equal(mutations.length, 1);
      assert.equal(
        mutations[0].payload.providerNameUpdate,
        "Confirmed Provider with a deliberately long name",
      );
      assert.equal(mutations[0].payload.enabledUpdate, undefined);
      assert.equal(await toggle.getAttribute("aria-checked"), "true");
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      const style = (node) => {
        const css = getComputedStyle(node),
          icon = node.querySelector("svg");
        return {
          background: css.backgroundColor,
          color: css.color,
          border: css.borderColor,
          width: node.getBoundingClientRect().width,
          height: node.getBoundingClientRect().height,
          icon: icon ? getComputedStyle(icon).color : null,
        };
      };
      const checkIndicator = async (tile, selected) => {
        const box = tile.locator("[data-model-option-checkbox]");
        const actual = await box.evaluate(style);
        const reference = await page
          .getByTestId(selected ? "system-checkbox-on" : "system-checkbox-off")
          .evaluate(style);
        assert.equal(actual.border, reference.border, "indicator border matches system checkbox");
        assert.equal(
          actual.background,
          reference.background,
          "indicator fill matches system checkbox",
        );
        assert.equal(actual.width, 16);
        assert.equal(actual.height, 16);
        assert.equal(await box.getAttribute("aria-hidden"), "true");
        assert.equal(await box.locator("button, input, [tabindex]").count(), 0);
        if (selected) {
          assert.equal(actual.color, reference.color);
          assert.equal(
            actual.border,
            actual.background,
            "selected border must not follow tick color",
          );
          assert.notEqual(actual.icon, actual.background);
          assert.equal(
            await box.locator("svg").evaluate((node) => node.getBoundingClientRect().width),
            12,
          );
        } else {
          assert.equal(actual.icon, null);
        }
      };
      for (const tile of [
        page.locator('[data-model-input-modality="image"]'),
        page.getByRole("checkbox", { name: "Capability" }),
        page.getByRole("checkbox", { name: "System messages" }),
      ]) {
        await tile.hover();
        await page.waitForTimeout(180);
        const off = await tile.evaluate(style);
        await checkIndicator(tile, false);
        await tile.click();
        await page.waitForTimeout(180);
        const on = await tile.evaluate(style);
        await checkIndicator(tile, true);
        assert.notEqual(on.background, off.background, "same-pointer click must change background");
        // Todo134：选中时出现勾选图标是新预期，外层控件的文字/边框/尺寸仍不得跳变。
        for (const key of ["color", "border", "width", "height"])
          assert.equal(on[key], off[key], key);
        await page.screenshot({
          path: join(artifacts, `selected-${width}-${visualEvidence.length}.png`),
        });
        await tile.click();
        await page.waitForTimeout(180);
        assert.equal((await tile.evaluate(style)).background, off.background);
        await tile.press("Space");
        await checkIndicator(tile, true);
        await tile.press("Space");
        await checkIndicator(tile, false);
        visualEvidence.push({ off, on });
      }
      assert.equal(await page.locator('[data-model-input-modality="text"]').isDisabled(), true);
      await page.screenshot({ path: join(artifacts, `header-options-${width}.png`) });
      assert.deepEqual(errors, []);
      await writeFile(
        join(artifacts, `header-options-${width}.json`),
        JSON.stringify({ mutations, visualEvidence }, null, 2),
      );
    } finally {
      await page.close();
    }
  });
}
for (const [width, locale, theme] of [
  [390, "zh-CN", "light"],
  [1200, "en-US", "dark"],
]) {
  test(`account has no provider toggle ${width}/${locale}/${theme}`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const mutations = [];
    await page.route("**/mutation", async (route) => {
      mutations.push(route.request().postDataJSON());
      await route.fulfill({ status: 200, body: "{}" });
    });
    try {
      await page.goto(
        `${origin}fixture?${new URLSearchParams({ locale, theme, access: "account" })}`,
      );
      await page.getByTestId("detail").getByText("GLM-5.3", { exact: true }).waitFor();
      assert.equal(await page.getByTestId("model-provider-enabled-switch").count(), 0);
      assert.ok(
        (await page.getByTestId("detail").getByRole("switch").count()) > 0,
        "model switches remain available",
      );
      assert.deepEqual(mutations, [], "rendering must not save an enable override");
    } finally {
      await page.close();
    }
  });
}
for (const [width, locale, theme] of [
  [390, "zh-CN", "light"],
  [1200, "en-US", "dark"],
])
  test(`provider batch ${width}/${locale}/${theme}`, async () => {
    await mkdir(artifacts, { recursive: true });
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [],
      logs = [],
      mutations = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => logs.push(m.text()));
    page.setDefaultTimeout(15000);
    let failDelete = true;
    await page.route("**/mutation", async (route) => {
      const data = route.request().postDataJSON();
      mutations.push(data);
      const status = data.action === "delete" && failDelete ? 500 : 200;
      if (data.action === "delete") failDelete = false;
      await route.fulfill({ status, body: "{}", contentType: "application/json" });
    });
    try {
      await page.goto(`${origin}fixture?${new URLSearchParams({ locale, theme })}`);
      const group = page.locator('[data-provider-template-group="zhipu"]');
      await group.waitFor();
      assert.equal(await group.locator("button").count(), 4);
      assert.deepEqual(
        await group.locator("button").evaluateAll((nodes) => nodes.map((n) => n.dataset.testid)),
        ["bigmodel-api", "zai-api", "bigmodel-standard-api", "zai-standard-api"].map(
          (id) => "model-provider-template-item-" + id,
        ),
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      await page.screenshot({ path: join(artifacts, `templates-${width}.png`) });
      await group.locator("button").first().click();
      const toggle = page.getByTestId("model-provider-enabled-switch");
      await toggle.waitFor();
      assert.equal(await toggle.getAttribute("aria-checked"), "true");
      assert.equal(await page.locator('[data-provider-status="ready"]').count(), 2);
      await toggle.click();
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-testid="model-provider-enabled-switch"]')
            .getAttribute("aria-checked") === "false",
      );
      assert.equal(await page.locator('[data-provider-status="disabled"]').count(), 2);
      const disabledTests = page.getByTitle(
        locale === "zh-CN" ? "请先启用供应商" : "Enable the provider first",
        { exact: true },
      );
      assert.ok((await disabledTests.count()) > 0);
      assert.equal(await disabledTests.first().isDisabled(), true);
      const save = mutations.find((m) => m.action === "save").payload;
      assert.equal(save.enabledUpdate, false);
      assert.equal(save.config.access.apiKey, "fixture-key");
      assert.equal("enabled" in save.personalConfig, false);
      await toggle.click();
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-testid="model-provider-enabled-switch"]')
            .getAttribute("aria-checked") === "true",
      );
      const keyLink = page.getByRole("button", {
        name: locale === "zh-CN" ? "获取 API Key" : "Get API key",
        exact: true,
      });
      const allKeyLinks = page.getByRole("button", { name: /获取.*Key|Get.*[Kk]ey/ });
      assert.equal(await allKeyLinks.count(), 1);
      await keyLink.click();
      assert.equal(
        await page.getByTestId("opened").textContent(),
        "https://bigmodel.cn/coding-plan/personal/overview",
      );
      const nav = page.getByRole("button", { name: "fixture", exact: true });
      const before = await nav.boundingBox();
      await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
      await page.mouse.down();
      await page.mouse.move(before.x + before.width / 2 + 240, before.y + before.height / 2 + 8, {
        steps: 8,
      });
      const during = await nav.boundingBox();
      assert.ok(Math.abs(during.x - before.x) < 2, "horizontal drag must remain inside sidebar");
      await page.mouse.up();
      await page.getByTestId("model-provider-model-delete-button-2").click();
      await page.getByRole("alert").waitFor();
      assert.match(
        await page.getByRole("alert").innerText(),
        locale === "zh-CN" ? /删除失败/ : /delete/i,
      );
      await page
        .getByRole("button", { name: locale === "zh-CN" ? "重试" : "Retry", exact: true })
        .click();
      await page.waitForFunction(
        () => !document.querySelector('[data-testid="model-provider-model-delete-button-2"]'),
      );
      assert.match(
        await page.locator('[data-provider-detail-feedback-state="success"]').last().innerText(),
        locale === "zh-CN" ? /已删除/ : /deleted/i,
      );
      assert.equal(mutations.filter((m) => m.action === "delete").length, 2);
      await page
        .getByTitle(locale === "zh-CN" ? "测试模型" : "Test model", { exact: true })
        .first()
        .click();
      const success = page
        .locator('[data-provider-detail-feedback-state="success"]')
        .filter({ hasText: locale === "zh-CN" ? "连接成功" : "connected" });
      await success.waitFor();
      assert.match(await success.innerText(), /Fixture Provider/);
      const visual = await success.evaluate((node) => ({
        color: getComputedStyle(node).color,
        background: getComputedStyle(node).backgroundColor,
        border: getComputedStyle(node).borderColor,
      }));
      assert.ok(visual.background !== "rgba(0, 0, 0, 0)");
      assert.equal(
        await success.evaluate(
          (node) =>
            node.classList.contains("text-success") &&
            node.classList.contains("border-success/30") &&
            node.classList.contains("bg-success/10"),
        ),
        true,
      );
      assert.equal(await success.locator("button").count(), 1);
      await success.locator("button").click();
      await success.waitFor({ state: "hidden" });
      // 清空 Key 会触发异步草稿保存，放在独立操作完成后，避免与删除回归竞争保存门禁。
      const keyInput = page.getByPlaceholder(locale === "zh-CN" ? "输入 API Key" : "Enter API key");
      await keyInput.fill("");
      assert.equal(await allKeyLinks.count(), 1);
      await keyLink.click();
      assert.equal(
        await page.getByTestId("opened").textContent(),
        "https://bigmodel.cn/coding-plan/personal/overview",
      );
      assert.deepEqual(errors, []);
      await page.screenshot({ path: join(artifacts, `detail-${width}.png`) });
    } finally {
      await writeFile(join(artifacts, `${width}.log`), logs.concat(errors).join("\n"));
      await page.close();
    }
  });
