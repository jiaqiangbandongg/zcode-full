import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { test } from "node:test";

export function registerProgressiveModelEditorCases(getEnvironment) {
  for (const [width, locale, theme] of [
    [390, "zh-CN", "light"],
    [1200, "en-US", "dark"],
  ]) {
    test(`Todo141 hidden reasoning validation ${width}/${theme}`, async () => {
      const { browser, origin } = getEnvironment();
      const page = await browser.newPage({
        viewport: { width, height: 900 },
        reducedMotion: "reduce",
      });
      const writes = [];
      await page.route("**/mutation", async (route) => {
        writes.push(route.request().postDataJSON());
        await route.fulfill({ body: "{}" });
      });
      try {
        await page.goto(
          `${origin}fixture?${new URLSearchParams({ editor: "1", emptyReasoning: "1", locale, theme })}`,
        );
        const trigger = page.locator("[data-model-advanced-trigger]");
        for (let attempt = 0; attempt < 2; attempt++) {
          await page
            .locator("[data-model-settings-footer]")
            .getByRole("button", { name: locale === "zh-CN" ? "保存" : "Save", exact: true })
            .click();
          await page.waitForFunction(() =>
            document.activeElement?.hasAttribute("data-model-reasoning-level-add"),
          );
          assert.equal(await trigger.getAttribute("aria-expanded"), "true");
          assert.deepEqual(writes, []);
          if (!attempt) await trigger.click();
        }
        await page.locator("[data-model-reasoning-level-add]").press("Enter");
        await page.locator("[data-model-reasoning-level-input]").fill("enabled");
        await page.locator("[data-model-reasoning-level-input]").press("Enter");
        await trigger.click();
        await page
          .locator("[data-model-settings-footer]")
          .getByRole("button", { name: locale === "zh-CN" ? "保存" : "Save", exact: true })
          .click();
        await page.locator("[data-model-settings-footer]").waitFor({ state: "hidden" });
        assert.equal(writes.length, 1);
        assert.deepEqual(writes[0].personalConfig.optionSpecs.reasoningLevel.values, ["enabled"]);
      } finally {
        await page.close();
      }
    });
    test(
      `Todo141 progressive editor and hidden-field save ${width}/${theme}`,
      { timeout: 30000 },
      async () => {
        const { browser, origin, artifacts } = getEnvironment();
        await mkdir(artifacts, { recursive: true });
        const page = await browser.newPage({
          viewport: { width, height: 900 },
          hasTouch: width === 390,
        });
        page.setDefaultTimeout(5000);
        await page.context().tracing.start({ screenshots: true, snapshots: true });
        const writes = [],
          errors = [];
        page.on("pageerror", (error) => errors.push(String(error)));
        await page.route("**/mutation", async (route) => {
          writes.push(route.request().postDataJSON());
          await route.fulfill({ body: "{}" });
        });
        try {
          await page.goto(
            `${origin}fixture?${new URLSearchParams({ editor: "1", locale, theme, ...(width === 1200 ? { edit: "1" } : {}) })}`,
          );
          const advanced = page.locator("[data-model-advanced]");
          const summary = advanced.locator("[data-model-advanced-trigger]");
          const max = page.locator("[data-model-max-output] input");
          const map = advanced.locator("[data-model-json-slot] textarea");
          const footer = page.locator("[data-model-settings-footer]");
          const save = footer.getByRole("button", {
            name: locale === "zh-CN" ? "保存" : "Save",
            exact: true,
          });
          await summary.waitFor();
          const idInput = page.locator("[data-model-identity-row] input");
          assert.equal((await idInput.getAttribute("readonly")) !== null, width === 1200);
          await page.waitForFunction(
            (edit) =>
              document.activeElement ===
              document.querySelector(
                edit
                  ? '[data-model-settings-group="tokens"] input'
                  : "[data-model-identity-row] input",
              ),
            width === 1200,
          );
          assert.equal(await summary.getAttribute("aria-expanded"), "false");
          assert.equal(await max.isVisible(), true);
          assert.equal(await advanced.locator("[data-model-max-output]").count(), 0);
          assert.equal(
            await page.locator("[data-model-reasoning-level-editor]").isVisible(),
            false,
          );
          assert.equal(await page.locator("[data-model-output-modality]").count(), 0);
          assert.equal(await page.getByText("MFJS", { exact: false }).count(), 0);
          const buttons = await footer
            .locator("button[data-variant]:not([data-model-help])")
            .allTextContents();
          assert.deepEqual(
            buttons,
            locale === "zh-CN" ? ["重置表单", "取消", "保存"] : ["Reset form", "Cancel", "Save"],
          );
          assert.equal(await footer.getByRole("switch").count(), 0);
          assert.equal(
            await page.locator('[data-slot="dialog-header"]').getByRole("switch").count(),
            1,
          );
          assert.equal(
            await page
              .locator("[data-model-settings-group]")
              .evaluateAll((nodes) =>
                nodes.every(
                  (node) =>
                    getComputedStyle(node).borderTopWidth === "0px" &&
                    getComputedStyle(node).paddingLeft === "0px",
                ),
              ),
            true,
          );
          const bounds = await footer.boundingBox();
          assert.ok(
            bounds.x >= 0 && bounds.x + bounds.width <= width && bounds.y + bounds.height <= 900,
          );
          await page.screenshot({ path: `${artifacts}/todo141-basic-${width}.png` });
          const spacing = await page.locator("[data-model-settings-scroll]").evaluate((node) => {
            const groups = [...node.children].slice(0, 3);
            return groups
              .slice(1)
              .map(
                (group, index) =>
                  group.getBoundingClientRect().top - groups[index].getBoundingClientRect().bottom,
              );
          });
          assert.deepEqual(spacing, [16, 16]);
          // 基础区最大输出错误不展开高级配置，但仍把焦点交还给错误输入。
          await max.fill("0");
          await save.click();
          await page.waitForFunction(
            () =>
              document.activeElement === document.querySelector("[data-model-max-output] input"),
          );
          assert.equal(await summary.getAttribute("aria-expanded"), "false");
          assert.deepEqual(writes, []);
          await max.fill("");
          // 高级仅控制可见性，不能清草稿或丢掉原有覆盖高亮。
          await page.locator('[data-model-settings-group="tokens"] input').first().fill("654321");
          await summary.click();
          const textOption = advanced.locator('[data-model-input-modality="text"]');
          assert.equal(await textOption.isDisabled(), true);
          assert.equal(await textOption.getAttribute("aria-pressed"), "true");
          assert.equal(await textOption.locator("[data-model-option-checkbox]").count(), 1);
          const reasoning = advanced.locator('[data-model-settings-group="reasoning"]');
          assert.equal(await reasoning.locator("[data-model-reasoning-level-editor]").count(), 1);
          assert.equal(await reasoning.locator("[data-model-json-slot]").count(), 1);
          // 重复值在失焦时不能提交，收起再展开仍要保留该局部编辑，而非卸载丢弃。
          await reasoning.getByRole("button", { name: "low", exact: true }).click();
          const levelInput = reasoning.locator("[data-model-reasoning-level-input]");
          await levelInput.fill("high");
          await summary.click();
          await summary.press("Space");
          assert.equal(await levelInput.inputValue(), "high");
          await levelInput.fill("low");
          await levelInput.blur();
          await max.fill("54321");
          await map.fill("bad (");
          assert.equal(await max.getAttribute("data-personal-override"), "true");
          const image = advanced.locator('[data-model-input-modality="image"]');
          await image.click();
          assert.equal(await image.locator("[data-model-option-checkbox]").count(), 1);
          assert.equal(await image.getAttribute("data-personal-override"), "true");
          await summary.click();
          assert.equal(await max.inputValue(), "54321");
          assert.deepEqual(writes, []);
          // 收起后保存仍校验高级字段，自动展开并聚焦；重复同一错误也有效。
          for (let attempt = 0; attempt < 2; attempt++) {
            await save.click();
            await page.waitForFunction(
              () =>
                document
                  .querySelector("[data-model-advanced-trigger]")
                  .getAttribute("aria-expanded") === "true" &&
                document.activeElement ===
                  document.querySelector("[data-model-json-slot] textarea"),
            );
            assert.deepEqual(writes, []);
            if (!attempt) await summary.click();
          }
          await map.fill("{}");
          await map.evaluate(async (node) => {
            await Promise.all(
              node
                .closest("[data-model-advanced]")
                .getAnimations({ subtree: true })
                .map((animation) => animation.finished),
            );
          });
          await map.scrollIntoViewIfNeeded();
          await page.screenshot({ path: `${artifacts}/todo141-advanced-${width}.png` });
          const layout = await page.locator("[data-model-settings-scroll]").evaluate((node) => ({
            scrollWidth: node.scrollWidth,
            clientWidth: node.clientWidth,
          }));
          assert.ok(layout.scrollWidth <= layout.clientWidth + 1, JSON.stringify(layout));
          await summary.click();
          await save.click();
          await footer.waitFor({ state: "hidden" });
          assert.equal(writes.length, 1);
          assert.equal(writes[0].personalConfig.properties.contextWindow, 654321);
          assert.equal(writes[0].personalConfig.optionSpecs.maxOutputTokens.max, 54321);
          assert.equal(writes[0].personalConfig.optionSpecs.reasoningLevel.map, "{}");
          assert.equal(writes[0].personalConfig.properties.inputFormat.supportsImage, false);
          await page.getByRole("button", { name: "Reopen editor" }).click();
          assert.equal(await summary.getAttribute("aria-expanded"), "false");
          assert.equal(await max.inputValue(), "");
          await page.getByRole("switch").click();
          await save.click();
          await footer.waitFor({ state: "hidden" });
          assert.equal(writes.length, 2);
          assert.equal(writes[1].useRecommendedConfig, false);
          assert.equal(
            Object.hasOwn(writes[1].personalConfig.properties, "requiresMfjsToolSchema"),
            false,
          );
          assert.equal(Object.hasOwn(writes[1].personalConfig.properties, "outputFormat"), false);
          assert.deepEqual(errors, []);
          await page.getByRole("button", { name: "Reopen editor" }).click();
          await summary.click();
          await max.fill("34567");
          await footer
            .getByRole("button", { name: locale === "zh-CN" ? "取消" : "Cancel", exact: true })
            .click();
          await footer.waitFor({ state: "hidden" });
          assert.equal(writes.length, 2);
          await page.getByRole("button", { name: "Reopen editor" }).click();
          assert.equal(await summary.getAttribute("aria-expanded"), "false");
          assert.equal(await max.inputValue(), "");
        } finally {
          await page.screenshot({ path: `${artifacts}/todo141-final-${width}.png` });
          await page.context().tracing.stop({ path: `${artifacts}/todo141-${width}.zip` });
          await page.close();
        }
      },
    );
  }
}
