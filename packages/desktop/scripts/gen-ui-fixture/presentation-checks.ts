import { BrowserWindow, clipboard, type WebContents } from "electron";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import type { PluginSandboxHandle } from "@zcode/shared/mcp-apps";

export async function checkCopyButton(win: BrowserWindow, preview = false) {
  const selector = `${preview ? '[role="dialog"] ' : ""}[data-testid="gen-ui-actions"] button`;
  const buttonState = () =>
    win.webContents.executeJavaScript(`(() => {
      const button = document.querySelector(${JSON.stringify(selector)});
      return {title: button.title, label: button.getAttribute('aria-label'),
        icon: button.querySelector('svg').outerHTML, disabled: button.disabled};
    })()`);
  const initial = await buttonState();
  assert.equal(initial.disabled, false);
  for (let attempt = 0; attempt < 2; attempt++) {
    clipboard.clear();
    await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const button = document.querySelector(${JSON.stringify(selector)});
      button.click();
      const end = Date.now() + 5000;
      const tick = () => {
        if (!button.disabled) resolve(true);
        else if (Date.now() > end) reject(new Error('Copy button did not become available'));
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    })`);
    assert.equal(clipboard.readImage().isEmpty(), false);
    assert.deepEqual(await buttonState(), initial);
  }
}

export async function checkCapture(
  win: BrowserWindow,
  guest: WebContents,
  latestHandle: PluginSandboxHandle,
  root: string,
) {
  await win.webContents.executeJavaScript("window.copy()");
  assert.equal(clipboard.readImage().isEmpty(), false);
  const fullImage = await guest.capturePage();
  const viewport = await win.webContents.executeJavaScript(
    "document.querySelector('webview').getBoundingClientRect().toJSON()",
  );
  const copiedSize = clipboard.readImage().getSize();
  assert.equal(
    copiedSize.width,
    Math.floor(((viewport.width - 5) * fullImage.getSize().width) / viewport.width) -
      Math.ceil((5 * fullImage.getSize().width) / viewport.width),
  );
  const request = {
    sandboxId: latestHandle.sandboxId,
    initId: latestHandle.initId,
    viewportSize: { width: viewport.width, height: viewport.height },
    captureRect: { x: 5, y: 5, width: viewport.width - 10, height: viewport.height - 10 },
  };
  const copyRequest = (value: unknown) =>
    `window.zcodePluginSandbox.copyImage(${JSON.stringify(value)})`;
  await assert.rejects(
    win.webContents.executeJavaScript(copyRequest({ ...request, initId: request.initId + 1 })),
    /no longer available/,
  );
  await assert.rejects(
    win.webContents.executeJavaScript(
      copyRequest({ ...request, captureRect: { ...request.captureRect, x: -1 } }),
    ),
    /too_small|greater|minimum/,
  );
  const otherWindow = new BrowserWindow({
    show: false,
    webPreferences: { preload: join(root, "preload.cjs") },
  });
  await otherWindow.loadURL("about:blank");
  await assert.rejects(
    otherWindow.webContents.executeJavaScript(copyRequest(request)),
    /no longer available/,
  );
  otherWindow.destroy();
}

export async function checkStaleCapture(win: BrowserWindow, guest: WebContents) {
  const captureStarted = Promise.withResolvers<void>(),
    captureGate = Promise.withResolvers<void>();
  const nativeCapture = guest.capturePage.bind(guest);
  guest.capturePage = async () => {
    const image = await nativeCapture();
    captureStarted.resolve();
    await captureGate.promise;
    return image;
  };
  clipboard.writeText("capture-stale-sentinel");
  await win.webContents.executeJavaScript(
    "window.copyResult=window.copy().then(()=>'',error=>String(error)); 'pending'",
  );
  await captureStarted.promise;
  await win.webContents.executeJavaScript("window.stop()");
  captureGate.resolve();
  assert.match(await win.webContents.executeJavaScript("window.copyResult"), /no longer available/);
  assert.equal(clipboard.readText(), "capture-stale-sentinel");
}

export async function checkInlineLayout(
  win: BrowserWindow,
  read: (code: string) => Promise<any>,
  artifacts: string,
) {
  await checkParentWidth(win, read);
  assert.equal(
    await win.webContents.executeJavaScript(
      "getComputedStyle(document.querySelector('[data-testid=gen-ui-card]')).borderWidth",
    ),
    "0px",
  );
  assert.equal(
    await win.webContents.executeJavaScript(
      "getComputedStyle(document.querySelector('[data-testid=gen-ui-card]')).backgroundColor",
    ),
    "rgba(0, 0, 0, 0)",
  );
  assert.equal(await read("getComputedStyle(document.body).fontSize"), "14px");
  await read(
    "document.querySelector('#preview').insertAdjacentHTML('beforeend','<small class=\"text-small text-muted\">Units and source</small>')",
  );
  assert.equal(await read("getComputedStyle(document.querySelector('small')).fontSize"), "12px");
  const scrollErrors = await win.webContents.executeJavaScript(`(async () => {
      const scroller=document.querySelector('#gen-ui-scroll'), view=document.querySelector('webview');
      const initial=view.getBoundingClientRect().top+scroller.scrollTop;
      const errors=[];
      for(const offset of [0,80,260,40,480,0]) {
        scroller.scrollTop=offset;
        errors.push(Math.abs(view.getBoundingClientRect().top+scroller.scrollTop-initial));
        await new Promise(requestAnimationFrame);
        errors.push(Math.abs(view.getBoundingClientRect().top+scroller.scrollTop-initial));
      }
      return errors;
    })()`);
  assert.ok(
    scrollErrors.every((error: number) => error < 1),
    JSON.stringify(scrollErrors),
  );
  await win.webContents.executeJavaScript("document.querySelector('#root').style.width='380px'");
  await read("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  assert.equal(await read("document.documentElement.scrollWidth <= innerWidth"), true);
  await win.webContents.executeJavaScript("document.querySelector('#root').style.width=''");
  await checkNativeScroll(win);
  await checkContentSizing(win, read, artifacts);
}

async function checkParentWidth(win: BrowserWindow, read: (code: string) => Promise<any>) {
  // 修复回归：736/1024 是生成时的设计参考，不应在已经定宽的会话列中再次截断卡片。
  const measurements = await win.webContents.executeJavaScript(`(async () => {
    const root=document.querySelector('#root'), result=[];
    const view=document.querySelector('webview');
    for (const mode of ['normal','wide']) {
      window.setInlineMode(mode);
      for (const width of [1200,900,390,1200]) {
        root.style.width=width+'px';
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        const card=document.querySelector('[data-testid=gen-ui-card]');
        const parent=card.parentElement, style=getComputedStyle(parent);
        result.push({mode,width,card:card.getBoundingClientRect().width,
          available:parent.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight),
          retained:document.querySelector('webview')===view});
      }
    }
    root.style.width='';
    return result;
  })()`);
  for (const measured of measurements) {
    assert.ok(Math.abs(measured.card - measured.available) < 1, JSON.stringify(measured));
    assert.equal(measured.retained, true);
  }
  await win.webContents.executeJavaScript("document.querySelector('#root').style.width='390px'");
  await read("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
  assert.equal(await read("document.documentElement.scrollWidth <= innerWidth"), true);
  await win.webContents.executeJavaScript("document.querySelector('#root').style.width=''");
}

async function checkNativeScroll(win: BrowserWindow) {
  const point = await win.webContents.executeJavaScript(`(() => {
    const style=document.createElement('style');
    style.textContent='#gen-ui-scroll::-webkit-scrollbar{width:12px}#gen-ui-scroll::-webkit-scrollbar-thumb{background:#888}';
    document.head.append(style);
    const scroller=document.querySelector('#gen-ui-scroll'); scroller.scrollTop=0;
    const rect=scroller.getBoundingClientRect();
    return {x:Math.round(rect.right-6), y:Math.round(rect.top+30)};
  })()`);
  win.webContents.debugger.attach("1.3");
  try {
    await win.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mousePressed",
      ...point,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await win.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y + 130,
      button: "left",
      buttons: 1,
    });
    await win.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: point.x,
      y: point.y + 130,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    const dragged = await win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{
      const end=Date.now()+2000; const tick=()=>{
        const scroll=document.querySelector('#gen-ui-scroll').scrollTop;
        if(scroll>0) resolve(scroll); else if(Date.now()>end) reject(new Error('Native scrollbar did not move')); else requestAnimationFrame(tick);
      }; tick();
    })`);
    assert.ok(dragged > 0);
    assert.ok(
      await win.webContents.executeJavaScript(
        `Math.abs(document.querySelector('[data-testid=gen-ui-anchor]').getBoundingClientRect().top-document.querySelector('webview').getBoundingClientRect().top)<1`,
      ),
    );
    await win.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      ...point,
      deltaX: 0,
      deltaY: -60,
    });
    await win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{
      const end=Date.now()+2000; const tick=()=>{
        const scroll=document.querySelector('#gen-ui-scroll').scrollTop;
        if(scroll<${dragged}) resolve(scroll); else if(Date.now()>end) reject(new Error('Native wheel did not move')); else requestAnimationFrame(tick);
      }; tick();
    })`);
  } finally {
    win.webContents.debugger.detach();
  }
  await win.webContents.executeJavaScript(
    "document.querySelector('#gen-ui-scroll').scrollTop=0; new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
  );
}

async function checkContentSizing(
  win: BrowserWindow,
  read: (code: string) => Promise<any>,
  artifacts: string,
) {
  const host = (code: string) => win.webContents.executeJavaScript(code);
  await read(`(() => {
    const originalNodes = [...document.body.childNodes];
    window.sizingOriginal = document.createElement('div');
    sizingOriginal.hidden = true;
    sizingOriginal.setAttribute('role', 'tooltip');
    document.body.append(sizingOriginal);
    sizingOriginal.append(...originalNodes);
    const root = document.createElement('div'); root.dataset.sizingProbe = '';
    root.style.cssText = 'display:flex;flex-direction:column;gap:16px';
    root.innerHTML = '<nav><button id="size-short">Controls</button><button id="size-tall">Charts</button></nav><section id="size-panel"></section>';
    document.body.append(root);
    window.sizePanel = (tall) => {
      document.querySelector('#size-panel').innerHTML = tall
        ? '<svg style="display:block;width:100%;height:auto" viewBox="0 0 1000 300"><path d="M0 250L500 60L1000 120" stroke="currentColor" fill="none" /></svg><div style="height:360.765625px">Chart footer</div>'
        : '<div style="height:180.265625px">Controls</div>';
    };
    document.querySelector('#size-short').onclick = () => sizePanel(false);
    document.querySelector('#size-tall').onclick = () => sizePanel(true);
    sizePanel(false);
    window.sizingRootMutations = 0;
    window.sizingObserver = new MutationObserver(records => sizingRootMutations += records.length);
    sizingObserver.observe(document.documentElement, {attributes:true,attributeFilter:['style']});
  })()`);
  const fitted = async () => {
    const target =
      await host(`({width:document.querySelector('webview').getBoundingClientRect().width,
      theme:document.documentElement.classList.contains('dark')?'dark':'light'})`);
    return read(`new Promise((resolve,reject) => {
    const end = Date.now()+4000;
    const tick = () => {
      const root = document.querySelector('[data-sizing-probe]'), css = getComputedStyle(document.body);
      const expected = Math.ceil(root.getBoundingClientRect().height + parseFloat(css.paddingTop) + parseFloat(css.paddingBottom));
      const measured = {expected, height:innerHeight, width:innerWidth, clientWidth:document.documentElement.clientWidth,
        scrollbar:getComputedStyle(document.documentElement).scrollbarWidth, scrollY};
      if (Math.abs(expected-innerHeight)<=1 && Math.abs(innerWidth-${target.width})<=1 && document.documentElement.dataset.theme===${JSON.stringify(target.theme)}) resolve(measured);
      else if(Date.now()>end) reject(new Error('Content height did not settle: '+JSON.stringify(measured)));
      else requestAnimationFrame(tick);
    }; requestAnimationFrame(tick);
  })`);
  };
  try {
    for (const width of [1100, 390]) {
      await host(`document.querySelector('#root').style.width='${width}px'`);
      for (const theme of ["light", "dark"]) {
        await host(`document.documentElement.classList.toggle('dark',${theme === "dark"})`);
        for (const tab of ["tall", "short", "tall", "short"]) {
          await read(`document.querySelector('#size-${tab}').click()`);
          const size = await fitted();
          assert.equal(size.scrollbar, "none", JSON.stringify(size));
          assert.equal(size.clientWidth, size.width, JSON.stringify(size));
          assert.equal(size.scrollY, 0, JSON.stringify(size));
        }
      }
    }
    // 修复回归：测量不得临时写 html 高度，影响原生滚动条布局。
    await read("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    await read("window.sizingRootMutations=0; document.querySelector('#size-tall').click()");
    await fitted();
    assert.equal(await read("window.sizingRootMutations"), 0);
    await read(
      "document.querySelector('#size-panel').insertAdjacentHTML('beforeend','<div id=size-extra style=height:123.5px>More data</div>')",
    );
    await fitted();
    await read("document.querySelector('#size-extra').remove()");
    const beforeTooltip = await fitted();
    await read(
      "document.body.insertAdjacentHTML('beforeend','<div data-sizing-probe role=tooltip style=\"position:absolute;top:2000px\">Tip</div>')",
    );
    await read("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    assert.equal((await fitted()).height, beforeTooltip.height);
    await read("document.querySelector('[role=tooltip][data-sizing-probe]').remove()");
    await host("document.querySelector('#root').style.width='1100px'");
    await fitted();
    await host("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    await writeFile(
      join(artifacts, "inline-charts.png"),
      (await win.webContents.capturePage()).toPNG(),
    );
    const point = await host(`(() => {
      document.querySelector('#gen-ui-scroll').scrollTop=0;
      const rect=document.querySelector('webview').getBoundingClientRect();
      return {x:Math.round(rect.left+80), y:Math.round(rect.top+120)};
    })()`);
    win.webContents.debugger.attach("1.3");
    try {
      await win.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        ...point,
        deltaX: 0,
        deltaY: 160,
      });
      await host(`new Promise((resolve,reject)=>{
        const end=Date.now()+2000; const tick=()=>{
          if(document.querySelector('#gen-ui-scroll').scrollTop>0) resolve(true);
          else if(Date.now()>end) reject(new Error('Wheel over the chart did not scroll the conversation'));
          else requestAnimationFrame(tick);
        };tick();
      })`);
      assert.equal(await read("scrollY"), 0);
    } finally {
      win.webContents.debugger.detach();
      await host("document.querySelector('#gen-ui-scroll').scrollTop=0");
    }
    await read("document.querySelector('#size-panel').style.height='calc(100vh + 10px)'");
    const feedback = await read(`(async () => {
      const heights=[];
      for(let i=0;i<24;i++){await new Promise(requestAnimationFrame); heights.push(innerHeight)}
      return heights;
    })()`);
    assert.equal(new Set(feedback.slice(-8)).size, 1, JSON.stringify(feedback));
    assert.ok(feedback.at(-1) < 2000, JSON.stringify(feedback));
    await read("document.querySelector('#size-panel').style.height='12000px'");
    await host(`new Promise((resolve,reject) => {
      const end=Date.now()+4000; const tick=()=>{
        const height=document.querySelector('[data-testid="gen-ui-anchor"]').style.height;
        if(height==='10000px') resolve(true);
        else if(Date.now()>end) reject(new Error('Height limit did not settle: '+height));
        else requestAnimationFrame(tick);
      };tick();
    })`);
    assert.equal(await read("scrollTo(0,10000); scrollY>0"), true);
    await read(
      "scrollTo(0,0); document.querySelector('#size-panel').style.height=''; sizePanel(false)",
    );
    await fitted();
    process.stdout.write(
      `Gen UI sizing: wide/narrow, light/dark, tabs, nested changes, tooltip and viewport feedback passed\n`,
    );
  } finally {
    await read(
      `sizingObserver.disconnect(); document.body.append(...sizingOriginal.childNodes); sizingOriginal.remove(); document.querySelectorAll('[data-sizing-probe]').forEach(node=>node.remove())`,
    );
    await host(
      "document.querySelector('#root').style.width=''; document.documentElement.classList.remove('dark')",
    );
  }
}
