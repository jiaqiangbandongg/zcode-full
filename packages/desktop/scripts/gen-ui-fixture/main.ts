import { app, BrowserWindow, ipcMain, protocol, webContents } from "electron";
import {
  checkCapture,
  checkStaleCapture,
  checkInlineLayout,
  checkCopyButton,
} from "./presentation-checks.js";
import { checkStandalone } from "./standalone-checks.js";
import { checkExternalLinks } from "./external-links-checks.js";
import { checkFileSummary } from "./file-summary-checks.js";
import {
  checkRuntimeWidgets,
  checkCalendarAndCarousel,
  checkTweakLifecycle,
} from "./runtime-checks.js";
import { checkInheritedOutput, prepareOutputFiles } from "./output-files.js";
import { installOfflineChecks } from "./offline-checks.js";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  installPluginSandboxHost,
  PLUGIN_SANDBOX_PRIVILEGED_SCHEME,
} from "../../src/main/pluginSandbox/index.js";
import { createGenUiService } from "../../../services/src/gen-ui/node.js";
const root = process.argv[2]!;
app.setPath("userData", join(root, "profile"));
const offline = installOfflineChecks();
protocol.registerSchemesAsPrivileged([PLUGIN_SANDBOX_PRIVILEGED_SCHEME]);
app.on("window-all-closed", () => {});
app.on("web-contents-created", (_, contents) =>
  contents.on("console-message", (event) =>
    process.stderr.write(`[${contents.getType()}] ${event.message}\n`),
  ),
);
const deadline = setTimeout(() => {
  process.stderr.write("Gen UI E2E deadline exceeded\n");
  app.exit(1);
}, 45_000);
void app
  .whenReady()
  .then(async () => {
    const sandbox = installPluginSandboxHost({
      rendererDir: root,
      aliasDir: root,
      preloadPath: join(root, "guest.cjs"),
      logger: { info() {}, warn: (...args) => process.stderr.write(JSON.stringify(args) + "\n") },
    });
    const win = new BrowserWindow({
      show: true,
      width: 1100,
      height: 820,
      webPreferences: {
        preload: join(root, "preload.cjs"),
        webviewTag: true,
        backgroundThrottling: false,
      },
    });
    const pending: string[] = [];
    win.webContents.on("will-attach-webview", (event, webPreferences, params) => {
      const result = sandbox.configureGuest({
        webPreferences,
        params,
        ownerWebContentsId: win.webContents.id,
      });
      if (!result.ok) event.preventDefault();
      else pending.push(result.sandboxId);
    });
    win.webContents.on("did-attach-webview", (_, guest) =>
      sandbox.attachGuest({ guest, hostWebContents: win.webContents, sandboxId: pending.shift()! }),
    );
    const output = await prepareOutputFiles(root);
    const service = createGenUiService({
      stateRoot: join(root, "state"),
      outputRoot: output.outputRoot,
      registerSandbox: async (input) => sandbox.registerFromHost(input),
    });
    service.onStateChanged((value) => win.webContents.send("fixture-state", value));
    let latestHandle: any;
    ipcMain.handle("fixture-service", async (_, method: keyof typeof service, input: never) => {
      const result = await (service[method] as (input: unknown) => unknown)(input);
      if (method === "prepareSandbox") latestHandle = result;
      return result;
    });
    ipcMain.handle("fixture-config", () => ({
      root: output.workspacePath,
      path: output.paths.fixture,
      paths: output.paths,
    }));
    // No synthetic native gesture: programmatic follow-up must use confirmation.
    ipcMain.handle("fixture-gesture", () => false);
    await win.loadFile(join(root, "host.html"));
    await win.webContents.executeJavaScript("window.harnessReady");
    const currentGuest = () =>
      webContents.getAllWebContents().find((contents) => contents.getType() === "webview")!;
    let guest = currentGuest();
    let frame = guest.mainFrame.frames.find((value) => value.url.includes("/instance/"))!;
    assert.ok(frame);
    const read = (code: string) => frame.executeJavaScript(code);
    await read(
      "new Promise(resolve => document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', resolve, {once:true}) : resolve())",
    );
    await read(
      "new Promise(resolve => globalThis.lucide ? resolve() : document.getElementById('zcode-visualization-lucide').addEventListener('load', resolve, {once:true}))",
    );
    assert.equal(await read("typeof window.openai"), "undefined");
    assert.equal(await read("typeof window.require"), "undefined");
    await read(
      "window.zcode.setWidgetState({modelContent:{count:7},privateContent:{secret:'local'}})",
    );
    for (let i = 0; i < 6; i++)
      await win.webContents.executeJavaScript(`window.switchPage(${i % 2 === 0})`);
    assert.equal(currentGuest().id, guest.id);
    assert.equal(await read("window.starts"), 1);
    assert.equal(await read("window.zcode.widgetState.modelContent.count"), 7);
    assert.equal(
      await read("getComputedStyle(document.querySelector('.card')).borderWidth"),
      "0px",
    );
    win.focus();
    await checkRuntimeWidgets(read);
    await checkCalendarAndCarousel(read);
    await checkTweakLifecycle(read, win);
    await offline.check(read);
    assert.equal(await read("fetch('https://example.invalid').then(()=>false,()=>true)"), true);
    assert.equal(
      await read(
        `new Promise(resolve=>{const listen=event=>{if(event.data?.id==='denied-tool'){window.removeEventListener('message',listen);resolve(event.data.error?.code)}};window.addEventListener('message',listen);window.parent.postMessage({jsonrpc:'2.0',id:'denied-tool',method:'tools/call',params:{name:'anything',arguments:{}}},'*')})`,
      ),
      -32601,
    );

    await checkCapture(win, guest, latestHandle, root);
    await win.webContents.executeJavaScript("window.adjust()");
    await read("new Promise(requestAnimationFrame)");
    assert.equal(await read("document.querySelector('#preview').style.padding"), "35px");
    assert.equal((await win.webContents.executeJavaScript("window.inspect()")).messages.length, 0);
    await read("window.zcode.sendFollowUpMessage({prompt:'Explain count',title:'Demo'})");
    const sent = await win.webContents.executeJavaScript("window.inspect()");
    assert.equal(sent.confirmations, 1);
    assert.equal(sent.messages.length, 1);
    assert.equal(sent.messages[0].source.kind, "genUi");
    await win.webContents.executeJavaScript("window.submit()");
    assert.equal((await win.webContents.executeJavaScript("window.inspect()")).messages.length, 2);
    await win.webContents.executeJavaScript("document.documentElement.classList.add('dark')");
    await read("new Promise(requestAnimationFrame)");
    assert.equal(await read("document.documentElement.dataset.theme"), "dark");
    await writeFile(join(root, "view.png"), (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript("window.restore()");
    guest = currentGuest();
    frame = guest.mainFrame.frames.find((value) => value.url.includes("/instance/"))!;
    assert.deepEqual(await read("window.initial"), {
      modelContent: { count: 7 },
      privateContent: { secret: "local" },
    });
    await win.webContents.executeJavaScript("window.unbind()");
    assert.match(
      await read(
        "window.zcode.sendFollowUpMessage({prompt:'stale'}).then(()=>'',error=>String(error))",
      ),
      /read-only|disconnected/,
    );
    const html = await readFile(output.paths.fixture!, "utf8");
    await writeFile(output.paths.fixture!, html.replace("Original heading", "Updated heading"));
    await win.webContents.executeJavaScript("window.restore()");
    guest = currentGuest();
    frame = guest.mainFrame.frames.find((value) => value.url.includes("/instance/"))!;
    assert.equal(await read("document.querySelector('h1').textContent"), "Updated heading");
    await checkStaleCapture(win, guest);
    await win.loadFile(join(root, "react.html"));
    const waitHost = async (predicate: string) =>
      win.webContents.executeJavaScript(
        `new Promise((resolve,reject)=>{const end=Date.now()+8000;const tick=()=>{if(${predicate})resolve(true);else if(Date.now()>end)reject(new Error(${JSON.stringify(`React fixture condition timed out: ${predicate}`)}));else requestAnimationFrame(tick)};tick()})`,
      );
    const clickHost = async (text: string) =>
      win.webContents.executeJavaScript(
        `(() => { const button = [...document.querySelectorAll('button')].find(node => (node.textContent === ${JSON.stringify(text)} || node.getAttribute("aria-label") === ${JSON.stringify(text)})); if(!button) throw new Error('button not found'); button.click(); })()`,
      );
    await waitHost(`window.showReply`);
    const streaming = await win.webContents.executeJavaScript("window.inspectReact()");
    assert.equal(streaming.reads, 0);
    assert.equal(streaming.preparations, 0);
    assert.equal(
      await win.webContents.executeJavaScript("document.querySelectorAll('webview').length"),
      0,
    );
    await win.webContents.executeJavaScript("window.showReply('complete')");
    await waitHost(`document.querySelector('[data-gen-ui-phase="ready"]')`);
    assert.equal(
      await win.webContents.executeJavaScript("document.body.textContent.includes('::visualize')"),
      false,
    );
    assert.equal(
      await win.webContents.executeJavaScript(
        "document.body.textContent.includes('Before view') && document.body.textContent.includes('After view')",
      ),
      true,
    );
    guest = currentGuest();
    frame = guest.mainFrame.frames.find((value) => value.url.includes("/instance/"))!;
    const guestId = guest.id;
    await checkExternalLinks(win, guest, read);
    await checkFileSummary(win, root, waitHost);
    await checkInlineLayout(win, read, root);
    await checkCopyButton(win);
    const inlineHeight = await win.webContents.executeJavaScript(
      "document.querySelector('[data-testid=gen-ui-anchor]').style.height",
    );
    await clickHost("Expand");
    await waitHost(`document.querySelector('[role="dialog"]')`);
    await checkCopyButton(win, true);
    assert.equal(
      await win.webContents.executeJavaScript(
        "document.querySelector('[data-testid=gen-ui-anchor]').style.height",
      ),
      inlineHeight,
    );
    assert.equal(currentGuest().id, guestId);
    assert.ok(
      await win.webContents.executeJavaScript(
        "document.querySelector('[data-sandbox-page-root]:popover-open')",
      ),
    );
    await read(
      "window.modalFollow = window.zcode.sendFollowUpMessage({prompt:'Expanded confirmation'}).then(()=>true,()=>false); 'pending'",
    );
    await waitHost(`document.querySelector('[role="dialog"] textarea')`);
    assert.equal(
      await win.webContents.executeJavaScript(
        "Boolean(document.querySelector('[data-sandbox-page-root]:popover-open'))",
      ),
      false,
    );
    await clickHost("Cancel");
    await waitHost(`document.querySelector('[data-sandbox-page-root]:popover-open')`);
    await clickHost("Collapse");
    await waitHost(`!document.querySelector('[role="dialog"]')`);
    assert.equal(currentGuest().id, guestId);
    await clickHost("Expand");
    await waitHost(`document.querySelector('[data-sandbox-page-root]:popover-open')`);
    await read("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await waitHost(`!document.querySelector('[data-sandbox-page-root]:popover-open')`);
    await clickHost("Expand");
    await waitHost(`document.querySelector('[data-testid="gen-ui-backdrop"]')`);
    await win.webContents.executeJavaScript(
      "document.querySelector('[data-testid=gen-ui-backdrop]').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))",
    );
    await waitHost(`!document.querySelector('[data-sandbox-page-root]:popover-open')`);
    await clickHost("Adjust design");
    await waitHost(`document.querySelector('[data-testid="gen-ui-tweaks"] input[type="range"]')`);
    await waitHost(
      `(() => { const anchor=document.querySelector('[data-testid="gen-ui-anchor"]'); const view=document.querySelector('webview'); return anchor && view && Math.abs(anchor.getBoundingClientRect().top-view.getBoundingClientRect().top)<1; })()`,
    );
    await writeFile(join(root, "react-tweaks.png"), (await win.webContents.capturePage()).toPNG());

    await win.webContents.executeJavaScript(`(() => {
      const range = document.querySelector('[data-testid=gen-ui-tweaks] input[type=range]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(range, '21');
      range.dispatchEvent(new Event('input', {bubbles:true}));
      range.dispatchEvent(new Event('change', {bubbles:true}));
    })()`);
    const waitPreview = (value: string) =>
      read(
        `new Promise(resolve=>{const check=()=>{if(document.querySelector('#preview').style.padding===${JSON.stringify(value)}){observer.disconnect();resolve(true)}};const observer=new MutationObserver(check);observer.observe(document.querySelector('#preview'),{attributes:true});check()})`,
      );
    await waitPreview("21px");
    await clickHost("Preview original");
    await waitPreview("20px");
    await clickHost("Preview original");
    await waitPreview("21px");
    await clickHost("Adjust design");
    await waitHost(`!document.querySelector('[data-testid="gen-ui-tweaks"]')`);
    await clickHost("Adjust design");
    await waitHost(
      `document.querySelector('[data-testid="gen-ui-tweaks"] input[type="range"]')?.value === '21'`,
    );
    assert.equal(
      await win.webContents.executeJavaScript(
        "document.querySelectorAll('[data-testid=gen-ui-tweaks] fieldset').length",
      ),
      2,
    );
    await clickHost("Reset");
    await waitPreview("20px");
    await clickHost("Submit design changes");
    await waitHost(`window.inspectReact().messages.length === 1`);
    await read(
      "window.followResult=window.zcode.sendFollowUpMessage({prompt:'React confirmation'}).then(()=>true); 'pending'",
    );
    await waitHost(
      `document.querySelector('[role="dialog"] textarea')?.value === "React confirmation"`,
    );
    await clickHost("Send");
    assert.equal(await read("window.followResult"), true);
    const actual = await win.webContents.executeJavaScript("window.inspectReact()");
    assert.equal(actual.reads, 1);
    assert.equal(actual.preparations, 1);
    assert.equal(actual.messages.length, 2);
    assert.equal(actual.ports, 1);
    assert.equal(actual.states, 1);
    await read(
      "window.staleResult=window.zcode.sendFollowUpMessage({prompt:'stale confirmation'}).then(()=>'',error=>String(error)); 'pending'",
    );
    await waitHost(
      `document.querySelector('[role="dialog"] textarea')?.value === "stale confirmation"`,
    );
    await win.webContents.executeJavaScript("window.disableSession()");
    await clickHost("Send");
    assert.match(await read("window.staleResult"), /binding changed/);
    assert.equal(
      (await win.webContents.executeJavaScript("window.inspectReact()")).messages.length,
      2,
    );
    await writeFile(join(root, "react-view.png"), (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript("window.showReply('hidden')");
    await waitHost(`document.querySelector('[data-sandbox-page-parking] webview')`);
    assert.equal(currentGuest().id, guestId);
    await win.webContents.executeJavaScript("window.showReply('complete')");
    await waitHost(`document.querySelector('[data-gen-ui-phase="ready"]')`);
    assert.equal(
      await win.webContents.executeJavaScript("document.querySelectorAll('webview').length"),
      1,
    );
    assert.equal((await win.webContents.executeJavaScript("window.inspectReact()")).reads, 1);
    assert.equal(
      (await win.webContents.executeJavaScript("window.inspectReact()")).preparations,
      1,
    );
    guest = currentGuest();
    frame = guest.mainFrame.frames.find((value) => value.url.includes("/instance/"))!;
    assert.equal(await read("document.querySelector('h1').textContent"), "Updated heading");
    await writeFile(
      join(root, "react-replayed.png"),
      (await win.webContents.capturePage()).toPNG(),
    );
    assert.equal(currentGuest().id, guestId);
    assert.equal(await read("window.starts"), 1);
    await win.webContents.executeJavaScript("window.showTask('second-task')");
    await waitHost(
      `document.querySelector('[data-gen-ui-phase="ready"]') && window.inspectReact().preparations === 2`,
    );
    await checkInheritedOutput(win);
    assert.equal(
      webContents.getAllWebContents().filter((contents) => contents.getType() === "webview").length,
      2,
    );
    await win.webContents.executeJavaScript("window.showTask('fixture')");
    await waitHost(`document.querySelector('[data-gen-ui-phase="ready"]')`);
    assert.equal(
      await win.webContents.executeJavaScript(
        "document.querySelector('[data-testid=gen-ui-anchor] webview').getWebContentsId()",
      ),
      guestId,
    );
    assert.equal((await win.webContents.executeJavaScript("window.inspectReact()")).reads, 2);
    await win.webContents.executeJavaScript(
      "document.querySelector('#gen-ui-scroll').scrollTop=800",
    );
    await win.webContents.executeJavaScript(
      "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
    );
    await win.webContents.executeJavaScript("window.expireOffscreen()");
    await waitHost(`!document.querySelector('webview')`);
    await win.webContents.executeJavaScript("document.querySelector('#gen-ui-scroll').scrollTop=0");
    await waitHost(
      `document.querySelector('[data-gen-ui-phase="ready"]') && window.inspectReact().preparations === 3`,
    );
    assert.notEqual(
      await win.webContents.executeJavaScript(
        "document.querySelector('webview').getWebContentsId()",
      ),
      guestId,
    );
    await win.webContents.executeJavaScript(
      "window.showReply('hidden'); window.deleteTask('fixture'); window.deleteTask('second-task')",
    );
    await waitHost(
      `window.inspectReact().ports === 0 && window.inspectReact().states === 0 && !document.querySelector('webview')`,
    );
    service.dispose();
    win.destroy();
    await checkStandalone(root);
    offline.assertNoNetwork();
    clearTimeout(deadline);
    process.stdout.write(
      "Gen UI Electron E2E passed: isolation, state, anchors, external links, styles, tooltip, tabs, icons, calendar, carousel, Tweak lifecycle, follow-up, theme, replay, reload, standalone and historical remount\n",
    );
    app.exit(0);
  })
  .catch(async (error) => {
    process.stderr.write(String(error.stack ?? error));
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      await writeFile(join(root, "failure.png"), (await win.webContents.capturePage()).toPNG());
      process.stderr.write(
        await win.webContents.executeJavaScript(
          `JSON.stringify({scrollY, anchors:[...document.querySelectorAll('[data-testid="gen-ui-anchor"]')].map(node=>node.getBoundingClientRect().toJSON()), views:[...document.querySelectorAll('webview')].map(node=>({rect:node.getBoundingClientRect().toJSON(),style:node.getAttribute('style')}))})`,
        ),
      );
    }
    app.exit(1);
  });
