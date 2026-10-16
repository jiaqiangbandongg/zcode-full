import assert from "node:assert/strict";
import type { BrowserWindow, WebContents } from "electron";
import { evaluateGuest } from "./guest-evaluation.js";

/** 从宿主坐标发送鼠标事件，避免直接向 guest 注入点击绕过透明层命中测试。 */
export async function clickHostPoint(win: BrowserWindow, point: { x: number; y: number }) {
  win.webContents.debugger.attach("1.3");
  try {
    for (const type of ["mousePressed", "mouseReleased"])
      await win.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
        type,
        ...point,
        button: "left",
        clickCount: 1,
      });
    await win.webContents.executeJavaScript(
      "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    );
  } finally {
    win.webContents.debugger.detach();
  }
}

export async function checkPagePointerInput(win: BrowserWindow, guest: WebContents) {
  const page = (code: string) => evaluateGuest(guest, code);
  const before = Number(await page("document.querySelector('#counter').textContent"));
  for (const selector of ["#counter", "#input"]) {
    const local = await page(`(() => {
      const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return {x: r.x + r.width / 2, y: r.y + r.height / 2};
    })()`);
    const point = await win.webContents.executeJavaScript(`(() => {
      const view = document.querySelector('webview');
      const r = view.getBoundingClientRect();
      const x = Math.round(r.x + ${local.x}), y = Math.round(r.y + ${local.y});
      return {x, y, hit: document.elementFromPoint(x, y)?.tagName};
    })()`);
    assert.equal(point.hit, "WEBVIEW", JSON.stringify(point));
    await clickHostPoint(win, { x: point.x, y: point.y });
  }
  assert.equal(await page("document.querySelector('#counter').textContent"), String(before + 1));
  assert.equal(await page("document.activeElement.id"), "input");
  const input = await page(`(() => {
    const node = document.querySelector('#input');
    return {value: node.value, start: node.selectionStart, end: node.selectionEnd};
  })()`);
  win.webContents.debugger.attach("1.3");
  try {
    await win.webContents.debugger.sendCommand("Input.insertText", { text: "pointer-input" });
  } finally {
    win.webContents.debugger.detach();
  }
  assert.equal(
    await page("document.querySelector('#input').value"),
    input.value.slice(0, input.start) + "pointer-input" + input.value.slice(input.end),
    JSON.stringify(input),
  );
}
