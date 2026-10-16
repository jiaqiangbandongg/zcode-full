import assert from "node:assert/strict";
import { join } from "node:path";
import { BrowserWindow } from "electron";

/** 导出资源必须独立工作，不能依赖桌面 preload 或正在运行的 Agent。 */
export async function checkStandalone(root: string) {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    const load = async () => {
      await win.loadFile(join(root, "standalone.html"));
      const frame = win.webContents.mainFrame.frames.find((item) => item.url === "about:srcdoc");
      assert.ok(frame, "Export must use an isolated srcdoc iframe");
      await frame.executeJavaScript(`new Promise(resolve => {
        if (document.readyState === 'complete') resolve(true);
        else addEventListener('load', () => resolve(true), {once:true});
      })`);
      return frame;
    };
    let frame = await load();
    assert.equal(await frame.executeJavaScript("typeof require"), "undefined");
    assert.equal(await frame.executeJavaScript("window.initialCount"), 0);
    assert.equal(await frame.executeJavaScript("d3.version"), "7.9.0");
    assert.equal(
      await frame.executeJavaScript(
        "document.querySelector('[data-d3-probe]').getAttribute('width')",
      ),
      "7",
    );
    assert.equal(await frame.executeJavaScript("typeof FloatingUIDOM.computePosition"), "function");
    assert.equal(
      await frame.executeJavaScript("Boolean(document.querySelector('svg.lucide-search'))"),
      true,
    );
    await frame.executeJavaScript(`new Promise((resolve,reject)=>{
      document.querySelector('[data-tooltip]').dispatchEvent(new PointerEvent('click',{pointerType:'touch',detail:1,bubbles:true}));
      const end=Date.now()+2000;const tick=()=>{if(document.querySelector('[role=tooltip]')?.style.visibility==='visible')resolve(true);else if(Date.now()>end)reject(new Error('Offline tooltip failed'));else requestAnimationFrame(tick)};tick();
    })`);
    assert.equal(await frame.executeJavaScript("window.calendarWasReady"), true);
    assert.equal(
      await frame.executeJavaScript("Boolean(document.querySelector('viz-calendar').shadowRoot)"),
      true,
    );
    assert.equal(await frame.executeJavaScript("window.zcode.statePersistence"), "local");
    await frame.executeJavaScript(
      "window.zcode.setWidgetState({privateContent:{count:7},modelContent:'count:7'})",
    );
    frame = await load();
    assert.equal(await frame.executeJavaScript("window.initialCount"), 7);
    assert.equal(await frame.executeJavaScript("d3.version"), "7.9.0");
    assert.equal(await frame.executeJavaScript("window.zcode.stateModelContext"), "none");
    assert.equal(await frame.executeJavaScript("typeof globalThis.Tweak"), "undefined");
    assert.equal(
      await frame.executeJavaScript(
        "window.zcode.sendFollowUpMessage({prompt:'test'}).then(()=>true)",
      ),
      true,
    );
  } finally {
    win.destroy();
  }
}
