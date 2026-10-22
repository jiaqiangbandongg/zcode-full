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
      const creation = env
        .createWindow(scope, "background-interaction")
        .then(() => "unexpected success", String);
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
      await ui("window.setAnchors(false, true)");
      const stateBeforeHide = await env.evalPage(
        win,
        `({
        counter: document.querySelector('#counter').textContent,
        input: document.querySelector('#input').value
      })`,
      );
      const registrations = env.events.history.filter(
        (event) => event.type === "registered",
      ).length;
      const clickControl = async (selector: string) => {
        const point = await ui(`(() => {
          const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
          return {x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2)};
        })()`);
        await clickHostPoint(win, point);
      };
      // 保留真实 React 卡片与 guest，用宿主鼠标关闭、重开及切换标签，防止只测卸载的假阳性。
      for (const theme of ["light", "dark"] as const) {
        await ui(`window.setShowcasePresentation(${JSON.stringify(theme)}, 'en', 400)`);
        await ui("window.setAnchors(false, true)");
        for (const selector of [
          "#toggle-sidebar",
          "#switch-sidebar-tab",
          "#switch-main-page",
          "#switch-workspace",
        ]) {
          await clickControl(selector);
          const hidden = await ui(`(() => {
          const view = document.querySelector('webview');
          const root = view.closest('[data-sandbox-page-root]');
          return {
            visible: window.managedState().visible,
            display: getComputedStyle(root).display,
            opacity: getComputedStyle(root).opacity,
            inert: root.inert,
            width: view.getBoundingClientRect().width,
            anchorConnected: document.querySelector('#sidebar-anchor [data-testid="plugin-ui-card"]').isConnected,
            hit: document.elementFromPoint(600, 200)?.tagName
          };
        })()`);
          await writeFile(
            join(root, `visibility-${theme}-${selector.slice(1)}.json`),
            JSON.stringify(hidden, null, 2),
          );
          await writeFile(
            join(root, `visibility-${theme}-${selector.slice(1)}.png`),
            (await win.webContents.capturePage()).toPNG(),
          );
          assert.equal(hidden.visible, false, JSON.stringify(hidden));
          assert.equal(hidden.display, "block", JSON.stringify(hidden));
          assert.ok(Number(hidden.opacity) <= 0.001, JSON.stringify(hidden));
          assert.equal(hidden.inert, true);
          assert.ok(hidden.width > 0);
          assert.equal(hidden.anchorConnected, true);
          assert.notEqual(hidden.hit, "WEBVIEW");
          assert.equal(guest.isDestroyed(), false);
          // 隐藏不能停帧；用真实后台双帧完成工作，不能只检查 guest 还存在。
          assert.equal(
            await env.evalPage(
              win,
              `Promise.race([
          new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve('running')))),
          new Promise(resolve => setTimeout(() => resolve('stalled'), 5000))
        ])`,
            ),
            "running",
          );
          await clickControl(selector);
          assert.equal((await ui("window.managedState()")).visible, true);
          assert.equal(env.guests.get(win.webContents.id)!.id, guest.id);
          assert.deepEqual(
            await env.evalPage(
              win,
              `({
          counter: document.querySelector('#counter').textContent,
          input: document.querySelector('#input').value
        })`,
            ),
            stateBeforeHide,
          );
        }
        await writeFile(
          join(root, `visibility-${theme}-restored.png`),
          (await win.webContents.capturePage()).toPNG(),
        );
      }
      assert.equal(
        env.events.history.filter((event) => event.type === "registered").length,
        registrations,
      );
      await checkPagePointerInput(win, guest);
      await writeFile(
        join(root, "interaction-results.json"),
        JSON.stringify(
          {
            retryClicks: await ui("window.retryClickCount"),
            phase: (await ui("window.managedState()")).phase,
            views: (await ui("window.managedState()")).views,
            sidebarInput: true,
            inlineInput: true,
            sidebarHideAndRestore: true,
            inactiveTabHideAndRestore: true,
            mainPageHideAndRestore: true,
            workspaceHideAndRestore: true,
            hiddenBackgroundFrames: true,
            themes: ["light", "dark"],
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
