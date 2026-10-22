import assert from "node:assert/strict";
import type { BrowserWindow } from "electron";

export async function checkPreviewCorners(win: BrowserWindow) {
  const result = await win.webContents.executeJavaScript(`(async () => {
    const anchor=document.querySelector('[data-testid=gen-ui-preview-anchor]');
    const plane=document.querySelector('[data-sandbox-page-root]:popover-open');
    const view=plane.querySelector('webview');
    const dialog=anchor.closest('[role=dialog]');
    const title=dialog.querySelector('[data-slot=dialog-title]');
    const titleCheck={visible:!title.classList.contains('sr-only'),toolbar:!!title.closest('[role=toolbar]'),linked:dialog.getAttribute('aria-labelledby')===title.id,text:title.textContent,full:title.title,overflow:getComputedStyle(title).textOverflow};
    const toggle=dialog.querySelector('button[aria-pressed]');
    const corners=()=>{const css=getComputedStyle(plane);return [css.borderTopLeftRadius,css.borderTopRightRadius,css.borderBottomLeftRadius,css.borderBottomRightRadius]};
    const radius=getComputedStyle(dialog).borderBottomLeftRadius;
    const initial=corners(),overflow=getComputedStyle(plane).overflow;
    toggle.click();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const withPanel=corners();
    toggle.click();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    return {radius,initial,overflow,withPanel,restored:corners(),retained:plane.querySelector('webview')===view,titleCheck};
  })()`);
  assert.notEqual(result.radius, "0px");
  assert.deepEqual(result.initial, ["0px", "0px", result.radius, result.radius]);
  assert.equal(result.overflow, "hidden");
  assert.deepEqual(result.withPanel, ["0px", "0px", "0px", "0px"]);
  assert.deepEqual(result.restored, result.initial);
  assert.equal(result.retained, true);
  assert.equal(result.titleCheck.visible, true);
  assert.equal(result.titleCheck.toolbar, true);
  assert.equal(result.titleCheck.linked, true);
  assert.ok(result.titleCheck.text.length > 0);
  assert.equal(result.titleCheck.full, result.titleCheck.text);
  assert.equal(result.titleCheck.overflow, "ellipsis");
  const untitled = await win.webContents.executeJavaScript(`(async () => {
    window.setViewTitle('');await new Promise(requestAnimationFrame);
    const title=document.querySelector('[role=dialog] [data-slot=dialog-title]');
    const hidden=title.classList.contains('sr-only');window.setViewTitle('Gen UI test');return hidden;
  })()`);
  assert.equal(untitled, true);
}

export async function checkLoading(
  win: BrowserWindow,
  waitHost: (predicate: string) => Promise<unknown>,
) {
  await win.webContents.executeJavaScript("window.holdDocument(); window.showReply('complete')");
  await waitHost(`document.querySelector('[role=status] svg')`);
  assert.deepEqual(
    await win.webContents.executeJavaScript(`(() => {
      const status=document.querySelector('[role=status]');
      return [status.textContent.trim(),getComputedStyle(status).fontSize,status.querySelector('svg').getAttribute('aria-hidden')];
    })()`),
    ["Loading…", "14px", "true"],
  );
  await win.webContents.executeJavaScript("window.releaseDocument()");
}
