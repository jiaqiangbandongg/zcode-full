import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { registerProviderAppIconCases } from "./provider-app-icon-cases.mjs";

export function registerProviderPresentationCases(getEnvironment) {
  registerProviderAppIconCases(getEnvironment);
  for (const [width, locale, theme] of [
    [390, "zh-CN", "light"],
    [1200, "en-US", "dark"],
  ]) {
    test(`openrouter template label ${width}/${locale}`, async () => {
      const { browser, origin, artifacts } = getEnvironment();
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      try {
        await page.goto(`${origin}fixture?${new URLSearchParams({ locale, theme })}`);
        const card = page.getByTestId("model-provider-template-item-openrouter");
        await card.waitFor();
        assert.equal((await card.innerText()).trim(), "OpenRouter");
        await card.hover();
        await page
          .getByRole("tooltip")
          .filter({ hasText: /^OpenRouter$/ })
          .waitFor();
        await mkdir(artifacts, { recursive: true });
        await page.screenshot({ path: join(artifacts, `openrouter-label-${width}.png`) });
      } finally {
        await page.close();
      }
    });
    test(`subagent selection error copy ${width}/${locale}`, async () => {
      const { browser, origin, artifacts } = getEnvironment();
      const context = await browser.newContext({
        viewport: { width, height: 1000 },
        permissions: ["clipboard-read", "clipboard-write"],
      });
      const page = await context.newPage();
      try {
        await page.goto(
          `${origin}fixture?${new URLSearchParams({ locale, theme, access: "account", selectionError: "1" })}`,
        );
        await page
          .getByTestId("subagent-error")
          .getByText(locale === "zh-CN" ? "执行失败" : "Failed", { exact: true })
          .hover();
        const detail = page
          .locator('[data-slot="tooltip-content"]')
          .filter({ hasText: "reasoning-level-missing" });
        await detail.waitFor();
        assert.match(await detail.innerText(), /未选择思考档位/);
        // Radix 还生成一份 aria 隐藏描述，点击实际展示的复制按钮。
        await detail.locator('button:not([role="tooltip"] button)').click();
        const copied = await page.evaluate(() => navigator.clipboard.readText());
        assert.match(copied, /reason=reasoning-level-missing/);
        assert.match(copied, /selection=account:bigmodel-team-coding-plan\/GLM-5\.3/);
        assert.match(copied, /No reasoning level selected/);
        await mkdir(artifacts, { recursive: true });
        await page.screenshot({ path: join(artifacts, `subagent-error-${width}.png`) });
      } finally {
        await context.close();
      }
    });
  }
  for (const [width, locale, theme] of [
    [390, "zh-CN", "light"],
    [1200, "en-US", "dark"],
  ]) {
    test(`coding plan vision badge in settings and picker ${width}/${theme}`, async () => {
      const { browser, origin, artifacts } = getEnvironment();
      const page = await browser.newPage({ viewport: { width, height: 1100 } });
      try {
        for (const access of ["start-zai", "start-bigmodel", "account", "team", "manual"]) {
          await page.goto(
            `${origin}fixture?${new URLSearchParams({ locale, theme, access, vision: "1" })}`,
          );
          const label = locale === "zh-CN" ? "视觉" : "Vision";
          const detail = page.getByTestId("detail");
          await detail.getByText("GLM-5.3", { exact: true }).waitFor();
          const main = detail.getByText("GLM-5.3", { exact: true }).locator("..");
          const flash = detail.getByText("GLM-5.3-Flash", { exact: true }).locator("..");
          assert.equal(await main.getByText(label, { exact: true }).count(), 0);
          assert.equal(await flash.getByText(label, { exact: true }).count(), 1);
          await page.getByRole("button", { name: "Pick model", exact: true }).click();
          const menu = page.getByRole("menu");
          await menu.waitFor();
          const mainItem = menu.getByRole("menuitemradio").filter({ hasText: /^GLM-5\.3$/ });
          const flashItem = menu.getByRole("menuitemradio").filter({ hasText: /GLM-5\.3-Flash/ });
          assert.equal(await mainItem.count(), 1);
          assert.equal(await mainItem.getByText(label, { exact: true }).count(), 0);
          assert.equal(await flashItem.getByText(label, { exact: true }).count(), 1);
          await mkdir(artifacts, { recursive: true });
          await page.screenshot({ path: join(artifacts, `vision-${access}-${width}.png`) });
        }
      } finally {
        await page.close();
      }
    });
  }
}
