import assert from "node:assert/strict";
import { test } from "node:test";

export function registerProviderModelEditorCases(getEnvironment) {
  for (const [width, locale, theme] of [
    [390, "zh-CN", "light"],
    [1200, "en-US", "dark"],
  ]) {
    test(`empty new model reasoning ${width}/${locale}`, { timeout: 30000 }, async () => {
      const { browser, origin } = getEnvironment();
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      const errors = [],
        requests = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      let receive;
      await page.route("**/resolve?*", (route) => {
        requests.push(route.request().url());
        receive(route);
      });
      try {
        await page.goto(
          `${origin}fixture?${new URLSearchParams({ locale, theme, access: "manual" })}`,
        );
        await page.getByTestId("model-provider-add-model-button").click();
        await page.locator("[data-model-advanced-trigger]").click();
        const editor = page.locator("[data-model-reasoning-level-editor]");
        const chips = editor.locator("[data-model-reasoning-chip]");
        const id = page.locator("[data-model-identity-row] input");
        await editor.waitFor();
        assert.equal(await chips.count(), 0);
        assert.equal(requests.length, 0);
        const first = new Promise((resolve) => {
          receive = resolve;
        });
        await id.fill("new-model");
        await id.blur();
        const recommendation = {
          inheritedConfig: {
            properties: { contextWindow: 111111 },
            optionSpecs: { reasoningLevel: { values: ["disabled", "enabled"], map: "{}" } },
          },
          issues: [],
          revision: 1,
        };
        await (
          await first
        ).fulfill({ contentType: "application/json", body: JSON.stringify(recommendation) });
        await chips.filter({ hasText: "enabled" }).waitFor();
        assert.equal(await chips.count(), 2);
        await id.fill("");
        await id.blur();
        await page.waitForFunction(
          () => document.querySelectorAll("[data-model-reasoning-chip]").length === 0,
        );
        assert.equal(requests.length, 1);
        // 空草稿可手动加档位，随后推荐回包不能覆盖显式编辑。
        await editor.getByRole("button").last().click();
        await editor.locator("input").fill("custom-level");
        await editor.locator("input").press("Enter");
        const second = new Promise((resolve) => {
          receive = resolve;
        });
        await id.fill("another-model");
        await id.blur();
        recommendation.inheritedConfig.properties.contextWindow = 222222;
        await (
          await second
        ).fulfill({ contentType: "application/json", body: JSON.stringify(recommendation) });
        // 等到该解析已完成，验证未覆盖用户档位。
        await page.waitForFunction(
          () =>
            document
              .querySelector('[data-model-settings-group="tokens"] input')
              ?.getAttribute("placeholder") === "222222",
        );
        assert.equal(await chips.count(), 1);
        assert.match(await chips.textContent(), /custom-level/);
        assert.deepEqual(errors, []);
      } finally {
        await page.close();
      }
    });
    test(`restore lifecycle guards ${width}/${locale}`, { timeout: 30000 }, async () => {
      const { browser, origin } = getEnvironment();
      for (const action of ["mode", "scope", "close", "repeat", "save", "id"]) {
        const page = await browser.newPage({ viewport: { width, height: 1000 } });
        let receive, saveRequest;
        const request = () =>
          new Promise((resolve) => {
            receive = resolve;
          });
        await page.route("**/resolve?*", (route) => receive(route));
        await page.route("**/mutation", (route) => {
          saveRequest = route;
        });
        try {
          await page.goto(
            `${origin}fixture?${new URLSearchParams({ editor: "1", locale, theme })}`,
          );
          const restore = page.getByRole("button", {
            name: locale === "zh-CN" ? "重置表单" : "Reset form",
            exact: true,
          });
          const toggle = page.locator('[data-model-recommended-config] [role="switch"]');
          const capacity = page.locator('[data-model-settings-group="tokens"] input').first();
          if (action === "id") await toggle.click();
          await capacity.fill("333333");
          const first = request();
          await restore.click();
          const obsolete = await first;
          if (action === "mode") await toggle.click();
          if (action === "scope")
            await page.getByTestId("external-scope").evaluate((node) => node.click());
          if (action === "close")
            await page
              .getByRole("button", { name: locale === "zh-CN" ? "取消" : "Cancel", exact: true })
              .click();
          if (action === "id")
            await page.locator("[data-model-identity-row] input").fill("new-identity");
          if (action === "repeat") {
            const second = request();
            await restore.click();
            await (
              await second
            ).fulfill({
              contentType: "application/json",
              body: JSON.stringify({
                inheritedConfig: { properties: { contextWindow: 222222 } },
                issues: [],
              }),
            });
            await page.waitForFunction(
              () =>
                JSON.parse(document.querySelector('[data-testid="editor-draft"]').textContent)
                  .contextWindowValue === "",
            );
          }
          if (action === "save") {
            await page
              .getByRole("button", { name: locale === "zh-CN" ? "保存" : "Save", exact: true })
              .click();
            for (const control of [restore, toggle]) assert.equal(await control.isDisabled(), true);
          }
          const before = await page.getByTestId("editor-draft").textContent();
          await obsolete.fulfill(
            locale === "zh-CN"
              ? { status: 500, body: "obsolete failure" }
              : {
                  contentType: "application/json",
                  body: JSON.stringify({
                    inheritedConfig: { properties: { contextWindow: 999999 } },
                    issues: [],
                  }),
                },
          );
          await page.waitForTimeout(50);
          assert.equal(await page.getByTestId("editor-draft").textContent(), before, action);
          assert.equal(await page.getByRole("alert").count(), 0, action);
          if (action === "save") {
            assert.ok(saveRequest);
            await saveRequest.fulfill({ status: 500, body: "save failed" });
            await page.getByRole("alert").waitFor();
            assert.equal(await capacity.inputValue(), "333333");
          }
        } finally {
          await page.close();
        }
      }
    });
    test(`seven help entries and header smart placement ${width}/${locale}`, async () => {
      const { browser, origin, artifacts } = getEnvironment();
      const page = await browser.newPage({
        viewport: { width, height: 1000 },
        hasTouch: width === 390,
      });
      const errors = [],
        writes = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.route("**/mutation", async (route) => {
        writes.push(route.request().postDataJSON());
        await route.fulfill({ body: "{}" });
      });
      try {
        await page.goto(`${origin}fixture?${new URLSearchParams({ editor: "1", locale, theme })}`);
        const help = page.locator("button[data-model-help]");
        await help.first().waitFor();
        assert.equal(await help.count(), 7);
        await page.locator("[data-model-advanced-trigger]").click();
        assert.equal(
          await help.evaluateAll((nodes) => nodes.every((node) => !node.closest("label"))),
          true,
          "help buttons must not take the input label association",
        );
        for (const input of await page.locator("input[id]").all()) {
          const id = await input.getAttribute("id");
          const label = page.locator(`label[for=${JSON.stringify(id)}]`);
          await label.click();
          assert.equal(await input.evaluate((node) => node === document.activeElement), true);
        }
        assert.equal(await page.locator('[data-model-help="modelId"]').count(), 0);
        assert.equal(await page.locator('[data-model-settings-footer] [role="switch"]').count(), 0);
        assert.equal(await page.locator('[data-model-identity-row] [role="switch"]').count(), 0);
        const idBox = await page.locator("[data-model-identity-row] input").boundingBox();
        const smartBox = await page.locator("[data-model-recommended-config]").boundingBox();
        assert.ok(smartBox.y + smartBox.height <= idBox.y);
        const before = await page.getByTestId("editor-draft").textContent();
        for (const field of await help.evaluateAll((nodes) =>
          nodes.map((node) => node.dataset.modelHelp),
        )) {
          const trigger = page.locator(`[data-model-help="${field}"]`);
          if (width === 390) await trigger.tap();
          else await trigger.hover();
          const popup = page.locator(`[data-model-help-content="${field}"]`);
          await popup.waitFor({ timeout: 500 });
          await page.waitForTimeout(150);
          assert.ok((await popup.innerText()).length > 15);
          const box = await popup.boundingBox();
          assert.ok(
            box.x >= 0 &&
              box.x + box.width <= width + 1 &&
              box.y >= 0 &&
              box.y + box.height <= 1001,
          );
          if (field === "reasoningLevelsOrdered")
            assert.ok((await popup.locator("strong").innerText()).length > 0);
          if (field === "reasoningLevelMapping")
            assert.equal(await popup.locator("code").innerText(), "reasoningLevel");
          await page.keyboard.press("Escape");
        }
        const keyboard = page.locator('[data-model-help="followRecommendedConfig"]');
        // 智能帮助现为最后一个：Escape 关闭弹层后焦点仍在该按钮，先 Tab 离开再验证键盘重入。
        await page.keyboard.press("Tab");
        await page.mouse.move(0, 0);
        await keyboard.scrollIntoViewIfNeeded();
        await keyboard.focus();
        await page
          .locator('[data-model-help-content="followRecommendedConfig"]')
          .waitFor({ timeout: 500 });
        await page.waitForTimeout(150);
        const finalPopup = await page
          .locator('[data-model-help-content="followRecommendedConfig"]')
          .boundingBox();
        assert.ok(finalPopup.y >= 0 && finalPopup.y + finalPopup.height <= 1001);
        await page.screenshot({ path: `${artifacts}/editor-help-${locale}.png` });
        assert.equal(await page.getByTestId("editor-draft").textContent(), before);
        assert.deepEqual(writes, []);
        assert.deepEqual(errors, []);
      } finally {
        await page.close();
      }
    });
    test(`restore is atomic and ignores obsolete intent ${width}/${locale}`, async () => {
      const { browser, origin } = getEnvironment();
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      const writes = [],
        errors = [];
      let nextRequest;
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.route("**/resolve?*", (route) => {
        nextRequest?.(route);
      });
      await page.route("**/mutation", async (route) => {
        writes.push(route.request().postDataJSON());
        await route.fulfill({ body: "{}" });
      });
      const request = () =>
        new Promise((resolve) => {
          nextRequest = resolve;
        });
      const response = (contextWindow) => ({
        contentType: "application/json",
        body: JSON.stringify({
          inheritedConfig: {
            properties: { contextWindow },
            optionSpecs: {
              reasoningLevel: { values: ["high"], map: "{}" },
              maxOutputTokens: { max: 1000 },
            },
          },
          issues: [],
        }),
      });
      try {
        await page.goto(`${origin}fixture?${new URLSearchParams({ editor: "1", locale, theme })}`);
        const restore = page.getByRole("button", {
          name: locale === "zh-CN" ? "重置表单" : "Reset form",
          exact: true,
        });
        const capacity = page.locator('[data-model-settings-group="tokens"] input').first();
        const toggle = page.locator('[data-model-recommended-config] [role="switch"]');
        await capacity.fill("987654");
        const first = request();
        await restore.click({ timeout: 2000 });
        const pending = await first;
        assert.equal(await capacity.inputValue(), "987654", "do not clear before response");
        await pending.fulfill(response(222222));
        await capacity.waitFor();
        await page.waitForFunction(
          () =>
            JSON.parse(document.querySelector('[data-testid="editor-draft"]').textContent)
              .contextWindowValue === "",
        );
        assert.equal(await capacity.getAttribute("placeholder"), "222222");
        assert.equal(await toggle.getAttribute("aria-checked"), "true");
        assert.deepEqual(writes, []);
        const second = request();
        await restore.click();
        const obsolete = await second;
        await capacity.fill("444444");
        await obsolete.fulfill(response(999999));
        await page.waitForTimeout(50);
        assert.equal(await capacity.inputValue(), "444444");
        assert.equal(await capacity.getAttribute("placeholder"), "222222");
        const third = request();
        await restore.click();
        await (await third).fulfill({ status: 500, body: "failed" });
        await page.getByRole("alert").waitFor();
        assert.equal(await capacity.inputValue(), "444444");
        assert.deepEqual(writes, []);
        assert.deepEqual(errors, []);
      } finally {
        await page.close();
      }
    });
    test(`manual editable fields and pending cancellation ${width}/${locale}`, async () => {
      const { browser, origin } = getEnvironment();
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      const requests = [],
        writes = [],
        errors = [];
      let received;
      const requested = new Promise((resolve) => {
        received = resolve;
      });
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.route("**/resolve?*", async (route) => {
        requests.push(new URL(route.request().url()).searchParams.get("id"));
        received(route);
      });
      await page.route("**/mutation", async (route) => {
        writes.push(route.request().postDataJSON());
        await route.fulfill({ body: "{}" });
      });
      try {
        await page.goto(`${origin}fixture?${new URLSearchParams({ editor: "1", locale, theme })}`);
        const id = page.locator("[data-model-identity-row] input");
        const toggle = page.locator('[data-model-recommended-config] [role="switch"]');
        await id.fill("");
        await toggle.click();
        assert.equal(await toggle.getAttribute("aria-checked"), "false");
        assert.deepEqual(requests, []);
        await page
          .getByRole("button", {
            name: locale === "zh-CN" ? "重置表单" : "Reset form",
            exact: true,
          })
          .click();
        assert.equal(await toggle.getAttribute("aria-checked"), "true");
        assert.equal(await id.inputValue(), "");
        assert.deepEqual(requests, [], "empty restore must not resolve an empty model ID");
        assert.deepEqual(writes, [], "restore only changes the editor draft");
        await toggle.click();
        await id.fill("new-model");
        await toggle.click();
        await id.focus();
        await id.blur();
        await page.waitForFunction(
          () =>
            JSON.parse(document.querySelector('[data-testid="editor-draft"]').textContent)
              .idValue === "new-model",
        );
        const held = await Promise.race([
          requested,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("missing resolution request")), 5000),
          ),
        ]);
        await toggle.click();
        const before = await page.getByTestId("editor-draft").textContent();
        await held.fulfill(
          locale === "zh-CN"
            ? { status: 500, body: "failed" }
            : {
                contentType: "application/json",
                body: JSON.stringify({
                  inheritedConfig: {
                    properties: { contextWindow: 999999 },
                    optionSpecs: { reasoningLevel: { values: ["late"], map: "{}" } },
                  },
                  issues: [],
                }),
              },
        );
        await page.waitForTimeout(50);
        assert.equal(await page.getByTestId("editor-draft").textContent(), before);
        assert.equal(await toggle.getAttribute("aria-checked"), "false");
        assert.deepEqual(writes, []);
        assert.deepEqual(errors, []);
      } finally {
        await page.close();
      }
    });
  }
}
