import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

export function registerProviderAppIconCases(getContext) {
  for (const [width, locale, theme] of [
    [390, "zh-CN", "light"],
    [1200, "en-US", "dark"],
  ]) {
    test(`zai app icon ${width}/${locale}/${theme}`, async () => {
      const { browser, origin, artifacts } = getContext();
      await mkdir(artifacts, { recursive: true });
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [],
        mutations = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.route("**/mutation", async (route) => {
        mutations.push(route.request().postDataJSON());
        await route.fulfill({ status: 200, body: "{}" });
      });
      const assertAppIcon = async (image) => {
        await image.waitFor();
        assert.match(await image.getAttribute("src"), /model-provider-zai-app\.png(?:\?|$)/);
        await image.evaluate((node) => node.decode());
        assert.deepEqual(
          await image.evaluate((node) => ({
            width: node.naturalWidth,
            height: node.naturalHeight,
            filter: getComputedStyle(node).filter,
          })),
          { width: 128, height: 128, filter: "none" },
        );
        const box = await image.boundingBox();
        assert.equal(box.width, box.height);
      };
      try {
        await page.goto(`${origin}fixture?${new URLSearchParams({ locale, theme })}`);
        for (const id of ["zai-api", "zai-standard-api"]) {
          const card = page.getByTestId(`model-provider-template-item-${id}`);
          const name = id === "zai-api" ? "Z.ai Coding Plan" : "Z.ai API";
          await assertAppIcon(card.locator("img"));
          assert.equal((await card.innerText()).trim(), name);
          await card.hover();
          await page.getByRole("tooltip", { name, exact: true }).waitFor();
          await page.keyboard.press("Escape");
          await page.mouse.move(0, 0);
          await page.getByRole("tooltip", { name, exact: true }).waitFor({ state: "hidden" });
        }
        await page.screenshot({ path: join(artifacts, `zai-app-templates-${width}.png`) });
        assert.equal(mutations.length, 0);
        await page.getByTestId("model-provider-template-item-zai-api").click();
        await assertAppIcon(page.getByTestId("model-provider-header").locator("img"));
        assert.ok((await page.locator('img[src*="model-provider-zai-app.png"]').count()) >= 2);
        await page.screenshot({ path: join(artifacts, `zai-app-detail-${width}.png`) });
        assert.deepEqual(mutations, [{ action: "create", payload: "zai-api" }]);
        assert.deepEqual(errors, []);
      } finally {
        await page.close();
      }
    });
  }
}
