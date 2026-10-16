import { app, protocol } from "electron";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PLUGIN_SANDBOX_PRIVILEGED_SCHEME } from "../../src/main/pluginSandbox/index.js";
import { managedEnvironment } from "./managed-environment.js";
import { clickHostPoint, checkPagePointerInput } from "./pointer-input.js";

const [root, profile, node, cli] = process.argv.slice(2) as [string, string, string, string];
app.setPath("userData", profile);
protocol.registerSchemesAsPrivileged([PLUGIN_SANDBOX_PRIVILEGED_SCHEME]);
app.on("window-all-closed", () => {});
app
  .whenReady()
  .then(async () => {
    const htmlPath = join(root, "widget.html");
    const goodHtml = await readFile(htmlPath, "utf8");
    const env = await managedEnvironment(root, node, cli);
    try {
      // 真实等待握手时限；不伪造 controller 的错误态或直接卸载 webview。
      await writeFile(
        htmlPath,
        '<!doctype html><script>throw new Error("fixture startup failure")</script>',
      );
      const scope = await env.agent.session(join(root, "interaction-workspace"), "managed");
      const creation = env.createWindow(scope).then(() => "unexpected success", String);
      await env.events.wait((event) => event.type === "phase" && event.phase === "mounted");
      const win = env.windows[0]!;
      const ui = (code: string) => win.webContents.executeJavaScript(code);
      await ui("window.setAnchors(false, true)");
      assert.match(await creation, /handshake timed out/);
      await ui(`new Promise(resolve => {
      if (!document.querySelector('webview')) return resolve();
      const observer = new MutationObserver(() => {
        if (!document.querySelector('webview')) { observer.disconnect(); resolve(); }
      });
      observer.observe(document.body, {subtree: true, childList: true});
    })`);
      const point = await ui(`(() => {
      const button = document.querySelector('[data-testid=plugin-ui-retry]');
      const r = button.getBoundingClientRect();
      const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
      window.retryClickCount = 0;
      button.addEventListener('click', () => window.retryClickCount++);
      return {x, y, hit: document.elementFromPoint(x, y)?.outerHTML};
    })()`);
      await writeFile(join(root, "retry-hit-test.json"), JSON.stringify(point, null, 2));
      await writeFile(htmlPath, goodHtml);
      const offset = env.events.history.length;
      await clickHostPoint(win, { x: point.x, y: point.y });
      assert.equal(await ui("window.retryClickCount"), 1, JSON.stringify(point));
      await env.events.wait((event) => event.type === "phase" && event.phase === "running", offset);
      await env.evalPage(win, "window.fixtureReady");
      assert.equal((await ui("window.managedState()")).views, 1);
      assert.equal(env.events.history.filter((event) => event.type === "registered").length, 2);
      const guest = env.guests.get(win.webContents.id)!;
      await checkPagePointerInput(win, guest);
      await ui("window.setAnchors(true, false)");
      await checkPagePointerInput(win, guest);
      assert.equal(env.guests.get(win.webContents.id)!.id, guest.id);
      await writeFile(
        join(root, "interaction-results.json"),
        JSON.stringify(
          {
            retryClicks: await ui("window.retryClickCount"),
            phase: (await ui("window.managedState()")).phase,
            views: (await ui("window.managedState()")).views,
            sidebarInput: true,
            inlineInput: true,
          },
          null,
          2,
        ),
      );
      process.stdout.write(
        "PASS real handshake timeout accepts mouse retry and restores interactive sidebar/inline guest\n",
      );
    } finally {
      await writeFile(htmlPath, goodHtml);
      await env.close();
    }
    app.exit(0);
  })
  .catch((error) => {
    process.stderr.write(String(error.stack ?? error) + "\n");
    app.exit(1);
  });
