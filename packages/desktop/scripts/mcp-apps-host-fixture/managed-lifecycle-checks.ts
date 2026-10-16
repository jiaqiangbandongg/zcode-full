import assert from "node:assert/strict";
import type { BrowserWindow } from "electron";
import type { managedEnvironment } from "./managed-environment.js";
import { checkLate } from "./managed-late-checks.js";
type Environment = Awaited<ReturnType<typeof managedEnvironment>>;
export async function checkLifecycle(
  env: Environment,
  win: BrowserWindow,
  scope: any,
  check: (name: string, run: () => Promise<void>) => Promise<void>,
) {
  const ui = (code: string) => win.webContents.executeJavaScript(code);
  const page = (code: string) => env.evalPage(win, code);
  async function retry() {
    const offset = env.events.history.length;
    await ui("window.retryManaged()");
    await env.events.wait(
      (e) => e.type === "phase" && e.phase === "running" && e.owner === win.webContents.id,
      offset,
    );
    await page("window.fixtureReady");
  }
  await retry();
  await checkLate(env, win, scope, check);
  await check(
    "production feed deduplication and 80 position switches preserve guest, ports and resource count",
    async () => {
      const initial = await ui("window.managedState()");
      const reads = env.agent.events.history.filter((e) => e.type === "read").length;
      await page(
        "document.querySelector('#counter').click(); document.querySelector('#scroll').scrollTop=123",
      );
      for (let n = 0; n < 40; n++) {
        await ui(`window.setAnchors(true, true, ${n})`);
        await page(`window.waitFeed(${n})`);
        await ui(`window.setAnchors(true, false, ${n})`);
      }
      const after = await ui("window.managedState()");
      const feed = await page("window.receivedFeed");
      assert.deepEqual(
        feed.result,
        Array.from({ length: 40 }, (_, i) => i),
      );
      assert.deepEqual(feed.input, feed.result);
      assert.equal(after.handle.sandboxId, initial.handle.sandboxId);
      assert.equal(after.listeners.ports, 1);
      assert.equal(after.listeners.frame, 1);
      assert.equal(env.agent.events.history.filter((e) => e.type === "read").length, reads);
      assert.deepEqual(
        await page(
          "({ count: document.querySelector('#counter').textContent, scroll: document.querySelector('#scroll').scrollTop, starts:window.starts })",
        ),
        { count: "1", scroll: 123, starts: 1 },
      );
    },
  );
  await check(
    "large JSON widget snapshot survives recycle without capturing unsaved React state",
    async () => {
      await page(
        "window.saveWidget({text:'x'.repeat(512*1024), nested:[null,1,false,{value:'safe'}]})",
      );
      await ui("window.setAnchors(false,false)");
      await ui("window.suspendManaged()");
      const offset = env.events.history.length;
      await ui("window.setAnchors(true,false)");
      await env.events.wait((e) => e.type === "phase" && e.phase === "running", offset);
      await page("window.fixtureReady");
      assert.equal(await page("window.readWidget().text.length"), 512 * 1024);
      assert.deepEqual(await page("window.readWidget().nested"), [
        null,
        1,
        false,
        { value: "safe" },
      ]);
      assert.equal(await page("document.querySelector('#counter').textContent"), "0");
      await page("window.saveWidget(null)");
      assert.equal((await ui("window.managedState()")).widget, null);
    },
  );
  await check(
    "real guest renderer crash revokes old credential and retry reconstructs one page",
    async () => {
      const old = env.handles.get(win.webContents.id).instance;
      const guest = env.guests.get(win.webContents.id)!;
      const offset = env.events.history.length;
      const failed = ui("window.waitManagedPhase('error')");
      guest.forcefullyCrashRenderer();
      await failed;
      await env.events.wait(
        (e) =>
          e.type === "bridge" && e.method === "closeInstance" && e.owner === win.webContents.id,
        offset,
      );
      await assert.rejects(() =>
        env.agent.call("mcp/uiValidateInstance", { ...scope, instance: old }),
      );
      await retry();
      assert.notEqual(env.handles.get(win.webContents.id).instance.token, old.token);
      assert.equal(env.countGuests(), 1);
      assert.equal((await ui("window.managedState()")).listeners.ports, 1);
    },
  );
  await check(
    "Web and remote platform adapters keep fallback without sandbox or conversation lease",
    async () => {
      for (const mode of ["web", "remote"]) {
        const offset = env.events.history.length;
        const fallback = await env.createWindow(scope, mode);
        const state = await fallback.webContents.executeJavaScript("window.managedState()");
        assert.equal(state.supported, false);
        assert.equal(state.views, 0);
        assert.equal(
          env.events.history
            .slice(offset)
            .some((e) => e.type === "registered" || e.type === "subscribed"),
          false,
        );
        fallback.destroy();
      }
      assert.equal(env.countGuests(), 1);
    },
  );
  await check(
    "two managed windows share browser storage but isolate widget snapshots and resource feeds",
    async () => {
      const second = await env.createWindow(scope);
      const other = (code: string) => env.evalPage(second, code);
      await page("window.saveWidget({window:1}); window.storageRoundTrip(true)");
      assert.equal(await other("window.readWidget()"), null);
      assert.deepEqual(await other("window.storageRoundTrip(false)"), { local: "42", indexed: 42 });
      await other(
        "new Promise(resolve => { const r=indexedDB.open('host-fixture'); r.onsuccess=()=>{window.heldDb=r.result; resolve();}; })",
      );
      await page(
        "window.upgradeBlocked=Promise.withResolvers(); window.upgradeDone=Promise.withResolvers(); const upgrade=indexedDB.open('host-fixture',2); upgrade.onblocked=()=>window.upgradeBlocked.resolve(); upgrade.onupgradeneeded=()=>upgrade.result.createObjectStore('v2'); upgrade.onsuccess=()=>{upgrade.result.close(); window.upgradeDone.resolve();}; upgrade.onerror=()=>window.upgradeDone.reject(upgrade.error); true",
      );
      await page("window.upgradeBlocked.promise");
      await Promise.all([page("window.subscribeFixture()"), other("window.subscribeFixture()")]);
      env.agent.notify("managed", "fixture://state");
      await Promise.all([page("window.waitResources(1)"), other("window.waitResources(1)")]);
      await other("window.heldDb.close()");
      await page("window.upgradeDone.promise");
      assert.deepEqual(await other("window.storageRoundTrip(false)"), { local: "42", indexed: 42 });
      const active = env.guests.get(win.webContents.id)!;
      const dead = env.guests.get(second.webContents.id)!;
      const stopped = new Promise<void>((resolve) => dead.once("destroyed", resolve));
      second.destroy();
      await stopped;
      assert.equal(active.isDestroyed(), false);
      env.agent.notify("managed", "fixture://state");
      await page("window.waitResources(2)");
      assert.equal((await ui("window.managedState()")).listeners.frame, 1);
    },
  );
  await check(
    "task deletion during approval removes page, snapshot and task listener before late allow",
    async () => {
      const result = page("window.callTool('task-delete')").catch((error) => ({
        error: String(error),
      }));
      const pending = await env.agent.approvals.wait((r) => r.params.input?.key === "task-delete");
      const guest = env.guests.get(win.webContents.id)!;
      const stopped = new Promise<void>((resolve) => guest.once("destroyed", resolve));
      await ui("window.setAnchors(false,false); window.removeTask()");
      await stopped;
      await env.agent.respond(pending, "allow");
      assert.ok((await result).error);
      const state = await ui("window.managedState()");
      assert.equal(state.widget, undefined);
      assert.equal(state.listeners.task, 0);
      assert.equal(state.listeners.ports, 0);
      assert.equal(
        env.agent.events.history.some((e) => e.type === "executed" && e.key === "task-delete"),
        false,
      );
    },
  );
  await check(
    "clear data seals registration and cancels live tool before discarding multi-window storage",
    async () => {
      const offset = env.events.history.length;
      await ui("window.setAnchors(true,false)");
      await env.events.wait((e) => e.type === "phase" && e.phase === "running", offset);
      await page("window.fixtureReady");
      const second = await env.createWindow(scope);
      await page("window.storageRoundTrip(true)");
      const guest = env.guests.get(win.webContents.id)!;
      const frame = guest.mainFrame.frames.find((f) => f.url.includes("/instance/"))!;
      const active = page("window.callTool('clear-running',true)").catch((error) => ({
        error: String(error),
      }));
      await env.agent.respond(
        await env.agent.approvals.wait((r) => r.params.input?.key === "clear-running"),
        "allow",
      );
      await env.agent.events.wait((e) => e.type === "executed" && e.key === "clear-running");
      const waiting = env
        .evalPage(second, "window.callTool('clear-approval')")
        .catch((error) => ({ error: String(error) }));
      const permission = await env.agent.approvals.wait(
        (r) => r.params.input?.key === "clear-approval",
      );
      await Promise.all([
        page("window.startStorageWriter()"),
        env.evalPage(second, "window.startStorageWriter()"),
      ]);
      const clearing = env.native.clearBrowserData();
      assert.throws(() => env.native.registerFromHost({} as never), /being cleared/);
      await clearing;
      assert.equal(frame.isDestroyed(), true);
      assert.equal(env.countGuests(), 0);
      assert.ok((await active).error);
      assert.ok((await waiting).error);
      await env.agent.respond(permission, "allow");
      await env.agent.events.wait((e) => e.type === "cancelled" && e.key === "clear-running");
      env.agent.release("managed", "clear-running");
      assert.equal(
        env.agent.events.history.some((e) => e.type === "executed" && e.key === "clear-approval"),
        false,
      );
    },
  );
  await check(
    "full cleanup releases production subscriptions after existing keep-warm deadline",
    async () => {
      const active = env.windows.filter((w) => !w.isDestroyed());
      const offset = env.events.history.length;
      for (const owner of active)
        await owner.webContents.executeJavaScript(
          "window.setAnchors(false,false).then(() => window.clearManaged())",
        );
      await Promise.all(
        active.map((owner) =>
          owner.webContents.executeJavaScript("window.waitConnectionsReleased()"),
        ),
      );
      for (const owner of active)
        assert.ok(
          Object.values(
            (await owner.webContents.executeJavaScript("window.managedState()")).listeners,
          ).every((count) => count === 0),
        );
      assert.equal(env.countGuests(), 0);
      // Renderer 释放本地监听不代表异步退订 RPC 已应答；等待真实 ACK，避免跨进程完成顺序造成误报。
      await Promise.all(
        active.map((owner) =>
          env.events.wait(
            (event) => event.type === "unsubscribed" && event.owner === owner.webContents.id,
            offset,
          ),
        ),
      );
      assert.equal(
        env.events.history.slice(offset).filter((e) => e.type === "unsubscribed").length,
        active.length,
      );
    },
  );
}
