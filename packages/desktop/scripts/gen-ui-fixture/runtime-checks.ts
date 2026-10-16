import assert from "node:assert/strict";
import type { BrowserWindow } from "electron";

type Read = (code: string) => Promise<any>;
const waitFor = (read: Read, predicate: string) =>
  read(`new Promise((resolve,reject)=>{
  const end=Date.now()+4000; const tick=()=>{
    if(${predicate})resolve(true);else if(Date.now()>end)reject(new Error(${JSON.stringify(predicate)} + ' ' + JSON.stringify({focus:document.activeElement?.outerHTML,tip:document.getElementById('tip')?.matches(':focus-visible'),popup:document.querySelector('[role=tooltip]')?.outerHTML})));else requestAnimationFrame(tick);
  };tick();
})`);

export async function checkRuntimeWidgets(read: Read) {
  await read("document.querySelector('#second-tab').click()");
  assert.equal(await read("document.querySelector('#second').hidden"), false);
  assert.equal(await read("document.querySelector('#first').hidden"), true);
  assert.ok(await read("Boolean(document.querySelector('svg.lucide'))"));
  await read(
    "document.querySelector('#second-tab').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}))",
  );
  assert.equal(await read("document.querySelector('#first').hidden"), false);
  assert.equal(await read("typeof FloatingUIDOM.computePosition"), "function");
  assert.equal(await read("typeof lucide.createIcons"), "function");
  await read(
    `document.body.insertAdjacentHTML('beforeend','<div id="runtime-probe"><span id="described">Existing description</span><button id="tip" data-tooltip="Runtime tooltip" aria-describedby="described">Tooltip</button><div id="shadow"></div><i id="dynamic-icon" data-lucide="search"></i><div class="nav" role="tablist"><button id="shared-a" role="tab" aria-controls="shared-panel">A</button><button id="shared-b" role="tab" aria-controls="shared-panel">B</button></div><div id="shared-panel">Shared panel</div></div>')`,
  );
  await read("new Promise(requestAnimationFrame)");
  assert.equal(await read("document.getElementById('dynamic-icon').tagName"), "I");
  await read("lucide.createIcons({attrs:{width:16,height:16}})");
  assert.equal(await read("document.getElementById('dynamic-icon').tagName.toLowerCase()"), "svg");
  await read("document.getElementById('shared-a').click()");
  assert.equal(await read("document.getElementById('shared-panel').hidden"), false);
  await read(
    "document.getElementById('shared-a').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))",
  );
  assert.equal(
    await read("document.getElementById('shared-b').getAttribute('aria-selected')"),
    "true",
  );
  assert.equal(await read("document.getElementById('shared-panel').hidden"), false);

  // 上游只为 focus-visible 自动打开；脚本 focus 不等于用户键盘输入，悬停走实际延迟路径。
  await read(
    "document.getElementById('tip').dispatchEvent(new PointerEvent('pointerover',{pointerType:'mouse',bubbles:true}))",
  );
  await waitFor(read, "document.querySelector('[role=tooltip]')?.style.visibility === 'visible'");
  assert.ok(
    (await read("document.getElementById('tip').getAttribute('aria-describedby')")).startsWith(
      "described ",
    ),
  );
  await read("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
  assert.equal(await read("document.querySelector('[role=tooltip]') === null"), true);
  assert.equal(
    await read("document.getElementById('tip').getAttribute('aria-describedby')"),
    "described",
  );
  for (const placement of ["top", "right", "bottom", "left"]) {
    await read(`(() => {
      const tip=document.getElementById('tip');tip.dataset.tooltipPlacement=${JSON.stringify(placement)};
      tip.style.cssText='position:fixed;top:150px;left:250px';
      tip.dispatchEvent(new PointerEvent('click',{pointerType:'touch',detail:1,bubbles:true}));
    })()`);
    await waitFor(read, "document.querySelector('[role=tooltip]')?.style.visibility === 'visible'");
    const bounds = await read(
      `(() => {const t=document.getElementById('tip').getBoundingClientRect(),p=document.querySelector('[role=tooltip]').getBoundingClientRect();return {tip:t.toJSON(),popup:p.toJSON(),width:innerWidth,height:innerHeight}})()`,
    );
    assert.ok(bounds.popup.left >= 0 && bounds.popup.right <= bounds.width + 1);
    assert.ok(bounds.popup.top >= 0 && bounds.popup.bottom <= bounds.height + 1);
    if (placement === "top") assert.ok(bounds.popup.bottom <= bounds.tip.top);
    if (placement === "bottom") assert.ok(bounds.popup.top >= bounds.tip.bottom);
    if (placement === "left") assert.ok(bounds.popup.right <= bounds.tip.left);
    if (placement === "right") assert.ok(bounds.popup.left >= bounds.tip.right);
    await read(
      "document.getElementById('tip').dispatchEvent(new PointerEvent('pointerout',{pointerType:'touch',bubbles:true}))",
    );
    assert.equal(await read("document.querySelectorAll('[role=tooltip]').length"), 1);
    await read(
      "document.body.dispatchEvent(new PointerEvent('click',{pointerType:'touch',detail:1,bubbles:true}))",
    );
    assert.equal(await read("document.querySelector('[role=tooltip]') === null"), true);
  }
  await read(
    `document.getElementById('shadow').attachShadow({mode:'open'}).innerHTML='<button data-tooltip="Shadow tooltip">Shadow</button>'`,
  );
  await read("new Promise(requestAnimationFrame)");
  await read(
    "document.getElementById('shadow').shadowRoot.querySelector('button').dispatchEvent(new PointerEvent('click',{pointerType:'touch',detail:1,bubbles:true,composed:true}))",
  );
  await waitFor(read, "document.querySelector('[role=tooltip]')?.style.visibility === 'visible'");
  assert.equal(
    await read("document.querySelector('[role=tooltip]').textContent"),
    "Shadow tooltip",
  );
  await read("document.getElementById('shadow').remove()");
  await waitFor(read, "!document.querySelector('[role=tooltip]')");
  await read("document.getElementById('runtime-probe').remove()");
}

export async function checkCalendarAndCarousel(read: Read) {
  assert.equal(await read("window.calendarWasReady"), true);
  assert.equal(
    await read("document.querySelector('.viz-carousel').dataset.activeVariant"),
    "First",
  );
  await read("document.querySelector('.viz-carousel-next').click()");
  assert.equal(
    await read("document.querySelector('.viz-carousel').dataset.activeVariant"),
    "Second",
  );
  await read("document.querySelector('.viz-carousel-previous').click()");
  assert.equal(
    await read("document.querySelector('.viz-carousel').dataset.activeVariant"),
    "First",
  );
  await read(`(() => {
    const calendar=document.createElement('viz-calendar');calendar.id='calendar-probe';calendar.setAttribute('date','2026-09-29');calendar.setAttribute('start','09:00');calendar.setAttribute('end','12:00');calendar.setAttribute('interactive','');
    calendar.events=[{title:'One',start:'09:00',end:'10:00'},{title:'Two',start:'09:30',end:'10:30'}];
    calendar.addEventListener('eventselect',event=>window.calendarSelection=event.detail.index);document.body.append(calendar);
  })()`);
  const readCalendar = (expression: string) =>
    read(`(() => {const c=document.getElementById('calendar-probe');return ${expression}})()`);
  assert.equal(await readCalendar("c.shadowRoot.querySelectorAll('.event').length"), 2);
  assert.equal(
    await readCalendar(
      "c.shadowRoot.querySelectorAll('.event')[1].style.getPropertyValue('--lanes')",
    ),
    "2",
  );
  await readCalendar("c.shadowRoot.querySelector('button[data-event-index]').click()");
  assert.equal(await read("window.calendarSelection"), 0);
  await readCalendar("c.setAttribute('date','2026-02-30')");
  assert.ok(await readCalendar("c.shadowRoot.querySelector('[role=alert]') !== null"));
  await readCalendar("c.setAttribute('date','2026-09-29')");
  assert.equal(await readCalendar("c.shadowRoot.querySelectorAll('.event').length"), 2);
  await readCalendar("c.remove()");
}

export async function checkTweakLifecycle(read: Read, win: BrowserWindow) {
  const host = (code: string) => win.webContents.executeJavaScript(code);
  await read(`(() => {
    const container=document.createElement('div');container.id='tweak-probe';document.body.append(container);
    window.probeState={size:4};window.probeRenders=0;
    window.probeTweak=new Tweak({container,onChange:()=>window.probeRenders++});
    window.probeTweak.addSlider(window.probeState,'size',{min:0,max:10,label:'Probe'});
  })()`);
  await waitFor(host, "window.inspect().snapshot.groups.length === 3");
  const id = await host("window.inspect().snapshot.groups[2].controls[0].id");
  await host(`window.setProbeTweaks(${JSON.stringify({ [id]: 9 })})`);
  await waitFor(read, "window.probeState.size === 9");
  await read("window.probeTweak.dispose()");
  await waitFor(host, "window.inspect().snapshot.groups.length === 2");
  assert.equal(await read("window.probeState.size"), 4);
  await read(
    "window.probeTweak=new Tweak({container:document.getElementById('tweak-probe'),onChange:()=>{}});window.probeTweak.addToggle({enabled:true},'enabled')",
  );
  await waitFor(host, "window.inspect().snapshot.groups.length === 3");
  await read("document.getElementById('tweak-probe').remove()");
  await waitFor(host, "window.inspect().snapshot.groups.length === 2");
}
