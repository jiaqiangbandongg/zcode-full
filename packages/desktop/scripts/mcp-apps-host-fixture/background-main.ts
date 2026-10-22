import { app, protocol, type BrowserWindow, type WebContents } from "electron";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PLUGIN_SANDBOX_PRIVILEGED_SCHEME } from "../../src/main/pluginSandbox/index.js";
import { managedEnvironment } from "./managed-environment.js";
import { evaluateGuest } from "./guest-evaluation.js";
import { clickHostPoint } from "./pointer-input.js";

const [root, profile, node, cli] = process.argv.slice(2) as [string, string, string, string];
if (process.env.ZCODE_FIXTURE_CDP_PORT)
  app.commandLine.appendSwitch("remote-debugging-port", process.env.ZCODE_FIXTURE_CDP_PORT);
app.setPath("userData", profile);
protocol.registerSchemesAsPrivileged([PLUGIN_SANDBOX_PRIVILEGED_SCHEME]);
app.on("window-all-closed", () => {});
app
  .whenReady()
  .then(async () => {
    const env = await managedEnvironment(root, node, cli);
    const results: Record<string, boolean | string> = {};
    try {
      if (!process.env.ZCODE_PHOTOCRAFT_ONLY) {
        const admitted: Array<{ win: BrowserWindow; guest: WebContents }> = [];
        // 先打开外壳但没有任何会话卡片/订阅，再让真实模型调用返回 UI 工具结果。
        for (const source of ["admission-first", "admission-second"]) {
          const scope = await env.agent.uiSession(join(root, source), source);
          const win = await env.createWindow(scope, "background-admission");
          const ui = (code: string) => win.webContents.executeJavaScript(code);
          assert.equal(env.guests.has(win.webContents.id), false);
          assert.equal(
            env.events.history.some(
              (e) => e.type === "subscribed" && e.owner === win.webContents.id,
            ),
            false,
          );
          env.model.plans.push({ key: source, delayed: true, toolName: "open_editor" });
          await env.agent.call("v4/command", {
            commandId: randomUUID(),
            clientId: "admission-fixture",
            sessionId: scope.sessionId,
            type: "sendText",
            issuedAt: Date.now(),
            payload: {
              text: "Open fixture editor",
              mode: "yolo",
              modelSelection: env.model.selection,
            },
          });
          await env.agent.events.wait(
            (e) => e.source === source && e.type === "executed" && e.key === source,
          );
          assert.equal(env.guests.has(win.webContents.id), false);
          env.agent.release(source, source);
          await env.events.wait((e) => e.type === "registered" && e.owner === win.webContents.id);
          await ui("window.waitManagedPhase('running')");
          await env.evalPage(win, "window.fixtureReady");
          const guest = env.guests.get(win.webContents.id)!;
          assert.equal((await ui("window.managedState()")).visible, false);
          await env.evalPage(
            win,
            "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>{window.unsavedDocument={layers:[1,2,3]};resolve(true)})))",
          );
          await ui("window.expireOffscreen()");
          assert.equal(guest.isDestroyed(), false);
          await ui("window.revealBackgroundPage()");
          assert.equal(env.guests.get(win.webContents.id), guest);
          assert.deepEqual(await env.evalPage(win, "window.unsavedDocument"), {
            layers: [1, 2, 3],
          });
          assert.equal(
            env.events.history.filter(
              (e) => e.type === "registered" && e.owner === win.webContents.id,
            ).length,
            1,
          );
          // 保留两份同插件实例，确认第二份创建不会关闭第一份。
          admitted.push({ win, guest });
          process.stdout.write(
            `PASS ${source}: real tool result with no card/subscription, background frames, retention and reveal\n`,
          );
        }
        assert.equal(env.countGuests(), 2);
        // 两个窗口独立释放；并行等待生产 keep-warm 到期，不串行增加测试时限。
        await Promise.all(
          admitted.map(async ({ win, guest }) => {
            assert.equal(guest.isDestroyed(), false);
            assert.deepEqual(await env.evalPage(win, "window.unsavedDocument"), {
              layers: [1, 2, 3],
            });
            await win.webContents.executeJavaScript(
              "window.stopBackgroundReceiver(); window.removeTask()",
            );
            await win.webContents.executeJavaScript("window.waitConnectionsReleased()");
            assert.equal(guest.isDestroyed(), true);
            win.destroy();
          }),
        );
        assert.equal(env.countGuests(), 0);
        results.toolResultAdmissionWithoutCardOrSubscription = true;
        results.independentSessionsRetainedAndReleased = true;

        for (const mode of ["background-cold", "background-hidden", "background-cold-minimized"]) {
          const coldScope = await env.agent.session(join(root, mode), "background");
          const cold = await env.createWindow(coldScope, mode);
          const coldUi = (code: string) => cold.webContents.executeJavaScript(code);
          const coldPage = (code: string) => env.evalPage(cold, code);
          await coldPage("window.fixtureReady");
          const guest = env.guests.get(cold.webContents.id)!;
          const dimensions = await coldPage(`new Promise((resolve,reject)=>{
            const timeout=setTimeout(()=>reject(new Error('post-handshake frames stopped without a running session')),5000);
            requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timeout);resolve({width:innerWidth,height:innerHeight})}));
          })`);
          assert.ok(dimensions.width > 0 && dimensions.height > 0, "隐藏冷启动必须有尺寸和帧");
          process.stdout.write(`PASS ${mode}: initialized with nonzero background surface\n`);
          await coldPage(
            "window.unsavedDocument={layers:[1,2,3]}; window.ticks=0; (function tick(){window.ticks++;requestAnimationFrame(tick)})(); true",
          );
          await new Promise((resolve) => setTimeout(resolve, 400));
          const idle = await coldPage("window.ticks");
          await new Promise((resolve) => setTimeout(resolve, 400));
          assert.ok((await coldPage("window.ticks")) > idle, "插件内部工作不能因 session 空闲停帧");
          process.stdout.write(`PASS ${mode}: internal frames continue without session activity\n`);
          if (mode === "background-hidden") {
            await coldUi(`document.querySelector('#sidebar-anchor').style.display='block';
            new Promise(resolve=>{const check=()=>window.managedState().visible?resolve():setTimeout(check,20);check()})`);
            assert.equal(env.guests.get(cold.webContents.id), guest);
          }
          cold.minimize();
          await coldUi(`document.hidden || new Promise(resolve=>document.addEventListener('visibilitychange',function changed(){
          if(document.hidden){document.removeEventListener('visibilitychange',changed);resolve()}
        }))`);
          process.stdout.write(`PASS ${mode}: owner document hidden\n`);
          assert.equal(
            await coldPage(
              "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))",
            ),
            true,
          );
          process.stdout.write(`PASS ${mode}: minimized execution completed\n`);
          await coldUi("window.expireOffscreen()");
          assert.equal(guest.isDestroyed(), false);
          assert.deepEqual(await coldPage("window.unsavedDocument"), { layers: [1, 2, 3] });
          cold.restore();
          await coldUi("window.removeTask()");
          await coldUi("window.waitConnectionsReleased()");
          assert.equal(guest.isDestroyed(), true);
          cold.destroy();
          process.stdout.write(
            `PASS ${mode}: cold boot, post-handshake frames, minimized execution, retention and deletion\n`,
          );
        }
        const scope = await env.agent.session(join(root, "background-workspace"), "background");
        const win = await env.createWindow(scope, "background");
        const ui = (code: string) => win.webContents.executeJavaScript(code);
        const page = (code: string) => env.evalPage(win, code);
        await page("window.fixtureReady");
        await ui(
          "document.querySelector('#inline-scroll').scrollTop=900; new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
        );
        assert.equal((await ui("window.managedState()")).visible, false);
        await page(
          "new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('offscreen inline frames stopped')),5000);requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timeout);resolve(true)}))})",
        );
        await ui(
          "document.querySelector('#inline-scroll').scrollTop=0; new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
        );
        const command = (type: string, payload: unknown) =>
          env.agent.call("v4/command", {
            commandId: randomUUID(),
            clientId: "background-fixture",
            sessionId: scope.sessionId,
            type,
            payload,
            issuedAt: Date.now(),
          });
        const start = async (key: string) => {
          env.model.plans.push({ key, delayed: false, holdStream: true });
          await command("sendText", {
            text: `fixture ${key}`,
            modelSelection: env.model.selection,
            mode: "build",
          });
          await env.model.requests.wait((r) => r.plan?.key === key);
        };
        const stop = async () => {
          const after = env.agent.notifications.history.length;
          await command("stop", {});
          await env.agent.notifications.wait(
            (e) =>
              e.method === "v4/telemetry/event" &&
              e.params.kind === "turn.terminal" &&
              e.params.sessionId === scope.sessionId,
            after,
          );
        };
        const original = env.guests.get(win.webContents.id)!;
        const handle = env.handles.get(win.webContents.id);
        await assert.rejects(
          ui(
            `window.zcodePluginSandbox.setExecutionActive(${JSON.stringify(handle.sandboxId)}, ${handle.initId + 1}, true)`,
          ),
          /no longer available/,
        );
        const foreign = await env.createWindow(scope, "web");
        await assert.rejects(
          foreign.webContents.executeJavaScript(
            `window.zcodePluginSandbox.setExecutionActive(${JSON.stringify(handle.sandboxId)}, ${handle.initId}, true)`,
          ),
          /no longer available/,
        );
        foreign.destroy();

        const siblingHandle = env.native.registerFromHost({
          instance: { ...handle.instance, token: randomUUID() },
          ownerWebContentsId: win.webContents.id,
          sessionId: scope.sessionId,
          pluginId: scope.pluginId,
          serverName: scope.serverName,
          scopeId: "idle-sibling",
          html: "<html><body><script>window.ticks=0;function tick(){window.ticks++;requestAnimationFrame(tick)}tick()</script></body></html>",
        });
        const attached = new Promise<WebContents>((resolve) =>
          win.webContents.once("did-attach-webview", (_event, guest) => resolve(guest)),
        );
        await ui(
          `(() => { const guest = document.createElement('webview'); guest.id='idle-sibling'; guest.src=${JSON.stringify(siblingHandle.shellUrl)}; guest.partition=${JSON.stringify(siblingHandle.partition)}; guest.style.cssText='display:flex;width:200px;height:100px'; document.body.append(guest); })()`,
        );
        const sibling = await attached;
        env.guests.set(win.webContents.id, original);
        await new Promise<void>((resolve) => {
          const check = () => {
            if (!sibling.mainFrame.frames.some((frame) => frame.url.includes("/instance/"))) return;
            sibling.removeListener("did-frame-finish-load", check);
            resolve();
          };
          sibling.on("did-frame-finish-load", check);
          check();
        });
        await evaluateGuest(
          sibling,
          "new Promise(resolve => requestAnimationFrame(() => resolve(window.ticks)))",
        );
        await ui("document.querySelector('#idle-sibling').style.display='none'");
        // 此处测量隐藏 guest 是否跑帧，观察窗口是测试本身的负向断言，不承担产品状态同步。
        await new Promise((resolve) => setTimeout(resolve, 400));
        const siblingBefore = await evaluateGuest(sibling, "window.ticks");
        await start("background-first");
        await ui("window.setAnchors(false, false)");
        assert.equal(await ui("window.suspendManaged()"), false, "运行中的 session 不得回收");
        const frames = await page(
          "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve('frames-completed'))))",
        );
        assert.equal(frames, "frames-completed");
        assert.equal(env.guests.get(win.webContents.id), original);
        assert.equal(
          await ui(
            "Boolean(document.elementFromPoint(25,25)?.closest('[data-sandbox-page-root]'))",
          ),
          false,
        );
        const hidden = await ui(
          "({display:getComputedStyle(document.querySelector('[data-sandbox-page-root]')).display,inert:document.querySelector('[data-sandbox-page-root]').inert})",
        );
        assert.equal(hidden.inert, true);
        assert.equal(
          await evaluateGuest(sibling, "window.ticks"),
          siblingBefore,
          "目标执行不能唤醒同窗空闲 guest",
        );
        await ui(
          `window.zcodePluginSandbox.disposeSandbox(${JSON.stringify(siblingHandle.sandboxId)}, ${siblingHandle.initId})`,
        );
        await ui("document.querySelector('#idle-sibling').remove()");
        await writeFile(
          join(root, "background-hidden.png"),
          (await win.webContents.capturePage()).toPNG(),
        );
        process.stdout.write(
          "PASS hidden running guest keeps frames and does not intercept clicks\n",
        );
        await page(
          "window.unsavedDocument={name:'retained draft',layers:[1,2,3]}; window.backgroundTicks=0; (function tick(){window.backgroundTicks++;requestAnimationFrame(tick)})(); true",
        );
        await stop();
        const stoppedTicks = await page("window.backgroundTicks");
        await page(
          "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))",
        );
        assert.ok(
          (await page("window.backgroundTicks")) > stoppedTicks,
          "session 停止不能冻结插件内部工作",
        );
        assert.equal(original.isDestroyed(), false);
        await ui("window.expireOffscreen()");
        assert.equal(await ui("window.suspendManaged()"), false, "空闲 MCP 页面也不得自动回收");
        assert.equal(original.isDestroyed(), false);
        assert.deepEqual(await page("window.unsavedDocument"), {
          name: "retained draft",
          layers: [1, 2, 3],
        });
        process.stdout.write(
          "PASS MCP guest keeps internal frames and retains unsaved state past deadline\n",
        );
        await start("background-expiry");
        await page("new Promise(resolve => requestAnimationFrame(() => resolve(true)))");
        await ui("window.expireOffscreen()");
        assert.equal(await ui("window.suspendManaged()"), false);
        await stop();
        assert.equal(await ui("window.suspendManaged()"), false);
        assert.equal(original.isDestroyed(), false);

        // 卡片仍未挂载；下一轮必须唤醒同一 guest，不能靠重建恢复编辑状态。
        await start("background-reopen");
        assert.equal(env.guests.get(win.webContents.id), original);
        assert.equal(env.countGuests(), 1);
        assert.equal(
          await page(
            "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))",
          ),
          true,
        );
        assert.deepEqual(await page("window.unsavedDocument"), {
          name: "retained draft",
          layers: [1, 2, 3],
        });
        process.stdout.write("PASS next turn wakes the same MCP guest without a mounted card\n");
        await stop();
        await ui("window.removeTask()");
        await ui("window.waitConnectionsReleased()");
        assert.equal(env.countGuests(), 0);
        Object.assign(results, {
          coldBootWithoutAnchor: true,
          retainedHiddenTabBoot: true,
          minimizedVisibleOwner: true,
          coldBootWhileMinimized: true,
          retainedDuringRun: true,
          hiddenFrames: frames,
          independentOfSessionActivity: true,
          retainedAfterIdleDeadline: true,
          unsavedStatePreserved: true,
          idleSiblingPreserved: true,
          staleAndForeignRequestsRejected: true,
          resumedWithoutAnchor: true,
          removed: true,
        });
      }
      if (process.env.ZCODE_PHOTOCRAFT_SERVER) {
        // 仅此隔离 workspace 内的真实插件测试批准工具，仍经过生产 Agent 权限链路。
        env.agent.client.onRequest((request) => {
          if (request.method === "interaction/requestPermission")
            void env.agent.respond(request, "allow");
        });
        const craftScope = await env.agent.uiSession(
          join(root, "photocraft-workspace"),
          "photocraft",
          {
            serverScript: process.env.ZCODE_PHOTOCRAFT_SERVER,
            resourceUri: "ui://photocraft/panel.html",
            surface: "editor",
          },
        );
        const craft = await env.createWindow(craftScope, "background-admission-minimized");
        const craftUi = (code: string) => craft.webContents.executeJavaScript(code);
        const craftPage = (code: string) => env.evalPage(craft, code);
        assert.equal(env.guests.has(craft.webContents.id), false);
        env.model.plans.push({
          key: "photocraft-open",
          delayed: false,
          toolName: "open_editor",
          arguments: {},
        });
        await env.agent.call("v4/command", {
          commandId: randomUUID(),
          clientId: "photocraft-admission",
          sessionId: craftScope.sessionId,
          type: "sendText",
          issuedAt: Date.now(),
          payload: {
            text: "Open the image editor",
            mode: "yolo",
            modelSelection: env.model.selection,
          },
        });
        await env.events.wait((e) => e.type === "registered" && e.owner === craft.webContents.id);
        await craftUi("window.waitManagedPhase('running')");
        const boot = await craftPage(`new Promise((resolve,reject)=>{
          const check=()=>{const state=window.__craftPlugin;
            if(state?.error)reject(new Error(state.error));
            else if(state?.automationReady)resolve(state);
            else setTimeout(check,100);
          };check();
        })`);
        assert.equal(boot.loaded, true);
        process.stdout.write(
          "PASS real PhotoCraft: WASM initialized from a real tool result while minimized, without a card\n",
        );
        const craftGuest = env.guests.get(craft.webContents.id)!;
        const craftHandle = env.handles.get(craft.webContents.id);
        const call = async (toolName: string, args: Record<string, unknown> = {}) => {
          const result = await env.agent.call("mcp/uiCallTool", {
            workspace: craftScope.workspace,
            sessionId: craftScope.sessionId,
            pluginId: craftScope.pluginId,
            serverName: craftScope.serverName,
            instance: craftHandle.instance,
            callId: randomUUID(),
            toolName,
            arguments: args,
          });
          assert.ok(!result.isError, JSON.stringify(result));
          return result;
        };
        await call("doc_new", {
          width: 64,
          height: 48,
          name: "Background retained draft",
          background: "white",
        });
        craft.minimize();
        await call("command_run", { id: "layer.new.layer", params: { name: "Background layer" } });
        const document = await call("doc_inspect");
        assert.match(JSON.stringify(document), /Background layer/);
        process.stdout.write("PASS real PhotoCraft: minimized document and layer operations\n");
        await craftUi("window.expireOffscreen()");
        assert.equal(craftGuest.isDestroyed(), false);
        assert.deepEqual(await call("doc_inspect"), document);
        assert.equal(env.guests.get(craft.webContents.id), craftGuest);
        craft.restore();
        craft.show();
        await craftUi("window.revealBackgroundPage()");
        await craftPage(
          "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))",
        );
        const canvas = await craftPage(
          "(()=>{const canvas=document.querySelector('#craft-stage canvas');return {width:canvas.width,height:canvas.height}})()",
        );
        assert.ok(canvas.width > 0 && canvas.height > 0);
        assert.equal(env.guests.get(craft.webContents.id), craftGuest);
        const switchMainPage = async () => {
          const point = await craftUi(`(() => {
            const r = document.querySelector('#switch-main-page').getBoundingClientRect();
            return {x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2)};
          })()`);
          await clickHostPoint(craft, point);
        };
        await switchMainPage();
        const hidden = await craftUi(`(() => {
          const root = document.querySelector('[data-sandbox-page-root]');
          return {visible: window.managedState().visible, inert: root.inert,
            opacity: getComputedStyle(root).opacity, hit: document.elementFromPoint(600, 200)?.tagName};
        })()`);
        assert.equal(hidden.visible, false, JSON.stringify(hidden));
        assert.equal(hidden.inert, true);
        assert.ok(Number(hidden.opacity) <= 0.001);
        assert.notEqual(hidden.hit, "WEBVIEW");
        await writeFile(
          join(root, "photocraft-page-hidden.png"),
          (await craft.webContents.capturePage()).toPNG(),
        );
        // 原始插件不做任何适配：切主页面后仍执行编辑，返回同一 guest 显示新图层。
        await call("command_run", { id: "layer.new.layer", params: { name: "Hidden page layer" } });
        const hiddenDocument = await call("doc_inspect");
        assert.match(JSON.stringify(hiddenDocument), /Hidden page layer/);
        await switchMainPage();
        assert.equal((await craftUi("window.managedState()")).visible, true);
        assert.equal(env.guests.get(craft.webContents.id), craftGuest);
        assert.deepEqual(await call("doc_inspect"), hiddenDocument);
        await craftPage(
          "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
        );
        results.photocraftHiddenPageExecution = true;
        await writeFile(
          join(root, "photocraft-restored.png"),
          (await craftGuest.capturePage()).toPNG(),
        );
        process.stdout.write(
          "PASS real PhotoCraft: restored the same guest to a visible canvas; captured photocraft-restored.png\n",
        );
        await craftUi("window.stopBackgroundReceiver(); window.removeTask()");
        await craftUi("window.waitConnectionsReleased()");
        assert.equal(craftGuest.isDestroyed(), true);
        assert.equal(env.countGuests(), 0);
        craft.destroy();
        results.photoCraft = true;
        process.stdout.write(
          "PASS real PhotoCraft: background WASM boot, minimized document/layer operations, retained draft and deletion\n",
        );
      }
      await writeFile(join(root, "background-results.json"), JSON.stringify(results));
      process.stdout.write(
        "PASS MCP page survives idle deadlines, executes in background and releases on deletion\n",
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
