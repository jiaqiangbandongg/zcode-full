import { app, BrowserWindow, ipcMain, protocol, webContents } from "electron";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  installPluginSandboxHost,
  PLUGIN_SANDBOX_PRIVILEGED_SCHEME,
} from "../../src/main/pluginSandbox/index.js";
const [root, profile] = process.argv.slice(2) as [string, string];
app.setPath("userData", profile);
protocol.registerSchemesAsPrivileged([PLUGIN_SANDBOX_PRIVILEGED_SCHEME]);
app
  .whenReady()
  .then(async () => {
    const { appIdentity } = JSON.parse(
      await readFile(join(root, "managed-storage-identity.json"), "utf8"),
    );
    const host = installPluginSandboxHost({
      rendererDir: root,
      aliasDir: root,
      preloadPath: join(root, "guest.cjs"),
    });
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: join(root, "preload.cjs"),
        webviewTag: true,
        backgroundThrottling: false,
      },
    });
    const handle = host.registerFromHost({
      instance: {
        runtimeId: "storage-probe",
        generation: 1,
        token: crypto.randomUUID(),
        appIdentity,
      },
      ownerWebContentsId: win.webContents.id,
      workspacePath: "/fixture",
      sessionId: "fixture",
      pluginId: "fixture",
      serverName: "fixture",
      scopeId: "fixture",
      html: await readFile(join(root, "widget.html"), "utf8"),
    });
    win.webContents.on("will-attach-webview", (event, webPreferences, params) => {
      if (
        !host.configureGuest({ webPreferences, params, ownerWebContentsId: win.webContents.id }).ok
      )
        event.preventDefault();
    });
    win.webContents.on("did-attach-webview", (_event, guest) =>
      host.attachGuest({ guest, hostWebContents: win.webContents, sandboxId: handle.sandboxId }),
    );
    ipcMain.handle("fixture-config", () => null);
    ipcMain.handle("fixture-handle", () => handle);
    await win.loadFile(join(root, "host.html"));
    await win.webContents.executeJavaScript("window.harnessReady");
    const guest = webContents.getAllWebContents().find((w) => w.getType() === "webview")!;
    const frame = guest.mainFrame.frames.find((f) => f.url.includes("/instance/"))!;
    await frame.executeJavaScript("window.fixtureReady");
    const empty = await frame.executeJavaScript(
      "indexedDB.databases().then(dbs=>({local:localStorage.length,databases:dbs.length,widget:window.readWidget()}))",
    );
    assert.deepEqual(empty, { local: 0, databases: 0, widget: null });
    await writeFile(join(root, "managed-storage-empty.json"), JSON.stringify(empty));
    process.stdout.write(
      "PASS new Electron process confirms multi-window clearing left LS/IDB empty and widgetState absent\n",
    );
    win.destroy();
    app.exit(0);
  })
  .catch((error) => {
    process.stderr.write(String(error.stack ?? error));
    app.exit(1);
  });
