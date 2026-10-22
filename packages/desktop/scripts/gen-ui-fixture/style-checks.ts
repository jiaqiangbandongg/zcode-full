import assert from "node:assert/strict";
import { webContents, type BrowserWindow } from "electron";
import { checkCompactButtons } from "./compact-button-checks.js";
import { checkControlStates } from "./control-state-checks.js";

/** 用真实 guest computed style 验证 token 同步和容器层级，不用 CSS 字符串模拟浏览器。 */
export async function checkUnifiedStyles(win: BrowserWindow, read: (code: string) => Promise<any>) {
  win.focus();
  const guest = webContents
    .getAllWebContents()
    .find((contents) => contents.getType() === "webview")!;
  // 自动化窗口未必拥有系统焦点；通过 CDP 强制伪类，由 Chromium 验证焦点样式。
  guest.debugger.attach("1.3");
  const { targetInfos } = await guest.debugger.sendCommand("Target.getTargets");
  const url = guest.mainFrame.frames.find((frame) => frame.url.includes("/instance/"))!.url;
  const target = targetInfos.find((info: { url: string }) => info.url === url);
  const { sessionId } = await guest.debugger.sendCommand("Target.attachToTarget", {
    targetId: target.targetId,
    flatten: true,
  });
  const send = (method: string, params = {}) =>
    guest.debugger.sendCommand(method, params, sessionId);
  await send("DOM.enable");
  await send("CSS.enable");
  await read(`(() => {
    const probe=document.createElement('div');probe.id='style-probe';
    probe.innerHTML='<style>#style-probe *{transition:none}</style><h1>Heading</h1><h2>Heading</h2><h3>Heading</h3><button class="btn">Outline</button><button class="btn btn-primary">Primary</button><button class="btn btn-secondary">Secondary</button><button class="btn btn-ghost" disabled>Ghost</button><input class="form-control" id="genui-focus-probe" placeholder="Input"><select class="form-select"><option>Option</option></select><textarea class="form-control">Text</textarea><label class="form-check"><input type="checkbox" class="form-check-input">Check</label><label class="form-check form-switch"><input type="checkbox" class="form-check-input">Switch</label><div class="card"><div><button class="btn">First</button><div class="card"><div><button class="btn">Second</button><div class="card"><button class="btn">Third</button><div class="card">Fourth</div></div></div></div></div></div>';
    document.body.append(probe);
  })()`);
  await send("DOM.getDocument", { depth: -1 });
  const search = await send("DOM.performSearch", { query: "#genui-focus-probe" });
  assert.equal(search.resultCount, 1);
  const { nodeIds } = await send("DOM.getSearchResults", {
    searchId: search.searchId,
    fromIndex: 0,
    toIndex: 1,
  });
  await send("CSS.forcePseudoState", {
    nodeId: nodeIds[0],
    forcedPseudoClasses: ["focus", "focus-visible"],
  });
  try {
    for (const dark of [false, true]) {
      for (const width of [1100, 390]) {
        for (const size of [14, 18]) {
          await win.webContents.executeJavaScript(`(() => {
            const root=document.documentElement;root.classList.toggle('dark',${dark});
            root.classList.toggle('theme-zai-dark',${dark});root.classList.toggle('theme-zai-light',${!dark});
            root.style.setProperty('--ui-font-size','${size}px');document.querySelector('#root').style.width='${width}px';
          })()`);
          await read(`new Promise((resolve,reject)=>{
            const end=Date.now()+3000;const tick=()=>{
              if(getComputedStyle(document.querySelector('#style-probe .btn')).fontSize==='${size}px' && document.documentElement.dataset.theme==='${dark ? "dark" : "light"}')resolve(true);
              else if(Date.now()>end)reject(new Error('Style projection did not settle'));else requestAnimationFrame(tick);
            };tick();
          })`);
          const actual = await read(`(() => {
            const root=document.querySelector('#style-probe');
            const css=selector=>getComputedStyle(root.querySelector(selector));
            return {headings:[...root.querySelectorAll('h1,h2,h3')].map(node=>getComputedStyle(node).fontSize),
              radius:[...root.querySelectorAll('.card')].map(node=>getComputedStyle(node).borderRadius),
              controls:[...root.querySelectorAll('.card .btn')].map(node=>getComputedStyle(node).borderRadius),
              buttonHeight:css('.btn').minHeight,inputHeight:css('.form-control').minHeight,
              textareaHeight:css('textarea').minHeight,disabled:css('.btn-ghost').opacity,
              checkbox:css('.form-check-input').width,switchHeight:css('.form-switch input').height,
              inputBg:css('.form-control').backgroundColor,primary:css('.btn-primary').backgroundColor,
              foreground:css('.btn-ghost').color,selectBg:css('.form-select').backgroundColor};
          })()`);
          assert.deepEqual(actual.headings, [`${size + 4}px`, `${size + 2}px`, `${size}px`]);
          await checkCompactButtons(read, send);
          await checkControlStates(read, send);
          assert.deepEqual(actual.radius, ["12px", "8px", "6px", "4px"]);
          assert.deepEqual(actual.controls, ["8px", "6px", "4px"]);
          assert.equal(actual.buttonHeight, "28px");
          assert.equal(actual.inputHeight, "36px");
          assert.equal(actual.textareaHeight, "64px");
          assert.equal(actual.disabled, "0.5");
          assert.equal(actual.checkbox, "16px");
          assert.equal(actual.switchHeight, "18px");
          assert.equal(actual.inputBg, actual.selectBg);
          const host = await win.webContents.executeJavaScript(`(() => {
            const css=getComputedStyle(document.documentElement);
            const resolve=name=>{const node=document.createElement('span');node.style.color=css.getPropertyValue(name);document.body.append(node);const color=getComputedStyle(node).color;node.remove();return color;};
            return {input:resolve('--color-input'),primary:resolve('--color-primary')};
          })()`);
          assert.equal(actual.inputBg, host.input);
          assert.equal(actual.primary, host.primary);
          const states = await read(`(() => {
            const root=document.querySelector('#style-probe'), input=root.querySelector('input');input.focus();
            const check=root.querySelector('.form-check-input');check.click();
            const css=getComputedStyle(input);const checked=getComputedStyle(check).backgroundColor;
            check.indeterminate=true;const mixed=getComputedStyle(check).backgroundColor;
            const toggle=root.querySelector('.form-switch input');toggle.click();
            const outline=root.querySelector('.btn');outline.setAttribute('aria-pressed','true');
            input.focus();
            const result={focusVisible:input.matches(':focus-visible'),active:document.activeElement?.outerHTML,focused:document.hasFocus(),border:css.borderColor,background:css.backgroundColor,
              placeholder:getComputedStyle(input,'::placeholder').color,checked,mixed,switchColor:getComputedStyle(toggle).backgroundColor,
              selected:getComputedStyle(outline).backgroundColor,indeterminateMark:getComputedStyle(check,'::before').height};
            input.blur();outline.removeAttribute('aria-pressed');check.checked=false;check.indeterminate=false;toggle.checked=false;return result;
          })()`);
          const expected = await win.webContents.executeJavaScript(`(() => {
            const root=getComputedStyle(document.documentElement);const resolve=name=>{const node=document.createElement('span');node.style.color=root.getPropertyValue(name);document.body.append(node);const value=getComputedStyle(node).color;node.remove();return value;};
            return {border:resolve('--color-input-border-focused'),background:resolve('--color-input-focused'),placeholder:resolve('--color-foreground-subtlest'),selected:resolve('--color-selected')};
          })()`);
          assert.match(states.active, /genui-focus-probe/);
          assert.equal(states.border, expected.border);
          assert.equal(states.background, expected.background);
          assert.equal(states.placeholder, expected.placeholder);
          assert.equal(states.checked, host.primary);
          assert.equal(states.mixed, host.primary);
          assert.equal(states.switchColor, host.primary);
          assert.equal(states.selected, expected.selected);
          assert.equal(states.indeterminateMark, "2px");
        }
      }
    }
  } finally {
    await send("CSS.forcePseudoState", { nodeId: nodeIds[0], forcedPseudoClasses: [] });
    guest.debugger.detach();
    await read("document.querySelector('#style-probe').remove()");
    await win.webContents.executeJavaScript(
      "document.documentElement.style.removeProperty('--ui-font-size');document.documentElement.classList.remove('theme-zai-dark','theme-zai-light');document.querySelector('#root').style.width=''",
    );
  }
}
