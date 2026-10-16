import assert from "node:assert/strict";
import type { BrowserWindow, WebContents } from "electron";
import type { startAgent } from "./agent.js";

export async function checkCombinations(context: {
  agent: Awaited<ReturnType<typeof startAgent>>;
  win: BrowserWindow;
  scope: any;
  handles: Map<number, any>;
  guests: Map<number, WebContents>;
  calls: any[];
  bridge: any;
  wire(params: any): any;
  evalPage(win: BrowserWindow, code: string): Promise<any>;
  createWindow(scope: any): Promise<BrowserWindow>;
  closeWindow(win: BrowserWindow): Promise<void>;
  check(name: string, run: () => Promise<void>): Promise<void>;
}) {
  const { agent, win, scope, handles, guests, calls, bridge, wire, evalPage, check } = context;
  const approval = (key: string) => agent.approvals.wait((r) => r.params.input?.key === key);
  const event = (type: string, key: string) =>
    agent.events.wait((e) => e.type === type && e.key === key);
  const executions = (key: string) =>
    agent.events.history.filter((e) => e.type === "executed" && e.key === key).length;
  const cancel = (key: string) => {
    const {
      toolName: _tool,
      arguments: _args,
      ...binding
    } = calls.find((c) => c.arguments.key === key);
    return bridge.cancelToolCall(binding);
  };
  async function moving(action?: () => Promise<unknown>) {
    const identity = handles.get(win.webContents.id);
    const guest = guests.get(win.webContents.id)!.id;
    const reads = agent.events.history.filter((e) => e.type === "read").length;
    const before = new Map<boolean, unknown>();
    for (let i = 0; i < 12; i++) {
      const move = win.webContents.executeJavaScript(`window.switchPage(${i % 2 === 0})`);
      if (i === 5 && action) await action();
      const { dispatchMs: _time, ...counts } = await move;
      const side = i % 2 === 0;
      if (!before.has(side)) before.set(side, counts);
      assert.deepEqual(counts, before.get(side));
      assert.deepEqual(handles.get(win.webContents.id), identity);
      assert.equal(guests.get(win.webContents.id)!.id, guest);
      assert.equal(agent.events.history.filter((e) => e.type === "read").length, reads);
    }
  }
  await check(
    "approval pending and allow during 12 location changes preserves one invocation",
    async () => {
      const key = "move-approval";
      const result = evalPage(win, `window.callTool('${key}')`);
      const request = await approval(key);
      await moving(async () => {
        assert.equal(executions(key), 0);
        await agent.respond(request, "allow");
      });
      assert.equal((await result).result.structuredContent.key, key);
      assert.equal(executions(key), 1);
    },
  );
  await check(
    "executing tool and result during 12 location changes preserves target and state",
    async () => {
      const key = "move-executing";
      await evalPage(win, "window.saveWidget({moving: 9})");
      const result = evalPage(win, `window.callTool('${key}',true)`);
      await agent.respond(await approval(key), "allow");
      await event("executed", key);
      await moving(async () => {
        agent.release("source-a", key);
        await event("released", key);
      });
      assert.equal((await result).result.structuredContent.key, key);
      assert.equal(executions(key), 1);
      assert.deepEqual(await win.webContents.executeJavaScript("window.savedWidget()"), {
        moving: 9,
      });
      assert.equal(
        agent.events.history.some((e) => e.type === "cancelled" && e.key === key),
        false,
      );
    },
  );
  await check(
    "tool input and result notifications arrive during movement without remount",
    async () => {
      await moving(async () => {
        for (let n = 0; n < 5; n++) {
          await win.webContents.executeJavaScript(`window.deliverFeed(${n})`);
          await evalPage(win, `window.waitFeed(${n})`);
        }
      });
      assert.deepEqual(await evalPage(win, "window.receivedFeed"), {
        input: [0, 1, 2, 3, 4],
        result: [0, 1, 2, 3, 4],
      });
    },
  );
  for (const ordering of ["result-first", "cancel-first", "concurrent"]) {
    await check(`cancel/result race ${ordering} has one terminal and no replay`, async () => {
      const key = `race-${ordering}`;
      const result = evalPage(win, `window.callTool('${key}',true)`);
      await agent.respond(await approval(key), "allow");
      await event("executed", key);
      if (ordering === "result-first") {
        agent.release("source-a", key);
        assert.ok((await result).result);
        assert.equal((await cancel(key)).cancelled, false);
      } else if (ordering === "cancel-first") {
        assert.equal((await cancel(key)).cancelled, true);
        await event("cancelled", key);
        assert.ok((await result).error);
        agent.release("source-a", key);
      } else {
        // 同一轮发出，允许任一合法赢家；以 Agent 的取消接纳结果核对页面终态。
        const cancellation = cancel(key);
        agent.release("source-a", key);
        const [ack, response] = await Promise.all([cancellation, result]);
        assert.equal(Boolean(response.error), ack.cancelled);
        assert.equal(Boolean(response.result), !ack.cancelled);
      }
      await event("released", key);
      assert.equal((await cancel(key)).cancelled, false);
      await assert.rejects(() =>
        agent.call("mcp/uiCallTool", wire(calls.find((c) => c.arguments.key === key))),
      );
      assert.equal(executions(key), 1);
      assert.equal(await win.webContents.executeJavaScript("window.pageBusy()"), false);
    });
  }
  await check("raw MCP error and mixed content preserve result semantics", async () => {
    const key = "raw-error";
    const result = evalPage(win, `window.callTool('${key}')`);
    await agent.respond(await approval(key), "allow");
    const response = await result;
    assert.equal(response.error, undefined);
    assert.deepEqual(response.result, {
      isError: true,
      content: [
        { type: "text", text: "fixture error" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        {
          type: "resource",
          resource: { uri: "fixture://error", mimeType: "text/plain", text: "details" },
        },
      ],
      structuredContent: { key, source: "source-a" },
      _meta: { fixture: true },
    });
    assert.equal(executions(key), 1);
  });
  await check(
    "two windows executing: cross-owner dispose and cancellation cannot touch peer",
    async () => {
      const second = await context.createWindow(scope);
      try {
        const firstResult = evalPage(win, "window.callTool('peer-first',true)");
        const secondResult = evalPage(second, "window.callTool('peer-second',true)");
        await agent.respond(await approval("peer-first"), "allow");
        await agent.respond(await approval("peer-second"), "allow");
        await Promise.all([event("executed", "peer-first"), event("executed", "peer-second")]);
        const other = handles.get(second.webContents.id);
        await win.webContents.executeJavaScript(
          `window.harness.dispose(${JSON.stringify(other.sandboxId)},${other.initId})`,
        );
        assert.ok(!guests.get(second.webContents.id)!.isDestroyed());
        assert.equal((await cancel("peer-first")).cancelled, true);
        assert.ok((await firstResult).error);
        await win.webContents.executeJavaScript("window.disposePage()");
        assert.equal(await second.webContents.executeJavaScript("window.pageBusy()"), true);
        agent.release("source-a", "peer-second");
        assert.equal((await secondResult).result.structuredContent.key, "peer-second");
        assert.equal(executions("peer-first"), 1);
        assert.equal(executions("peer-second"), 1);
        assert.equal((await cancel("peer-second")).cancelled, false);
        await win.webContents.executeJavaScript("window.restorePage(false)");
        await evalPage(win, "window.fixtureReady");
      } finally {
        await context.closeWindow(second);
      }
    },
  );
  await check("stable same-origin guest cannot load another instance script resource", async () => {
    const second = await context.createWindow(scope);
    try {
      const ownUrl = await evalPage(win, "location.href");
      const peerUrl = await evalPage(second, "location.href");
      assert.equal(new URL(ownUrl).host, new URL(peerUrl).host);
      assert.notEqual(ownUrl, peerUrl);
      // 使用 CSP 本来允许的 self script：避免 connect-src none 让正负样本都失败，掩盖 guest 校验。
      const ownAsset = new URL("__zcode__/alias.js", ownUrl).href;
      const peerAsset = new URL("__zcode__/alias.js", peerUrl).href;
      const loadAsset = (target: BrowserWindow, url: string) =>
        evalPage(
          target,
          `new Promise(resolve => { const s = document.createElement('script'); s.src = ${JSON.stringify(url)}; s.onload = () => { s.remove(); resolve(true); }; s.onerror = () => { s.remove(); resolve(false); }; document.head.append(s); })`,
        );
      assert.equal(await loadAsset(win, ownAsset), true);
      assert.equal(
        await loadAsset(win, `${peerAsset}?uncached=${crypto.randomUUID()}`),
        false,
        "uncached cross-guest request must be denied before checking the shared cache",
      );
      assert.equal(await loadAsset(win, peerAsset), false);
      assert.equal(await loadAsset(second, peerAsset), true);
    } finally {
      await context.closeWindow(second);
    }
  });
  await check(
    "forged credential fields are rejected by real Agent without revoking valid instance",
    async () => {
      const instance = handles.get(win.webContents.id).instance;
      for (const patch of [
        { token: crypto.randomUUID() },
        { runtimeId: "forged" },
        { generation: instance.generation + 100 },
        { appIdentity: "b".repeat(64) },
      ]) {
        await assert.rejects(() =>
          agent.call("mcp/uiValidateInstance", { ...scope, instance: { ...instance, ...patch } }),
        );
        await agent.call("mcp/uiValidateInstance", { ...scope, instance });
      }
    },
  );
}
