import { app, protocol } from "electron";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PLUGIN_SANDBOX_PRIVILEGED_SCHEME } from "../../src/main/pluginSandbox/index.js";
import { managedEnvironment } from "./managed-environment.js";
const [root, profile, node, cli] = process.argv.slice(2) as [string, string, string, string];
app.setPath("userData", profile);
protocol.registerSchemesAsPrivileged([PLUGIN_SANDBOX_PRIVILEGED_SCHEME]);
app.on("window-all-closed", () => {});
app
  .whenReady()
  .then(async () => {
    const env = await managedEnvironment(root, node, cli);
    const checks: string[] = [];
    const check = async (name: string, run: () => Promise<void>) => {
      await run();
      checks.push(name);
      process.stdout.write(`PASS ${name}\n`);
    };
    try {
      const scope = await env.agent.session(join(root, "rows-workspace"), "rows");
      const win = await env.createWindow(scope, "rows");
      const ui = (code: string) => win.webContents.executeJavaScript(code);
      const page = (code: string) => env.evalPage(win, code);
      const state = () => ui("window.rowsState()");
      const settle = () =>
        ui("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
      const openRow = async () => {
        await ui(`document.querySelector('[data-testid="plugin-ui-open-side-pane"]').click()`);
        await settle();
      };
      const closeSidebar = async () => {
        await ui("document.getElementById('close-sidebar').click()");
        await settle();
      };
      const showCard = async () => {
        await ui(
          `document.querySelector('[data-tool-call-id] [data-testid="plugin-ui-card"]').scrollIntoView({block:'center'})`,
        );
        await settle();
        assert.equal(await ui("window.rowPageVisible()"), true);
      };
      const expandHistory = async () => {
        await ui(
          `document.querySelectorAll('button[data-history-open="false"]').forEach(e => e.click())`,
        );
        await settle();
      };
      const errors = [
        { id: 2, isError: true, fullscreen: true },
        { id: 4, isError: true, fullscreen: true },
        { id: 6, isError: true, fullscreen: true },
        { id: 7, status: "error", fullscreen: true },
        { id: 8, status: "cancelled", fullscreen: true },
      ];
      await check(
        "all failures: real timeline rows preserve records but create no App or automatic sidebar",
        async () => {
          await ui(`window.setRows(${JSON.stringify(errors)}, true)`);
          await expandHistory();
          assert.equal(
            await ui('document.querySelectorAll("[data-tool-call-id]").length'),
            errors.length,
          );
          assert.deepEqual(await state(), {
            cards: 0,
            placeholders: 0,
            opens: 0,
            sidebar: false,
            views: 0,
            owners: [],
          });
          assert.equal(env.events.history.filter((e) => e.type === "registered").length, 0);
          assert.equal(env.agent.events.history.filter((e) => e.type === "read").length, 0);
        },
      );
      await check("explicit widgetSessionId failures also cannot create App anchors", async () => {
        await ui(
          `window.setRows(${JSON.stringify(errors.map((row) => ({ ...row, widget: true })))}, true)`,
        );
        await expandHistory();
        assert.equal(
          await ui('document.querySelectorAll("[data-tool-call-id]").length'),
          errors.length,
        );
        const s = await state();
        assert.equal(s.cards, 0);
        assert.equal(s.placeholders, 0);
        assert.equal(s.opens, 0);
        assert.equal(s.views, 0);
        assert.equal(env.agent.events.history.filter((e) => e.type === "read").length, 0);
      });
      const mixed = [{ id: 1 }, errors[0], { id: 3 }, errors[1], { id: 5 }, ...errors.slice(2)];
      const attached = new Promise<void>((resolve) =>
        win.webContents.once("did-attach-webview", () => resolve()),
      );
      await ui(`window.setRows(${JSON.stringify(mixed)})`);
      await attached;
      await ui("window.waitRowsRunning()");
      await page("window.fixtureReady");
      await expandHistory();
      const guestId = env.guests.get(win.webContents.id)!.id;
      await check(
        "success plus three MCP errors, transport error and cancellation leaves one latest-success anchor",
        async () => {
          const s = await state();
          assert.equal(s.cards, 1);
          assert.equal(s.views, 1);
          assert.equal(s.opens, 0);
          assert.deepEqual(s.owners, ["row-5"]);
          await showCard();
          assert.equal(
            await ui('document.querySelectorAll("[data-tool-call-id]").length'),
            mixed.length,
          );
          await page("document.getElementById('counter').click()");
          await page("new Promise(r => requestAnimationFrame(r))");
          assert.equal(await page("document.getElementById('counter').textContent"), "1");
        },
      );
      const started = performance.now();
      await check(
        "20 real row-button inline/sidebar round trips keep one guest, one anchor and React state",
        async () => {
          for (let i = 0; i < 20; i++) {
            await ui(`document.querySelector('[data-testid="plugin-ui-open-side-pane"]').click()`);
            await settle();
            let s = await state();
            assert.equal(s.cards, 0);
            assert.equal(s.placeholders, 1);
            assert.equal(s.views, 1);
            assert.deepEqual(s.owners, ["row-5"]);
            await ui("document.getElementById('close-sidebar').click()");
            await settle();
            s = await state();
            assert.equal(s.cards, 1);
            assert.equal(s.placeholders, 0);
            await showCard();
            assert.equal(env.guests.get(win.webContents.id)!.id, guestId);
          }
          assert.equal(await page("document.getElementById('counter').textContent"), "1");
          assert.equal(await page("window.starts"), 1);
          assert.equal(env.events.history.filter((e) => e.type === "registered").length, 1);
          assert.equal(env.agent.events.history.filter((e) => e.type === "read").length, 1);
          assert.equal(env.events.history.filter((e) => e.type === "subscribed").length, 1);
        },
      );
      const switchesMs = performance.now() - started;
      await check(
        "timeline unmount/remount and later error preserve the good page without fullscreen stealing",
        async () => {
          await ui("window.mountRows(false)");
          await ui("window.mountRows(true)");
          await expandHistory();
          await ui(
            `window.setRows(${JSON.stringify([...mixed, { id: 9, isError: true, fullscreen: true }])})`,
          );
          await expandHistory();
          const s = await state();
          assert.equal(s.opens, 20);
          assert.equal(s.cards, 1);
          assert.deepEqual(s.owners, ["row-5"]);
          assert.equal(env.guests.get(win.webContents.id)!.id, guestId);
          assert.equal(await page("document.getElementById('counter').textContent"), "1");
        },
      );
      await check(
        "new successful fullscreen result still opens once and reuses the existing page",
        async () => {
          await ui(`window.setRows(${JSON.stringify([...mixed, { id: 10, fullscreen: true }])})`);
          await settle();
          const s = await state();
          assert.equal(s.opens, 21);
          assert.equal(s.placeholders, 1);
          assert.deepEqual(s.owners, ["row-10"]);
          await ui("document.getElementById('close-sidebar').click()");
          await settle();
          assert.deepEqual((await state()).owners, ["row-10"]);
          assert.equal(env.guests.get(win.webContents.id)!.id, guestId);
          assert.equal(await page("document.getElementById('counter').textContent"), "1");
          assert.equal(env.agent.events.history.filter((e) => e.type === "read").length, 1);
          assert.equal(env.events.history.filter((e) => e.type === "registered").length, 1);
        },
      );
      await check(
        "closed fullscreen call stays closed after session view unmount and remount",
        async () => {
          const opens = (await state()).opens;
          await ui("window.mountRows(false)");
          await ui("window.mountRows(true)");
          assert.equal((await state()).sidebar, false);
          assert.equal((await state()).opens, opens);
          assert.equal(env.guests.get(win.webContents.id)!.id, guestId);
          await openRow();
          assert.equal((await state()).sidebar, true);
          assert.equal((await state()).opens, opens + 1);
        },
      );
      await check(
        "calls arriving in an open sidebar are consumed; later new calls still open",
        async () => {
          await ui(`window.setRows(${JSON.stringify([...mixed, { id: 11, fullscreen: true }])})`);
          const opens = (await state()).opens;
          await closeSidebar();
          await ui("window.mountRows(false)");
          await ui("window.mountRows(true)");
          assert.equal((await state()).sidebar, false);
          assert.equal((await state()).opens, opens);
          await ui(`window.setRows(${JSON.stringify([...mixed, { id: 12, fullscreen: true }])})`);
          assert.equal((await state()).sidebar, true);
          assert.equal((await state()).opens, opens + 1);
          assert.equal(env.guests.get(win.webContents.id)!.id, guestId);
          await closeSidebar();
        },
      );
      await showCard();
      await writeFile(join(root, "rows-inline.png"), (await win.webContents.capturePage()).toPNG());
      await writeFile(
        join(root, "rows-results.json"),
        JSON.stringify({ checks, switchesMs, guestId, state: await state() }, null, 2),
      );
    } finally {
      await env.close();
    }
    app.exit(0);
  })
  .catch((error) => {
    process.stderr.write(String(error.stack ?? error) + "\n");
    app.exit(1);
  });
