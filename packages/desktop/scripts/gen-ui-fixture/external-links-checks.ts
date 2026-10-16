import assert from "node:assert/strict";
import { app, type BrowserWindow, type WebContents } from "electron";

// 使用生产桥接与手势校验；只替换最终 opener，避免测试启动系统浏览器。
export async function checkExternalLinks(
  win: BrowserWindow,
  guest: WebContents,
  read: (code: string) => Promise<any>,
) {
  assert.deepEqual(await read("Object.keys(window.zcode).sort()"), [
    "openExternal",
    "sendFollowUpMessage",
    "setWidgetState",
    "widgetState",
  ]);
  const inspect = () => win.webContents.executeJavaScript("window.inspectReact()");
  const wait = (predicate: string, execute = read) =>
    execute(`new Promise((resolve,reject)=>{
      const end=Date.now()+5000;
      const tick=()=>{if(${predicate})resolve(true);else if(Date.now()>end)reject(new Error('Link condition timed out: '+${JSON.stringify(predicate)}));else requestAnimationFrame(tick)};
      tick();
    })`).catch(async (error) => {
      process.stderr.write(
        JSON.stringify({
          host: await inspect(),
          guest: await read(
            "({events:window.linkEvents,errors:window.linkErrors,probe:document.getElementById('link-probe').outerHTML,point:document.getElementById('link-probe').getBoundingClientRect().toJSON()})",
          ),
          shell: await guest.mainFrame.executeJavaScript(
            "document.querySelector('iframe').getBoundingClientRect().toJSON()",
          ),
        }) + "\n",
      );
      throw error;
    });
  const click = async (button: "left" | "middle" = "left", modifiers: string[] = []) => {
    app.focus({ steal: true });
    win.focus();
    guest.focus();
    const point = await read(`(() => {
      const r=document.getElementById('link-probe').getBoundingClientRect();
      return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};
    })()`);
    await win.webContents.capturePage();
    // CDP 能命中嵌套 iframe，但不发 Electron input-event；先用原生修饰键登记手势。
    guest.sendInputEvent({ type: "keyDown", keyCode: "Shift" });
    guest.sendInputEvent({ type: "keyUp", keyCode: "Shift" });
    guest.debugger.attach("1.3");
    try {
      const keys = modifiers.includes("meta") ? 4 : modifiers.includes("control") ? 2 : 0;
      await guest.debugger.sendCommand("Input.dispatchMouseEvent", {
        type: "mousePressed",
        ...point,
        button,
        buttons: button === "middle" ? 4 : 1,
        clickCount: 1,
        modifiers: keys,
      });
      await guest.debugger.sendCommand("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        ...point,
        button,
        buttons: 0,
        clickCount: 1,
        modifiers: keys,
      });
    } finally {
      guest.debugger.detach();
    }
  };
  await read(`(() => {
    const probe=document.createElement('a');probe.id='link-probe';
    probe.style.cssText='position:fixed;top:4px;left:4px;z-index:99999;padding:12px;background:white;color:black';
    probe.innerHTML='<span>Open subscription</span>';document.body.append(probe);
    window.linkErrors=[];
    window.linkEvents=[];
    for(const type of ['pointerdown','pointerup','click','auxclick'])document.addEventListener(type,event=>window.linkEvents.push({type,trusted:event.isTrusted,target:event.target.outerHTML,x:event.clientX,y:event.clientY}),true);
    window.addEventListener('zcode:error',event=>window.linkErrors.push(String(event.detail)));
  })()`);
  const originalUrl = await read("location.href");
  let expected = 0;
  const openedOnce = async (url: string) => {
    expected++;
    await wait(`window.inspectReact().opened.length===${expected}`, (code) =>
      win.webContents.executeJavaScript(code),
    );
    assert.equal((await inspect()).opened.at(-1), url);
    assert.equal(await read("location.href"), originalUrl);
    assert.equal(await read("window.starts"), 1);
  };
  for (const target of ["", "_blank", "_self"]) {
    await read(
      `Object.assign(document.getElementById('link-probe'),{href:'https://example.com/subscribe',target:${JSON.stringify(target)}})`,
    );
    await click();
    await openedOnce("https://example.com/subscribe");
  }
  await click("left", [process.platform === "darwin" ? "meta" : "control"]);
  await openedOnce("https://example.com/subscribe");
  await click("middle");
  await openedOnce("https://example.com/subscribe");
  await read("document.getElementById('link-probe').focus()");
  guest.sendInputEvent({ type: "keyDown", keyCode: "Shift" });
  guest.sendInputEvent({ type: "keyUp", keyCode: "Shift" });
  guest.debugger.attach("1.3");
  try {
    await guest.debugger.sendCommand("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    });
    await guest.debugger.sendCommand("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    });
  } finally {
    guest.debugger.detach();
  }
  await openedOnce("https://example.com/subscribe");

  // 页面可取消默认行为，避免自定义点击处理与委托处理重复打开。
  await read(`document.getElementById('link-probe').onclick=event=>{
    event.preventDefault();window.linkResult=window.zcode.openExternal({href:'http://example.com/script'}).then(()=>'',String);
  }`);
  await click();
  await wait("window.linkResult");
  assert.equal(await read("window.linkResult"), "");
  await openedOnce("http://example.com/script");
  assert.match(
    await read(
      "window.zcode.openExternal({href:'https://example.com/automatic'}).then(()=>'',String)",
    ),
    /gesture/i,
  );
  for (const href of [
    "relative/path",
    "file:///tmp/test",
    "javascript:void(0)",
    "data:text/plain,test",
  ]) {
    assert.match(
      await read(`window.zcode.openExternal({href:${JSON.stringify(href)}}).then(()=>'',String)`),
      /URL|HTTP/i,
    );
  }
  await read(
    "document.getElementById('link-probe').onclick=null;document.getElementById('link-probe').click()",
  );
  // 合成点击不能利用之前未消费的用户手势；下载与片段也不进入 opener。
  await read("document.getElementById('link-probe').download='plan.html'");
  await click();
  await read(
    "document.getElementById('link-probe').removeAttribute('download');document.getElementById('link-probe').click()",
  );
  await read("document.getElementById('link-probe').href='#first'");
  await click();
  await wait("location.hash==='#first'");
  await read(
    "history.replaceState(null,'',location.pathname);document.getElementById('link-probe').href='file:///tmp/test'",
  );
  await click();
  await wait("window.linkErrors.length>0");
  assert.match(await read("window.linkErrors.at(-1)"), /HTTP/i);
  assert.equal((await inspect()).opened.length, expected);

  await win.webContents.executeJavaScript("window.rejectExternalOpen(true)");
  await read(`window.linkResult=null;document.getElementById('link-probe').onclick=event=>{
    event.preventDefault();window.linkResult=window.zcode.openExternal({href:'https://example.com/failure'}).then(()=>'',String);
  }`);
  await click();
  await wait("window.linkResult");
  assert.match(await read("window.linkResult"), /Fixture opener failed/);
  await win.webContents.executeJavaScript("window.rejectExternalOpen(false);window.holdGesture()");
  await read("window.linkResult=null");
  await click();
  await wait("window.inspectReact().gesturePending", (code) =>
    win.webContents.executeJavaScript(code),
  );
  await win.webContents.executeJavaScript("window.showReply('hidden');window.releaseGesture()");
  assert.match(await read("window.linkResult"), /active|closed/i);
  assert.match(
    await read(
      "window.zcode.openExternal({href:'https://example.com/hidden'}).then(()=>'',String)",
    ),
    /active|closed/i,
  );
  assert.equal((await inspect()).opened.length, expected);
  assert.deepEqual((await inspect()).messages, []);
  await read("document.getElementById('link-probe').remove()");
  await win.webContents.executeJavaScript("window.showReply('complete')");
}
