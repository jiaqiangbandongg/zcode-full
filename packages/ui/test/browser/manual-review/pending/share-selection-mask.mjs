import assert from "node:assert/strict";

export async function verifySelectionScrollMask(panel, screenshotPath) {
  const viewport = panel.locator('[data-slot="scroll-area-viewport"]');
  const footer = panel.getByTestId("conversation-share-selection-footer");
  const bounds = await viewport.boundingBox();
  const header = await panel.getByTestId("conversation-share-selection-header").boundingBox();
  assert.equal(header.y, (await panel.boundingBox()).y);
  assert.equal(bounds.y, header.y + header.height);
  assert.equal(bounds.y + bounds.height, (await footer.boundingBox()).y);
  const readMask = () => viewport.evaluate((node) => getComputedStyle(node).maskImage);
  const scroll = async (position) => {
    await viewport.evaluate(async (node, next) => {
      node.scrollTop = next;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, position);
  };
  const maxScroll = await viewport.evaluate((node) => node.scrollHeight - node.clientHeight);
  await scroll(0);
  if (maxScroll <= 1) {
    assert.equal(await readMask(), "none");
    return;
  }
  const topMask = await readMask();
  assert.match(topMask, /32px/);
  assert.equal((topMask.match(/rgba\(0, 0, 0, 0\)/g) ?? []).length, 1);
  await scroll(maxScroll / 2);
  const middleMask = await readMask();
  assert.equal((middleMask.match(/rgba\(0, 0, 0, 0\)/g) ?? []).length, 2);
  assert.equal(await footer.evaluate((node) => getComputedStyle(node).maskImage), "none");
  assert.equal(
    await panel
      .getByTestId("conversation-share-selection-scroll-thumb")
      .evaluate((node) => getComputedStyle(node).maskImage),
    "none",
  );
  await panel.screenshot({ path: screenshotPath });
  await scroll(maxScroll);
  const bottomMask = await readMask();
  assert.notEqual(bottomMask, topMask);
  assert.equal((bottomMask.match(/rgba\(0, 0, 0, 0\)/g) ?? []).length, 1);
  await scroll(0);
  assert.equal(await readMask(), topMask);
}
