import assert from "node:assert/strict";
import { test } from "node:test";
export function registerShareDisclosureTests(environment) {
  test("SHARE34 warning row shakes once and respects reduced motion", async () => {
    for (const reducedMotion of ["no-preference", "reduce"]) {
      const { browser, origin } = environment();
      const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, reducedMotion });
      await page.goto(`${origin}fixture?theme=light&locale=zh-CN`);
      await page.getByTestId("conversation-share-trigger").click();
      const animations = await page.evaluate(() => {
        const button = document.querySelector('[data-testid="conversation-share-confirm"]');
        const row = document
          .querySelector('[data-testid="conversation-share-disclosure-checkbox"]')
          .closest("label");
        button.click();
        button.click();
        return row
          .getAnimations()
          .map((a) => a.effect.getKeyframes().map((frame) => frame.transform));
      });
      assert.equal(animations.length, reducedMotion === "reduce" ? 0 : 1);
      if (reducedMotion !== "reduce") assert.ok(animations[0].includes("translateX(-4px)"));
      await page.getByTestId("conversation-share-disclosure-checkbox").check();
      assert.equal(
        await page
          .getByTestId("conversation-share-disclosure")
          .locator("label")
          .evaluate((row) => row.getAnimations().length),
        0,
      );
      assert.equal(await page.getByTestId("conversation-share-publish-progress").count(), 0);
      await page.close();
    }
  });

  test("SHARE34 short viewport keeps unchecked feedback inside the popover", async () => {
    const { browser, origin } = environment();
    const page = await browser.newPage({ viewport: { width: 390, height: 420 } });
    await page.goto(`${origin}fixture?theme=dark&locale=en-US`);
    await page.getByTestId("conversation-share-trigger").click();
    const popover = page.getByTestId("conversation-share-popover");
    await popover.waitFor();
    await page.evaluate(async () => {
      await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {})));
    });
    const submit = page.getByTestId("conversation-share-confirm");
    const before = await submit.boundingBox();
    await submit.click();
    assert.deepEqual(await submit.boundingBox(), before);
    assert.equal(await page.evaluate(() => window.scrollY), 0);
    const checkbox = await page.getByTestId("conversation-share-disclosure-checkbox").boundingBox();
    const body = await page.getByTestId("conversation-share-confirmation-body").boundingBox();
    assert.ok(checkbox.y >= body.y && checkbox.y + checkbox.height <= body.y + body.height);
    assert.equal(await page.getByTestId("conversation-share-publish-progress").count(), 0);
    await page.close();
  });
}
