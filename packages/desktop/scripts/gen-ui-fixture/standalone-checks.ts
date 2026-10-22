import assert from "node:assert/strict";
import { join } from "node:path";
import { BrowserWindow } from "electron";
import { checkControlStates } from "./control-state-checks.js";

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
    for (const theme of ["light", "dark"]) {
      const styles = await frame.executeJavaScript(`(() => {
        document.documentElement.dataset.theme=${JSON.stringify(theme)};
        const probe=document.createElement('div');probe.innerHTML='<h1>Title</h1><h2>Title</h2><h3>Title</h3><div class="card"><button class="btn btn-primary">Primary</button><input class="form-control"><select class="form-select"><option>Option</option></select></div>';
        document.body.append(probe);const css=selector=>getComputedStyle(probe.querySelector(selector));
        const result={headings:[...probe.querySelectorAll('h1,h2,h3')].map(node=>getComputedStyle(node).fontSize),radius:css('.card').borderRadius,input:css('input').minHeight,primary:css('.btn').backgroundColor};probe.remove();return result;
      })()`);
      assert.deepEqual(styles.headings, ["18px", "16px", "14px"]);
      assert.equal(styles.radius, "12px");
      assert.equal(styles.input, "36px");
      assert.equal(styles.primary, theme === "light" ? "rgb(0, 0, 0)" : "rgb(255, 255, 255)");
    }
    win.webContents.debugger.attach("1.3");
    const { targetInfos } = await win.webContents.debugger.sendCommand("Target.getTargets");
    const target = targetInfos.find((info: { url: string }) => info.url === "about:srcdoc");
    const { sessionId } = await win.webContents.debugger.sendCommand("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: true,
    });
    try {
      const send = (method: string, params = {}) =>
        win.webContents.debugger.sendCommand(method, params, sessionId);
      await send("DOM.enable");
      await send("CSS.enable");
      await send("DOM.getDocument", { depth: -1 });
      for (const theme of ["light", "dark"]) {
        await frame.executeJavaScript(`document.documentElement.dataset.theme='${theme}'`);
        await checkControlStates((code) => frame.executeJavaScript(code), send, true);
      }
      await win.webContents.debugger.sendCommand(
        "Emulation.setTouchEmulationEnabled",
        {
          enabled: true,
        },
        sessionId,
      );
      await win.webContents.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await win.webContents.debugger.sendCommand("Emulation.setEmitTouchEventsForMouse", {
        enabled: true,
        configuration: "mobile",
      });
      const touch = await frame.executeJavaScript(`(() => {
        const probe=document.createElement('div');probe.innerHTML='<button class="btn btn-xs">Touch</button><input class="form-control form-control-xs">';document.body.append(probe);
        const button=getComputedStyle(probe.querySelector('button')),input=getComputedStyle(probe.querySelector('input'));
        const result={coarse:matchMedia('(pointer:coarse)').matches,button:button.minHeight,input:input.minHeight,font:input.fontSize};probe.remove();return result;
      })()`);
      assert.equal(touch.coarse, true);
      assert.equal(touch.button, "44px");
      assert.equal(touch.input, "44px");
      assert.equal(touch.font, "16px");
    } finally {
      await win.webContents.debugger.sendCommand(
        "Emulation.setTouchEmulationEnabled",
        {
          enabled: false,
        },
        sessionId,
      );
      await win.webContents.debugger.sendCommand("Emulation.clearDeviceMetricsOverride");
      await win.webContents.debugger.sendCommand("Emulation.setEmitTouchEventsForMouse", {
        enabled: false,
      });
      win.webContents.debugger.detach();
    }
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
