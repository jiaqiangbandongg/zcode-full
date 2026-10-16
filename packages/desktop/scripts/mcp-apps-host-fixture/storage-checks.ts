import { BrowserWindow, session, webContents } from "electron";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginSandboxHost } from "../../src/main/pluginSandbox/host.js";

const prepared = new Set<string>();
export async function legacyStorage(partition: string, write: boolean) {
  const storage = session.fromPartition(partition);
  if (!prepared.has(partition)) {
    prepared.add(partition);
    await storage.protocol.handle(
      "https",
      () =>
        new Response("<!doctype html><body>legacy fixture</body>", {
          headers: { "Content-Type": "text/html" },
        }),
    );
  }
  const win = new BrowserWindow({
    show: false,
    webPreferences: { partition, backgroundThrottling: false },
  });
  try {
    await win.loadURL("https://legacy.fixture.invalid");
    return await win.webContents.executeJavaScript(
      `(${async function (write: boolean) {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open("host-fixture", 1);
          request.onupgradeneeded = () => request.result.createObjectStore("values");
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        if (write) {
          localStorage.setItem("counter", "legacy");
          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction("values", "readwrite");
            tx.objectStore("values").put(7, "counter");
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          });
        }
        const value = await new Promise((resolve, reject) => {
          const request = db.transaction("values").objectStore("values").get("counter");
          request.onsuccess = () => resolve(request.result ?? null);
          request.onerror = () => reject(request.error);
        });
        db.close();
        return { local: localStorage.getItem("counter"), indexed: value };
      }.toString()})(${write})`,
    );
  } finally {
    win.destroy();
  }
}

export async function checkClearing(input: {
  root: string;
  partition: string;
  oldPartition: string;
  host: PluginSandboxHost;
  win: BrowserWindow;
  register(): unknown;
}) {
  const { root, partition, oldPartition, host, win, register } = input;
  const sentinelPaths = [join(root, "plugin-sentinel.sqlite"), join(root, "plugin-sentinel.txt")];
  const before = await Promise.all(sentinelPaths.map((file) => readFile(file)));
  const guest = webContents.getAllWebContents().find((c) => c.getType() === "webview")!;
  const frame = guest.mainFrame.frames.find((f) => f.url.includes("/instance/"))!;
  await frame.executeJavaScript(
    "window.addEventListener('beforeunload', e => { e.preventDefault(); e.returnValue = 'keep writing'; }); window.startStorageWriter()",
    true,
  );
  const destroyed = new Promise<void>((resolve) => guest.once("destroyed", resolve));
  const storage = session.fromPartition(partition);
  const clear = storage.clearStorageData.bind(storage);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  // 只控制真实清理开始的时序；释放后仍调用 Electron 原生实现，不用 mock 成功代替持久化验证。
  storage.clearStorageData = async (options) => {
    entered.resolve();
    await release.promise;
    await clear(options);
  };
  let completed = false;
  const clearing = host.clearBrowserData().then(() => {
    completed = true;
  });
  try {
    await entered.promise;
    await destroyed;
    // Electron guest 的包装对象 destroyed 不等于插件文档退出；旧实现这里稳定失败。
    assert.equal(frame.isDestroyed(), true, "plugin frame must stop before storage clearing");
    assert.equal(completed, false);
    assert.equal(
      webContents.getAllWebContents().filter((c) => c.getType() === "webview").length,
      0,
    );
    assert.throws(register, /being cleared/);
    await assert.rejects(() => win.webContents.executeJavaScript("window.restorePage(false)"));
    assert.equal(completed, false);
    release.resolve();
    await clearing;
    assert.deepEqual(await legacyStorage(oldPartition, false), { local: null, indexed: null });
    const after = await Promise.all(sentinelPaths.map((file) => readFile(file)));
    assert.deepEqual(after, before);
    await writeFile(
      join(root, "clearing-results.json"),
      JSON.stringify({
        oldFrameDestroyedBeforeClear: true,
        registrationAndReopenRejected: true,
        beforeUnloadDidNotBlock: true,
        legacyStorageEmpty: true,
        pluginSentinelsUnchanged: true,
      }),
    );
    process.stdout.write(
      "PASS clearing rejects register/reopen, destroys writing frame before clearing despite beforeunload, clears legacy data, preserves SQLite/file sentinels\n",
    );
  } finally {
    release.resolve();
    await clearing;
    storage.clearStorageData = clear;
  }
}
