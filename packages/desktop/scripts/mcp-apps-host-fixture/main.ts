import { app, BrowserWindow, ipcMain, protocol, session, webContents } from "electron";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { legacyStorage, checkClearing } from "./storage-checks.js";
import { checkPagePointerInput } from "./pointer-input.js";
import {
  installPluginSandboxHost,
  PLUGIN_SANDBOX_PRIVILEGED_SCHEME,
} from "../../src/main/pluginSandbox/index.js";
const [root, profile, mode] = process.argv.slice(2);
app.setPath("userData", profile!);
protocol.registerSchemesAsPrivileged([PLUGIN_SANDBOX_PRIVILEGED_SCHEME]);
// 旧分区探针会先关闭临时窗口；完整测试结束前不能触发 Electron 默认退出。
app.on("window-all-closed", () => {});
app
  .whenReady()
  .then(async () => {
    const oldPartition = "persist:plugin-sandbox-v1-" + "b".repeat(64);
    const old = session.fromPartition(oldPartition);
    assert.deepEqual(
      await legacyStorage(oldPartition, mode === "write"),
      mode === "empty" ? { local: null, indexed: null } : { local: "legacy", indexed: 7 },
    );
    const unrelated = session.fromPartition("persist:unrelated-fixture");
    const cookie = {
      url: "https://fixture.invalid",
      name: "fixture",
      value: "retained",
      expirationDate: Date.now() / 1000 + 3600,
    };
    if (mode === "write") {
      await old.cookies.set(cookie);
      await unrelated.cookies.set(cookie);
    } else {
      assert.equal((await old.cookies.get({ name: "fixture" })).length, mode === "empty" ? 0 : 1);
      assert.equal((await unrelated.cookies.get({ name: "fixture" })).length, 1);
    }
    // 冷启动计时只包含待测宿主页，不把旧分区探针窗口的启动耗时算入。
    const started = performance.now();
    const host = installPluginSandboxHost({
      rendererDir: root!,
      aliasDir: root!,
      preloadPath: join(root!, "guest.cjs"),
      logger: {
        info: (...args) => process.stdout.write(JSON.stringify(args) + "\n"),
        warn: (...args) => process.stderr.write(JSON.stringify(args) + "\n"),
      },
    });
    const win = new BrowserWindow({
      show: false,
      width: 1000,
      height: 700,
      webPreferences: {
        preload: join(root!, "preload.cjs"),
        webviewTag: true,
        backgroundThrottling: false,
      },
    });
    win.webContents.on("console-message", (event) =>
      process.stderr.write(String(event.message) + "\n"),
    );
    const pending: string[] = [];
    win.webContents.on("will-attach-webview", (event, webPreferences, params) => {
      const result = host.configureGuest({
        webPreferences,
        params,
        ownerWebContentsId: win.webContents.id,
      });
      if (!result.ok) event.preventDefault();
      else pending.push(result.sandboxId);
    });
    win.webContents.on("did-attach-webview", (_event, guest) =>
      host.attachGuest({ guest, hostWebContents: win.webContents, sandboxId: pending.shift()! }),
    );
    const html = await readFile(join(root!, "widget.html"), "utf8");
    let generation = 0;
    const register = () =>
      host.registerFromHost({
        instance: {
          runtimeId: "fixture",
          generation: ++generation,
          token: crypto.randomUUID(),
          appIdentity: "a".repeat(64),
        },
        ownerWebContentsId: win.webContents.id,
        workspacePath: "/fixture",
        sessionId: "fixture",
        pluginId: "fixture",
        serverName: "fixture",
        scopeId: "fixture",
        html,
      });
    const handle = register();
    let first = true;
    let htmlReads = 0;
    session
      .fromPartition(handle.partition)
      .webRequest.onCompleted({ urls: ["zcode-sandbox://*/*"] }, (event) => {
        if (event.url.includes("/index.html")) htmlReads++;
      });
    ipcMain.handle("fixture-handle", () => {
      if (first) {
        first = false;
        return handle;
      }
      return register();
    });
    ipcMain.handle("fixture-config", () => null);
    await win.loadFile(join(root!, "host.html"));
    await win.webContents.executeJavaScript("window.harnessReady");
    const guest = webContents
      .getAllWebContents()
      .find((contents) => contents.getType() === "webview")!;
    assert.ok(guest);
    const frame = guest.mainFrame.frames.find((frame) => frame.url.includes("/instance/"))!;
    await frame.executeJavaScript("window.fixtureReady");
    const initialState =
      "({ counter: document.querySelector('#counter').textContent, input: document.querySelector('#input').value, scroll: document.querySelector('#scroll').scrollTop, starts: window.starts })";
    assert.deepEqual(await frame.executeJavaScript(initialState), {
      counter: "0",
      input: "",
      scroll: 0,
      starts: 1,
    });
    if (mode === "write")
      assert.deepEqual(await frame.executeJavaScript("window.storageRoundTrip(false)"), {
        local: null,
        indexed: null,
      });
    const coldMs = performance.now() - started;
    await win.webContents.executeJavaScript("window.switchPage(false)");
    const storage = await frame.executeJavaScript(`window.storageRoundTrip(${mode === "write"})`);
    assert.deepEqual(
      storage,
      mode === "empty" ? { local: null, indexed: null } : { local: "42", indexed: 42 },
    );
    // 用 Chromium 输入事件走 React onClick/onChange，避免直接改 DOM 掩盖受控状态丢失。
    guest.debugger.attach("1.3");
    for (const selector of ["#counter", "#input"]) {
      const point = await frame.executeJavaScript(
        `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2)}; })()`,
      );
      await guest.debugger.sendCommand("Input.dispatchMouseEvent", {
        type: "mousePressed",
        ...point,
        button: "left",
        clickCount: 1,
      });
      await guest.debugger.sendCommand("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        ...point,
        button: "left",
        clickCount: 1,
      });
    }
    await guest.debugger.sendCommand("Input.insertText", { text: "retained" });
    guest.debugger.detach();
    await frame.executeJavaScript(
      "document.querySelector('#scroll').scrollTop = 123; new Promise(requestAnimationFrame)",
    );
    const active = webContents.getAllWebContents().length;
    const times: number[] = [];
    const dispatchTimes: number[] = [];
    const listenerCounts = new Map<boolean, number>();
    for (let n = 0; n < 40; n++) {
      const start = performance.now();
      const counts = await win.webContents.executeJavaScript(`window.switchPage(${n % 2 === 0})`);
      times.push(performance.now() - start);
      const side = n % 2 === 0;
      if (!listenerCounts.has(side)) listenerCounts.set(side, counts.listeners);
      dispatchTimes.push(counts.dispatchMs);
      const { dispatchMs: _dispatch, ...stable } = counts;
      assert.deepEqual(stable, {
        handshakes: 1,
        views: 1,
        listeners: listenerCounts.get(n % 2 === 0),
      });
      assert.equal(htmlReads, 1);
      assert.equal(webContents.getAllWebContents().length, active);
      assert.equal(
        guest.id,
        webContents.getAllWebContents().find((contents) => contents.getType() === "webview")!.id,
      );
    }
    assert.deepEqual(
      await frame.executeJavaScript(
        "({ counter: document.querySelector('#counter').textContent, input: document.querySelector('#input').value, scroll: document.querySelector('#scroll').scrollTop, starts: window.starts })",
      ),
      { counter: "1", input: "retained", scroll: 123, starts: 1 },
    );
    for (const position of ["inline", "sidebar", "preview"]) {
      await win.webContents.executeJavaScript(`window.switchPage(${position === "sidebar"})`);
      if (position === "preview")
        await win.webContents.executeJavaScript("window.previewPage(true)");
      await checkPagePointerInput(win, guest);
      if (position === "preview")
        await win.webContents.executeJavaScript("window.previewPage(false)");
      assert.equal(guest.isDestroyed(), false);
    }
    await writeFile(
      join(root!, `switch-${mode}.png`),
      (await win.webContents.capturePage()).toPNG(),
    );
    await writeFile(
      join(root!, `metrics-${mode}.json`),
      JSON.stringify(
        {
          mode,
          coldMs,
          switches: times.length,
          switchObservedMedianMs: [...times].sort((a, b) => a - b)[20],
          switchDispatchMedianMs: [...dispatchTimes].sort((a, b) => a - b)[20],
          webContents: active,
          handshakes: 1,
          htmlReads,
          listeners: { inline: listenerCounts.get(false), sidebar: listenerCounts.get(true) },
          storage,
        },
        null,
        2,
      ),
    );
    assert.equal(await frame.executeJavaScript("window.readWidget()"), null);
    await frame.executeJavaScript("window.saveWidget({ saved: 7 })");
    assert.deepEqual(await win.webContents.executeJavaScript("window.recyclePage()"), {
      views: 0,
      state: { saved: 7 },
    });
    assert.equal(
      webContents.getAllWebContents().filter((c) => c.getType() === "webview").length,
      0,
    );
    for (const retry of [false, true]) {
      await win.webContents.executeJavaScript(`window.restorePage(${retry})`);
      const restoredGuest = webContents.getAllWebContents().find((c) => c.getType() === "webview")!;
      const restored = restoredGuest.mainFrame.frames.find((f) => f.url.includes("/instance/"))!;
      await restored.executeJavaScript("window.fixtureReady");
      assert.deepEqual(await restored.executeJavaScript(initialState), {
        counter: "0",
        input: "",
        scroll: 0,
        starts: 1,
      });
      assert.deepEqual(
        await restored.executeJavaScript("window.readWidget()"),
        retry ? null : { saved: 7 },
      );
      assert.deepEqual(await restored.executeJavaScript("window.storageRoundTrip(false)"), storage);
      assert.equal(webContents.getAllWebContents().length, active);
    }
    if (mode === "read") {
      await checkClearing({
        root: root!,
        partition: handle.partition,
        oldPartition,
        host,
        win,
        register,
      });
      assert.equal(
        webContents.getAllWebContents().filter((contents) => contents.getType() === "webview")
          .length,
        0,
      );
      assert.equal((await old.cookies.get({ name: "fixture" })).length, 0);
      assert.equal((await unrelated.cookies.get({ name: "fixture" })).length, 1);
      assert.throws(() => host.registerFromHost({} as never), /being cleared/);
    }
    session.fromPartition(handle.partition).flushStorageData();
    await old.cookies.flushStore();
    await unrelated.cookies.flushStore();
    win.destroy();
    app.exit(0);
  })
  .catch((error) => {
    process.stderr.write(String(error.stack ?? error));
    app.exit(1);
  });
