import { app, BrowserWindow, ipcMain, protocol, webContents, type WebContents } from "electron";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  installPluginSandboxHost,
  PLUGIN_SANDBOX_PRIVILEGED_SCHEME,
} from "../../src/main/pluginSandbox/index.js";
import { createPluginUiBridgeService } from "../../../services/src/plugin-ui-bridge/pluginUiBridgeService.js";
import { startAgent } from "./agent.js";
import { checkCombinations } from "./chain-combinations.js";
import { evaluateGuest } from "./guest-evaluation.js";
const [root, profile, node, cli] = process.argv.slice(2) as [string, string, string, string];
app.setPath("userData", profile);
protocol.registerSchemesAsPrivileged([PLUGIN_SANDBOX_PRIVILEGED_SCHEME]);
app.on("window-all-closed", () => {});
app
  .whenReady()
  .then(async () => {
    const agent = await startAgent(root, node, cli);
    const checks: { name: string; ms: number }[] = [];
    const windows: BrowserWindow[] = [];
    const guests = new Map<number, WebContents>();
    const scopes = new Map<number, any>();
    const handles = new Map<number, any>();
    const calls: any[] = [];
    const host = installPluginSandboxHost({
      rendererDir: root,
      aliasDir: root,
      preloadPath: join(root, "guest.cjs"),
    });
    const wire = (params: any) => {
      const {
        workspacePath,
        workspaceIdentity,
        scopeId: _scope,
        resourceUri: _uri,
        ownerWebContentsId: _owner,
        csp: _csp,
        prefersBorder: _border,
        ...rest
      } = params;
      return {
        ...rest,
        workspace: {
          workspacePath,
          workspaceKey: workspaceIdentity?.trim() || workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
        },
      };
    };
    const bridge = createPluginUiBridgeService({
      openInstance: (p) =>
        agent.call("mcp/uiOpenInstance", {
          workspace: wire(p).workspace,
          sessionId: p.sessionId,
          pluginId: p.pluginId,
          serverName: p.serverName,
          resourceUri: p.resourceUri,
          scopeId: p.scopeId,
          ownerWebContentsId: p.ownerWebContentsId,
        }),
      validateInstance: (p) => agent.call("mcp/uiValidateInstance", wire(p)),
      closeInstance: (p) => agent.call("mcp/uiCloseInstance", wire(p)),
      recycleInstance: async (p) =>
        (await agent.call("mcp/uiCloseInstance", { ...wire(p), onlyIfIdle: true })).closed,
      readMcpResource: (p) => agent.call("mcp/readResource", wire(p)),
      callMcpToolForUi: (p) => {
        calls.push(p);
        return agent.call("mcp/uiCallTool", wire(p));
      },
      cancelMcpToolCallForUi: (p) => agent.call("mcp/uiCancelCall", wire(p)),
      readMcpResourceForUi: (p) => agent.call("mcp/uiReadResource", wire(p)),
      listMcpResourcesForUi: (p) => agent.call("mcp/uiListResources", wire(p)),
      registerSandbox: async (input) => {
        const handle = host.registerFromHost(input);
        handles.set(input.ownerWebContentsId, handle);
        return handle;
      },
    });
    ipcMain.handle("fixture-config", (event) => {
      const scope = scopes.get(event.sender.id)!;
      return {
        scope: {
          workspacePath: scope.workspace.workspacePath,
          ...(scope.workspace.workspaceIdentity
            ? { workspaceIdentity: scope.workspace.workspaceIdentity }
            : {}),
          sessionId: scope.sessionId,
          scope: { kind: "surface", surfaceId: "same" },
        },
        presentation: {
          pluginId: scope.pluginId,
          serverName: scope.serverName,
          resourceUri: "ui://fixture",
        },
      };
    });
    ipcMain.handle("fixture-bridge", async (event, method, params) => {
      const scope = scopes.get(event.sender.id);
      assert.equal(params.sessionId, scope.sessionId);
      assert.equal(params.serverName, scope.serverName);
      if (method === "prepareSandbox") {
        // 同一逻辑页面并发初始化经过生产 bridge，必须只有一次 MCP read 与 Main register。
        const [a, b] = await Promise.all([
          bridge.prepareSandbox(params),
          bridge.prepareSandbox(params),
        ]);
        assert.deepEqual(a, b);
        return a;
      }
      const fn = (bridge as any)[method];
      assert.equal(typeof fn, "function");
      return fn(params);
    });
    async function createWindow(scope: any) {
      const win = new BrowserWindow({
        show: false,
        width: 1000,
        height: 700,
        webPreferences: {
          preload: join(root, "preload.cjs"),
          webviewTag: true,
          backgroundThrottling: false,
        },
      });
      windows.push(win);
      scopes.set(win.webContents.id, scope);
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
      win.webContents.on("did-attach-webview", (_event, guest) => {
        guests.set(win.webContents.id, guest);
        host.attachGuest({ guest, hostWebContents: win.webContents, sandboxId: pending.shift()! });
      });
      await win.loadFile(join(root, "host.html"));
      await win.webContents.executeJavaScript("window.harnessReady");
      await evaluateGuest(guests.get(win.webContents.id)!, "window.fixtureReady");
      return win;
    }
    async function closeWindow(win: BrowserWindow) {
      if (win.isDestroyed()) return;
      const guest = guests.get(win.webContents.id);
      const closed =
        guest && !guest.isDestroyed()
          ? new Promise<void>((resolve) => guest.once("destroyed", resolve))
          : Promise.resolve();
      win.destroy();
      await closed;
    }
    const evalPage = (win: BrowserWindow, code: string) =>
      evaluateGuest(guests.get(win.webContents.id)!, code);
    async function check(name: string, run: () => Promise<void>) {
      const start = performance.now();
      await run();
      checks.push({ name, ms: performance.now() - start });
      process.stdout.write(`PASS ${name}\n`);
    }
    const approval = (key: string) =>
      agent.approvals.wait((request) => request.params.input?.key === key);
    const executed = (key: string) =>
      agent.events.history.filter((event) => event.type === "executed" && event.key === key).length;
    const scope = await agent.session(join(root, "workspace-a"), "source-a");
    const win = await createWindow(scope);
    try {
      await check("concurrent prepare reads once and mounts one guest", async () => {
        assert.equal(
          agent.events.history.filter(
            (event) => event.type === "read" && event.source === "source-a",
          ).length,
          1,
        );
        assert.equal(
          webContents.getAllWebContents().filter((contents) => contents.getType() === "webview")
            .length,
          1,
        );
      });
      await check(
        "app-only tool approval and untruncated raw result without conversation turn",
        async () => {
          const result = evalPage(win, "window.callTool('raw')");
          await agent.respond(await approval("raw"), "allow");
          const response = await result;
          assert.equal(response.result.content[0].text.length, 40_000);
          assert.deepEqual(response.result.structuredContent, { key: "raw", source: "source-a" });
          assert.deepEqual(response.result._meta, { fixture: true });
          assert.equal(executed("raw"), 1);
          const snapshot = await agent.call("session/read", { sessionId: scope.sessionId });
          assert.equal(snapshot.messages.length, 0);
        },
      );
      await check("denied approval never reaches MCP tool", async () => {
        const result = evalPage(win, "window.callTool('denied')");
        await agent.respond(await approval("denied"), "deny");
        assert.ok((await result).error);
        assert.equal(executed("denied"), 0);
      });
      await check(
        "cancellation before admission and after success never replays a call",
        async () => {
          const instance = handles.get(win.webContents.id).instance;
          const binding = { ...scope, instance, callId: "cancel-before-admission" };
          assert.equal((await agent.call("mcp/uiCancelCall", binding)).cancelled, false);
          await assert.rejects(() =>
            agent.call("mcp/uiCallTool", {
              ...binding,
              toolName: "edit",
              arguments: { key: "before-admission" },
            }),
          );
          assert.equal(executed("before-admission"), 0);
          const completed = calls.find((call) => call.arguments.key === "raw");
          await assert.rejects(() => agent.call("mcp/uiCallTool", wire(completed)));
          const { toolName: _tool, arguments: _args, ...cancel } = completed;
          assert.equal((await bridge.cancelToolCall(cancel)).cancelled, false);
          assert.equal(executed("raw"), 1);
        },
      );
      await check("SDK cancellation reaches real MCP process and rejects late result", async () => {
        const result = evalPage(win, "window.callTool('cancelled',true)");
        await agent.respond(await approval("cancelled"), "allow");
        await agent.events.wait((event) => event.type === "executed" && event.key === "cancelled");
        await evalPage(win, "window.cancelTool('cancelled')");
        await agent.events.wait((event) => event.type === "cancelled" && event.key === "cancelled");
        assert.ok((await result).error);
        agent.release("source-a", "cancelled");
        await agent.events.wait((event) => event.type === "released" && event.key === "cancelled");
        assert.equal(executed("cancelled"), 1);
      });
      await check("duplicate callId executes once and cancellation is idempotent", async () => {
        const result = evalPage(win, "window.callTool('duplicate',true)");
        await agent.respond(await approval("duplicate"), "allow");
        await agent.events.wait((event) => event.type === "executed" && event.key === "duplicate");
        const binding = calls.find((call) => call.arguments.key === "duplicate");
        await assert.rejects(() => agent.call("mcp/uiCallTool", wire(binding)));
        const { toolName: _tool, arguments: _args, ...cancel } = binding;
        assert.equal((await bridge.cancelToolCall(cancel)).cancelled, true);
        assert.equal((await bridge.cancelToolCall(cancel)).cancelled, false);
        assert.ok((await result).error);
        assert.equal(executed("duplicate"), 1);
      });
      await check(
        "pending approval pins instance and late approval cannot run closed generation",
        async () => {
          const pending = evalPage(win, "window.callTool('late-approval')").catch(() => ({
            closed: true,
          }));
          const request = await approval("late-approval");
          const old = handles.get(win.webContents.id);
          const binding = {
            workspacePath: scope.workspace.workspacePath,
            sessionId: scope.sessionId,
            pluginId: scope.pluginId,
            serverName: scope.serverName,
            instance: old.instance,
          };
          assert.equal(await bridge.recycleInstance(binding), false);
          await win.webContents.executeJavaScript("window.disposePage()");
          await win.webContents.executeJavaScript("window.restorePage(false)");
          await evalPage(win, "window.fixtureReady");
          assert.notEqual(handles.get(win.webContents.id).instance.token, old.instance.token);
          await agent.respond(request, "allow");
          await pending;
          assert.equal(executed("late-approval"), 0);
          // 旧 dispose 到达新登记之后，也不能拆掉替换页面。
          await win.webContents.executeJavaScript(
            `window.harness.dispose(${JSON.stringify(old.sandboxId)},${old.initId})`,
          );
          const result = evalPage(win, "window.callTool('new-approval')");
          await agent.respond(await approval("new-approval"), "deny");
          assert.ok((await result).error);
          assert.equal(executed("new-approval"), 0);
          assert.ok(!guests.get(win.webContents.id)!.isDestroyed());
        },
      );
      await check(
        "same surface in different windows keeps independent guest and widget snapshot",
        async () => {
          const second = await createWindow(scope);
          assert.notEqual(
            guests.get(win.webContents.id)!.id,
            guests.get(second.webContents.id)!.id,
          );
          assert.notEqual(
            handles.get(win.webContents.id).instance.token,
            handles.get(second.webContents.id).instance.token,
          );
          await evalPage(win, "window.saveWidget({window:1})");
          assert.equal(await evalPage(second, "window.readWidget()"), null);
          await evalPage(win, "window.storageRoundTrip(true)");
          assert.deepEqual(await evalPage(second, "window.storageRoundTrip(false)"), {
            local: "42",
            indexed: 42,
          });
          await closeWindow(second);
          assert.ok(!guests.get(win.webContents.id)!.isDestroyed());
        },
      );
      await check(
        "same surface across server and workspace identities isolates browser storage",
        async () => {
          for (const [workspace, server, identity] of [
            ["workspace-a", "other"],
            ["workspace-b", "fixture"],
            ["workspace-a", "fixture", "fixture-other-workspace"],
          ]) {
            // 连接命令、参数、资源、surface 完全相同，每次只改变一个身份维度。
            const otherScope = await agent.session(
              join(root, workspace!),
              "source-a",
              server!,
              identity,
            );
            const other = await createWindow(otherScope);
            assert.notEqual(
              handles.get(win.webContents.id).partition,
              handles.get(other.webContents.id).partition,
            );
            assert.deepEqual(await evalPage(other, "window.storageRoundTrip(false)"), {
              local: null,
              indexed: null,
            });
            await closeWindow(other);
            await agent.call("session/close", { sessionId: otherScope.sessionId });
          }
        },
      );
      await checkCombinations({
        agent,
        win,
        scope,
        handles,
        guests,
        calls,
        bridge,
        wire,
        evalPage,
        createWindow,
        closeWindow,
        check,
      });
      await check("connection revoked during approval rejects late allow", async () => {
        const result = evalPage(win, "window.callTool('disconnect')");
        const request = await approval("disconnect");
        agent.disconnect("source-a");
        assert.ok((await result).error);
        await agent.respond(request, "allow");
        assert.equal(executed("disconnect"), 0);
        await assert.rejects(() =>
          agent.call("mcp/uiValidateInstance", {
            ...scope,
            instance: handles.get(win.webContents.id).instance,
          }),
        );
      });
      for (const window of windows) if (!window.isDestroyed()) await closeWindow(window);
      assert.equal(
        webContents.getAllWebContents().filter((contents) => contents.getType() === "webview")
          .length,
        0,
      );
      await writeFile(
        join(root, "chain-results.json"),
        JSON.stringify(
          {
            checks,
            executions: agent.events.history.filter((event) => event.type === "executed"),
            remainingGuests: 0,
          },
          null,
          2,
        ),
      );
    } finally {
      for (const window of windows) if (!window.isDestroyed()) await closeWindow(window);
      await agent.close();
    }
    app.exit(0);
  })
  .catch((error) => {
    process.stderr.write(String(error.stack ?? error) + "\n");
    app.exit(1);
  });
