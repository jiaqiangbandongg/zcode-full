import assert from "node:assert/strict";

export async function verifySelectionSelectAll(panel) {
  const all = panel.getByTestId("conversation-share-selection-all");
  const rows = panel.locator("[data-conversation-share-selection-item]");
  const first = rows.first().getByRole("checkbox");
  const running = rows.last().getByRole("checkbox");
  assert.equal((await all.boundingBox()).x, (await first.boundingBox()).x);
  const runningState = await running.getAttribute("data-state");
  const toggle = rows.first().getByTestId("conversation-share-selection-toggle");
  const label = panel.getByTestId("conversation-share-selection-header").locator("label > span");
  assert.equal((await label.boundingBox()).x, (await toggle.boundingBox()).x);
  const locate = rows.first().getByTestId("conversation-share-selection-locate");
  await locate.hover();
  const tooltip = panel.page().getByRole("tooltip");
  await tooltip.waitFor();
  assert.equal(await locate.getAttribute("title"), null);
  const content = panel.page().locator('[data-slot="tooltip-content"]').filter({ has: tooltip });
  if (panel.page().viewportSize().width >= 600) {
    assert.equal(await content.getAttribute("data-side"), "right");
  } else {
    const bounds = await content.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= panel.page().viewportSize().width);
  }
  await toggle.click();
  assert.equal(await first.isChecked(), false);
  await locate.click();
  assert.equal(await first.isChecked(), false);
  await toggle.focus();
  await toggle.press("Space");
  assert.equal(await first.isChecked(), true);
  assert.equal(await all.getAttribute("aria-checked"), "true");
  await all.click();
  assert.equal(await all.getAttribute("aria-checked"), "false");
  assert.equal(await panel.getByTestId("conversation-share-selection-apply").isDisabled(), true);
  assert.equal(await rows.locator('[role="checkbox"][data-state="checked"]').count(), 0);
  await first.click();
  assert.equal(await all.getAttribute("aria-checked"), "mixed");
  await all.click();
  assert.equal(await all.getAttribute("aria-checked"), "true");
  assert.equal(await rows.locator('[role="checkbox"][data-state="checked"]').count(), 8);
  assert.equal(await running.getAttribute("data-state"), runningState);
  const page = panel.page();
  const summary = panel.getByTestId("conversation-share-selection-summary");
  const apply = panel.getByTestId("conversation-share-selection-apply");
  await page.getByTestId("toggle-limit").click();
  assert.match(await summary.innerText(), /110/);
  assert.match(await summary.getAttribute("class"), /text-warning/);
  assert.equal(await apply.isDisabled(), true);
  await first.click();
  assert.match(await summary.innerText(), /7/);
  assert.equal(await apply.isDisabled(), false);
  await first.click();
  assert.match(await summary.innerText(), /110/);
  await page.getByTestId("toggle-limit").click();
  await page.getByTestId("toggle-preflight").click();
  assert.equal(await apply.isDisabled(), true);
  await page.getByTestId("toggle-preflight").click();
  assert.equal(await apply.isDisabled(), false);
}
