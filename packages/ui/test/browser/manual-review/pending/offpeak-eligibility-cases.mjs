import assert from "node:assert/strict";
import { test } from "node:test";

export function registerOffPeakEligibilityCases(getContext) {
  test("offpeak: actual home Team-only entry preserves gray, inactive and dismiss gates", async () => {
    const { browser, origin } = getContext();
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    try {
      for (const family of ["bigmodel", "zai"]) {
        for (const gate of ["", "&inactive=1", "&noPlan=1", "&grayOff=1"]) {
          await page.goto(`${origin}fixture?teamEntry=1&family=${family}&locale=zh-CN${gate}`);
          await page.waitForFunction(
            () => document.querySelector('[data-testid="team-loaded"]')?.textContent === "true",
          );
          const entry = page.locator("[data-off-peak-new-task-entry]");
          if (gate === "&grayOff=1") {
            assert.equal(await entry.count(), 0);
            continue;
          }
          await entry.locator("[data-off-peak-template-grid] button").last().click();
          assert.equal(await page.getByTestId("team-opened").textContent(), gate ? "0" : "1");
          if (!gate) {
            assert.match(await page.getByTestId("team-draft").textContent(), /app.session/);
            await page.getByTestId("dismiss-entry").click();
            assert.equal(await entry.count(), 0);
          }
        }
      }
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });
  test("offpeak: Registry ready notification and manual refresh share current eligibility", async () => {
    const { browser, origin } = getContext();
    const page = await browser.newPage();
    const calls = [],
      errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.route("**/eligibility-rpc", async (route) => {
      calls.push(route.request().postDataJSON());
      await route.fulfill({ status: 200, body: "{}" });
    });
    const settled = async (status) =>
      page.waitForFunction(
        (value) =>
          document.querySelector('[data-testid="status-automation"]')?.textContent === value,
        status,
      );
    try {
      await page.goto(`${origin}fixture?offpeak=1&locale=zh-CN&theme=dark`);
      await settled("idle");
      assert.equal(await page.getByTestId("create-automation").isDisabled(), true);
      assert.equal(calls.length, 1, "two entries share initialization");
      calls.length = 0;
      await page.getByTestId("account-ready").click();
      await settled("ready");
      assert.equal(await page.getByTestId("create-automation").isEnabled(), true);
      assert.equal(await page.getByTestId("create-home").isEnabled(), true);
      assert.deepEqual(
        calls.map((c) => c.call),
        ["support", "availability"],
      );
      await page.getByTestId("account-off").click();
      await settled("idle");
      assert.equal(await page.getByTestId("create-automation").isDisabled(), true);
      calls.length = 0;
      await page.getByTestId("account-silent").click();
      await page.getByTestId("refresh-automation").click();
      await settled("ready");
      assert.deepEqual(
        calls.map((c) => c.call),
        ["support", "availability"],
      );
      await page.getByTestId("rpc-fail").click();
      await settled("error");
      assert.equal(await page.getByTestId("create-automation").isDisabled(), true);
      await page.getByTestId("account-ready").click();
      await settled("ready");
      assert.equal(await page.getByTestId("create-automation").isEnabled(), true);
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });
}
