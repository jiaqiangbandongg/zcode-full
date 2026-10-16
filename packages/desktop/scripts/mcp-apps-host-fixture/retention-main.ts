import { app, BrowserWindow, ipcMain, protocol, webContents } from "electron";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  installPluginSandboxHost,
  PLUGIN_SANDBOX_PRIVILEGED_SCHEME,
} from "../../src/main/pluginSandbox/index.js";
const [root, profile] = process.argv.slice(2);
app.setPath("userData", profile!);
protocol.registerSchemesAsPrivileged([PLUGIN_SANDBOX_PRIVILEGED_SCHEME]);
app
  .whenReady()
  .then(async () => {
    const host = installPluginSandboxHost({
      rendererDir: root!,
      aliasDir: root!,
      preloadPath: join(root!, "guest.cjs"),
    });
    const win = new BrowserWindow({
      show: false,
      width: 1000,
      height: 900,
      webPreferences: {
        preload: join(root!, "preload.cjs"),
        webviewTag: true,
        backgroundThrottling: false,
      },
    });
    const pending: string[] = [];
    win.webContents.on("will-attach-webview", (event, webPreferences, params) => {
      const result = host.configureGuest({
        webPreferences,
        params,
        ownerWebContentsId: win.webContents.id,
      });
      if (result.ok) pending.push(result.sandboxId);
      else event.preventDefault();
    });
    win.webContents.on("did-attach-webview", (_event, guest) =>
      host.attachGuest({ guest, hostWebContents: win.webContents, sandboxId: pending.shift()! }),
    );
    const html = await readFile(join(root!, "widget.html"), "utf8");
    let generation = 0;
    const register = (key: string, task: string) =>
      host.registerFromHost({
        instance: {
          runtimeId: "retention",
          generation: ++generation,
          token: crypto.randomUUID(),
          appIdentity: "c".repeat(64),
        },
        ownerWebContentsId: win.webContents.id,
        workspacePath: "/retention",
        sessionId: task,
        pluginId: "fixture",
        serverName: "fixture",
        scopeId: key,
        html,
      });
    ipcMain.handle("fixture-bridge", (_event, method, params) => {
      assert.equal(method, "register");
      return register(params.key, params.task);
    });
    await win.loadFile(join(root!, "retention.html"));
    await win.webContents.executeJavaScript("window.harnessReady");
    const run = (code: string) => win.webContents.executeJavaScript(`window.retention.${code}`);
    const guestCount = () =>
      webContents.getAllWebContents().filter((contents) => contents.getType() === "webview").length;
    const started = performance.now();
    const counts: any[] = [];
    for (let n = 0; n < 64; n++) assert.ok((await run(`addPage('cap-${n}','capacity')`)).sandboxId);
    assert.equal(guestCount(), 64);
    counts.push({ phase: "capacity-full", guests: guestCount(), ...(await run("counts()")) });
    assert.match((await run("addPage('overflow','capacity')")).error, /capacity/);
    assert.equal(guestCount(), 64);
    assert.throws(() => register("native-overflow", "capacity"), /64/);
    assert.equal(guestCount(), 64);
    await run("visibility('cap-0',false)");
    await run("busy('cap-0',true)");
    assert.match((await run("addPage('busy-overflow','capacity')")).error, /capacity/);
    assert.equal(guestCount(), 64);
    await run("busy('cap-0',false)");
    assert.ok((await run("addPage('replacement','capacity')")).sandboxId);
    assert.equal(guestCount(), 64);
    assert.ok((await run("counts()")).released.includes("cap-0"));
    await run("clear()");
    assert.equal(guestCount(), 0);
    assert.equal((await run("counts()")).ports, 0);
    counts.push({ phase: "capacity-cleared", guests: guestCount(), ...(await run("counts()")) });
    for (let n = 0; n < 30; n++) {
      await run(`addPage('task-${n}','task-${n}',false)`);
      await run(`visibility('task-${n}',false)`);
    }
    await run("busy('task-0',true)");
    await run("addPage('task-30','task-30',false)");
    assert.equal(guestCount(), 30);
    const lru = await run("counts()");
    assert.equal(lru.pages, 30);
    assert.equal(lru.snapshots, 30);
    assert.ok(lru.released.includes("task-1"));
    assert.ok(!lru.released.includes("task-0"));
    counts.push({ phase: "task-lru", guests: guestCount(), ...lru });
    await run("clear()");
    assert.equal(guestCount(), 0);
    await run("addPage('deadline','deadline')");
    await run("visibility('deadline',false)");
    await run("advance(299999)");
    assert.equal(guestCount(), 1);
    await run("visibility('deadline',true)");
    await run("advance(600000)");
    assert.equal(guestCount(), 1);
    await run("visibility('deadline',false)");
    await run("busy('deadline',true)");
    await run("advance(300000)");
    assert.equal(guestCount(), 1);
    await run("busy('deadline',false)");
    // 释放完成由 guest destroyed 事件确认；不使用 sleep 作为同步依据。
    const remaining = webContents
      .getAllWebContents()
      .filter((contents) => contents.getType() === "webview");
    await Promise.all(
      remaining.map((guest) => new Promise<void>((resolve) => guest.once("destroyed", resolve))),
    );
    assert.equal(guestCount(), 0);
    assert.equal((await run("counts()")).snapshots, 1);
    await run("clear()");
    const cleared = await run("counts()");
    assert.equal(cleared.pages, 0);
    assert.equal(cleared.ports, 0);
    assert.equal(cleared.snapshots, 0);
    assert.equal(cleared.timers, 0);
    counts.push({ phase: "all-cleared", guests: guestCount(), ...cleared });
    await writeFile(
      join(root!, "retention-results.json"),
      JSON.stringify({ durationMs: performance.now() - started, counts }, null, 2),
    );
    process.stdout.write("PASS real Electron 64 guests / 30 tasks / offscreen / busy retention\n");
    win.destroy();
    app.exit(0);
  })
  .catch((error) => {
    process.stderr.write(String(error.stack ?? error) + "\n");
    app.exit(1);
  });
